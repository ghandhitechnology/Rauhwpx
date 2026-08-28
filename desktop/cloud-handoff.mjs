import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const CLOUD_HANDOFF_STATES = Object.freeze([
  'preparing',
  'uploading',
  'committing',
  'queued',
  'running',
  'suspended',
  'completed',
  'downloading',
  'downloaded',
  'cancelled',
  'expired',
  'failed',
]);

const TERMINAL_STATES = new Set(['downloaded', 'cancelled', 'expired', 'failed']);

/** Debounce window for watermark-only stream writes. */
const CLOUD_HANDOFF_PERSIST_DEBOUNCE_MS = 250;
const TRANSITIONS = Object.freeze({
  preparing: new Set(['uploading', 'completed', 'expired', 'failed', 'cancelled']),
  uploading: new Set(['committing', 'completed', 'expired', 'failed', 'cancelled']),
  committing: new Set(['queued', 'running', 'completed', 'expired', 'failed', 'cancelled']),
  queued: new Set(['running', 'suspended', 'cancelled', 'failed']),
  running: new Set(['queued', 'suspended', 'completed', 'cancelled', 'failed']),
  suspended: new Set(['queued', 'running', 'completed', 'cancelled', 'failed']),
  completed: new Set(['downloading', 'expired', 'failed']),
  downloading: new Set(['completed', 'downloaded', 'failed']),
  downloaded: new Set(),
  cancelled: new Set(),
  expired: new Set(),
  failed: new Set(),
});

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new Error('Cloud handoff record is invalid');
  if (typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(record.id)) {
    throw new Error('Cloud handoff id is invalid');
  }
  if (!CLOUD_HANDOFF_STATES.includes(record.state)) throw new Error('Cloud handoff state is invalid');
  if (!Number.isInteger(record.version) || record.version < 1) throw new Error('Cloud handoff version is invalid');
  if (typeof record.documentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.documentDigest)) {
    throw new Error('Cloud handoff document digest is invalid');
  }
  return record;
}

function takeoverReceiptKey(sessionId, operationId) {
  return JSON.stringify([sessionId, operationId]);
}

function validateTakeoverReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') throw new Error('Cloud takeover receipt is invalid');
  for (const [name, value] of [['session id', receipt.sessionId], ['operation id', receipt.operationId]]) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256 || value.includes('\0')) {
      throw new Error(`Cloud takeover ${name} is invalid`);
    }
  }
  if (typeof receipt.consumedAt !== 'string' || !Number.isFinite(Date.parse(receipt.consumedAt))) {
    throw new Error('Cloud takeover consumption time is invalid');
  }
  return receipt;
}

async function atomicJsonWrite(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, filePath);
}

export class CloudHandoffStore {
  #filePath;
  #payloadRoot;
  #records = new Map();
  #takeoverReceipts = new Map();
  #loaded = false;
  #writeChain = Promise.resolve();
  #persistTimer = null;

  constructor({ filePath }) {
    if (!filePath) throw new Error('Cloud handoff store requires a file path');
    this.#filePath = filePath;
    this.#payloadRoot = path.join(path.dirname(filePath), 'pending-payloads');
  }

  async load() {
    if (this.#loaded) return this.list();
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.#filePath, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.records)) throw new Error('Unsupported handoff store');
      if (parsed.takeoverReceipts != null && !Array.isArray(parsed.takeoverReceipts)) {
        throw new Error('Unsupported handoff takeover receipts');
      }
      let migrated = false;
      for (const record of parsed.records) {
        try {
          const validated = validateRecord(record);
          const terminal = TERMINAL_STATES.has(validated.state);
          const normalized = {
            ...validated,
            errorCode: typeof validated.errorCode === 'string' ? validated.errorCode : null,
            retryable: typeof validated.retryable === 'boolean' ? validated.retryable : null,
            failurePhase: typeof validated.failurePhase === 'string' ? validated.failurePhase : null,
            destination: validated.destination && typeof validated.destination === 'object'
              ? { ...validated.destination }
              : null,
            ...(terminal ? {
              documentStagingPath: null,
              resources: (validated.resources ?? []).map(({ stagingPath: _stagingPath, ...resource }) => resource),
            } : {}),
          };
          if (terminal && validated.documentStagingPath) {
            await fs.rm(path.join(this.#payloadRoot, validated.id), { recursive: true, force: true }).catch(() => {});
            migrated = true;
          }
          this.#records.set(normalized.id, Object.freeze(normalized));
        } catch {}
      }
      for (const receipt of parsed.takeoverReceipts ?? []) {
        try {
          const validated = validateTakeoverReceipt(receipt);
          this.#takeoverReceipts.set(
            takeoverReceiptKey(validated.sessionId, validated.operationId),
            Object.freeze({ ...validated }),
          );
        } catch {}
      }
      if (migrated) await this.#persist().catch(() => {});
      const activePayloadIds = new Set(
        [...this.#records.values()]
          .filter((record) => !TERMINAL_STATES.has(record.state) && record.documentStagingPath)
          .map((record) => record.id),
      );
      for (const entry of await fs.readdir(this.#payloadRoot, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && !activePayloadIds.has(entry.name)) {
          await fs.rm(path.join(this.#payloadRoot, entry.name), { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const corrupt = `${this.#filePath}.corrupt-${Date.now()}`;
        await fs.rename(this.#filePath, corrupt).catch(() => {});
      }
    }
    return this.list();
  }

  async create({
    sessionId,
    threadId,
    documentId,
    originPath,
    documentName,
    documentBytes,
    timeline,
    provider,
    executionConfig,
    goal,
    limits,
    resources = [],
    destination = null,
  }) {
    await this.load();
    const bytes = Buffer.from(documentBytes ?? []);
    if (bytes.length === 0) throw new Error('Cloud handoff document is empty');
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Cloud handoff document exceeds 64 MiB');
    const resourcePayloads = resources.map((resource) => ({ resource, bytes: Buffer.from(resource.bytes ?? []) }));
    for (const { resource, bytes: resourceBytes } of resourcePayloads) {
      if (!resourceBytes.length) throw new Error(`Cloud reference ${resource.name ?? ''} is empty`);
      if (resourceBytes.length > 128 * 1024 * 1024) throw new Error('Cloud reference exceeds 128 MiB');
    }
    const timelineSize = Buffer.byteLength(JSON.stringify(timeline ?? null));
    if (timelineSize > 100 * 1024 * 1024) throw new Error('Cloud timeline exceeds 100 MiB');
    const totalSize = bytes.length + timelineSize
      + resourcePayloads.reduce((total, resource) => total + resource.bytes.length, 0);
    if (totalSize > 512 * 1024 * 1024) throw new Error('Cloud transfer exceeds 512 MiB');
    const now = new Date().toISOString();
    const id = randomUUID();
    const payloadDirectory = path.join(this.#payloadRoot, id);
    await fs.mkdir(payloadDirectory, { recursive: true, mode: 0o700 });
    const documentStagingPath = path.join(payloadDirectory, 'document.bin');
    const stagedResources = [];
    try {
      await fs.writeFile(documentStagingPath, bytes, { flag: 'wx', mode: 0o600 });
      for (let index = 0; index < resourcePayloads.length; index += 1) {
        const { resource, bytes: resourceBytes } = resourcePayloads[index];
        const filePath = path.join(payloadDirectory, `reference-${index}.bin`);
        await fs.writeFile(filePath, resourceBytes, { flag: 'wx', mode: 0o600 });
        stagedResources.push({
          id: String(resource.id ?? ''),
          name: String(resource.name ?? `reference-${index + 1}`),
          mimeType: String(resource.mimeType ?? 'application/octet-stream'),
          scope: String(resource.scope ?? ''),
          scopeId: String(resource.scopeId ?? ''),
          size: resourceBytes.length,
          sha256: sha256Hex(resourceBytes),
          stagingPath: filePath,
        });
      }
    } catch (error) {
      await fs.rm(payloadDirectory, { recursive: true, force: true });
      throw error;
    }
    const record = Object.freeze({
      id,
      version: 1,
      state: 'preparing',
      revision: 1,
      originSessionId: String(sessionId ?? ''),
      threadId: String(threadId ?? ''),
      originDocumentId: String(documentId ?? ''),
      originPath: typeof originPath === 'string' && originPath ? originPath : null,
      cloudSessionId: null,
      documentName: String(documentName ?? 'document.hwpx'),
      documentDigest: sha256Hex(bytes),
      documentSize: bytes.length,
      documentStagingPath,
      provider: String(provider ?? ''),
      executionConfig: { ...safeRecord(executionConfig) },
      goal: String(goal ?? ''),
      limits: { ...safeRecord(limits) },
      resources: stagedResources,
      timeline: timeline && typeof timeline === 'object' ? structuredClone(timeline) : null,
      destination: destination && typeof destination === 'object' ? structuredClone(destination) : null,
      lastEventSequence: 0,
      createdAt: now,
      updatedAt: now,
      error: null,
      errorCode: null,
      retryable: null,
      failurePhase: null,
    });
    this.#records.set(record.id, record);
    try {
      await this.#persist();
    } catch (error) {
      this.#records.delete(record.id);
      await fs.rm(payloadDirectory, { recursive: true, force: true });
      throw error;
    }
    return record;
  }

  async transition(id, nextState, patch = {}) {
    await this.load();
    const current = this.#records.get(id);
    if (!current) throw new Error('Cloud handoff does not exist');
    if (current.state === nextState) return current;
    if (!TRANSITIONS[current.state]?.has(nextState)) {
      throw new Error(`Invalid cloud handoff transition: ${current.state} -> ${nextState}`);
    }
    const terminal = TERMINAL_STATES.has(nextState);
    if (terminal) await fs.rm(path.join(this.#payloadRoot, id), { recursive: true, force: true });
    const next = Object.freeze({
      ...current,
      ...safeRecord(patch),
      ...(terminal ? {
        documentStagingPath: null,
        resources: (current.resources ?? []).map(({ stagingPath: _stagingPath, ...resource }) => resource),
      } : {}),
      id: current.id,
      version: current.version,
      state: nextState,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    validateRecord(next);
    this.#records.set(id, next);
    await this.#persist();
    return next;
  }

  async applyEvent(id, event) {
    await this.load();
    const current = this.#records.get(id);
    if (!current) return null;
    const sequence = Number(event?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence <= current.lastEventSequence) return current;
    const eventState = String(event?.state ?? current.state);
    const patch = { lastEventSequence: sequence, ...(safeRecord(event?.patch)) };
    if (eventState === current.state) {
      const next = Object.freeze({
        ...current,
        ...patch,
        id: current.id,
        state: current.state,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      this.#records.set(id, next);
      // High-frequency stream events must not rewrite the whole store on every
      // tick; a debounced write still survives crashes via server replay.
      this.#schedulePersist();
      return next;
    }
    return this.transition(id, eventState, patch);
  }

  async get(id) {
    await this.load();
    return this.#records.get(id) ?? null;
  }

  async list({ activeOnly = false } = {}) {
    if (!this.#loaded) await this.load();
    return [...this.#records.values()]
      .filter((record) => !activeOnly || !TERMINAL_STATES.has(record.state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async remove(id) {
    await this.load();
    const removed = this.#records.delete(id);
    if (removed) {
      await fs.rm(path.join(this.#payloadRoot, id), { recursive: true, force: true });
      await this.#persist();
    }
    return removed;
  }

  async dismiss(id) {
    return this.remove(id);
  }

  async consumeTakeoverBoundary(sessionId, operationId) {
    await this.load();
    const receipt = Object.freeze(validateTakeoverReceipt({
      sessionId,
      operationId,
      consumedAt: new Date().toISOString(),
    }));
    const key = takeoverReceiptKey(sessionId, operationId);
    const previous = this.#takeoverReceipts.get(key);
    if (previous) return previous;
    this.#takeoverReceipts.set(key, receipt);
    try {
      await this.#persist();
    } catch (error) {
      if (this.#takeoverReceipts.get(key) === receipt) this.#takeoverReceipts.delete(key);
      throw error;
    }
    return receipt;
  }

  async hasConsumedTakeoverBoundary(sessionId, operationId) {
    await this.load();
    validateTakeoverReceipt({ sessionId, operationId, consumedAt: new Date().toISOString() });
    return this.#takeoverReceipts.has(takeoverReceiptKey(sessionId, operationId));
  }

  async readPayload(id) {
    await this.load();
    const record = this.#records.get(id);
    if (!record?.documentStagingPath) throw new Error('Pending cloud payload is unavailable');
    const documentBytes = await fs.readFile(record.documentStagingPath);
    if (documentBytes.length !== record.documentSize || sha256Hex(documentBytes) !== record.documentDigest) {
      throw new Error('Pending cloud document failed integrity verification');
    }
    const resources = [];
    for (const resource of record.resources ?? []) {
      const bytes = await fs.readFile(resource.stagingPath);
      if (bytes.length !== resource.size || sha256Hex(bytes) !== resource.sha256) {
        throw new Error(`Pending cloud reference ${resource.name} failed integrity verification`);
      }
      resources.push({ ...resource, bytes: new Uint8Array(bytes) });
    }
    return { documentBytes: new Uint8Array(documentBytes), resources };
  }

  async clearPayload(id) {
    await this.load();
    const record = this.#records.get(id);
    if (!record) return false;
    await fs.rm(path.join(this.#payloadRoot, id), { recursive: true, force: true });
    await this.patch(id, {
      documentStagingPath: null,
      resources: (record.resources ?? []).map(({ stagingPath: _stagingPath, ...resource }) => resource),
    });
    return true;
  }

  async patch(id, patch = {}) {
    await this.load();
    const current = this.#records.get(id);
    if (!current) throw new Error('Cloud handoff does not exist');
    const next = Object.freeze({
      ...current,
      ...safeRecord(patch),
      id: current.id,
      version: current.version,
      state: current.state,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    validateRecord(next);
    this.#records.set(id, next);
    await this.#persist();
    return next;
  }

  #persist() {
    const snapshot = {
      version: 1,
      records: [...this.#records.values()],
      takeoverReceipts: [...this.#takeoverReceipts.values()],
    };
    const operation = this.#writeChain.then(() => atomicJsonWrite(this.#filePath, snapshot));
    this.#writeChain = operation.catch(() => {});
    return operation;
  }

  /** Trailing write for watermark-only updates; state changes persist immediately. */
  #schedulePersist() {
    if (this.#persistTimer) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      this.#persist().catch(() => {});
    }, CLOUD_HANDOFF_PERSIST_DEBOUNCE_MS);
    this.#persistTimer.unref?.();
  }

  flush() {
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    return this.#persist().catch(() => {});
  }
}

export function cloudConflictPath(originalPath, now = new Date()) {
  const parsed = path.parse(originalPath);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(parsed.dir, `${parsed.name}.cloud-${stamp}${parsed.ext}`);
}

export async function writeVerifiedRecoveryFile({ filePath, bytes, expectedDigest }) {
  const payload = Buffer.from(bytes ?? []);
  if (!payload.length) throw new Error('Cloud result is empty');
  const actualDigest = sha256Hex(payload);
  if (actualDigest !== expectedDigest) throw new Error('Cloud result digest does not match');
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temp, payload, { mode: 0o600 });
  const verified = await fs.readFile(temp);
  if (verified.length !== payload.length || sha256Hex(verified) !== expectedDigest) {
    await fs.rm(temp, { force: true });
    throw new Error('Cloud result could not be verified after writing');
  }
  await fs.rename(temp, filePath);
  return { filePath, byteLength: payload.length, digest: actualDigest };
}

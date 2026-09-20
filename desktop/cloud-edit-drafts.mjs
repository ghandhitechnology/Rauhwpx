import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { replaceFile } from './fs-replace.mjs';

const MAX_DRAFT_BYTES = 64 * 1024 * 1024;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkedId(value, label) {
  const text = String(value ?? '');
  if (!ID.test(text)) throw new Error(`Cloud edit ${label} is invalid`);
  return text;
}

function checkedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Cloud edit boundary revision is invalid');
  }
  return value;
}

function checkedWriterGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Cloud edit writer generation is invalid');
  }
  return value;
}

function checkedStateVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Cloud edit state version is invalid');
  }
  return value;
}

function checkedBytes(value) {
  const bytes = Buffer.from(value ?? []);
  if (bytes.length < 1 || bytes.length > MAX_DRAFT_BYTES) {
    throw new Error('Cloud edit draft size is invalid');
  }
  return bytes;
}

function keyFor(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex');
}

async function atomicWrite(filePath, bytes, platform) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporary, bytes, { mode: 0o600 });
  await replaceFile(temporary, filePath, platform);
}

export class CloudEditDraftStore {
  #root;
  #platform;
  #chains = new Map();

  constructor({ root, platform = process.platform } = {}) {
    if (!root) throw new Error('Cloud edit draft store requires a root');
    this.#root = root;
    this.#platform = platform;
  }

  #manifestPath(sessionId) {
    return path.join(this.#root, 'sessions', `${keyFor(sessionId)}.json`);
  }

  #blobPath(sessionId, sha256) {
    return path.join(this.#root, 'blobs', keyFor(sessionId), sha256);
  }

  #serialize(sessionId, operation) {
    const previous = this.#chains.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.#chains.set(sessionId, current);
    return current.finally(() => {
      if (this.#chains.get(sessionId) === current) this.#chains.delete(sessionId);
    });
  }

  save(input) {
    const sessionId = checkedId(input?.sessionId, 'session id');
    const editSessionId = checkedId(input?.editSessionId, 'session identity');
    const operationId = checkedId(input?.boundary?.operationId, 'boundary operation');
    const revision = checkedRevision(input?.boundary?.revision);
    const writerGeneration = checkedWriterGeneration(input?.boundary?.writerGeneration);
    const stateVersion = checkedStateVersion(input?.boundary?.stateVersion);
    const bytes = checkedBytes(input?.bytes);
    const sha256 = digest(bytes);
    const fileName = String(input?.fileName ?? 'cloud-draft.hwpx').slice(0, 512);
    if (!fileName || fileName.includes('\0')) throw new Error('Cloud edit file name is invalid');
    return this.#serialize(sessionId, async () => {
      const existing = await this.get(sessionId).catch(() => null);
      if (existing && existing.editSessionId !== editSessionId) {
        throw new Error('Another Cloud edit draft already owns this task');
      }
      const blobPath = this.#blobPath(sessionId, sha256);
      try {
        await fs.access(blobPath);
      } catch {
        await atomicWrite(blobPath, bytes, this.#platform);
      }
      const savedAt = new Date().toISOString();
      const manifest = {
        schema: 'rauhwpx.cloud-edit-draft',
        version: 1,
        sessionId,
        editSessionId,
        boundary: { operationId, revision, writerGeneration, stateVersion },
        fileName,
        sha256,
        size: bytes.length,
        savedAt,
      };
      await atomicWrite(
        this.#manifestPath(sessionId),
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
        this.#platform,
      );
      if (existing && existing.sha256 !== sha256) {
        await fs.rm(this.#blobPath(sessionId, existing.sha256), { force: true });
      }
      return { ...manifest, bytes: new Uint8Array(bytes) };
    });
  }

  async get(sessionIdInput) {
    const sessionId = checkedId(sessionIdInput, 'session id');
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(this.#manifestPath(sessionId), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (manifest?.schema !== 'rauhwpx.cloud-edit-draft' || manifest.version !== 1
      || manifest.sessionId !== sessionId) {
      throw new Error('Cloud edit draft manifest is invalid');
    }
    checkedId(manifest.editSessionId, 'session identity');
    checkedId(manifest.boundary?.operationId, 'boundary operation');
    checkedRevision(manifest.boundary?.revision);
    checkedWriterGeneration(manifest.boundary?.writerGeneration);
    checkedStateVersion(manifest.boundary?.stateVersion);
    if (!/^[a-f0-9]{64}$/.test(manifest.sha256)
      || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_DRAFT_BYTES) {
      throw new Error('Cloud edit draft manifest is invalid');
    }
    const bytes = await fs.readFile(this.#blobPath(sessionId, manifest.sha256));
    if (bytes.length !== manifest.size || digest(bytes) !== manifest.sha256) {
      throw new Error('Cloud edit draft failed integrity verification');
    }
    return { ...manifest, bytes: new Uint8Array(bytes) };
  }

  remove(sessionIdInput, editSessionIdInput = null) {
    const sessionId = checkedId(sessionIdInput, 'session id');
    return this.#serialize(sessionId, async () => {
      if (editSessionIdInput !== null) {
        const existing = await this.get(sessionId);
        if (!existing) return false;
        if (existing.editSessionId !== checkedId(editSessionIdInput, 'session identity')) return false;
      }
      await fs.rm(this.#manifestPath(sessionId), { force: true });
      await fs.rm(path.join(this.#root, 'blobs', keyFor(sessionId)), { recursive: true, force: true });
      return true;
    });
  }
}

export const __test = { digest, keyFor, MAX_DRAFT_BYTES };

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { sha256Hex, writeVerifiedRecoveryFile } from './cloud-handoff.mjs';

const CHUNK_BYTES = 512 * 1024;
const MAX_BYTES = 128 * 1024 * 1024;
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);

export function validateMergeRequest(value) {
  if (!value || !['id', 'runId', 'sessionId', 'documentId', 'threadId', 'cloudStartId', 'operationId'].every((key) => id(value[key]))
    || value.kind !== 'turn' || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.turn) || value.turn < 0
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_BYTES
    || value.chunkCount !== Math.ceil(value.size / CHUNK_BYTES)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.fileName !== 'string' || !value.fileName || value.fileName.length > 255
    || /[\\/\0]/.test(value.fileName)) throw new Error('Cloud merge request is invalid');
  return Object.fromEntries(['id', 'runId', 'sessionId', 'documentId', 'threadId', 'cloudStartId',
    'operationId', 'revision', 'turn', 'kind', 'fileName', 'sha256', 'size', 'chunkCount'].map((key) => [key, value[key]]));
}

/** The broker owns delivery; this cache keeps verified downloads usable locally. */
export class CloudMergeRecovery {
  constructor({ store, recoveryDir, provider }) {
    this.store = store;
    this.directory = recoveryDir ? path.join(recoveryDir, 'durable-merges') : null;
    this.provider = provider;
    this.requests = [];
    this.generation = 0;
    this.inflight = null;
    this.refreshedAt = 0;
  }

  reset() {
    this.generation += 1;
    this.requests = [];
    this.accountId = null;
    this.refreshedAt = 0;
    this.inflight = null;
  }

  async refresh({ force = false, assertCurrent = () => {} } = {}) {
    const provider = this.provider();
    if (!provider?.listMergeRequests) return;
    if (this.inflight) return this.inflight;
    if (!force && Date.now() - this.refreshedAt < 15_000) return;
    this.refreshedAt = Date.now();
    const generation = this.generation;
    const check = () => {
      assertCurrent();
      if (generation !== this.generation) throw new DOMException('Cloud account changed', 'AbortError');
    };
    const task = (async () => {
      const cacheIdentity = await provider.getLocalCacheIdentity?.();
      check();
      let result;
      try { result = await provider.listMergeRequests(); } catch (error) {
        check();
        if (error.status === 401 || error.status === 403 || /AUTH_REQUIRED|ACCOUNT_SESSION/.test(error.code ?? '')) throw error;
        if (!cacheIdentity || cacheIdentity !== await provider.getLocalCacheIdentity?.()) throw error;
        const records = await this.store.list();
        check();
        const cached = records.flatMap((record) => (record.mergeArchives ?? []).filter((entry) => (
          entry.cacheIdentity === cacheIdentity && entry.cachePath && entry.sessionId === record.cloudSessionId
          && entry.documentId === record.originDocumentId && entry.threadId === record.threadId
        )));
        if (!cached.length) throw error;
        const accountId = cached[0].accountId;
        if (!id(accountId) || cached.some((entry) => entry.accountId !== accountId)) throw error;
        this.requests = cached.map((entry) => ({ ...validateMergeRequest(entry), localAvailable: true }));
        this.accountId = accountId;
        return;
      }
      check();
      if (!id(result?.accountId) || !Array.isArray(result.mergeRequests) || result.mergeRequests.length > 1024) {
        throw new Error('Cloud merge inbox is invalid');
      }
      if (cacheIdentity && cacheIdentity !== await provider.getLocalCacheIdentity?.()) {
        throw new DOMException('Cloud account changed', 'AbortError');
      }
      check();
      const incoming = result.mergeRequests.map(validateMergeRequest);
      const records = await this.store.list();
      check();
      const requests = [];
      for (const record of records) {
        const matching = incoming.filter((entry) => entry.sessionId === record.cloudSessionId
          && entry.documentId === record.originDocumentId && entry.threadId === record.threadId
          && (!record.timeline?.thread?.cloudStartId || entry.cloudStartId === record.timeline.thread.cloudStartId));
        const mergeEntries = (latest) => {
          const cached = (latest.mergeArchives ?? []).filter((entry) => entry.accountId === result.accountId
            && (entry.cachePath || matching.some((request) => request.operationId === entry.operationId)));
          const merged = new Map(cached.map((entry) => [entry.operationId, entry]));
          for (const entry of matching) {
            const previous = merged.get(entry.operationId);
            if (previous && JSON.stringify(validateMergeRequest(previous)) !== JSON.stringify(entry)) {
              throw new Error('Cloud merge receipt changed');
            }
            merged.set(entry.operationId, { ...previous, ...entry, accountId: result.accountId,
              ...(cacheIdentity ? { cacheIdentity } : {}) });
          }
          return [...merged.values()];
        };
        let entries = mergeEntries(record);
        if (matching.length) {
          // Preserve a download receipt written while discovery was in flight.
          const updated = await this.store.patch(record.id, (latest) => ({ mergeArchives: [
            ...(latest.mergeArchives ?? []).filter((entry) => entry.accountId !== result.accountId),
            ...mergeEntries(latest),
          ] }));
          check();
          entries = mergeEntries(updated);
        }
        requests.push(...entries.map((entry) => ({ ...validateMergeRequest(entry), localAvailable: Boolean(entry.cachePath) })));
      }
      this.accountId = result.accountId;
      this.requests = requests;
      this.refreshedAt = Date.now();
    })().catch((error) => {
      if (generation === this.generation && (error.status === 401 || error.status === 403
        || /AUTH_REQUIRED|ACCOUNT_SESSION/.test(error.code ?? ''))) {
        this.reset();
        this.refreshedAt = Date.now();
      }
      throw error;
    }).finally(() => { if (this.inflight === task) this.inflight = null; });
    this.inflight = task;
    return task;
  }

  async download(sessionId, operationId, assertCurrent = () => {}) {
    const receipt = this.requests.find((entry) => entry.sessionId === sessionId && entry.operationId === operationId);
    if (!receipt) return null;
    const generation = this.generation;
    const accountId = this.accountId;
    const check = () => {
      assertCurrent();
      if (generation !== this.generation || accountId !== this.accountId) throw new DOMException('Cloud account changed', 'AbortError');
    };
    const record = (await this.store.list()).find((entry) => entry.cloudSessionId === sessionId
      && entry.originDocumentId === receipt.documentId && entry.threadId === receipt.threadId);
    check();
    if (!record) throw new Error('Cloud merge origin is unavailable');
    const cacheIdentity = await this.provider().getLocalCacheIdentity?.();
    check();
    const archive = (record.mergeArchives ?? []).find((entry) => entry.id === receipt.id && entry.accountId === accountId);
    if (this.provider().getLocalCacheIdentity && (!cacheIdentity || archive?.cacheIdentity !== cacheIdentity)) {
      throw new DOMException('Cloud account changed', 'AbortError');
    }
    const filePath = path.join(this.directory, sha256Hex(Buffer.from(`${this.accountId}:${receipt.id}`)), receipt.fileName);
    let bytes = await readFile(filePath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (bytes && (bytes.length !== receipt.size || sha256Hex(bytes) !== receipt.sha256)) bytes = null;
    if (!bytes) {
      bytes = Buffer.alloc(receipt.size);
      for (let index = 0; index < receipt.chunkCount; index += 1) {
        const result = await this.provider().downloadMergeChunk(receipt.id, index);
        check();
        const encoded = result?.bytesBase64;
        const expected = Math.min(CHUNK_BYTES, receipt.size - index * CHUNK_BYTES);
        if (typeof encoded !== 'string' || encoded.length !== 4 * Math.ceil(expected / 3)
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Cloud merge chunk is invalid');
        const chunk = Buffer.from(encoded, 'base64');
        if (chunk.length !== expected || chunk.toString('base64') !== encoded) throw new Error('Cloud merge chunk size is invalid');
        chunk.copy(bytes, index * CHUNK_BYTES);
      }
      if (sha256Hex(bytes) !== receipt.sha256) throw new Error('Cloud merge document digest does not match');
      await writeVerifiedRecoveryFile({ filePath, bytes, expectedDigest: receipt.sha256 });
      check();
    }
    await this.store.patch(record.id, (latest) => ({ mergeArchives: (latest.mergeArchives ?? []).map((entry) => (
      entry.accountId === this.accountId && entry.id === receipt.id ? { ...entry, cachePath: filePath } : entry
    )) }));
    check();
    if (cacheIdentity && cacheIdentity !== await this.provider().getLocalCacheIdentity?.()) {
      throw new DOMException('Cloud account changed', 'AbortError');
    }
    check();
    receipt.localAvailable = true;
    return {
      sessionId, documentId: receipt.documentId, fileName: receipt.fileName,
      bytes: new Uint8Array(bytes), byteLength: receipt.size, sha256: receipt.sha256,
      revision: receipt.revision, turn: receipt.turn, operationId: receipt.operationId, kind: 'turn',
      originOnThisDevice: true,
      expectedOriginSha256: Object.hasOwn(record, 'originDigest') ? record.originDigest : record.documentDigest,
    };
  }
}

// Bounded, sender-scoped storage for extension document fetches. The service
// worker owns the fetched bytes and exposes only one small sequential chunk per
// message, avoiding Chrome's whole-file Uint8Array -> JSON number[] expansion.

export const FETCH_TRANSFER_CHUNK_BYTES = 256 * 1024;
export const FETCH_TRANSFER_IDLE_TTL_MS = 30 * 1000;
export const FETCH_TRANSFER_START_TTL_MS = 2 * 60 * 1000;
export const FETCH_TRANSFER_MAX_ACTIVE = 2;
export const FETCH_TRANSFER_MAX_BYTES = 128 * 1024 * 1024;

export class FetchTransferError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'FetchTransferError';
    this.code = code;
  }
}

export function encodeJsonNumberChunk(chunk) {
  return Array.from(chunk);
}

export function encodeArrayBufferChunk(chunk) {
  // A subarray's .buffer may expose the complete document. Return an exact
  // copy so Firefox structured-clones only this bounded chunk.
  return chunk.slice().buffer;
}

function exactSenderScope(sender) {
  const url = sender?.url || sender?.tab?.url;
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId ?? 0;
  const documentId = sender?.documentId ?? '';

  if (
    typeof url !== 'string'
    || url.length === 0
    || !Number.isInteger(tabId)
    || tabId < 0
    || !Number.isInteger(frameId)
    || frameId < 0
    || (documentId !== '' && typeof documentId !== 'string')
  ) {
    throw new FetchTransferError('invalid-sender', 'Transfer sender identity is unavailable.');
  }

  return JSON.stringify([tabId, frameId, documentId, url]);
}

function validTransferId(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128;
}

export class FetchTransferStore {
  constructor(options = {}) {
    this.chunkBytes = options.chunkBytes ?? FETCH_TRANSFER_CHUNK_BYTES;
    this.idleTtlMs = options.idleTtlMs ?? FETCH_TRANSFER_IDLE_TTL_MS;
    this.startTtlMs = options.startTtlMs ?? FETCH_TRANSFER_START_TTL_MS;
    this.maxActive = options.maxActive ?? FETCH_TRANSFER_MAX_ACTIVE;
    this.maxBytes = options.maxBytes ?? FETCH_TRANSFER_MAX_BYTES;
    this.encodeChunk = options.encodeChunk ?? encodeJsonNumberChunk;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID());
    this.entries = new Map();

    for (const [name, value] of [
      ['chunkBytes', this.chunkBytes],
      ['idleTtlMs', this.idleTtlMs],
      ['startTtlMs', this.startTtlMs],
      ['maxActive', this.maxActive],
      ['maxBytes', this.maxBytes],
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer.`);
      }
    }
    if (typeof this.encodeChunk !== 'function') throw new TypeError('encodeChunk must be a function.');
  }

  get activeCount() {
    this.#pruneExpired();
    return this.entries.size;
  }

  reserve(sender, options = {}) {
    this.#pruneExpired();
    if (this.entries.size >= this.maxActive) {
      throw new FetchTransferError('transfer-capacity', 'Too many document transfers are active.');
    }

    const owner = exactSenderScope(sender);
    let transferId = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.createId();
      if (validTransferId(candidate) && !this.entries.has(candidate)) {
        transferId = candidate;
        break;
      }
    }
    if (!transferId) throw new FetchTransferError('transfer-id', 'Unable to create a transfer identifier.');

    const entry = {
      transferId,
      owner,
      bytes: null,
      nextIndex: 0,
      expiresAt: 0,
      timer: null,
      onExpire: typeof options.onExpire === 'function' ? options.onExpire : null,
    };
    this.entries.set(transferId, entry);
    this.#touch(entry, this.startTtlMs);
    return { transferId };
  }

  commit(transferId, sender, bytes) {
    const entry = this.#ownedEntry(transferId, sender);
    if (!(bytes instanceof Uint8Array)) {
      throw new FetchTransferError('invalid-bytes', 'Transfer bytes must be a Uint8Array.');
    }
    if (
      !Number.isSafeInteger(bytes.byteLength)
      || bytes.byteLength <= 0
      || bytes.byteLength > this.maxBytes
    ) {
      throw new FetchTransferError('invalid-size', `Document transfer exceeds ${this.maxBytes} bytes.`);
    }
    if (entry.bytes !== null) {
      throw new FetchTransferError('already-committed', 'Document transfer is already ready.');
    }

    entry.bytes = bytes;
    entry.onExpire = null;
    this.#touch(entry, this.idleTtlMs);
    return {
      transferId,
      byteLength: bytes.byteLength,
      chunkBytes: this.chunkBytes,
      chunkCount: Math.ceil(bytes.byteLength / this.chunkBytes),
    };
  }

  readChunk(transferId, index, sender) {
    const entry = this.#ownedEntry(transferId, sender);
    if (entry.bytes === null) {
      throw new FetchTransferError('not-ready', 'Document transfer is not ready.');
    }
    if (!Number.isSafeInteger(index) || index < 0 || index !== entry.nextIndex) {
      throw new FetchTransferError('chunk-order', `Expected transfer chunk ${entry.nextIndex}.`);
    }

    const offset = index * this.chunkBytes;
    if (!Number.isSafeInteger(offset) || offset >= entry.bytes.byteLength) {
      throw new FetchTransferError('chunk-range', 'Transfer chunk is outside the document.');
    }
    const end = Math.min(offset + this.chunkBytes, entry.bytes.byteLength);
    const chunk = entry.bytes.subarray(offset, end);
    const data = this.encodeChunk(chunk);
    entry.nextIndex += 1;
    this.#touch(entry, this.idleTtlMs);
    return {
      transferId,
      index,
      offset,
      byteLength: chunk.byteLength,
      done: end === entry.bytes.byteLength,
      data,
    };
  }

  close(transferId, sender) {
    const entry = this.#ownedEntry(transferId, sender);
    this.#drop(entry, false);
    return true;
  }

  #ownedEntry(transferId, sender) {
    this.#pruneExpired();
    if (!validTransferId(transferId)) {
      throw new FetchTransferError('invalid-transfer-id', 'Invalid transfer identifier.');
    }
    const entry = this.entries.get(transferId);
    if (!entry) throw new FetchTransferError('unknown-transfer', 'Document transfer is no longer available.');
    if (entry.owner !== exactSenderScope(sender)) {
      throw new FetchTransferError('sender-mismatch', 'Document transfer belongs to a different sender.');
    }
    return entry;
  }

  #touch(entry, ttlMs) {
    if (entry.timer !== null) this.clearTimer(entry.timer);
    entry.expiresAt = this.now() + ttlMs;
    entry.timer = this.setTimer(() => this.#expireWhenDue(entry), ttlMs);
    entry.timer?.unref?.();
  }

  #expireWhenDue(entry) {
    if (this.entries.get(entry.transferId) !== entry) return;
    const remaining = entry.expiresAt - this.now();
    if (remaining > 0) {
      entry.timer = this.setTimer(() => this.#expireWhenDue(entry), remaining);
      entry.timer?.unref?.();
      return;
    }
    this.#drop(entry, true);
  }

  #pruneExpired() {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.expiresAt <= now) this.#drop(entry, true);
    }
  }

  #drop(entry, expired) {
    if (this.entries.get(entry.transferId) !== entry) return;
    this.entries.delete(entry.transferId);
    if (entry.timer !== null) this.clearTimer(entry.timer);
    entry.timer = null;
    entry.bytes = null;
    if (expired && entry.onExpire) {
      try {
        entry.onExpire();
      } catch {
        // Expiry cleanup must not keep an otherwise unreachable transfer alive.
      }
    }
    entry.onExpire = null;
  }
}

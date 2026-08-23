import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { transaction } from './database.mjs';
import { CloudError, TRANSFER_LIMITS } from './protocol.mjs';

async function digestFile(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

export class BlobStore {
  constructor(database, { root, now = Date.now, chunkBytes = TRANSFER_LIMITS.chunkBytes } = {}) {
    this.database = database;
    this.root = root;
    this.staging = path.join(root, 'staging');
    this.blobs = path.join(root, 'blobs');
    this.now = now;
    this.chunkBytes = chunkBytes;
    mkdirSync(this.staging, { recursive: true, mode: 0o700 });
    mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
  }

  get(sha256) {
    return this.database.prepare('SELECT * FROM blobs WHERE sha256 = ?').get(sha256) ?? null;
  }

  async initUpload({ deviceId, sha256, size, name, kind, sessionId = null }) {
    const blob = this.get(sha256);
    if (blob) {
      if (blob.size !== size) throw new CloudError('BLOB_SIZE_MISMATCH', 'Stored blob size does not match upload', 409);
      return this.#uploadResponse(null, blob, true);
    }
    const obsolete = this.database.prepare(`
      SELECT * FROM uploads
      WHERE device_id = ? AND sha256 = ? AND size = ? AND kind = ?
        AND ((session_id IS NULL AND ? IS NULL) OR session_id = ?)
        AND status IN ('failed', 'expired', 'complete')
    `).all(deviceId, sha256, size, kind, sessionId, sessionId);
    for (const upload of obsolete) {
      await fs.rm(upload.temp_path, { force: true });
      this.database.prepare('DELETE FROM uploads WHERE id = ?').run(upload.id);
    }
    const existing = this.database.prepare(`
      SELECT * FROM uploads
      WHERE device_id = ? AND sha256 = ? AND size = ? AND kind = ?
        AND ((session_id IS NULL AND ? IS NULL) OR session_id = ?)
        AND status = 'uploading'
      ORDER BY created_at DESC LIMIT 1
    `).get(deviceId, sha256, size, kind, sessionId, sessionId);
    if (existing) {
      await this.#reconcileUploadFile(existing);
      return this.#uploadResponse(this.database.prepare('SELECT * FROM uploads WHERE id = ?').get(existing.id));
    }
    if (sessionId) {
      const reserved = this.database.prepare(`
        SELECT COALESCE(SUM(size), 0) AS size FROM uploads
        WHERE session_id = ? AND status IN ('uploading', 'complete')
      `).get(sessionId).size;
      if (reserved + size > 10 * 1024 ** 3) {
        throw new CloudError('SESSION_STORAGE_LIMIT', 'Session storage exceeds 10 GiB', 413);
      }
    }
    const now = this.now();
    const id = randomUUID();
    const tempPath = path.join(this.staging, `${id}.part`);
    await fs.writeFile(tempPath, Buffer.alloc(0), { mode: 0o600 });
    this.database.prepare(`
      INSERT INTO uploads(id, device_id, session_id, sha256, size, name, kind, temp_path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)
    `).run(id, deviceId, sessionId, sha256, size, name, kind, tempPath, now, now);
    const upload = this.database.prepare('SELECT * FROM uploads WHERE id = ?').get(id);
    if (size === 0) return this.#finish(upload);
    return this.#uploadResponse(upload);
  }

  async #reconcileUploadFile(upload) {
    const stat = await fs.stat(upload.temp_path).catch(() => null);
    if (!stat) {
      await fs.writeFile(upload.temp_path, Buffer.alloc(0), { mode: 0o600 });
      this.database.prepare('UPDATE uploads SET received_bytes = 0, updated_at = ? WHERE id = ?').run(this.now(), upload.id);
      return;
    }
    if (stat.size > upload.received_bytes) await fs.truncate(upload.temp_path, upload.received_bytes);
    if (stat.size < upload.received_bytes) {
      this.database.prepare('UPDATE uploads SET received_bytes = ?, updated_at = ? WHERE id = ?').run(stat.size, this.now(), upload.id);
    }
  }

  async appendChunk({ uploadId, deviceId, offset, bytes }) {
    const upload = this.database.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId);
    if (!upload || upload.device_id !== deviceId) throw new CloudError('UPLOAD_NOT_FOUND', 'Upload was not found', 404);
    if (upload.status !== 'uploading') {
      const blob = this.get(upload.sha256);
      return this.#uploadResponse(upload, blob);
    }
    await this.#reconcileUploadFile(upload);
    const current = this.database.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId);
    if (offset !== current.received_bytes) {
      throw new CloudError('UPLOAD_OFFSET_MISMATCH', 'Upload offset does not match', 409, { expectedOffset: current.received_bytes });
    }
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > this.chunkBytes) {
      throw new CloudError('UPLOAD_CHUNK_INVALID', 'Upload chunk size is invalid', 413, { chunkBytes: this.chunkBytes });
    }
    if (offset + bytes.length > current.size) throw new CloudError('UPLOAD_TOO_LARGE', 'Upload exceeds declared size', 413);
    const handle = await fs.open(current.temp_path, 'r+');
    try {
      await handle.write(bytes, 0, bytes.length, offset);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const received = offset + bytes.length;
    this.database.prepare('UPDATE uploads SET received_bytes = ?, updated_at = ? WHERE id = ?')
      .run(received, this.now(), uploadId);
    const updated = this.database.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId);
    return received === updated.size ? this.#finish(updated) : this.#uploadResponse(updated);
  }

  async #finish(upload) {
    const digest = await digestFile(upload.temp_path);
    if (digest !== upload.sha256) {
      this.database.prepare(`UPDATE uploads SET status = 'failed', updated_at = ? WHERE id = ?`).run(this.now(), upload.id);
      await fs.rm(upload.temp_path, { force: true });
      throw new CloudError('UPLOAD_DIGEST_MISMATCH', 'Upload digest does not match', 422);
    }
    const directory = path.join(this.blobs, digest.slice(0, 2));
    const destination = path.join(directory, digest);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (existsSync(destination)) await fs.rm(upload.temp_path, { force: true });
    else await fs.rename(upload.temp_path, destination);
    const descriptor = openSync(directory, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    const now = this.now();
    transaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO blobs(sha256, size, storage_path, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(sha256) DO NOTHING
      `).run(digest, upload.size, destination, now);
      this.database.prepare(`UPDATE uploads SET status = 'complete', received_bytes = size, updated_at = ? WHERE id = ?`)
        .run(now, upload.id);
    });
    return this.#uploadResponse(this.database.prepare('SELECT * FROM uploads WHERE id = ?').get(upload.id), this.get(digest));
  }

  #uploadResponse(upload, blob = null, blobExists = false) {
    if (!upload && blob) {
      return {
        uploadId: null,
        chunkSize: this.chunkBytes,
        offset: blob.size,
        status: 'complete',
        blobExists,
        blob: { id: blob.sha256, sha256: blob.sha256, size: blob.size },
      };
    }
    return {
      uploadId: upload.id,
      chunkSize: this.chunkBytes,
      offset: upload.received_bytes,
      status: upload.status,
      blobExists,
      blob: blob ? { id: blob.sha256, sha256: blob.sha256, size: blob.size } : null,
    };
  }

  openReadStream(sha256) {
    const blob = this.get(sha256);
    if (!blob) throw new CloudError('BLOB_NOT_FOUND', 'Blob was not found', 404);
    return { blob, stream: createReadStream(blob.storage_path) };
  }

  async removeUploadTempFiles(uploads) {
    let removed = 0;
    for (const upload of uploads ?? []) {
      if (!upload
        || typeof upload.id !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(upload.id)
        || typeof upload.tempPath !== 'string') continue;
      const expected = path.resolve(this.staging, `${upload.id}.part`);
      const candidate = path.resolve(upload.tempPath);
      // Only remove the exact staging file name generated by initUpload. A
      // malformed database path must never widen purge into arbitrary files.
      if (candidate !== expected) continue;
      await fs.rm(candidate, { force: true });
      removed += 1;
    }
    return removed;
  }

  async removeUnreferenced(sha256) {
    const blob = this.get(sha256);
    if (!blob || blob.ref_count > 0) return false;
    transaction(this.database, () => {
      this.database.prepare(`DELETE FROM uploads WHERE sha256 = ? AND status = 'complete'`).run(sha256);
      this.database.prepare('DELETE FROM blobs WHERE sha256 = ? AND ref_count = 0').run(sha256);
    });
    await fs.rm(blob.storage_path, { force: true });
    return true;
  }

  async pruneStaleUploads(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = this.now() - maxAgeMs;
    const stale = this.database.prepare(`SELECT * FROM uploads WHERE status = 'uploading' AND updated_at < ?`).all(cutoff);
    for (const upload of stale) {
      await fs.rm(upload.temp_path, { force: true });
      this.database.prepare(`UPDATE uploads SET status = 'expired', updated_at = ? WHERE id = ?`).run(this.now(), upload.id);
    }
    const completed = this.database.prepare(`
      SELECT * FROM uploads WHERE status = 'complete' AND updated_at < ?
    `).all(cutoff);
    for (const upload of completed) {
      if (!await this.removeUnreferenced(upload.sha256)) {
        this.database.prepare(`DELETE FROM uploads WHERE id = ? AND status = 'complete'`).run(upload.id);
      }
    }
    const obsolete = this.database.prepare(`
      SELECT * FROM uploads WHERE status IN ('failed', 'expired') AND updated_at < ?
    `).all(cutoff);
    for (const upload of obsolete) {
      await fs.rm(upload.temp_path, { force: true });
      this.database.prepare(`DELETE FROM uploads WHERE id = ?`).run(upload.id);
    }
    return stale.length + completed.length + obsolete.length;
  }
}

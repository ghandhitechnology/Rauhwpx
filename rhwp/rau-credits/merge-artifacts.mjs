import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { syncDirectory } from './store.mjs';

export const MERGE_CHUNK_BYTES = 512 * 1024;
export const MERGE_MAX_BYTES = 128 * 1024 * 1024;
export const MERGE_ACCOUNT_BYTES = 512 * 1024 * 1024;
export const MERGE_ACCOUNT_COUNT = 1024;
export const MERGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const fail = (code, message) => Object.assign(new Error(message), { code });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fields = ['sessionId', 'documentId', 'threadId', 'cloudStartId', 'operationId'];

function validate(input) {
  const metadata = {};
  for (const name of fields) {
    if (typeof input?.[name] !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(input[name])) {
      throw fail('CLOUD_INVALID_REQUEST', `${name} is invalid`);
    }
    metadata[name] = input[name];
  }
  for (const name of ['revision', 'turn', 'size', 'chunkCount', 'chunkIndex']) {
    if (!Number.isSafeInteger(input[name]) || input[name] < (['revision', 'size', 'chunkCount'].includes(name) ? 1 : 0)) {
      throw fail('CLOUD_INVALID_REQUEST', `${name} is invalid`);
    }
  }
  if (input.kind !== 'turn' || typeof input.fileName !== 'string' || !input.fileName.trim()
    || input.fileName.length > 255 || /[\x00-\x1f/\\]/.test(input.fileName)
    || !/^[a-f0-9]{64}$/.test(input.sha256 ?? '') || input.size > MERGE_MAX_BYTES
    || input.chunkCount !== Math.ceil(input.size / MERGE_CHUNK_BYTES)
    || input.chunkIndex >= input.chunkCount) throw fail('CLOUD_INVALID_REQUEST', 'Invalid merge checkpoint metadata');
  const encoded = input.bytesBase64;
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MERGE_CHUNK_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw fail('CLOUD_INVALID_REQUEST', 'Invalid base64 chunk');
  }
  const bytes = Buffer.from(encoded, 'base64');
  const expected = Math.min(MERGE_CHUNK_BYTES, input.size - input.chunkIndex * MERGE_CHUNK_BYTES);
  if (bytes.length !== expected || bytes.toString('base64') !== encoded) throw fail('CLOUD_INVALID_REQUEST', 'Incorrect chunk size');
  for (const name of ['revision', 'turn', 'kind', 'fileName', 'sha256', 'size', 'chunkCount']) metadata[name] = input[name];
  return { metadata, bytes, index: input.chunkIndex };
}

export function createMergeArtifacts({ store, sessionSecret, now = Date.now,
  accountBytes = MERGE_ACCOUNT_BYTES, accountCount = MERGE_ACCOUNT_COUNT }) {
  if (!sessionSecret) throw new Error('sessionSecret is required for checkpoint encryption');
  const key = createHash('sha256').update(`rau-merge-artifacts:v1:${sessionSecret}`).digest();
  const aad = (accountId, id, index) => Buffer.from(JSON.stringify([accountId, id, index]));
  const encrypt = (accountId, id, index, bytes) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(accountId, id, index));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  };
  const decrypt = (accountId, id, index, bytes) => {
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(aad(accountId, id, index));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
  };
  const publicRecord = ({ complete, ...record }) => record;
  return {
    async upload(accountId, runId, input) {
      const { metadata, bytes, index } = validate(input);
      const id = `merge_${hash(JSON.stringify([accountId, metadata.sessionId, metadata.operationId]))}`;
      return store.transaction(accountId, async (repo) => {
        await repo.expire(now());
        let record = await repo.get(id);
        if (record) {
          if (Object.entries(metadata).some(([name, value]) => record[name] !== value)) {
            throw fail('CLOUD_MERGE_CONFLICT', 'This operation already has different checkpoint metadata');
          }
        } else {
          const records = await repo.list();
          if (records.length >= accountCount || records.reduce((sum, item) => sum + item.size, 0) + metadata.size > accountBytes) {
            throw fail('CLOUD_MERGE_CAPACITY', 'Checkpoint storage allowance is full');
          }
          record = { id, runId, ...metadata, createdAt: now(), expiresAt: now() + MERGE_RETENTION_MS, complete: false };
          await repo.put(record);
        }
        const previous = await repo.chunk(id, index);
        if (previous) {
          if (!decrypt(accountId, id, index, previous).equals(bytes)) throw fail('CLOUD_MERGE_CONFLICT', 'This chunk already contains different bytes');
        } else {
          await repo.putChunk(id, index, encrypt(accountId, id, index, bytes));
        }
        if (!record.complete && await repo.chunkCount(id) === record.chunkCount) {
          const digest = createHash('sha256');
          let total = 0;
          let complete = true;
          for (let i = 0; i < record.chunkCount; i++) {
            const encrypted = await repo.chunk(id, i);
            if (!encrypted) { complete = false; break; }
            const decoded = decrypt(accountId, id, i, encrypted);
            total += decoded.length;
            digest.update(decoded);
          }
          if (complete) {
            if (total !== record.size || digest.digest('hex') !== record.sha256) throw fail('CLOUD_MERGE_DIGEST_MISMATCH', 'Checkpoint digest does not match');
            record.complete = true;
            await repo.put(record);
          }
        }
        return { complete: record.complete, mergeRequest: publicRecord(record) };
      });
    },
    async list(accountId, sessionId) {
      if (sessionId != null && (typeof sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(sessionId))) throw fail('CLOUD_INVALID_REQUEST', 'sessionId is invalid');
      return store.transaction(accountId, async (repo) => ({ mergeRequests: (await repo.list())
        .filter((item) => item.complete && item.expiresAt > now() && (sessionId == null || item.sessionId === sessionId))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(publicRecord) }));
    },
    async chunk(accountId, id, index) {
      if (!/^merge_[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(index) || index < 0) throw fail('CLOUD_INVALID_REQUEST', 'Invalid checkpoint chunk');
      return store.transaction(accountId, async (repo) => {
        const record = await repo.get(id);
        if (!record?.complete || record.expiresAt <= now() || index >= record.chunkCount) throw fail('CLOUD_MERGE_NOT_FOUND', 'Checkpoint not found');
        const bytes = await repo.chunk(id, index);
        if (!bytes) throw fail('CLOUD_MERGE_NOT_FOUND', 'Checkpoint chunk not found');
        return { bytesBase64: decrypt(accountId, id, index, bytes).toString('base64') };
      });
    },
    async cleanup() { await store.cleanup(now()); },
  };
}

function serialized() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task, task);
    tail = result.catch(() => {});
    return result;
  };
}

export function createMemoryMergeStore() {
  const accounts = new Map();
  const queue = serialized();
  return {
    transaction(accountId, task) {
      return queue(async () => {
        const state = structuredClone(accounts.get(accountId) ?? { records: {}, chunks: {} });
        const result = await task(objectRepository(state));
        accounts.set(accountId, state);
        return result;
      });
    },
    cleanup(at) { return queue(async () => { for (const state of accounts.values()) await objectRepository(state).expire(at); }); },
  };
}

function objectRepository(state) {
  return {
    async list() { return Object.values(state.records); },
    async get(id) { return state.records[id]; },
    async put(record) { state.records[record.id] = record; },
    async chunk(id, index) { const value = state.chunks[`${id}:${index}`]; return value ? Buffer.from(value) : null; },
    async putChunk(id, index, bytes) { state.chunks[`${id}:${index}`] = bytes; },
    async chunkCount(id) { return Object.keys(state.chunks).filter((key) => key.startsWith(`${id}:`)).length; },
    async expire(at) {
      for (const record of Object.values(state.records)) if (record.expiresAt <= at) {
        delete state.records[record.id];
        for (let i = 0; i < record.chunkCount; i++) delete state.chunks[`${record.id}:${i}`];
      }
    },
  };
}

// Local development uses immutable chunk files and atomically published metadata.
// A directory must have only one broker process; production uses PostgreSQL locks.
export function createFileMergeStore(directory) {
  const queue = serialized();
  async function read(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  async function write(file, bytes) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(12).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, file);
      await syncDirectory(path.dirname(file));
    } finally { await handle?.close(); await fs.rm(temporary, { force: true }); }
  }
  async function transaction(accountKey, task) {
    const location = path.join(directory, accountKey);
    const file = path.join(location, 'metadata.json');
    const records = await read(file);
    const pending = new Map();
    const removed = [];
    let changed = false;
    const chunkPath = (id, index) => path.join(location, `${id}.${index}.enc`);
    const repo = {
      async list() { return Object.values(records); },
      async get(id) { return records[id]; },
      async put(record) { records[record.id] = record; changed = true; },
      async chunk(id, index) {
        const key = chunkPath(id, index);
        if (pending.has(key)) return pending.get(key);
        if (removed.includes(key)) return null;
        try { return await fs.readFile(key); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      },
      async putChunk(id, index, bytes) { pending.set(chunkPath(id, index), bytes); },
      async chunkCount(id) {
        const files = await fs.readdir(location).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
        return new Set([...files.filter((name) => name.startsWith(`${id}.`) && name.endsWith('.enc') && !removed.includes(path.join(location, name))),
          ...[...pending.keys()].map((name) => path.basename(name)).filter((name) => name.startsWith(`${id}.`))]).size;
      },
      async expire(at) {
        for (const record of Object.values(records)) if (record.expiresAt <= at) {
          delete records[record.id]; changed = true;
          for (let i = 0; i < record.chunkCount; i++) removed.push(chunkPath(record.id, i));
        }
      },
    };
    const result = await task(repo);
    for (const [file, bytes] of pending) await write(file, bytes);
    if (changed) await write(file, JSON.stringify(records));
    for (const file of removed) if (!pending.has(file)) await fs.rm(file, { force: true });
    return result;
  }
  return {
    transaction(accountId, task) { return queue(() => transaction(hash(accountId), task)); },
    cleanup(at) {
      return queue(async () => {
        const directories = await fs.readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
        for (const name of directories.filter((name) => /^[a-f0-9]{64}$/.test(name))) {
          await transaction(name, (repo) => repo.expire(at));
          const location = path.join(directory, name);
          const records = await read(path.join(location, 'metadata.json'));
          for (const file of await fs.readdir(location)) {
            const match = file.match(/^(merge_[a-f0-9]{64})\.\d+\.enc$/);
            if ((match && !records[match[1]]) || file.endsWith('.tmp')) await fs.rm(path.join(location, file), { force: true });
          }
        }
      });
    },
  };
}

export async function createPostgresMergeStore({ connectionString, PoolClass = null }) {
  const Pool = PoolClass ?? (await import('pg')).Pool;
  const pool = new Pool({ connectionString });
  await pool.query(`CREATE TABLE IF NOT EXISTS rau_cloud_merge_artifacts (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, metadata JSONB NOT NULL,
    expires_at BIGINT NOT NULL
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS rau_cloud_merge_account ON rau_cloud_merge_artifacts(account_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS rau_cloud_merge_expiry ON rau_cloud_merge_artifacts(expires_at)');
  await pool.query(`CREATE TABLE IF NOT EXISTS rau_cloud_merge_chunks (
    artifact_id TEXT NOT NULL REFERENCES rau_cloud_merge_artifacts(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL, ciphertext BYTEA NOT NULL,
    PRIMARY KEY(artifact_id, chunk_index)
  )`);
  return {
    async transaction(accountId, task) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Account lock serializes quota reservations and operation retries across replicas.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`rau-merge:${accountId}`]);
        const repo = {
          async list() { return (await client.query('SELECT metadata FROM rau_cloud_merge_artifacts WHERE account_id = $1', [accountId])).rows.map((row) => row.metadata); },
          async get(id) { return (await client.query('SELECT metadata FROM rau_cloud_merge_artifacts WHERE account_id = $1 AND id = $2', [accountId, id])).rows[0]?.metadata; },
          async put(record) { await client.query(`INSERT INTO rau_cloud_merge_artifacts(id, account_id, metadata, expires_at) VALUES ($1,$2,$3::jsonb,$4)
            ON CONFLICT(id) DO UPDATE SET metadata = EXCLUDED.metadata WHERE rau_cloud_merge_artifacts.account_id = EXCLUDED.account_id`, [record.id, accountId, JSON.stringify(record), record.expiresAt]); },
          async chunk(id, index) { return (await client.query(`SELECT c.ciphertext FROM rau_cloud_merge_chunks c JOIN rau_cloud_merge_artifacts a ON a.id = c.artifact_id
            WHERE a.account_id = $1 AND a.id = $2 AND c.chunk_index = $3`, [accountId, id, index])).rows[0]?.ciphertext; },
          async chunkCount(id) { return Number((await client.query('SELECT COUNT(*) AS count FROM rau_cloud_merge_chunks WHERE artifact_id = $1', [id])).rows[0].count); },
          async putChunk(id, index, bytes) { await client.query('INSERT INTO rau_cloud_merge_chunks(artifact_id, chunk_index, ciphertext) VALUES ($1,$2,$3)', [id, index, bytes]); },
          async expire(at) { await client.query('DELETE FROM rau_cloud_merge_artifacts WHERE account_id = $1 AND expires_at <= $2', [accountId, at]); },
        };
        const result = await task(repo);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async cleanup(at) { await pool.query('DELETE FROM rau_cloud_merge_artifacts WHERE expires_at <= $1', [at]); },
    async close() { await pool.end(); },
  };
}

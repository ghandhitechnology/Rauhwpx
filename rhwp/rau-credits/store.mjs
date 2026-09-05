import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const MAX_STORE_BYTES = 8 * 1024 * 1024;

const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set([
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
]);

const WINDOWS_DIRECTORY_OPEN_ERRORS = new Set([
  'EACCES',
  'EISDIR',
  'EPERM',
]);

function emptyState() {
  return { users: {}, sessions: {}, accessTokens: {}, accountSessions: {} };
}

function serializeState(next) {
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
    throw Object.assign(
      new Error('Rau credits state exceeds the 8 MiB safety limit'),
      { code: 'RAU_CREDITS_STORE_TOO_LARGE' },
    );
  }
  return serialized;
}

/** Use the exact durable-store accounting before an irreversible provider call. */
export function assertStoreStateFits(next) {
  serializeState(next);
  return true;
}

export function createMemoryStore(initial = emptyState()) {
  let state = structuredClone(initial);
  let mutationTail = Promise.resolve();
  return {
    async load() {
      return structuredClone(state);
    },
    async save(next) {
      serializeState(next);
      state = structuredClone(next);
    },
    async mutate(task) {
      const run = async () => {
        const next = structuredClone(state);
        const result = await task(next);
        serializeState(next);
        state = structuredClone(next);
        return result;
      };
      const queued = mutationTail.then(run, run);
      mutationTail = queued.then(() => undefined, () => undefined);
      return queued;
    },
  };
}

/**
 * Flush a directory entry after an atomic rename. Some platforms report a
 * specific "not supported" error for directory handles. Disk and I/O errors
 * still reject the save because they can mean the rename is not durable.
 */
export async function syncDirectory(directory, {
  openImpl = fs.open,
  platform = process.platform,
} = {}) {
  let handle;
  try {
    handle = await openImpl(directory, 'r');
    await handle.sync();
  } catch (error) {
    const unsupported = UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(error?.code)
      || (platform === 'win32' && WINDOWS_DIRECTORY_OPEN_ERRORS.has(error?.code));
    if (!unsupported) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function createFileStore(filePath, {
  syncDirectoryImpl = syncDirectory,
  emptyState: createEmpty = emptyState,
} = {}) {
  let chain = Promise.resolve();

  async function readState() {
    let handle;
    try {
      handle = await fs.open(filePath, 'r');
      const info = await handle.stat();
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1
        || info.size > MAX_STORE_BYTES) {
        throw new Error('Rau credits state is empty, oversized, or not a regular file');
      }
      const bytes = Buffer.allocUnsafe(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) throw new Error('Rau credits state changed while it was being read');
        offset += bytesRead;
      }
      const extra = Buffer.allocUnsafe(1);
      if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
        throw new Error('Rau credits state changed while it was being read');
      }
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return createEmpty();
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function writeState(serialized) {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
    const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temp, filePath);
      await syncDirectoryImpl(directory);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  return {
    async load() {
      // A caller that observed a failed save may safely retry from the last
      // durable file; never race a read against a still-running rename.
      await chain.catch(() => {});
      return readState();
    },
    async save(next) {
      const serialized = serializeState(next);
      chain = chain.then(
        () => writeState(serialized),
        () => writeState(serialized),
      );
      return chain;
    },
  };
}

/** PostgreSQL locks the shared state row while each account or quota update runs. */
export async function createPostgresStore({
  connectionString,
  legacyFilePath = null,
  PoolClass = null,
} = {}) {
  if (!String(connectionString ?? '').trim()) throw new Error('connectionString is required');
  const Pool = PoolClass ?? (await import('pg')).Pool;
  const pool = new Pool({ connectionString });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rau_credits_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL DEFAULT 1,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  let imported = emptyState();
  if (legacyFilePath) {
    try { imported = JSON.parse(await fs.readFile(legacyFilePath, 'utf8')); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await pool.query(
    `INSERT INTO rau_credits_state(id, payload) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(imported)],
  );

  return {
    async load() {
      const result = await pool.query('SELECT payload FROM rau_credits_state WHERE id = 1');
      return structuredClone(result.rows[0]?.payload ?? emptyState());
    },
    async save(next) {
      serializeState(next);
      await pool.query(
        'UPDATE rau_credits_state SET payload = $1::jsonb, updated_at = NOW() WHERE id = 1',
        [JSON.stringify(next)],
      );
    },
    async mutate(task) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query('SELECT payload FROM rau_credits_state WHERE id = 1 FOR UPDATE');
        const state = structuredClone(locked.rows[0]?.payload ?? emptyState());
        const result = await task(state);
        serializeState(state);
        await client.query(
          'UPDATE rau_credits_state SET payload = $1::jsonb, updated_at = NOW() WHERE id = 1',
          [JSON.stringify(state)],
        );
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

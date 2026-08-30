import { promises as fs } from 'node:fs';
import path from 'node:path';

function emptyState() {
  return { users: {}, sessions: {}, accessTokens: {} };
}

function serializedMutator(load, save) {
  let chain = Promise.resolve();
  return (task) => {
    const running = chain.then(async () => {
      const state = await load();
      const result = await task(state);
      await save(state);
      return result;
    });
    chain = running.then(() => undefined, () => undefined);
    return running;
  };
}

export function createMemoryStore(initial = emptyState()) {
  let state = structuredClone(initial);
  const store = {
    async load() {
      return structuredClone(state);
    },
    async save(next) {
      state = structuredClone(next);
    },
  };
  store.mutate = serializedMutator(store.load, store.save);
  return store;
}

export function createFileStore(filePath) {
  let chain = Promise.resolve();
  const store = {
    async load() {
      try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return emptyState();
        throw error;
      }
    },
    async save(next) {
      chain = chain.then(async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const temp = `${filePath}.tmp-${process.pid}`;
        await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temp, filePath);
      }, async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const temp = `${filePath}.tmp-${process.pid}`;
        await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temp, filePath);
      });
      return chain;
    },
  };
  // This is process-local serialization. Production horizontal replicas must
  // use createPostgresStore instead of sharing this JSON contract.
  store.mutate = serializedMutator(store.load, store.save);
  return store;
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

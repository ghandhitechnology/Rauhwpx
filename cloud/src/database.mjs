import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(directory, '../migrations');
const migrations = [
  { version: 1, sql: readFileSync(path.join(migrationsDirectory, '001_initial.sql'), 'utf8') },
  { version: 2, sql: readFileSync(path.join(migrationsDirectory, '002_session_execution.sql'), 'utf8') },
  { version: 3, sql: readFileSync(path.join(migrationsDirectory, '003_resource_names.sql'), 'utf8') },
  { version: 4, sql: readFileSync(path.join(migrationsDirectory, '004_safe_pause.sql'), 'utf8') },
  { version: 5, sql: readFileSync(path.join(migrationsDirectory, '005_atomic_finish.sql'), 'utf8') },
  { version: 6, sql: readFileSync(path.join(migrationsDirectory, '006_refresh_rotation_receipts.sql'), 'utf8') },
  { version: 7, sql: readFileSync(path.join(migrationsDirectory, '007_atomic_takeover_boundaries.sql'), 'utf8') },
  { version: 8, sql: readFileSync(path.join(migrationsDirectory, '008_pairing_seek.sql'), 'utf8') },
];

export function transaction(database, callback) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = FULL');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA trusted_schema = OFF');
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT');
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    transaction(database, () => {
      const already = database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(migration.version);
      if (already) return;
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(migration.version, Date.now());
    });
  }
  return database;
}

export function databasePragmas(database) {
  return {
    journalMode: database.prepare('PRAGMA journal_mode').get().journal_mode,
    synchronous: database.prepare('PRAGMA synchronous').get().synchronous,
    foreignKeys: database.prepare('PRAGMA foreign_keys').get().foreign_keys,
    migrationVersion: database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version,
  };
}

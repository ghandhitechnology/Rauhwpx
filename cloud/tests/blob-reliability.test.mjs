import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BlobStore } from '../src/blob-store.mjs';
import { openDatabase } from '../src/database.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-blob-reliability-'));
  const database = openDatabase(path.join(root, 'cloud.sqlite3'));
  database.prepare(`
    INSERT INTO devices(id, name, created_at, last_seen_at) VALUES ('device-1', 'Desktop', 1, 1)
  `).run();
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, database, blobs: new BlobStore(database, { root: path.join(root, 'objects'), chunkBytes: 64 }) };
}

test('concurrent identical upload initialization shares one reservation and staging file', async (t) => {
  const { database, blobs, root } = await fixture(t);
  const bytes = Buffer.from('one durable upload');
  const input = {
    deviceId: 'device-1',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    name: 'document.hwpx',
    kind: 'document',
    sessionId: 'session-1',
  };

  const initialized = await Promise.all(Array.from({ length: 40 }, () => blobs.initUpload(input)));
  assert.equal(new Set(initialized.map((entry) => entry.uploadId)).size, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM uploads').get().count, 1);
  assert.equal((await fs.readdir(path.join(root, 'objects', 'staging'))).length, 1);
});

test('duplicate final chunks serialize and all observe the completed blob', async (t) => {
  const { database, blobs, root } = await fixture(t);
  const bytes = Buffer.alloc(64, 7);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const initialized = await blobs.initUpload({
    deviceId: 'device-1', sha256, size: bytes.length,
    name: 'result.hwpx', kind: 'result', sessionId: 'session-1',
  });

  const completed = await Promise.all(Array.from({ length: 40 }, () => blobs.appendChunk({
    uploadId: initialized.uploadId,
    deviceId: 'device-1',
    offset: 0,
    bytes,
  })));

  assert.ok(completed.every((entry) => entry.status === 'complete' && entry.blob?.id === sha256));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM blobs').get().count, 1);
  assert.equal((await fs.readdir(path.join(root, 'objects', 'staging'))).length, 0);
});

test('upload re-initialization cannot truncate a chunk being durably committed', async (t) => {
  const { blobs } = await fixture(t);
  const bytes = Buffer.alloc(64, 9);
  const input = {
    deviceId: 'device-1',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    name: 'result.hwpx',
    kind: 'result',
    sessionId: 'session-race',
  };
  const initialized = await blobs.initUpload(input);
  const originalOpen = fs.open;
  let enteredSync;
  let releaseSync;
  const syncEntered = new Promise((resolve) => { enteredSync = resolve; });
  const syncReleased = new Promise((resolve) => { releaseSync = resolve; });
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      enteredSync();
      await syncReleased;
      return originalSync();
    };
    return handle;
  };

  try {
    const appending = blobs.appendChunk({
      uploadId: initialized.uploadId,
      deviceId: 'device-1',
      offset: 0,
      bytes,
    });
    await syncEntered;
    let initSettled = false;
    const reinitializing = blobs.initUpload(input).finally(() => { initSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(initSettled, false, 'init must share the in-flight chunk lock');
    releaseSync();
    const [completed, reconciled] = await Promise.all([appending, reinitializing]);
    assert.equal(completed.status, 'complete');
    assert.equal(reconciled.status, 'complete');
    assert.equal(reconciled.blob.id, input.sha256);
  } finally {
    fs.open = originalOpen;
    releaseSync?.();
  }
});

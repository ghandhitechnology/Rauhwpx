import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DocumentSnapshotManager } from '../document-snapshot-manager.mjs';

const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

async function temporaryManager(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-document-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    manager: new DocumentSnapshotManager({
      rootDir: root,
      createId: () => 'snapshot-1',
      ...options,
    }),
  };
}

test('materializes a browser document snapshot under the isolated chat workspace', async (t) => {
  const { root, manager } = await temporaryManager(t);
  const result = await manager.materialize({
    chatId: 'chat-a',
    documentIdentity: { documentId: 'doc-a', documentName: '../보고서.final.hwp' },
    snapshot: {
      sourceFormat: 'hwp',
      byteLength: CFB.length,
      dataBase64: CFB.toString('base64'),
      revision: 7,
      digest: 'blake3:source',
      dirty: true,
    },
  });

  assert.equal(result.fileName, '보고서.final.hwp');
  assert.equal(result.documentId, 'doc-a');
  assert.equal(result.dirty, true);
  assert.equal(result.revision, 7);
  assert.match(result.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.ok(path.resolve(result.path).startsWith(path.resolve(root) + path.sep));
  assert.deepEqual(await fs.readFile(result.path), CFB);
  assert.equal((await fs.stat(result.path)).mode & 0o077, 0);
});

test('preserves HWPX format while correcting a stale display-name extension', async (t) => {
  const { manager } = await temporaryManager(t);
  const result = await manager.materialize({
    chatId: 'chat-b',
    documentIdentity: { documentId: 'doc-b', documentName: 'renamed.hwp' },
    snapshot: {
      sourceFormat: 'hwpx',
      byteLength: ZIP.length,
      dataBase64: ZIP.toString('base64'),
    },
  });
  assert.equal(result.fileName, 'renamed.hwpx');
  assert.deepEqual(await fs.readFile(result.path), ZIP);
});

test('rejects malformed, oversized, mismatched, and unscoped snapshots', async (t) => {
  const { manager } = await temporaryManager(t, { maxBytes: 16 });
  const base = {
    chatId: 'chat-a',
    documentIdentity: { documentId: 'doc-a', documentName: 'report.hwp' },
  };
  await assert.rejects(
    manager.materialize({ ...base, snapshot: { sourceFormat: 'hwp', dataBase64: '***=' } }),
    (error) => error.code === 'SNAPSHOT_INVALID',
  );
  await assert.rejects(
    manager.materialize({
      ...base,
      snapshot: { sourceFormat: 'hwp', byteLength: 99, dataBase64: CFB.toString('base64') },
    }),
    (error) => error.code === 'SNAPSHOT_SIZE_MISMATCH',
  );
  await assert.rejects(
    manager.materialize({
      ...base,
      snapshot: { sourceFormat: 'hwpx', byteLength: CFB.length, dataBase64: CFB.toString('base64') },
    }),
    (error) => error.code === 'SNAPSHOT_FORMAT_MISMATCH',
  );
  await assert.rejects(
    manager.materialize({
      chatId: 'chat-a', documentIdentity: null,
      snapshot: { sourceFormat: 'hwp', byteLength: CFB.length, dataBase64: CFB.toString('base64') },
    }),
    (error) => error.code === 'SNAPSHOT_SCOPE_MISSING',
  );
  const huge = Buffer.alloc(17, 1).toString('base64');
  await assert.rejects(
    manager.materialize({ ...base, snapshot: { sourceFormat: 'hwp', dataBase64: huge } }),
    (error) => error.code === 'SNAPSHOT_TOO_LARGE',
  );
});

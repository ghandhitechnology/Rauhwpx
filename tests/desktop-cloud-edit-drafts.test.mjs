import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CloudEditDraftStore, __test } from '../desktop/cloud-edit-drafts.mjs';

test('Cloud edit drafts survive store reconstruction and update under one edit identity', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boundary = { operationId: 'turn-4', revision: 7, writerGeneration: 2, stateVersion: 9 };
  const first = new CloudEditDraftStore({ root });
  await first.save({
    sessionId: 'cloud-session-1', editSessionId: 'edit-session-1', boundary,
    fileName: 'draft.hwpx', bytes: Buffer.from('first'),
  });
  const restarted = new CloudEditDraftStore({ root });
  assert.equal(Buffer.from((await restarted.get('cloud-session-1')).bytes).toString(), 'first');
  await restarted.save({
    sessionId: 'cloud-session-1', editSessionId: 'edit-session-1', boundary,
    fileName: 'draft.hwpx', bytes: Buffer.from('second'),
  });
  const restored = await first.get('cloud-session-1');
  assert.equal(Buffer.from(restored.bytes).toString(), 'second');
  assert.equal(restored.boundary.operationId, 'turn-4');
  assert.equal(restored.boundary.revision, 7);
  assert.equal((await readdir(path.join(root, 'blobs', __test.keyFor('cloud-session-1')))).length, 1);
});

test('Cloud edit drafts reject a competing edit identity and corrupted bytes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CloudEditDraftStore({ root });
  const input = {
    sessionId: 'cloud-session-2', editSessionId: 'edit-owner',
    boundary: { operationId: 'turn-2', revision: 3, writerGeneration: 4, stateVersion: 8 },
    fileName: 'draft.hwpx', bytes: Buffer.from('draft'),
  };
  const saved = await store.save(input);
  await assert.rejects(store.save({ ...input, editSessionId: 'edit-stale' }), /already owns/);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(root, 'blobs', __test.keyFor(input.sessionId), saved.sha256), Buffer.from('broken'));
  await assert.rejects(store.get(input.sessionId), /integrity verification/);
});

test('removing a Cloud edit draft is fenced by its edit identity', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CloudEditDraftStore({ root });
  await store.save({
    sessionId: 'cloud-session-3', editSessionId: 'edit-current',
    boundary: { operationId: 'turn-1', revision: 1, writerGeneration: 1, stateVersion: 5 },
    fileName: 'draft.hwpx', bytes: Buffer.from('draft'),
  });
  assert.equal(await store.remove('cloud-session-3', 'edit-stale'), false);
  assert.ok(await store.get('cloud-session-3'));
  assert.equal(await store.remove('cloud-session-3', 'edit-current'), true);
  assert.equal(await store.get('cloud-session-3'), null);
});

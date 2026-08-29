import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CloudHandoffStore, sha256Hex, writeVerifiedRecoveryFile } from '../desktop/cloud-handoff.mjs';

test('concurrent startup readers wait for the same durable handoff load', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-handoff-load-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'handoffs.json');

  const writer = new CloudHandoffStore({ filePath });
  const created = await writer.create({
    sessionId: 'desktop-session',
    threadId: 'thread-1',
    documentId: 'document-1',
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    provider: 'codex',
    limits: { maxTurns: 100 },
  });

  const reader = new CloudHandoffStore({ filePath });
  const loading = reader.load();
  const getting = reader.get(created.id);
  const listing = reader.list();
  const [, found, records] = await Promise.all([loading, getting, listing]);

  assert.equal(found?.id, created.id);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, created.id);
});

test('handoff persistence survives every write under win32 replace semantics', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-handoff-win32-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'handoffs.json');

  const store = new CloudHandoffStore({ filePath, platform: 'win32' });
  const created = await store.create({
    sessionId: 'desktop-session',
    documentId: 'document-1',
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    provider: 'codex',
    limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');

  const reloaded = new CloudHandoffStore({ filePath, platform: 'win32' });
  const [record] = await reloaded.list();
  assert.equal(record.state, 'committing');
});

test('verified recovery files replace existing targets under win32 semantics', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-recovery-win32-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'takeover.hwpx');
  const bytes = Buffer.from('recovered document');
  await writeVerifiedRecoveryFile({ filePath, bytes, expectedDigest: sha256Hex(bytes), platform: 'win32' });
  await writeVerifiedRecoveryFile({ filePath, bytes, expectedDigest: sha256Hex(bytes), platform: 'win32' });

  const { readFile, readdir } = await import('node:fs/promises');
  assert.equal((await readFile(filePath)).toString(), 'recovered document');
  assert.deepEqual(await readdir(directory), ['takeover.hwpx']);
});

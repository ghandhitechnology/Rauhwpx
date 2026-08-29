import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CloudHandoffStore } from '../desktop/cloud-handoff.mjs';

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

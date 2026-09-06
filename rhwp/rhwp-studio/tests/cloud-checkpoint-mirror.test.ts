import assert from 'node:assert/strict';
import test from 'node:test';

import { createCheckpointMirror } from '../src/cloud/checkpoint-mirror.ts';
import type { CloudCheckpointPayload } from '../src/cloud/types.ts';

const checkpoint: CloudCheckpointPayload = {
  sessionId: 'session-a',
  documentId: 'document-a',
  kind: 'turn',
  fileName: 'document.hwpx',
  bytes: new Uint8Array([1]),
  byteLength: 1,
  sha256: 'a'.repeat(64),
  revision: 2,
  turn: 1,
  operationId: 'operation-a',
};

test('failed checkpoint application retries autonomously and applies the boundary exactly once', async () => {
  let downloads = 0;
  let applications = 0;
  const mirror = createCheckpointMirror({
    download: async () => {
      downloads += 1;
      return checkpoint;
    },
    apply: async () => {
      applications += 1;
      if (applications === 1) throw new Error('disk unavailable');
    },
    retryBaseMs: 1,
    retryMaxMs: 2,
  });

  const first = mirror.mirror('session-a', 'operation-a');
  assert.equal(mirror.mirror('session-a', 'operation-a'), first);
  await first;
  await mirror.mirror('session-a', 'operation-a');

  assert.equal(downloads, 2);
  assert.equal(applications, 2);
});

test('a rejected operation does not poison a later boundary in the same session', async () => {
  const applications: string[] = [];
  let failedA = false;
  const mirror = createCheckpointMirror({
    download: async (_sessionId, operationId) => ({
      ...checkpoint,
      operationId: operationId ?? 'reconnect',
      revision: operationId === 'operation-b' ? 3 : 2,
    }),
    apply: async (value) => {
      if (value.operationId === 'operation-a' && !failedA) {
        failedA = true;
        throw new Error('A failed');
      }
      applications.push(value.operationId);
    },
    retryBaseMs: 20,
    retryMaxMs: 20,
  });

  const operationA = mirror.mirror('session-a', 'operation-a');
  await new Promise((resolve) => setTimeout(resolve, 1));
  const operationB = mirror.mirror('session-a', 'operation-b');
  await operationB;
  mirror.mirror('session-a', 'operation-a');
  await operationA;

  assert.deepEqual(applications, ['operation-b']);
});

test('changing pinned servers invalidates in-flight and completed mirror state', async () => {
  const firstDownload = Promise.withResolvers<CloudCheckpointPayload>();
  let downloads = 0;
  const applied: string[] = [];
  const mirror = createCheckpointMirror({
    download: async () => {
      downloads += 1;
      return downloads === 1
        ? firstDownload.promise
        : { ...checkpoint, documentId: 'document-b', revision: 1 };
    },
    apply: async (value) => { applied.push(value.documentId ?? 'archive-only'); },
    retryBaseMs: 1,
    retryMaxMs: 1,
  });

  const stale = mirror.mirror('shared-session', 'shared-operation');
  while (downloads === 0) await Promise.resolve();
  mirror.reset();
  const fresh = mirror.mirror('shared-session', 'shared-operation');
  firstDownload.resolve(checkpoint);
  await assert.rejects(stale, { name: 'AbortError' });
  await fresh;

  assert.deepEqual(applied, ['document-b']);
  assert.equal(downloads, 2);
});

test('reset and dispose cancel old-profile retries without applying stale work', async () => {
  let applications = 0;
  let downloads = 0;
  const mirror = createCheckpointMirror({
    download: async () => {
      downloads += 1;
      throw new Error('offline');
    },
    apply: async () => { applications += 1; },
    retryBaseMs: 20,
    retryMaxMs: 20,
  });
  const stale = mirror.mirror('session-a', 'operation-a');
  await new Promise((resolve) => setTimeout(resolve, 1));
  mirror.reset();
  await assert.rejects(stale, { name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(downloads, 1);
  assert.equal(applications, 0);

  const pending = mirror.mirror('session-a', 'operation-b');
  await new Promise((resolve) => setTimeout(resolve, 1));
  mirror.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(mirror.mirror('session-a', 'operation-c'), { name: 'AbortError' });
});

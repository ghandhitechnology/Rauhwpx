import assert from 'node:assert/strict';
import test from 'node:test';

import { runCloudMessageSubmission } from '../src/cloud/message-submission.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('workflow, attachment preparation, queue, and commit hold one exclusive lock', async () => {
  const workflow = deferred<{ sessionId: string; threadId: string; documentId: string; expectedVersion: number }>();
  const attachments = deferred<string[]>();
  const accepted = deferred<void>();
  const events: string[] = [];
  let locked = false;
  let blockedSwitches = 0;
  const attemptSwitch = () => {
    if (locked) blockedSwitches += 1;
  };
  const operation = runCloudMessageSubmission({
    acquire: () => {
      assert.equal(locked, false);
      locked = true;
      events.push('lock');
      return { release: () => {
        locked = false;
        events.push('release');
      } };
    },
    target: { sessionId: 'session-b', threadId: 'thread-b', documentId: 'document-b', expectedVersion: 4 },
    changeTarget: () => workflow.promise,
    prepare: () => attachments.promise,
    isCurrent: (target) => target.expectedVersion === 5,
    queue: async (target, files) => {
      events.push(`queue:${target.threadId}:${target.expectedVersion}:${files.join(',')}`);
      await accepted.promise;
    },
    commit: (target) => {
      events.push(`commit:${target.threadId}`);
      return target.threadId;
    },
    restore: (files) => events.push(`restore:${files.join(',')}`),
  });

  assert.equal(locked, true);
  attemptSwitch();
  workflow.resolve({ sessionId: 'session-b', threadId: 'thread-b', documentId: 'document-b', expectedVersion: 5 });
  await Promise.resolve();
  assert.equal(locked, true);
  attemptSwitch();
  attachments.resolve(['attachment-b']);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(locked, true);
  attemptSwitch();
  assert.deepEqual(events, ['lock', 'queue:thread-b:5:attachment-b']);
  accepted.resolve();

  assert.deepEqual(await operation, { kind: 'accepted', committed: 'thread-b' });
  assert.equal(locked, false);
  assert.equal(blockedSwitches, 3);
  assert.deepEqual(events, [
    'lock',
    'queue:thread-b:5:attachment-b',
    'commit:thread-b',
    'release',
  ]);
});

test('stale binding refuses queue and restores prepared attachments', async () => {
  const queued: string[] = [];
  const committed: string[] = [];
  const restored: string[][] = [];
  const result = await runCloudMessageSubmission({
    acquire: () => ({ release() {} }),
    target: { sessionId: 'session-b', threadId: 'thread-b', documentId: 'document-b' },
    prepare: async () => ['draft-b'],
    isCurrent: () => false,
    queue: async (target) => { queued.push(target.threadId); },
    commit: (target) => committed.push(target.threadId),
    restore: (files) => restored.push(files),
  });

  assert.deepEqual(result, { kind: 'stale' });
  assert.deepEqual(queued, []);
  assert.deepEqual(committed, []);
  assert.deepEqual(restored, [['draft-b']]);
});

test('queue rejection preserves attachments and cannot create a durable message', async () => {
  const committed: string[] = [];
  const restored: string[][] = [];
  await assert.rejects(runCloudMessageSubmission({
    acquire: () => ({ release() {} }),
    target: { sessionId: 'session-b', threadId: 'thread-b', documentId: 'document-b' },
    prepare: async () => ['draft-b'],
    isCurrent: () => true,
    queue: async () => { throw new Error('queue rejected'); },
    commit: (target) => committed.push(target.threadId),
    restore: (files) => restored.push(files),
  }), /queue rejected/);

  assert.deepEqual(committed, []);
  assert.deepEqual(restored, [['draft-b']]);
});

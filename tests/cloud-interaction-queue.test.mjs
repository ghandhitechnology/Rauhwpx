import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudInputQueue } from '../desktop/cloud-input-queue.mjs';
import { readStreamChunk } from '../desktop/cloud-stream-reader.mjs';

test('input batches coalesce text and scroll without crossing key or pointer transitions', async () => {
  const batches = [];
  const queue = new CloudInputQueue(async (_stream, events) => { batches.push(events); }, () => 32);
  const events = [
    { kind: 'key', action: 'down', key: 'Shift' },
    { kind: 'text', text: '가' }, { kind: 'text', text: '나다' },
    { kind: 'key', action: 'up', key: 'Shift' },
    { kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: 10 },
    { kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: 20 },
    { kind: 'pointer', action: 'down', x: 1, y: 2, button: 'left' },
    { kind: 'pointer', action: 'move', x: 3, y: 4 },
    { kind: 'pointer', action: 'move', x: 5, y: 6 },
    { kind: 'pointer', action: 'up', x: 5, y: 6, button: 'left' },
  ];
  await Promise.all(events.map((event) => queue.enqueue('stream', event)));
  assert.deepEqual(batches, [[events[0], { kind: 'text', text: '가나다' }, events[3],
    { ...events[4], deltaY: 30 }, events[6], events[8], events[9]]]);
  await queue.close();
});

test('ambiguous input failure rejects pending actions without replay', async () => {
  const request = Promise.withResolvers();
  const started = Promise.withResolvers();
  let calls = 0;
  const queue = new CloudInputQueue(async () => { calls++; started.resolve(); await request.promise; }, () => 32);
  const first = queue.enqueue('stream', { kind: 'text', text: 'first' });
  const firstCheck = assert.rejects(first, /lost receipt/);
  await started.promise;
  const later = queue.enqueue('stream', { kind: 'text', text: 'later' });
  const laterCheck = assert.rejects(later, /lost receipt/);
  request.reject(new Error('lost receipt'));
  await Promise.all([firstCheck, laterCheck]);
  await queue.close();
  assert.equal(calls, 1);
});

test('obsolete queued input expires before transmission', async () => {
  let now = 0;
  let calls = 0;
  const queue = new CloudInputQueue(async () => { calls++; }, () => 32, () => now);
  const pending = queue.enqueue('stream', { kind: 'text', text: 'old' });
  now = 3000;
  await assert.rejects(pending, { code: 'DISPLAY_INPUT_EXPIRED' });
  assert.equal(calls, 0);
  await queue.close();
});

test('silent streams are cancelled, while heartbeat bytes satisfy liveness', async () => {
  let cancelled = false;
  await assert.rejects(readStreamChunk({ read: () => new Promise(() => {}), cancel: async () => { cancelled = true; } }, 10), { code: 'ETIMEDOUT' });
  assert.equal(cancelled, true);
  assert.deepEqual(await readStreamChunk({ read: async () => ({ done: false, value: Buffer.from(': keepalive\n\n') }) }, 10),
    { done: false, value: Buffer.from(': keepalive\n\n') });
});

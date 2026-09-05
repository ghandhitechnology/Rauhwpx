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
    { kind: 'pointer', action: 'down', x: 1, y: 2, button: 'left', clickCount: 2 },
    { kind: 'pointer', action: 'move', x: 3, y: 4 },
    { kind: 'pointer', action: 'move', x: 5, y: 6 },
    { kind: 'pointer', action: 'up', x: 5, y: 6, button: 'left', clickCount: 2 },
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

test('an old connection failure does not discard input entered after reconnecting', async () => {
  const oldRequest = Promise.withResolvers();
  const started = Promise.withResolvers();
  const batches = [];
  const queue = new CloudInputQueue(async (stream, events) => {
    batches.push({ stream, events });
    if (stream === 'old-stream') {
      started.resolve();
      await oldRequest.promise;
    }
  }, () => 32);
  const original = queue.enqueue('old-stream', { kind: 'text', text: 'old' });
  const originalRejected = assert.rejects(original, /old connection closed/);
  await started.promise;
  queue.reset();
  const current = queue.enqueue('new-stream', { kind: 'text', text: 'new' });
  oldRequest.reject(new Error('old connection closed'));
  await Promise.all([originalRejected, current]);
  assert.deepEqual(batches, [
    { stream: 'old-stream', events: [{ kind: 'text', text: 'old' }] },
    { stream: 'new-stream', events: [{ kind: 'text', text: 'new' }] },
  ]);
  await queue.close();
});

test('silent streams are cancelled, while heartbeat bytes satisfy liveness', async () => {
  let cancelled = false;
  await assert.rejects(readStreamChunk({ read: () => new Promise(() => {}), cancel: async () => { cancelled = true; } }, 10), { code: 'ETIMEDOUT' });
  assert.equal(cancelled, true);
  assert.deepEqual(await readStreamChunk({ read: async () => ({ done: false, value: Buffer.from(': keepalive\n\n') }) }, 10),
    { done: false, value: Buffer.from(': keepalive\n\n') });
});

test('a complete click stays together at a batch boundary and uses the existing wire protocol', async () => {
  const batches = [];
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const queue = new CloudInputQueue(async (_stream, events) => {
    batches.push(events);
    if (batches.length === 1) { started.resolve(); await gate.promise; }
  }, () => 32);
  const first = queue.enqueue('stream', { kind: 'text', text: 'busy' });
  await started.promise;
  const pending = Array.from({ length: 31 }, (_, i) => queue.enqueue('stream', {
    kind: 'key', action: i % 2 ? 'up' : 'down', key: 'Shift',
  }));
  const click = { kind: 'pointer', action: 'click', x: 230, y: 140, button: 'left', clickCount: 2 };
  pending.push(queue.enqueue('stream', click));
  pending.push(queue.enqueue('stream', { kind: 'text', text: 'after click' }));
  gate.resolve();
  await Promise.all([first, ...pending]);
  assert.equal(batches[1].length, 31);
  assert.deepEqual(batches[2], [
    { ...click, action: 'down' }, { ...click, action: 'up' }, { kind: 'text', text: 'after click' },
  ]);
  await queue.close();
});

test('a click failure is reported once and is never retried', async () => {
  let calls = 0;
  const queue = new CloudInputQueue(async (_stream, events) => {
    calls++;
    assert.deepEqual(events.map(event => event.action), ['down', 'up']);
    throw new Error('receipt lost');
  }, () => 32);
  await assert.rejects(queue.enqueue('stream', { kind: 'pointer', action: 'click',
    x: 1, y: 2, button: 'left', clickCount: 1 }), /receipt lost/);
  await queue.close();
  assert.equal(calls, 1);
});

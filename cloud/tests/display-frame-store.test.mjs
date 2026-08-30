import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DisplayFrameStore,
  MAX_DISPLAY_FRAME_BYTES,
} from '../src/display-frame-store.mjs';

function jpeg(content, { width = 1280, height = 800 } = {}) {
  const comment = Buffer.from(content);
  const commentLength = Buffer.alloc(2);
  commentLength.writeUInt16BE(comment.length + 2);
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    height >> 8, height & 0xff,
    width >> 8, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xfe]),
    commentLength,
    comment,
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function publish(store, stream, workerId, sequence, content, capturedAt = `2026-08-30T00:00:0${sequence}.000Z`) {
  return store.publishFrame({
    sessionId: stream.sessionId,
    workerId,
    streamId: stream.streamId,
    sequence,
    capturedAt,
    bytes: jpeg(content),
  });
}

test('DisplayFrameStore bounds sessions, viewers, dimensions, and retained JPEG bytes', () => {
  const store = new DisplayFrameStore({ maxSessions: 1, maxViewersPerStream: 1, maxDimension: 1280 });
  assert.throws(() => store.openStream({
    sessionId: 'session-too-wide', workerId: 'worker-a', width: 1281, height: 800,
  }), { code: 'DISPLAY_DIMENSIONS_INVALID' });
  const stream = store.openStream({ sessionId: 'session-a', workerId: 'worker-a', width: 1280, height: 800 });
  assert.throws(() => store.openStream({
    sessionId: 'session-b', workerId: 'worker-b', width: 1280, height: 800,
  }), { code: 'DISPLAY_SESSION_LIMIT' });
  store.setInterest('session-a', stream.streamId, 'viewer-a', true);
  assert.throws(
    () => store.setInterest('session-a', stream.streamId, 'viewer-b', true),
    { code: 'DISPLAY_VIEWER_LIMIT' },
  );
  const oversized = Buffer.alloc(MAX_DISPLAY_FRAME_BYTES + 1, 0x61);
  oversized[0] = 0xff;
  oversized[1] = 0xd8;
  oversized[oversized.length - 2] = 0xff;
  oversized[oversized.length - 1] = 0xd9;
  assert.throws(() => store.publishFrame({
    sessionId: 'session-a', workerId: 'worker-a', streamId: stream.streamId,
    sequence: 1, capturedAt: '2026-08-30T00:00:01.000Z', bytes: oversized,
  }), { code: 'DISPLAY_FRAME_TOO_LARGE' });
  publish(store, stream, 'worker-a', 1, 'one');
  publish(store, stream, 'worker-a', 2, 'two');
  const latest = publish(store, stream, 'worker-a', 3, 'three');
  assert.equal(store.snapshot().streams[0].frames, 2);
  assert.throws(() => store.getFrame('session-a', stream.streamId, 1), { code: 'DISPLAY_FRAME_NOT_FOUND' });
  assert.equal(Object.isFrozen(latest), true);
  const downloaded = store.getFrame('session-a', stream.streamId, 3);
  downloaded.bytes.fill(0);
  assert.deepEqual(store.getFrame('session-a', stream.streamId, 3).bytes, jpeg('three'));
});

test('DisplayFrameStore rejects malformed and dimension-confused JPEG frames before retention', () => {
  const store = new DisplayFrameStore();
  const stream = store.openStream({
    sessionId: 'session-jpeg', workerId: 'worker-jpeg', width: 1280, height: 800,
  });
  const publishBytes = (bytes) => store.publishFrame({
    sessionId: stream.sessionId,
    workerId: 'worker-jpeg',
    streamId: stream.streamId,
    sequence: 1,
    capturedAt: '2026-08-30T00:00:01.000Z',
    bytes,
  });
  assert.throws(() => publishBytes(jpeg('mismatch', { width: 640, height: 480 })), {
    code: 'DISPLAY_FRAME_DIMENSIONS_MISMATCH',
  });
  assert.throws(() => publishBytes(jpeg('huge', { width: 5000, height: 800 })), {
    code: 'DISPLAY_DIMENSIONS_INVALID',
  });
  assert.throws(() => publishBytes(jpeg('zero', { width: 0, height: 800 })), {
    code: 'DISPLAY_DIMENSIONS_INVALID',
  });
  assert.throws(() => publishBytes(Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01, 0x02, 0xff, 0xd9,
  ])), { code: 'DISPLAY_FRAME_INVALID' });
  assert.throws(() => publishBytes(Buffer.from([
    0xff, 0xd8, 0xff, 0xfe, 0x00, 0x04, 0x01, 0x02, 0xff, 0xd9,
  ])), { code: 'DISPLAY_FRAME_INVALID' });
  assert.throws(() => publishBytes(Buffer.from([
    0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9,
  ])), { code: 'DISPLAY_FRAME_INVALID' });
  assert.equal(store.snapshot().streams[0].frames, 0);
});

test('replacement worker identity fences the prior stream and stale publishers', async () => {
  const store = new DisplayFrameStore();
  const first = store.openStream({ sessionId: 'session-a', workerId: 'worker-one', width: 1280, height: 800 });
  const waiter = store.waitForDemand('session-a', 'worker-one', first.streamId, 1);
  const second = store.openStream({ sessionId: 'session-a', workerId: 'worker-two', width: 1280, height: 800 });
  assert.notEqual(second.streamId, first.streamId);
  assert.deepEqual(await waiter, {
    streamId: first.streamId, version: 2, interested: false, maxFps: 0, closed: true,
  });
  assert.throws(
    () => publish(store, first, 'worker-one', 1, 'stale'),
    { code: 'DISPLAY_STREAM_NOT_FOUND' },
  );
  assert.throws(
    () => publish(store, second, 'worker-one', 1, 'wrong-owner'),
    { code: 'DISPLAY_WORKER_REPLACED' },
  );
  assert.equal(publish(store, second, 'worker-two', 1, 'fresh').sequence, 1);
});

test('frame sequence retries are idempotent while conflicts and evicted sequences fail', () => {
  const store = new DisplayFrameStore();
  const stream = store.openStream({ sessionId: 'session-a', workerId: 'worker-a', width: 1280, height: 800 });
  const first = publish(store, stream, 'worker-a', 1, 'same');
  assert.strictEqual(publish(store, stream, 'worker-a', 1, 'same'), first);
  assert.throws(() => publish(store, stream, 'worker-a', 1, 'different'), { code: 'DISPLAY_SEQUENCE_CONFLICT' });
  publish(store, stream, 'worker-a', 2, 'two');
  publish(store, stream, 'worker-a', 3, 'three');
  assert.throws(() => publish(store, stream, 'worker-a', 1, 'same'), { code: 'DISPLAY_SEQUENCE_STALE' });
});

test('viewer interest expires independently and demand stops after the grace period', async () => {
  let clock = Date.parse('2026-08-30T00:00:00.000Z');
  const store = new DisplayFrameStore({ now: () => clock, interestTtlMs: 10, interestGraceMs: 5 });
  const stream = store.openStream({ sessionId: 'session-a', workerId: 'worker-a', width: 1280, height: 800 });
  assert.deepEqual(await store.waitForDemand('session-a', 'worker-a', stream.streamId, 0), {
    streamId: stream.streamId, version: 1, interested: false, maxFps: 0, closed: false,
  });
  store.setInterest('session-a', stream.streamId, 'viewer-a', true);
  assert.equal((await store.waitForDemand('session-a', 'worker-a', stream.streamId, 1)).interested, true);
  clock += 11;
  store.capability('session-a');
  assert.equal(store.snapshot().streams[0].viewers, 0);
  clock += 6;
  const stopped = await store.waitForDemand('session-a', 'worker-a', stream.streamId, 2);
  assert.deepEqual(stopped, {
    streamId: stream.streamId, version: 3, interested: false, maxFps: 0, closed: false,
  });
});

test('metadata subscriptions replay only the latest frame and cleanup is idempotent', async () => {
  const store = new DisplayFrameStore();
  const stream = store.openStream({ sessionId: 'session-a', workerId: 'worker-a', width: 1280, height: 800 });
  publish(store, stream, 'worker-a', 1, 'one');
  publish(store, stream, 'worker-a', 2, 'two');
  const received = [];
  const unsubscribe = store.subscribe('session-a', stream.streamId, (metadata) => received.push(metadata?.sequence ?? null));
  publish(store, stream, 'worker-a', 3, 'three');
  const waiter = store.waitForDemand('session-a', 'worker-a', stream.streamId, 1);
  assert.equal(store.closeStream('session-a', 'worker-a', stream.streamId).closed, true);
  assert.equal((await waiter).closed, true);
  assert.deepEqual(received, [2, 3, null]);
  unsubscribe();
  unsubscribe();
  assert.equal(store.closeSession('session-a'), false);
  store.closeAll();
  store.closeAll();
  assert.deepEqual(store.snapshot(), { sessions: 0, streams: [] });
});

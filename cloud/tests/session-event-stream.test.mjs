import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { streamSessionEvents } from '../src/session-event-stream.mjs';

function fixture(t, count = 0) {
  const response = new EventEmitter();
  const notifications = new EventEmitter();
  const events = Array.from({ length: count }, (_, i) => ({ seq: i + 1 }));
  const delivered = [];
  const reads = [];
  let allowance = Infinity;
  let closedPresence = 0;
  let touchedPresence = 0;
  let heartbeats = 0;
  let readError;
  const errors = [];
  response.write = () => { heartbeats++; return --allowance > 0; };
  response.destroy = () => { response.destroyed = true; response.emit('close'); };
  const close = streamSessionEvents({
    response, sessionId: 'session', after: 0,
    sessionStore: {
      listEvents(_id, after, limit) {
        if (readError) throw readError;
        reads.push({ after, limit });
        return events.filter((event) => event.seq > after).slice(0, limit);
      },
      subscribe(_id, listener) {
        notifications.on('event', listener);
        return () => notifications.off('event', listener);
      },
    },
    writeEvent(event) { delivered.push(event.seq); return --allowance > 0; },
    touchPresence() { touchedPresence++; },
    closePresence() { closedPresence++; },
    onError(error) { errors.push(error); },
  });
  t.after(close);
  return {
    response, delivered, reads, notifications, errors,
    failRead(error) { readError = error; },
    append(count) {
      for (let i = 0; i < count; i++) {
        const event = { seq: events.length + 1 };
        events.push(event);
        notifications.emit('event', event);
      }
    },
    allow(count) { allowance = count; },
    get closedPresence() { return closedPresence; },
    get touchedPresence() { return touchedPresence; },
    get heartbeats() { return heartbeats; },
  };
}

test('slow receivers pause replay and live reads until drain without losing or reordering events', async (t) => {
  const f = fixture(t, 100);
  f.allow(1);
  await nextTurn();
  assert.deepEqual(f.delivered, [1]);
  assert.equal(f.reads.length, 1);
  f.append(100);
  await nextTurn();
  assert.equal(f.reads.length, 1, 'live notifications must not fetch or buffer while blocked');
  f.allow(Infinity);
  f.response.emit('drain');
  for (let i = 0; i < 10; i++) await nextTurn();
  assert.deepEqual(f.delivered, Array.from({ length: 200 }, (_, i) => i + 1));
  assert.ok(f.reads.every(({ limit }) => limit === 32));
  f.allow(1);
  f.append(2);
  await nextTurn();
  assert.equal(f.delivered.at(-1), 201);
  f.allow(Infinity);
  f.response.emit('drain');
  await nextTurn();
  assert.deepEqual(f.delivered.slice(-2), [201, 202]);
});

test('large replay yields to other work after one small page', async (t) => {
  const f = fixture(t, 1000);
  await nextTurn();
  assert.equal(f.delivered.length, 32);
  assert.equal(f.reads.length, 1);
  f.append(1);
  for (let i = 0; i < 35; i++) await nextTurn();
  assert.deepEqual(f.delivered, Array.from({ length: 1001 }, (_, i) => i + 1));
});

test('disconnect cancels blocked and scheduled replay and removes subscription and presence once', async (t) => {
  for (const blocked of [false, true]) {
    await t.test(blocked ? 'blocked' : 'scheduled', async (t) => {
      const f = fixture(t, 100);
      if (blocked) { f.allow(1); await nextTurn(); }
      const before = f.delivered.length;
      f.response.emit('close');
      f.response.emit('close');
      f.response.emit('drain');
      f.append(1);
      await nextTurn();
      assert.equal(f.delivered.length, before);
      assert.equal(f.notifications.listenerCount('event'), 0);
      assert.equal(f.response.listenerCount('drain'), 0);
      assert.equal(f.closedPresence, 1);
    });
  }
});

test('keepalives maintain presence without writing into a blocked response', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t, 1);
  f.allow(1);
  await nextTurn();
  t.mock.timers.tick(30_000);
  assert.equal(f.touchedPresence, 2);
  assert.equal(f.heartbeats, 0);
  f.allow(1);
  f.response.emit('drain');
  await nextTurn();
  t.mock.timers.tick(15_000);
  assert.equal(f.heartbeats, 1);
  f.append(1);
  await nextTurn();
  assert.deepEqual(f.delivered, [1], 'heartbeat backpressure also pauses durable delivery');
  f.response.emit('close');
  t.mock.timers.tick(30_000);
  assert.equal(f.touchedPresence, 3);
});

test('a durable log failure closes the stream and releases its resources', async (t) => {
  const f = fixture(t, 1);
  const error = new Error('Session was deleted');
  f.failRead(error);
  await nextTurn();
  assert.equal(f.response.destroyed, true);
  assert.equal(f.notifications.listenerCount('event'), 0);
  assert.equal(f.closedPresence, 1);
  assert.deepEqual(f.errors, [error]);
});

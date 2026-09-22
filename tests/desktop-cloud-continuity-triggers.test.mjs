import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { installCloudContinuityTriggers } from '../desktop/cloud-continuity-triggers.mjs';

function harness({ online = true } = {}) {
  const monitor = new EventEmitter();
  const calls = [];
  const warmCalls = [];
  const timers = new Map();
  let cleared = 0;
  const state = { online };
  const stop = installCloudContinuityTriggers({
    powerMonitor: monitor,
    isOnline: () => state.online,
    reconcile: async ({ reason }) => { calls.push(reason); },
    keepWarm: async ({ reason }) => { warmCalls.push(reason); },
    setIntervalImpl: (callback, ms) => {
      const handle = { ms };
      timers.set(ms, callback);
      return handle;
    },
    clearIntervalImpl: () => { cleared += 1; },
  });
  return { monitor, calls, warmCalls, timers, state, stop, clearedCount: () => cleared };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('startup, wake, unlock, and an offline-to-online edge reconcile through one callback', async () => {
  const setup = harness();
  await settle();
  setup.monitor.emit('resume');
  setup.monitor.emit('unlock-screen');
  setup.state.online = false;
  setup.timers.get(10_000)();
  setup.monitor.emit('resume');
  setup.state.online = true;
  setup.timers.get(10_000)();
  await settle();
  assert.deepEqual(setup.calls, ['startup', 'resume', 'unlock', 'online']);
  setup.stop();
  assert.equal(setup.clearedCount(), 3);
  setup.monitor.emit('resume');
  assert.deepEqual(setup.calls, ['startup', 'resume', 'unlock', 'online']);
});

test('a cadence timer reconciles without a wake or network edge', async () => {
  const setup = harness();
  await settle();
  setup.timers.get(60_000)();
  await settle();
  assert.deepEqual(setup.calls, ['startup', 'cadence']);
  setup.state.online = false;
  setup.timers.get(60_000)();
  await settle();
  assert.deepEqual(setup.calls, ['startup', 'cadence']);
  setup.stop();
});

test('the warm reservation is renewed on startup, wake, unlock, reconnect, and its own cadence', async () => {
  const setup = harness();
  await settle();
  setup.monitor.emit('resume');
  setup.monitor.emit('unlock-screen');
  setup.state.online = false;
  setup.timers.get(10_000)();
  setup.state.online = true;
  setup.timers.get(10_000)();
  setup.timers.get(20 * 60_000)();
  await settle();
  assert.deepEqual(setup.warmCalls, ['startup', 'resume', 'unlock', 'online', 'keep-warm']);
  setup.stop();
  setup.timers.get(20 * 60_000)();
  await settle();
  assert.deepEqual(setup.warmCalls, ['startup', 'resume', 'unlock', 'online', 'keep-warm']);
});

test('a reconcile or warm failure never rejects into the caller', async () => {
  const monitor = new EventEmitter();
  const rejected = [];
  process.on('unhandledRejection', (error) => rejected.push(error));
  const stop = installCloudContinuityTriggers({
    powerMonitor: monitor,
    isOnline: () => true,
    reconcile: async () => { throw new Error('reconcile failed'); },
    keepWarm: async () => { throw new Error('prewarm failed'); },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  await settle();
  assert.deepEqual(rejected, []);
  stop();
});

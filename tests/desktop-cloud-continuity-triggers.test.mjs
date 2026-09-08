import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { installCloudContinuityTriggers } from '../desktop/cloud-continuity-triggers.mjs';

test('startup, wake, unlock, and an offline-to-online edge reconcile through one callback', async () => {
  const monitor = new EventEmitter();
  const calls = [];
  let online = true;
  let poll = null;
  let cleared = false;
  const stop = installCloudContinuityTriggers({
    powerMonitor: monitor,
    isOnline: () => online,
    reconcile: async ({ reason }) => { calls.push(reason); },
    setIntervalImpl: (callback) => {
      poll = callback;
      return { unref() {} };
    },
    clearIntervalImpl: () => { cleared = true; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  monitor.emit('resume');
  monitor.emit('unlock-screen');
  online = false;
  poll();
  monitor.emit('resume');
  online = true;
  poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['startup', 'resume', 'unlock', 'online']);
  stop();
  assert.equal(cleared, true);
  monitor.emit('resume');
  assert.deepEqual(calls, ['startup', 'resume', 'unlock', 'online']);
});

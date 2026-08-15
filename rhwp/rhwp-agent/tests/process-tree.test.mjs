import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  isolatedProcessEnv,
  processTreeSpawnOptions,
  terminateProcessTree,
  waitForProcessTreeExit,
} from '../process-tree.mjs';

function timerHarness() {
  let callback = null;
  const timer = { unref() {} };
  return {
    setTimer(next, delay) {
      callback = next;
      timer.delay = delay;
      return timer;
    },
    fire() { callback?.(); },
    timer,
  };
}

test('owned spawn options create POSIX groups without detaching Windows children', () => {
  assert.deepEqual(processTreeSpawnOptions('linux'), { detached: true, windowsHide: true });
  assert.deepEqual(processTreeSpawnOptions('darwin'), { detached: true, windowsHide: true });
  assert.deepEqual(processTreeSpawnOptions('win32'), { detached: false, windowsHide: true });
});

test('POSIX termination targets the child process group with TERM then KILL', () => {
  const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null, signalCode: null });
  const signals = [];
  const timers = timerHarness();

  const timer = terminateProcessTree(child, {
    platform: 'linux',
    graceMs: 250,
    killProcess(pid, signal) { signals.push([pid, signal]); },
    setTimer: timers.setTimer,
  });

  assert.equal(timer, timers.timer);
  assert.equal(timers.timer.delay, 250);
  assert.deepEqual(signals, [[-4321, 'SIGTERM']]);
  timers.fire();
  assert.deepEqual(signals, [[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
});

test('process exit clears escalation before a reused POSIX pid can be killed', () => {
  const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null, signalCode: null });
  const signals = [];
  const timers = timerHarness();
  let cleared = null;

  terminateProcessTree(child, {
    platform: 'linux',
    killProcess(pid, signal) { signals.push([pid, signal]); },
    setTimer: timers.setTimer,
    clearTimer(timer) { cleared = timer; },
  });
  child.exitCode = 0;
  child.emit('exit', 0, null);
  timers.fire();

  assert.equal(cleared, timers.timer);
  assert.deepEqual(signals, [[-4321, 'SIGTERM']]);
});

test('process-tree exit wait settles from the owned child event', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 777, exitCode: null, signalCode: null });
  const exited = waitForProcessTreeExit(child, { timeoutMs: 100 });
  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.equal(await exited, true);
});

test('Windows termination invokes taskkill with argv only and force-escalates the tree', () => {
  const child = Object.assign(new EventEmitter(), { pid: 9876, exitCode: null, signalCode: null });
  const calls = [];
  const timers = timerHarness();
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return new EventEmitter();
  };

  terminateProcessTree(child, {
    platform: 'win32',
    spawnProcess,
    setTimer: timers.setTimer,
  });
  timers.fire();

  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['taskkill', ['/PID', '9876', '/T']],
    ['taskkill', ['/PID', '9876', '/T', '/F']],
  ]);
  assert.ok(calls.every(({ options }) => (
    options.shell === false
    && options.windowsHide === true
    && options.detached === false
    && options.stdio === 'ignore'
  )));
});

test('isolated process environments set both home conventions and the RHWP session', () => {
  assert.deepEqual(
    isolatedProcessEnv(
      { isolatedHome: 'C:\\Users\\Rau\\isolated home', sessionId: 'thread-42' },
      { PATH: 'C:\\bin', HOME: 'old-home', USERPROFILE: 'old-profile' },
    ),
    {
      PATH: 'C:\\bin',
      HOME: 'C:\\Users\\Rau\\isolated home',
      USERPROFILE: 'C:\\Users\\Rau\\isolated home',
      RHWP_SESSION_ID: 'thread-42',
    },
  );
});

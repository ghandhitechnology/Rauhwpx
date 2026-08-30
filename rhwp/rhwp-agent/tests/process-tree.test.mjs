import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  isolatedProcessEnv,
  processTreeSpawnOptions,
  terminateAndWaitForProcessTreeExit,
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

  const termination = terminateProcessTree(child, {
    platform: 'linux',
    graceMs: 250,
    killProcess(pid, signal) { signals.push([pid, signal]); },
    setTimer: timers.setTimer,
    processGroupAlive: () => true,
  });

  assert.equal(typeof termination.then, 'function');
  assert.equal(timers.timer.delay, 250);
  assert.deepEqual(signals, [[-4321, 'SIGTERM']]);
  timers.fire();
  assert.deepEqual(signals, [[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
});

test('POSIX leader exit does not cancel descendant group escalation', () => {
  const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null, signalCode: null });
  const signals = [];
  const timers = timerHarness();

  terminateProcessTree(child, {
    platform: 'linux',
    killProcess(pid, signal) { signals.push([pid, signal]); },
    setTimer: timers.setTimer,
    processGroupAlive: () => true,
  });
  child.exitCode = 0;
  child.emit('exit', 0, null);
  timers.fire();

  assert.deepEqual(signals, [[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
});

test('process-tree exit wait holds a leader-only exit through descendant escalation', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 777, exitCode: null, signalCode: null });
  const signals = [];
  const timers = timerHarness();
  let groupProbe = 0;
  const exited = waitForProcessTreeExit(child, { timeoutMs: 100 });
  terminateProcessTree(child, {
    platform: 'linux',
    killProcess(pid, signal) { signals.push([pid, signal]); },
    setTimer: timers.setTimer,
    processGroupAlive: () => groupProbe++ < 2,
  });
  child.exitCode = 0;
  child.emit('exit', 0, null);

  let result = null;
  void exited.then((value) => { result = value; });
  await Promise.resolve();
  assert.equal(result, null, 'leader exit alone must not release cleanup');
  timers.fire();
  await Promise.resolve();
  assert.equal(result, null, 'KILL dispatch still gets a bounded final observation grace');
  timers.fire();
  assert.equal(await exited, true);
  assert.deepEqual(signals, [[-777, 'SIGTERM'], [-777, 'SIGKILL']]);
});

test('already-exited POSIX leader still cleans a live descendant group', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 778, exitCode: 0, signalCode: null });
  const signals = [];
  const timers = timerHarness();
  const probes = [true, true, false];
  const exited = waitForProcessTreeExit(child, {
    timeoutMs: 100,
    terminateProcess(proc) {
      return terminateProcessTree(proc, {
        platform: 'linux',
        killProcess(pid, signal) { signals.push([pid, signal]); },
        setTimer: timers.setTimer,
        processGroupAlive: () => probes.shift() ?? false,
      });
    },
  });

  let result = null;
  void exited.then((value) => { result = value; });
  await Promise.resolve();
  assert.equal(result, null);
  assert.deepEqual(signals, [[-778, 'SIGTERM']]);
  timers.fire();
  assert.deepEqual(signals, [[-778, 'SIGTERM'], [-778, 'SIGKILL']]);
  timers.fire();
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

test('Windows leader exit does not cancel forced descendant cleanup', () => {
  const child = Object.assign(new EventEmitter(), { pid: 9877, exitCode: null, signalCode: null });
  const calls = [];
  const timers = timerHarness();

  terminateProcessTree(child, {
    platform: 'win32',
    spawnProcess(command, args) {
      calls.push([command, args]);
      return new EventEmitter();
    },
    setTimer: timers.setTimer,
  });
  child.exitCode = 0;
  child.emit('exit', 0, null);
  timers.fire();

  assert.deepEqual(calls, [
    ['taskkill', ['/PID', '9877', '/T']],
    ['taskkill', ['/PID', '9877', '/T', '/F']],
  ]);
});

test('already-exited Windows leader fails closed without targeting a reusable pid', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 9878, exitCode: 0, signalCode: null });
  const calls = [];
  const timers = timerHarness();
  const exited = waitForProcessTreeExit(child, {
    timeoutMs: 100,
    terminateProcess(proc) {
      return terminateProcessTree(proc, {
        platform: 'win32',
        setTimer: timers.setTimer,
        spawnProcess(command, args) {
          calls.push([command, args]);
          return new EventEmitter();
        },
      });
    },
  });

  assert.equal(await exited, false);
  assert.deepEqual(calls, [], 'an expired Windows pid must never be passed to taskkill');
});

test('Windows taskkill success is not cleanup proof while the owned leader survives', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 9879, exitCode: null, signalCode: null });
  const commands = [];
  const timers = timerHarness();
  const termination = terminateProcessTree(child, {
    platform: 'win32',
    setTimer: timers.setTimer,
    spawnProcess() {
      const taskkill = new EventEmitter();
      commands.push(taskkill);
      return taskkill;
    },
  });

  commands[0].emit('exit', 0, null);
  let result = null;
  void termination.then((value) => { result = value; });
  await Promise.resolve();
  assert.equal(result, null);
  timers.fire();
  commands[1].emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(result, null, 'taskkill exit zero does not replace the leader-exit proof');
  timers.fire();
  assert.equal(await termination, false);
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

test('combined termination waits for an injected cleanup proof after leader exit', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 9001, exitCode: null, signalCode: null });
  let release;
  const cleanup = new Promise((resolve) => { release = resolve; });
  const stopped = terminateAndWaitForProcessTreeExit(child, {
    terminateProcess(proc) {
      proc.signalCode = 'SIGTERM';
      proc.emit('exit', null, 'SIGTERM');
      return cleanup;
    },
  });
  let settled = false;
  void stopped.finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release(true);
  assert.equal(await stopped, true);
});

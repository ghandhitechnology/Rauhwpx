import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  isolatedProcessEnv,
  PROCESS_TREE_CLEANUP_OUTCOME,
  processTreeCleanupOutcome,
  processTreeSpawnOptions,
  terminateAndWaitForProcessTreeExit,
  terminateAndWaitForProcessTreeExitOutcome,
  terminateProcessTree,
  waitForProcessTreeExit,
} from '../process-tree.mjs';

const WINDOWS_ENV = Object.freeze({ SystemRoot: 'C:\\Windows' });
const WINDOWS_TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';

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

test('Windows termination invokes one trusted taskkill command with argv only', () => {
  const child = Object.assign(new EventEmitter(), { pid: 9876, exitCode: null, signalCode: null });
  const calls = [];
  const timers = timerHarness();
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return new EventEmitter();
  };

  terminateProcessTree(child, {
    platform: 'win32',
    env: WINDOWS_ENV,
    spawnProcess,
    setTimer: timers.setTimer,
  });
  timers.fire();

  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    [WINDOWS_TASKKILL, ['/PID', '9876', '/T', '/F']],
  ]);
  assert.ok(calls.every(({ options }) => (
    options.shell === false
    && options.windowsHide === true
    && options.detached === false
    && options.stdio === 'ignore'
  )));
});

test('Windows leader exit after taskkill starts blocks PID-based escalation', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 9877, exitCode: null, signalCode: null });
  const calls = [];
  const taskkills = [];
  const timers = timerHarness();

  const cleanup = terminateProcessTree(child, {
    platform: 'win32',
    env: WINDOWS_ENV,
    spawnProcess(command, args) {
      calls.push([command, args]);
      const taskkill = new EventEmitter();
      taskkills.push(taskkill);
      return taskkill;
    },
    setTimer: timers.setTimer,
  });
  child.exitCode = 0;
  child.emit('exit', 0, null);
  taskkills[0].emit('close', 1, null);
  timers.fire();

  assert.deepEqual(calls, [
    [WINDOWS_TASKKILL, ['/PID', '9877', '/T', '/F']],
  ]);
  assert.equal(await cleanup, null);
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

  assert.equal(await exited, null);
  assert.deepEqual(calls, [], 'an expired Windows pid must never be passed to taskkill');
});

test('an exited leader without a tree identity reports unavailable proof', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null });
  assert.equal(await waitForProcessTreeExit(child), null);
  assert.equal(terminateProcessTree(child), null);
});

test('cleanup outcomes keep unavailable proof distinct and fail closed in the boolean wrapper', async () => {
  assert.equal(
    processTreeCleanupOutcome(true, true),
    PROCESS_TREE_CLEANUP_OUTCOME.PROVEN,
  );
  assert.equal(
    processTreeCleanupOutcome(false, true),
    PROCESS_TREE_CLEANUP_OUTCOME.FAILED,
  );
  assert.equal(
    processTreeCleanupOutcome(true, undefined),
    PROCESS_TREE_CLEANUP_OUTCOME.FAILED,
  );
  assert.equal(
    processTreeCleanupOutcome(null, true),
    PROCESS_TREE_CLEANUP_OUTCOME.UNAVAILABLE,
  );

  const child = Object.assign(new EventEmitter(), { pid: 9880, exitCode: 0, signalCode: null });
  const calls = [];
  const options = {
    terminateOptions: {
      platform: 'win32',
      spawnProcess(command, args) { calls.push([command, args]); },
    },
  };
  assert.equal(
    await terminateAndWaitForProcessTreeExitOutcome(child, options),
    PROCESS_TREE_CLEANUP_OUTCOME.UNAVAILABLE,
  );
  assert.equal(await terminateAndWaitForProcessTreeExit(child, options), false);
  assert.deepEqual(calls, [], 'an unavailable proof must not target the expired pid');
});

test('Windows taskkill success never retargets a delayed leader PID', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 9879, exitCode: null, signalCode: null });
  const commands = [];
  const timers = timerHarness();
  const termination = terminateProcessTree(child, {
    platform: 'win32',
    env: WINDOWS_ENV,
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
  await Promise.resolve();
  assert.equal(commands.length, 1, 'a delayed exit must not trigger a second PID command');
  assert.equal(result, null, 'taskkill exit zero does not replace the leader-exit proof');
  timers.fire();
  assert.equal(await termination, false);
});

test('Windows cleanup fails closed when the trusted system taskkill path is unavailable', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 9881, exitCode: null, signalCode: null });
  const calls = [];
  const timers = timerHarness();
  const termination = terminateProcessTree(child, {
    platform: 'win32',
    env: { SystemRoot: 'relative-root' },
    setTimer: timers.setTimer,
    spawnProcess(command, args) { calls.push([command, args]); },
  });
  timers.fire();
  timers.fire();

  assert.equal(await termination, false);
  assert.deepEqual(calls, []);
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

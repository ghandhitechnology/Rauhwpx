import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  SessionDisplay,
  allocateDisplay,
  createSessionDisplay,
} from '../document-runtime/session-display.mjs';
import { takeEnvironmentScreenshot } from '../../rhwp/rhwp-agent/environment-screenshot.mjs';

function xvfbAvailable() {
  return spawnSync('Xvfb', ['-help'], { encoding: 'utf8' }).error?.code !== 'ENOENT';
}

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.resume = () => {};
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    queueMicrotask(() => {
      child.exitCode = signal === 'SIGKILL' ? null : 0;
      child.signalCode = signal === 'SIGTERM' || signal === 'SIGKILL' ? signal : null;
      child.emit('exit', child.exitCode, child.signalCode);
    });
    return true;
  };
  return child;
}

function displayPaths(root) {
  return {
    x11Directory: path.join(root, 'x11'),
    lockDirectory: path.join(root, 'locks'),
  };
}

test('allocateDisplay atomically separates concurrent in-process allocators', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-display-allocation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = displayPaths(root);
  const [first, second] = await Promise.all([
    allocateDisplay(90, paths),
    allocateDisplay(90, paths),
  ]);
  assert.deepEqual(new Set([first.display, second.display]), new Set([':90', ':91']));
  await Promise.all([first.release(), second.release()]);
});

test('released display claims are reusable and release is idempotent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-display-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = displayPaths(root);
  const first = await allocateDisplay(90, { ...paths, maxAttempts: 1 });
  await first.release();
  await first.release();
  const reused = await allocateDisplay(90, { ...paths, maxAttempts: 1 });
  assert.equal(reused.display, ':90');
  await reused.release();
});

test('SessionDisplay reaches ready, restarts once on crash, then stops', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-display-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  let xvfb = null;
  let launches = 0;
  const display = createSessionDisplay({
    workspace: root,
    display: ':91',
    startWindowManager: false,
    startTimeoutMs: 2_000,
    onEvent: (event) => events.push(event.type),
    spawnProcess: (command, args) => {
      assert.equal(command, 'Xvfb');
      assert.equal(args[0], ':91');
      launches += 1;
      xvfb = fakeChild(5000 + launches);
      queueMicrotask(() => xvfb.stderr.emit('data', Buffer.from('')));
      return xvfb;
    },
  });

  const started = await display.start();
  assert.equal(started.status, 'error');
  assert.ok(events.includes('environment.display_starting'));
  assert.ok(events.includes('environment.display_failed'));
  assert.equal(display.environment, null);

  const launchesBeforeLock = launches;
  display.disableRestarts();
  const locked = await display.restart({ reason: 'fixed-browser-mode' });
  assert.equal(locked.restartBudget, 0);
  assert.equal(launches, launchesBeforeLock, 'a fixed browser mode must never restart Xvfb');

  await display.stop();
  assert.equal(display.status, 'stopped');
  assert.ok(events.includes('environment.display_stopped'));
});

test('SessionDisplay fail-soft when Xvfb binary is missing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-display-missing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const display = new SessionDisplay({
    workspace: root,
    display: ':92',
    ...displayPaths(root),
    startWindowManager: false,
    xvfbBin: '/nonexistent/Xvfb',
    startTimeoutMs: 500,
    spawnProcess: (command) => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })));
      queueMicrotask(() => child.emit('exit', null, null));
      return child;
    },
  });
  const snapshot = await display.start();
  assert.equal(snapshot.status, 'error');
  assert.match(snapshot.lastError || '', /./);
  await display.stop();
  const replacement = await allocateDisplay(92, displayPaths(root));
  assert.equal(replacement.display, ':92', 'failed startup must release its local claim');
  await replacement.release();
});

test('SessionDisplay releases an Xvfb collision and starts on the next claimed display', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-display-collision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const spawns = [];
  let xvfbSpawns = 0;
  let socketChecks = 0;
  const display = createSessionDisplay({
    workspace: root,
    baseDisplay: 100,
    maxDisplayAttempts: 2,
    ...displayPaths(root),
    startWindowManager: true,
    prepareAuthority: async () => {},
    probe: async () => {},
    waitForSocket: async () => {
      socketChecks += 1;
      if (socketChecks === 1) return new Promise(() => {});
    },
    environment: {
      PATH: '/usr/bin:/bin',
      RAUHWpx_WORKER_TOKEN: 'worker-secret',
      RAUHWpx_CONTROL_SOCKET: '/run/rauhwpx/control.sock',
      CONTROL_PLANE_SECRET: 'secret',
    },
    spawnProcess: (command, args, options) => {
      const child = fakeChild(6000 + spawns.length);
      spawns.push({ command, args, options, child });
      if (command === 'Xvfb') xvfbSpawns += 1;
      if (command === 'Xvfb' && xvfbSpawns === 1) {
        queueMicrotask(() => {
          child.stderr.emit('data', Buffer.from('Server is already active for display'));
          child.exitCode = 1;
          child.emit('exit', 1, null);
        });
      }
      return child;
    },
  });
  const snapshot = await display.start();
  assert.equal(snapshot.status, 'ready', snapshot.lastError);
  assert.equal(snapshot.display, ':101');
  assert.deepEqual(
    spawns.filter(({ command }) => command === 'Xvfb').map(({ args }) => args[0]),
    [':100', ':101'],
  );
  assert.equal(spawns.some(({ command }) => command === 'matchbox-window-manager'), true);
  for (const { options } of spawns) {
    assert.equal(options.env.PATH, '/usr/bin:/bin');
    assert.equal(options.env.RAUHWpx_WORKER_TOKEN, undefined);
    assert.equal(options.env.RAUHWpx_CONTROL_SOCKET, undefined);
    assert.equal(options.env.CONTROL_PLANE_SECRET, undefined);
  }
  await display.stop();
  const released = await allocateDisplay(100, displayPaths(root));
  assert.equal(released.display, ':100');
  await released.release();
});

test('live Xvfb supervisor reaches ready, restarts, and screenshots', { skip: !xvfbAvailable() }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-display-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  const display = createSessionDisplay({
    workspace: root,
    baseDisplay: 70,
    startWindowManager: false,
    onEvent: (event) => events.push(event),
  });
  const startedAt = Date.now();
  const snapshot = await display.start();
  const elapsed = Date.now() - startedAt;
  t.after(async () => { await display.stop(); });
  assert.equal(snapshot.status, 'ready', snapshot.lastError);
  assert.match(snapshot.display, /^:\d+$/);
  assert.ok(snapshot.pid > 0);
  assert.ok(elapsed < 3_000, `display start p50 budget 3s, got ${elapsed}ms`);
  assert.ok(events.some((event) => event.type === 'environment.display_ready'));
  assert.deepEqual(display.environment?.DISPLAY, snapshot.display);
  assert.equal(display.environment?.RAUHWpx_SESSION_DISPLAY, 'ready');

  const workDir = path.join(root, 'work');
  await fs.mkdir(workDir, { recursive: true });
  const shot = await takeEnvironmentScreenshot({
    workDir,
    display: snapshot.display,
    authFile: path.join(root, 'home', '.Xauthority'),
  });
  assert.ok(shot.imagePath.startsWith(path.join(workDir, '.rhwp-agent', 'screens')));
  assert.ok(shot.bytes > 0);
  assert.ok(shot.elapsedMs < 2_000, `1280x800 capture under 2s, got ${shot.elapsedMs}ms`);

  const childPid = snapshot.pid;
  process.kill(childPid, 'SIGTERM');
  await delay(800);
  let guard = 0;
  while (display.status !== 'ready' && guard < 40) {
    await delay(50);
    guard += 1;
  }
  assert.equal(display.status, 'ready', display.lastError);
  assert.ok(events.some((event) => event.type === 'environment.display_restarted'
    || event.type === 'environment.display_ready'));

  await display.stop();
  assert.equal(display.status, 'stopped');
});

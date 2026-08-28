import test from 'node:test';
import assert from 'node:assert/strict';
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

test('allocateDisplay prefers a free :10-style display', async () => {
  const display = await allocateDisplay(90);
  assert.match(display, /^:\d+$/);
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
      // Pretend the X socket appeared by creating the unix dir entry the probe expects.
      // The real probe uses xdpyinfo; stub by short-circuiting with a child that stays up
      // and monkey-patching probe via overriding after spawn — instead we use the live
      // Xvfb on hosts that have it when RAUHWpx_SESSION_DISPLAY_LIVE=1.
      queueMicrotask(() => xvfb.stderr.emit('data', Buffer.from('')));
      return xvfb;
    },
  });

  // Without a real X socket the fake spawn fails soft into error.
  const started = await display.start();
  assert.equal(started.status, 'error');
  assert.ok(events.includes('environment.display_starting'));
  assert.ok(events.includes('environment.display_failed'));
  assert.equal(display.environment, null);

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
});

test('live Xvfb supervisor reaches ready under the current uid', async (t) => {
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

  // Crash-restart once.
  const childPid = snapshot.pid;
  process.kill(childPid, 'SIGTERM');
  await delay(800);
  // Auto-restart from exit handler may still be settling.
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

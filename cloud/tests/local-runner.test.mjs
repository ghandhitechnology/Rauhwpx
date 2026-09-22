import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { __test, LocalRunner } from '../src/local-runner.mjs';

const WORKER_UID = process.getuid?.() ?? 1001;
const WORKER_GID = process.getgid?.() ?? WORKER_UID;
const CONTROL_UID = WORKER_UID === 0 ? 1 : 0;
const CONTROL_PID = 1_900_000_000;
const CHILD_PID = 2_000_000_000;

test('the worker uid inventory ignores zombies and retains live processes', () => {
  const live = 'State:\tS (sleeping)\nUid:\t1001\t1001\t1001\t1001\n';
  const zombie = 'State:\tZ (zombie)\nUid:\t1001\t1001\t1001\t1001\n';
  assert.equal(__test.activeLinuxProcessOwnedByUid(live, 1001), true);
  assert.equal(__test.activeLinuxProcessOwnedByUid(live, 1002), false);
  assert.equal(__test.activeLinuxProcessOwnedByUid(zombie, 1001), false);
});

function processModel() {
  const processes = new Map();
  const signals = [];
  return {
    processes,
    signals,
    listUidProcesses: async (uid) => [...processes]
      .filter(([, owner]) => owner === uid)
      .map(([pid]) => pid),
    signalProcess(pid, signal) {
      signals.push({ pid, signal });
      processes.delete(pid);
    },
  };
}

async function fixture(t, model, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-local-runner-uid-'));
  const config = {
    workspaceRoot: path.join(root, 'workspaces'),
    providerAuthDirectory: path.join(root, 'provider-auth'),
    workerUid: WORKER_UID,
    workerGid: WORKER_GID,
  };
  const events = [];
  const children = [];
  const runner = new LocalRunner(config, {
    controlPlaneUid: CONTROL_UID,
    controlPlanePid: CONTROL_PID,
    listUidProcesses: model.listUidProcesses,
    signalProcess: (pid, signal) => model.signalProcess(pid, signal),
    wait: async () => {},
    uidPollMs: 0,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.pid = CHILD_PID + children.length;
      child.stderr = { unref() {} };
      child.unref = () => {};
      child.kill = (signal) => {
        events.push({ type: 'group', pid: child.pid, signal, workspaceExists: existsSync(child.workspace) });
        model.processes.delete(child.pid);
        child.emit('exit', 0, signal);
      };
      model.processes.set(child.pid, WORKER_UID);
      children.push(child);
      events.push({ type: 'spawn', pid: child.pid });
      return child;
    },
    ...overrides,
  });
  t.after(async () => {
    model.processes.clear();
    await runner.stopAll().catch(() => {});
    for (const entry of runner.children.values()) {
      await fs.rm(entry.temporaryDirectory, { recursive: true, force: true });
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const start = async (sessionId = 'session-one') => {
    const sandboxId = await runner.start({ id: sessionId, provider: 'codex' }, {
      workerToken: `token-${sessionId}`,
      controlSocket: '/run/rauhwpx/control.sock',
    });
    const entry = runner.children.get(sandboxId);
    entry.child.workspace = entry.workspace;
    return { sandboxId, entry };
  };
  return { config, events, runner, start };
}

test('local runner cleans the original group and detached same-uid processes before removing the workspace', async (t) => {
  const model = processModel();
  const detachedPid = 2_100_000_000;
  const { runner, start, events } = await fixture(t, model, {
    signalProcess(pid, signal) {
      const entry = [...runner.children.values()][0];
      events.push({ type: 'uid', pid, signal, workspaceExists: existsSync(entry.workspace) });
      model.signalProcess(pid, signal);
    },
  });
  const { sandboxId, entry } = await start();
  model.processes.set(detachedPid, WORKER_UID);

  await runner.stop(sandboxId);

  assert.deepEqual(events.filter((event) => event.type !== 'spawn'), [
    { type: 'group', pid: entry.child.pid, signal: 'SIGTERM', workspaceExists: true },
    { type: 'uid', pid: detachedPid, signal: 'SIGTERM', workspaceExists: true },
  ]);
  assert.equal(existsSync(entry.workspace), false);
});

test('local runner inventories again and kills a same-uid process forked during termination', async (t) => {
  const model = processModel();
  const detachedPid = 2_100_000_001;
  const forkedPid = 2_100_000_002;
  const { runner, start } = await fixture(t, model, {
    signalProcess(pid, signal) {
      model.signals.push({ pid, signal });
      model.processes.delete(pid);
      if (pid === detachedPid) model.processes.set(forkedPid, WORKER_UID);
    },
  });
  const { sandboxId } = await start();
  model.processes.set(detachedPid, WORKER_UID);

  await runner.stop(sandboxId);

  assert.deepEqual(model.signals, [
    { pid: detachedPid, signal: 'SIGTERM' },
    { pid: forkedPid, signal: 'SIGTERM' },
  ]);
});

test('local runner removes stale same-uid processes before spawning the next session', async (t) => {
  const model = processModel();
  const stalePid = 2_100_000_003;
  model.processes.set(stalePid, WORKER_UID);
  const order = [];
  const { runner, start } = await fixture(t, model, {
    signalProcess(pid, signal) {
      order.push(`signal:${pid}:${signal}`);
      model.signalProcess(pid, signal);
    },
    spawnProcess: () => {
      order.push('spawn');
      const child = new EventEmitter();
      child.pid = CHILD_PID;
      child.stderr = { unref() {} };
      child.unref = () => {};
      child.kill = (signal) => {
        model.processes.delete(child.pid);
        child.emit('exit', 0, signal);
      };
      model.processes.set(child.pid, WORKER_UID);
      return child;
    },
  });

  const { sandboxId } = await start('session-after-crash');

  assert.deepEqual(order.slice(0, 2), [`signal:${stalePid}:SIGTERM`, 'spawn']);
  await runner.stop(sandboxId);
});

test('local runner leaves other uids and the control-plane pid untouched', async (t) => {
  const model = processModel();
  const stalePid = 2_100_000_004;
  const otherUidPid = 2_100_000_005;
  model.processes.set(stalePid, WORKER_UID);
  model.processes.set(otherUidPid, WORKER_UID + 1);
  model.processes.set(CONTROL_PID, WORKER_UID);
  const { runner, start } = await fixture(t, model);

  const { sandboxId } = await start();

  assert.deepEqual(model.signals, [{ pid: stalePid, signal: 'SIGTERM' }]);
  assert.equal(model.processes.has(otherUidPid), true);
  assert.equal(model.processes.has(CONTROL_PID), true);
  await runner.stop(sandboxId);
  assert.equal(model.processes.has(otherUidPid), true);
  assert.equal(model.processes.has(CONTROL_PID), true);

  const developmentRunner = new LocalRunner({ workerUid: WORKER_UID }, {
    controlPlaneUid: WORKER_UID,
    listUidProcesses: model.listUidProcesses,
  });
  assert.equal(developmentRunner.hardIsolationAvailable, false);
});

test('local runner fails closed and retains recovery evidence when the worker uid cannot be emptied', async (t) => {
  const model = processModel();
  const survivorPid = 2_100_000_006;
  const { runner, start } = await fixture(t, model, {
    uidStopGraceMs: 0,
    uidKillWaitMs: 0,
    signalProcess(pid, signal) {
      model.signals.push({ pid, signal });
    },
  });
  const { sandboxId, entry } = await start();
  model.processes.set(survivorPid, WORKER_UID);

  await assert.rejects(runner.stop(sandboxId), {
    code: 'LOCAL_WORKER_CLEANUP_FAILED',
    details: { workerUid: WORKER_UID, remainingPids: [survivorPid] },
  });
  assert.equal(existsSync(entry.workspace), true);
  assert.deepEqual(await runner.list(), []);
  assert.deepEqual(await runner.list({ all: true }), [{
    sandboxId,
    sessionId: 'session-one',
    running: false,
  }]);
  await assert.rejects(runner.stopAll(), { code: 'LOCAL_WORKER_CLEANUP_FAILED' });
  assert.deepEqual(model.signals, [
    { pid: survivorPid, signal: 'SIGTERM' },
    { pid: survivorPid, signal: 'SIGKILL' },
    { pid: survivorPid, signal: 'SIGTERM' },
    { pid: survivorPid, signal: 'SIGKILL' },
  ]);

  model.processes.delete(survivorPid);
  await runner.stop(sandboxId);
  assert.equal(existsSync(entry.workspace), false);
  assert.deepEqual(await runner.list({ all: true }), []);
});

import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildChildArgv,
  capUtf8Tail,
  childExcludeTools,
  createSubagentManager,
  LIVE_STDOUT_CAP,
  shouldRegisterSubagentTools,
} from '../pi/extension/subagents.ts';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = null;

  kill(signal) {
    this.killed = signal;
    return true;
  }

  close(code = 0, signal = null) {
    this.emit('close', code, signal);
  }
}

function capability(childId, role, profile = 'direct') {
  return {
    childId,
    agentRole: `pi-subagent.${childId}.${role}`,
    profile,
    token: `child-token-${childId}`,
  };
}

test('child argv uses an internal session id and excludes nested/root interaction tools', () => {
  const argv = buildChildArgv({
    model: 'openrouter/deepseek/deepseek-chat-v3.1',
    sessionDir: '/pi/sessions',
    sessionId: 'internal-uuid',
    prompt: 'Inspect one section.',
    role: 'doc-researcher',
    planningRestricted: false,
  });
  assert.equal(argv[argv.indexOf('--session-id') + 1], 'internal-uuid');
  assert.match(argv[argv.indexOf('--exclude-tools') + 1], /subagent_spawn/);
  assert.match(argv[argv.indexOf('--exclude-tools') + 1], /ask_user/);
  assert.match(argv[argv.indexOf('--exclude-tools') + 1], /bash,edit,write/);
});

test('a child extension does not register another fleet surface', () => {
  assert.equal(shouldRegisterSubagentTools({}), true);
  assert.equal(shouldRegisterSubagentTools({ RHWP_PI_SUBAGENT_ID: 'child-id' }), false);
});

test('manager replaces root authority and uses unique internal child sessions', async () => {
  const spawned = [];
  const registrations = [];
  let internalSequence = 0;
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'deepseek/deepseek-chat-v3.1',
    sessionDir: '/pi/sessions',
    env: {
      RHWP_AGENT_TOKEN: 'root-token',
      RHWP_AGENT_NAME: 'pi',
      RHWP_SESSION_ID: 'hub-session',
      RHWP_TOOL_PROFILE: 'direct',
      OPENROUTER_API_KEY: 'provider-secret',
    },
    internalSessionId: () => `internal-${++internalSequence}`,
    async registerCapability(request) {
      registrations.push(request);
      return capability(request.childId, request.role, request.role === 'doc-researcher' ? 'doc-researcher' : 'direct');
    },
    async revokeCapability() {},
    spawnProcess(command, argv, options) {
      const proc = new FakeChild();
      spawned.push({ command, argv, options, proc });
      return proc;
    },
  });

  const first = await manager.spawn({ prompt: 'Edit A.', name: 'A', role: 'doc-editor', cwd: process.cwd() });
  const second = await manager.spawn({ prompt: 'Research B.', name: 'B', role: 'doc-researcher', cwd: process.cwd() });

  assert.equal(first.id, 'sa-1');
  assert.notEqual(first.childId, second.childId);
  assert.equal(registrations[0].taskId, 'sa-1');
  assert.equal(spawned[0].argv[spawned[0].argv.indexOf('--session-id') + 1], 'internal-1');
  assert.equal(spawned[1].argv[spawned[1].argv.indexOf('--session-id') + 1], 'internal-2');
  assert.notEqual(spawned[0].argv[spawned[0].argv.indexOf('--session-id') + 1], first.id);
  assert.match(spawned[0].options.env.RHWP_AGENT_TOKEN, /^child-token-/);
  assert.notEqual(spawned[0].options.env.RHWP_AGENT_TOKEN, 'root-token');
  assert.equal(spawned[0].options.env.RHWP_PI_SUBAGENT_ID, first.childId);
  assert.match(spawned[0].options.env.RHWP_AGENT_ROLE, /^pi-subagent\./);
  assert.equal(spawned[1].options.env.RHWP_TOOL_PROFILE, 'doc-researcher');

  spawned[0].proc.close();
  spawned[1].proc.close();
  await Promise.all([first.done, second.done]);
});

test('cancel revokes authority before signaling and holds the slot until close', async () => {
  const order = [];
  const processes = [];
  let finishTermination;
  const terminationGate = new Promise((resolve) => { finishTermination = resolve; });
  let noteTerminationStarted;
  const terminationStarted = new Promise((resolve) => { noteTerminationStarted = resolve; });
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'model',
    sessionDir: '/pi/sessions',
    env: {},
    async registerCapability(request) { return capability(request.childId, request.role); },
    async revokeCapability() { order.push('revoke'); },
    async terminateChild(proc) {
      order.push('kill');
      proc.kill('SIGTERM');
      noteTerminationStarted();
      await terminationGate;
      proc.close(null, 'SIGTERM');
      return 'proven';
    },
    spawnProcess() {
      const proc = new FakeChild();
      processes.push(proc);
      return proc;
    },
  });
  const children = [];
  for (let index = 0; index < 4; index += 1) {
    children.push(await manager.spawn({ prompt: `${index}`, name: `${index}`, cwd: process.cwd() }));
  }

  const cancelling = manager.cancel([children[0].id]);
  await terminationStarted;
  assert.deepEqual(order.slice(0, 2), ['revoke', 'kill']);
  assert.equal(manager.runningCount(), 4);
  await assert.rejects(
    manager.spawn({ prompt: 'fifth', name: 'fifth', cwd: process.cwd() }),
    /Max 4 subagents/,
  );
  finishTermination();
  await cancelling;
  await children[0].done;
  assert.equal(order.filter((entry) => entry === 'revoke').length, 1);
  assert.equal(manager.runningCount(), 3);
  for (const proc of processes.slice(1)) proc.close();
  await Promise.all(children.slice(1).map((entry) => entry.done));
});

test('cancel kills the owned process tree but reports an unrevoked capability', async () => {
  const order = [];
  let issuedCapability;
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'model',
    sessionDir: '/pi/sessions',
    env: {},
    async registerCapability(request) {
      issuedCapability = capability(request.childId, request.role);
      return issuedCapability;
    },
    async revokeCapability() {
      order.push('revoke');
      throw new Error(`Bearer ${issuedCapability.token} stayed live`);
    },
    async terminateChild(proc) {
      order.push('kill-tree');
      proc.close(null, 'SIGTERM');
      return 'proven';
    },
    spawnProcess() { return new FakeChild(); },
  });
  const record = await manager.spawn({ prompt: 'task', name: 'task', cwd: process.cwd() });
  await assert.rejects(manager.cancel([record.id]), /cancellation cleanup unconfirmed/);
  assert.deepEqual(order, ['revoke', 'kill-tree', 'revoke']);
  await record.done;
  assert.doesNotMatch(manager.snapshot(record), new RegExp(issuedCapability.token));
});

test('multi-cancel acts on every child before reporting cleanup uncertainty', async () => {
  const killed = [];
  let firstChildId;
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'model',
    sessionDir: '/pi/sessions',
    env: {},
    async registerCapability(request) {
      firstChildId ??= request.childId;
      return capability(request.childId, request.role);
    },
    async revokeCapability(issued) {
      if (issued.childId === firstChildId) throw new Error('first capability stayed live');
    },
    async terminateChild(proc) {
      killed.push(proc);
      proc.close(null, 'SIGTERM');
      return 'proven';
    },
    spawnProcess() { return new FakeChild(); },
  });
  const first = await manager.spawn({ prompt: 'first', name: 'first', cwd: process.cwd() });
  const second = await manager.spawn({ prompt: 'second', name: 'second', cwd: process.cwd() });
  await assert.rejects(manager.cancel([first.id, second.id]), /cancellation cleanup unconfirmed/);
  assert.equal(killed.length, 2);
  await Promise.all([first.done, second.done]);
});

test('failed diagnostics are redacted and live output remains bounded', async () => {
  let childProcess;
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'model',
    sessionDir: '/pi/sessions',
    env: { RHWP_AGENT_TOKEN: 'root-secret', OPENROUTER_API_KEY: 'sk-provider-secret-12345' },
    async registerCapability(request) { return capability(request.childId, request.role); },
    async revokeCapability() {},
    spawnProcess() { childProcess = new FakeChild(); return childProcess; },
  });
  const record = await manager.spawn({ prompt: 'task', name: 'task', cwd: process.cwd() });
  const childToken = record.capability.token;
  childProcess.stdout.emit('data', 'x'.repeat(LIVE_STDOUT_CAP));
  childProcess.stdout.emit('data', `tail-kept ${childToken}`);
  childProcess.stderr.emit('data', 'Bearer root-secret token=sk-provider-secret-12345');
  childProcess.close(1, null);
  await record.done;

  assert.ok(Buffer.byteLength(record.output) <= LIVE_STDOUT_CAP);
  assert.match(record.output, /tail-kept \[redacted\]$/);
  const snapshot = manager.snapshot(record);
  assert.doesNotMatch(snapshot, new RegExp(`root-secret|provider-secret|${childToken}`));
  assert.match(snapshot, /\[redacted\]/);
  assert.equal(capUtf8Tail('한글한글', 6), '한글');
});

test('natural exit reports capability cleanup uncertainty with redacted diagnostics', async () => {
  let childProcess;
  let issuedCapability;
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'model',
    sessionDir: '/pi/sessions',
    env: {},
    async registerCapability(request) {
      issuedCapability = capability(request.childId, request.role);
      return issuedCapability;
    },
    async revokeCapability() {
      throw new Error(`Bearer ${issuedCapability.token} could not be revoked`);
    },
    spawnProcess() { childProcess = new FakeChild(); return childProcess; },
  });
  const record = await manager.spawn({ prompt: 'task', name: 'task', cwd: process.cwd() });
  childProcess.close(0);
  await record.done;
  assert.equal(record.status, 'error');
  assert.match(manager.snapshot(record), /Capability cleanup failed/);
  assert.doesNotMatch(manager.snapshot(record), new RegExp(issuedCapability.token));
});

test('natural close terminates the owned process tree before releasing the child', async () => {
  let childProcess;
  let terminationCalls = 0;
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'model',
    sessionDir: '/pi/sessions',
    env: {},
    async registerCapability(request) { return capability(request.childId, request.role); },
    async revokeCapability() {},
    async terminateChild(proc) {
      terminationCalls += 1;
      assert.equal(proc, childProcess);
      return 'proven';
    },
    spawnProcess() { childProcess = new FakeChild(); return childProcess; },
  });
  const record = await manager.spawn({ prompt: 'task', name: 'task', cwd: process.cwd() });
  childProcess.close(0);
  await record.done;

  assert.equal(terminationCalls, 1);
  assert.equal(record.status, 'done');
  assert.equal(manager.runningCount(), 0);
});

test('aborting wait removes its listener and leaves the child running', async () => {
  let childProcess;
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'model',
    sessionDir: '/pi/sessions',
    env: {},
    async registerCapability(request) { return capability(request.childId, request.role); },
    async revokeCapability() {},
    spawnProcess() { childProcess = new FakeChild(); return childProcess; },
  });
  const record = await manager.spawn({ prompt: 'task', name: 'task', cwd: process.cwd() });
  const controller = new AbortController();
  const waiting = manager.waitFor([record.id], controller.signal);
  controller.abort();
  await assert.rejects(waiting, /Wait aborted\. Subagents keep running/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(manager.runningCount(), 1);
  childProcess.close();
  await record.done;
});

test('a failed capability registration never launches a child or consumes a slot', async () => {
  let spawns = 0;
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'model',
    sessionDir: '/pi/sessions',
    env: {},
    async registerCapability() { throw new Error('Bearer root-secret registration failed'); },
    spawnProcess() { spawns += 1; return new FakeChild(); },
  });
  await assert.rejects(
    manager.spawn({ prompt: 'task', name: 'task', cwd: process.cwd() }),
    /registration failed/,
  );
  assert.equal(spawns, 0);
  assert.equal(manager.runningCount(), 0);
});

test('working_dir is revalidated after capability registration before spawn', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-pi-child-cwd-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'rhwp-pi-child-outside-'));
  mkdirSync(path.join(root, 'inside'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  let releaseRegistration;
  const registrationGate = new Promise((resolve) => { releaseRegistration = resolve; });
  let registrationStarted;
  const started = new Promise((resolve) => { registrationStarted = resolve; });
  let spawns = 0;
  let revokes = 0;
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'model',
    sessionDir: '/pi/sessions',
    env: { RHWP_ROOT_DIR: root },
    async registerCapability(request) {
      registrationStarted(request);
      await registrationGate;
      return capability(request.childId, request.role);
    },
    async revokeCapability() { revokes += 1; },
    spawnProcess() { spawns += 1; return new FakeChild(); },
  });
  const spawning = manager.spawn({
    prompt: 'task', name: 'task', working_dir: 'inside', cwd: root,
  });
  await started;
  renameSync(path.join(root, 'inside'), path.join(root, 'authorized-but-moved'));
  symlinkSync(outside, path.join(root, 'inside'), 'dir');
  releaseRegistration();
  await assert.rejects(spawning, /working_dir must stay inside|working_dir changed/);
  assert.equal(spawns, 0);
  assert.equal(revokes, 1);
  assert.equal(manager.runningCount(), 0);
});

test('an aborted gated spawn revokes its capability and never launches', async () => {
  let releaseRegistration;
  const registrationGate = new Promise((resolve) => { releaseRegistration = resolve; });
  let registrationStarted;
  const started = new Promise((resolve) => { registrationStarted = resolve; });
  let spawns = 0;
  let revokes = 0;
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'model',
    sessionDir: '/pi/sessions',
    env: {},
    async registerCapability(request) {
      registrationStarted();
      await registrationGate;
      return capability(request.childId, request.role);
    },
    async revokeCapability() { revokes += 1; },
    spawnProcess() { spawns += 1; return new FakeChild(); },
  });
  const controller = new AbortController();
  const spawning = manager.spawn({
    prompt: 'task', name: 'task', cwd: process.cwd(), signal: controller.signal,
  });
  await started;
  controller.abort();
  releaseRegistration();
  await assert.rejects(spawning, /Subagent spawn aborted/);
  assert.equal(spawns, 0);
  assert.equal(revokes, 1);
  assert.equal(manager.runningCount(), 0);
});

test('dispose waits for pending registration and prevents a post-shutdown launch', async () => {
  let releaseRegistration;
  const registrationGate = new Promise((resolve) => { releaseRegistration = resolve; });
  let registrationStarted;
  const started = new Promise((resolve) => { registrationStarted = resolve; });
  let spawns = 0;
  let revokes = 0;
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'model',
    sessionDir: '/pi/sessions',
    env: {},
    async registerCapability(request) {
      registrationStarted();
      await registrationGate;
      return capability(request.childId, request.role);
    },
    async revokeCapability() { revokes += 1; },
    spawnProcess() { spawns += 1; return new FakeChild(); },
  });
  const spawning = manager.spawn({ prompt: 'task', name: 'task', cwd: process.cwd() });
  await started;
  let disposeFinished = false;
  const disposing = manager.dispose().then(() => { disposeFinished = true; });
  await Promise.resolve();
  assert.equal(disposeFinished, false);

  releaseRegistration();
  await assert.rejects(spawning, /Parent Pi session closed/);
  await disposing;
  assert.equal(spawns, 0);
  assert.equal(revokes, 1);
  assert.equal(manager.runningCount(), 0);
  await assert.rejects(
    manager.spawn({ prompt: 'late task', name: 'late task', cwd: process.cwd() }),
    /Parent Pi session is closed/,
  );
});

test('completed child history is compacted and bounded', async () => {
  const processes = [];
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'model',
    sessionDir: '/pi/sessions',
    env: {},
    async registerCapability(request) { return capability(request.childId, request.role); },
    async revokeCapability() {},
    spawnProcess() {
      const proc = new FakeChild();
      processes.push(proc);
      return proc;
    },
  });
  for (let index = 0; index < 70; index += 1) {
    const record = await manager.spawn({ prompt: `task-${index}`, name: `task-${index}`, cwd: process.cwd() });
    processes.at(-1).close();
    await record.done;
    assert.equal(record.prompt, '');
  }
  assert.equal(manager.list().length, 64);
  assert.equal(manager.get('sa-1'), undefined);
  assert.equal(manager.get('sa-70')?.status, 'done');
});

test('researchers always lose workspace mutation tools', () => {
  assert.match(childExcludeTools(false, 'doc-researcher'), /bash,edit,write/);
  assert.doesNotMatch(childExcludeTools(false, 'doc-editor'), /bash,edit,write/);
});

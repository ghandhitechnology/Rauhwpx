import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BlobStore } from '../src/blob-store.mjs';
import { openDatabase } from '../src/database.mjs';
import { PodmanRunner } from '../src/podman-runner.mjs';
import { ProviderCliManager } from '../src/provider-cli.mjs';
import { redactLogData, RedactedLogger } from '../src/redacted-logger.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { SecretVault } from '../src/secret-vault.mjs';
import { SessionStore } from '../src/session-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cloud-security-'));
  const database = openDatabase(path.join(root, 'cloud.sqlite3'));
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, database };
}

test('provider vault encrypts at rest with a mode-0600 key and authenticated context', async (t) => {
  const { root, database } = await fixture(t);
  const vault = new SecretVault(database, { dataDirectory: root });
  vault.set('cursor', 'CURSOR_API_KEY', 'cursor-secret-value');
  assert.equal(vault.get('cursor', 'CURSOR_API_KEY'), 'cursor-secret-value');
  assert.deepEqual(vault.list().map(({ provider, name }) => ({ provider, name })), [
    { provider: 'cursor', name: 'CURSOR_API_KEY' },
  ]);
  const stored = database.prepare('SELECT * FROM provider_credentials').get();
  assert.equal(Buffer.from(stored.ciphertext).includes(Buffer.from('cursor-secret-value')), false);
  assert.equal((await fs.stat(vault.keyPath)).mode & 0o777, 0o600);
  database.prepare(`UPDATE provider_credentials SET credential_name = 'OTHER'`).run();
  assert.throws(() => vault.get('cursor', 'OTHER'), { code: 'VAULT_DECRYPT_FAILED' });
});

test('service logs redact credentials, content, and bearer tokens before persistence', async (t) => {
  const { database } = await fixture(t);
  const output = { info() {}, warn() {}, error() {} };
  const logger = new RedactedLogger(database, { output });
  const clean = logger.info('request', {
    authorization: 'Bearer ra_at_secret',
    nested: { prompt: 'private document prompt', note: 'token sk-abcdef' },
  });
  assert.deepEqual(clean, {
    authorization: '[REDACTED]',
    nested: { prompt: '[REDACTED]', note: 'token [REDACTED]' },
  });
  const stored = database.prepare('SELECT data_json FROM service_logs').get().data_json;
  assert.equal(stored.includes('private document prompt'), false);
  assert.equal(stored.includes('sk-abcdef'), false);
  assert.equal(redactLogData({ normal: 'Bearer ra_rt_family.1.secret' }).normal, '[REDACTED]');
});

test('Podman runner keeps private rootless networking, mounts only control socket, and caps output', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-podman-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const spawnProcess = (executable, args, options = {}) => {
    calls.push({ executable, args, env: options.env });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (args[1] === 'run') child.stdout.write('x'.repeat(100_000));
      if (args[1] === 'ps') child.stdout.write('[]');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
  const config = {
    dataDirectory: root,
    providerAuthDirectory: path.join(root, 'provider-auth'),
    workerCpuCount: 2,
    workerMemoryBytes: 1024,
    workerPids: 32,
    workspaceBytes: 2048,
    workerImage: 'worker:test',
  };
  const runner = new PodmanRunner(config, { spawnProcess });
  const sandboxId = await runner.start({ id: 'session-1', provider: 'codex' }, {
    workerToken: 'worker-token', controlSocket: path.join(root, 'control.sock'),
  });
  assert.equal(sandboxId.length, 64 * 1024);
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 2), ['--cgroup-manager=cgroupfs', 'run']);
  assert.equal(args.includes('--network=host'), false);
  assert.equal(args.includes('--network'), false, 'Podman default rootless private network should be used');
  assert.equal(args.some((value) => value.startsWith('--userns=keep-id')), false);
  const firstMap = args.indexOf('--uidmap');
  assert.deepEqual(args.slice(firstMap, firstMap + 12), [
    '--uidmap', '0:1:1000',
    '--uidmap', '1000:0:1',
    '--uidmap', '1001:1001:64535',
    '--gidmap', '0:1:1000',
    '--gidmap', '1000:0:1',
    '--gidmap', '1001:1001:64535',
  ]);
  assert.ok(args.includes('--cap-drop=all'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('max-size=1048576'));
  assert.ok(args.some((value) => value.includes('/workspace:rw,size=2048')));
  assert.equal(args.includes('--env'), true);
  const tokenIndex = args.indexOf('RAUHWpx_WORKER_TOKEN');
  assert.ok(tokenIndex > 0 && args[tokenIndex - 1] === '--env');
  assert.equal(args.some((value) => String(value).includes('worker-token')), false);
  assert.equal(calls[0].env?.RAUHWpx_WORKER_TOKEN, 'worker-token');
  const nameIndex = args.indexOf('--name');
  assert.match(args[nameIndex + 1], /^rauhwpx-[a-f0-9]{32}$/);
  const workspaceTmpfs = args[args.indexOf('--tmpfs') + 1];
  const secondTmpfsIndex = args.indexOf('--tmpfs', args.indexOf('--tmpfs') + 1);
  const temporaryTmpfs = args[secondTmpfsIndex + 1];
  assert.match(workspaceTmpfs, /mode=1777$/);
  assert.match(temporaryTmpfs, /mode=1777$/);
  assert.doesNotMatch(`${workspaceTmpfs},${temporaryTmpfs}`, /(?:uid|gid)=/);
  assert.ok(args.some((value) => value.includes(':/run/rauhwpx:ro,Z')));
  assert.ok(args.some((value) => value.includes('/provider-auth/codex:/provider-auth:ro,Z')));
  await runner.list({ all: true });
  assert.deepEqual(calls.at(-1).args.slice(0, 2), ['--cgroup-manager=cgroupfs', 'ps']);
  assert.equal(calls.at(-1).args[2], '--no-trunc');
  assert.ok(calls.at(-1).args.includes('--all'), 'stopped worker containers must be discoverable for cleanup');
  assert.deepEqual(calls.at(-1).args.slice(-2), ['--format', 'json']);
  await runner.stop('sandbox-1');
  assert.deepEqual(calls.at(-1).args.slice(0, 2), ['--cgroup-manager=cgroupfs', 'rm']);
});

test('Podman list preserves the full detach ID used by scheduler recovery', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-podman-full-id-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fullSandboxId = 'a'.repeat(64);
  const calls = [];
  const spawnProcess = (_executable, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (args[1] === 'run') child.stdout.write(`${fullSandboxId}\n`);
      if (args[1] === 'ps') {
        child.stdout.write(JSON.stringify([{
          Id: fullSandboxId,
          Labels: { 'com.rauhwpx.cloud': 'true', 'com.rauhwpx.session': 'session-full-id' },
        }]));
      }
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
  const runner = new PodmanRunner({
    providerAuthDirectory: path.join(root, 'provider-auth'),
    workerCpuCount: 1,
    workerMemoryBytes: 1024,
    workerPids: 16,
    workspaceBytes: 2048,
    workerImage: 'worker:test',
  }, { spawnProcess });
  const started = await runner.start({ id: 'session-full-id', provider: 'codex' }, {
    workerToken: 'worker-token', controlSocket: path.join(root, 'control.sock'),
  });
  const [listed] = await runner.list();
  assert.equal(started, fullSandboxId);
  assert.equal(listed.sandboxId, started);
  assert.equal(listed.sessionId, 'session-full-id');
  const listArgs = calls.find((args) => args[1] === 'ps');
  assert.deepEqual(listArgs, [
    '--cgroup-manager=cgroupfs', 'ps', '--no-trunc',
    '--filter', 'label=com.rauhwpx.cloud=true', '--format', 'json',
  ]);
});

test('macOS Podman runner selects the dedicated VM and uses HTTP worker control', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-podman-macos-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const spawnProcess = (executable, args) => {
    calls.push({ executable, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.write('a'.repeat(64));
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
  const runner = new PodmanRunner({
    platform: 'darwin', podmanConnection: 'rauhwpx-cloud',
    providerAuthDirectory: path.join(root, 'provider-auth'),
    workerCpuCount: 2, workerMemoryBytes: 1024, workerPids: 32, workspaceBytes: 2048,
    workerImage: 'worker:test',
  }, { spawnProcess });
  await runner.start({ id: 'session-macos', provider: 'codex' }, {
    workerToken: 'worker-token',
    controlEndpoint: { baseUrl: 'http://host.containers.internal:12345' },
  });
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 4), ['--connection', 'rauhwpx-cloud', 'run', '--detach']);
  assert.ok(args.includes('--userns=keep-id:uid=1000,gid=1000'));
  assert.ok(args.includes('RAUHWpx_CONTROL_URL=http://host.containers.internal:12345'));
  assert.equal(args.some((value) => value.includes('/run/rauhwpx')), false);
  assert.equal(args.includes('--cgroup-manager=cgroupfs'), false);
  assert.ok(args.some((value) => value.endsWith('/provider-auth:ro')));
});

test('Podman list propagates command, JSON, shape, and output-limit failures', async () => {
  const responseCases = [
    { name: 'command failure', code: 125, stderr: 'unsupported format', output: '', expected: 'PODMAN_FAILED' },
    { name: 'invalid JSON', code: 0, stderr: '', output: '{', expected: 'PODMAN_RESPONSE_INVALID' },
    { name: 'invalid shape', code: 0, stderr: '', output: JSON.stringify([{ Id: 'short', Labels: {} }]), expected: 'PODMAN_RESPONSE_INVALID' },
    { name: 'oversized output', code: 0, stderr: '', output: ' '.repeat(64 * 1024 + 1), expected: 'PODMAN_OUTPUT_LIMIT' },
  ];
  for (const response of responseCases) {
    const spawnProcess = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.write(response.output);
        child.stderr.write(response.stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', response.code);
      });
      return child;
    };
    const runner = new PodmanRunner({}, { spawnProcess });
    await assert.rejects(runner.list(), (error) => {
      assert.equal(error.code, response.expected, response.name);
      return true;
    });
  }
});

test('Podman shutdown ignores only missing containers and reports other removal failures', async () => {
  const close = (child, code, stderr = '') => queueMicrotask(() => {
    child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code);
  });
  const spawnWithError = (stderr) => () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    close(child, 125, stderr);
    return child;
  };

  const missing = new PodmanRunner({}, {
    spawnProcess: spawnWithError('Error: no such container: already-removed'),
  });
  await missing.stop('already-removed');

  const denied = new PodmanRunner({}, {
    spawnProcess: spawnWithError('Error: permission denied'),
  });
  await assert.rejects(denied.stop('still-running'), { code: 'PODMAN_FAILED' });
});

test('Podman stopAll propagates inventory failure instead of claiming cleanup', async () => {
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.end('Podman service unavailable');
      child.stdout.end();
      child.emit('close', 125);
    });
    return child;
  };
  const runner = new PodmanRunner({}, { spawnProcess });
  await assert.rejects(runner.stopAll(), { code: 'PODMAN_FAILED' });
});

test('Podman stopAll attempts every container and aggregates failed removals', async () => {
  const firstId = 'a'.repeat(64);
  const secondId = 'b'.repeat(64);
  const removals = [];
  const spawnProcess = (_executable, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (args.includes('ps')) {
        child.stdout.end(JSON.stringify([
          { Id: firstId, Labels: { 'com.rauhwpx.session': 'session-first' }, State: 'running' },
          { Id: secondId, Labels: { 'com.rauhwpx.session': 'session-second' }, State: 'running' },
        ]));
        child.stderr.end();
        child.emit('close', 0);
        return;
      }
      const sandboxId = args.at(-1);
      removals.push(sandboxId);
      child.stdout.end();
      if (sandboxId === firstId) {
        child.stderr.end('Error: permission denied');
        child.emit('close', 125);
      } else {
        child.stderr.end();
        child.emit('close', 0);
      }
    });
    return child;
  };
  const runner = new PodmanRunner({}, { spawnProcess });
  await assert.rejects(runner.stopAll(), (error) => {
    assert.equal(error.code, 'PODMAN_STOP_FAILED');
    assert.equal(error.errors.length, 1);
    assert.deepEqual(error.details, { sandboxIds: [firstId] });
    return true;
  });
  assert.deepEqual(removals.sort(), [firstId, secondId].sort());
});

test('scheduler inventory failures propagate before session recovery mutates state', async () => {
  const mutations = [];
  const inventoryError = Object.assign(new Error('Podman inventory unavailable'), { code: 'PODMAN_FAILED' });
  const sessionStore = {
    recoverInterruptedSessions: (...args) => { mutations.push(args); },
    expireRetainedSessions: async () => { mutations.push('expired'); },
  };
  const recoveryScheduler = new Scheduler(sessionStore, { list: async () => { throw inventoryError; } });
  await assert.rejects(recoveryScheduler.recover(), (error) => error === inventoryError);
  assert.deepEqual(mutations, []);
  let listCalls = 0;
  const tickScheduler = new Scheduler(sessionStore, {
    list: async () => {
      listCalls += 1;
      if (listCalls === 1) throw inventoryError;
      return [];
    },
  });
  await assert.rejects(tickScheduler.tick(), (error) => error === inventoryError);
  assert.equal(listCalls, 1);
  assert.deepEqual(mutations, [], 'neither recovery nor maintenance may mutate state from an incomplete inventory');
});

test('scheduler does not requeue a running session whose full sandbox ID is still live', async () => {
  const fullSandboxId = 'b'.repeat(64);
  const requeues = [];
  const stops = [];
  let listCalls = 0;
  const database = {
    prepare(sql) {
      if (sql.includes("SELECT * FROM sessions WHERE status = 'running'")) {
        return { all: () => [{ id: 'session-live', sandbox_id: fullSandboxId }] };
      }
      if (sql.includes('SELECT status, sandbox_id FROM sessions WHERE id = ?')) {
        return { get: () => ({ status: 'running', sandbox_id: fullSandboxId }) };
      }
      if (sql.includes("SELECT COUNT(*) AS count FROM sessions WHERE status = 'running'")) {
        return { get: () => ({ count: 1 }) };
      }
      throw new Error(`Unexpected scheduler query: ${sql}`);
    },
  };
  const sessionStore = {
    database,
    expireRetainedSessions: async () => {},
    requeueInterruptedSession: (...args) => { requeues.push(args); },
    clearSandbox: () => {},
  };
  const runner = {
    list: async () => { listCalls += 1; return [{ sandboxId: fullSandboxId, sessionId: 'session-live', running: true }]; },
    stop: async (id) => { stops.push(id); },
  };
  const scheduler = new Scheduler(sessionStore, runner, { maxRunningSessions: 1 });
  await scheduler.tick();
  assert.equal(listCalls, 1);
  assert.deepEqual(requeues, []);
  assert.deepEqual(stops, []);
});

function idleSchedulerStore() {
  return {
    database: {
      prepare(sql) {
        if (sql.includes("SELECT * FROM sessions WHERE status = 'running'")) return { all: () => [] };
        if (sql.includes("SELECT COUNT(*) AS count FROM sessions WHERE status = 'running'")) {
          return { get: () => ({ count: 0 }) };
        }
        throw new Error(`Unexpected scheduler query: ${sql}`);
      },
    },
    recoverInterruptedSessions() {},
    expireRetainedSessions: async () => {},
    requestIdleSleeps() {},
    claimNextSession: () => null,
  };
}

test('scheduler startup is single-flight and stop cancels a startup still in recovery', async () => {
  const recovery = Promise.withResolvers();
  let listCalls = 0;
  const runner = {
    list: async () => {
      listCalls += 1;
      if (listCalls === 1) return recovery.promise;
      return [];
    },
  };
  const scheduler = new Scheduler(idleSchedulerStore(), runner, { intervalMs: 60_000 });
  const first = scheduler.start();
  const second = scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listCalls, 1, 'concurrent starts must share recovery');

  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, 'stop must wait for admitted startup work');
  recovery.resolve([]);
  await Promise.all([first, second, stopping]);

  assert.equal(listCalls, 1, 'cancelled startup must not run its initial tick');
  assert.equal(scheduler.timer, null);
});

test('scheduler stop fences an active tick before it can claim or start work', async () => {
  const inventory = Promise.withResolvers();
  const inventoryEntered = Promise.withResolvers();
  let claims = 0;
  let starts = 0;
  const sessionStore = idleSchedulerStore();
  sessionStore.claimNextSession = () => {
    claims += 1;
    return claims === 1 ? { id: 'session-after-stop', provider: 'codex' } : null;
  };
  sessionStore.providerStatus = () => ({ available: true, authenticated: true });
  sessionStore.prepareWorker = () => {};
  sessionStore.attachSandbox = () => {};
  sessionStore.suspend = () => {};
  sessionStore.requeueInterruptedSession = () => {};
  const runner = {
    async list() {
      inventoryEntered.resolve();
      return inventory.promise;
    },
    async start() {
      starts += 1;
      return 'sandbox-after-stop';
    },
    async stop() {},
  };
  const scheduler = new Scheduler(sessionStore, runner, { maxRunningSessions: 1 });

  const ticking = scheduler.tick();
  await inventoryEntered.promise;
  const stopping = scheduler.stop();
  inventory.resolve([]);
  await Promise.all([ticking, stopping]);

  assert.equal(claims, 0);
  assert.equal(starts, 0);
  assert.equal(scheduler.timer, null);
});

test('scheduler stop revokes and removes a sandbox that finishes starting late', async () => {
  const sandbox = Promise.withResolvers();
  const startEntered = Promise.withResolvers();
  let claimed = false;
  const requeues = [];
  const attaches = [];
  const stops = [];
  const sessionStore = idleSchedulerStore();
  sessionStore.database = {
    prepare(sql) {
      if (sql.includes("SELECT * FROM sessions WHERE status = 'running'")) return { all: () => [] };
      if (sql.includes("SELECT COUNT(*) AS count FROM sessions WHERE status = 'running'")) {
        return { get: () => ({ count: claimed ? 1 : 0 }) };
      }
      throw new Error(`Unexpected scheduler query: ${sql}`);
    },
  };
  sessionStore.claimNextSession = () => {
    if (claimed) return null;
    claimed = true;
    return { id: 'session-late-start', provider: 'codex' };
  };
  sessionStore.providerStatus = () => ({ available: true, authenticated: true });
  sessionStore.prepareWorker = () => {};
  sessionStore.attachSandbox = (...args) => attaches.push(args);
  sessionStore.suspend = () => {};
  sessionStore.requeueInterruptedSession = (...args) => requeues.push(args);
  const runner = {
    async list() { return []; },
    async start() {
      startEntered.resolve();
      return sandbox.promise;
    },
    async stop(sandboxId) { stops.push(sandboxId); },
  };
  const scheduler = new Scheduler(sessionStore, runner, { maxRunningSessions: 1 });

  const ticking = scheduler.tick();
  await startEntered.promise;
  const stopping = scheduler.stop();
  assert.deepEqual(requeues, [['session-late-start', 'scheduler_stopped']]);
  sandbox.resolve('sandbox-late-start');
  await Promise.all([ticking, stopping]);

  assert.deepEqual(attaches, []);
  assert.deepEqual(stops, ['sandbox-late-start']);
});

test('scheduler removes a duplicate sandbox even when it has the active session label', async () => {
  const stopped = [];
  const cleared = [];
  const sessionStore = {
    database: {
      prepare(sql) {
        if (sql.includes("SELECT * FROM sessions WHERE status = 'running'")) {
          return { all: () => [{ id: 'session-duplicate', sandbox_id: 'sandbox-current' }] };
        }
        if (sql.includes('SELECT status, sandbox_id FROM sessions WHERE id = ?')) {
          return { get: () => ({ status: 'running', sandbox_id: 'sandbox-current' }) };
        }
        if (sql.includes("SELECT COUNT(*) AS count FROM sessions WHERE status = 'running'")) {
          return { get: () => ({ count: 1 }) };
        }
        throw new Error(`Unexpected scheduler query: ${sql}`);
      },
    },
    expireRetainedSessions: async () => {},
    requestIdleSleeps() {},
    clearSandbox: (...args) => cleared.push(args),
  };
  const runner = {
    list: async () => [
      { sandboxId: 'sandbox-current', sessionId: 'session-duplicate', running: true },
      { sandboxId: 'sandbox-stale', sessionId: 'session-duplicate', running: true },
    ],
    stop: async (sandboxId) => { stopped.push(sandboxId); },
  };
  await new Scheduler(sessionStore, runner, { maxRunningSessions: 1 }).tick();
  assert.deepEqual(stopped, ['sandbox-stale']);
  assert.deepEqual(cleared, [['session-duplicate', 'sandbox-stale']]);
});

test('scheduler stops a worker that loses the session before sandbox attachment', async () => {
  const stopped = [];
  let capacityChecks = 0;
  const sessionStore = {
    database: {
      prepare(sql) {
        if (sql.includes("SELECT * FROM sessions WHERE status = 'running'")) return { all: () => [] };
        if (sql.includes("SELECT COUNT(*) AS count FROM sessions WHERE status = 'running'")) {
          return { get: () => ({ count: capacityChecks++ === 0 ? 0 : 1 }) };
        }
        throw new Error(`Unexpected scheduler query: ${sql}`);
      },
    },
    expireRetainedSessions: async () => {},
    requestIdleSleeps() {},
    claimNextSession: () => ({ id: 'session-cancelled-during-start', provider: 'codex' }),
    providerStatus: () => ({ available: true, authenticated: true }),
    prepareWorker() {},
    attachSandbox() {
      throw Object.assign(new Error('Session was cancelled'), { code: 'INVALID_SESSION_STATE' });
    },
    suspend() {},
  };
  const runner = {
    list: async () => [],
    start: async () => 'sandbox-cancelled-during-start',
    stop: async (sandboxId) => { stopped.push(sandboxId); },
  };
  const logger = { info() {}, error() {} };
  await new Scheduler(sessionStore, runner, { logger, maxRunningSessions: 1 }).tick();
  assert.deepEqual(stopped, ['sandbox-cancelled-during-start']);
});

test('scheduler starts up to the configured cap and suspends failed sandboxes durably', async (t) => {
  const { root, database } = await fixture(t);
  const blobs = new BlobStore(database, { root: path.join(root, 'objects') });
  const sessions = new SessionStore(database, blobs);
  database.prepare(`INSERT INTO devices(id, name, created_at, last_seen_at) VALUES ('device', 'Device', 1, 1)`).run();
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const documentBytes = Buffer.from('document');
  const digest = createHash('sha256').update(documentBytes).digest('hex');
  const initialized = await blobs.initUpload({ deviceId: 'device', sha256: digest, size: documentBytes.length, name: 'doc', kind: 'document' });
  await blobs.appendChunk({ uploadId: initialized.uploadId, deviceId: 'device', offset: 0, bytes: documentBytes });
  for (const id of ['session-scheduler-1', 'session-scheduler-2', 'session-scheduler-3']) {
    sessions.createSession({ id: 'device' }, {
      sessionId: id, provider: 'codex', goal: 'Work',
      originDocument: { blobId: digest, size: documentBytes.length, name: 'doc' },
      resources: [], timeline: null, limits: { maxDurationSeconds: 3600, maxTurns: 10 },
    });
    sessions.executeCommand({ id: 'device' }, id, {
      commandId: `activate-${id}`, type: 'session.activate', payload: { expectedVersion: 1 },
    });
  }
  const starts = [];
  const runner = {
    maxRunningSessions: 1,
    async list() { return []; },
    async start(session, options) {
      starts.push({ session, options });
      if (session.id.endsWith('1')) throw Object.assign(new Error('image missing'), { code: 'PODMAN_FAILED' });
      return `sandbox-${session.id}`;
    },
    async stop() {},
  };
  const logger = { info() {}, error() {} };
  const scheduler = new Scheduler(sessions, runner, {
    logger, maxRunningSessions: 4, controlSocket: path.join(root, 'control.sock'),
  });
  assert.equal(scheduler.maxRunningSessions, 1, 'local runners cap configured concurrency at one');
  await scheduler.tick();
  assert.equal(starts.length, 2, 'a failed claim should free capacity for the next queued session');
  assert.equal(sessions.getSession('session-scheduler-1').status, 'suspended');
  assert.equal(sessions.getSession('session-scheduler-2').status, 'running');
  assert.equal(sessions.getSession('session-scheduler-3').status, 'queued');
  assert.equal(starts[1].options.controlSocket, path.join(root, 'control.sock'));
  assert.equal(new Scheduler({}, {}, { maxRunningSessions: 4 }).maxRunningSessions, 4);
});

test('doctor separates managed CLI health from optional provider authentication', async () => {
  const states = new Map([
    ['claude', { provider: 'claude', available: true, authenticated: false }],
    ['codex', { provider: 'codex', available: true, authenticated: true }],
    ['pi', { provider: 'pi', available: true, authenticated: false }],
    ['grok', { provider: 'grok', available: true, authenticated: false }],
    ['cursor', { provider: 'cursor', available: true, authenticated: false }],
  ]);
  const providerManager = { probe: async (provider) => states.get(provider) };
  const manager = new ProviderCliManager({ providerAuthDirectory: '/tmp/auth', providerCliDirectory: '/tmp/cli' }, providerManager, {});
  const healthy = await manager.doctor('codex');
  assert.equal(healthy.ok, true);
  assert.equal(healthy.selectedProviderReady, true);
  const authNeeded = await manager.doctor('claude');
  assert.equal(authNeeded.ok, true);
  assert.equal(authNeeded.selectedProviderReady, false);
  states.set('cursor', { provider: 'cursor', available: false, authenticated: false });
  assert.equal((await manager.doctor()).ok, false);
});

test('provider environments precreate every private CLI state directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-provider-environment-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const providerAuthDirectory = path.join(root, 'auth');
  const providerCliDirectory = path.join(root, 'cli');
  await fs.mkdir(path.join(providerAuthDirectory, 'codex', '.codex'), { recursive: true, mode: 0o755 });
  const manager = new ProviderCliManager({ providerAuthDirectory, providerCliDirectory }, { probe: async () => ({}) }, {});
  for (const provider of ['claude', 'codex', 'pi', 'grok', 'cursor']) {
    const environment = manager.environment(provider);
    const expected = [
      environment.HOME,
      environment.XDG_CONFIG_HOME,
      environment.XDG_CACHE_HOME,
      environment.XDG_DATA_HOME,
      environment.XDG_STATE_HOME,
      environment.CODEX_HOME,
      environment.GROK_HOME,
      environment.PI_CODING_AGENT_DIR,
      path.join(environment.HOME, '.local'),
      path.join(environment.HOME, '.local', 'bin'),
      path.join(environment.HOME, '.pi'),
    ];
    for (const directory of expected) {
      const stat = await fs.lstat(directory);
      assert.equal(stat.isDirectory(), true, directory);
      assert.equal(stat.isSymbolicLink(), false, directory);
      assert.equal(stat.mode & 0o777, 0o700, directory);
    }
  }
});

test('unreferenced blob delete is gated on the row actually disappearing', async (t) => {
  const { root, database } = await fixture(t);
  const blobs = new BlobStore(database, { root: path.join(root, 'objects') });
  database.prepare(`INSERT INTO devices(id, name, created_at, last_seen_at) VALUES ('device', 'Device', 1, 1)`).run();
  const documentBytes = Buffer.from('keep-me');
  const digest = createHash('sha256').update(documentBytes).digest('hex');
  const initialized = await blobs.initUpload({
    deviceId: 'device', sha256: digest, size: documentBytes.length, name: 'doc', kind: 'document',
  });
  await blobs.appendChunk({ uploadId: initialized.uploadId, deviceId: 'device', offset: 0, bytes: documentBytes });
  database.prepare('UPDATE blobs SET ref_count = 1 WHERE sha256 = ?').run(digest);
  const storagePath = blobs.get(digest).storage_path;
  assert.equal(await blobs.removeUnreferenced(digest), false);
  await fs.access(storagePath);
  database.prepare('UPDATE blobs SET ref_count = 0 WHERE sha256 = ?').run(digest);
  assert.equal(await blobs.removeUnreferenced(digest), true);
  await assert.rejects(fs.access(storagePath), { code: 'ENOENT' });
});

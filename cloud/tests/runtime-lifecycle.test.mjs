import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCloudRuntime } from '../src/runtime.mjs';

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cloud-runtime-lifecycle-'));
  const calls = {
    databaseClose: 0,
    displayClose: 0,
    leaseRelease: 0,
    probeAll: 0,
    runnerStopAll: 0,
    schedulerStart: 0,
    schedulerStop: 0,
    errors: [],
  };
  const database = {
    close() { calls.databaseClose += 1; },
  };
  const scheduler = {
    controlEndpoint: null,
    async start() { calls.schedulerStart += 1; },
    async stop() { calls.schedulerStop += 1; },
    ...overrides.scheduler,
  };
  const runner = {
    async probeControl() {},
    async stopAll() { calls.runnerStopAll += 1; },
    ...overrides.runner,
  };
  const providerManager = {
    async probeAll() { calls.probeAll += 1; },
    ...overrides.providerManager,
  };
  const displayFrameStore = {
    closeSession() {},
    closeAll() { calls.displayClose += 1; },
  };
  const logger = {
    prune() {},
    info() {},
    error(event, data) { calls.errors.push({ event, data }); },
  };
  const raucloudLease = {
    async release() { calls.leaseRelease += 1; },
    ...overrides.raucloudLease,
  };
  const runtime = createCloudRuntime({
    runner: 'podman',
    maxRunningSessions: 1,
    maxQueuedSessions: 4,
    dataDirectory: root,
    workerControlDirectory: path.join(root, 'control'),
    workspaceRoot: path.join(root, 'workspace'),
    databasePath: path.join(root, 'cloud.sqlite3'),
    blobDirectory: path.join(root, 'objects'),
    providerAuthDirectory: path.join(root, 'provider-auth'),
    providerCliDirectory: path.join(root, 'provider-cli'),
    workerImage: 'worker:test',
    podmanConnection: null,
    platform: process.platform,
    bootstrapToken: '',
    workerControlMode: 'tcp',
    workerControlSocket: path.join(root, 'control', 'worker.sock'),
    host: '127.0.0.1',
    port: 0,
    basePath: '/rauhwpx-cloud',
    browserOrigins: [],
    startupProviders: [],
  }, {
    database,
    identity: { serverPublicKey: 'ed25519:test', serverId: 'runtime-test' },
    auth: { prune() {}, authenticate() {} },
    blobStore: { async pruneStaleUploads() {} },
    displayFrameStore,
    sessionStore: { setRuntimeInvalidationHandler() {} },
    logger,
    vault: {},
    providerManager,
    runner,
    scheduler,
    providerCli: {},
    raucloudLease,
    seedProvider: async () => ({}),
  });
  t.after(async () => {
    await runtime.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return { runtime, calls };
}

test('runtime start and stop are single-flight', async (t) => {
  const probe = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const { runtime, calls } = await fixture(t, {
    providerManager: {
      async probeAll() {
        calls.probeAll += 1;
        entered.resolve();
        await probe.promise;
      },
    },
  });
  const first = runtime.start();
  await entered.promise;
  const second = runtime.start();
  probe.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(calls.probeAll, 1);
  assert.equal(calls.schedulerStart, 1);

  await Promise.all([runtime.stop(), runtime.stop()]);
  assert.equal(calls.schedulerStop, 1);
  assert.equal(calls.runnerStopAll, 1);
  assert.equal(calls.leaseRelease, 1);
  assert.equal(calls.databaseClose, 1);
});

test('stop fences startup before the scheduler can reopen work', async (t) => {
  const probe = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const { runtime, calls } = await fixture(t, {
    providerManager: {
      async probeAll() {
        calls.probeAll += 1;
        entered.resolve();
        await probe.promise;
      },
    },
  });
  const starting = runtime.start().then(
    () => null,
    (error) => error,
  );
  await entered.promise;
  let stopSettled = false;
  const stopping = runtime.stop().then(() => { stopSettled = true; });
  const lateStart = runtime.start().then(
    () => null,
    (error) => error,
  );
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(stopSettled, false, 'shutdown must drain startup before closing shared state');
    assert.equal(
      runtime.publicServer.listening,
      false,
      'public admission must close before shutdown waits for a blocked startup',
    );
    assert.equal((await lateStart)?.code, 'RUNTIME_STOPPED');
  } finally {
    probe.resolve();
  }
  const startupError = await starting;
  await stopping;

  assert.equal(startupError?.code, 'RUNTIME_STOPPING');
  assert.equal(calls.schedulerStart, 0);
  assert.equal(calls.runnerStopAll, 1);
  assert.equal(calls.databaseClose, 1);
  assert.equal(runtime.publicServer.listening, false);
  assert.equal(runtime.workerServer.listening, false);
  await assert.rejects(runtime.start(), { code: 'RUNTIME_STOPPED' });
});

test('failed startup rolls back workers and can retry without closing the database', async (t) => {
  let probes = 0;
  const { runtime, calls } = await fixture(t, {
    providerManager: {
      async probeAll() {
        calls.probeAll += 1;
        probes += 1;
        if (probes === 1) throw Object.assign(new Error('provider probe failed'), { code: 'PROVIDER_PROBE_FAILED' });
      },
    },
  });
  await assert.rejects(runtime.start(), { code: 'PROVIDER_PROBE_FAILED' });
  assert.equal(calls.schedulerStop, 1);
  assert.equal(calls.runnerStopAll, 1);
  assert.equal(calls.displayClose, 1);
  assert.equal(calls.databaseClose, 0);
  assert.equal(runtime.publicServer.listening, false);
  assert.equal(runtime.workerServer.listening, false);

  await runtime.start();
  assert.equal(calls.probeAll, 2);
  assert.equal(calls.schedulerStart, 1);
  await runtime.stop();
  assert.equal(calls.databaseClose, 1);
});

test('failed startup cleanup quarantines the runtime until stop retries cleanup', async (t) => {
  let probes = 0;
  let stopAttempts = 0;
  const { runtime, calls } = await fixture(t, {
    providerManager: {
      async probeAll() {
        probes += 1;
        throw Object.assign(new Error('provider probe failed'), { code: 'PROVIDER_PROBE_FAILED' });
      },
    },
    runner: {
      async stopAll() {
        stopAttempts += 1;
        if (stopAttempts === 1) {
          throw Object.assign(new Error('worker cleanup failed'), { code: 'WORKER_STOP_FAILED' });
        }
      },
    },
  });

  await assert.rejects(runtime.start(), (error) => {
    assert.equal(error.code, 'RUNTIME_START_ROLLBACK_FAILED');
    assert.equal(error.retryable, false);
    assert.equal(error.cause.code, 'PROVIDER_PROBE_FAILED');
    assert.deepEqual(error.details, {
      startupCode: 'PROVIDER_PROBE_FAILED',
      failedSteps: ['workers'],
    });
    assert.equal(error.errors.length, 2);
    return true;
  });
  await assert.rejects(runtime.start(), { code: 'RUNTIME_CLEANUP_REQUIRED' });
  assert.equal(probes, 1, 'quarantined startup must not probe or reopen services');
  assert.equal(runtime.publicServer.listening, false);
  assert.equal(runtime.workerServer.listening, false);
  assert.deepEqual(calls.errors.map(({ data }) => data.step), ['workers']);

  await runtime.stop();
  assert.equal(stopAttempts, 2, 'stop must retry the failed worker cleanup');
  assert.equal(calls.databaseClose, 1);
});

test('shutdown closes active HTTP connections instead of waiting for header timeout', async (t) => {
  const { runtime } = await fixture(t);
  await runtime.start();
  const port = runtime.publicServer.address().port;
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');

  const stopping = runtime.stop();
  const outcome = await Promise.race([
    stopping.then(() => 'stopped'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 200)),
  ]);
  if (outcome !== 'stopped') socket.destroy();
  await stopping;
  assert.equal(outcome, 'stopped');
});

test('shutdown closes public admission before draining workers and keeps worker control alive', async (t) => {
  const schedulerStop = Promise.withResolvers();
  const schedulerEntered = Promise.withResolvers();
  const workerStop = Promise.withResolvers();
  const workerEntered = Promise.withResolvers();
  const { runtime, calls } = await fixture(t, {
    scheduler: {
      async stop() {
        calls.schedulerStop += 1;
        schedulerEntered.resolve();
        await schedulerStop.promise;
      },
    },
    runner: {
      async stopAll() {
        calls.runnerStopAll += 1;
        workerEntered.resolve();
        await workerStop.promise;
      },
    },
  });
  await runtime.start();
  const stopping = runtime.stop();
  await schedulerEntered.promise;
  assert.equal(runtime.publicServer.listening, false);
  assert.equal(runtime.workerServer.listening, true);

  schedulerStop.resolve();
  await workerEntered.promise;
  assert.equal(runtime.workerServer.listening, true);
  workerStop.resolve();
  await stopping;
  assert.equal(runtime.workerServer.listening, false);
});

test('shutdown runs every cleanup step and reports all failures', async (t) => {
  const { runtime, calls } = await fixture(t, {
    scheduler: {
      async stop() {
        calls.schedulerStop += 1;
        throw Object.assign(new Error('scheduler did not stop'), { code: 'SCHEDULER_STOP_FAILED' });
      },
    },
    runner: {
      async stopAll() {
        calls.runnerStopAll += 1;
        throw Object.assign(new Error('workers did not stop'), { code: 'WORKER_STOP_FAILED' });
      },
    },
  });
  await runtime.start();
  await assert.rejects(runtime.stop(), (error) => {
    assert.equal(error.code, 'RUNTIME_STOP_FAILED');
    assert.equal(error.errors.length, 2);
    assert.deepEqual(error.details, { failedSteps: ['scheduler', 'workers'] });
    return true;
  });
  assert.equal(calls.schedulerStop, 1);
  assert.equal(calls.runnerStopAll, 1);
  assert.equal(calls.leaseRelease, 1);
  assert.equal(calls.displayClose, 1);
  assert.equal(calls.databaseClose, 1);
  assert.equal(runtime.publicServer.listening, false);
  assert.equal(runtime.workerServer.listening, false);
  assert.deepEqual(calls.errors.map(({ data }) => data.step), ['scheduler', 'workers']);
});

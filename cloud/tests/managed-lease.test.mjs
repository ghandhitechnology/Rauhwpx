import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../src/config.mjs';
import { ManagedLeaseController } from '../src/managed-lease.mjs';

const TOKEN = `mcw_${'a'.repeat(43)}`;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function controller(handler) {
  const calls = [];
  return {
    calls,
    lease: new ManagedLeaseController({
      baseUrl: 'https://broker.example',
      runId: 'run-1',
      workerToken: TOKEN,
      fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), options });
        return handler(new URL(url), options, calls.length);
      },
    }),
  };
}

test('self-hosted runtimes leave managed lifecycle calls disabled', async () => {
  let fetched = false;
  const lease = new ManagedLeaseController({ fetchImpl: async () => { fetched = true; } });
  assert.deepEqual(await lease.beforeTurnStart(), { managed: false });
  assert.deepEqual(await lease.heartbeat(), { mustStop: false });
  assert.equal(fetched, false);
});

test('allocation starts only when a turn starts and completes at its stable boundary', async () => {
  const { lease, calls } = controller((url) => {
    if (url.pathname.endsWith('/lease')) return response({ runId: 'run-1', status: 'ready' });
    if (url.pathname.endsWith('/allocation')) return response({ run: { id: 'run-1', status: 'active' }, quota: { remainingMs: 60_000 } });
    if (url.pathname.endsWith('/complete')) return response({ run: { id: 'run-1', status: 'completed' } });
    throw new Error(`unexpected ${url.pathname}`);
  });
  assert.equal(calls.length, 0, 'provisioning time is not metered');
  await lease.beforeTurnStart();
  lease.rememberCheckpoint('boundary-1');
  await lease.complete();
  assert.deepEqual(calls.map(({ url }) => url.pathname), [
    '/v1/internal/cloud/lease',
    '/v1/internal/cloud/runs/run-1/allocation',
    '/v1/internal/cloud/runs/run-1/complete',
  ]);
  assert.deepEqual(JSON.parse(calls[2].options.body), { checkpointId: 'boundary-1' });
});

test('grace blocks new input immediately while allowing the running turn until mustStop', async () => {
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const { lease } = controller((url) => {
    if (url.pathname.endsWith('/lease')) return response({ runId: 'run-1', status: 'ready' });
    if (url.pathname.endsWith('/allocation')) return response({ quota: { remainingMs: 1 } });
    return response({
      run: { id: 'run-1', status: 'active', graceDeadlineAt: deadline },
      quota: { remainingMs: 0, grace: { active: true, remainingMs: 60_000 } },
      mustStop: false,
    });
  });
  await lease.beforeTurnStart();
  assert.deepEqual(await lease.heartbeat(), {
    run: { id: 'run-1', status: 'active', graceDeadlineAt: deadline },
    quota: { remainingMs: 0, grace: { active: true, remainingMs: 60_000 } },
    mustStop: false,
  });
  await assert.rejects(lease.assertCommandAllowed('message.queue'), { code: 'MANAGED_CLOUD_INPUT_BLOCKED' });
  await lease.assertCommandAllowed('wait.resolve');
  assert.equal(lease.mustStop, false);
});

test('three broker failures fail closed and tell the worker to stop', async () => {
  const { lease } = controller((url) => {
    if (url.pathname.endsWith('/lease')) return response({ runId: 'run-1', status: 'ready' });
    if (url.pathname.endsWith('/allocation')) return response({ quota: { remainingMs: 60_000 } });
    throw new Error('offline');
  });
  await lease.beforeTurnStart();
  await assert.rejects(lease.heartbeat(), { code: 'MANAGED_BROKER_UNREACHABLE' });
  await assert.rejects(lease.heartbeat(), { code: 'MANAGED_BROKER_UNREACHABLE' });
  assert.deepEqual(await lease.heartbeat(), { mustStop: true, degraded: true });
  await assert.rejects(lease.assertCommandAllowed('session.resume'), { code: 'MANAGED_CLOUD_INPUT_BLOCKED' });
});

test('one managed runtime can meter two turns independently on the same lease', async () => {
  let status = 'ready';
  let allocations = 0;
  const { lease, calls } = controller((url) => {
    if (url.pathname.endsWith('/lease')) return response({ runId: 'run-1', status });
    if (url.pathname.endsWith('/allocation')) {
      status = 'active';
      allocations += 1;
      return response({ run: { id: 'run-1', status }, quota: { remainingMs: 60_000 } });
    }
    if (url.pathname.endsWith('/complete')) {
      status = 'ready';
      return response({ run: { id: 'run-1', status }, worker: { status: 'warm' }, quota: { remainingMs: 60_000 } });
    }
    throw new Error(`unexpected ${url.pathname}`);
  });
  await lease.beforeTurnStart();
  await lease.complete('boundary-1');
  await lease.beforeTurnStart();
  await lease.complete('boundary-2');
  assert.equal(allocations, 2);
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith('/allocation')).length, 2);
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith('/complete')).length, 2);
});

test('turn completion cannot reopen input after the normal allowance is exhausted', async () => {
  let stage = 'ready';
  const { lease } = controller((url) => {
    if (url.pathname.endsWith('/lease')) return response({ runId: 'run-1', status: stage });
    if (url.pathname.endsWith('/allocation')) {
      stage = 'active';
      return response({ run: { id: 'run-1', status: 'active' }, quota: { remainingMs: 1 } });
    }
    if (url.pathname.endsWith('/heartbeat')) {
      return response({ run: { id: 'run-1', status: 'active' }, quota: { remainingMs: 0, grace: { active: true } } });
    }
    if (url.pathname.endsWith('/complete')) {
      stage = 'ready';
      return response({ run: { id: 'run-1', status: 'ready' }, worker: { status: 'warm' }, quota: { remainingMs: 0 } });
    }
    throw new Error(`unexpected ${url.pathname}`);
  });
  await lease.beforeTurnStart();
  await lease.heartbeat();
  await lease.complete('boundary-1');
  await assert.rejects(lease.beforeTurnStart(), { code: 'MANAGED_CLOUD_INPUT_BLOCKED' });
});

test('warm workers discover and activate a newly assigned run', async () => {
  let currentRun = 'run-1';
  const { lease, calls } = controller((url) => {
    if (url.pathname.endsWith('/lease')) return response({ runId: currentRun, status: 'ready' });
    if (url.pathname.endsWith('/allocation')) return response({ run: { id: currentRun, status: 'active' }, quota: { remainingMs: 60_000 } });
    if (url.pathname.endsWith('/complete')) return response({ run: { id: currentRun, status: 'completed' } });
    throw new Error(`unexpected ${url.pathname}`);
  });
  await lease.beforeTurnStart();
  await lease.complete('boundary-1');
  currentRun = 'run-2';
  await lease.beforeTurnStart();
  assert.equal(lease.runId, 'run-2');
  assert.ok(calls.some(({ url }) => url.pathname.endsWith('/runs/run-2/allocation')));
});

test('managed lease configuration is all-or-nothing and self-hosted remains empty', () => {
  const selfHosted = parseConfig({ RAUHWpx_RUNNER: 'podman' });
  assert.equal(selfHosted.managedBrokerUrl, '');
  assert.throws(() => parseConfig({ RAUHWpx_MANAGED_BROKER_URL: 'https://broker.example' }), { code: 'CONFIG_INVALID' });
  const managed = parseConfig({
    RAUHWpx_RUNNER: 'podman',
    RAUHWpx_MANAGED_BROKER_URL: 'https://broker.example/',
    RAUHWpx_MANAGED_RUN_ID: 'run-1',
    RAUHWpx_MANAGED_WORKER_TOKEN: TOKEN,
  });
  assert.equal(managed.managedBrokerUrl, 'https://broker.example');
});

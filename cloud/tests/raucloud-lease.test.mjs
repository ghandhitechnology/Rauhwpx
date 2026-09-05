import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../src/config.mjs';
import { RaucloudLeaseController } from '../src/raucloud-lease.mjs';

const TOKEN = `mcw_${'a'.repeat(43)}`;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function controller(handler, options = {}) {
  const calls = [];
  return {
    calls,
    lease: new RaucloudLeaseController({
      ...options,
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

test('self-hosted runtimes leave Raucloud lifecycle calls disabled', async () => {
  let fetched = false;
  const lease = new RaucloudLeaseController({ fetchImpl: async () => { fetched = true; } });
  assert.deepEqual(await lease.beforeTurnStart(), { raucloud: false });
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
  await assert.rejects(lease.assertCommandAllowed('message.queue'), { code: 'RAUCLOUD_INPUT_BLOCKED' });
  await lease.assertCommandAllowed('wait.resolve');
  assert.equal(lease.mustStop, false);
});

test('brief broker outages preserve the worker, but the bounded grace expires', async () => {
  let now = 0;
  const { lease } = controller((url) => {
    if (url.pathname.endsWith('/lease')) return response({ runId: 'run-1', status: 'ready' });
    if (url.pathname.endsWith('/allocation')) return response({ quota: { remainingMs: 60_000 } });
    throw new Error('offline');
  }, { now: () => now });
  await lease.beforeTurnStart();
  for (let index = 0; index < 4; index++) {
    assert.deepEqual(await lease.heartbeat(), { mustStop: false, degraded: true });
    now += 15_000;
  }
  now = 90_000;
  assert.deepEqual(lease.status(), { mustStop: true, degraded: true });
  await assert.rejects(lease.assertCommandAllowed('session.resume'), { code: 'RAUCLOUD_INPUT_BLOCKED' });
});

test('one Raucloud runtime can meter two turns independently on the same lease', async () => {
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
  await assert.rejects(lease.beforeTurnStart(), { code: 'RAUCLOUD_INPUT_BLOCKED' });
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

test('Raucloud lease configuration is all-or-nothing and self-hosted remains empty', () => {
  const selfHosted = parseConfig({ RAUHWpx_RUNNER: 'podman' });
  assert.equal(selfHosted.raucloudBrokerUrl, '');
  assert.throws(() => parseConfig({ RAUHWpx_RAUCLOUD_BROKER_URL: 'https://broker.example' }), { code: 'CONFIG_INVALID' });
  const raucloud = parseConfig({
    RAUHWpx_RUNNER: 'podman',
    RAUHWpx_RAUCLOUD_BROKER_URL: 'https://broker.example/',
    RAUHWpx_RAUCLOUD_RUN_ID: 'run-1',
    RAUHWpx_RAUCLOUD_WORKER_TOKEN: TOKEN,
  });
  assert.equal(raucloud.raucloudBrokerUrl, 'https://broker.example');

  const legacy = parseConfig({
    RAUHWpx_RUNNER: 'podman',
    RAUHWpx_MANAGED_BROKER_URL: 'https://legacy-broker.example/', // raucloud-legacy: deployed worker fixture.
    RAUHWpx_MANAGED_RUN_ID: 'run-legacy', // raucloud-legacy: deployed worker fixture.
    RAUHWpx_MANAGED_WORKER_TOKEN: TOKEN, // raucloud-legacy: deployed worker fixture.
  });
  assert.equal(legacy.raucloudBrokerUrl, 'https://legacy-broker.example');
  assert.equal(legacy.raucloudRunId, 'run-legacy');
});

test('editing activity is coalesced into one warm renewal per local heartbeat', async () => {
  let now = 0;
  const { lease, calls } = controller((url) => {
    if (url.pathname.endsWith('/lease')) return response({ runId: 'run-1', status: 'ready' });
    if (url.pathname.endsWith('/allocation')) return response({ run: { status: 'active' } });
    if (url.pathname.endsWith('/complete') || url.pathname.endsWith('/activity')) return response({ run: { status: 'ready' }, worker: { status: 'warm' } });
    assert.fail(url.pathname);
  }, { now: () => now });
  await lease.beforeTurnStart();
  await lease.complete('checkpoint-1');
  for (let index = 0; index < 100; index++) { now++; lease.noteActivity(); }
  await lease.heartbeat();
  await lease.heartbeat();
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith('/activity')).length, 1);
  now++;
  lease.noteActivity();
  await lease.heartbeat();
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith('/activity')).length, 2);
  assert.equal(lease.mustStop, false);
});

test('turn completion survives a broker outage and a local controller restart', async () => {
  let saved = null;
  let offline = true;
  const reportStore = { load: () => saved, save: (value) => { saved = structuredClone(value); }, clear: () => { saved = null; } };
  const handler = (url) => {
    if (url.pathname.endsWith('/lease')) return response({ runId: 'run-1', status: 'ready' });
    if (url.pathname.endsWith('/allocation')) return response({ run: { status: 'active' } });
    if (url.pathname.endsWith('/complete')) {
      if (offline) throw new Error('broker offline');
      return response({ run: { status: 'ready' }, worker: { status: 'warm' } });
    }
    assert.fail(url.pathname);
  };
  const first = controller(handler, { reportStore }).lease;
  await first.beforeTurnStart();
  assert.deepEqual(await first.complete('durable-checkpoint'), { pending: true, degraded: true });
  assert.deepEqual(saved, { runId: 'run-1', checkpointId: 'durable-checkpoint' });
  const restarted = controller(handler, { reportStore });
  offline = false;
  await restarted.lease.heartbeat();
  assert.equal(saved, null);
  assert.equal(restarted.lease.active, false);
  assert.equal(restarted.lease.mustStop, false);
  assert.equal(restarted.calls.length, 1);
});

test('explicit broker revocation stops immediately without waiting for outage grace', async () => {
  const { lease } = controller((url) => {
    if (url.pathname.endsWith('/lease')) return response({ runId: 'run-1', status: 'ready' });
    if (url.pathname.endsWith('/allocation')) return response({ run: { status: 'active' } });
    return response({ error: { code: 'WORKER_UNAUTHORIZED', message: 'revoked' } }, 403);
  });
  await lease.beforeTurnStart();
  assert.equal((await lease.heartbeat()).mustStop, true);
});

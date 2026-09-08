import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

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
  now = 10 * 60_000;
  assert.deepEqual(lease.status(), { mustStop: true, degraded: true });
  await assert.rejects(lease.assertCommandAllowed('session.resume'), { code: 'RAUCLOUD_INPUT_BLOCKED' });
});

test('the last metered allowance stops offline work before the broker outage grace ends', async () => {
  let now = 0;
  let offline = false;
  const { lease } = controller((url) => {
    if (offline) throw new Error('offline');
    if (url.pathname.endsWith('/lease')) return response({ runId: 'run-1', status: 'ready' });
    return response({ run: { status: 'active' }, quota: { remainingMs: 1_000,
      grace: { active: false, remainingMs: 2_000 } } });
  }, { now: () => now });
  await lease.beforeTurnStart();
  offline = true;
  assert.equal((await lease.heartbeat()).mustStop, false);
  now = 2_999;
  assert.equal(lease.status().mustStop, false);
  now = 3_000;
  assert.equal(lease.status().mustStop, true);
});

test('a broker outage longer than the old ninety-second grace recovers without stopping accepted work', async () => {
  let now = 0;
  let offline = false;
  const { lease } = controller((url) => {
    if (offline) throw new Error('offline');
    if (url.pathname.endsWith('/lease')) return response({ runId: 'run-1', status: 'ready' });
    return response({ run: { status: 'active' }, quota: { remainingMs: 3_600_000,
      grace: { active: false, remainingMs: 1_800_000 } } });
  }, { now: () => now });
  await lease.beforeTurnStart();
  offline = true;
  await lease.heartbeat();
  now = 5 * 60_000;
  assert.equal((await lease.heartbeat()).mustStop, false);
  offline = false;
  await lease.heartbeat();
  assert.deepEqual(lease.status(), { mustStop: false, degraded: false });
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

test('merge uploads stream canonical chunks and require the final durable receipt', async () => {
  const chunkBytes = 512 * 1024;
  const bytes = Buffer.alloc(chunkBytes * 2 + 17, 7);
  const metadata = { sessionId: 'session-1', documentId: 'document-1', threadId: 'thread-1',
    cloudStartId: 'start-1', operationId: 'turn-1', revision: 3, turn: 1, kind: 'turn',
    fileName: '문서.hwpx', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  let yielded = 0;
  const { lease, calls } = controller((url, options) => {
    assert.equal(url.pathname, '/v1/internal/cloud/runs/run-1/merge-requests');
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
    const body = JSON.parse(options.body);
    const offset = body.chunkIndex * chunkBytes;
    assert.equal(body.chunkCount, 3);
    assert.deepEqual(Buffer.from(body.bytesBase64, 'base64'), bytes.subarray(offset, offset + chunkBytes));
    // A slow broker must hold back reads, rather than buffer the whole file.
    if (body.chunkIndex === 0) assert.ok(yielded <= 10);
    return response({ complete: body.chunkIndex === 2, mergeRequest: { id: 'merge-1', ...metadata } });
  });
  const stream = Readable.from((async function* () {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      yielded++;
      yield bytes.subarray(offset, offset + 64 * 1024);
    }
  })(), { highWaterMark: 1 });
  const result = await lease.archiveMergeRequest(metadata, stream);
  assert.equal(result.complete, true);
  assert.equal(calls.length, 3);
});

test('merge uploads retry immutable chunks after a lost response without interrupting the turn', async () => {
  const bytes = Buffer.from('durable document');
  const metadata = { operationId: 'turn-retry', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const { lease, calls } = controller((_url, _options, attempt) => {
    if (attempt === 1) throw new Error('response lost after durable write');
    return response({ complete: true, mergeRequest: { id: 'merge-retry', ...metadata } });
  });
  assert.equal((await lease.archiveMergeRequest(metadata, Readable.from([bytes]))).mergeRequest.id, 'merge-retry');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body, calls[1].options.body);
});

test('merge upload rejects damaged bytes and incomplete broker receipts', async () => {
  const bytes = Buffer.from('document');
  const metadata = { operationId: 'turn-check', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const { lease, calls } = controller(() => response({ complete: false }));
  await assert.rejects(lease.archiveMergeRequest(metadata, Readable.from([Buffer.from('damaged!')])), { code: 'RAUCLOUD_ARTIFACT_INVALID' });
  assert.equal(calls.length, 0, 'invalid final bytes must never publish');
  await assert.rejects(lease.archiveMergeRequest(metadata, Readable.from([bytes])), { code: 'RAUCLOUD_ARTIFACT_UNCONFIRMED' });
});

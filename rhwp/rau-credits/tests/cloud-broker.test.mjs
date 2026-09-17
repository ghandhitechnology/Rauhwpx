import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import test from 'node:test';
import { createRaucloudBroker, CLOUD_ALLOCATION_LEASE_MS, CLOUD_WARM_IDLE_MS, CLOUD_FINAL_CHECKPOINT_MS,
  CLOUD_DAILY_LIMIT_MS, CLOUD_GRACE_LIMIT_MS, CLOUD_COLD_START_WINDOW_LIMIT } from '../cloud-broker.mjs';

function fixture({ provisioner = null, at = Date.parse('2026-09-05T23:59:30Z'), raucloud = null } = {}) {
  let state = { users: { 'account-1': { id: 'account-1', email: 'user@example.com' } } };
  if (raucloud) state.raucloud = structuredClone(raucloud);
  let chain = Promise.resolve();
  let clock = at;
  const mutate = (operation) => {
    const result = chain.then(async () => {
      const candidate = structuredClone(state);
      const value = await operation(candidate);
      state = candidate;
      return value;
    });
    chain = result.catch(() => {});
    return result;
  };
  const broker = createRaucloudBroker({
    store: { load: async () => structuredClone(state) }, mutate,
    authenticateAccessToken: async () => 'account-1',
    workerSecret: 'worker-secret', provisioner, now: () => clock,
  });
  return {
    broker, advance: (ms) => { clock += ms; }, snapshot: () => structuredClone(state),
    create: (key = 'create-1') => broker.createCloudRun('access-token', {
      deviceId: 'device-1', timezone: 'UTC', idempotencyKey: key,
    }),
    status: (runId) => broker.getCloudStatus('access-token', { deviceId: 'device-1', runId }),
    waitFor: async (predicate) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const snapshot = structuredClone(state);
        if (predicate(snapshot)) return snapshot;
        await nextTick();
      }
      assert.fail('Broker operation did not settle');
    },
  };
}

for (const reconciliation of ['status', 'metering']) {
  test(`${reconciliation} charges a midnight-crossing turn to the correct quota windows`, async () => {
    const setup = fixture();
    const created = await setup.create();
    await setup.broker.confirmCloudAllocation('worker-secret', created.run.id);
    setup.advance(40_000);
    if (reconciliation === 'status') await setup.status(created.run.id);
    else await setup.broker.reconcileCloudUsage();
    const result = await setup.broker.heartbeatCloudRun('worker-secret', created.run.id);
    assert.equal(result.quota.usedMs, 10_000);
    assert.equal(result.quota.remainingMs, 60 * 60 * 1000 - 10_000);
    assert.equal(setup.snapshot().raucloud.runs[created.run.id].lastAccountedAt, Date.parse('2026-09-06T00:00:10Z'));
  });
}

test('provisioning and warm idle are unbilled, and repeated allocation requests count one cold start', async () => {
  const setup = fixture({ at: Date.parse('2026-09-05T10:00:00Z') });
  const created = await setup.create();
  setup.advance(120_000);
  const retried = await setup.create();
  assert.equal(retried.run.id, created.run.id);
  assert.equal(retried.quota.usedMs, 0);
  await setup.broker.confirmCloudAllocation('worker-secret', created.run.id);
  setup.advance(60_000);
  const finished = await setup.broker.completeCloudRun('worker-secret', created.run.id, { checkpointId: 'checkpoint-1' });
  assert.equal(finished.quota.usedMs, 60_000);
  assert.equal(finished.quota.coldStarts.usedToday, 1);
  assert.equal(finished.worker.status, 'warm');
  setup.advance(CLOUD_WARM_IDLE_MS + 1);
  await setup.broker.reconcileCloudUsage();
  const idle = await setup.status(created.run.id);
  assert.equal(idle.quota.usedMs, 60_000);
  assert.equal(idle.worker, null);
});

const REMOTE = { providerId: 'railway', serviceId: 'service-1', projectId: 'project-1', environmentId: 'environment-1' };
const RECEIPT = { endpoint: 'https://worker.up.railway.app/rauhwpx-cloud', serverPublicKey: `ed25519:${'A'.repeat(43)}`, pairingCode: 'ABCD-EFGH-JKLM' };

for (const finish of [true, false]) {
  test(`quota fuse allows one bounded final checkpoint window${finish ? ' and tears down after its receipt' : ' before forced cleanup'}`, async () => {
    const deleted = [];
    const setup = fixture({ at: Date.parse('2026-09-05T10:00:00Z'), provisioner: {
      provision: async () => ({ remote: REMOTE, receipt: RECEIPT }),
      teardown: async (remote) => { deleted.push(remote.serviceId); },
    } });
    const created = await setup.create();
    await setup.waitFor((state) => state.raucloud.accounts['account-1'].worker?.status === 'ready');
    await setup.broker.confirmCloudAllocation('worker-secret', created.run.id);
    setup.advance(CLOUD_DAILY_LIMIT_MS + CLOUD_GRACE_LIMIT_MS);
    const stop = await setup.broker.heartbeatCloudRun('worker-secret', created.run.id);
    assert.equal(stop.mustStop, true);
    assert.equal(stop.run.status, 'checkpointing');
    assert.equal(stop.run.inputBlocked, true);
    assert.deepEqual(deleted, []);
    await assert.rejects(setup.broker.confirmCloudAllocation('worker-secret', created.run.id), { code: 'CLOUD_RUN_STATE_INVALID' });
    if (finish) {
      const completed = await setup.broker.completeCloudRun('worker-secret', created.run.id, { checkpointId: 'final-boundary' });
      assert.equal(completed.run.status, 'completed');
    } else {
      setup.advance(CLOUD_FINAL_CHECKPOINT_MS - 1);
      await setup.broker.reconcileCloudUsage();
      assert.deepEqual(deleted, []);
      setup.advance(1);
      await setup.broker.reconcileCloudUsage();
    }
    assert.deepEqual(deleted, ['service-1']);
    assert.equal((await setup.status(created.run.id)).quota.usedMs, CLOUD_DAILY_LIMIT_MS);
  });
}

for (const workerStatus of ['ready', 'warm']) {
  for (const renew of [false, true]) {
    test(`${workerStatus} worker expires after two unbilled idle hours${renew ? ' from workspace activity' : ''}`, async () => {
      const at = Date.parse('2026-09-05T10:00:00Z');
      const deleted = [];
      const setup = fixture({ at, provisioner: {
        provision: async () => ({ remote: REMOTE, receipt: RECEIPT }),
        teardown: async (remote) => { deleted.push(remote.serviceId); return { removed: true }; },
      } });
      const created = await setup.create();
      await setup.waitFor((state) => state.raucloud.accounts['account-1'].worker?.status === 'ready');
      if (workerStatus === 'warm') {
        await setup.broker.confirmCloudAllocation('worker-secret', created.run.id);
        await setup.broker.completeCloudRun('worker-secret', created.run.id);
      }
      assert.equal((await setup.status(created.run.id)).worker.warmUntil, at + CLOUD_WARM_IDLE_MS);

      if (renew) {
        setup.advance(10 * 60_000);
        const touched = await setup.broker.touchCloudWorkspace('worker-secret', created.run.id);
        assert.equal(touched.worker.warmUntil, at + 10 * 60_000 + CLOUD_WARM_IDLE_MS);
      }
      setup.advance(CLOUD_WARM_IDLE_MS - 1);
      await setup.broker.reconcileCloudUsage();
      const retained = await setup.status(created.run.id);
      assert.equal(retained.worker.status, workerStatus);
      assert.equal(retained.quota.usedMs, 0);
      assert.deepEqual(deleted, []);

      setup.advance(1);
      await setup.broker.reconcileCloudUsage();
      const expired = await setup.status(created.run.id);
      assert.equal(expired.worker, null);
      assert.equal(expired.quota.usedMs, 0);
      assert.deepEqual(deleted, ['service-1']);
    });
  }
}

for (const cancellation of ['force-quit', 'allocation-expired']) {
  test(`${cancellation} stops a late remote callback before further provisioning`, async () => {
    const createdRemote = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let continued = false;
    const deleted = [];
    const setup = fixture({ provisioner: {
      provision: async ({ onRemoteCreated }) => {
        entered.resolve();
        await createdRemote.promise;
        await onRemoteCreated(REMOTE);
        continued = true;
        return { remote: REMOTE, receipt: RECEIPT };
      },
      teardown: async (remote) => { deleted.push(remote.serviceId); return { removed: true }; },
    } });
    const created = await setup.create();
    await entered.promise;
    if (cancellation === 'force-quit') {
      await setup.broker.forceQuitAccountCloud('access-token', { deviceId: 'device-1' });
    } else setup.advance(CLOUD_ALLOCATION_LEASE_MS + 1);
    createdRemote.resolve();
    const state = await setup.waitFor((value) => value.raucloud.runs[created.run.id].remoteDeletedAt != null);
    assert.equal(continued, false);
    assert.equal(state.raucloud.accounts['account-1'].worker, null);
    assert.equal(state.raucloud.runs[created.run.id].status, cancellation === 'force-quit' ? 'stopped' : 'failed');
    assert.deepEqual(deleted, ['service-1']);
    assert.equal(state.raucloud.accounts['account-1'].quota.window.normalUsedMs, 0);
  });
}

test('a receipt arriving after the allocation lease expires is cleaned up instead of becoming ready', async () => {
  const finish = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const deleted = [];
  const setup = fixture({ provisioner: {
    provision: async ({ onRemoteCreated }) => {
      await onRemoteCreated(REMOTE);
      entered.resolve();
      await finish.promise;
      return { remote: REMOTE, receipt: RECEIPT };
    },
    teardown: async (remote) => { deleted.push(remote.serviceId); return { removed: true }; },
  } });
  const created = await setup.create();
  await entered.promise;
  setup.advance(CLOUD_ALLOCATION_LEASE_MS + 1);
  finish.resolve();
  const state = await setup.waitFor((value) => value.raucloud.runs[created.run.id].remoteDeletedAt != null);
  assert.equal(state.raucloud.runs[created.run.id].status, 'failed');
  assert.equal(state.raucloud.runs[created.run.id].failureCode, 'ALLOCATION_LEASE_EXPIRED');
  assert.equal(state.raucloud.accounts['account-1'].worker, null);
  assert.deepEqual(deleted, ['service-1']);
});

test('orphan scan retains an allocation created after its initial state snapshot', async () => {
  let inspect;
  let release;
  const entered = new Promise((resolve) => { inspect = resolve; });
  const continueScan = new Promise((resolve) => { release = resolve; });
  let guard;
  const setup = fixture({ provisioner: {
    serviceName: ({ runId }) => `rauhwpx-raucloud-${runId}`,
    provision: async () => ({ remote: REMOTE, receipt: RECEIPT }),
    teardown: async () => {},
    reconcileRaucloud: async (options) => {
      assert.deepEqual(options.keepServiceNames, []);
      guard = options.shouldKeepService;
      inspect();
      await continueScan;
      return { found: 0, removed: 0 };
    },
  } });
  const reconcile = setup.broker.reconcileCloudUsage();
  await entered;
  try {
    const created = await setup.create();
    assert.equal(await guard({ name: `rauhwpx-raucloud-${created.run.id}` }), true);
    assert.equal(await guard({ name: 'rauhwpx-raucloud-orphan' }), false);
  } finally {
    release();
    await reconcile;
  }
});

const PREWARM_REMOTE = {
  providerId: 'railway', serviceId: 'service-warm', projectId: 'project-1', environmentId: 'environment-1',
  domain: 'worker.up.railway.app', bootstrapToken: 'bootstrap-token',
};
const PREWARM_RECEIPT = {
  endpoint: 'https://worker.up.railway.app/rauhwpx-cloud',
  serverPublicKey: `ed25519:${'B'.repeat(43)}`,
  pairingCode: 'WARM-WARM-WARM',
};

function warmFixture({ at = Date.parse('2026-09-05T10:00:00Z'), provisioner = null, raucloud = null } = {}) {
  const deleted = [];
  const refreshed = [];
  const setup = fixture({
    at,
    raucloud: raucloud ?? { accounts: { 'account-1': { usedCloudAt: at - 24 * 60 * 60 * 1000 } } },
    provisioner: provisioner ?? {
      provision: async () => ({ remote: PREWARM_REMOTE, receipt: PREWARM_RECEIPT }),
      receipt: async (remote, options) => {
        refreshed.push({ remote, options });
        return { ...PREWARM_RECEIPT, pairingCode: 'BCDF-GHJK-LMNP' };
      },
      teardown: async (remote) => { deleted.push(remote.serviceId); return { removed: true }; },
    },
  });
  return {
    ...setup,
    deleted,
    refreshed,
    prewarm: () => setup.broker.prewarmCloudWorker('access-token', { deviceId: 'device-1', timezone: 'UTC' }),
    readyWorker: () => setup.waitFor((state) => state.raucloud.accounts['account-1'].worker?.status === 'ready'),
  };
}

test('a prewarmed worker stays idle, unbilled, and invisible until a run claims it', async () => {
  const setup = warmFixture();
  const reserved = await setup.prewarm();
  await setup.readyWorker();
  assert.equal(reserved.prewarm, true);
  const status = await setup.broker.getCloudStatus('access-token', { deviceId: 'device-1' });
  assert.equal(status.activeRun, null);
  assert.equal(status.worker.prewarm, true);
  assert.equal(status.gate.state, 'ready');
  assert.equal(status.gate.canStart, true);
  assert.equal(status.quota.usedMs, 0);
  assert.equal(status.quota.coldStarts.usedToday, 1);
  const other = await setup.broker.getCloudStatus('access-token', { deviceId: 'device-2' });
  assert.equal(other.gate.state, 'ready');
  assert.equal(other.gate.canStart, true);
});

test('the first run claims the reservation instead of paying for another cold start', async () => {
  const setup = warmFixture();
  const reserved = await setup.prewarm();
  await setup.readyWorker();
  setup.advance(30 * 60_000);
  const claimed = await setup.create();
  assert.equal(claimed.run.id, reserved.run.id);
  assert.equal(claimed.run.status, 'ready');
  assert.equal(claimed.run.prewarm, false);
  assert.equal(claimed.run.reused, true);
  assert.equal(claimed.coldStart, false);
  assert.equal(claimed.quota.usedMs, 0);
  assert.equal(claimed.quota.coldStarts.usedToday, 1);
  assert.equal(claimed.run.receipt.pairingCode, PREWARM_RECEIPT.pairingCode);
  assert.equal(setup.snapshot().raucloud.accounts['account-1'].worker.prewarm, undefined);
});

test('repeated prewarm calls renew one reservation without another cold start', async () => {
  const setup = warmFixture();
  await setup.prewarm();
  await setup.readyWorker();
  setup.advance(CLOUD_WARM_IDLE_MS - 1);
  const renewed = await setup.prewarm();
  assert.equal(renewed.prewarm, true);
  assert.equal(renewed.quota.coldStarts.usedToday, 1);
  setup.advance(CLOUD_WARM_IDLE_MS - 1);
  await setup.broker.reconcileCloudUsage();
  assert.deepEqual(setup.deleted, []);
  assert.equal(setup.snapshot().raucloud.accounts['account-1'].worker.status, 'ready');
});

test('an unclaimed reservation expires with the warm idle window', async () => {
  const setup = warmFixture();
  await setup.prewarm();
  await setup.readyWorker();
  setup.advance(CLOUD_WARM_IDLE_MS + 1);
  await setup.broker.reconcileCloudUsage();
  assert.deepEqual(setup.deleted, ['service-warm']);
  assert.equal(setup.snapshot().raucloud.accounts['account-1'].worker, null);
});

test('an unclaimed reservation still counts against the cold start limit', async () => {
  const setup = warmFixture();
  for (let attempt = 0; attempt < CLOUD_COLD_START_WINDOW_LIMIT; attempt += 1) {
    const reserved = await setup.prewarm();
    await setup.readyWorker();
    await setup.broker.stopCloudRun('access-token', reserved.run.id, { deviceId: 'device-1', reason: 'test' });
  }
  await assert.rejects(setup.prewarm(), { code: 'CLOUD_COLD_START_RATE_LIMITED' });
});

test('stopping a reservation cancels the worker it holds', async () => {
  const setup = warmFixture();
  const reserved = await setup.prewarm();
  await setup.readyWorker();
  const stopped = await setup.broker.stopCloudRun('access-token', reserved.run.id, {
    deviceId: 'device-1', reason: 'user',
  });
  assert.equal(stopped.run.status, 'stopped');
  await setup.broker.reconcileCloudUsage();
  assert.deepEqual(setup.deleted, ['service-warm']);
});

test('a claimed run reissues a fresh pairing receipt for its own device only', async () => {
  const setup = warmFixture();
  const reserved = await setup.prewarm();
  await setup.readyWorker();
  const claimed = await setup.create();
  const refreshed = await setup.broker.refreshCloudRunReceipt('access-token', claimed.run.id, {
    deviceId: 'device-1', deviceName: 'Laptop',
  });
  assert.equal(refreshed.receipt.pairingCode, 'BCDF-GHJK-LMNP');
  assert.equal(setup.refreshed[0].remote.bootstrapToken, 'bootstrap-token');
  assert.equal(setup.refreshed[0].options.serverPublicKey, PREWARM_RECEIPT.serverPublicKey);
  assert.equal((await setup.status(claimed.run.id)).run.receipt.pairingCode, 'BCDF-GHJK-LMNP');
  await assert.rejects(
    setup.broker.refreshCloudRunReceipt('access-token', claimed.run.id, { deviceId: 'device-2' }),
    { code: 'CLOUD_OWNED_ELSEWHERE' },
  );
});

test('an active run keeps a reservation request from provisioning a second worker', async () => {
  let spawned = 0;
  const setup = warmFixture({ provisioner: {
    provision: async () => { spawned += 1; return { remote: PREWARM_REMOTE, receipt: PREWARM_RECEIPT }; },
    teardown: async () => ({ removed: true }),
  } });
  const created = await setup.create();
  await setup.readyWorker();
  const result = await setup.prewarm();
  assert.equal(result.prewarm, false);
  assert.equal(result.activeRun.id, created.run.id);
  assert.equal(spawned, 1);
});

test('prewarm funds an idle worker only after the account has run a turn', async () => {
  let spawned = 0;
  const setup = warmFixture({
    raucloud: { accounts: {} },
    provisioner: {
      provision: async () => { spawned += 1; return { remote: PREWARM_REMOTE, receipt: PREWARM_RECEIPT }; },
      teardown: async () => ({ removed: true }),
    },
  });
  const first = await setup.prewarm();
  assert.equal(first.prewarm, false);
  assert.equal(spawned, 0);
  const created = await setup.create();
  await setup.readyWorker();
  await setup.broker.confirmCloudAllocation('worker-secret', created.run.id);
  await setup.broker.completeCloudRun('worker-secret', created.run.id, { checkpointId: 'turn-1' });
  await setup.broker.stopCloudRun('access-token', created.run.id, { deviceId: 'device-1', reason: 'test' });
  assert.equal(setup.snapshot().raucloud.accounts['account-1'].worker, null);
  const warm = await setup.prewarm();
  await setup.readyWorker();
  assert.equal(warm.prewarm, true);
  assert.equal(spawned, 2);
});

import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import test from 'node:test';
import { createRaucloudBroker, CLOUD_ALLOCATION_LEASE_MS, CLOUD_WARM_IDLE_MS } from '../cloud-broker.mjs';

function fixture({ provisioner = null, at = Date.parse('2026-09-05T23:59:30Z') } = {}) {
  let state = { users: { 'account-1': { id: 'account-1', email: 'user@example.com' } } };
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

for (const workerStatus of ['ready', 'warm']) {
  for (const renew of [false, true]) {
    test(`${workerStatus} worker expires after 20 unbilled idle minutes${renew ? ' from workspace activity' : ''}`, async () => {
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
      assert.equal((await setup.status(created.run.id)).worker.warmUntil, at + 20 * 60_000);

      if (renew) {
        setup.advance(10 * 60_000);
        const touched = await setup.broker.touchCloudWorkspace('worker-secret', created.run.id);
        assert.equal(touched.worker.warmUntil, at + 30 * 60_000);
      }
      setup.advance(20 * 60_000 - 1);
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

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  CLOUD_ALLOCATION_LEASE_MS,
  CLOUD_DAILY_LIMIT_MS,
  CLOUD_GRACE_LIMIT_MS,
  CLOUD_TIMEZONE_CHANGE_MS,
} from '../cloud-broker.mjs';
import { createRailwayCloudProvisioner } from '../cloud-provisioner.mjs';
import { createCreditsService, creditsRequestListener } from '../service.mjs';
import { createMemoryStore } from '../store.mjs';

const WORKER_SECRET = 'trusted-broker-reconciler-secret';
const MINUTE = 60 * 1000;

async function eventually(read, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  } while (Date.now() < deadline);
  assert.fail(`condition did not become true; last value: ${JSON.stringify(value)}`);
}

async function fixture({ start = Date.UTC(2026, 0, 1, 10), provisioner = null } = {}) {
  let clock = start;
  const store = createMemoryStore();
  const service = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'cloud-broker-test-session-secret',
    cloudWorkerSecret: WORKER_SECRET,
    cloudProvisioner: provisioner,
    store,
    now: () => clock,
    authenticateWorkos: async () => ({ id: 'user_cloud', email: 'cloud@example.com' }),
    createOpenRouterKey: async () => ({ key: 'sk-or-v1-cloud-test', id: 'or-cloud-test' }),
  });
  const login = await service.createDeviceSession();
  await service.completeLogin('ok', login.id);
  const token = (await service.redeemDeviceSession(login.id)).accessToken;
  const secondLogin = await service.createDeviceSession();
  await service.completeLogin('ok', secondLogin.id);
  const secondToken = (await service.redeemDeviceSession(secondLogin.id)).accessToken;
  return {
    service,
    store,
    token,
    secondToken,
    now: () => clock,
    setTime: (value) => { clock = value; },
    advance: (amount) => { clock += amount; },
  };
}

test('account and status require auth, initialize timezone once, and defer a 30-day timezone change', async () => {
  const f = await fixture();
  await assert.rejects(() => f.service.getAccount('invalid'), { code: 'RAU_ACCESS_INVALID' });
  assert.equal((await f.service.getAccount(f.token)).account.timezone, null);
  assert.equal((await f.service.getCloudStatus(f.token)).gate.state, 'timezone_required');

  const initialized = await f.service.setAccountTimezone(f.token, 'UTC');
  assert.equal(initialized.account.timezone, 'UTC');
  await assert.rejects(
    () => f.service.setAccountTimezone(f.token, 'Asia/Seoul'),
    { code: 'CLOUD_TIMEZONE_CHANGE_RATE_LIMITED' },
  );

  f.advance(CLOUD_TIMEZONE_CHANGE_MS + MINUTE);
  const scheduled = await f.service.setAccountTimezone(f.token, 'Asia/Seoul');
  assert.equal(scheduled.account.timezone, 'UTC');
  assert.equal(scheduled.account.pendingTimezone, 'Asia/Seoul');
  const before = await f.service.getCloudStatus(f.token);
  f.setTime(before.quota.resetsAt + 1);
  const after = await f.service.getCloudStatus(f.token);
  assert.equal(after.account.timezone, 'Asia/Seoul');
  assert.equal(after.account.pendingTimezone, null);
  assert.equal(after.quota.usedMs, 0, 'timezone activation creates exactly one new quota window');
  assert.ok(after.quota.resetsAt - before.quota.resetsAt >= 24 * 60 * MINUTE);
});

test('run creation is idempotent and enforces one account-global worker across devices', async () => {
  const f = await fixture();
  const first = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'create-1',
  });
  assert.equal(first.coldStart, true);
  assert.equal(first.run.status, 'allocating');
  const replay = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'create-1',
  });
  assert.equal(replay.run.id, first.run.id);
  await assert.rejects(
    () => f.service.createCloudRun(f.secondToken, {
      deviceId: 'device-b', timezone: 'UTC', idempotencyKey: 'create-2',
    }),
    { code: 'CLOUD_OWNED_ELSEWHERE' },
  );
  const quit = await f.service.forceQuitAccountCloud(f.secondToken, {
    deviceId: 'device-b', reason: 'force-quit',
  });
  assert.equal(quit.worker, null);
  await f.service.createCloudRun(f.secondToken, {
    deviceId: 'device-b', timezone: 'UTC', idempotencyKey: 'create-after-force-quit',
  });
});

test('different WorkOS identities for one verified email share one Cloud account and quota', async () => {
  const store = createMemoryStore();
  const service = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'canonical-account-test-secret',
    cloudWorkerSecret: WORKER_SECRET,
    store,
    authenticateWorkos: async (code) => ({
      id: code === 'second' ? 'user_workos_b' : 'user_workos_a',
      email: 'same@example.com',
    }),
    createOpenRouterKey: async () => ({ key: 'sk-or-v1-shared-cloud', id: 'or-shared-cloud' }),
  });
  const login = async (code) => {
    const session = await service.createDeviceSession();
    await service.completeLogin(code, session.id);
    return (await service.redeemDeviceSession(session.id)).accessToken;
  };
  const tokenA = await login('first');
  const tokenB = await login('second');
  await service.createCloudRun(tokenA, { deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'canonical-a' });
  await assert.rejects(
    () => service.createCloudRun(tokenB, { deviceId: 'device-b', timezone: 'UTC', idempotencyKey: 'canonical-b' }),
    { code: 'CLOUD_OWNED_ELSEWHERE' },
  );
  assert.equal(Object.keys((await store.load()).raucloud.accounts).length, 1);
});

test('retired broker state migrates to Raucloud without losing account data', async () => {
  const f = await fixture();
  await f.service.setAccountTimezone(f.token, 'UTC');
  const state = await f.store.load();
  const legacyStateKey = 'managedCloud'; // raucloud-legacy: durable state fixture.
  state[legacyStateKey] = state.raucloud;
  delete state.raucloud;
  await f.store.save(state);

  await f.service.reconcileCloudUsage();
  const migrated = await f.store.load();
  assert.equal(migrated[legacyStateKey], undefined);
  assert.equal(migrated.raucloud.accounts.user_cloud.timezone, 'UTC');
});

test('shared transactional store preserves the one-worker invariant across service instances', async () => {
  const store = createMemoryStore();
  const makeService = () => createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'shared-transaction-test-secret',
    cloudWorkerSecret: WORKER_SECRET,
    store,
    authenticateWorkos: async () => ({ id: 'user_shared', email: 'shared@example.com' }),
    createOpenRouterKey: async () => ({ key: 'sk-or-v1-shared-transaction', id: 'or-shared-transaction' }),
  });
  const firstService = makeService();
  const secondService = makeService();
  const login = async (service) => {
    const session = await service.createDeviceSession();
    await service.completeLogin('ok', session.id);
    return (await service.redeemDeviceSession(session.id)).accessToken;
  };
  const [tokenA, tokenB] = await Promise.all([login(firstService), login(secondService)]);
  const attempts = await Promise.allSettled([
    firstService.createCloudRun(tokenA, { deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'global-a' }),
    secondService.createCloudRun(tokenB, { deviceId: 'device-b', timezone: 'UTC', idempotencyKey: 'global-b' }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  assert.equal(attempts.find((attempt) => attempt.status === 'rejected').reason.code, 'CLOUD_OWNED_ELSEWHERE');
});

test('only confirmed allocation is metered; zero denies starts and grace fuse survives midnight as debt', async () => {
  const start = Date.UTC(2026, 0, 1, 22, 40);
  const f = await fixture({ start });
  const created = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'quota-1',
  });
  f.advance(10 * MINUTE);
  await f.service.confirmCloudAllocation(WORKER_SECRET, created.run.id);
  let status = await f.service.getCloudStatus(f.token, { deviceId: 'device-a' });
  assert.equal(status.quota.usedMs, 0, 'provisioning time is free');

  f.advance(CLOUD_DAILY_LIMIT_MS);
  status = await f.service.heartbeatCloudRun(WORKER_SECRET, created.run.id);
  assert.equal(status.quota.remainingMs, 0);
  assert.equal(status.quota.grace.active, false);
  assert.equal(status.run.inputBlocked, true, 'exactly zero blocks new input immediately');
  f.advance(CLOUD_GRACE_LIMIT_MS);
  const fused = await f.service.heartbeatCloudRun(WORKER_SECRET, created.run.id);
  assert.equal(fused.mustStop, true);
  assert.equal(fused.run.status, 'stopped');
  assert.equal(fused.quota.grace.usedMs, CLOUD_GRACE_LIMIT_MS);

  const nextDay = await f.service.getCloudStatus(f.token, { deviceId: 'device-a' });
  assert.equal(nextDay.quota.debtAppliedMs, CLOUD_GRACE_LIMIT_MS);
  assert.equal(nextDay.quota.remainingMs, CLOUD_DAILY_LIMIT_MS - CLOUD_GRACE_LIMIT_MS);
  const state = await f.service.inspectCloudState(f.token);
  assert.equal(state.runs[created.run.id].graceStartedAt + CLOUD_GRACE_LIMIT_MS, state.runs[created.run.id].completedAt);
});

test('15-second grace heartbeats keep one turn debt in the window after its normal allowance', async () => {
  const f = await fixture({ start: Date.UTC(2026, 0, 1, 22, 59, 45) });
  const created = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'quota-cadence',
  });
  await f.service.confirmCloudAllocation(WORKER_SECRET, created.run.id);
  f.advance(CLOUD_DAILY_LIMIT_MS);
  await f.service.heartbeatCloudRun(WORKER_SECRET, created.run.id);

  f.advance(15_000);
  await f.service.heartbeatCloudRun(WORKER_SECRET, created.run.id);
  f.advance(15_000);
  const afterMidnight = await f.service.heartbeatCloudRun(WORKER_SECRET, created.run.id);

  assert.equal(afterMidnight.quota.debtAppliedMs, 30_000);
  assert.equal(afterMidnight.quota.grace.debtMs, 0);
  assert.equal(afterMidnight.quota.remainingMs, CLOUD_DAILY_LIMIT_MS - 30_000);
});

test('an exactly exhausted stopped account cannot start another run', async () => {
  const f = await fixture();
  const created = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'zero-1',
  });
  await f.service.confirmCloudAllocation(WORKER_SECRET, created.run.id);
  f.advance(CLOUD_DAILY_LIMIT_MS);
  await f.service.heartbeatCloudRun(WORKER_SECRET, created.run.id);
  await f.service.stopCloudRun(f.token, created.run.id, { deviceId: 'device-a' });
  await assert.rejects(
    () => f.service.createCloudRun(f.token, { deviceId: 'device-a', idempotencyKey: 'zero-2' }),
    { code: 'CLOUD_QUOTA_EXHAUSTED' },
  );
});

test('one Cloud session re-enters ready after a turn; warm idle is free and the next turn is not a cold start', async () => {
  const f = await fixture();
  const first = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'warm-1',
  });
  await f.service.confirmCloudAllocation(WORKER_SECRET, first.run.id);
  f.advance(5 * MINUTE);
  await f.service.completeCloudRun(WORKER_SECRET, first.run.id, { checkpointId: 'checkpoint-warm' });
  const beforeIdle = await f.service.getCloudStatus(f.token, { deviceId: 'device-a' });
  f.advance(4 * MINUTE);
  const afterIdle = await f.service.getCloudStatus(f.token, { deviceId: 'device-a' });
  assert.equal(afterIdle.quota.usedMs, beforeIdle.quota.usedMs);

  const reused = await f.service.confirmCloudAllocation(WORKER_SECRET, first.run.id);
  assert.equal(reused.run.status, 'active');
  assert.equal(reused.quota.coldStarts.usedToday, 1);
});

test('three confirmed cold starts in 15 minutes block a fourth but idempotent and warm starts do not count', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i += 1) {
    const run = await f.service.createCloudRun(f.token, {
      deviceId: 'device-a', timezone: 'UTC', idempotencyKey: `cold-${i}`,
    });
    await f.service.confirmCloudAllocation(WORKER_SECRET, run.run.id);
    await f.service.stopCloudRun(f.token, run.run.id, { deviceId: 'device-a' });
    f.advance(MINUTE);
  }
  const status = await f.service.getCloudStatus(f.token);
  assert.deepEqual(status.quota.coldStarts, { usedToday: 3, dailyLimit: 12, recent: 3, recentLimit: 3 });
  await assert.rejects(
    () => f.service.createCloudRun(f.token, { deviceId: 'device-a', idempotencyKey: 'cold-4' }),
    { code: 'CLOUD_COLD_START_RATE_LIMITED' },
  );
});

test('twelve confirmed cold starts in an account day block the thirteenth', async () => {
  const f = await fixture();
  for (let i = 0; i < 12; i += 1) {
    const run = await f.service.createCloudRun(f.token, {
      deviceId: 'device-a', timezone: 'UTC', idempotencyKey: `daily-cold-${i}`,
    });
    await f.service.confirmCloudAllocation(WORKER_SECRET, run.run.id);
    await f.service.stopCloudRun(f.token, run.run.id, { deviceId: 'device-a' });
    f.advance(6 * MINUTE);
  }
  const status = await f.service.getCloudStatus(f.token);
  assert.equal(status.quota.coldStarts.usedToday, 12);
  await assert.rejects(
    () => f.service.createCloudRun(f.token, { deviceId: 'device-a', idempotencyKey: 'daily-cold-13' }),
    { code: 'CLOUD_COLD_START_RATE_LIMITED' },
  );
});

test('an abandoned allocation lease expires and releases its account reservation', async () => {
  const f = await fixture();
  const run = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'abandoned-allocation',
  });
  f.advance(CLOUD_ALLOCATION_LEASE_MS);
  await f.service.reconcileCloudUsage();
  const state = await f.service.inspectCloudState(f.token);
  assert.equal(state.runs[run.run.id].status, 'failed');
  assert.equal(state.runs[run.run.id].failureCode, 'ALLOCATION_LEASE_EXPIRED');
  assert.equal(state.account.worker, null);
});

test('checkpoint release fails closed until an encrypted artifact is restorable', async () => {
  const f = await fixture();
  const source = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'take-source',
  });
  await f.service.confirmCloudAllocation(WORKER_SECRET, source.run.id);
  f.advance(MINUTE);
  await f.service.checkpointCloudRun(WORKER_SECRET, source.run.id, 'checkpoint-abc');
  const visible = await f.service.getCloudStatus(f.secondToken, { deviceId: 'device-b' });
  assert.equal(visible.gate.canTakeover, false);
  assert.equal(visible.takeoverRun.id, source.run.id);

  await assert.rejects(
    () => f.service.takeoverCloudRun(f.secondToken, source.run.id, {
      deviceId: 'device-b', checkpointId: 'checkpoint-abc', idempotencyKey: 'take-1',
    }),
    { code: 'CLOUD_TAKEOVER_ARTIFACT_UNAVAILABLE' },
  );
});

test('controlling logout blocks new input and lets only the current turn finish', async () => {
  const f = await fixture();
  const created = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'logout-1',
  });
  await f.service.confirmCloudAllocation(WORKER_SECRET, created.run.id);
  const stopping = await f.service.stopCloudRun(f.token, created.run.id, {
    deviceId: 'device-a', reason: 'logout', finishCurrentTurn: true, checkpoint: true,
  });
  assert.equal(stopping.run.status, 'active');
  assert.equal(stopping.run.inputBlocked, true);
  const state = await f.service.inspectCloudState(f.token);
  assert.equal(state.account.worker.teardownAfterTurn, true);
  const completed = await f.service.completeCloudRun(WORKER_SECRET, created.run.id, { checkpointId: 'logout-checkpoint' });
  assert.equal(completed.worker, null);
});

test('logout finish fuse stops after 30 minutes even with normal quota remaining', async () => {
  const f = await fixture();
  const created = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'logout-fuse',
  });
  await f.service.confirmCloudAllocation(WORKER_SECRET, created.run.id);
  await f.service.stopCloudRun(f.token, created.run.id, {
    deviceId: 'device-a', reason: 'logout', finishCurrentTurn: true,
  });
  f.advance(CLOUD_GRACE_LIMIT_MS);
  const reconciled = await f.service.reconcileCloudUsage();
  assert.equal(reconciled.stopped, 1);
  const state = await f.service.inspectCloudState(f.token);
  assert.equal(state.runs[created.run.id].status, 'stopped');
  assert.equal(state.runs[created.run.id].lastAccountedAt, state.runs[created.run.id].logoutRequestedAt + CLOUD_GRACE_LIMIT_MS);
});

test('production mode fails closed when the trusted provisioner is absent', async () => {
  const f = await fixture();
  const locked = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'cloud-broker-test-session-secret',
    cloudProvisionerRequired: true,
    store: f.store,
    createOpenRouterKey: async () => ({ key: 'unused', id: 'unused' }),
  });
  await assert.rejects(
    () => locked.createCloudRun(f.token, { deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'closed' }),
    { code: 'CLOUD_UNAVAILABLE' },
  );
});

test('run creation returns while slow provisioning continues and status tracks that run', async () => {
  let releaseProvision;
  const provisionGate = new Promise((resolve) => { releaseProvision = resolve; });
  const provisioner = {
    async provision(input) {
      const remote = { providerId: 'railway', serviceId: 'svc-slow', projectId: 'project', environmentId: 'environment' };
      await input.onRemoteCreated(remote);
      await provisionGate;
      return {
        remote,
        receipt: {
          endpoint: 'https://slow-worker.example/rauhwpx-cloud',
          serverPublicKey: `ed25519:${'A'.repeat(59)}`,
          pairingCode: 'ABCD-EFGH-JKLM',
        },
      };
    },
    async teardown() { return { removed: true }; },
  };
  const f = await fixture({ provisioner });
  const created = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'slow-provision',
  });

  assert.equal(created.run.status, 'allocating');
  const allocating = await f.service.getCloudStatus(f.token, {
    deviceId: 'device-a', runId: created.run.id,
  });
  assert.equal(allocating.run.status, 'allocating');

  releaseProvision();
  const ready = await eventually(
    () => f.service.getCloudStatus(f.token, { deviceId: 'device-a', runId: created.run.id }),
    (status) => status.run?.status === 'ready',
  );
  assert.equal(ready.run.receipt.pairingCode, 'ABCD-EFGH-JKLM');
});

test('injected provisioner returns a receipt, receives only a scoped worker token, and teardown is retried', async () => {
  const calls = [];
  let teardownAttempts = 0;
  let scopedToken = '';
  let reconciledKeepNames = null;
  const provisioner = {
    serviceName: ({ runId }) => `rauhwpx-raucloud-test-${runId}`,
    async reconcileRaucloud({ keepServiceNames }) {
      reconciledKeepNames = keepServiceNames;
      return { found: 0, removed: 0, failed: [] };
    },
    async provision(input) {
      scopedToken = input.workerToken;
      assert.match(scopedToken, /^mcw_[A-Za-z0-9_-]{40,}$/);
      const remote = { providerId: 'railway', serviceId: 'svc-1', projectId: 'project-1', environmentId: 'env-1' };
      await input.onRemoteCreated(remote);
      calls.push({ runId: input.runId, accountId: input.accountId });
      return {
        remote,
        receipt: {
          endpoint: 'https://worker.example/rauhwpx-cloud',
          serverPublicKey: `ed25519:${'A'.repeat(59)}`,
          pairingCode: 'ABCD-EFGH-JKLM',
        },
      };
    },
    async teardown(remote) {
      teardownAttempts += 1;
      if (teardownAttempts === 1) throw new Error('temporary delete failure');
      assert.equal(remote.serviceId, 'svc-1');
      return { removed: true };
    },
  };
  const f = await fixture({ provisioner });
  const created = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'provision-1',
  });
  assert.equal(created.run.status, 'allocating');
  const ready = await eventually(
    () => f.service.getCloudStatus(f.token, { deviceId: 'device-a', runId: created.run.id }),
    (status) => status.run?.status === 'ready',
  );
  assert.equal(ready.run.receipt.pairingCode, 'ABCD-EFGH-JKLM');
  assert.doesNotMatch(JSON.stringify(ready), new RegExp(scopedToken));
  assert.equal(calls.length, 1);
  const nonOwner = await f.service.getCloudStatus(f.secondToken, { deviceId: 'device-b' });
  assert.equal(nonOwner.activeRun.receipt, null, 'a pairing code is never visible to another device');
  await assert.rejects(
    () => f.service.heartbeatCloudRun('wrong-run-token', created.run.id),
    { code: 'CLOUD_WORKER_UNAUTHORIZED' },
  );
  await f.service.confirmCloudAllocation(scopedToken, created.run.id);
  f.advance(MINUTE);
  assert.equal((await f.service.heartbeatCloudRun(scopedToken, created.run.id)).quota.usedMs, MINUTE);
  await f.service.completeCloudRun(scopedToken, created.run.id, { checkpointId: 'warm-provisioned' });
  const lease = await f.service.getCloudLease(scopedToken);
  assert.equal(lease.runId, created.run.id);
  assert.equal(lease.shouldConfirm, true);
  await f.service.confirmCloudAllocation(scopedToken, lease.runId);
  f.advance(MINUTE);
  assert.equal((await f.service.heartbeatCloudRun(scopedToken, lease.runId)).quota.usedMs, 2 * MINUTE);
  await f.service.stopCloudRun(f.token, lease.runId, { deviceId: 'device-a' });
  assert.equal(teardownAttempts, 1, 'failed teardown remains pending instead of being forgotten');
  const pending = await f.service.inspectCloudState(f.token);
  assert.equal(pending.account.worker.status, 'tearing_down');
  await assert.rejects(
    () => f.service.createCloudRun(f.token, { deviceId: 'device-a', idempotencyKey: 'blocked-by-delete' }),
    { code: 'CLOUD_TEARDOWN_PENDING' },
  );
  await f.service.reconcileCloudUsage();
  assert.equal(teardownAttempts, 2);
  assert.deepEqual(reconciledKeepNames, [], 'terminal runs are not protected from Raucloud orphan cleanup');
  const state = await f.service.inspectCloudState(f.token);
  assert.equal(state.runs[lease.runId].remote, undefined);
});

test('provision failure after a remote id is persisted tears the orphan down', async () => {
  const removed = [];
  const provisioner = {
    async provision(input) {
      const remote = { providerId: 'railway', serviceId: 'svc-orphan', projectId: 'p', environmentId: 'e' };
      await input.onRemoteCreated(remote);
      throw Object.assign(new Error('domain failed'), { code: 'PROVIDER_REJECTED' });
    },
    async teardown(remote) { removed.push(remote.serviceId); return { removed: true }; },
  };
  const f = await fixture({ provisioner });
  const created = await f.service.createCloudRun(f.token, {
    deviceId: 'device-a', timezone: 'UTC', idempotencyKey: 'orphan-provision',
  });
  assert.equal(created.run.status, 'allocating');
  const failed = await eventually(
    () => f.service.getCloudStatus(f.token, { deviceId: 'device-a', runId: created.run.id }),
    (status) => status.run?.status === 'failed',
  );
  assert.equal(failed.run.failureCode, 'PROVIDER_REJECTED');
  assert.equal(failed.run.message, 'Raucloud could not allocate a worker');
  assert.deepEqual(removed, ['svc-orphan']);
  const state = await f.service.inspectCloudState(f.token);
  const run = Object.values(state.runs)[0];
  assert.equal(run.status, 'failed');
  assert.equal(run.remote, undefined);
  assert.equal(state.account.worker, null);
});

test('Railway reconciliation deletes delayed Raucloud creates that have no durable run', async () => {
  const legacyPrefix = 'rauhwpx-managed-'; // raucloud-legacy: existing Railway service fixture.
  let services = [
    { id: 'svc-keep', name: 'rauhwpx-raucloud-keep' },
    { id: 'svc-orphan', name: 'rauhwpx-raucloud-orphan' },
    { id: 'svc-legacy-keep', name: `${legacyPrefix}keep` },
    { id: 'svc-legacy-orphan', name: `${legacyPrefix}orphan` },
    { id: 'svc-user', name: 'unrelated-service' },
  ];
  const provisioner = createRailwayCloudProvisioner({
    config: {
      token: 'railway-token', projectId: 'project', environmentId: 'environment',
      image: 'example/image:tag', apiUrl: 'https://railway.test/graphql', brokerUrl: 'https://broker.test',
    },
    fetchImpl: async (_url, options) => {
      const { query, variables } = JSON.parse(options.body);
      if (query.includes('RaucloudProjectServices')) {
        return Response.json({ data: { project: { services: { edges: services.map((node) => ({ node })) } } } });
      }
      if (query.includes('RaucloudServiceDelete')) {
        services = services.filter((service) => service.id !== variables.id);
        return Response.json({ data: { serviceDelete: true } });
      }
      throw new Error('unexpected Railway operation');
    },
  });
  const result = await provisioner.reconcileRaucloud({
    keepServiceNames: ['rauhwpx-raucloud-keep', `${legacyPrefix}keep`],
  });
  assert.equal(result.removed, 2);
  assert.deepEqual(services.map(({ id }) => id), ['svc-keep', 'svc-legacy-keep', 'svc-user']);
});

test('HTTP account, status, run, and internal endpoints use stable envelopes and separate auth', async () => {
  const f = await fixture();
  const server = http.createServer(creditsRequestListener(f.service));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json', ...options.headers },
  });
  try {
    assert.equal((await request('/v1/account')).status, 200);
    const status = await request('/v1/cloud/status?timezone=UTC').then((response) => response.json());
    assert.equal(status.quota.limitMs, CLOUD_DAILY_LIMIT_MS);
    assert.equal(status.worker, null);
    const created = await request('/v1/cloud/runs', {
      method: 'POST', body: JSON.stringify({ deviceId: 'device-http', idempotencyKey: 'http-1' }),
    }).then((response) => response.json());
    assert.equal(created.run.status, 'allocating');
    const requestedRun = await request(`/v1/cloud/status?deviceId=device-http&runId=${created.run.id}`)
      .then((response) => response.json());
    assert.equal(requestedRun.run.id, created.run.id);
    assert.equal(requestedRun.run.status, 'allocating');
    const denied = await request(`/v1/internal/cloud/runs/${created.run.id}/allocation`, {
      method: 'POST', body: '{}',
    });
    assert.equal(denied.status, 401);
    const confirmed = await request(`/v1/internal/cloud/runs/${created.run.id}/allocation`, {
      method: 'POST', body: '{}', headers: { Authorization: `Bearer ${WORKER_SECRET}` },
    });
    assert.equal(confirmed.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

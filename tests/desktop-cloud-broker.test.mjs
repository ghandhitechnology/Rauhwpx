import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createRaucloudBrokerClient,
  createRaucloudBrokerProvider,
  RAUCLOUD_ACCESS_SECRET,
  RAUCLOUD_PROVIDER_ID,
  RAUCLOUD_SETUP_TIMEOUT_MS,
} from '../desktop/cloud-broker.mjs';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';

const ACCESS_TOKEN = 'rau_v1_account_token_1234567890';
const TAKEOVER_SERVER_KEY = `ed25519:${generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;
const RECEIPT = Object.freeze({
  endpoint: 'https://worker.example.test/rauhwpx-cloud',
  serverPublicKey: `ed25519:${'A'.repeat(59)}`,
  pairingCode: 'ABCD-EFGH-JKLM',
});

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function broker(routes, overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const key = `${options.method ?? 'GET'} ${parsed.pathname}`;
    calls.push({
      key,
      url: parsed,
      headers: options.headers,
      body: options.body ? JSON.parse(options.body) : null,
    });
    const route = routes[key];
    if (!route) throw new Error(`unexpected request: ${key}`);
    return typeof route === 'function' ? route(calls.at(-1)) : route;
  };
  const client = createRaucloudBrokerClient({
    baseUrl: 'https://broker.example.test',
    getAccessToken: overrides.getAccessToken ?? (async () => ACCESS_TOKEN),
    getDeviceIdentity: overrides.getDeviceIdentity ?? (async () => ({ id: 'device-desktop-123', name: 'Laptop' })),
    fetchImpl,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 1_000,
    setupRequestTimeoutMs: overrides.setupRequestTimeoutMs ?? overrides.requestTimeoutMs ?? 1_000,
    sleep: async () => {},
  });
  return { client, calls };
}

test('Raucloud refuses requests without a signed-in Rau account', async () => {
  let requested = false;
  const client = createRaucloudBrokerClient({
    baseUrl: 'https://broker.example.test',
    getAccessToken: async () => null,
    getDeviceIdentity: async () => ({ id: 'device-desktop-123' }),
    fetchImpl: async () => { requested = true; return json({}); },
  });
  await assert.rejects(() => client.status(), (error) => {
    assert.equal(error.code, 'RAUCLOUD_AUTH_REQUIRED');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(requested, false, 'logged-out clients never contact the broker');
});

test('Raucloud creates one broker run without Railway credentials or provider secrets', async () => {
  const { client, calls } = broker({
    'POST /v1/cloud/runs': json({
      run: { id: 'run-1', status: 'ready', region: 'ap-northeast', reused: false },
      receipt: RECEIPT,
      quota: { remainingSeconds: 3_600, dailyLimitSeconds: 3_600 },
    }),
  });
  const provider = createRaucloudBrokerProvider({ client });
  const journals = [];
  const result = await provider.spawn({
    deviceName: 'Work laptop',
    selectedProvider: 'codex',
    credentials: { apiKey: 'must-not-leave-the-device' },
    onSandboxCreated: async (sandbox) => journals.push(sandbox),
  });

  assert.equal(provider.id, RAUCLOUD_PROVIDER_ID);
  assert.equal(result.sandbox.sandboxId, 'run-1');
  assert.deepEqual(result.receipt, RECEIPT);
  assert.equal(journals.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.match(calls[0].headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls[0].body, {
    deviceId: 'device-desktop-123',
    deviceName: 'Work laptop',
    provider: 'codex',
  });
  assert.equal(JSON.stringify(calls[0]).includes('must-not-leave-the-device'), false);
  assert.equal(JSON.stringify(calls[0]).toLowerCase().includes('railway'), false);
});

test('Raucloud polls broker allocation status until a pairing receipt is ready', async () => {
  const { client, calls } = broker({
    'POST /v1/cloud/runs': json({
      run: { id: 'run-allocating', status: 'allocating', createdAt: Date.parse('2026-08-30T12:00:00.000Z') },
      gate: { state: 'ready', canStart: false },
    }),
    'GET /v1/cloud/status': json({
      run: { id: 'run-allocating', status: 'active', createdAt: Date.parse('2026-08-30T12:00:00.000Z') },
      worker: { id: 'worker-1', runId: 'run-allocating', status: 'active' },
      receipt: RECEIPT,
      gate: { state: 'ready', canStart: false },
    }),
  });
  const provider = createRaucloudBrokerProvider({ client, allocationAttempts: 2, allocationPollMs: 10 });
  const journal = [];
  const result = await provider.spawn({ onSandboxCreated: async (sandbox) => journal.push({ ...sandbox }) });
  assert.equal(result.receipt.endpoint, RECEIPT.endpoint);
  assert.equal(journal[0].sandboxId, 'run-allocating', 'the billable run id is journaled before polling');
  assert.equal(journal[0].host, '');
  assert.deepEqual(calls.map((call) => call.key), ['POST /v1/cloud/runs', 'GET /v1/cloud/status']);
});

test('Raucloud allows the full 30-minute setup window when allocation needs many polls', async () => {
  let statusCalls = 0;
  const client = {
    baseUrl: 'https://broker.example.test',
    sleep: async () => {},
    createRun: async () => ({
      run: { id: 'run-slow', status: 'allocating', createdAt: Date.parse('2026-08-30T12:00:00.000Z') },
    }),
    status: async () => {
      statusCalls += 1;
      return statusCalls >= 121
        ? { run: { id: 'run-slow', status: 'ready', receipt: RECEIPT } }
        : { run: { id: 'run-slow', status: 'allocating' } };
    },
    stopRun: async () => ({}),
  };
  const provider = createRaucloudBrokerProvider({ client });
  const result = await provider.spawn();

  assert.equal(RAUCLOUD_SETUP_TIMEOUT_MS, 30 * 60_000);
  assert.equal(statusCalls, 121, 'the previous five-minute/120-poll ceiling would stop too early');
  assert.equal(result.receipt.pairingCode, RECEIPT.pairingCode);
});

function hangingFetch(routes, overrides = {}) {
  const fetchImpl = (url, options = {}) => {
    const parsed = new URL(url);
    const key = `${options.method ?? 'GET'} ${parsed.pathname}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected request: ${key}`);
    return typeof route === 'function' ? route(options) : route;
  };
  const client = createRaucloudBrokerClient({
    baseUrl: 'https://broker.example.test',
    getAccessToken: async () => ACCESS_TOKEN,
    getDeviceIdentity: async () => ({ id: 'device-desktop-123', name: 'Laptop' }),
    fetchImpl,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 20,
    setupRequestTimeoutMs: overrides.setupRequestTimeoutMs ?? 20,
    sleep: async () => {},
  });
  return { client };
}

test('create requests use a looser compatibility timeout than ordinary status requests', async () => {
  const fetchImpl = (_url, options = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(json({ run: { id: 'run-delayed', status: 'allocating' } })), 30);
    options.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(options.signal.reason);
    }, { once: true });
  });
  const client = createRaucloudBrokerClient({
    baseUrl: 'https://broker.example.test',
    getAccessToken: async () => ACCESS_TOKEN,
    getDeviceIdentity: async () => ({ id: 'device-desktop-123', name: 'Laptop' }),
    fetchImpl,
    requestTimeoutMs: 10,
    setupRequestTimeoutMs: 100,
  });

  assert.equal((await client.createRun()).run.id, 'run-delayed');
  await assert.rejects(() => client.status(), (error) => {
    assert.equal(error.code, 'RAUCLOUD_TIMEOUT');
    return true;
  });
});

test('spawn attaches to the in-flight run after a blocking create is aborted', async () => {
  let statusCalls = 0;
  const { client } = hangingFetch({
    'POST /v1/cloud/runs': (options) => new Promise((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
    'GET /v1/cloud/status': () => {
      statusCalls += 1;
      return json(statusCalls === 1
        ? { activeRun: { id: 'run-blocked', status: 'allocating' } }
        : { activeRun: { id: 'run-blocked', status: 'ready' }, receipt: RECEIPT });
    },
  });
  const result = await createRaucloudBrokerProvider({
    client, allocationAttempts: 3, allocationPollMs: 10,
  }).spawn();
  assert.equal(result.sandbox.sandboxId, 'run-blocked');
  assert.equal(result.receipt.pairingCode, RECEIPT.pairingCode);
  assert.ok(statusCalls >= 2);
});

test('spawn resumes the same-device run after create reports it is already active', async () => {
  const { client } = broker({
    'POST /v1/cloud/runs': json({
      error: 'CLOUD_RUN_ALREADY_ACTIVE', message: 'A Raucloud run is already active',
      details: { runId: 'run-existing' },
    }, 409),
    'GET /v1/cloud/status': json({
      activeRun: { id: 'run-existing', status: 'ready' },
      receipt: RECEIPT,
    }),
  });
  const result = await createRaucloudBrokerProvider({ client }).spawn();
  assert.equal(result.sandbox.sandboxId, 'run-existing');
  assert.deepEqual(result.receipt, RECEIPT);
});

test('spawn still fails when create times out and status has no run', async () => {
  const { client } = hangingFetch({
    'POST /v1/cloud/runs': (options) => new Promise((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
    'GET /v1/cloud/status': json({ gate: { state: 'ready', canStart: true } }),
  });
  await assert.rejects(
    () => createRaucloudBrokerProvider({ client }).spawn(),
    (error) => error.code === 'RAUCLOUD_TIMEOUT',
  );
});

test('Raucloud status preserves warm reuse, controller lease, and quota visuals', async () => {
  const { client, calls } = broker({
    'GET /v1/cloud/status': json({
      run: {
        id: 'run-1',
        status: 'warm-idle',
        reused: true,
        warmUntil: '2026-08-30T12:05:00.000Z',
        controller: { deviceId: 'device-other', name: 'Desktop' },
        readOnly: true,
        takeoverRequired: true,
      },
      quota: { remainingSeconds: 240, dailyLimitSeconds: 3_600, state: 'warning' },
    }),
  });
  const provider = createRaucloudBrokerProvider({ client });
  const status = await provider.status({ sandboxId: 'run-1' });
  assert.equal(status.lifecycle, 'ready');
  assert.equal(status.status, 'warm-idle');
  assert.equal(status.raucloud.reused, true);
  assert.equal(status.raucloud.readOnly, true);
  assert.equal(status.raucloud.takeoverRequired, true);
  assert.equal(status.raucloud.quota.remainingSeconds, 240);
  assert.equal(calls[0].url.searchParams.get('runId'), 'run-1');
  assert.equal(calls[0].url.searchParams.get('deviceId'), 'device-desktop-123');
});

test('Raucloud account status normalizes backend quota and another-device ownership', async () => {
  const { client } = broker({
    'GET /v1/cloud/status': json({
      account: { id: 'user-1', email: 'user@example.test', loggedIn: true, timezone: 'Asia/Seoul' },
      quota: {
        limitMs: 3_600_000,
        usedMs: 900_000,
        remainingMs: 2_700_000,
        resetsAt: Date.parse('2026-08-31T15:00:00.000Z'),
        grace: { usedMs: 0, debtMs: 120_000 },
        coldStarts: { usedToday: 2, dailyLimit: 12, recent: 1, recentLimit: 3 },
      },
      activeRun: {
        id: 'run-other', ownerDeviceId: 'device-other', createdAt: Date.parse('2026-08-30T12:00:00.000Z'),
      },
      worker: { id: 'worker-1', runId: 'run-other', ownerDeviceId: 'device-other', status: 'active' },
      gate: { state: 'owned_elsewhere', canStart: false, reason: 'Raucloud is active on another device' },
    }),
  });
  const account = await createRaucloudBrokerProvider({ client }).accountStatus();
  assert.equal(account.signedIn, true);
  assert.equal(account.quota.dailyLimitMs, 3_600_000);
  assert.equal(account.quota.debtMs, 120_000);
  assert.equal(account.quota.activeRun.controllingThisDevice, false);
  assert.deepEqual(account.raucloud, {
    kind: 'active-elsewhere', runId: 'run-other', deviceName: null,
  });
});

test('the controlling device stays available while its single run is active', async () => {
  const { client } = broker({
    'GET /v1/cloud/status': json({
      account: { id: 'user-1', email: 'user@example.test', timezone: 'Asia/Seoul' },
      quota: {
        limitMs: 3_600_000, usedMs: 10_000, remainingMs: 3_590_000, resetsAt: Date.parse('2026-08-31T15:00:00.000Z'),
        grace: { usedMs: 0, debtMs: 0 },
        coldStarts: { usedToday: 1, dailyLimit: 12, recent: 1, recentLimit: 3 },
      },
      activeRun: { id: 'run-here', ownerDeviceId: 'device-desktop-123', createdAt: Date.now() },
      gate: { state: 'ready', canStart: false, reason: null },
    }),
  });
  const account = await createRaucloudBrokerProvider({ client }).accountStatus();
  assert.deepEqual(account.raucloud, { kind: 'available' });
  assert.equal(account.quota.activeRun.controllingThisDevice, true);
});

test('Raucloud exposes explicit checkpointed takeover and graceful logout stop', async () => {
  const { client, calls } = broker({
    'GET /v1/cloud/status': json({
      takeoverRun: { id: 'run-1', status: 'checkpointed', checkpointId: 'checkpoint-1' },
    }),
    'POST /v1/cloud/runs/run-1/takeover': json({ run: { id: 'run-2', status: 'ready' }, receipt: RECEIPT }),
    'POST /v1/cloud/runs/run-1/stop': (call) => json({
      run: call.body.reason === 'logout'
        ? { id: 'run-1', status: 'active', inputBlocked: true }
        : { id: 'run-1', status: 'stopped' },
    }),
  });
  const provider = createRaucloudBrokerProvider({ client });

  const takeover = await provider.takeover(null, { deviceName: 'New controller' });
  assert.deepEqual(takeover.receipt, RECEIPT);
  assert.equal(takeover.sandbox.sandboxId, 'run-2');
  assert.deepEqual(calls[1].body, {
    deviceId: 'device-desktop-123',
    checkpointId: 'checkpoint-1',
  });

  const logout = await provider.logout({ sandboxId: 'run-1' });
  assert.equal(logout.status, 'stopping');
  assert.deepEqual(calls[2].body, {
    deviceId: 'device-desktop-123',
    reason: 'logout',
    finishCurrentTurn: true,
    checkpoint: true,
  });

  const teardown = await provider.teardown({ sandboxId: 'run-1' });
  assert.equal(teardown.removed, true);
  assert.deepEqual(calls[3].body, {
    deviceId: 'device-desktop-123',
    reason: 'user-request',
    finishCurrentTurn: false,
    checkpoint: true,
  });
});

test('Raucloud keeps broker conflict and quota failures stable for the UI', async () => {
  const conflict = broker({
    'POST /v1/cloud/runs': json({
      error: 'CLOUD_TAKEOVER_REQUIRED', message: 'Another device controls this worker',
    }, 409),
  });
  await assert.rejects(() => conflict.client.createRun(), (error) => {
    assert.equal(error.code, 'CLOUD_TAKEOVER_REQUIRED');
    assert.equal(error.status, 409);
    assert.equal(error.retryable, false);
    return true;
  });

  const legacyQuotaCode = 'MANAGED_CLOUD_QUOTA_EXHAUSTED'; // raucloud-legacy: rolling broker response fixture.
  const quota = broker({
    'POST /v1/cloud/runs': json({ error: { code: legacyQuotaCode, message: 'Daily Cloud allowance is used' } }, 429, { 'retry-after': '900' }),
  });
  await assert.rejects(() => quota.client.createRun(), (error) => {
    assert.equal(error.code, 'RAUCLOUD_QUOTA_EXHAUSTED');
    assert.equal(error.retryAfter, '900');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('the packaged desktop uses the Rau account token and not the direct Railway provider', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /createRaucloudBrokerProvider/);
  assert.match(source, /getAccessToken:\s*\(\) => secretVault\.get\(RAUCLOUD_ACCESS_SECRET\)/);
  assert.doesNotMatch(source, /createRailwayServerProvider/);
  assert.equal(RAUCLOUD_ACCESS_SECRET, 'rhwp.rau.openrouter-api-key');
});

test('coordinator snapshots expose a logged-out account gate before any Cloud profile exists', async () => {
  const provider = createRaucloudBrokerProvider({
    baseUrl: 'https://broker.example.test',
    getAccessToken: async () => null,
    getDeviceIdentity: async () => ({ id: 'device-desktop-123' }),
    fetchImpl: async () => { throw new Error('logged-out status must stay local'); },
  });
  const store = {
    load: async () => [],
    list: async () => [],
    flush: async () => {},
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadServerMode: async () => null,
      loadProfile: async () => null,
    },
    store,
    appServers: [provider],
  });
  const snapshot = await coordinator.start();
  assert.equal(snapshot.profile.kind, 'unconfigured');
  assert.deepEqual(snapshot.account, {
    signedIn: false,
    account: null,
    quota: null,
    raucloud: { kind: 'logged-out' },
    updatedAt: snapshot.account.updatedAt,
  });
  await coordinator.stop();
});

test('a newly signed-in device can take over without an existing local Cloud profile', async () => {
  let profile = null;
  let paired = false;
  let takeoverSandbox = 'not-called';
  const receipt = { ...RECEIPT, serverPublicKey: TAKEOVER_SERVER_KEY };
  const provider = {
    id: RAUCLOUD_PROVIDER_ID,
    displayName: 'Raucloud',
    configuration: () => ({ configured: true, missing: [] }),
    spawn: async () => { throw new Error('not used'); },
    status: async () => ({ lifecycle: 'idle' }),
    teardown: async () => ({ removed: true }),
    accountStatus: async () => ({
      signedIn: true, account: { id: 'user-1' }, quota: null,
      raucloud: { kind: 'active-elsewhere', runId: 'run-1' }, updatedAt: new Date().toISOString(),
    }),
    takeover: async (sandbox) => {
      takeoverSandbox = sandbox;
      return {
        sandbox: {
          providerId: RAUCLOUD_PROVIDER_ID, sandboxId: 'run-2', host: 'worker.example.test',
          createdAt: new Date().toISOString(), projectId: '', environmentId: '', domainId: '', region: '',
        },
        receipt,
      };
    },
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadServerMode: async () => null,
      saveServerMode: async () => 'app-hosted',
      loadProfile: async () => profile,
      isPaired: async () => paired,
      redeemPairingCode: async () => ({ credentials: { refreshToken: 'refresh', device: { id: 'device-2' } } }),
      health: async () => ({ ok: true, serverPublicKey: receipt.serverPublicKey }),
      activateProfile: async (next) => { profile = next; paired = true; },
    },
    store: { load: async () => [], list: async () => [], flush: async () => {} },
    appServers: [provider],
  });
  await coordinator.start();
  const snapshot = await coordinator.takeoverAppServer({ deviceName: 'Second laptop' });
  assert.equal(takeoverSandbox, null);
  assert.equal(snapshot.profile.kind, 'configured');
  assert.equal(snapshot.profile.mode, 'app-hosted');
  assert.equal(snapshot.profile.sandbox.sandboxId, 'run-2');
  await coordinator.stop();
});

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AppServerError } from '../desktop/cloud-app-server.mjs';
import {
  createRaucloudBrokerClient,
  createRaucloudBrokerProvider,
  RAUCLOUD_PROVIDER_ID,
  RAUCLOUD_SETUP_TIMEOUT_MS,
} from '../desktop/cloud-broker.mjs';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';

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
  const authorizeOwnedBackend = async (request, { signal } = {}) => {
    const parsed = new URL(request.pathname, 'https://broker.example.test');
    const key = `${request.method ?? 'GET'} ${parsed.pathname}`;
    calls.push({
      key,
      url: parsed,
      headers: request.headers,
      body: request.body ?? null,
    });
    const route = routes[key];
    if (!route) throw new Error(`unexpected request: ${key}`);
    const response = typeof route === 'function'
      ? await route(calls.at(-1), { signal })
      : await route;
    if (!(response instanceof Response)) return response;
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;
    const supplied = typeof body?.error === 'string' ? body.error : body?.error?.code ?? body?.code;
    throw Object.assign(new Error(body?.message ?? supplied ?? 'Raucloud request failed'), {
      code: supplied ?? 'RAU_CREDITS_HTTP',
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      fromCreditsService: true,
    });
  };
  const client = createRaucloudBrokerClient({
    baseUrl: 'https://broker.example.test',
    authorizeOwnedBackend: overrides.authorizeOwnedBackend ?? authorizeOwnedBackend,
    getDeviceIdentity: overrides.getDeviceIdentity ?? (async () => ({ id: 'device-desktop-123', name: 'Laptop' })),
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
    authorizeOwnedBackend: async () => {
      requested = true;
      throw Object.assign(new Error('Account sign-in is required'), {
        code: 'ACCOUNT_SESSION_UNAUTHORIZED',
      });
    },
    getDeviceIdentity: async () => ({ id: 'device-desktop-123' }),
  });
  await assert.rejects(() => client.status(), (error) => {
    assert.equal(error.code, 'RAUCLOUD_AUTH_REQUIRED');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(requested, true, 'the account-session boundary rejects before network authorization');
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
  assert.equal(new Headers(calls[0].headers).has('authorization'), false);
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
  const authorizeOwnedBackend = (request, { signal } = {}) => {
    const parsed = new URL(request.pathname, 'https://broker.example.test');
    const key = `${request.method ?? 'GET'} ${parsed.pathname}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected request: ${key}`);
    const result = typeof route === 'function' ? route({ signal }) : route;
    return Promise.resolve(result).then(async (response) => {
      if (!(response instanceof Response)) return response;
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body;
      throw Object.assign(new Error(body?.message ?? body?.error ?? 'Raucloud request failed'), {
        code: typeof body?.error === 'string' ? body.error : body?.error?.code ?? 'RAU_CREDITS_HTTP',
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        fromCreditsService: true,
      });
    });
  };
  const client = createRaucloudBrokerClient({
    baseUrl: 'https://broker.example.test',
    authorizeOwnedBackend,
    getDeviceIdentity: async () => ({ id: 'device-desktop-123', name: 'Laptop' }),
    requestTimeoutMs: overrides.requestTimeoutMs ?? 20,
    setupRequestTimeoutMs: overrides.setupRequestTimeoutMs ?? 20,
    sleep: async () => {},
  });
  return { client };
}

test('create requests use a looser compatibility timeout than ordinary status requests', async () => {
  const authorizeOwnedBackend = (_request, { signal } = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(json({ run: { id: 'run-delayed', status: 'allocating' } })), 30);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  }).then((response) => response.json());
  const client = createRaucloudBrokerClient({
    baseUrl: 'https://broker.example.test',
    authorizeOwnedBackend,
    getDeviceIdentity: async () => ({ id: 'device-desktop-123', name: 'Laptop' }),
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

test('Raucloud force-quit stops every live account run from any signed-in device', async () => {
  const { client, calls } = broker({
    'POST /v1/cloud/force-quit': json({
      worker: null,
      activeRun: null,
      gate: { state: 'ready', canStart: true, reason: null },
    }),
  });
  const provider = createRaucloudBrokerProvider({ client });
  const result = await provider.forceQuitAccount();
  assert.equal(result.status, 'idle');
  assert.equal(calls[0].key, 'POST /v1/cloud/force-quit');
  assert.deepEqual(calls[0].body, {
    deviceId: 'device-desktop-123',
    reason: 'force-quit',
  });
});

test('account force-quit ends leftover sessions and the account worker', async () => {
  const ended = [];
  let forceQuitCalled = false;
  const provider = {
    id: RAUCLOUD_PROVIDER_ID,
    displayName: 'Raucloud',
    configuration: () => ({ configured: true, missing: [] }),
    spawn: async () => { throw new Error('not used'); },
    status: async () => ({ lifecycle: 'idle' }),
    teardown: async () => ({ removed: true }),
    accountStatus: async () => ({
      signedIn: true, account: { id: 'user-1' }, quota: null,
      raucloud: { kind: 'available' }, updatedAt: new Date().toISOString(),
    }),
    forceQuitAccount: async () => {
      forceQuitCalled = true;
      return { worker: null, account: { signedIn: true, account: { id: 'user-1' }, quota: null, raucloud: { kind: 'available' }, updatedAt: new Date().toISOString() } };
    },
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadServerMode: async () => null,
      loadProfile: async () => null,
      sessions: async () => [{ id: 'session-live', status: 'running', stateVersion: 4 }],
      command: async (sessionId, type, payload) => {
        ended.push({ sessionId, type, payload });
        return { session: { id: sessionId, status: 'cancelled' } };
      },
    },
    store: { load: async () => [], list: async () => [], flush: async () => {} },
    appServers: [provider],
  });
  await coordinator.start();
  await coordinator.forceQuitAccountCloud();
  assert.equal(forceQuitCalled, true);
  assert.deepEqual(ended, [{
    sessionId: 'session-live',
    type: 'session.end',
    payload: { expectedVersion: 4 },
  }]);
  await coordinator.stop();
});

test('reconnect exposes link state after a health probe', async () => {
  let healthy = false;
  const profile = {
    mode: 'self-hosted',
    name: 'vps',
    endpoint: 'https://vps.example.test/rauhwpx-cloud',
    serverPublicKey: 'ed25519:test',
    ssh: { host: 'vps.example.test', user: 'ubuntu', port: 22 },
    transport: 'tailscale',
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadServerMode: async () => 'self-hosted',
      loadProfile: async () => profile,
      isPaired: async () => true,
      health: async () => {
        if (!healthy) throw new Error('temporary disconnect');
        return { ok: true, serverPublicKey: profile.serverPublicKey };
      },
    },
    store: { load: async () => [], list: async () => [], flush: async () => {} },
  });
  const started = await coordinator.start();
  assert.equal(started.link.kind, 'ready');
  const failed = await coordinator.reconnectCloud();
  assert.equal(failed.link.kind, 'failed');
  assert.equal(failed.link.error, 'temporary disconnect');
  assert.equal(failed.link.canRecreate, false);
  healthy = true;
  const ready = await coordinator.reconnectCloud();
  assert.equal(ready.link.kind, 'ready');
  assert.equal(ready.link.attempt, 0);
  await coordinator.stop();
});

test('self-hosted recreate reconnects instead of spawning a sandbox', async () => {
  const profile = {
    mode: 'self-hosted',
    name: 'vps',
    endpoint: 'https://vps.example.test/rauhwpx-cloud',
    serverPublicKey: 'ed25519:test',
    ssh: { host: 'vps.example.test', user: 'ubuntu', port: 22 },
    transport: 'tailscale',
  };
  let spawned = false;
  const coordinator = new CloudCoordinator({
    client: {
      loadServerMode: async () => 'self-hosted',
      loadProfile: async () => profile,
      isPaired: async () => true,
      health: async () => ({ ok: true, serverPublicKey: profile.serverPublicKey }),
    },
    store: { load: async () => [], list: async () => [], flush: async () => {} },
    appServers: [{
      id: RAUCLOUD_PROVIDER_ID,
      displayName: 'Raucloud',
      configuration: () => ({ configured: true, missing: [] }),
      spawn: async () => {
        spawned = true;
        throw new Error('self-hosted recreate must not spawn');
      },
      status: async () => ({ lifecycle: 'idle' }),
      teardown: async () => ({ removed: true }),
    }],
  });
  await coordinator.start();
  const snapshot = await coordinator.recreateCloud();
  assert.equal(spawned, false);
  assert.equal(snapshot.link.kind, 'ready');
  await coordinator.stop();
});

test('account force-quit still unlocks when Raucloud cannot complete the request', async () => {
  const provider = {
    id: RAUCLOUD_PROVIDER_ID,
    displayName: 'Raucloud',
    configuration: () => ({ configured: true, missing: [] }),
    spawn: async () => { throw new Error('not used'); },
    status: async () => ({ lifecycle: 'idle' }),
    teardown: async () => { throw new AppServerError('Raucloud could not complete the request'); },
    accountStatus: async () => ({
      signedIn: true, account: { id: 'user-1' }, quota: null,
      raucloud: { kind: 'available' }, updatedAt: new Date().toISOString(),
    }),
    forceQuitAccount: async () => {
      throw new AppServerError('Raucloud could not complete the request', {
        code: 'RAUCLOUD_REQUEST_FAILED', retryable: false,
      });
    },
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadServerMode: async () => null,
      loadProfile: async () => null,
      sessions: async () => { throw new Error('worker unreachable'); },
      command: async () => { throw new Error('worker unreachable'); },
    },
    store: { load: async () => [], list: async () => [], flush: async () => {} },
    appServers: [provider],
  });
  await coordinator.start();
  const snapshot = await coordinator.forceQuitAccountCloud();
  assert.equal(snapshot.session.kind, 'idle');
  await coordinator.stop();
});

test('Raucloud force-quit falls back to stop when the broker endpoint is missing', async () => {
  const { client, calls } = broker({
    'POST /v1/cloud/force-quit': json({ error: 'not found' }, 404),
    'GET /v1/cloud/status': json({
      activeRun: { id: 'run-1', status: 'active', ownerDeviceId: 'device-desktop-123' },
    }),
    'POST /v1/cloud/runs/run-1/stop': json({ run: { id: 'run-1', status: 'stopped' } }),
  });
  const provider = createRaucloudBrokerProvider({ client });
  const result = await provider.forceQuitAccount();
  assert.equal(result.lifecycle, 'idle');
  assert.equal(result.status, 'stopped');
  assert.deepEqual(calls.map((call) => call.key), [
    'POST /v1/cloud/force-quit',
    'GET /v1/cloud/status',
    'POST /v1/cloud/runs/run-1/stop',
  ]);
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

test('the packaged desktop uses the account-session boundary and not the direct Railway provider', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const preload = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  assert.match(source, /createRaucloudBrokerProvider/);
  assert.match(source, /authorizeOwnedBackend:\s*\(request, options\) =>/);
  assert.match(source, /cloudAccountSession\.authorizeOwnedBackend\(request, options\)/);
  assert.doesNotMatch(source, /createRailwayServerProvider/);
  assert.doesNotMatch(source, /RAUCLOUD_ACCESS_SECRET|getAccessToken/);
  assert.match(source, /cloud:reconnect-link/);
  assert.match(source, /cloud:recreate-link/);
  assert.match(preload, /cloudReconnectLink/);
  assert.match(preload, /cloudRecreateLink/);
});

test('coordinator snapshots expose a logged-out account gate before any Cloud profile exists', async () => {
  const provider = createRaucloudBrokerProvider({
    baseUrl: 'https://broker.example.test',
    authorizeOwnedBackend: async () => {
      throw Object.assign(new Error('Account sign-in is required'), {
        code: 'ACCOUNT_SESSION_UNAUTHORIZED',
      });
    },
    getDeviceIdentity: async () => ({ id: 'device-desktop-123' }),
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

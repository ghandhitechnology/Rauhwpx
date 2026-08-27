import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { AppServerError, createAppServerRegistry } from '../desktop/cloud-app-server.mjs';
import { CloudClient } from '../desktop/cloud-client.mjs';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';
import { sha256Hex } from '../desktop/cloud-handoff.mjs';
import { cloudProfileWithoutSecrets, normalizeCloudProfile } from '../desktop/cloud-profile.mjs';
import { createRailwayServerProvider, railwayConfigFromEnv } from '../desktop/cloud-railway.mjs';

const SERVER_IDENTITY = generateKeyPairSync('ed25519');
const SERVER_KEY = `ed25519:${SERVER_IDENTITY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;

const RAILWAY_CONFIG = Object.freeze({
  token: 'railway-token',
  projectId: 'project-1',
  environmentId: 'environment-1',
  image: 'ghcr.io/example/rauhwpx-cloud:stable',
  region: 'us-east4-eqdc4a',
  apiUrl: 'https://backboard.railway.com/graphql/v2',
});

const SANDBOX = Object.freeze({
  providerId: 'railway',
  sandboxId: 'service-1',
  projectId: 'project-1',
  environmentId: 'environment-1',
  domainId: 'domain-1',
  region: 'us-east4-eqdc4a',
  host: 'sandbox-1.up.railway.app',
  createdAt: '2026-08-24T00:00:00.000Z',
});

function memoryVault(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); return true; },
    delete: async (key) => values.delete(key),
    values,
  };
}

function signedFetch(handler, identity = SERVER_IDENTITY) {
  const serverKey = `ed25519:${identity.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;
  return async (url, options = {}) => {
    const response = await handler(url, options);
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentDigest = sha256Hex(bytes);
    const requestUrl = new URL(url);
    const nonce = options.headers?.['x-rauhwpx-request-nonce'];
    const canonical = `RAUHWpx-response-v1\n${nonce}\n${String(options.method ?? 'GET').toUpperCase()}\n${requestUrl.pathname}${requestUrl.search}\n${response.status}\n${contentDigest}`;
    const headers = new Headers(response.headers);
    headers.set('x-rauhwpx-server-key', serverKey);
    headers.set('x-rauhwpx-content-sha256', contentDigest);
    headers.set('x-rauhwpx-response-signature', sign(null, Buffer.from(canonical), identity.privateKey).toString('base64url'));
    return new Response(bytes.length ? bytes : null, { status: response.status, headers });
  };
}

function graphqlFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const name = body.query.match(/(?:mutation|query)\s+(\w+)/)[1];
    calls.push({ name, variables: body.variables, authorization: options.headers.authorization });
    const route = routes[name];
    if (!route) throw new Error(`unexpected Railway call: ${name}`);
    const payload = typeof route === 'function' ? route(body.variables, calls) : route;
    return new Response(JSON.stringify(payload.body ?? payload), {
      status: payload.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls, names: () => calls.map((call) => call.name) };
}

function railwayProvider(routes, overrides = {}) {
  const transport = graphqlFetch(routes);
  const provider = createRailwayServerProvider({
    config: { ...RAILWAY_CONFIG, ...(overrides.config ?? {}) },
    fetchImpl: transport.fetchImpl,
    probeHealth: overrides.probeHealth ?? (async () => ({ ok: true, serverPublicKey: SERVER_KEY })),
    acquireReceipt: overrides.acquireReceipt ?? (async ({ endpoint, serverPublicKey }) => ({
      endpoint,
      serverPublicKey,
      pairingCode: 'ABCD-EFGH-JKLM',
    })),
    sleep: async () => {},
    deployTimeoutMs: overrides.deployTimeoutMs ?? 1_000,
    healthTimeoutMs: overrides.healthTimeoutMs ?? 1_000,
  });
  return { provider, transport };
}

const SPAWN_ROUTES = Object.freeze({
  RauhwpxServiceCreate: { data: { serviceCreate: { id: 'service-1', name: 'rauhwpx-sandbox-abcd' } } },
  RauhwpxServiceInstanceUpdate: { data: { serviceInstanceUpdate: true } },
  RauhwpxServiceDomainCreate: {
    data: { serviceDomainCreate: { id: 'domain-1', domain: 'sandbox-1.up.railway.app' } },
  },
  RauhwpxLatestDeployment: {
    data: { deployments: { edges: [{ node: { id: 'deployment-1', status: 'SUCCESS' } }] } },
  },
  RauhwpxServiceDelete: { data: { serviceDelete: true } },
});

test('cloud profiles keep app sandboxes and user hosts apart', () => {
  const appHosted = normalizeCloudProfile({
    mode: 'app-hosted',
    name: 'Railway sandbox',
    endpoint: 'https://sandbox-1.up.railway.app/rauhwpx-cloud',
    serverPublicKey: SERVER_KEY,
    sandbox: SANDBOX,
  });
  assert.equal(appHosted.mode, 'app-hosted');
  assert.equal(appHosted.ssh, null);
  assert.equal(appHosted.transport, 'public-https');
  assert.equal(appHosted.id, 'app-hosted:railway:service-1');
  assert.equal(appHosted.sandbox.host, 'sandbox-1.up.railway.app');
  assert.equal(cloudProfileWithoutSecrets(appHosted).ssh, null, 'there is no SSH key path to redact');

  const selfHosted = normalizeCloudProfile({
    endpoint: 'https://vps.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'vps.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  assert.equal(selfHosted.mode, 'self-hosted', 'stored profiles without a mode stay self-hosted');
  assert.equal(selfHosted.sandbox, null);
  assert.equal(selfHosted.id, 'personal-vps');

  assert.throws(() => normalizeCloudProfile({
    mode: 'app-hosted',
    endpoint: 'https://sandbox-1.up.railway.app/rauhwpx-cloud',
  }), /Sandbox provider is required/);
  assert.throws(() => normalizeCloudProfile({
    mode: 'app-hosted',
    endpoint: 'https://sandbox-1.up.railway.app/rauhwpx-cloud',
    sandbox: { ...SANDBOX, host: 'not a host' },
  }), /Sandbox host is invalid/);
  assert.throws(() => normalizeCloudProfile({ mode: 'fly', endpoint: 'https://x.example.com/c' }), /server mode/);
});

test('the app server registry validates providers and reports missing configuration', () => {
  const stub = (id, configured) => ({
    id,
    displayName: `${id} sandbox`,
    configuration: () => ({ configured, missing: configured ? [] : ['TOKEN'] }),
    spawn: async () => {},
    status: async () => {},
    teardown: async () => {},
  });
  const registry = createAppServerRegistry([stub('unset', false), stub('railway', true)]);
  assert.equal(registry.size, 2);
  assert.deepEqual(registry.list(), [
    { providerId: 'unset', displayName: 'unset sandbox', configured: false, missingConfig: ['TOKEN'] },
    { providerId: 'railway', displayName: 'railway sandbox', configured: true, missingConfig: [] },
  ]);
  assert.equal(registry.preferred().id, 'railway', 'a configured provider wins the default');
  assert.equal(registry.has('railway'), true);
  assert.equal(registry.has('fly'), false);
  assert.throws(() => registry.get('fly'), { code: 'PROVIDER_UNKNOWN' });

  assert.equal(createAppServerRegistry([]).preferred(), null);
  assert.throws(() => createAppServerRegistry([stub('Railway', true)]), /lowercase id/);
  assert.throws(() => createAppServerRegistry([stub('railway', true), stub('railway', true)]), /Duplicate/);
  assert.throws(() => createAppServerRegistry([{ id: 'railway', displayName: 'x' }]), /must implement configuration/);
  assert.throws(() => createAppServerRegistry([{ ...stub('railway', true), displayName: '' }]), /display name/);
});

test('the Railway provider refuses to pretend when it has no configuration', async () => {
  const { provider, transport } = railwayProvider({}, { config: { token: '', projectId: '', environmentId: '' } });
  assert.deepEqual(provider.configuration(), {
    configured: false,
    missing: ['RAUHWpx_RAILWAY_TOKEN', 'RAUHWpx_RAILWAY_PROJECT_ID', 'RAUHWpx_RAILWAY_ENVIRONMENT_ID'],
    image: RAILWAY_CONFIG.image,
    region: RAILWAY_CONFIG.region,
  });
  await assert.rejects(provider.spawn({}), { code: 'PROVIDER_NOT_CONFIGURED' });
  assert.deepEqual(transport.names(), [], 'no request leaves the app before configuration exists');

  const env = railwayConfigFromEnv({
    RAUHWpx_RAILWAY_TOKEN: ' railway-token ',
    RAUHWpx_RAILWAY_PROJECT_ID: 'project-1',
    RAUHWpx_RAILWAY_ENVIRONMENT_ID: 'environment-1',
  });
  assert.equal(env.token, 'railway-token');
  assert.equal(env.apiUrl, 'https://backboard.railway.com/graphql/v2');
  assert.match(env.image, /rauhwpx-cloud/);
});

test('the Railway provider creates a reachable sandbox and returns a pairing receipt', async () => {
  const probes = [];
  const { provider, transport } = railwayProvider(SPAWN_ROUTES, {
    probeHealth: async (endpoint) => {
      probes.push(endpoint);
      if (probes.length === 1) throw new Error('fetch failed');
      return { ok: true, serverPublicKey: SERVER_KEY };
    },
  });
  const lines = [];
  const spawned = await provider.spawn({ deviceName: 'Rauhwpx desktop', onLine: (line) => lines.push(line) });
  assert.deepEqual(transport.names(), [
    'RauhwpxServiceCreate',
    'RauhwpxServiceInstanceUpdate',
    'RauhwpxServiceDomainCreate',
    'RauhwpxLatestDeployment',
  ]);
  assert.equal(transport.calls[0].authorization, 'Bearer railway-token');
  assert.deepEqual(spawned.sandbox, {
    providerId: 'railway',
    sandboxId: 'service-1',
    projectId: 'project-1',
    environmentId: 'environment-1',
    domainId: 'domain-1',
    region: 'us-east4-eqdc4a',
    host: 'sandbox-1.up.railway.app',
    createdAt: spawned.sandbox.createdAt,
  });
  assert.equal(spawned.receipt.endpoint, 'https://sandbox-1.up.railway.app/rauhwpx-cloud');
  assert.equal(spawned.receipt.serverPublicKey, SERVER_KEY);
  assert.equal(spawned.receipt.pairingCode, 'ABCD-EFGH-JKLM');
  assert.equal(probes.length, 2, 'the provider waits for the sandbox to answer');
  assert.ok(lines.length >= 3);

  const variables = transport.calls[0].variables.input;
  assert.equal(variables.projectId, 'project-1');
  assert.equal(variables.source.image, RAILWAY_CONFIG.image);
  assert.match(variables.name, /^rauhwpx-sandbox-[0-9a-f]{8}$/);
  assert.match(variables.variables.RAUHWpx_BOOTSTRAP_TOKEN, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(variables.variables.RAUHWpx_PORT, '7740');
  assert.equal(variables.variables.RAUHWpx_BASE_PATH, '/rauhwpx-cloud');
});

test('a Railway sandbox that never becomes usable is removed instead of left behind', async () => {
  const failedDeploy = {
    ...SPAWN_ROUTES,
    RauhwpxLatestDeployment: {
      data: { deployments: { edges: [{ node: { id: 'deployment-1', status: 'CRASHED' } }] } },
    },
  };
  const crashed = railwayProvider(failedDeploy);
  await assert.rejects(crashed.provider.spawn({ onLine: () => {} }), { code: 'SANDBOX_DEPLOY_FAILED' });
  assert.equal(crashed.transport.names().at(-1), 'RauhwpxServiceDelete');

  const unhealthy = railwayProvider(SPAWN_ROUTES, {
    probeHealth: async () => { throw new Error('fetch failed'); },
    healthTimeoutMs: 0,
  });
  await assert.rejects(unhealthy.provider.spawn({ onLine: () => {} }), { code: 'SANDBOX_UNHEALTHY' });
  assert.equal(unhealthy.transport.names().at(-1), 'RauhwpxServiceDelete');

  const wrongKey = railwayProvider(SPAWN_ROUTES, {
    probeHealth: async () => ({ ok: true, serverPublicKey: 'ed25519:short' }),
    healthTimeoutMs: 0,
  });
  await assert.rejects(wrongKey.provider.spawn({ onLine: () => {} }), { code: 'SANDBOX_UNHEALTHY' });

  const rejected = railwayProvider({
    RauhwpxServiceCreate: { status: 401, body: { errors: [{ message: 'Not Authorized' }] } },
  });
  await assert.rejects(rejected.provider.spawn({ onLine: () => {} }), { code: 'PROVIDER_UNAUTHORIZED' });

  const offline = createRailwayServerProvider({
    config: RAILWAY_CONFIG,
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
    probeHealth: async () => ({ ok: true, serverPublicKey: SERVER_KEY }),
    acquireReceipt: async () => ({}),
  });
  await assert.rejects(offline.spawn({ onLine: () => {} }), { code: 'PROVIDER_UNREACHABLE' });
});

test('Railway status maps deployments to lifecycles and teardown is idempotent', async () => {
  const lifecycles = [
    ['BUILDING', 'provisioning'],
    ['SUCCESS', 'ready'],
    ['SLEEPING', 'ready'],
    ['FAILED', 'error'],
    ['NOT_A_STATUS', 'provisioning'],
  ];
  for (const [status, lifecycle] of lifecycles) {
    const { provider } = railwayProvider({
      RauhwpxLatestDeployment: { data: { deployments: { edges: [{ node: { id: 'd', status } }] } } },
    });
    const result = await provider.status(SANDBOX);
    assert.equal(result.lifecycle, lifecycle, `${status} maps to ${lifecycle}`);
    assert.equal(result.status, status);
  }

  const gone = railwayProvider({
    RauhwpxLatestDeployment: { body: { errors: [{ message: 'Service not found' }] } },
  });
  assert.deepEqual(await gone.provider.status(SANDBOX), {
    lifecycle: 'idle',
    status: 'REMOVED',
    message: 'This sandbox no longer exists.',
  });

  const removed = railwayProvider({ RauhwpxServiceDelete: { data: { serviceDelete: true } } });
  assert.deepEqual(await removed.provider.teardown(SANDBOX), { lifecycle: 'idle', removed: true });

  const already = railwayProvider({
    RauhwpxServiceDelete: { body: { errors: [{ message: 'Service does not exist' }] } },
  });
  assert.deepEqual(await already.provider.teardown(SANDBOX), { lifecycle: 'idle', removed: false });
});

test('the client remembers the chosen server mode and verifies bootstrap receipts', async () => {
  const vault = memoryVault();
  const responses = [];
  const client = new CloudClient({
    vault,
    fetchImpl: signedFetch(async () => responses.shift()),
  });
  assert.equal(await client.loadServerMode(), null);
  assert.equal(await client.saveServerMode('app-hosted'), 'app-hosted');
  assert.equal(await client.loadServerMode(), 'app-hosted');
  await assert.rejects(client.saveServerMode('fly'), /server mode/);
  await vault.set('cloud.server-mode', 'nonsense');
  assert.equal(await client.loadServerMode(), null, 'a corrupted mode falls back to no choice');

  const bootstrapRequest = {
    endpoint: 'https://sandbox-1.up.railway.app/rauhwpx-cloud',
    bootstrapToken: 'a'.repeat(43),
    deviceName: 'Rauhwpx desktop',
    serverPublicKey: SERVER_KEY,
  };
  const jsonBody = (value, status = 201) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  responses.push(jsonBody({ code: 'ABCD-EFGH-JKLM', serverPublicKey: SERVER_KEY }));
  assert.deepEqual(await client.bootstrapPairing(bootstrapRequest), {
    endpoint: 'https://sandbox-1.up.railway.app/rauhwpx-cloud',
    serverPublicKey: SERVER_KEY,
    pairingCode: 'ABCD-EFGH-JKLM',
  });

  responses.push(jsonBody({ code: 'ABCD-EFGH-JKLM', serverPublicKey: `ed25519:${'B'.repeat(59)}` }));
  await assert.rejects(client.bootstrapPairing(bootstrapRequest), { code: 'SERVER_IDENTITY_MISMATCH' });

  responses.push(jsonBody({ code: 'not-a-code', serverPublicKey: SERVER_KEY }));
  await assert.rejects(client.bootstrapPairing(bootstrapRequest), { code: 'BOOTSTRAP_RECEIPT_INVALID' });

  await assert.rejects(
    client.bootstrapPairing({ ...bootstrapRequest, serverPublicKey: 'ed25519:short' }),
    { code: 'SERVER_IDENTITY_INVALID' },
  );
  await assert.rejects(
    client.bootstrapPairing({ ...bootstrapRequest, bootstrapToken: 'short' }),
    { code: 'BOOTSTRAP_TOKEN_INVALID' },
  );
});

function appServerStub(overrides = {}) {
  const calls = { spawn: 0, teardown: 0, status: 0 };
  const provider = {
    id: overrides.id ?? 'railway',
    displayName: 'Railway sandbox',
    calls,
    configuration: overrides.configuration ?? (() => ({ configured: true, missing: [] })),
    spawn: overrides.spawn ?? (async () => {
      calls.spawn += 1;
      return {
        sandbox: SANDBOX,
        receipt: {
          endpoint: 'https://sandbox-1.up.railway.app/rauhwpx-cloud',
          serverPublicKey: SERVER_KEY,
          pairingCode: 'ABCD-EFGH-JKLM',
        },
      };
    }),
    status: overrides.status ?? (async () => {
      calls.status += 1;
      return { lifecycle: 'ready', status: 'SUCCESS', message: null };
    }),
    teardown: overrides.teardown ?? (async () => {
      calls.teardown += 1;
      return { lifecycle: 'idle', removed: true };
    }),
  };
  return provider;
}

function sandboxCoordinator({ provider = appServerStub(), records = [], vault = memoryVault(), appServers } = {}) {
  const client = new CloudClient({
    vault,
    fetchImpl: signedFetch(async (url) => {
      if (url.endsWith('/v1/pairing/redeem')) {
        return new Response(JSON.stringify({
          accessToken: 'sandbox-access',
          accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshToken: 'sandbox-refresh',
          device: { id: 'sandbox-device' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, serverPublicKey: SERVER_KEY }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  });
  const coordinator = new CloudCoordinator({
    client,
    store: { load: async () => records, list: async () => records },
    provisioner: {},
    recoveryDir: '/unused',
    appServers: appServers ?? [provider],
  });
  return { coordinator, client, provider, vault };
}

test('an unconfigured build advertises the app option without letting a spawn start', async () => {
  const provider = appServerStub({ configuration: () => ({ configured: false, missing: ['RAUHWpx_RAILWAY_TOKEN'] }) });
  const { coordinator } = sandboxCoordinator({ provider });
  const snapshot = await coordinator.start();
  assert.deepEqual(snapshot.server, {
    mode: null,
    preferredMode: null,
    providers: [{
      providerId: 'railway',
      displayName: 'Railway sandbox',
      configured: false,
      missingConfig: ['RAUHWpx_RAILWAY_TOKEN'],
    }],
    lifecycle: 'idle',
    message: null,
  });
  await assert.rejects(coordinator.spawnAppServer(), { code: 'PROVIDER_NOT_CONFIGURED' });
  assert.equal(provider.calls.spawn, 0);
  assert.equal((await coordinator.snapshot()).server.lifecycle, 'idle');

  const bare = new CloudCoordinator({
    client: { loadProfile: async () => null, isPaired: async () => false },
    store: { load: async () => [], list: async () => [] },
    provisioner: {},
    recoveryDir: '/unused',
  });
  await assert.rejects(bare.spawnAppServer(), { code: 'PROVIDER_UNAVAILABLE' });
});

test('concurrent spawns share one sandbox and the choice survives a restart', async () => {
  const vault = memoryVault();
  const { coordinator, provider, client } = sandboxCoordinator({ vault });
  await coordinator.start();
  const [first, second] = await Promise.all([coordinator.spawnAppServer(), coordinator.spawnAppServer()]);
  assert.equal(provider.calls.spawn, 1, 'a paid sandbox is never created twice');
  assert.equal(first, second);
  assert.equal(first.profile.kind, 'configured');
  assert.equal(first.profile.mode, 'app-hosted');
  assert.equal(first.profile.sandbox.sandboxId, 'service-1');
  assert.equal(first.profile.sandbox.displayName, 'Railway sandbox');
  assert.equal(first.server.mode, 'app-hosted');
  assert.equal(first.server.preferredMode, 'app-hosted');
  assert.equal(first.server.lifecycle, 'ready');
  assert.equal(await client.loadServerMode(), 'app-hosted');

  const reused = await coordinator.spawnAppServer();
  assert.equal(provider.calls.spawn, 1, 'a live sandbox is reused, not replaced');
  assert.equal(reused.server.lifecycle, 'ready');

  const restarted = sandboxCoordinator({ vault, provider });
  const resumed = await restarted.coordinator.start();
  assert.equal(resumed.server.preferredMode, 'app-hosted');
  assert.equal(resumed.server.lifecycle, 'ready');
  assert.equal(resumed.profile.mode, 'app-hosted');
});

test('a live sandbox cannot be abandoned by switching to a user server', async () => {
  const { coordinator } = sandboxCoordinator();
  await coordinator.start();
  await coordinator.spawnAppServer();
  const userProfile = {
    name: 'Office VPS',
    host: 'vps.example.ts.net',
    sshUser: 'cloud',
    sshPort: 22,
    tailscaleHttpsPort: 443,
    auth: { kind: 'ssh-agent' },
    transport: { kind: 'tailscale' },
    serverPublicKey: SERVER_KEY,
  };
  await assert.rejects(coordinator.saveProfile({ profile: userProfile }), { code: 'SANDBOX_STILL_ACTIVE' });
  await assert.rejects(coordinator.pair({ code: 'ABCD-EFGH-JKLM', profile: userProfile }), {
    code: 'SANDBOX_STILL_ACTIVE',
  });
  await assert.rejects(coordinator.provision({ profile: userProfile }), { code: 'SANDBOX_STILL_ACTIVE' });
  await assert.rejects(coordinator.provision(), /app, not installed over SSH/);
  await assert.rejects(coordinator.testProfile(), /no SSH check/);

  const snapshot = await coordinator.teardownAppServer();
  assert.equal(snapshot.profile.kind, 'unconfigured');
  assert.equal(snapshot.server.lifecycle, 'idle');
  await coordinator.saveProfile({ profile: userProfile });
  const saved = await coordinator.snapshot();
  assert.equal(saved.profile.mode, 'self-hosted');
  assert.equal(saved.server.preferredMode, 'self-hosted');
});

test('teardown protects live cloud work, forgets credentials, and repeats safely', async () => {
  const records = [{ id: 'handoff-1', state: 'running', resolvedAt: null }];
  const { coordinator, provider, vault } = sandboxCoordinator({ records });
  await coordinator.start();
  await coordinator.spawnAppServer();
  assert.equal(vault.values.has('cloud.refresh'), true);

  await assert.rejects(coordinator.teardownAppServer(), { code: 'SANDBOX_HAS_WORK' });
  assert.equal(provider.calls.teardown, 0);
  assert.equal((await coordinator.snapshot()).server.lifecycle, 'ready');

  const removed = await coordinator.teardownAppServer({ force: true });
  assert.equal(provider.calls.teardown, 1);
  assert.equal(removed.profile.kind, 'unconfigured');
  assert.equal(removed.server.mode, null);
  assert.equal(removed.server.lifecycle, 'idle');
  assert.equal(vault.values.has('cloud.refresh'), false, 'sandbox credentials do not outlive the sandbox');
  assert.equal(vault.values.has('cloud.profile'), false);

  const again = await coordinator.teardownAppServer();
  assert.equal(provider.calls.teardown, 1, 'a torn down sandbox is not torn down twice');
  assert.equal(again.server.lifecycle, 'idle');
});

test('a failed spawn reports an actionable lifecycle and stays retryable', async () => {
  let attempts = 0;
  const provider = appServerStub({
    spawn: async () => {
      attempts += 1;
      if (attempts === 1) throw new AppServerError('Railway deployment ended in CRASHED', { code: 'SANDBOX_DEPLOY_FAILED' });
      return {
        sandbox: SANDBOX,
        receipt: {
          endpoint: 'https://sandbox-1.up.railway.app/rauhwpx-cloud',
          serverPublicKey: SERVER_KEY,
          pairingCode: 'ABCD-EFGH-JKLM',
        },
      };
    },
  });
  const events = [];
  const { coordinator } = sandboxCoordinator({ provider });
  coordinator.on('event', (event) => events.push(event.type));
  await coordinator.start();
  await assert.rejects(coordinator.spawnAppServer(), { code: 'SANDBOX_DEPLOY_FAILED' });
  const failed = await coordinator.snapshot();
  assert.equal(failed.server.lifecycle, 'error');
  assert.match(failed.server.message, /CRASHED/);
  assert.ok(events.includes('sandbox-provision-failed'));

  const recovered = await coordinator.spawnAppServer();
  assert.equal(recovered.server.lifecycle, 'ready');
  assert.equal(recovered.server.message, null);
  assert.ok(events.includes('sandbox-ready'));
});

test('sandbox status refreshes the lifecycle from the provider', async () => {
  let lifecycle = 'ready';
  const provider = appServerStub({
    status: async () => ({ lifecycle, status: lifecycle === 'ready' ? 'SUCCESS' : 'CRASHED', message: lifecycle === 'ready' ? null : 'Railway reports CRASHED.' }),
  });
  const { coordinator } = sandboxCoordinator({ provider });
  await coordinator.start();
  assert.equal((await coordinator.appServerStatus()).server.lifecycle, 'idle', 'a user server has no sandbox status');
  await coordinator.spawnAppServer();
  assert.equal((await coordinator.appServerStatus()).server.lifecycle, 'ready');
  lifecycle = 'error';
  const broken = await coordinator.appServerStatus();
  assert.equal(broken.server.lifecycle, 'error');
  assert.match(broken.server.message, /CRASHED/);
});

test('a sandbox this build cannot manage still has a way out', async () => {
  const vault = memoryVault();
  const spawned = sandboxCoordinator({ vault });
  await spawned.coordinator.start();
  await spawned.coordinator.spawnAppServer();

  const stranger = sandboxCoordinator({ vault, appServers: [appServerStub({ id: 'fly' })] });
  const events = [];
  stranger.coordinator.on('event', (event) => events.push(event.type));
  const resumed = await stranger.coordinator.start();
  assert.equal(resumed.server.lifecycle, 'error', 'an unmanageable sandbox never reports itself ready');
  assert.match(resumed.server.message, /cannot manage the railway sandbox/);

  const status = await stranger.coordinator.appServerStatus();
  assert.equal(status.server.lifecycle, 'error');
  assert.match(status.profile.message, /provider console/);

  const released = await stranger.coordinator.teardownAppServer();
  assert.equal(released.profile.kind, 'unconfigured');
  assert.equal(released.server.lifecycle, 'idle');
  assert.equal(released.sandbox.unmanaged, true, 'the remote sandbox is not claimed to be removed');
  assert.equal(released.sandbox.removed, false);
  assert.ok(events.includes('sandbox-abandoned'));
  assert.equal(vault.values.has('cloud.refresh'), false);

  await stranger.coordinator.saveProfile({
    profile: {
      name: 'Office VPS',
      host: 'vps.example.ts.net',
      sshUser: 'cloud',
      sshPort: 22,
      tailscaleHttpsPort: 443,
      auth: { kind: 'ssh-agent' },
      transport: { kind: 'tailscale' },
      serverPublicKey: SERVER_KEY,
    },
  });
  assert.equal((await stranger.coordinator.snapshot()).profile.mode, 'self-hosted');
});

test('selecting a server mode persists before anything is provisioned', async () => {
  const vault = memoryVault();
  const { coordinator, client } = sandboxCoordinator({ vault });
  await coordinator.start();
  const chosen = await coordinator.selectServerMode('self-hosted');
  assert.equal(chosen.server.preferredMode, 'self-hosted');
  assert.equal(chosen.server.mode, null, 'nothing is configured yet');
  assert.equal(await client.loadServerMode(), 'self-hosted');
  await assert.rejects(coordinator.selectServerMode('fly'), /server mode/);
});

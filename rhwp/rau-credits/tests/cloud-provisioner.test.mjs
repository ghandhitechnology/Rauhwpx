import assert from 'node:assert/strict';
import test from 'node:test';
import { createRailwayCloudProvisioner } from '../cloud-provisioner.mjs';

const PUBLIC_KEY = `ed25519:${'A'.repeat(43)}`;
const RECEIPT = { code: 'ABCD-EFGH-JKLM', serverPublicKey: PUBLIC_KEY };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

function fixture(intercept = async () => undefined, options = {}) {
  let clock = 1_000_000;
  let exists = false;
  let serviceName;
  const calls = [];
  const remotes = [];
  const signals = [];
  const provisioner = createRailwayCloudProvisioner({
    config: {
      token: 'private-broker-token', projectId: 'project-1', environmentId: 'environment-1',
      apiUrl: 'https://railway.example/graphql', image: 'test-image',
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    requestTimeoutMs: 25,
    deploymentTimeoutMs: 20_000,
    healthTimeoutMs: 5_000,
    ...options,
    fetchImpl: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : {};
      const operation = body.query?.match(/(?:mutation|query) (\w+)/)?.[1]
        ?? (url.endsWith('/v1/health') ? 'health' : 'bootstrap');
      calls.push(operation);
      signals.push(init.signal);
      if (operation === 'RaucloudServiceCreate') {
        exists = true;
        serviceName = body.variables.input.name;
      }
      const intercepted = await intercept({ operation, body, init, url, calls, advance: (ms) => { clock += ms; } });
      if (intercepted !== undefined) return intercepted;
      if (operation === 'RaucloudServiceCreate') return json({ data: { serviceCreate: { id: 'service-1', name: serviceName } } });
      if (operation === 'RaucloudDomainCreate') return json({ data: { serviceDomainCreate: { id: 'domain-1', domain: 'worker.up.railway.app' } } });
      if (operation === 'RaucloudLatestDeployment') return json({ data: { deployments: { edges: [{ node: { status: 'SUCCESS' } }] } } });
      if (operation === 'RaucloudServiceDelete') { exists = false; return json({ data: { serviceDelete: true } }); }
      if (operation === 'RaucloudProjectServices') return json({ data: { project: { services: { edges: exists ? [{ node: { id: 'service-1', name: serviceName } }] : [] } } } });
      if (operation === 'health') return json({ ok: true, serverPublicKey: PUBLIC_KEY });
      if (operation === 'bootstrap') return json(RECEIPT);
      assert.fail(`Unexpected operation ${operation}`);
    },
  });
  return {
    provisioner, calls, signals, remotes,
    provision: () => provisioner.provision({
      runId: 'run-1', accountId: 'account-1', deviceId: 'device-1', workerToken: 'private-worker-token',
      onRemoteCreated: async (remote) => { remotes.push(structuredClone(remote)); },
    }),
  };
}

test('allocation persists remote ownership before deploying and returns a validated receipt', async () => {
  const setup = fixture();
  const result = await setup.provision();
  assert.equal(result.receipt.serverPublicKey, PUBLIC_KEY);
  assert.equal(result.receipt.pairingCode, RECEIPT.code);
  assert.equal(setup.remotes.length, 2);
  assert.equal(setup.remotes[0].serviceId, 'service-1');
  assert.equal(setup.remotes[0].domain, undefined);
  assert.equal(setup.remotes[1].domain, 'worker.up.railway.app');
  assert.ok(setup.signals.every((signal) => signal instanceof AbortSignal));
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('deployment polling survives repeated transient query failures without recreating the service', async () => {
  let failures = 4;
  const setup = fixture(async ({ operation }) => {
    if (operation === 'RaucloudLatestDeployment' && failures-- > 0) throw new TypeError('fetch failed');
  });
  await setup.provision();
  assert.equal(setup.calls.filter((call) => call === 'RaucloudServiceCreate').length, 1);
  assert.equal(setup.calls.filter((call) => call === 'RaucloudLatestDeployment').length, 5);
  assert.equal(setup.calls.includes('RaucloudServiceDelete'), false);
});

test('retryable HTTP responses can recover even when their body is not JSON', async () => {
  let failed = false;
  const setup = fixture(async ({ operation }) => {
    if (operation === 'RaucloudLatestDeployment' && !failed) {
      failed = true;
      return new Response('upstream unavailable', { status: 502 });
    }
  });
  await setup.provision();
  assert.equal(setup.calls.filter((call) => call === 'RaucloudLatestDeployment').length, 2);
});

test('an ambiguous create response is reconciled by name and never replayed', async () => {
  const setup = fixture(async ({ operation }) => {
    if (operation === 'RaucloudServiceCreate') throw new TypeError('lost create receipt');
  });
  await setup.provision();
  assert.equal(setup.calls.filter((call) => call === 'RaucloudServiceCreate').length, 1);
  assert.equal(setup.calls.filter((call) => call === 'RaucloudProjectServices').length, 1);
});

test('rejected credentials fail immediately without create reconciliation or retries', async () => {
  const setup = fixture(async () => new Response('Unauthorized', { status: 401 }));
  await assert.rejects(setup.provision(), { code: 'PROVIDER_UNAUTHORIZED' });
  assert.deepEqual(setup.calls, ['RaucloudServiceCreate']);
});

test('a stalled create response body times out and reconciles the accepted allocation', async () => {
  let aborted = false;
  const setup = fixture(async ({ operation, init }) => {
    if (operation !== 'RaucloudServiceCreate') return;
    return new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          controller.error(init.signal.reason);
        }, { once: true });
      },
    }));
  });
  await setup.provision();
  assert.equal(aborted, true);
  assert.equal(setup.calls.filter((call) => call === 'RaucloudServiceCreate').length, 1);
  assert.equal(setup.calls.includes('RaucloudProjectServices'), true);
});

for (const healthKind of ['malformed-key', 'unhealthy', 'late-response', 'never-responds']) {
  test(`${healthKind} health cannot produce a pairing receipt`, async () => {
    const setup = fixture(async ({ operation, init, advance }) => {
      if (operation !== 'health') return;
      if (healthKind === 'malformed-key') return json({ ok: true, serverPublicKey: 'ed25519:invalid' });
      if (healthKind === 'unhealthy') return json({ ok: false, serverPublicKey: PUBLIC_KEY }, 503);
      if (healthKind === 'late-response') {
        advance(5_001);
        return json({ ok: true, serverPublicKey: PUBLIC_KEY });
      }
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    });
    await assert.rejects(setup.provision(), { code: 'SANDBOX_UNHEALTHY' });
    assert.equal(setup.calls.includes('bootstrap'), false);
    assert.equal(setup.calls.includes('RaucloudServiceDelete'), true);
  });
}

test('a stalled bootstrap response body times out and tears down the unusable worker', async () => {
  const setup = fixture(async ({ operation, init }) => {
    if (operation !== 'bootstrap') return;
    return new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
    } }));
  });
  await assert.rejects(setup.provision(), { code: 'PROVIDER_UNREACHABLE' });
  assert.equal(setup.calls.filter((call) => call === 'bootstrap').length, 1);
  assert.equal(setup.calls.includes('RaucloudServiceDelete'), true);
});

test('oversized streamed provider responses are cancelled before buffering unbounded data', async () => {
  let cancelled = false;
  const setup = fixture(async ({ operation }) => {
    if (operation !== 'RaucloudLatestDeployment') return;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }));
  });
  await assert.rejects(setup.provision(), { code: 'PROVIDER_RESPONSE_INVALID' });
  assert.equal(cancelled, true);
  assert.equal(setup.calls.includes('RaucloudServiceDelete'), true);
});

test('orphan cleanup refreshes retained allocations after remote inventory', async () => {
  const setup = fixture();
  await setup.provision();
  const checked = [];
  const result = await setup.provisioner.reconcileRaucloud({
    keepServiceNames: [],
    shouldKeepService: async (service) => { checked.push(service.id); return true; },
  });
  assert.deepEqual(checked, ['service-1']);
  assert.equal(result.removed, 0);
  assert.equal(setup.calls.includes('RaucloudServiceDelete'), false);
});

test('orphan cleanup retains services if checking current allocation ownership fails', async () => {
  const setup = fixture();
  await setup.provision();
  const result = await setup.provisioner.reconcileRaucloud({
    shouldKeepService: async () => { throw new Error('State store temporarily unavailable'); },
  });
  assert.equal(result.removed, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(setup.calls.includes('RaucloudServiceDelete'), false);
});

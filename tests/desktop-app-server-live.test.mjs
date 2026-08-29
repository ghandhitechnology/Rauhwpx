// 앱 제공 서버 경로를 실제 컨트롤 플레인에 붙여 확인한다. Railway GraphQL만 대역하고
// 부트스트랩 페어링, 서명 검증, 프로필 활성화, 자격 증명 폐기는 모두 진짜 코드가 처리한다.
// 컨트롤 플레인은 Railway가 주입할 환경 변수와 같은 부트스트랩 토큰으로 뜬다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CloudClient } from '../desktop/cloud-client.mjs';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';
import { createRailwayServerProvider } from '../desktop/cloud-railway.mjs';
import { CloudApiTransport, SshTunnelManager } from '../desktop/cloud-ssh-tunnel.mjs';
import { parseConfig } from '../cloud/src/config.mjs';
import { createCloudRuntime } from '../cloud/src/runtime.mjs';

const SANDBOX_HOST = 'sandbox-live.up.railway.app';
const BASE_PATH = '/rauhwpx-cloud';

const RAILWAY_CONFIG = Object.freeze({
  token: 'railway-token',
  projectId: 'project-live',
  environmentId: 'environment-live',
  image: 'ghcr.io/example/rauhwpx-cloud:stable',
  region: '',
  apiUrl: 'https://backboard.railway.com/graphql/v2',
});

function memoryVault() {
  const values = new Map();
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); return true; },
    delete: async (key) => values.delete(key),
  };
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Railway 서비스가 받을 환경 변수로 실제 컨트롤 플레인을 띄운다. */
async function bootControlPlane(t, variables) {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-live-sandbox-'));
  const port = await availablePort();
  const config = parseConfig({
    RAUHWpx_DATA_DIR: dataDirectory,
    RAUHWpx_HOST: variables.RAUHWpx_HOST,
    RAUHWpx_PORT: String(port),
    RAUHWpx_BASE_PATH: variables.RAUHWpx_BASE_PATH,
    RAUHWpx_BOOTSTRAP_TOKEN: variables.RAUHWpx_BOOTSTRAP_TOKEN,
    RAUHWpx_MAX_RUNNING: variables.RAUHWpx_MAX_RUNNING,
    RAUHWpx_MAX_QUEUED: variables.RAUHWpx_MAX_QUEUED,
    RAUHWpx_RUNNER: 'local',
    // 작업 디렉터리는 0700 데이터 디렉터리 밖에 있어야 워커 uid가 지나갈 수 있다.
    RAUHWpx_WORKSPACE_ROOT: `${dataDirectory}-workspaces`,
    RAUHWpx_PROVIDER_CLI_DIR: path.join(dataDirectory, 'provider-cli'),
  });
  const runtime = createCloudRuntime(config, {
    runner: { list: async () => [], start: async () => '', stop: async () => {} },
  });
  const started = await runtime.start();
  t.after(async () => {
    await runtime.stop();
    await fs.rm(dataDirectory, { recursive: true, force: true });
    await fs.rm(config.workspaceRoot, { recursive: true, force: true });
  });
  return { config, runtime, started, origin: `http://127.0.0.1:${port}`, port };
}

async function liveHarness(t, { boot = true } = {}) {
  const deployStatus = { value: 'SUCCESS' };
  const calls = [];
  let plane = null;
  const desktopDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-live-desktop-'));
  t.after(() => fs.rm(desktopDirectory, { recursive: true, force: true }));

  const routes = {
    RauhwpxServiceCreate: async (variables) => {
      if (boot) plane = await bootControlPlane(t, variables.input.variables);
      return { data: { serviceCreate: { id: 'service-live', name: 'rauhwpx-sandbox-live' } } };
    },
    RauhwpxServiceDomainCreate: { data: { serviceDomainCreate: { id: 'domain-live', domain: SANDBOX_HOST } } },
    RauhwpxLatestDeployment: () => ({
      data: { deployments: { edges: [{ node: { id: 'deployment-live', status: deployStatus.value } }] } },
    }),
    RauhwpxServiceDelete: { data: { serviceDelete: true } },
  };
  const railwayFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const name = body.query.match(/(?:mutation|query)\s+(\w+)/)[1];
    calls.push({ name, variables: body.variables });
    const route = routes[name];
    if (!route) throw new Error(`unexpected Railway call: ${name}`);
    const payload = typeof route === 'function' ? await route(body.variables) : route;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  // 샌드박스 도메인으로 향한 요청만 로컬 컨트롤 플레인으로 돌린다. 경로는 그대로 두어 응답 서명이 유효하다.
  const sandboxFetch = (input, options) => {
    const requested = new URL(typeof input === 'string' ? input : input.url);
    assert.equal(requested.hostname, SANDBOX_HOST, 'the desktop only talks to the sandbox domain');
    if (!plane) throw new TypeError('fetch failed');
    return fetch(new URL(`${requested.pathname}${requested.search}`, plane.origin), options);
  };

  const vault = memoryVault();
  const client = new CloudClient({
    vault,
    fetchImpl: sandboxFetch,
    transport: new CloudApiTransport({
      tunnelManager: new SshTunnelManager({
        knownHostsPath: path.join(desktopDirectory, 'ssh-known-hosts'),
      }),
    }),
  });
  const provider = createRailwayServerProvider({
    config: RAILWAY_CONFIG,
    fetchImpl: railwayFetch,
    probeHealth: (endpoint, options) => client.probeEndpointHealth(endpoint, options),
    acquireReceipt: (request) => client.bootstrapPairing(request),
    sleep: async () => {},
    deployTimeoutMs: boot ? 5_000 : 200,
    healthTimeoutMs: boot ? 5_000 : 0,
  });
  const coordinator = new CloudCoordinator({
    client,
    store: { load: async () => [], list: async () => [] },
    provisioner: {},
    recoveryDir: path.join(desktopDirectory, 'recovery'),
    appServers: [provider],
  });
  return {
    client,
    coordinator,
    provider,
    vault,
    deployStatus,
    names: () => calls.map((call) => call.name),
    createVariables: () => calls.find((call) => call.name === 'RauhwpxServiceCreate')?.variables.input.variables,
    plane: () => plane,
  };
}

test('the app-provided path pairs against a real control plane and closes bootstrap for good', async (t) => {
  const live = await liveHarness(t);
  await live.coordinator.start();
  assert.equal(await live.client.isPaired(), false);

  const ready = await live.coordinator.spawnAppServer({ deviceName: 'Rauhwpx integration' });
  const plane = live.plane();
  assert.equal(live.createVariables().RAUHWpx_PORT, '7740', 'the image listens where the domain points');
  assert.equal(plane.config.runner, 'local', 'the app sandbox runs sessions inside its own container');
  assert.match(plane.started.serverPublicKey, /^ed25519:[A-Za-z0-9_-]{59}$/);

  assert.equal(ready.profile.kind, 'configured');
  assert.equal(ready.profile.mode, 'app-hosted');
  assert.equal(ready.profile.connection, 'ready');
  assert.equal(ready.profile.sandbox.host, SANDBOX_HOST);
  assert.equal(ready.profile.sandbox.sandboxId, 'service-live');
  assert.equal(ready.server.lifecycle, 'ready');
  assert.equal(ready.server.mode, 'app-hosted');
  assert.equal(ready.server.preferredMode, 'app-hosted');
  assert.deepEqual(live.names(), [
    'RauhwpxServiceCreate',
    'RauhwpxServiceDomainCreate',
    'RauhwpxLatestDeployment',
  ]);

  assert.equal(await live.client.isPaired(), true, 'the bootstrap code produced real device tokens');
  const profile = await live.client.profile();
  assert.equal(profile.devices.some((device) => device.name === 'Rauhwpx integration'), true);

  // 다른 기기가 같은 토큰으로 끼어들 수 없어야 한다.
  const closed = await fetch(`${plane.origin}${BASE_PATH}/v1/pairing/bootstrap`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${plane.config.bootstrapToken}`,
      'content-type': 'application/json',
      'x-rauhwpx-request-nonce': randomBytes(24).toString('base64url'),
    },
    body: JSON.stringify({ deviceName: 'Second desktop' }),
  });
  assert.equal(closed.status, 409);
  assert.equal((await closed.json()).error.code, 'BOOTSTRAP_CLOSED');

  assert.equal((await live.coordinator.appServerStatus()).server.lifecycle, 'ready');
  live.deployStatus.value = 'CRASHED';
  const crashed = await live.coordinator.appServerStatus();
  assert.equal(crashed.server.lifecycle, 'error');
  assert.match(crashed.server.message, /CRASHED/);

  const removed = await live.coordinator.teardownAppServer();
  assert.equal(removed.profile.kind, 'unconfigured');
  assert.equal(removed.server.lifecycle, 'idle');
  assert.equal(live.names().at(-1), 'RauhwpxServiceDelete');
  assert.equal(live.vault.values.has('cloud.refresh'), false, 'sandbox tokens do not outlive the sandbox');
  assert.equal(await live.client.isPaired(), false);
});

test('a sandbox that never answers is deleted and leaves the desktop unconfigured', async (t) => {
  const live = await liveHarness(t, { boot: false });
  await live.coordinator.start();
  await assert.rejects(live.coordinator.spawnAppServer(), { code: 'SANDBOX_UNHEALTHY' });
  assert.equal(live.names().at(-1), 'RauhwpxServiceDelete', 'the paid service is removed');
  const snapshot = await live.coordinator.snapshot();
  assert.equal(snapshot.profile.kind, 'unconfigured');
  assert.equal(snapshot.server.lifecycle, 'error');
  assert.equal(live.vault.values.has('cloud.profile'), false);
});

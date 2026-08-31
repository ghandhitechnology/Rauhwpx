import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createCloudController, parseCloudSnapshot } from '../src/cloud/desktop-cloud.ts';
import type { CloudSnapshot } from '../src/cloud/types.ts';
import {
  appServerProvider,
  createCloudSetupState,
  mapCloudSetupIssue,
  mapSandboxIssue,
  RAUCLOUD_SETUP_WAIT_MINUTES,
  reconcileCloudSetupState,
  raucloudSetupElapsed,
  snapshotProfile,
  snapshotSandbox,
} from '../src/ui/agent-sidebar/cloud-onboarding-state.ts';

const onboarding = readFileSync(new URL('../src/ui/agent-sidebar/cloud-onboarding.ts', import.meta.url), 'utf8');
const onboardingCss = readFileSync(new URL('../src/ui/agent-sidebar/cloud-onboarding.css', import.meta.url), 'utf8');
const cloudUi = readFileSync(new URL('../src/ui/agent-sidebar/cloud-ui.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../../../desktop/preload.cjs', import.meta.url), 'utf8');
const desktopMain = readFileSync(new URL('../../../desktop/main.mjs', import.meta.url), 'utf8');

const SANDBOX = {
  providerId: 'railway',
  sandboxId: 'service-1',
  displayName: 'Railway sandbox',
  region: 'us-east4-eqdc4a',
  host: 'sandbox-1.up.railway.app',
  createdAt: '2026-08-24T00:00:00.000Z',
};

const RAILWAY_PROVIDER = {
  providerId: 'railway',
  displayName: 'Railway sandbox',
  configured: true,
  missingConfig: [],
};

const userProfile = {
  name: 'Office VPS',
  host: 'vps.example.ts.net',
  sshUser: 'cloud',
  sshPort: 22,
  tailscaleHttpsPort: 443,
  auth: { kind: 'ssh-agent' as const },
  transport: { kind: 'tailscale' as const },
};

function snapshot(overrides: Partial<CloudSnapshot> = {}): CloudSnapshot {
  return {
    revision: 1,
    profileEpoch: 1,
    available: true,
    profile: { kind: 'unconfigured' },
    server: { mode: null, preferredMode: null, providers: [], lifecycle: 'idle', message: null },
    lease: { owner: 'local' },
    session: { kind: 'idle' },
    sessions: [],
    queuedMessages: [],
    timeline: null,
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

function appHosted(lifecycle: CloudSnapshot['server']['lifecycle'], connection: 'ready' | 'error' = 'ready'): CloudSnapshot {
  return snapshot({
    profile: {
      kind: 'configured',
      mode: 'app-hosted',
      name: 'Railway sandbox',
      sandbox: SANDBOX,
      connection,
      serviceVersion: null,
      message: connection === 'error' ? 'sandbox is unreachable' : null,
    },
    server: {
      mode: 'app-hosted',
      preferredMode: 'app-hosted',
      providers: [RAILWAY_PROVIDER],
      lifecycle,
      message: lifecycle === 'error' ? 'Railway reports CRASHED.' : null,
    },
  });
}

test('the parser keeps app sandboxes, user hosts, and legacy snapshots apart', () => {
  const appSnapshot = parseCloudSnapshot({
    revision: 4,
    profileEpoch: 2,
    available: true,
    profile: {
      kind: 'configured',
      mode: 'app-hosted',
      name: 'Railway sandbox',
      sandbox: SANDBOX,
      connection: 'ready',
      serviceVersion: null,
      message: null,
    },
    server: {
      mode: 'app-hosted',
      preferredMode: 'app-hosted',
      providers: [RAILWAY_PROVIDER],
      lifecycle: 'ready',
      message: null,
    },
    lease: { owner: 'local' },
    session: { kind: 'idle' },
    queuedMessages: [],
    timeline: null,
    updatedAt: '2026-08-24T00:00:00.000Z',
  });
  assert.equal(appSnapshot?.profile.kind, 'configured');
  assert.equal(appSnapshot?.profile.kind === 'configured' ? appSnapshot.profile.mode : null, 'app-hosted');
  assert.deepEqual(appSnapshot?.server.providers, [RAILWAY_PROVIDER]);
  assert.equal(snapshotSandbox(appSnapshot!)?.sandbox.host, 'sandbox-1.up.railway.app');
  assert.equal(snapshotProfile(appSnapshot!), undefined, 'a sandbox never fills the SSH form');

  const legacy = parseCloudSnapshot({
    revision: 1,
    profileEpoch: 1,
    available: true,
    profile: {
      kind: 'configured',
      profile: userProfile,
      connection: 'ready',
      serviceVersion: '1.0.0',
      message: null,
    },
    lease: { owner: 'local' },
    session: { kind: 'idle' },
    queuedMessages: [],
    timeline: null,
    updatedAt: '2026-08-24T00:00:00.000Z',
  });
  assert.equal(legacy?.profile.kind === 'configured' ? legacy.profile.mode : null, 'self-hosted');
  assert.deepEqual(legacy?.server, {
    mode: 'self-hosted',
    preferredMode: null,
    providers: [],
    lifecycle: 'idle',
    message: null,
  });

  const base = {
    revision: 1,
    profileEpoch: 1,
    available: true,
    profile: { kind: 'unconfigured' },
    lease: { owner: 'local' },
    session: { kind: 'idle' },
    queuedMessages: [],
    timeline: null,
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
  assert.equal(parseCloudSnapshot({
    ...base,
    server: { mode: null, preferredMode: null, providers: [], lifecycle: 'melting', message: null },
  }), null);
  assert.equal(parseCloudSnapshot({
    ...base,
    server: { mode: null, preferredMode: null, providers: [{ providerId: '' }], lifecycle: 'idle', message: null },
  }), null);

  // 철거가 원격 서버를 실제로 지웠는지는 사용자에게 알려야 한다.
  const idleServer = { mode: null, preferredMode: null, providers: [], lifecycle: 'idle', message: null };
  assert.deepEqual(
    parseCloudSnapshot({ ...base, server: idleServer, sandbox: { ok: true, removed: false, unmanaged: true } })?.sandbox,
    { removed: false, unmanaged: true },
  );
  assert.deepEqual(
    parseCloudSnapshot({ ...base, server: idleServer, sandbox: { ok: true, removed: true } })?.sandbox,
    { removed: true, unmanaged: false },
  );
  assert.equal(parseCloudSnapshot({ ...base, server: idleServer })?.sandbox, undefined);
  assert.equal(parseCloudSnapshot({
    ...base,
    profile: {
      kind: 'configured',
      mode: 'app-hosted',
      name: 'Railway sandbox',
      sandbox: { ...SANDBOX, sandboxId: '' },
      connection: 'ready',
      serviceVersion: null,
      message: null,
    },
    server: { mode: 'app-hosted', preferredMode: null, providers: [], lifecycle: 'ready', message: null },
  }), null);
});

test('the controller forwards every server mode call to its own IPC channel', async () => {
  const calls: Array<[string, unknown]> = [];
  const accepted = {
    ...snapshot({ revision: 9 }),
    profile: { kind: 'unconfigured' as const },
  };
  const api = {
    cloudSelectServerMode: async (payload: unknown) => { calls.push(['select', payload]); return accepted; },
    cloudSpawnSandbox: async (payload: unknown) => { calls.push(['spawn', payload]); return accepted; },
    cloudSandboxStatus: async () => { calls.push(['status', undefined]); return accepted; },
    cloudTeardownSandbox: async (payload: unknown) => { calls.push(['teardown', payload]); return accepted; },
  };
  const controller = createCloudController(api as never);
  await controller.selectServerMode('app-hosted');
  await controller.spawnSandbox('railway');
  await controller.spawnSandbox();
  await controller.sandboxStatus();
  await controller.teardownSandbox();
  await controller.teardownSandbox({ force: true });
  assert.deepEqual(calls, [
    ['select', { mode: 'app-hosted' }],
    ['spawn', { providerId: 'railway' }],
    ['spawn', {}],
    ['status', undefined],
    ['teardown', { force: false }],
    ['teardown', { force: true }],
  ]);

  const bare = createCloudController({} as never);
  await assert.rejects(bare.spawnSandbox(), /클라우드 에이전트를 지원하지 않습니다/);
  controller.dispose();
});

test('setup opens on the server choice and defaults to what this build can actually do', () => {
  const bare = createCloudSetupState(snapshot(), 'manage');
  assert.equal(bare.kind, 'choose');
  assert.equal(bare.kind === 'choose' ? bare.mode : null, 'self-hosted');
  assert.equal(appServerProvider(snapshot()), null);

  const offered = createCloudSetupState(
    snapshot({ server: { mode: null, preferredMode: null, providers: [RAILWAY_PROVIDER], lifecycle: 'idle', message: null } }),
    'transfer',
  );
  assert.equal(offered.kind === 'choose' ? offered.mode : null, 'app-hosted');

  const remembered = createCloudSetupState(
    snapshot({
      server: {
        mode: null,
        preferredMode: 'self-hosted',
        providers: [RAILWAY_PROVIDER],
        lifecycle: 'idle',
        message: null,
      },
    }),
    'manage',
  );
  assert.equal(remembered.kind === 'choose' ? remembered.mode : null, 'self-hosted');

  const unavailable = snapshot({
    server: {
      mode: null,
      preferredMode: 'app-hosted',
      providers: [{ ...RAILWAY_PROVIDER, configured: false, missingConfig: ['RAUHWpx_RAILWAY_TOKEN'] }],
      lifecycle: 'idle',
      message: null,
    },
  });
  assert.equal(appServerProvider(unavailable)?.configured, false);
});

test('a configured server skips the choice and lands on its own screen', () => {
  const ready = snapshot({
    profile: {
      kind: 'configured',
      mode: 'self-hosted',
      profile: userProfile,
      connection: 'ready',
      serviceVersion: '1.0.0',
      message: null,
    },
  });
  assert.equal(createCloudSetupState(ready, 'manage').kind, 'connected');

  const broken = snapshot({
    profile: {
      kind: 'configured',
      mode: 'self-hosted',
      profile: userProfile,
      connection: 'error',
      serviceVersion: null,
      message: 'No route to host',
    },
  });
  const introState = createCloudSetupState(broken, 'manage');
  assert.equal(introState.kind, 'intro', 'a broken user server is repaired, not re-chosen');
  assert.equal(introState.kind === 'intro' ? introState.draft.host : null, 'vps.example.ts.net');

  assert.equal(createCloudSetupState(appHosted('ready'), 'manage').kind, 'sandbox-ready');
  assert.equal(createCloudSetupState(appHosted('tearing-down'), 'manage').kind, 'sandbox-tearing-down');
  assert.equal(createCloudSetupState(appHosted('provisioning'), 'manage').kind, 'sandbox-provisioning');

  const failed = createCloudSetupState(appHosted('error'), 'manage');
  assert.equal(failed.kind, 'sandbox-failed');
  assert.equal(failed.kind === 'sandbox-failed' ? failed.phase : null, 'spawn');
  assert.equal(failed.kind === 'sandbox-failed' ? failed.issue.title : null, '샌드박스를 시작하지 못했습니다');
});

test('Raucloud setup exposes a readable 30-minute progress window', () => {
  const startedAt = Date.UTC(2026, 7, 31, 12, 0, 0);
  assert.equal(RAUCLOUD_SETUP_WAIT_MINUTES, 30);
  assert.equal(raucloudSetupElapsed(startedAt, startedAt), '0초');
  assert.equal(raucloudSetupElapsed(startedAt, startedAt + 61_000), '1분 1초');
});

test('sandbox screens follow the snapshot without losing an in-flight teardown', () => {
  const ready = createCloudSetupState(appHosted('ready'), 'manage');
  assert.equal(reconcileCloudSetupState(ready, appHosted('ready')), ready, 'a steady sandbox does not rerender');

  const tearing = { kind: 'sandbox-tearing-down' as const, intent: 'manage' as const, name: 'Railway sandbox' };
  assert.equal(reconcileCloudSetupState(tearing, appHosted('tearing-down')), tearing);
  assert.equal(reconcileCloudSetupState(tearing, snapshot()).kind, 'choose', 'a removed sandbox returns to the choice');

  const replaced = reconcileCloudSetupState(ready, appHosted('ready') && snapshot({
    profile: {
      kind: 'configured',
      mode: 'app-hosted',
      name: 'Railway sandbox',
      sandbox: { ...SANDBOX, sandboxId: 'service-2', host: 'sandbox-2.up.railway.app' },
      connection: 'ready',
      serviceVersion: null,
      message: null,
    },
    server: {
      mode: 'app-hosted',
      preferredMode: 'app-hosted',
      providers: [RAILWAY_PROVIDER],
      lifecycle: 'ready',
      message: null,
    },
  }));
  assert.equal(replaced.kind === 'sandbox-ready' ? replaced.sandbox.sandboxId : null, 'service-2');

  const connected = { kind: 'connected' as const, profile: userProfile, intent: 'manage' as const };
  assert.equal(reconcileCloudSetupState(connected, appHosted('ready')).kind, 'sandbox-ready');
  assert.equal(reconcileCloudSetupState(ready, appHosted('error')).kind, 'sandbox-failed');

  const provisioning = createCloudSetupState(appHosted('provisioning'), 'manage');
  assert.equal(reconcileCloudSetupState(provisioning, appHosted('provisioning')), provisioning);
  assert.equal(reconcileCloudSetupState(provisioning, appHosted('ready')).kind, 'sandbox-ready');
  assert.equal(reconcileCloudSetupState(provisioning, appHosted('error')).kind, 'sandbox-failed');
});

test('app server failures read as something the user can act on', () => {
  assert.equal(
    mapSandboxIssue(new Error('App-provided servers are not configured on this build: RAUHWpx_RAILWAY_TOKEN')).title,
    'Raucloud가 아직 준비되지 않았습니다',
  );
  assert.equal(
    mapSandboxIssue(new Error('This build does not include app-provided servers')).title,
    '이 빌드에는 Raucloud가 없습니다',
  );
  assert.equal(mapSandboxIssue(new Error('Railway rejected the configured API token')).title, '앱 서버 자격 증명이 거부되었습니다');
  assert.equal(mapSandboxIssue(new Error('Railway API is unreachable: fetch failed')).title, '앱 서버에 연결할 수 없습니다');
  assert.equal(mapSandboxIssue(new Error('Railway deployment ended in CRASHED')).title, '샌드박스를 시작하지 못했습니다');
  assert.equal(mapSandboxIssue(new Error('App sandbox did not answer its health check')).title, '샌드박스가 응답하지 않습니다');
  assert.equal(
    mapSandboxIssue(new Error('Finish or cancel the cloud work on this sandbox before shutting it down.')).title,
    '진행 중인 클라우드 작업이 있습니다',
  );
  assert.equal(mapSandboxIssue(new Error('App sandbox failed identity verification')).title, '샌드박스 ID를 확인하지 못했습니다');
  assert.equal(mapSandboxIssue(new Error('something else')).title, 'Raucloud를 준비하지 못했습니다');

  // 이 빌드가 다룰 수 없는 샌드박스는 종료로 연결을 놓고 콘솔에서 직접 지워야 한다.
  const unmanaged = mapSandboxIssue(new Error(
    'This app cannot manage the railway sandbox at sandbox-1.up.railway.app. Release it here, then delete the server in the provider console.',
  ));
  assert.equal(unmanaged.title, '이 앱이 관리할 수 없는 샌드박스입니다');
  assert.match(unmanaged.guidance, /공급자 콘솔/);

  // 내 서버로 옮기려다 막힌 사용자는 SSH 오류가 아니라 샌드박스 종료 안내를 받아야 한다.
  assert.equal(
    mapCloudSetupIssue(new Error('Shut down the app-provided sandbox before connecting your own server.')).title,
    '앱 샌드박스를 먼저 종료하세요',
  );
});

test('the dialog offers both servers and only restorable sandbox actions', () => {
  assert.match(onboarding, /Cloud 서버 선택/);
  assert.match(onboarding, /Raucloud/);
  assert.match(onboarding, /내 서버 사용/);
  assert.match(onboarding, /role', 'radiogroup'/);
  assert.match(onboarding, /dataset\.serverMode = mode/);
  assert.match(onboarding, /controller\.selectServerMode\(mode\)/);
  assert.match(onboarding, /controller\.spawnSandbox\(providerId\)/);
  assert.match(onboarding, /controller\.teardownSandbox\(\)/);
  assert.match(onboarding, /controller\.sandboxStatus\(\)/);
  assert.doesNotMatch(onboarding, /controller\.takeoverSandbox\(\)/);
  assert.match(onboarding, /그 기기에서 작업을 마친 뒤 계속할 수 있습니다/);
  assert.match(onboarding, /남은 서버는 공급자 콘솔에서 직접 삭제하세요/);
  // 놓고 온 유료 서버는 화면에 보여야 한다. 스크린 리더 전용 안내로는 부족하다.
  assert.match(onboarding, /state\.notice.*callout\('cloud', '남은 서버를 확인하세요', state\.notice\)/);
  assert.match(onboarding, /'Raucloud를 종료하지 못했습니다'\n\s*: 'Raucloud를 준비하지 못했습니다'/);
  assert.match(onboarding, /운영자가 \$\{provider\.missingConfig\.join\(', '\)\}/);
  assert.match(onboarding, /state\.kind !== 'sandbox-intro' && state\.kind !== 'sandbox-failed'/);
  assert.match(onboarding, /kind: 'sandbox-provisioning'/);
  assert.match(onboarding, /\$\{raucloudSetupElapsed\(startedAt\)\}, 초기 설정에서는 최대 \$\{RAUCLOUD_SETUP_WAIT_MINUTES\}분/);
  assert.match(onboarding, /진행 보기/);
  assert.match(onboarding, /Raucloud를 종료하고 있습니다/);
  assert.match(onboarding, /Raucloud · /);
  assert.match(onboardingCss, /\.ag-cloud-setup-option\.ag-selected/);
  assert.match(cloudUi, /appHosted/);
  assert.match(cloudUi, /setupActive \? '준비 중' : 'Cloud'/);
  assert.match(cloudUi, /if \(setupActive\) \{\n\s+onboarding\.open\('transfer', trigger\)/);
  assert.match(preload, /cloudSelectServerMode: \(payload\) => ipcRenderer\.invoke\('cloud:select-server-mode', payload\)/);
  assert.match(preload, /cloudSpawnSandbox: \(payload\) => ipcRenderer\.invoke\('cloud:spawn-sandbox', payload\)/);
  assert.match(preload, /cloudSandboxStatus: \(\) => ipcRenderer\.invoke\('cloud:sandbox-status'\)/);
  assert.match(preload, /cloudTeardownSandbox: \(payload\) => ipcRenderer\.invoke\('cloud:teardown-sandbox', payload\)/);
  assert.match(preload, /cloudTakeoverSandbox: \(\) => ipcRenderer\.invoke\('cloud:takeover-sandbox'\)/);
  for (const channel of ['cloud:select-server-mode', 'cloud:spawn-sandbox', 'cloud:sandbox-status', 'cloud:teardown-sandbox', 'cloud:takeover-sandbox']) {
    assert.match(desktopMain, new RegExp(`ipcMain\\.handle\\('${channel}'`));
  }
  assert.match(desktopMain, /createRaucloudBrokerProvider\(\{/);
  assert.match(desktopMain, /getAccessToken: \(\) => secretVault\.get\(RAUCLOUD_ACCESS_SECRET\)/);
  assert.doesNotMatch(desktopMain, /createRailwayServerProvider\(\{/);
});

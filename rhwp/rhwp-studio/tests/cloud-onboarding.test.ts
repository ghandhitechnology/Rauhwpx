import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createCloudSetupState,
  defaultCloudProfileDraft,
  mapCloudSetupIssue,
  reconcileCloudSetupState,
  validateCloudProfileDraft,
} from '../src/ui/agent-sidebar/cloud-onboarding-state.ts';

const baseSnapshot = {
  revision: 1,
  available: true,
  profile: { kind: 'unconfigured' as const },
  server: {
    mode: null,
    preferredMode: null,
    providers: [],
    lifecycle: 'idle' as const,
    message: null,
  },
  lease: { owner: 'local' as const },
  session: { kind: 'idle' as const },
  sessions: [],
  queuedMessages: [],
  timeline: null,
  updatedAt: '2026-08-24T00:00:00.000Z',
};

const profile = {
  name: 'Office VPS',
  host: 'rauhwpx-vps.tailnet.ts.net',
  sshUser: 'ubuntu',
  sshPort: 22,
  tailscaleHttpsPort: 443,
  auth: { kind: 'ssh-agent' as const },
  transport: { kind: 'tailscale' as const },
};

test('new setup defaults are consumer-ready and fixed to Tailscale', () => {
  assert.deepEqual(defaultCloudProfileDraft(), {
    name: 'My VPS',
    host: '',
    sshUser: 'ubuntu',
    sshPort: 22,
    tailscaleHttpsPort: 443,
    auth: { kind: 'ssh-agent' },
    transport: { kind: 'tailscale' },
  });
  assert.deepEqual(validateCloudProfileDraft(profile), {});
});

test('profile validation reports fields without discarding the draft', () => {
  const invalid = {
    ...profile,
    host: 'https://vps.example.com/path',
    sshUser: 'bad user',
    sshPort: 70_000,
    tailscaleHttpsPort: 0,
    auth: { kind: 'key-file' as const, keyPath: '' },
  };
  const errors = validateCloudProfileDraft(invalid);
  assert.deepEqual(Object.keys(errors).sort(), ['host', 'keyPath', 'sshPort', 'sshUser', 'tailscaleHttpsPort']);
  assert.equal(invalid.host, 'https://vps.example.com/path');
  assert.ok(validateCloudProfileDraft({ ...profile, sshUser: 'bad.user' }).sshUser);
  assert.ok(validateCloudProfileDraft({ ...profile, name: 'x'.repeat(81) }).name);
  assert.ok(validateCloudProfileDraft({ ...profile, host: 'example.com' }).host);
  assert.ok(validateCloudProfileDraft({ ...profile, host: '100.064.0.1' }).host);
  assert.deepEqual(validateCloudProfileDraft({ ...profile, host: '100.100.0.1' }), {});
  assert.ok(validateCloudProfileDraft({
    ...profile,
    auth: { kind: 'key-file' as const, keyPath: `bad\0path` },
  }).keyPath);
});

test('advanced public HTTPS profiles require a safe endpoint', () => {
  const publicProfile = {
    ...profile,
    host: 'vps.example.com',
    transport: { kind: 'https' as const, endpoint: 'https://cloud.example.com/rauhwpx-cloud' },
  };
  assert.deepEqual(validateCloudProfileDraft(publicProfile), {});
  assert.ok(validateCloudProfileDraft({
    ...publicProfile,
    transport: { kind: 'https' as const, endpoint: 'https://user:secret@cloud.example.com/rauhwpx-cloud' },
  }).endpoint);
});

test('existing environment requires a pinned identity and exact pairing code', () => {
  const missing = validateCloudProfileDraft(profile, { existing: true, pairingCode: '1234' });
  assert.ok(missing.serverPublicKey);
  assert.ok(missing.pairingCode);

  const complete = validateCloudProfileDraft({
    ...profile,
    serverPublicKey: `ed25519:${'A'.repeat(59)}`,
  }, { existing: true, pairingCode: 'ABCD-EFGH-JKLM' });
  assert.deepEqual(complete, {});
});

test('setup issues turn backend failures into actionable Korean guidance', () => {
  assert.equal(mapCloudSetupIssue(new Error('Permission denied (publickey)')).title, 'SSH 인증에 실패했습니다');
  assert.match(
    mapCloudSetupIssue(new Error('Permission denied (publickey)')).guidance,
    /OpenSSH 인증 에이전트 서비스/,
  );
  assert.equal(mapCloudSetupIssue(new Error('spawn ssh ENOENT')).title, '이 기기에 OpenSSH 클라이언트가 없습니다');
  assert.match(mapCloudSetupIssue(new Error('spawn ssh ENOENT')).guidance, /선택 기능/);
  assert.equal(mapCloudSetupIssue(new Error('passwordless sudo is required')).title, '비밀번호 없는 sudo가 필요합니다');
  assert.equal(mapCloudSetupIssue(new Error('tailscale is not connected')).title, 'VPS의 Tailscale을 확인하세요');
  assert.match(mapCloudSetupIssue(new Error('No route to host'), 'https').guidance, /방화벽과 HTTPS/);
  assert.equal(mapCloudSetupIssue(new Error('Provisioned cloud service failed identity verification')).title, '서버 ID를 확인하지 못했습니다');
  const missingRelease = mapCloudSetupIssue(new Error('ssh exited with 22: curl: (22) The requested URL returned error: 404'));
  assert.equal(missingRelease.title, 'Cloud 설치 파일을 찾을 수 없습니다');
  assert.match(missingRelease.guidance, /앱을 업데이트하거나 잠시 후/);
  const missingMagicDns = mapCloudSetupIssue(new Error('net::ERR_NAME_NOT_RESOLVED'), 'tailscale');
  assert.equal(missingMagicDns.title, 'Tailscale DNS를 켜 주세요');
  assert.match(missingMagicDns.guidance, /Accept DNS/);
  assert.equal(mapCloudSetupIssue(new TypeError('fetch failed'), 'tailscale').title, 'Tailscale DNS를 켜 주세요');
  assert.equal(mapCloudSetupIssue(new Error('unexpected failure')).detail, 'unexpected failure');
});

test('ready profiles open as connected while active drafts ignore snapshot refreshes', () => {
  const readySnapshot = {
    ...baseSnapshot,
    profile: {
      kind: 'configured' as const,
      mode: 'self-hosted' as const,
      profile,
      connection: 'ready' as const,
      serviceVersion: '1.0.0',
      message: null,
    },
  };
  assert.equal(createCloudSetupState(readySnapshot, 'manage').kind, 'connected');
  const connected = createCloudSetupState(readySnapshot, 'manage');
  assert.equal(reconcileCloudSetupState(connected, readySnapshot), connected);

  const editing = {
    kind: 'editing' as const,
    draft: { ...profile, host: 'draft-vps.tailnet.ts.net' },
    intent: 'transfer' as const,
    errors: {},
  };
  const reconciled = reconcileCloudSetupState(editing, readySnapshot);
  assert.equal(reconciled, editing);
  assert.equal(reconciled.draft.host, 'draft-vps.tailnet.ts.net');

  const disconnected = reconcileCloudSetupState(
    { kind: 'connected', profile, intent: 'manage' },
    { ...readySnapshot, profile: { ...readySnapshot.profile, connection: 'error' as const } },
  );
  assert.equal(disconnected.kind, 'intro');
});

test('configured public HTTPS profiles are preserved when Manage opens', () => {
  const publicProfile = {
    ...profile,
    transport: { kind: 'https' as const, endpoint: 'https://cloud.example.com/rauhwpx' },
  };
  const readySnapshot = {
    ...baseSnapshot,
    profile: {
      kind: 'configured' as const,
      mode: 'self-hosted' as const,
      profile: publicProfile,
      connection: 'ready' as const,
      serviceVersion: '1.0.0',
      message: null,
    },
  };
  const state = createCloudSetupState(readySnapshot, 'manage');
  assert.equal(state.kind, 'connected');
  assert.deepEqual(state.kind === 'connected' ? state.profile.transport : null, publicProfile.transport);
});

test('cloneDraft trims submitted profile fields', () => {
  const source = readFileSync(new URL('../src/ui/agent-sidebar/cloud-onboarding-state.ts', import.meta.url), 'utf8');
  assert.match(source, /name: draft.name.trim\(\)/);
  assert.match(source, /host: draft.host.trim\(\)/);
  assert.match(source, /sshUser: draft.sshUser.trim\(\)/);
  assert.match(source, /keyPath: draft.auth.keyPath.trim\(\)/);
});

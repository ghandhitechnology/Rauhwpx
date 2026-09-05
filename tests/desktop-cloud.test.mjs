import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CloudClient, CloudHttpError, __test as clientTest } from '../desktop/cloud-client.mjs';
import { CloudCoordinator, __test as coordinatorTest } from '../desktop/cloud-coordinator.mjs';
import { collectProviderAuth, DESKTOP_PROVIDER_AUTH } from '../desktop/cloud-provider-auth.mjs';
import { PROVIDER_AUTH } from '../cloud/src/provider-auth.mjs';
import { PROVIDERS } from '../cloud/src/protocol.mjs';
import { CloudHandoffStore, sha256Hex } from '../desktop/cloud-handoff.mjs';
import { normalizeCloudProfile, normalizeTailscaleHttpsPort } from '../desktop/cloud-profile.mjs';
import { CloudProvisioner, sshArguments, __test as provisionerTest } from '../desktop/cloud-provisioner.mjs';
import { SshTunnelManager, __test as tunnelTest } from '../desktop/cloud-ssh-tunnel.mjs';
import { applyCloudRecovery } from '../desktop/cloud-result.mjs';
import { mergeCloudOperationSnapshot } from '../desktop/cloud-snapshot.mjs';

test('desktop IPC cannot merge an operation response into another profile epoch', () => {
  const profileA = { kind: 'configured', profile: { serverPublicKey: 'server-a' } };
  const profileB = { kind: 'configured', profile: { serverPublicKey: 'server-b' } };
  assert.deepEqual(
    mergeCloudOperationSnapshot(
      { profileEpoch: 4, profile: profileA, commandResult: { ok: true } },
      { profileEpoch: 4, profile: profileA, session: { kind: 'idle' } },
    ),
    {
      profileEpoch: 4,
      profile: profileA,
      commandResult: { ok: true },
      session: { kind: 'idle' },
    },
  );
  assert.throws(
    () => mergeCloudOperationSnapshot(
      { profileEpoch: 4, profile: profileA, commandResult: { ok: true } },
      { profileEpoch: 5, profile: profileB, session: { kind: 'idle' } },
    ),
    { code: 'PROFILE_CHANGED' },
  );
});

const SERVER_IDENTITY = generateKeyPairSync('ed25519');
const SERVER_KEY = `ed25519:${SERVER_IDENTITY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;

test('saved Raucloud profiles migrate their retired provider id on read', () => {
  const legacyProviderId = 'managed-cloud'; // raucloud-legacy: persisted profile fixture.
  const profile = normalizeCloudProfile({
    mode: 'app-hosted',
    endpoint: 'https://raucloud.example/rauhwpx-cloud',
    serverPublicKey: SERVER_KEY,
    sandbox: { providerId: legacyProviderId, sandboxId: 'run-1' },
  });
  assert.equal(profile.sandbox.providerId, 'raucloud');
});

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

function memoryVault(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); return true; },
    delete: async (key) => values.delete(key),
    values,
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      'x-rauhwpx-server-key': SERVER_KEY,
      ...(init.headers ?? {}),
    },
  });
}

function portableTimeline(overrides = {}) {
  return {
    schema: 'rauhwpx.cloud.timeline',
    version: 1,
    exportedAt: new Date().toISOString(),
    thread: {
      id: 'thread-1',
      title: 'Task',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agent: 'codex',
      model: 'gpt-5.6',
      effort: 'high',
      messages: [{ role: 'user', text: 'Continue this document', messageId: 'msg-start' }],
      ...overrides,
    },
  };
}

function cloudStartFields(overrides = {}) {
  const text = overrides.initialMessage?.text ?? 'Continue this document';
  const messageId = overrides.initialMessage?.id ?? 'msg-start';
  return {
    startId: overrides.startId ?? 'startid01',
    initialMessage: {
      id: messageId,
      text,
      attachmentReferenceIds: overrides.initialMessage?.attachmentReferenceIds ?? [],
    },
    timeline: overrides.timeline ?? portableTimeline({
      messages: [{ role: 'user', text, messageId }],
    }),
  };
}

test('cloud start requires an explicit first-message goal and stable start id', () => {
  assert.equal(coordinatorTest.goalFromTransfer({
    initialMessage: { id: 'msg-start', text: '  표 제목을 고쳐줘  ' },
  }), '표 제목을 고쳐줘');
  assert.throws(
    () => coordinatorTest.goalFromTransfer({ timeline: portableTimeline() }),
    (error) => error.code === 'INITIAL_MESSAGE_REQUIRED',
  );
});

test('transfer recovery retries only explicit transport and server failures', () => {
  assert.equal(coordinatorTest.nonRetryableTransferError(new Error('local payload is corrupt')), true);
  assert.equal(coordinatorTest.nonRetryableTransferError(new TypeError('fetch failed')), false);
  assert.equal(coordinatorTest.nonRetryableTransferError(new TypeError('Cannot read properties of undefined')), true);
  assert.equal(coordinatorTest.nonRetryableTransferError(new CloudHttpError('busy', { status: 500 })), false);
  assert.equal(coordinatorTest.nonRetryableTransferError(new CloudHttpError('rate limited', { status: 429 })), false);
  assert.equal(coordinatorTest.nonRetryableTransferError(new CloudHttpError('bad request', { status: 400 })), true);
  assert.equal(coordinatorTest.nonRetryableTransferError(Object.assign(new Error('configured wrong'), {
    retryable: false,
  })), true);

  const readiness = {
    profile: {
      endpoint: 'https://one.example/rauhwpx-cloud',
      serverPublicKey: SERVER_KEY,
      mode: 'app-hosted',
      sandbox: { providerId: 'railway', sandboxId: 'sandbox-one' },
    },
    health: { protocolVersion: 1, version: '1.1.0' },
  };
  const destination = coordinatorTest.destinationFromReadiness(readiness);
  assert.equal(coordinatorTest.sameDestination(destination, { ...destination, runtimeVersion: '1.1.1' }), true);
  assert.equal(coordinatorTest.sameDestination(destination, { ...destination, sandboxId: 'sandbox-two' }), false);
  assert.equal(coordinatorTest.sameDestination(destination, null), false);
});

test('cloud profile accepts Tailscale and rejects insecure endpoints', () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://vps.example.ts.net/rauhwpx-cloud/',
    ssh: { host: '100.97.8.94', user: 'rauhwpx', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
    limits: { maxDurationMinutes: 15, maxTurns: 1, maxRunningSessions: 8 },
  });
  assert.equal(profile.endpoint, 'https://vps.example.ts.net/rauhwpx-cloud');
  assert.equal(profile.transport, 'tailscale');
  assert.equal(profile.tailscaleHttpsPort, 443);
  assert.equal(profile.limits.maxQueuedSessions, 20);
  assert.throws(() => normalizeCloudProfile({
    endpoint: 'http://vps.example.com',
    ssh: { host: 'vps.example.com', user: 'rauhwpx', useTailscaleSsh: false },
  }), /HTTPS/);
});

test('ordinary SSH profiles use a managed loopback tunnel without Tailscale', () => {
  const profile = coordinatorTest.uiProfileToStored({
    name: 'Office Mac mini', host: 'mac-mini.local', sshUser: 'macadmin', sshPort: 2222,
    auth: { kind: 'key-file', keyPath: '/Users/me/.ssh/mac-mini' },
    transport: { kind: 'ssh-tunnel' },
  });
  assert.equal(profile.version, 2);
  assert.equal(profile.transport, 'ssh-tunnel');
  assert.deepEqual(profile.api, {
    kind: 'ssh-tunnel', remoteHost: '127.0.0.1', remotePort: 7740, basePath: '/rauhwpx-cloud',
  });
  assert.equal(profile.endpoint, 'http://127.0.0.1:7740/rauhwpx-cloud');
  assert.equal(profile.ssh.useTailscaleSsh, false);
  const args = tunnelTest.sshTunnelArguments(profile, '/tmp/known-hosts', 43123);
  assert.ok(args.includes('StrictHostKeyChecking=accept-new'));
  assert.ok(args.includes('127.0.0.1:43123:127.0.0.1:7740'));
  assert.ok(args.includes('ServerAliveInterval=15'));
  assert.equal(args.includes('tailscale'), false);
  const receipt = provisionerTest.parseProvisionReceipt(`RAUHWpx_RECEIPT=${JSON.stringify({
    endpoint: 'http://127.0.0.1:7740/rauhwpx-cloud', transport: 'ssh-tunnel',
    serverPublicKey: SERVER_KEY, pairingCode: 'ABCD-EFGH-JKLM',
  })}`);
  assert.equal(receipt.transport, 'ssh-tunnel');
  const pinned = coordinatorTest.uiProfileToStored({
    name: 'Office Mac mini', host: 'mac-mini.local', sshUser: 'macadmin', sshPort: 2222,
    auth: { kind: 'ssh-agent' }, transport: { kind: 'ssh-tunnel' }, serverPublicKey: SERVER_KEY,
  });
  const differentHost = coordinatorTest.uiProfileToStored({
    name: 'Other Mac mini', host: 'other-mac.local', sshUser: 'macadmin', sshPort: 2222,
    auth: { kind: 'ssh-agent' }, transport: { kind: 'ssh-tunnel' },
  }, pinned);
  assert.equal(differentHost.serverPublicKey, '', 'a different SSH host must not inherit the old server identity');
});

test('stopping a tunnel also cancels an in-flight SSH connection', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rauhwpx-tunnel-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let spawned;
  const didSpawn = new Promise((resolve) => { spawned = resolve; });
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 143;
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    };
    spawned();
    return child;
  };
  const manager = new SshTunnelManager({ spawnImpl, knownHostsPath: path.join(root, 'known-hosts') });
  const pending = manager.acquire({
    api: { kind: 'ssh-tunnel' },
    ssh: { host: 'mac-mini.local', user: 'macadmin' },
  });
  const rejected = assert.rejects(pending, /SSH tunnel exited|stopped/);
  await didSpawn;
  await manager.stop();
  await rejected;
});

test('preflight recognizes an Apple silicon macOS host over normal SSH', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rauhwpx-macos-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.end('arch=arm64\nos=macos version=14.6.1\npreflight=ok\n');
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  };
  const provisioner = new CloudProvisioner({
    spawnImpl,
    installerPath: path.join(root, 'install.sh'),
    knownHostsPath: path.join(root, 'known-hosts'),
  });
  const result = await provisioner.preflight({ host: 'mac-mini.local', user: 'macadmin', port: 22 });
  assert.deepEqual(result, { platform: 'darwin', os: 'macos', version: '14.6.1', arch: 'arm64' });
  assert.equal(calls[0].command, 'ssh');
  assert.ok(calls[0].args.includes('StrictHostKeyChecking=accept-new'));
  assert.equal(calls[0].args.some((value) => String(value).includes('/etc/os-release') && String(value).includes('sw_vers')), true);
});

test('Tailscale HTTPS port persists through profiles, UI conversion, and provisioning receipts', async () => {
  const custom = normalizeCloudProfile({
    endpoint: 'https://vps.example.ts.net:8443/rauhwpx-cloud',
    ssh: { host: 'vps.example.ts.net', user: 'rauhwpx', useTailscaleSsh: true },
    transport: 'tailscale',
    tailscaleHttpsPort: 8443,
  });
  assert.equal(custom.tailscaleHttpsPort, 8443);
  const legacy = normalizeCloudProfile({
    endpoint: 'https://vps.example.ts.net:8443/rauhwpx-cloud',
    ssh: { host: 'vps.example.ts.net', user: 'rauhwpx', useTailscaleSsh: true },
    transport: 'tailscale',
  });
  assert.equal(legacy.tailscaleHttpsPort, 8443, 'old profiles infer a non-default endpoint port');
  assert.equal(normalizeTailscaleHttpsPort(undefined), 443);
  assert.throws(() => normalizeTailscaleHttpsPort(0), /1 to 65535/);
  assert.throws(() => normalizeTailscaleHttpsPort(65536), /1 to 65535/);
  assert.throws(() => normalizeCloudProfile({
    endpoint: 'https://vps.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'vps.example.ts.net', user: 'rauhwpx', useTailscaleSsh: true },
    transport: 'tailscale',
    tailscaleHttpsPort: 8443,
  }), /must match/);

  const stored = coordinatorTest.uiProfileToStored({
    name: 'Busy VPS', host: 'vps.example.ts.net', sshUser: 'ubuntu', sshPort: 22,
    tailscaleHttpsPort: 8443,
    auth: { kind: 'ssh-agent' }, transport: { kind: 'tailscale' },
  });
  assert.equal(stored.endpoint, 'https://vps.example.ts.net:8443/rauhwpx-cloud');
  assert.equal(stored.tailscaleHttpsPort, 8443);
  const reverted = coordinatorTest.uiProfileToStored({
    name: stored.name,
    host: stored.ssh.host,
    sshUser: stored.ssh.user,
    sshPort: stored.ssh.port,
    tailscaleHttpsPort: 443,
    auth: { kind: 'ssh-agent' },
    transport: { kind: 'tailscale' },
  }, stored);
  assert.equal(reverted.endpoint, 'https://vps.example.ts.net/rauhwpx-cloud');

  const receipt = provisionerTest.parseProvisionReceipt(`RAUHWpx_RECEIPT=${JSON.stringify({
    endpoint: 'https://vps.example.ts.net:8443/rauhwpx-cloud',
    serverPublicKey: SERVER_KEY,
    pairingCode: 'ABCD-EFGH-JKLM',
    tailscaleHttpsPort: 8443,
  })}`);
  assert.equal(receipt.tailscaleHttpsPort, 8443);
  const provisionerSource = await readFile(new URL('../desktop/cloud-provisioner.mjs', import.meta.url), 'utf8');
  assert.match(provisionerSource, /line.startsWith\('RAUHWpx_RECEIPT='\) \? 'RAUHWpx_RECEIPT=' : line/);
  assert.match(provisionerSource, /carry\[stream\] \+ stripControl/);
  assert.match(provisionerSource, /emitLogLine\(carry\.stdout\)/);
  assert.match(provisionerTest.installRemoteCommand({
    channel: 'stable', transport: 'tailscale', publicHost: '', tailscaleHttpsPort: 8443,
  }), /RAUHWpx_TAILSCALE_HTTPS_PORT=8443/);
  assert.doesNotMatch(provisionerTest.installRemoteCommand({
    channel: 'stable', transport: 'public-https', publicHost: 'vps.example.com', tailscaleHttpsPort: 443,
  }), /TAILSCALE_HTTPS_PORT/);
  assert.throws(() => provisionerTest.parseProvisionReceipt(`RAUHWpx_RECEIPT=${JSON.stringify({
    endpoint: 'https://vps.example.ts.net/rauhwpx-cloud',
    serverPublicKey: SERVER_KEY,
    tailscaleHttpsPort: 8443,
  })}`), /does not match/);
});

test('provisioner selects and installs an architecture-matched bundled runtime', () => {
  assert.equal(provisionerTest.bootstrapArchitecture('x86_64'), 'amd64');
  assert.equal(provisionerTest.bootstrapArchitecture('aarch64'), 'arm64');
  assert.throws(() => provisionerTest.bootstrapArchitecture('riscv64'), /amd64 or arm64/);
  const command = provisionerTest.bundledInstallRemoteCommand({
    channel: 'stable',
    transport: 'tailscale',
    publicHost: '',
    tailscaleHttpsPort: 8443,
    assetArchitecture: 'arm64',
  });
  assert.match(command, /tar -xzf -/);
  assert.match(command, /rauhwpx-cloud-linux-arm64\.tar\.gz/);
  assert.match(command, /RAUHWpx_RELEASE_URL=file:\/\/\$TMP\/rauhwpx-cloud-linux-arm64\.tar\.gz/);
  assert.match(command, /RAUHWpx_TAILSCALE_HTTPS_PORT=8443/);
  assert.doesNotMatch(command, /github\.com/);
});

test('provisioner reuses a compatible installation without downloading a release', () => {
  const tailscale = provisionerTest.existingInstallRemoteCommand({
    transport: 'tailscale', publicHost: '', tailscaleHttpsPort: 8443,
  });
  assert.match(tailscale, /systemctl is-active --quiet rauhwpx-cloud\.service/);
  assert.match(tailscale, /RAUHWpx_BASE_PATH/);
  assert.match(tailscale, /PROTOCOL_VERSION/);
  assert.match(tailscale, /127\.0\.0\.1:7740\/v1\/health/);
  assert.match(tailscale, /\$ENDPOINT\/v1\/health/);
  assert.match(tailscale, /TAILSCALE_JSON=.*\|\| exit 0/);
  assert.ok(tailscale.indexOf('$ENDPOINT/v1/health') < tailscale.indexOf('pairing create'));
  assert.match(tailscale, /RAUHWpx_TAILSCALE_HTTPS_PORT/);
  assert.match(tailscale, /pairing create/);
  assert.match(tailscale, /RAUHWpx_RECEIPT/);
  assert.match(tailscale, /PORT_SUFFIX=:8443/);
  assert.match(tailscale, /\$\{PORT_SUFFIX\}\/rauhwpx-cloud/);
  assert.doesNotMatch(tailscale, /github\.com|RAUHWpx_RELEASE_URL/);

  const exactVersion = provisionerTest.existingInstallRemoteCommand({
    transport: 'tailscale', publicHost: '', tailscaleHttpsPort: 443, requiredVersion: '1.1.0',
  });
  assert.match(exactVersion, /package\.json/);
  assert.match(exactVersion, /EXISTING_VERSION" = "1\.1\.0/);

  const publicHttps = provisionerTest.existingInstallRemoteCommand({
    transport: 'public-https', publicHost: 'cloud.example.com', tailscaleHttpsPort: 443,
  });
  assert.match(publicHttps, /cloud\.example\.com/);
  assert.match(publicHttps, /Caddyfile\.d\/rauhwpx-cloud\.caddy/);
});

test('ssh arguments do not invoke a shell and pin known hosts', () => {
  const args = sshArguments({
    host: '100.97.8.94',
    user: 'cloud-user',
    port: 2222,
    keyPath: '/keys/cloud key',
    useTailscaleSsh: true,
  }, '/state/known_hosts', 'sudo -n true');
  assert.deepEqual(args.slice(-2), ['cloud-user@100.97.8.94', 'sudo -n true']);
  assert.ok(args.includes('UserKnownHostsFile=/state/known_hosts'));
  assert.ok(args.includes('/keys/cloud key'));
  assert.throws(() => sshArguments({ host: '-oProxyCommand=bad', user: 'x' }, '/tmp/kh', 'true'));
});

test('ssh known-hosts paths with spaces stay intact inside the -o value', () => {
  const spaced = 'C:\\Users\\Foo Bar\\AppData\\Roaming\\Rauhwpx\\cloud\\ssh-known-hosts';
  const args = sshArguments({ host: '100.97.8.94', user: 'cloud-user', port: 22 }, spaced, 'sudo -n true');
  assert.ok(args.includes(`UserKnownHostsFile="${spaced}"`));
  const tunnelProfile = coordinatorTest.uiProfileToStored({
    host: 'mac-mini.local', sshUser: 'macadmin', transport: { kind: 'ssh-tunnel' },
  });
  const tunnel = tunnelTest.sshTunnelArguments(
    tunnelProfile,
    '/Users/Foo Bar/Library/Application Support/Rauhwpx/cloud/ssh-known-hosts',
    43123,
  );
  assert.ok(tunnel.some((option) => option === 'UserKnownHostsFile="/Users/Foo Bar/Library/Application Support/Rauhwpx/cloud/ssh-known-hosts"'));
});

test('ssh known-hosts paths preserve literal percent tokens and reject control characters', () => {
  const args = sshArguments(
    { host: 'example.com', user: 'cloud-user', port: 22 },
    '/state/100%h Cloud/known-hosts',
    'true',
  );
  assert.ok(args.includes('UserKnownHostsFile="/state/100%%h Cloud/known-hosts"'));
  assert.throws(
    () => sshArguments({ host: 'example.com', user: 'cloud-user' }, '/state/bad\npath', 'true'),
    /path is invalid/,
  );
});

test('handoff store persists transitions and ignores replayed events', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'handoffs.json');
  const store = new CloudHandoffStore({ filePath });
  const created = await store.create({
    sessionId: 'desktop-1',
    documentId: 'document-1',
    originPath: path.join(directory, 'source.hwpx'),
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    timeline: [{ role: 'user', content: 'continue' }],
    provider: 'codex',
    executionConfig: { model: 'gpt-5.6', effort: 'high', workflow: 'direct', permissionProfile: 'unrestricted' },
    limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-1' });
  const event = await store.applyEvent(created.id, { sequence: 7, state: 'suspended' });
  assert.equal(event.state, 'suspended');
  const replay = await store.applyEvent(created.id, { sequence: 6, state: 'failed' });
  assert.equal(replay.state, 'suspended');

  const reloaded = new CloudHandoffStore({ filePath });
  const [record] = await reloaded.list();
  assert.equal(record.cloudSessionId, 'cloud-1');
  assert.equal(record.lastEventSequence, 7);
  assert.equal(record.originDocumentId, 'document-1');
});

test('takeover receipts are scoped to normalized server identity and survive reload', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-takeover-receipts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'handoffs.json');
  const store = new CloudHandoffStore({ filePath });
  const destinationA = {
    endpoint: 'https://receipt-a.example.ts.net/rauhwpx-cloud/',
    serverPublicKey: SERVER_KEY,
  };
  const destinationB = {
    endpoint: 'https://receipt-b.example.ts.net/rauhwpx-cloud',
    serverPublicKey: SERVER_KEY,
  };
  const sessionId = 'shared-takeover-session';
  const operationId = 'shared-takeover-operation';

  await store.consumeTakeoverBoundary(destinationA, sessionId, operationId);
  assert.equal(await store.hasConsumedTakeoverBoundary(destinationA, sessionId, operationId), true);
  assert.equal(await store.hasConsumedTakeoverBoundary(destinationB, sessionId, operationId), false);
  await store.consumeTakeoverBoundary(destinationB, sessionId, operationId);

  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(
    persisted.takeoverReceipts.map((receipt) => receipt.destination.endpoint).sort(),
    [destinationA.endpoint.replace(/\/$/, ''), destinationB.endpoint].sort(),
  );
  persisted.takeoverReceipts.push({
    sessionId,
    operationId: 'legacy-unscoped-operation',
    consumedAt: new Date().toISOString(),
  });
  await writeFile(filePath, `${JSON.stringify(persisted)}\n`);

  const reloaded = new CloudHandoffStore({ filePath });
  assert.equal(await reloaded.hasConsumedTakeoverBoundary(destinationA, sessionId, operationId), true);
  assert.equal(await reloaded.hasConsumedTakeoverBoundary(destinationB, sessionId, operationId), true);
  assert.equal(
    await reloaded.hasConsumedTakeoverBoundary(destinationA, sessionId, 'legacy-unscoped-operation'),
    false,
  );
  const migrated = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(migrated.takeoverReceipts.length, 2);
  assert.ok(migrated.takeoverReceipts.every((receipt) => receipt.destination?.serverPublicKey === SERVER_KEY));
});

test('a failed takeover receipt write cannot leak through a concurrent mutation', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-takeover-receipt-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'handoffs.json');
  const destination = {
    endpoint: 'https://receipt-failure.example.ts.net/rauhwpx-cloud',
    serverPublicKey: SERVER_KEY,
  };
  const operationId = 'failed-receipt-operation';
  const receiptWriteStarted = Promise.withResolvers();
  const releaseReceiptWrite = Promise.withResolvers();
  const atomicWrite = async (target, value) => {
    if (value.takeoverReceipts.some((receipt) => receipt.operationId === operationId)) {
      receiptWriteStarted.resolve();
      await releaseReceiptWrite.promise;
      throw new Error('forced receipt write failure');
    }
    await writeFile(target, `${JSON.stringify(value)}\n`);
  };
  const store = new CloudHandoffStore({ filePath, atomicWrite });
  const created = await store.create({
    sessionId: 'receipt-failure-session', documentId: 'receipt-failure-document',
    documentName: 'receipt-failure.hwpx', documentBytes: Buffer.from('document'),
    provider: 'codex', limits: { maxTurns: 10 },
  });

  const receiptWrite = store.consumeTakeoverBoundary(destination, 'cloud-receipt-failure', operationId);
  await receiptWriteStarted.promise;
  assert.equal(
    await store.hasConsumedTakeoverBoundary(destination, 'cloud-receipt-failure', operationId),
    false,
  );
  const concurrentPatch = store.patch(created.id, { statusMessage: 'concurrent mutation' });
  releaseReceiptWrite.resolve();
  await assert.rejects(receiptWrite, /forced receipt write failure/);
  await concurrentPatch;

  const reloaded = new CloudHandoffStore({ filePath });
  assert.equal(
    await reloaded.hasConsumedTakeoverBoundary(destination, 'cloud-receipt-failure', operationId),
    false,
  );
  assert.equal((await reloaded.get(created.id)).statusMessage, 'concurrent mutation');
});

test('snapshot selection does not let an updated stale failure hide newer live work', async () => {
  const base = {
    version: 1,
    revision: 1,
    originSessionId: 'desktop-selection',
    originDocumentId: 'document-selection',
    threadId: 'thread-selection',
    documentName: 'selection.hwpx',
    documentDigest: 'a'.repeat(64),
    documentSize: 1,
    limits: {},
  };
  const records = [
    {
      ...base,
      id: 'stale-failure',
      state: 'failed',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      error: 'old failure',
      errorCode: 'CLOUD_NOT_CONFIGURED',
      retryable: false,
    },
    {
      ...base,
      id: 'live-session',
      cloudSessionId: 'cloud-live',
      state: 'suspended',
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
      error: null,
    },
  ];
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null, isPaired: async () => false },
    store: { list: async () => records },
    provisioner: {},
  });
  const snapshot = await coordinator.snapshot({
    originSessionId: 'desktop-selection',
    documentId: 'document-selection',
  });
  assert.equal(snapshot.session.kind, 'suspended');
  assert.equal(snapshot.session.sessionId, 'cloud-live');
  assert.equal(snapshot.lease.owner, 'cloud');
});

test('desktop selected session never changes the lease for the scoped document', async () => {
  const base = {
    version: 1,
    revision: 1,
    threadId: 'thread-a',
    documentName: 'scope.hwpx',
    documentDigest: 'a'.repeat(64),
    documentSize: 1,
    limits: {},
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    error: null,
  };
  const records = [
    {
      ...base,
      id: 'handoff-a',
      cloudSessionId: 'cloud-a',
      originSessionId: 'desktop-window',
      originDocumentId: 'document-a',
      state: 'running',
    },
    {
      ...base,
      id: 'handoff-b',
      cloudSessionId: 'cloud-b',
      originSessionId: 'desktop-window',
      originDocumentId: 'document-b',
      threadId: 'thread-b',
      state: 'suspended',
    },
  ];
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null, isPaired: async () => false },
    store: { list: async () => records },
    provisioner: {},
  });

  let snapshot = await coordinator.snapshot({
    originSessionId: 'desktop-window',
    documentId: 'document-a',
    selectedSessionId: 'cloud-b',
  });
  assert.equal(snapshot.session.sessionId, 'cloud-b');
  assert.deepEqual(snapshot.lease, {
    owner: 'cloud',
    sessionId: 'cloud-a',
    acquiredAt: base.createdAt,
  });

  records[1].state = 'failed';
  records[1].error = 'terminal';
  snapshot = await coordinator.snapshot({
    originSessionId: 'desktop-window',
    documentId: 'document-a',
    selectedSessionId: 'cloud-b',
  });
  assert.equal(snapshot.session.kind, 'failed');
  assert.equal(snapshot.lease.sessionId, 'cloud-a');
});

test('desktop cancelled takeover-ready sessions retain the document lease until completion', async () => {
  const record = {
    id: 'handoff-takeover',
    version: 1,
    revision: 1,
    cloudSessionId: 'cloud-takeover',
    originSessionId: 'desktop-window',
    originDocumentId: 'document-takeover',
    threadId: 'thread-takeover',
    documentName: 'takeover.hwpx',
    documentDigest: 'a'.repeat(64),
    documentSize: 1,
    state: 'cancelled',
    takeoverReady: true,
    limits: {},
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    error: null,
  };
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null, isPaired: async () => false },
    store: { list: async () => [record] },
    provisioner: {},
  });

  let snapshot = await coordinator.snapshot({
    originSessionId: 'desktop-window',
    documentId: 'document-takeover',
  });
  assert.equal(snapshot.session.kind, 'taking-over');
  assert.equal(snapshot.lease.owner, 'cloud');

  snapshot = await coordinator.snapshot({ selectedSessionId: 'cloud-takeover' });
  assert.equal(snapshot.lease.owner, 'cloud');

  record.takeoverReady = false;
  snapshot = await coordinator.snapshot({
    originSessionId: 'desktop-window',
    documentId: 'document-takeover',
  });
  assert.equal(snapshot.lease.owner, 'local');
});

test('desktop checkpoints carry the immutable handoff document identity', async () => {
  const coordinator = new CloudCoordinator({
    client: {
      downloadCheckpoint: async () => ({
        name: 'document.hwpx',
        bytes: Buffer.from('checkpoint'),
        size: 10,
        sha256: 'b'.repeat(64),
        revision: 3,
        turn: 2,
        boundaryOperation: 'operation-a',
        boundaryKind: 'turn',
      }),
    },
    store: {
      list: async () => [{
        id: 'handoff-a',
        cloudSessionId: 'cloud-a',
        originDocumentId: 'document-a',
        documentDigest: 'a'.repeat(64),
      }],
    },
    provisioner: {},
  });
  const checkpoint = await coordinator.downloadCheckpoint({ sessionId: 'cloud-a' });
  assert.equal(checkpoint.documentId, 'document-a');
  assert.equal(checkpoint.originOnThisDevice, true);
  assert.equal(checkpoint.expectedOriginSha256, 'a'.repeat(64));
});

test('loading legacy terminal handoffs removes their staged payloads', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-terminal-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'handoffs.json');
  const store = new CloudHandoffStore({ filePath });
  const created = await store.create({
    sessionId: 'desktop-legacy',
    documentId: 'document-legacy',
    documentName: 'legacy.hwpx',
    documentBytes: Buffer.from('legacy-document'),
    provider: 'codex',
  });
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  persisted.records[0].state = 'failed';
  persisted.records[0].error = 'old terminal failure';
  await writeFile(filePath, `${JSON.stringify(persisted)}\n`);

  const reloaded = new CloudHandoffStore({ filePath });
  const [record] = await reloaded.load();
  assert.equal(record.state, 'failed');
  assert.equal(record.documentStagingPath, null);
  assert.deepEqual(record.resources, []);
  await assert.rejects(access(path.join(directory, 'pending-payloads', created.id)), {
    code: 'ENOENT',
  });
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null, isPaired: async () => false },
    store: reloaded,
    provisioner: {},
  });
  const snapshot = await coordinator.dismissSession({ sessionId: created.id });
  assert.deepEqual(await reloaded.list(), []);
  assert.equal(snapshot.session.kind, 'idle');
});

test('result resolution replaces unchanged origins and preserves conflicts', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-result-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalPath = path.join(directory, 'report.hwpx');
  const recoveryPath = path.join(directory, 'recovery.hwpx');
  const original = Buffer.from('original');
  const cloud = Buffer.from('cloud-result');
  await writeFile(originalPath, original, { mode: 0o644 });
  await writeFile(recoveryPath, cloud);
  const replaced = await applyCloudRecovery({
    recoveryPath,
    resultDigest: sha256Hex(cloud),
    originalPath,
    originalDigest: sha256Hex(original),
    action: 'replace',
    platform: 'linux',
  });
  assert.equal(replaced.action, 'replace');
  assert.deepEqual(await readFile(originalPath), cloud);
  if (process.platform !== 'win32') {
    assert.equal((await stat(originalPath)).mode & 0o777, 0o644);
  }
  assert.deepEqual(await readFile(recoveryPath), cloud, 'recovery remains until the durable resolution receipt');
  const retriedReplace = await applyCloudRecovery({
    recoveryPath,
    resultDigest: sha256Hex(cloud),
    originalPath,
    originalDigest: sha256Hex(original),
    action: 'replace',
    platform: 'linux',
  });
  assert.equal(retriedReplace.action, 'replace');
  assert.equal(retriedReplace.conflict, false, 'a crash retry recognizes the already-applied result');

  const secondRecovery = path.join(directory, 'second.hwpx');
  await writeFile(secondRecovery, Buffer.from('new-cloud'));
  await writeFile(originalPath, Buffer.from('external-change'));
  const preserved = await applyCloudRecovery({
    recoveryPath: secondRecovery,
    resultDigest: sha256Hex(Buffer.from('new-cloud')),
    originalPath,
    originalDigest: sha256Hex(cloud),
    action: 'replace',
    resolutionId: 'handoff-conflict-crash',
    platform: 'linux',
    now: new Date('2026-08-23T10:11:12.000Z'),
  });
  assert.equal(preserved.action, 'keep-both');
  assert.equal(preserved.conflict, true);
  assert.deepEqual(await readFile(originalPath), Buffer.from('external-change'));
  assert.deepEqual(await readFile(preserved.path), Buffer.from('new-cloud'));
  assert.deepEqual(await readFile(secondRecovery), Buffer.from('new-cloud'));
  const retriedPreserved = await applyCloudRecovery({
    recoveryPath: secondRecovery,
    resultDigest: sha256Hex(Buffer.from('new-cloud')),
    originalPath,
    originalDigest: sha256Hex(cloud),
    action: 'replace',
    resolutionId: 'handoff-conflict-crash',
    platform: 'linux',
    now: new Date('2027-01-01T00:00:00.000Z'),
  });
  assert.equal(retriedPreserved.path, preserved.path, 'a crash retry reuses the preserved copy');
  const conflictCopies = (await readdir(directory)).filter((name) => name.startsWith('report.cloud-'));
  assert.deepEqual(conflictCopies, [path.basename(preserved.path)], 'a crash retry creates only one preserved copy');

  const discardedRecovery = path.join(directory, 'discarded-recovery.hwpx');
  await writeFile(discardedRecovery, cloud);
  await applyCloudRecovery({
    recoveryPath: discardedRecovery,
    resultDigest: sha256Hex(cloud),
    originalPath,
    originalDigest: sha256Hex(original),
    action: 'discard',
    platform: 'linux',
  });
  assert.deepEqual(await readFile(discardedRecovery), cloud, 'discard cleanup follows the durable receipt too');

  const windowsOriginal = path.join(directory, 'windows-report.hwpx');
  const windowsRecovery = path.join(directory, 'windows-recovery.hwpx');
  const userBackup = `${windowsOriginal}.rauhwpx-cloud-backup`;
  await writeFile(windowsOriginal, original);
  await writeFile(windowsRecovery, cloud);
  await writeFile(userBackup, Buffer.from('user-owned-backup'));
  await applyCloudRecovery({
    recoveryPath: windowsRecovery,
    resultDigest: sha256Hex(cloud),
    originalPath: windowsOriginal,
    originalDigest: sha256Hex(original),
    action: 'replace',
    platform: process.platform,
  });
  assert.deepEqual(await readFile(windowsOriginal), cloud);
  assert.deepEqual(await readFile(userBackup), Buffer.from('user-owned-backup'));
});

for (const externalAction of ['save', 'delete']) {
test(`publication preserves an origin ${externalAction} during replacement preparation`, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-publish-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalPath = path.join(directory, 'report.hwpx');
  const recoveryPath = path.join(directory, 'recovery.hwpx');
  await writeFile(originalPath, 'original');
  await writeFile(recoveryPath, 'cloud-result');
  const actualOpen = fs.open;
  let changed = false;
  t.mock.method(fs, 'open', async (filePath, ...options) => {
    const handle = await actualOpen(filePath, ...options);
    if (String(filePath).endsWith('.tmp')) {
      const actualSync = handle.sync.bind(handle);
      t.mock.method(handle, 'sync', async () => {
        if (!changed) {
          changed = true;
          if (externalAction === 'save') await writeFile(originalPath, 'external edit');
          else await rm(originalPath);
        }
        await actualSync();
      });
    }
    return handle;
  });
  const result = await applyCloudRecovery({
    recoveryPath, originalPath,
    originalDigest: sha256Hex(Buffer.from('original')),
    resultDigest: sha256Hex(Buffer.from('cloud-result')),
    action: 'replace', resolutionId: 'publication-race',
  });
  assert.equal(changed, true);
  assert.equal(result.conflict, true);
  assert.equal(result.action, 'keep-both');
  assert.equal(await readFile(result.path, 'utf8'), 'cloud-result');
  if (externalAction === 'save') assert.equal(await readFile(originalPath, 'utf8'), 'external edit');
  else await assert.rejects(readFile(originalPath), { code: 'ENOENT' });
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});
}

for (const externalAction of ['save', 'delete']) {
test(`publication preserves an origin ${externalAction} at the final rename boundary`, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-rename-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalPath = path.join(directory, 'report.hwpx');
  const recoveryPath = path.join(directory, 'recovery.hwpx');
  await writeFile(originalPath, 'original');
  await writeFile(recoveryPath, 'cloud-result');
  const actualRename = fs.rename;
  let changed = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!changed && (from === originalPath || to === originalPath && String(from).endsWith('.tmp'))) {
      changed = true;
      if (externalAction === 'save') await writeFile(originalPath, 'external latest');
      else await rm(originalPath);
    }
    return actualRename(from, to);
  });
  const result = await applyCloudRecovery({
    recoveryPath, originalPath,
    originalDigest: sha256Hex(Buffer.from('original')),
    resultDigest: sha256Hex(Buffer.from('cloud-result')),
    action: 'replace', resolutionId: 'rename-boundary-race',
  });
  assert.equal(changed, true);
  assert.equal(result.conflict, true);
  assert.equal(result.action, 'keep-both');
  assert.equal(await readFile(result.path, 'utf8'), 'cloud-result');
  if (externalAction === 'save') assert.equal(await readFile(originalPath, 'utf8'), 'external latest');
  else await assert.rejects(readFile(originalPath), { code: 'ENOENT' });
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});
}

test('publication preserves a new destination created after the origin moves aside', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-exclusive-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalPath = path.join(directory, 'report.hwpx');
  const recoveryPath = path.join(directory, 'recovery.hwpx');
  await writeFile(originalPath, 'original');
  await writeFile(recoveryPath, 'cloud-result');
  const actualRename = fs.rename;
  let displaced;
  t.mock.method(fs, 'rename', async (from, to) => {
    await actualRename(from, to);
    if (from === originalPath) {
      displaced = to;
      await writeFile(originalPath, 'new external generation');
    }
  });
  const result = await applyCloudRecovery({
    recoveryPath, originalPath,
    originalDigest: sha256Hex(Buffer.from('original')),
    resultDigest: sha256Hex(Buffer.from('cloud-result')),
    action: 'replace', resolutionId: 'exclusive-publication-race',
  });
  assert.equal(result.conflict, true);
  assert.equal(result.action, 'keep-both');
  assert.equal(await readFile(originalPath, 'utf8'), 'new external generation');
  assert.equal(await readFile(result.path, 'utf8'), 'cloud-result');
  assert.equal(await readFile(displaced, 'utf8'), 'original');
});

test('client rotates tokens, verifies server pin, and parses SSE frames', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const vault = memoryVault({
    'cloud.profile': JSON.stringify(profile),
    'cloud.refresh': 'refresh-old',
  });
  const requests = [];
  const client = new CloudClient({
    vault,
    fetchImpl: signedFetch(async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/v1/token/refresh')) {
        return jsonResponse({
          accessToken: 'access-new',
          accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshToken: 'refresh-new',
          refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      }
      return jsonResponse({ ok: true, serverPublicKey: SERVER_KEY });
    }),
  });
  const result = await client.profile();
  assert.equal(result.ok, true);
  assert.equal(await vault.get('cloud.refresh'), 'refresh-new');
  assert.equal(requests[1].options.headers.authorization, 'Bearer access-new');

  const parsed = clientTest.sseFrames('id: 3\nevent: session\ndata: {"state":"running"}\n\npartial');
  assert.equal(parsed.frames[0].id, '3');
  assert.equal(parsed.frames[0].event, 'session');
  assert.equal(parsed.rest, 'partial');
});

test('candidate provisioning keeps the working profile and credentials when verification fails', async () => {
  const candidateIdentity = generateKeyPairSync('ed25519');
  const candidateKey = `ed25519:${candidateIdentity.publicKey.export({
    type: 'spki', format: 'der',
  }).toString('base64url')}`;
  const oldProfile = normalizeCloudProfile({
    endpoint: 'https://old.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'old.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const oldDevice = JSON.stringify({ id: 'old-device' });
  const vault = memoryVault({
    'cloud.profile': JSON.stringify(oldProfile),
    'cloud.refresh': 'old-refresh',
    'cloud.device': oldDevice,
  });
  const assertWorkingSecrets = () => {
    assert.equal(vault.values.get('cloud.profile'), JSON.stringify(oldProfile));
    assert.equal(vault.values.get('cloud.refresh'), 'old-refresh');
    assert.equal(vault.values.get('cloud.device'), oldDevice);
  };
  const oldFetch = signedFetch(async () => jsonResponse({ ok: true, serverPublicKey: SERVER_KEY }));
  const candidateFetch = signedFetch(async (url) => {
    assertWorkingSecrets();
    if (url.endsWith('/v1/pairing/redeem')) return jsonResponse({
      accessToken: 'candidate-access',
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: 'candidate-refresh',
      device: { id: 'candidate-device' },
    });
    return jsonResponse({ ok: false, serverPublicKey: candidateKey });
  }, candidateIdentity);
  const client = new CloudClient({
    vault,
    fetchImpl: (url, options) => (
      new URL(url).hostname === 'old.example.ts.net'
        ? oldFetch(url, options)
        : candidateFetch(url, options)
    ),
  });
  const coordinator = new CloudCoordinator({
    client,
    store: { list: async () => [] },
    provisioner: {
      provision: async () => {
        assertWorkingSecrets();
        return {
          endpoint: 'https://candidate.example.ts.net/rauhwpx-cloud',
          serverPublicKey: candidateKey,
          pairingCode: 'ABCD-EFGH-JKLM',
          tailscaleHttpsPort: 443,
        };
      },
    },
    recoveryDir: '/unused',
  });

  await assert.rejects(coordinator.provision({
    installChannel: 'stable',
    profile: {
      name: 'Candidate VPS',
      host: 'candidate.example.ts.net',
      sshUser: 'cloud',
      sshPort: 22,
      tailscaleHttpsPort: 443,
      auth: { kind: 'ssh-agent' },
      transport: { kind: 'tailscale' },
    },
  }), /identity verification/);
  assertWorkingSecrets();
  assert.equal((await client.loadProfile()).endpoint, oldProfile.endpoint);
  assert.equal(await client.deviceId(), 'old-device');
  assert.equal((await client.health()).ok, true);
});

test('concurrent self-host provisioning shares one installer and pairing operation', async () => {
  let profile = null;
  let paired = false;
  let provisionCalls = 0;
  let healthCalls = 0;
  let pairingCalls = 0;
  let releaseProvision;
  const provisionReleased = new Promise((resolve) => { releaseProvision = resolve; });
  const client = {
    loadProfile: async () => profile,
    isPaired: async () => paired,
    health: async () => {
      healthCalls += 1;
      return { ok: true, serverPublicKey: SERVER_KEY };
    },
    redeemPairingCode: async () => {
      pairingCalls += 1;
      return {
        credentials: {
          accessToken: 'candidate-access',
          refreshToken: 'candidate-refresh',
          device: { id: 'candidate-device' },
        },
      };
    },
    activateProfile: async (candidate) => {
      profile = candidate;
      paired = true;
    },
    saveServerMode: async (mode) => mode,
  };
  const coordinator = new CloudCoordinator({
    client,
    store: { list: async () => [] },
    provisioner: {
      provision: async () => {
        provisionCalls += 1;
        await provisionReleased;
        return {
          endpoint: 'https://candidate.example.ts.net/rauhwpx-cloud',
          serverPublicKey: SERVER_KEY,
          pairingCode: 'ABCD-EFGH-JKLM',
          tailscaleHttpsPort: 443,
        };
      },
    },
    recoveryDir: '/unused',
  });
  const options = {
    installChannel: 'stable',
    profile: {
      name: 'Candidate VPS',
      host: 'candidate.example.ts.net',
      sshUser: 'cloud',
      sshPort: 22,
      tailscaleHttpsPort: 443,
      auth: { kind: 'ssh-agent' },
      transport: { kind: 'tailscale' },
    },
  };

  const first = coordinator.provision(options);
  const second = coordinator.provision(options);
  releaseProvision();
  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

  assert.equal(provisionCalls, 1);
  assert.equal(healthCalls, 1);
  assert.equal(pairingCalls, 1);
  assert.equal(firstSnapshot, secondSnapshot);
  assert.equal(firstSnapshot.profile.connection, 'ready');
});

test('candidate pairing keeps the working profile and credentials when health verification fails', async () => {
  const candidateIdentity = generateKeyPairSync('ed25519');
  const candidateKey = `ed25519:${candidateIdentity.publicKey.export({
    type: 'spki', format: 'der',
  }).toString('base64url')}`;
  const oldProfile = normalizeCloudProfile({
    endpoint: 'https://old-pair.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'old-pair.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const oldSecrets = {
    'cloud.profile': JSON.stringify(oldProfile),
    'cloud.refresh': 'old-pair-refresh',
    'cloud.device': JSON.stringify({ id: 'old-pair-device' }),
  };
  const vault = memoryVault(oldSecrets);
  const candidateFetch = signedFetch(async (url) => {
    for (const [key, value] of Object.entries(oldSecrets)) assert.equal(vault.values.get(key), value);
    if (url.endsWith('/v1/pairing/redeem')) return jsonResponse({
      accessToken: 'paired-access',
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: 'paired-refresh',
      device: { id: 'paired-device' },
    });
    return jsonResponse({ ok: true, serverPublicKey: SERVER_KEY });
  }, candidateIdentity);
  const client = new CloudClient({ vault, fetchImpl: candidateFetch });
  const coordinator = new CloudCoordinator({
    client,
    store: { list: async () => [] },
    provisioner: {},
    recoveryDir: '/unused',
  });

  await assert.rejects(coordinator.pair({
    code: 'ABCD-EFGH-JKLM',
    profile: {
      name: 'Existing Candidate',
      host: 'paired.example.ts.net',
      sshUser: 'cloud',
      sshPort: 22,
      tailscaleHttpsPort: 443,
      auth: { kind: 'ssh-agent' },
      transport: { kind: 'tailscale' },
      serverPublicKey: candidateKey,
    },
  }), /identity verification/);
  for (const [key, value] of Object.entries(oldSecrets)) assert.equal(vault.values.get(key), value);
  assert.equal((await client.loadProfile()).endpoint, oldProfile.endpoint);
  assert.equal(await client.deviceId(), 'old-pair-device');
});

test('profile activation restores every working secret when persistence fails', async () => {
  const oldProfile = normalizeCloudProfile({
    endpoint: 'https://old-activation.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'old-activation.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const oldSecrets = {
    'cloud.profile': JSON.stringify(oldProfile),
    'cloud.refresh': 'old-activation-refresh',
    'cloud.device': JSON.stringify({ id: 'old-activation-device' }),
  };
  const baseVault = memoryVault(oldSecrets);
  let rejectCandidateRefresh = true;
  const vault = {
    ...baseVault,
    set: async (key, value) => {
      if (key === 'cloud.refresh' && value === 'candidate-refresh' && rejectCandidateRefresh) {
        rejectCandidateRefresh = false;
        throw new Error('keychain unavailable');
      }
      return baseVault.set(key, value);
    },
  };
  const client = new CloudClient({ vault, fetchImpl: async () => { throw new Error('unused'); } });
  await client.loadProfile();

  await assert.rejects(client.activateProfile({
    endpoint: 'https://candidate-activation.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'candidate-activation.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  }, {
    tokens: {
      accessToken: 'candidate-access',
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: 'candidate-refresh',
    },
    device: { id: 'candidate-device' },
  }), /keychain unavailable/);
  for (const [key, value] of Object.entries(oldSecrets)) assert.equal(vault.values.get(key), value);
  assert.equal((await client.loadProfile()).endpoint, oldProfile.endpoint);
  assert.equal(await client.deviceId(), 'old-activation-device');
});

test('a refresh from the old VPS cannot overwrite an activated candidate profile', async () => {
  const oldProfile = normalizeCloudProfile({
    endpoint: 'https://old-refresh.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'old-refresh.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const candidateProfile = normalizeCloudProfile({
    endpoint: 'https://candidate-refresh.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'candidate-refresh.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const vault = memoryVault({
    'cloud.profile': JSON.stringify(oldProfile),
    'cloud.refresh': 'old-refresh',
    'cloud.device': JSON.stringify({ id: 'old-device' }),
  });
  let releaseRefresh;
  let markRefreshStarted;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const client = new CloudClient({
    vault,
    fetchImpl: signedFetch(async (url) => {
      if (url.endsWith('/v1/token/refresh')) {
        markRefreshStarted();
        await refreshGate;
        return jsonResponse({
          accessToken: 'stale-access',
          accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshToken: 'stale-refresh',
        });
      }
      return jsonResponse({ ok: true, serverPublicKey: SERVER_KEY });
    }),
  });

  const oldRequest = client.profile();
  const oldRequestResult = oldRequest.then(
    () => null,
    (error) => error,
  );
  await refreshStarted;
  await client.activateProfile(candidateProfile, {
    tokens: {
      accessToken: 'candidate-access',
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: 'candidate-refresh',
    },
    device: { id: 'candidate-device' },
  });
  releaseRefresh();

  assert.equal((await oldRequestResult)?.code, 'PROFILE_CHANGED');
  assert.equal((await client.loadProfile()).endpoint, candidateProfile.endpoint);
  assert.equal(vault.values.get('cloud.refresh'), 'candidate-refresh');
  assert.equal(vault.values.get('cloud.device'), JSON.stringify({ id: 'candidate-device' }));
});

test('a delayed refresh snapshot sends the old token only to the old profile', async () => {
  const oldProfile = normalizeCloudProfile({
    endpoint: 'https://snapshot-old.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'snapshot-old.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const candidateProfile = normalizeCloudProfile({
    endpoint: 'https://snapshot-new.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'snapshot-new.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const baseVault = memoryVault({
    'cloud.profile': JSON.stringify(oldProfile),
    'cloud.refresh': 'snapshot-old-refresh',
  });
  const refreshRead = Promise.withResolvers();
  const releaseRead = Promise.withResolvers();
  const refreshResponse = Promise.withResolvers();
  const observed = [];
  let delayed = false;
  const vault = {
    ...baseVault,
    get: async (key) => {
      const value = await baseVault.get(key);
      if (key === 'cloud.refresh' && !delayed) {
        delayed = true;
        refreshRead.resolve();
        await releaseRead.promise;
      }
      return value;
    },
  };
  const client = new CloudClient({
    vault,
    fetchImpl: signedFetch(async (url, options) => {
      if (url.endsWith('/v1/token/refresh')) {
        observed.push({ url, token: JSON.parse(options.body).refreshToken });
        await refreshResponse.promise;
        return jsonResponse({
          accessToken: 'snapshot-stale-access',
          accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshToken: 'snapshot-stale-refresh',
        });
      }
      return jsonResponse({ ok: true, serverPublicKey: SERVER_KEY });
    }),
  });
  const oldRequest = client.profile();
  const oldRequestResult = oldRequest.then(
    () => null,
    (error) => error,
  );
  await refreshRead.promise;
  const activation = client.activateProfile(candidateProfile, {
    tokens: {
      accessToken: 'snapshot-new-access',
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: 'snapshot-new-refresh',
    },
  });
  await activation;
  releaseRead.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  refreshResponse.resolve();
  assert.equal((await oldRequestResult)?.code, 'PROFILE_CHANGED');
  assert.deepEqual(observed, [{
    url: `${oldProfile.endpoint}/v1/token/refresh`,
    token: 'snapshot-old-refresh',
  }]);
  assert.equal(baseVault.values.get('cloud.refresh'), 'snapshot-new-refresh');
});

test('one aborted refresh waiter does not cancel another waiter', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://shared-refresh.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'shared-refresh.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const vault = memoryVault({
    'cloud.profile': JSON.stringify(profile),
    'cloud.refresh': 'shared-refresh-token',
  });
  const refreshStarted = Promise.withResolvers();
  const releaseRefresh = Promise.withResolvers();
  let refreshCalls = 0;
  const client = new CloudClient({
    vault,
    fetchImpl: signedFetch(async (url) => {
      if (url.endsWith('/v1/token/refresh')) {
        refreshCalls += 1;
        refreshStarted.resolve();
        await releaseRefresh.promise;
        return jsonResponse({
          accessToken: 'shared-access',
          accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshToken: 'shared-refresh-next',
        });
      }
      return jsonResponse({ device: { id: 'shared-device' } });
    }),
  });
  const controller = new AbortController();
  const first = client.profile({ signal: controller.signal });
  const second = client.profile();
  await refreshStarted.promise;
  controller.abort();
  const firstAborted = await Promise.race([
    first.then(
      () => false,
      (error) => error?.name === 'AbortError',
    ),
    new Promise((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
  releaseRefresh.resolve();
  assert.deepEqual(await second, { device: { id: 'shared-device' } });
  await first.catch(() => {});
  assert.equal(firstAborted, true);
  assert.equal(refreshCalls, 1);
});

test('a refresh started during candidate vault writes is invalidated before acceptance', async () => {
  const oldProfile = normalizeCloudProfile({
    endpoint: 'https://old-overlap.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'old-overlap.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const candidateProfile = normalizeCloudProfile({
    endpoint: 'https://candidate-overlap.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'candidate-overlap.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const baseVault = memoryVault({
    'cloud.profile': JSON.stringify(oldProfile),
    'cloud.refresh': 'old-overlap-refresh',
    'cloud.device': JSON.stringify({ id: 'old-overlap-device' }),
  });
  let releaseActivationWrite;
  let markActivationWriteStarted;
  let markRefreshStarted;
  const activationWriteStarted = new Promise((resolve) => { markActivationWriteStarted = resolve; });
  const activationWriteGate = new Promise((resolve) => { releaseActivationWrite = resolve; });
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const vault = {
    ...baseVault,
    set: async (key, value) => {
      if (key === 'cloud.profile' && value === JSON.stringify(candidateProfile)) {
        markActivationWriteStarted();
        await activationWriteGate;
      }
      return baseVault.set(key, value);
    },
  };
  const client = new CloudClient({
    vault,
    fetchImpl: signedFetch(async (url) => {
      if (url.endsWith('/v1/token/refresh')) {
        markRefreshStarted();
        return jsonResponse({
          accessToken: 'overlap-stale-access',
          accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshToken: 'overlap-stale-refresh',
        });
      }
      return jsonResponse({ ok: true, serverPublicKey: SERVER_KEY });
    }),
  });

  const activation = client.activateProfile(candidateProfile, {
    tokens: {
      accessToken: 'overlap-candidate-access',
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: 'overlap-candidate-refresh',
    },
    device: { id: 'overlap-candidate-device' },
  });
  await activationWriteStarted;
  const oldRequest = client.profile();
  await refreshStarted;
  releaseActivationWrite();
  await activation;

  await assert.rejects(oldRequest, (error) => error.code === 'PROFILE_CHANGED');
  assert.equal((await client.loadProfile()).endpoint, candidateProfile.endpoint);
  assert.equal(vault.values.get('cloud.refresh'), 'overlap-candidate-refresh');
  assert.equal(vault.values.get('cloud.device'), JSON.stringify({ id: 'overlap-candidate-device' }));
});

test('a refresh started during disconnect cannot repopulate deleted credentials', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://disconnect-overlap.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'disconnect-overlap.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const baseVault = memoryVault({
    'cloud.profile': JSON.stringify(profile),
    'cloud.refresh': 'disconnect-old-refresh',
    'cloud.device': JSON.stringify({ id: 'disconnect-old-device' }),
  });
  let releaseDelete;
  let markDeleteStarted;
  let markRefreshStarted;
  const deleteStarted = new Promise((resolve) => { markDeleteStarted = resolve; });
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const vault = {
    ...baseVault,
    delete: async (key) => {
      if (key === 'cloud.refresh') {
        markDeleteStarted();
        await deleteGate;
      }
      return baseVault.delete(key);
    },
  };
  const client = new CloudClient({
    vault,
    fetchImpl: signedFetch(async (url) => {
      if (url.endsWith('/v1/token/refresh')) {
        markRefreshStarted();
        return jsonResponse({
          accessToken: 'disconnect-stale-access',
          accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshToken: 'disconnect-stale-refresh',
        });
      }
      return jsonResponse({ ok: true, serverPublicKey: SERVER_KEY });
    }),
  });
  await client.loadProfile();

  const disconnecting = client.disconnect();
  await deleteStarted;
  const oldRequest = client.profile();
  await refreshStarted;
  releaseDelete();
  await disconnecting;

  await assert.rejects(oldRequest, (error) => error.code === 'PROFILE_CHANGED');
  assert.equal(vault.values.has('cloud.refresh'), false);
  assert.equal(vault.values.has('cloud.device'), false);
});

test('aborting SSE after headers cancels the blocked body read and releases its reader', async (t) => {
  const streamDigest = sha256Hex(Buffer.from('rauhwpx-sse-v1'));
  let closeStream;
  const streamClosed = new Promise((resolve) => { closeStream = resolve; });
  const server = createServer((request, response) => {
    const nonce = String(request.headers['x-rauhwpx-request-nonce'] ?? '');
    const canonical = `RAUHWpx-response-v1\n${nonce}\nGET\n${request.url}\n200\n${streamDigest}`;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-rauhwpx-server-key': SERVER_KEY,
      'x-rauhwpx-content-sha256': streamDigest,
      'x-rauhwpx-response-signature': sign(
        null,
        Buffer.from(canonical),
        SERVER_IDENTITY.privateKey,
      ).toString('base64url'),
      'x-rauhwpx-stream-protocol': 'rauhwpx-sse-v1',
    });
    response.flushHeaders();
    response.on('close', closeStream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const tokenFetch = signedFetch(async () => jsonResponse({
    accessToken: 'access-sse',
    accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshToken: 'refresh-sse-new',
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }));
  let streamingResponse;
  let deliverHeaders;
  const headersDelivered = new Promise((resolve) => { deliverHeaders = resolve; });
  const client = new CloudClient({
    vault: memoryVault({
      'cloud.profile': JSON.stringify(profile),
      'cloud.refresh': 'refresh-sse-old',
    }),
    fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/token/refresh')) return tokenFetch(url, options);
      const requestUrl = new URL(url);
      streamingResponse = await fetch(`http://127.0.0.1:${port}${requestUrl.pathname}${requestUrl.search}`, options);
      setImmediate(deliverHeaders);
      return streamingResponse;
    },
  });
  const controller = new AbortController();
  const reading = client.readEvents('session-stream', 0, { signal: controller.signal });
  await headersDelivered;
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  const error = await Promise.race([
    reading.then(
      () => new Error('SSE read unexpectedly completed'),
      (readError) => readError,
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error('SSE abort did not unblock reader.read()')), 500)),
  ]);
  assert.equal(error.name, 'AbortError');
  await Promise.race([
    streamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SSE connection leaked after abort')), 500)),
  ]);
  assert.equal(streamingResponse.body.locked, false, 'readEvents must release the aborted stream reader');
});

test('client fails closed when the application server key changes', async () => {
  const vault = memoryVault({
    'cloud.profile': JSON.stringify(normalizeCloudProfile({
      endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
      ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
      serverPublicKey: SERVER_KEY,
    })),
  });
  const impostor = generateKeyPairSync('ed25519');
  const client = new CloudClient({
    vault,
    fetchImpl: signedFetch(async () => jsonResponse({ ok: true }), impostor),
  });
  await assert.rejects(client.health(), /identity/);
});

test('client rejects echoed keys, body tampering, nonce replay, and SSE tampering', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const responseBody = Buffer.from(JSON.stringify({ ok: true, serverPublicKey: SERVER_KEY }));
  const bodyDigest = sha256Hex(responseBody);
  const impostor = generateKeyPairSync('ed25519');

  const echoedKeyClient = new CloudClient({
    vault: memoryVault({ 'cloud.profile': JSON.stringify(profile) }),
    fetchImpl: async (url, options) => {
      const requestUrl = new URL(url);
      const canonical = `RAUHWpx-response-v1\n${options.headers['x-rauhwpx-request-nonce']}\nGET\n${requestUrl.pathname}${requestUrl.search}\n200\n${bodyDigest}`;
      return new Response(responseBody, { headers: {
        'content-type': 'application/json',
        'x-rauhwpx-server-key': SERVER_KEY,
        'x-rauhwpx-content-sha256': bodyDigest,
        'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), impostor.privateKey).toString('base64url'),
      } });
    },
  });
  await assert.rejects(echoedKeyClient.health(), (error) => error.code === 'SERVER_PROOF_INVALID');

  const tamperedClient = new CloudClient({
    vault: memoryVault({ 'cloud.profile': JSON.stringify(profile) }),
    fetchImpl: async (url, options) => {
      const requestUrl = new URL(url);
      const canonical = `RAUHWpx-response-v1\n${options.headers['x-rauhwpx-request-nonce']}\nGET\n${requestUrl.pathname}${requestUrl.search}\n200\n${bodyDigest}`;
      return new Response(Buffer.from('{"ok":false}'), { headers: {
        'content-type': 'application/json',
        'x-rauhwpx-server-key': SERVER_KEY,
        'x-rauhwpx-content-sha256': bodyDigest,
        'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), SERVER_IDENTITY.privateKey).toString('base64url'),
      } });
    },
  });
  await assert.rejects(tamperedClient.health(), (error) => error.code === 'SERVER_BODY_TAMPERED');

  let captured;
  const makeSigned = signedFetch(async () => jsonResponse({ ok: true, serverPublicKey: SERVER_KEY }));
  const replayClient = new CloudClient({
    vault: memoryVault({ 'cloud.profile': JSON.stringify(profile) }),
    fetchImpl: async (url, options) => {
      if (!captured) {
        const response = await makeSigned(url, options);
        captured = { bytes: Buffer.from(await response.arrayBuffer()), headers: new Headers(response.headers) };
      }
      return new Response(captured.bytes, { headers: captured.headers });
    },
  });
  assert.equal((await replayClient.health()).ok, true);
  await assert.rejects(replayClient.health(), (error) => error.code === 'SERVER_PROOF_INVALID');

  const sseContext = {
    nonce: Buffer.alloc(24, 7).toString('base64url'),
    method: 'GET',
    pathAndQuery: '/rauhwpx-cloud/v1/sessions/session-1/events?after=0',
  };
  const data = JSON.stringify({ seq: 1, type: 'session.running', payload: { status: 'running' } });
  const eventDigest = sha256Hex(Buffer.from(data));
  const eventCanonical = `RAUHWpx-sse-event-v1\n${sseContext.nonce}\nGET\n${sseContext.pathAndQuery}\n200\n1\nsession.running\n${eventDigest}`;
  const frame = {
    id: '1', event: 'session.running', data, sha256: eventDigest,
    signature: sign(null, Buffer.from(eventCanonical), SERVER_IDENTITY.privateKey).toString('base64url'),
  };
  assert.equal(clientTest.verifySseFrame(profile, frame, sseContext), 1);
  assert.throws(
    () => clientTest.verifySseFrame(profile, { ...frame, data: `${data} ` }, sseContext),
    (error) => error.code === 'SSE_PROOF_INVALID',
  );
  assert.throws(
    () => clientTest.verifySseFrame(profile, frame, { ...sseContext, nonce: Buffer.alloc(24, 8).toString('base64url') }),
    (error) => error.code === 'SSE_PROOF_INVALID',
  );
});

test('transfer uploads the raw portable timeline and idempotently activates the staged session', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const vault = memoryVault({
    'cloud.profile': JSON.stringify(profile),
    'cloud.refresh': 'refresh-old',
  });
  const requests = [];
  const client = new CloudClient({
    vault,
    fetchImpl: signedFetch(async (url, options) => {
      const body = options.body && String(options.headers['content-type']).includes('json')
        ? JSON.parse(options.body)
        : null;
      requests.push({ url, options, body });
      if (url.endsWith('/v1/token/refresh')) return jsonResponse({
        accessToken: 'access',
        accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'refresh-new',
        refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      if (url.endsWith('/v1/uploads/init')) return jsonResponse({
        uploadId: `upload-${requests.length}`,
        chunkSize: 1024,
        offset: body.size,
        status: 'complete',
        blobExists: true,
        blob: { id: body.sha256, sha256: body.sha256, size: body.size },
      });
      if (url.endsWith('/v1/sessions')) return jsonResponse({
        id: 'handoff-12345678',
        status: 'staged',
        stateVersion: 1,
      }, { status: 201 });
      if (url.endsWith('/v1/sessions/handoff-12345678/commands')) return jsonResponse({
        session: { id: 'handoff-12345678', status: 'queued', stateVersion: 2 },
      });
      throw new Error(`unexpected request ${url}`);
    }),
  });
  const timeline = portableTimeline();
  const session = await client.transfer({
    sessionId: 'handoff-12345678',
    provider: 'codex',
    executionConfig: { model: 'gpt-5.6', effort: 'high', workflow: 'direct', permissionProfile: 'unrestricted' },
    goal: 'Continue',
    documentName: 'document.hwpx',
    documentBytes: Buffer.from('document'),
    timeline,
    resources: [{ name: 'notes.txt', bytes: Buffer.from('notes') }],
    limits: { maxDurationMinutes: 480, maxTurns: 100 },
  });
  assert.equal(session.status, 'queued');
  const timelineInit = requests
    .filter((request) => request.url.endsWith('/v1/uploads/init'))
    .find((request) => request.body.kind === 'timeline');
  assert.equal(timelineInit.body.size, Buffer.byteLength(JSON.stringify(timeline)));
  assert.ok(requests.some((request) => request.body?.kind === 'reference'));
  const activate = requests.find((request) => request.url.endsWith('/commands'));
  const create = requests.find((request) => request.url.endsWith('/v1/sessions'));
  assert.deepEqual(create.body.executionConfig, {
    model: 'gpt-5.6', effort: 'high', workflow: 'direct', permissionProfile: 'unrestricted',
  });
  assert.equal(activate.body.type, 'session.activate');
  assert.equal(activate.body.payload.expectedVersion, 1);
  assert.equal(activate.body.commandId, 'activate_handoff-12345678');
});

test('committed handoffs clear their staged payload without losing metadata', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-clear-'));
  t.after(async () => {
    // Wait for any trailing debounced write so cleanup cannot race it.
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const record = await store.create({
    sessionId: 'desktop-session',
    threadId: 'thread-1',
    documentId: 'document-1',
    documentName: 'document.hwpx',
    documentBytes: Buffer.from('document'),
    provider: 'codex',
    goal: 'Continue',
    timeline: { schema: 'rauhwpx.cloud.timeline', version: 1 },
    limits: { maxTurns: 100 },
    resources: [{ id: 'ref-1', name: 'notes.txt', scope: 'chat', scopeId: 'thread-1', bytes: Buffer.from('notes') }],
  });
  const payload = await store.readPayload(record.id);
  assert.deepEqual(Buffer.from(payload.documentBytes), Buffer.from('document'));
  assert.deepEqual(Buffer.from(payload.resources[0].bytes), Buffer.from('notes'));
  await store.clearPayload(record.id);
  const cleared = await store.get(record.id);
  assert.equal(cleared.documentStagingPath, null);
  assert.equal(cleared.resources[0].stagingPath, undefined);
  await assert.rejects(store.readPayload(record.id), /unavailable/);
});

test('timeline downloads require a verified portable timeline envelope', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const vault = memoryVault({
    'cloud.profile': JSON.stringify(profile),
    'cloud.refresh': 'refresh',
  });
  const makeClient = (timeline) => new CloudClient({
    vault,
    fetchImpl: signedFetch(async (url) => {
      if (url.endsWith('/v1/token/refresh')) return jsonResponse({
        accessToken: 'access',
        accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'refresh',
      });
      const bytes = Buffer.from(JSON.stringify(timeline));
      return new Response(bytes, {
        headers: {
          'content-type': 'application/json',
          'content-length': String(bytes.length),
          'x-content-sha256': sha256Hex(bytes),
          'x-rauhwpx-server-key': SERVER_KEY,
        },
      });
    }),
  });
  assert.deepEqual((await makeClient(portableTimeline()).downloadTimeline('session-1')).timeline.schema, 'rauhwpx.cloud.timeline');
  await assert.rejects(
    makeClient({ schema: 'wrong', version: 1 }).downloadTimeline('session-1'),
    /portable timeline schema/,
  );
});

test('result downloads reject a missing content digest', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const vault = memoryVault({
    'cloud.profile': JSON.stringify(profile),
    'cloud.refresh': 'refresh',
  });
  const bytes = Buffer.from('document-bytes');
  const client = new CloudClient({
    vault,
    fetchImpl: signedFetch(async (url) => {
      if (url.endsWith('/v1/token/refresh')) return jsonResponse({
        accessToken: 'access',
        accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'refresh',
      });
      return new Response(bytes, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
          'x-rauhwpx-server-key': SERVER_KEY,
        },
      });
    }),
  });
  await assert.rejects(client.downloadResult('result-1'), /digest does not match/);
});

test('downloaded results reopen from verified local recovery and disappear after resolution', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-reopen-'));
  t.after(async () => {
    // Wait for any trailing debounced write so cleanup cannot race it.
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const record = await store.create({
    sessionId: 'desktop-session',
    threadId: 'thread-1',
    documentId: 'document-1',
    documentName: 'document.hwpx',
    documentBytes: Buffer.from('origin'),
    provider: 'codex',
    goal: 'Continue',
    timeline: portableTimeline(),
    limits: { maxTurns: 100 },
  });
  await store.transition(record.id, 'uploading');
  await store.transition(record.id, 'committing');
  await store.transition(record.id, 'queued', { cloudSessionId: 'cloud-session-1' });
  await store.clearPayload(record.id);
  await store.transition(record.id, 'running');
  await store.transition(record.id, 'completed');
  await store.transition(record.id, 'downloading');
  const recoveryDirectory = path.join(directory, 'recovery', record.id);
  const recoveryPath = path.join(recoveryDirectory, 'document.hwpx');
  const timelinePath = path.join(recoveryDirectory, 'timeline.json');
  const resultBytes = Buffer.from('edited-result');
  const timelineBytes = Buffer.from(JSON.stringify(portableTimeline({ messages: [{ role: 'assistant', text: 'Done' }] })));
  await mkdir(recoveryDirectory, { recursive: true });
  await writeFile(recoveryPath, resultBytes);
  await writeFile(timelinePath, timelineBytes);
  await store.patch(record.id, {
    recoveryPath,
    resultName: 'document.hwpx',
    resultDigest: sha256Hex(resultBytes),
    resultSize: resultBytes.length,
    timelineRecoveryPath: timelinePath,
    timelineDigest: sha256Hex(timelineBytes),
    timelineSize: timelineBytes.length,
    timeline: JSON.parse(timelineBytes),
  });
  await store.transition(record.id, 'downloaded');
  let networkReads = 0;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      session: async () => { networkReads += 1; throw new Error('must stay local'); },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  const reopened = await coordinator.downloadResult({ sessionId: 'cloud-session-1' });
  assert.deepEqual(Buffer.from(reopened.bytes), resultBytes);
  assert.equal(networkReads, 0);
  const resolved = await coordinator.recordResolution(record.id, { action: 'discard', path: null, conflict: false });
  assert.equal(resolved.session.kind, 'idle');
  await assert.rejects(readFile(recoveryPath), /ENOENT/);
});

test('resolved recovery cleanup resumes idempotently after an app restart', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-resolution-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recoveryRoot = path.join(directory, 'recovery');
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const record = await store.create({
    sessionId: 'desktop-session', threadId: 'thread-1', documentId: 'document-1',
    documentName: 'document.hwpx', documentBytes: Buffer.from('origin'),
    provider: 'codex', goal: 'Continue', timeline: portableTimeline(), limits: { maxTurns: 100 },
  });
  await store.transition(record.id, 'uploading');
  await store.transition(record.id, 'committing');
  await store.transition(record.id, 'queued', { cloudSessionId: 'cloud-session-1' });
  await store.clearPayload(record.id);
  await store.transition(record.id, 'running');
  await store.transition(record.id, 'completed');
  await store.transition(record.id, 'downloading');
  await store.transition(record.id, 'downloaded');
  const recoveryDirectory = path.join(recoveryRoot, record.id);
  const recoveryPath = path.join(recoveryDirectory, 'document.hwpx');
  await mkdir(recoveryDirectory, { recursive: true });
  await writeFile(recoveryPath, Buffer.from('edited-result'));
  await store.patch(record.id, {
    resolvedAt: new Date().toISOString(),
    resolution: 'replace',
    resolvedPath: path.join(directory, 'document.hwpx'),
    recoveryPath: null,
    timelineRecoveryPath: null,
    recoveryCleanupPath: recoveryPath,
  });

  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null, isPaired: async () => false },
    store,
    provisioner: {},
    recoveryDir: recoveryRoot,
  });
  t.after(() => coordinator.stop());
  await coordinator.start();
  await assert.rejects(readFile(recoveryPath), /ENOENT/);
  assert.equal((await store.get(record.id)).recoveryCleanupPath, null);

  await coordinator.start();
  assert.equal((await store.get(record.id)).recoveryCleanupPath, null);
});

test('desktop and VPS provider auth catalogs stay aligned', () => {
  assert.deepEqual(Object.keys(DESKTOP_PROVIDER_AUTH), [...PROVIDERS]);
  for (const provider of PROVIDERS) {
    assert.equal(DESKTOP_PROVIDER_AUTH[provider].secretName, PROVIDER_AUTH[provider].secretName);
    for (const file of DESKTOP_PROVIDER_AUTH[provider].files) {
      assert.ok(PROVIDER_AUTH[provider].files.includes(file.destination), `${provider} ${file.destination}`);
    }
  }
});

test('collectProviderAuth gathers API keys and allow-listed files for every provider', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'rauhwpx-provider-home-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const secrets = {
    'rhwp.claude.api-key': 'sk-ant-local',
    'rhwp.codex.api-key': 'sk-proj-local',
    'rhwp.pi.openrouter-api-key': 'sk-or-local',
    'rhwp.grok.api-key': 'xai-local',
    'rhwp.cursor.api-key': 'cur-local',
  };
  await mkdir(path.join(homeDir, '.claude'), { recursive: true });
  await mkdir(path.join(homeDir, '.codex'), { recursive: true });
  await mkdir(path.join(homeDir, '.grok'), { recursive: true });
  await mkdir(path.join(homeDir, '.cursor'), { recursive: true });
  await writeFile(path.join(homeDir, '.claude', '.credentials.json'), '{"oauth":"claude"}');
  await writeFile(path.join(homeDir, '.codex', 'auth.json'), '{"token":"codex"}');
  await writeFile(path.join(homeDir, '.grok', 'auth.json'), '{"token":"grok"}');
  await writeFile(path.join(homeDir, '.cursor', 'cli-config.json'), '{"auth":"cursor"}');
  for (const provider of PROVIDERS) {
    const bundle = await collectProviderAuth(provider, {
      homeDir,
      env: {},
      readSecret: async (key) => secrets[key] ?? null,
    });
    assert.equal(bundle.secrets[DESKTOP_PROVIDER_AUTH[provider].secretName], secrets[DESKTOP_PROVIDER_AUTH[provider].secretId]);
    if (provider !== 'pi') assert.ok(Object.keys(bundle.files).length > 0, provider);
  }
});

test('transfer imports provider auth before staging the session', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const vault = memoryVault({
    'cloud.profile': JSON.stringify(profile),
    'cloud.refresh': 'refresh-old',
  });
  const requests = [];
  const client = new CloudClient({
    vault,
    fetchImpl: signedFetch(async (url, options) => {
      const body = options.body && String(options.headers['content-type']).includes('json')
        ? JSON.parse(options.body)
        : null;
      requests.push({ url, options, body });
      if (url.endsWith('/v1/token/refresh')) return jsonResponse({
        accessToken: 'access',
        accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'refresh-new',
        refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      if (url.endsWith('/v1/providers/codex/auth')) return jsonResponse({
        provider: { provider: 'codex', available: true, authenticated: true },
        importedSecrets: Object.keys(body.secrets),
        importedFiles: Object.keys(body.files),
      });
      if (url.endsWith('/v1/uploads/init')) return jsonResponse({
        uploadId: `upload-${requests.length}`,
        chunkSize: 1024,
        offset: body.size,
        status: 'complete',
        blobExists: true,
        blob: { id: body.sha256, sha256: body.sha256, size: body.size },
      });
      if (url.endsWith('/v1/sessions')) return jsonResponse({
        id: 'handoff-auth-01',
        status: 'staged',
        stateVersion: 1,
      }, { status: 201 });
      if (url.endsWith('/v1/sessions/handoff-auth-01/commands')) return jsonResponse({
        session: { id: 'handoff-auth-01', status: 'queued', stateVersion: 2 },
      });
      throw new Error(`unexpected request ${url}`);
    }),
  });
  await client.transfer({
    sessionId: 'handoff-auth-01',
    provider: 'codex',
    executionConfig: { model: 'gpt-5.6', effort: 'high', workflow: 'direct', permissionProfile: 'unrestricted' },
    goal: 'Continue',
    documentName: 'document.hwpx',
    documentBytes: Buffer.from('document'),
    timeline: portableTimeline(),
    limits: { maxDurationMinutes: 480, maxTurns: 100 },
    providerAuth: {
      secrets: { OPENAI_API_KEY: 'sk-proj-moved' },
      files: { '.codex/auth.json': '{"token":"moved"}' },
    },
  });
  const imported = requests.find((request) => request.url.endsWith('/v1/providers/codex/auth'));
  const created = requests.find((request) => request.url.endsWith('/v1/sessions'));
  assert.deepEqual(imported.body, {
    secrets: { OPENAI_API_KEY: 'sk-proj-moved' },
    files: { '.codex/auth.json': '{"token":"moved"}' },
  });
  assert.ok(requests.indexOf(imported) < requests.indexOf(created));
});

test('transfer accepts a POST-seeded sandbox when PUT auth import is unavailable', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const requests = [];
  const client = new CloudClient({
    vault: memoryVault({
      'cloud.profile': JSON.stringify(profile),
      'cloud.refresh': 'refresh-old',
    }),
    fetchImpl: signedFetch(async (url, options) => {
      const body = options.body && String(options.headers['content-type']).includes('json')
        ? JSON.parse(options.body)
        : null;
      requests.push({ url, body });
      if (url.endsWith('/v1/token/refresh')) return jsonResponse({
        accessToken: 'access',
        accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'refresh-new',
        refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      if (url.endsWith('/v1/providers/codex/auth')) return jsonResponse({
        error: { code: 'NOT_FOUND', message: 'Endpoint was not found' },
      }, { status: 404 });
      if (url.endsWith('/v1/profile')) return jsonResponse({
        providers: [{ provider: 'codex', available: true, authenticated: true }],
      });
      if (url.endsWith('/v1/uploads/init')) return jsonResponse({
        uploadId: `upload-${requests.length}`,
        chunkSize: 1024,
        offset: body.size,
        status: 'complete',
        blobExists: true,
        blob: { id: body.sha256, sha256: body.sha256, size: body.size },
      });
      if (url.endsWith('/v1/sessions')) return jsonResponse({
        id: 'handoff-post-only', status: 'staged', stateVersion: 1,
      }, { status: 201 });
      if (url.endsWith('/v1/sessions/handoff-post-only/commands')) return jsonResponse({
        session: { id: 'handoff-post-only', status: 'queued', stateVersion: 2 },
      });
      throw new Error(`unexpected request ${url}`);
    }),
  });
  await client.transfer({
    sessionId: 'handoff-post-only',
    provider: 'codex',
    executionConfig: { model: 'gpt-5.6', effort: 'high', workflow: 'direct', permissionProfile: 'unrestricted' },
    goal: 'Continue',
    documentName: 'document.hwpx',
    documentBytes: Buffer.from('document'),
    timeline: portableTimeline(),
    limits: { maxDurationMinutes: 480, maxTurns: 100 },
    providerAuth: { secrets: {}, files: { '.codex/auth.json': '{"token":"moved"}' } },
  });
  const imported = requests.find((request) => request.url.endsWith('/v1/providers/codex/auth'));
  const checked = requests.find((request) => request.url.endsWith('/v1/profile'));
  const uploaded = requests.find((request) => request.url.endsWith('/v1/uploads/init'));
  assert.ok(requests.indexOf(imported) < requests.indexOf(checked));
  assert.ok(requests.indexOf(checked) < requests.indexOf(uploaded));
});

test('transfer reports unsupported auth only after both import protocols are unavailable', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const requests = [];
  const client = new CloudClient({
    vault: memoryVault({
      'cloud.profile': JSON.stringify(profile),
      'cloud.refresh': 'refresh-old',
    }),
    fetchImpl: signedFetch(async (url) => {
      requests.push(url);
      if (url.endsWith('/v1/token/refresh')) return jsonResponse({
        accessToken: 'access',
        accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'refresh-new',
        refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      if (url.endsWith('/v1/providers/codex/auth')) return jsonResponse({
        error: { code: 'AUTH_IMPORT_UNAVAILABLE', message: 'This VPS cannot import provider credentials' },
      }, { status: 501 });
      if (url.endsWith('/v1/profile')) return jsonResponse({
        providers: [{ provider: 'codex', available: true, authenticated: false }],
      });
      throw new Error(`unexpected request ${url}`);
    }),
  });
  await assert.rejects(client.transfer({
    sessionId: 'handoff-unsupported',
    provider: 'codex',
    executionConfig: { model: 'gpt-5.6', effort: 'high', workflow: 'direct', permissionProfile: 'unrestricted' },
    goal: 'Continue',
    documentName: 'document.hwpx',
    documentBytes: Buffer.from('document'),
    timeline: portableTimeline(),
    limits: { maxDurationMinutes: 480, maxTurns: 100 },
    providerAuth: { secrets: {}, files: { '.codex/auth.json': '{"token":"moved"}' } },
  }), (error) => (
    error.code === 'SANDBOX_AUTH_UNSUPPORTED'
    && /cannot import that login/.test(error.message)
  ));
  assert.equal(requests.filter((url) => url.endsWith('/v1/uploads/init')).length, 0);
});

test('AUTH_REQUIRED fails the transfer once instead of retrying recovery', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-auth-fail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  let transferCalls = 0;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => true,
      transfer: async () => {
        transferCalls += 1;
        throw new CloudHttpError('codex must be authenticated on this VPS', {
          status: 409,
          code: 'AUTH_REQUIRED',
        });
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
    collectProviderAuth: async () => ({
      secrets: { OPENAI_API_KEY: 'sk-proj-local' },
      files: { '.codex/auth.json': '{"token":"local"}' },
    }),
  });
  t.after(() => coordinator.stop());
  await assert.rejects(
    coordinator.transfer({
      ...cloudStartFields({ startId: 'startauth' }),
      agent: 'codex',
      threadId: 'thread-auth',
      documentId: 'document-auth',
      document: { fileName: 'document.hwpx', bytes: Buffer.from('document') },
      limits: { maxDurationMs: 15 * 60_000, maxTurns: 8 },
    }, { originSessionId: 'desktop-auth' }),
    (error) => error.code === 'AUTH_REQUIRED',
  );
  const records = await store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'failed');
  assert.equal(records[0].error, 'codex must be authenticated on this VPS');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(transferCalls, 1);
});

test('concurrent requests cannot stage duplicate document transfers', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-duplicate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const profile = { endpoint: 'https://sandbox.example/rauhwpx-cloud', mode: 'app-hosted', serverPublicKey: SERVER_KEY, sandbox: { providerId: 'railway', sandboxId: 'sandbox-1' } };
  const client = {
    assertTransferReady: async () => ({ profile, health: { protocolVersion: 1, version: '1.1.0' } }),
    loadProfile: async () => profile,
    isPaired: async () => true,
    transfer: async ({ signal }) => new Promise((_resolve, reject) => {
      const stopped = () => reject(Object.assign(new Error('stopped'), { code: 'ECONNRESET' }));
      if (signal.aborted) stopped();
      else signal.addEventListener('abort', stopped, { once: true });
    }),
  };
  const coordinator = new CloudCoordinator({
    client,
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  const payload = {
    ...cloudStartFields({ startId: 'startdup1' }),
    agent: 'codex',
    threadId: 'thread-duplicate',
    documentId: 'document-duplicate',
    document: { fileName: 'duplicate.hwpx', bytes: Buffer.from('document') },
  };
  const first = coordinator.transfer(payload, { originSessionId: 'desktop-duplicate' });
  while ((await store.list()).length === 0) await new Promise((resolve) => setImmediate(resolve));
  const retrySameStart = coordinator.transfer(payload, { originSessionId: 'desktop-duplicate' });
  await assert.rejects(
    coordinator.transfer({
      ...payload,
      ...cloudStartFields({ startId: 'startdup2' }),
    }, { originSessionId: 'desktop-duplicate' }),
    (error) => error.code === 'TRANSFER_ALREADY_ACTIVE',
  );
  assert.equal((await store.list()).length, 1);
  const otherDocument = coordinator.transfer({
    ...payload,
    ...cloudStartFields({ startId: 'startdup3' }),
    threadId: 'thread-other-document',
    documentId: 'document-other',
  }, { originSessionId: 'desktop-duplicate' });
  while ((await store.list()).length < 2) await new Promise((resolve) => setImmediate(resolve));
  const stopped = assert.rejects(first, /stopped/);
  const retryStopped = assert.rejects(retrySameStart, /stopped/);
  const otherStopped = assert.rejects(otherDocument, /stopped/);
  await coordinator.stop();
  await stopped;
  await retryStopped;
  await otherStopped;
});

test('a completed recovery on a replaced server does not block a new document transfer', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-replaced-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  let profile = { endpoint: 'https://old.example/rauhwpx-cloud', mode: 'app-hosted', serverPublicKey: SERVER_KEY,
    sandbox: { providerId: 'railway', sandboxId: 'old-sandbox' } };
  const old = await store.create({
    sessionId: 'desktop-origin', documentId: 'same-document', threadId: 'old-thread',
    documentName: 'document.hwpx', documentBytes: Buffer.from('original'),
    destination: coordinatorTest.destinationFromReadiness({ profile }),
  });
  await store.transition(old.id, 'completed');
  const coordinator = new CloudCoordinator({
    client: {
      assertTransferReady: async () => ({ profile }), loadProfile: async () => profile, isPaired: async () => true,
      transfer: async () => { throw new CloudHttpError('Test reached the new server', { status: 409, code: 'AUTH_REQUIRED' }); },
    },
    store, provisioner: {}, recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(() => coordinator.stop());
  const payload = {
    ...cloudStartFields({ startId: 'replaced1' }), agent: 'codex', threadId: 'new-thread', documentId: 'same-document',
    document: { fileName: 'document.hwpx', bytes: Buffer.from('original') },
  };
  await assert.rejects(coordinator.transfer(payload, { originSessionId: 'desktop-origin' }),
    (error) => error.code === 'TRANSFER_ALREADY_ACTIVE');
  profile = { ...profile, endpoint: 'https://new.example/rauhwpx-cloud', sandbox: { ...profile.sandbox, sandboxId: 'new-sandbox' } };
  await assert.rejects(coordinator.transfer(payload, { originSessionId: 'desktop-origin' }),
    (error) => error.code === 'AUTH_REQUIRED');
  assert.equal((await store.get(old.id)).state, 'completed', 'keep the old recovery record');
  assert.equal((await store.list()).length, 2);
});

test('missing cloud configuration fails once instead of entering transfer recovery', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-unconfigured-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  let networkCalls = 0;
  const client = new CloudClient({
    vault: memoryVault(),
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error('an unconfigured transfer must not reach the network');
    },
  });
  await assert.rejects(client.profile(), (error) => (
    error.code === 'CLOUD_NOT_CONFIGURED'
    && error.message === 'Cloud server is not configured'
  ));

  const coordinator = new CloudCoordinator({
    client,
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
    collectProviderAuth: async () => ({
      secrets: { OPENAI_API_KEY: 'sk-proj-local' },
      files: {},
    }),
  });
  t.after(() => coordinator.stop());
  await assert.rejects(
    coordinator.transfer({
      ...cloudStartFields({ startId: 'startnone' }),
      agent: 'codex',
      threadId: 'thread-unconfigured',
      documentId: 'document-unconfigured',
      document: { fileName: 'document.hwpx', bytes: Buffer.from('document') },
      limits: { maxDurationMs: 15 * 60_000, maxTurns: 8 },
    }, { originSessionId: 'desktop-unconfigured' }),
    (error) => error.code === 'CLOUD_NOT_CONFIGURED',
  );
  assert.deepEqual(await store.list(), []);
  await assert.rejects(
    access(path.join(directory, 'pending-payloads')),
    (error) => error.code === 'ENOENT',
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(networkCalls, 0);
});

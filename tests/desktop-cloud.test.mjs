import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CloudClient, __test as clientTest } from '../desktop/cloud-client.mjs';
import { CloudCoordinator, __test as coordinatorTest } from '../desktop/cloud-coordinator.mjs';
import { CloudHandoffStore, sha256Hex } from '../desktop/cloud-handoff.mjs';
import { normalizeCloudProfile, normalizeTailscaleHttpsPort } from '../desktop/cloud-profile.mjs';
import { sshArguments, __test as provisionerTest } from '../desktop/cloud-provisioner.mjs';
import { applyCloudRecovery } from '../desktop/cloud-result.mjs';

const SERVER_IDENTITY = generateKeyPairSync('ed25519');
const SERVER_KEY = `ed25519:${SERVER_IDENTITY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;

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
      messages: [],
      ...overrides,
    },
  };
}

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

test('Tailscale HTTPS port persists through profiles, UI conversion, and provisioning receipts', () => {
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

test('result resolution replaces unchanged origins and preserves conflicts', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-result-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalPath = path.join(directory, 'report.hwpx');
  const recoveryPath = path.join(directory, 'recovery.hwpx');
  const original = Buffer.from('original');
  const cloud = Buffer.from('cloud-result');
  await writeFile(originalPath, original);
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
    platform: 'win32',
  });
  assert.deepEqual(await readFile(windowsOriginal), cloud);
  assert.deepEqual(await readFile(userBackup), Buffer.from('user-owned-backup'));
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
  t.after(() => rm(directory, { recursive: true, force: true }));
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

test('downloaded results reopen from verified local recovery and disappear after resolution', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-reopen-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
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

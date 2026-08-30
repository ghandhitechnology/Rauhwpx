import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuthService } from '../src/auth.mjs';
import { BlobStore } from '../src/blob-store.mjs';
import { openDatabase } from '../src/database.mjs';
import { DisplayFrameStore, MAX_DISPLAY_FRAME_BYTES } from '../src/display-frame-store.mjs';
import { createCloudHttpHandler } from '../src/http-server.mjs';
import { applyProviderAuth, parseProviderAuth } from '../src/provider-auth.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { SecretVault } from '../src/secret-vault.mjs';
import { WorkerClient } from '../worker/client.mjs';
import {
  SSE_STREAM_DIGEST,
  canonicalResponse,
  canonicalSseEvent,
} from '../src/response-proof.mjs';

const cloudVersion = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

function testIdentity() {
  const pair = generateKeyPairSync('ed25519');
  const encodedKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    serverPublicKey: `ed25519:${encodedKey}`,
    serverId: createHash('sha256').update(encodedKey).digest('hex').slice(0, 24),
  };
}

function proofNonce() {
  return randomBytes(24).toString('base64url');
}

function publicFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('X-Rauhwpx-Request-Nonce', options.proofNonce ?? proofNonce());
  const { proofNonce: _ignored, ...fetchOptions } = options;
  return fetch(url, { ...fetchOptions, headers });
}

function jpeg(width, height, content = '') {
  const comment = Buffer.from(content);
  const commentLength = Buffer.alloc(2);
  commentLength.writeUInt16BE(comment.length + 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xfe]),
    commentLength,
    comment,
    Buffer.from([
      0xff, 0xc0, 0x00, 0x0b, 0x08,
      height >> 8, height & 0xff,
      width >> 8, width & 0xff,
      0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ]),
  ]);
}

async function assertResponseProof(response, identity, { nonce, method = 'GET', pathAndQuery }) {
  const bytes = Buffer.from(await response.clone().arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(response.headers.get('x-rauhwpx-content-sha256'), digest);
  const canonical = canonicalResponse({ nonce, method, pathAndQuery, status: response.status, digest });
  assert.equal(verify(
    null,
    Buffer.from(canonical),
    identity.publicKey,
    Buffer.from(response.headers.get('x-rauhwpx-response-signature'), 'base64url'),
  ), true);
  return { bytes, digest, canonical };
}

async function fixture(t, {
  workerOnly = false,
  withProviderAuth = false,
  withWorkerControl = false,
  displayFrames = true,
  seedProvider,
  browserOrigins = [],
  managedLease = null,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cloud-http-'));
  const database = openDatabase(path.join(root, 'cloud.sqlite3'));
  const blobStore = new BlobStore(database, { root: path.join(root, 'objects'), chunkBytes: 8 });
  const auth = new AuthService(database);
  const displayFrameStore = displayFrames ? new DisplayFrameStore() : null;
  const sessionStore = new SessionStore(database, blobStore, {
    onRuntimeInvalidated: (sessionId) => displayFrameStore?.closeSession(sessionId),
  });
  const identity = testIdentity();
  const config = {
    basePath: '/rauhwpx-cloud', maxRunningSessions: 2, maxQueuedSessions: 20, browserOrigins,
  };
  const logger = { error() {} };
  const vault = withProviderAuth
    ? new SecretVault(database, { dataDirectory: root })
    : { list: () => [], get: () => null };
  const apply = withProviderAuth
    ? async (provider, raw) => {
      const imported = await applyProviderAuth(provider, parseProviderAuth(provider, raw), {
        vault,
        authDirectory: path.join(root, 'provider-auth'),
      });
      return {
        ...imported,
        provider: sessionStore.setProviderStatus(provider, { available: true, authenticated: true, version: '1' }),
      };
    }
    : null;
  const services = {
    auth, blobStore, sessionStore, identity, config, logger, vault,
    displayFrameStore,
    applyProviderAuth: apply,
    seedProvider,
    managedLease,
  };
  const server = http.createServer(createCloudHttpHandler(services, { workerOnly }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const workerServer = withWorkerControl
    ? http.createServer(createCloudHttpHandler(services, { workerOnly: true }))
    : null;
  if (workerServer) await new Promise((resolve) => workerServer.listen(0, '127.0.0.1', resolve));
  const workerBase = workerServer ? `http://127.0.0.1:${workerServer.address().port}` : null;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (workerServer) {
      workerServer.closeAllConnections();
      await new Promise((resolve) => workerServer.close(resolve));
    }
    displayFrameStore?.closeAll();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    base,
    workerBase,
    database,
    blobStore,
    displayFrameStore,
    auth,
    sessionStore,
    identity,
    root,
  };
}

test('configured PWA origins receive narrow CORS headers and unlisted origins fail preflight', async (t) => {
  const origin = 'https://studio.example.com';
  const { base } = await fixture(t, { browserOrigins: [origin] });
  const allowed = await fetch(`${base}/rauhwpx-cloud/v1/health`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'x-rauhwpx-request-nonce',
    },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
  assert.match(allowed.headers.get('access-control-expose-headers'), /X-Rauhwpx-Response-Signature/);
  const denied = await fetch(`${base}/rauhwpx-cloud/v1/health`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET' },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

async function pairOverHttp(auth, base) {
  const pairing = auth.createPairingCode();
  const response = await publicFetch(`${base}/rauhwpx-cloud/v1/pairing/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, deviceName: 'Origin' }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function uploadOverHttp(base, accessToken, bytes, { name, kind }) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const headers = { Authorization: `Bearer ${accessToken}` };
  let state = await (await publicFetch(`${base}/v1/uploads/init`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256, size: bytes.length, name, kind }),
  })).json();
  while (state.status !== 'complete') {
    const chunk = bytes.subarray(state.offset, state.offset + state.chunkSize);
    const response = await publicFetch(`${base}/v1/uploads/${state.uploadId}/chunks`, {
      method: 'POST',
      headers: { ...headers, 'X-Upload-Offset': String(state.offset), 'Content-Type': 'application/octet-stream' },
      body: chunk,
    });
    assert.equal(response.status, 200);
    state = await response.json();
  }
  return state.blob;
}

test('public API pins every response, supports the Tailscale path, and rejects worker routes', async (t) => {
  const { base, auth, identity } = await fixture(t);
  const health = await fetch(`${base}/rauhwpx-cloud/v1/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-rauhwpx-server-key'), identity.serverPublicKey);
  assert.deepEqual(await health.json(), {
    ok: true,
    version: cloudVersion,
    protocolVersion: 1,
    serverPublicKey: identity.serverPublicKey,
    serverId: identity.serverId,
  });
  const tokens = await pairOverHttp(auth, base);
  const worker = await publicFetch(`${base}/v1/internal/worker/session/heartbeat`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  assert.equal(worker.status, 404);
  assert.equal(worker.headers.get('x-rauhwpx-server-key'), identity.serverPublicKey);
});

test('Ed25519 JSON proofs bind the configured external path behind a path-stripping proxy', async (t) => {
  const { base, auth, identity } = await fixture(t);
  const tokens = await pairOverHttp(auth, base);
  const nonce = proofNonce();
  const response = await publicFetch(`${base}/v1/profile?proof=exact`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    proofNonce: nonce,
  });
  assert.equal(response.status, 200);
  const checked = await assertResponseProof(response, identity, {
    nonce,
    pathAndQuery: '/rauhwpx-cloud/v1/profile?proof=exact',
  });

  const tampered = Buffer.from(checked.bytes);
  tampered[tampered.length - 2] ^= 1;
  assert.notEqual(createHash('sha256').update(tampered).digest('hex'), checked.digest);

  const responseSignature = Buffer.from(response.headers.get('x-rauhwpx-response-signature'), 'base64url');
  const strippedProxyCanonical = canonicalResponse({
    nonce,
    method: 'GET',
    pathAndQuery: '/v1/profile?proof=exact',
    status: 200,
    digest: checked.digest,
  });
  assert.equal(verify(null, Buffer.from(strippedProxyCanonical), identity.publicKey, responseSignature), false);
  const replayCanonical = canonicalResponse({
    nonce: proofNonce(), method: 'GET', pathAndQuery: '/rauhwpx-cloud/v1/profile?proof=exact', status: 200, digest: checked.digest,
  });
  assert.equal(verify(null, Buffer.from(replayCanonical), identity.publicKey, responseSignature), false);

  const impostor = generateKeyPairSync('ed25519');
  const impostorSignature = sign(null, Buffer.from(checked.canonical), impostor.privateKey);
  assert.equal(verify(null, Buffer.from(checked.canonical), identity.publicKey, impostorSignature), false);

  const prefixedNonce = proofNonce();
  const prefixed = await publicFetch(`${base}/rauhwpx-cloud/v1/profile?proof=prefixed`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    proofNonce: prefixedNonce,
  });
  await assertResponseProof(prefixed, identity, {
    nonce: prefixedNonce,
    pathAndQuery: '/rauhwpx-cloud/v1/profile?proof=prefixed',
  });

  const unsigned = await fetch(`${base}/v1/profile`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  assert.equal(unsigned.status, 400);
  assert.equal((await unsigned.json()).error.code, 'PROOF_NONCE_REQUIRED');
});

test('HTTP handoff, idempotent command, SSE replay, and verified result download work end to end', async (t) => {
  const admittedCommands = [];
  const managedLease = {
    async assertCommandAllowed(type) {
      admittedCommands.push(type);
      if (type === 'message.queue') {
        throw Object.assign(new Error('Managed Cloud input is blocked'), {
          code: 'MANAGED_CLOUD_INPUT_BLOCKED', status: 409,
        });
      }
    },
  };
  const { base, auth, sessionStore, identity } = await fixture(t, { managedLease });
  const tokens = await pairOverHttp(auth, base);
  const secondPairing = auth.createPairingCode();
  const second = auth.redeemPairingCode({ code: secondPairing.code, deviceName: 'Second' });
  sessionStore.setProviderStatus('codex', { available: true, version: 'codex 1' });
  const document = await uploadOverHttp(base, tokens.accessToken, Buffer.from('source'), { name: 'source.hwp', kind: 'document' });
  const timeline = await uploadOverHttp(base, tokens.accessToken, Buffer.from('[]'), { name: 'timeline.json', kind: 'timeline' });
  const sessionResponse = await publicFetch(`${base}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'session_http_01',
      provider: 'codex',
      goal: 'Finish',
      clientContext: { threadId: 'thread-1', documentId: null },
      executionConfig: {
        model: 'gpt-5.6-sol', effort: 'high', workflow: 'direct', permissionProfile: 'unrestricted',
      },
      originDocument: { blobId: document.id, size: document.size, name: 'source.hwp' },
      timeline: { blobId: timeline.id, size: timeline.size },
    }),
  });
  assert.equal(sessionResponse.status, 201);
  const createdSession = await sessionResponse.clone().json();
  assert.deepEqual(createdSession.clientContext, { threadId: 'thread-1', documentId: null });
  assert.equal(createdSession.executionConfig.model, 'gpt-5.6-sol');
  const pairedTimeline = await publicFetch(`${base}/v1/sessions/session_http_01/timeline`, {
    headers: { Authorization: `Bearer ${second.accessToken}` },
  });
  assert.equal(pairedTimeline.status, 200);
  assert.equal(await pairedTimeline.text(), '[]');
  const commandBody = { commandId: 'command_http_01', type: 'session.activate', payload: { expectedVersion: 1 } };
  const command = await publicFetch(`${base}/v1/sessions/session_http_01/commands`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commandBody),
  });
  assert.equal(command.status, 200);
  const commandResult = await command.json();
  const retry = await publicFetch(`${base}/v1/sessions/session_http_01/commands`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commandBody),
  });
  assert.deepEqual(await retry.json(), commandResult);
  const blockedMessage = await publicFetch(`${base}/v1/sessions/session_http_01/commands`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commandId: 'managed_blocked_01', type: 'message.queue', payload: { content: 'Too late' } }),
  });
  assert.equal(blockedMessage.status, 409);
  assert.equal((await blockedMessage.json()).error.code, 'MANAGED_CLOUD_INPUT_BLOCKED');
  assert.deepEqual(admittedCommands, ['session.activate', 'session.activate', 'message.queue']);

  const controller = new AbortController();
  const eventNonce = proofNonce();
  const events = await publicFetch(`${base}/v1/sessions/session_http_01/events?after=0`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: controller.signal, proofNonce: eventNonce,
  });
  assert.equal(events.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(events.headers.get('x-rauhwpx-stream-protocol'), 'rauhwpx-sse-v1');
  assert.equal(events.headers.get('x-rauhwpx-content-sha256'), SSE_STREAM_DIGEST);
  const streamCanonical = canonicalResponse({
    nonce: eventNonce,
    method: 'GET',
    pathAndQuery: '/rauhwpx-cloud/v1/sessions/session_http_01/events?after=0',
    status: 200,
    digest: SSE_STREAM_DIGEST,
  });
  assert.equal(verify(
    null,
    Buffer.from(streamCanonical),
    identity.publicKey,
    Buffer.from(events.headers.get('x-rauhwpx-response-signature'), 'base64url'),
  ), true);
  const strippedStreamCanonical = canonicalResponse({
    nonce: eventNonce,
    method: 'GET',
    pathAndQuery: '/v1/sessions/session_http_01/events?after=0',
    status: 200,
    digest: SSE_STREAM_DIGEST,
  });
  assert.equal(verify(
    null,
    Buffer.from(strippedStreamCanonical),
    identity.publicKey,
    Buffer.from(events.headers.get('x-rauhwpx-response-signature'), 'base64url'),
  ), false);
  const reader = events.body.getReader();
  let eventText = '';
  while (!eventText.includes('event: session.queued')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    eventText += Buffer.from(chunk.value).toString('utf8');
  }
  assert.match(eventText, /event: session\.created/);
  assert.match(eventText, /event: session\.queued/);
  assert.match(eventText, /"stateVersion":2/);
  const createdFrame = eventText.split('\n\n').find((frame) => frame.includes('event: session.created'));
  const frameFields = Object.fromEntries(createdFrame.split('\n').map((line) => {
    const separator = line.indexOf(': ');
    return [line.slice(0, separator), line.slice(separator + 2)];
  }));
  const eventDigest = createHash('sha256').update(frameFields.data).digest('hex');
  assert.equal(frameFields['rauhwpx-sha256'], eventDigest);
  const eventCanonical = canonicalSseEvent({
    nonce: eventNonce,
    method: 'GET',
    pathAndQuery: '/rauhwpx-cloud/v1/sessions/session_http_01/events?after=0',
    status: 200,
    seq: Number(frameFields.id),
    type: frameFields.event,
    digest: eventDigest,
  });
  assert.equal(verify(
    null,
    Buffer.from(eventCanonical),
    identity.publicKey,
    Buffer.from(frameFields['rauhwpx-signature'], 'base64url'),
  ), true);
  const strippedEventCanonical = canonicalSseEvent({
    nonce: eventNonce,
    method: 'GET',
    pathAndQuery: '/v1/sessions/session_http_01/events?after=0',
    status: 200,
    seq: Number(frameFields.id),
    type: frameFields.event,
    digest: eventDigest,
  });
  assert.equal(verify(
    null,
    Buffer.from(strippedEventCanonical),
    identity.publicKey,
    Buffer.from(frameFields['rauhwpx-signature'], 'base64url'),
  ), false);
  controller.abort();
  await reader.cancel().catch(() => {});

  sessionStore.claimNextSession();
  const checkpoint = await uploadOverHttp(
    base,
    tokens.accessToken,
    Buffer.from('stable-checkpoint'),
    { name: 'checkpoint.hwpx', kind: 'document' },
  );
  sessionStore.recordCheckpoint('session_http_01', {
    operationId: 'checkpoint_http_01', turnNumber: 1, revision: 7,
    blobId: checkpoint.id, stable: true,
  });
  assert.equal(sessionStore.workerManifest('session_http_01').executionConfig.workflow, 'direct');
  const checkpointDownload = await publicFetch(`${base}/v1/sessions/session_http_01/checkpoint`, {
    headers: { Authorization: `Bearer ${second.accessToken}` },
  });
  assert.equal(checkpointDownload.status, 200);
  assert.equal(checkpointDownload.headers.get('x-content-sha256'), checkpoint.sha256);
  assert.equal(checkpointDownload.headers.get('x-checkpoint-revision'), '7');
  assert.equal(checkpointDownload.headers.get('x-checkpoint-turn'), '1');
  assert.equal(checkpointDownload.headers.get('x-boundary-kind'), 'turn');
  assert.equal(decodeURIComponent(checkpointDownload.headers.get('x-document-name')), 'source.checkpoint-r7.hwp');
  assert.equal(await checkpointDownload.text(), 'stable-checkpoint');
  const result = await uploadOverHttp(base, tokens.accessToken, Buffer.from('finished'), { name: 'result.hwpx', kind: 'result' });
  assert.deepEqual(sessionStore.claimFinish('session_http_01'), { ready: true, messages: [] });
  sessionStore.publishResult('session_http_01', { blobId: result.id, size: result.size });
  const deniedDownload = await publicFetch(`${base}/v1/results/session_http_01`, {
    headers: { Authorization: `Bearer ${second.accessToken}` },
  });
  assert.equal(deniedDownload.status, 403);
  const resultNonce = proofNonce();
  const download = await publicFetch(`${base}/v1/results/session_http_01`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` }, proofNonce: resultNonce,
  });
  assert.equal(download.headers.get('x-content-sha256'), result.sha256);
  assert.equal(decodeURIComponent(download.headers.get('x-document-name')), 'source.hwp');
  await assertResponseProof(download, identity, {
    nonce: resultNonce,
    pathAndQuery: '/rauhwpx-cloud/v1/results/session_http_01',
  });
  assert.equal(await download.text(), 'finished');
  const confirmation = await publicFetch(`${base}/v1/results/session_http_01/download-confirmed`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256: result.sha256, size: result.size }),
  });
  assert.equal(confirmation.status, 200);
  const firstReceipt = await confirmation.json();
  assert.equal(firstReceipt.status, 'purged');
  const confirmationRetry = await publicFetch(`${base}/v1/results/session_http_01/download-confirmed`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256: result.sha256, size: result.size }),
  });
  assert.equal(confirmationRetry.status, 200);
  assert.deepEqual(await confirmationRetry.json(), firstReceipt);
});

test('SSE replays more than one page and closes the replay-to-live gap', async (t) => {
  const { base, auth, sessionStore } = await fixture(t);
  const tokens = await pairOverHttp(auth, base);
  sessionStore.setProviderStatus('codex', { available: true, version: 'codex 1' });
  const document = await uploadOverHttp(base, tokens.accessToken, Buffer.from('source'), {
    name: 'source.hwpx', kind: 'document',
  });
  const response = await publicFetch(`${base}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'session_sse_replay_01', provider: 'codex', goal: 'Replay',
      originDocument: { blobId: document.id, size: document.size, name: 'source.hwpx' },
    }),
  });
  assert.equal(response.status, 201);
  for (let index = 0; index < 1_005; index += 1) {
    sessionStore.appendEvent('session_sse_replay_01', 'replay.event', { index });
  }
  const subscribe = sessionStore.subscribe.bind(sessionStore);
  let injected = false;
  sessionStore.subscribe = (sessionId, listener) => {
    const unsubscribe = subscribe(sessionId, listener);
    if (!injected) {
      injected = true;
      sessionStore.appendEvent(sessionId, 'handoff.event', { gap: true });
    }
    return unsubscribe;
  };
  const controller = new AbortController();
  const events = await publicFetch(`${base}/v1/sessions/session_sse_replay_01/events?after=0`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: controller.signal,
  });
  const reader = events.body.getReader();
  let text = '';
  while (!text.includes('event: handoff.event')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += Buffer.from(chunk.value).toString('utf8');
  }
  assert.equal((text.match(/event: replay\.event/g) ?? []).length, 1_005);
  assert.equal((text.match(/event: handoff\.event/g) ?? []).length, 1);
  assert.match(text, /id: 1007\n/);
  controller.abort();
  await reader.cancel().catch(() => {});
});

test('worker API accepts only the session worker token', async (t) => {
  const { base, auth, blobStore, sessionStore } = await fixture(t, { workerOnly: true });
  const pairing = auth.createPairingCode();
  const tokens = auth.redeemPairingCode({ code: pairing.code, deviceName: 'Origin' });
  sessionStore.setProviderStatus('pi', { available: true, version: 'pi 1' });
  const bytes = Buffer.from('source');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const initialized = await blobStore.initUpload({
    deviceId: tokens.device.id, sha256: digest, size: bytes.length, name: 'source.hwpx', kind: 'document',
  });
  await blobStore.appendChunk({ uploadId: initialized.uploadId, deviceId: tokens.device.id, offset: 0, bytes });
  sessionStore.createSession(tokens.device, {
    sessionId: 'session_worker_01', provider: 'pi', goal: 'Work',
    originDocument: { blobId: digest, size: bytes.length, name: 'source.hwpx' },
    resources: [], timeline: null, limits: { maxDurationSeconds: 3600, maxTurns: 10 },
  });
  sessionStore.executeCommand(tokens.device, 'session_worker_01', {
    commandId: 'command_worker_01', type: 'session.activate', payload: { expectedVersion: 1 },
  });
  sessionStore.claimNextSession();
  sessionStore.prepareWorker('session_worker_01', 'ra_wt_test');
  const denied = await fetch(`${base}/v1/internal/worker/session_worker_01/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer wrong' },
  });
  assert.equal(denied.status, 401);
  const heartbeat = await fetch(`${base}/v1/internal/worker/session_worker_01/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer ra_wt_test' },
  });
  assert.equal(heartbeat.status, 200);
  assert.deepEqual(await new WorkerClient({
    baseUrl: base,
    token: 'ra_wt_test',
    sessionId: 'session_worker_01',
  }).heartbeat(), { ok: true });
  const checkpointBytes = Buffer.from('edit');
  const checkpointDigest = createHash('sha256').update(checkpointBytes).digest('hex');
  const checkpointUpload = await blobStore.initUpload({
    deviceId: tokens.device.id, sha256: checkpointDigest, size: checkpointBytes.length,
    name: 'checkpoint.hwpx', kind: 'document',
  });
  const checkpoint = (await blobStore.appendChunk({
    uploadId: checkpointUpload.uploadId, deviceId: tokens.device.id, offset: 0, bytes: checkpointBytes,
  })).blob;
  const timelineBytes = Buffer.from('[1]');
  const timelineDigest = createHash('sha256').update(timelineBytes).digest('hex');
  const timelineUpload = await blobStore.initUpload({
    deviceId: tokens.device.id, sha256: timelineDigest, size: timelineBytes.length,
    name: 'timeline.json', kind: 'timeline',
  });
  const timeline = (await blobStore.appendChunk({
    uploadId: timelineUpload.uploadId, deviceId: tokens.device.id, offset: 0, bytes: timelineBytes,
  })).blob;
  sessionStore.executeCommand(tokens.device, 'session_worker_01', {
    commandId: 'command_worker_takeover', type: 'session.takeover', payload: { expectedVersion: 3 },
  });
  const boundary = await fetch(`${base}/v1/internal/worker/session_worker_01/boundary`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ra_wt_test', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationId: 'worker-boundary-1', turnNumber: 1, revision: 4,
      checkpoint: { blobId: checkpoint.id, size: checkpoint.size },
      timeline: { blobId: timeline.id, size: timeline.size },
    }),
  });
  assert.equal(boundary.status, 201);
  assert.equal((await boundary.json()).timeline.blobId, timeline.id);
  sessionStore.completeTurn('session_worker_01');
  const takeoverAck = await fetch(`${base}/v1/internal/worker/session_worker_01/takeover-ack`, {
    method: 'POST', headers: { Authorization: 'Bearer ra_wt_test' },
  });
  assert.equal(takeoverAck.status, 200);
  const takeover = await takeoverAck.json();
  assert.equal(takeover.takeover.status, 'ready');
  assert.equal(takeover.takeover.boundary.checkpoint.blobId, checkpoint.id);
  assert.equal(takeover.takeover.boundary.timeline.blobId, timeline.id);
});

test('an authenticated worker frame reaches paired devices with signed transient responses', async (t) => {
  const {
    base,
    workerBase,
    auth,
    displayFrameStore,
    sessionStore,
    identity,
    database,
  } = await fixture(t, { withWorkerControl: true });
  const origin = await pairOverHttp(auth, base);
  const second = auth.redeemPairingCode({
    code: auth.createPairingCode().code,
    deviceName: 'Viewer',
  });
  sessionStore.setProviderStatus('codex', { available: true, version: 'codex 1' });
  const sourceBytes = Buffer.from('display source');
  const document = await uploadOverHttp(base, origin.accessToken, sourceBytes, {
    name: 'display.hwpx', kind: 'document',
  });
  const created = sessionStore.createSession(origin.device, {
    sessionId: 'session_display_http_01',
    provider: 'codex',
    goal: 'Show the display',
    originDocument: { blobId: document.id, size: document.size, name: 'display.hwpx' },
    resources: [],
    timeline: null,
    limits: { maxDurationSeconds: 3600, maxTurns: 10 },
  });
  sessionStore.createSession(origin.device, {
    sessionId: 'session_display_other_01',
    provider: 'codex',
    goal: 'Other session',
    originDocument: { blobId: document.id, size: document.size, name: 'display.hwpx' },
    resources: [],
    timeline: null,
    limits: { maxDurationSeconds: 3600, maxTurns: 10 },
  });
  sessionStore.executeCommand(origin.device, created.id, {
    commandId: 'activate_display_http_01',
    type: 'session.activate',
    payload: { expectedVersion: created.stateVersion },
  });
  sessionStore.claimNextSession();
  sessionStore.prepareWorker(created.id, 'ra_wt_display_one');

  const deniedWorker = new WorkerClient({
    baseUrl: workerBase,
    token: 'wrong-worker-token',
    sessionId: created.id,
  });
  await assert.rejects(
    deniedWorker.openFrameStream({ width: 1280, height: 800 }),
    (error) => error.status === 401 && error.code === 'WORKER_UNAUTHORIZED',
  );

  const unavailableNonce = proofNonce();
  const unavailable = await publicFetch(`${base}/v1/sessions/${created.id}/display`, {
    headers: { Authorization: `Bearer ${second.accessToken}` },
    proofNonce: unavailableNonce,
  });
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  assert.equal((await unavailable.clone().json()).reason, 'stream-unavailable');
  await assertResponseProof(unavailable, identity, {
    nonce: unavailableNonce,
    pathAndQuery: `/rauhwpx-cloud/v1/sessions/${created.id}/display`,
  });

  const worker = new WorkerClient({
    baseUrl: workerBase,
    token: 'ra_wt_display_one',
    sessionId: created.id,
  });
  const capability = await worker.openFrameStream({ width: 1280, height: 800 });
  assert.deepEqual(capability, {
    kind: 'available',
    protocol: 'rauhwpx-frame-v1',
    sessionId: created.id,
    streamId: capability.streamId,
    width: 1280,
    height: 800,
    maxFrameBytes: 524288,
    maxFps: 12,
    inputProtocol: 'rauhwpx-input-v1',
    maxInputEventsPerSecond: 60,
  });
  const capabilityNonce = proofNonce();
  const publicCapability = await publicFetch(`${base}/v1/sessions/${created.id}/display`, {
    headers: { Authorization: `Bearer ${second.accessToken}` },
    proofNonce: capabilityNonce,
  });
  assert.deepEqual(await publicCapability.clone().json(), capability);
  await assertResponseProof(publicCapability, identity, {
    nonce: capabilityNonce,
    pathAndQuery: `/rauhwpx-cloud/v1/sessions/${created.id}/display`,
  });

  const durableEventCount = database.prepare(
    'SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?',
  ).get(created.id).count;
  displayFrameStore.interestGraceMs = 0;
  const demand = worker.frameDemand(capability.streamId, { after: 1 });
  for (let attempt = 0; attempt < 100 && displayFrameStore.snapshot().streams[0].waiters === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(displayFrameStore.snapshot().streams[0].waiters, 1);
  const invalidInterest = await publicFetch(`${base}/v1/sessions/${created.id}/display/interest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${second.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamId: capability.streamId, viewerId: 'short', active: true }),
  });
  assert.equal(invalidInterest.status, 400);
  const legacyInterest = await publicFetch(`${base}/v1/sessions/${created.id}/display/interest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${second.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamId: capability.streamId, active: true }),
  });
  assert.equal(legacyInterest.status, 200);
  assert.equal((await legacyInterest.json()).maxFps, 12);
  assert.equal((await demand).interested, true);
  const crossDeviceLegacyRelease = await publicFetch(`${base}/v1/sessions/${created.id}/display/interest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${origin.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamId: capability.streamId, active: false }),
  });
  assert.equal(crossDeviceLegacyRelease.status, 200);
  assert.equal(displayFrameStore.snapshot().streams[0].viewers, 1);
  const legacyDemandStopped = worker.frameDemand(capability.streamId, { after: 2 });
  const legacyRelease = await publicFetch(`${base}/v1/sessions/${created.id}/display/interest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${second.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamId: capability.streamId, active: false }),
  });
  assert.equal(legacyRelease.status, 200);
  assert.equal((await legacyDemandStopped).interested, false);
  const explicitDemand = worker.frameDemand(capability.streamId, { after: 3 });
  const firstInterest = await publicFetch(`${base}/v1/sessions/${created.id}/display/interest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${second.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamId: capability.streamId, viewerId: 'viewer-window-a', active: true }),
  });
  assert.equal(firstInterest.status, 200);
  assert.equal((await explicitDemand).interested, true);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM session_presence WHERE session_id = ?`).get(created.id).count, 0);
  const secondInterest = await publicFetch(`${base}/v1/sessions/${created.id}/display/interest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${second.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamId: capability.streamId, viewerId: 'viewer-window-b', active: true }),
  });
  assert.equal(secondInterest.status, 200);
  assert.equal(displayFrameStore.snapshot().streams[0].viewers, 2);
  const inputDemand = worker.frameDemand(capability.streamId, { after: 4 });
  const acceptedInput = await publicFetch(`${base}/v1/sessions/${created.id}/display/input`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${second.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      streamId: capability.streamId,
      viewerId: 'viewer-window-a',
      sequence: 1,
      event: { kind: 'pointer', action: 'down', x: 640, y: 400, button: 'left' },
    }),
  });
  assert.equal(acceptedInput.status, 202);
  assert.equal((await acceptedInput.json()).accepted, true);
  assert.deepEqual((await inputDemand).inputEvents, [{
    version: 5,
    sequence: 1,
    event: { kind: 'pointer', action: 'down', x: 640, y: 400, button: 'left' },
  }]);
  const conflictingInput = await publicFetch(`${base}/v1/sessions/${created.id}/display/input`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${second.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      streamId: capability.streamId,
      viewerId: 'viewer-window-b',
      sequence: 1,
      event: { kind: 'text', text: 'blocked controller' },
    }),
  });
  assert.equal(conflictingInput.status, 409);
  assert.equal((await conflictingInput.json()).error.code, 'DISPLAY_CONTROL_CONFLICT');
  const crossDeviceExplicitRelease = await publicFetch(`${base}/v1/sessions/${created.id}/display/interest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${origin.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamId: capability.streamId, viewerId: 'viewer-window-a', active: false }),
  });
  assert.equal(crossDeviceExplicitRelease.status, 200);
  const crossDeviceSecondExplicitRelease = await publicFetch(`${base}/v1/sessions/${created.id}/display/interest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${origin.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamId: capability.streamId, viewerId: 'viewer-window-b', active: false }),
  });
  assert.equal(crossDeviceSecondExplicitRelease.status, 200);
  assert.equal(displayFrameStore.snapshot().streams[0].viewers, 2);
  const firstRelease = await publicFetch(`${base}/v1/sessions/${created.id}/display/interest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${second.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamId: capability.streamId, viewerId: 'viewer-window-a', active: false }),
  });
  assert.equal(firstRelease.status, 200);
  assert.equal(displayFrameStore.snapshot().streams[0].viewers, 1);
  assert.equal((await worker.frameDemand(capability.streamId, { after: 0 })).interested, true);
  const controllerReset = await worker.frameDemand(capability.streamId, { after: 5 });
  assert.deepEqual(controllerReset.inputEvents, [{ version: 6, sequence: 0, event: { kind: 'reset' } }]);
  const finalDemand = worker.frameDemand(capability.streamId, { after: 6 });
  const secondRelease = await publicFetch(`${base}/v1/sessions/${created.id}/display/interest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${second.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamId: capability.streamId, viewerId: 'viewer-window-b', active: false }),
  });
  assert.equal(secondRelease.status, 200);
  assert.equal((await finalDemand).interested, false);

  const frameBytes = jpeg(1280, 800, 'paired-device-jpeg');
  const metadata = await worker.publishFrame(capability.streamId, {
    sequence: 1,
    capturedAt: '2026-08-30T12:00:00.000Z',
    bytes: frameBytes,
  });
  assert.equal(metadata.mimeType, 'image/jpeg');
  assert.equal(metadata.byteLength, frameBytes.length);
  assert.equal(metadata.sha256, createHash('sha256').update(frameBytes).digest('hex'));
  assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?',
  ).get(created.id).count, durableEventCount);

  displayFrameStore.maxViewersPerStream = 1;
  const watchController = new AbortController();
  const watchNonce = proofNonce();
  const watchPath = `/v1/sessions/${created.id}/display/frames?streamId=${encodeURIComponent(capability.streamId)}&after=0`;
  const watch = await publicFetch(`${base}${watchPath}`, {
    headers: { Authorization: `Bearer ${second.accessToken}` },
    proofNonce: watchNonce,
    signal: watchController.signal,
  });
  assert.equal(watch.status, 200);
  assert.equal(watch.headers.get('cache-control'), 'no-store, no-transform');
  assert.equal(watch.headers.get('x-rauhwpx-content-sha256'), SSE_STREAM_DIGEST);
  const watchCanonical = canonicalResponse({
    nonce: watchNonce,
    method: 'GET',
    pathAndQuery: `/rauhwpx-cloud${watchPath}`,
    status: 200,
    digest: SSE_STREAM_DIGEST,
  });
  assert.equal(verify(
    null,
    Buffer.from(watchCanonical),
    identity.publicKey,
    Buffer.from(watch.headers.get('x-rauhwpx-response-signature'), 'base64url'),
  ), true);
  const watchReader = watch.body.getReader();
  let watchText = '';
  while (!watchText.includes('\n\n')) {
    const chunk = await watchReader.read();
    assert.equal(chunk.done, false);
    watchText += Buffer.from(chunk.value).toString('utf8');
  }
  const fields = Object.fromEntries(watchText.trim().split('\n').map((line) => {
    const separator = line.indexOf(': ');
    return [line.slice(0, separator), line.slice(separator + 2)];
  }));
  const frameEvent = JSON.parse(fields.data);
  assert.equal(frameEvent.type, 'display.frame');
  assert.deepEqual(frameEvent.payload, metadata);
  const eventDigest = createHash('sha256').update(fields.data).digest('hex');
  assert.equal(fields['rauhwpx-sha256'], eventDigest);
  assert.equal(verify(
    null,
    Buffer.from(canonicalSseEvent({
      nonce: watchNonce,
      method: 'GET',
      pathAndQuery: `/rauhwpx-cloud${watchPath}`,
      status: 200,
      seq: 1,
      type: 'display.frame',
      digest: eventDigest,
    })),
    identity.publicKey,
    Buffer.from(fields['rauhwpx-signature'], 'base64url'),
  ), true);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM session_presence WHERE session_id = ?`).get(created.id).count, 0);
  const rejectedWatchNonce = proofNonce();
  const rejectedWatch = await publicFetch(`${base}${watchPath}`, {
    headers: { Authorization: `Bearer ${second.accessToken}` },
    proofNonce: rejectedWatchNonce,
  });
  assert.equal(rejectedWatch.status, 429);
  assert.equal((await rejectedWatch.clone().json()).error.code, 'DISPLAY_VIEWER_LIMIT');
  await assertResponseProof(rejectedWatch, identity, {
    nonce: rejectedWatchNonce,
    pathAndQuery: `/rauhwpx-cloud${watchPath}`,
  });
  watchController.abort();
  await watchReader.cancel().catch(() => {});

  const unauthenticatedFrame = await publicFetch(`${base}${metadata.framePath}`);
  assert.equal(unauthenticatedFrame.status, 401);
  const frameNonce = proofNonce();
  const frame = await publicFetch(`${base}${metadata.framePath}`, {
    headers: { Authorization: `Bearer ${second.accessToken}` },
    proofNonce: frameNonce,
  });
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('cache-control'), 'no-store');
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await frame.clone().arrayBuffer()), frameBytes);
  await assertResponseProof(frame, identity, {
    nonce: frameNonce,
    pathAndQuery: `/rauhwpx-cloud${metadata.framePath}`,
  });
  const crossSession = await publicFetch(
    `${base}${metadata.framePath.replace(created.id, 'session_display_other_01')}`,
    { headers: { Authorization: `Bearer ${second.accessToken}` } },
  );
  assert.equal(crossSession.status, 404);
  assert.equal((await crossSession.json()).error.code, 'DISPLAY_STREAM_NOT_FOUND');

  const oversized = await fetch(
    `${workerBase}/v1/internal/worker/${created.id}/display/streams/${capability.streamId}/frames/2`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ra_wt_display_one',
        'Content-Type': 'image/jpeg',
        'X-Rauhwpx-Frame-Captured-At': '2026-08-30T12:00:01.000Z',
      },
      body: Buffer.alloc(MAX_DISPLAY_FRAME_BYTES + 1),
    },
  );
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'REQUEST_TOO_LARGE');

  const authenticateWorker = sessionStore.authenticateWorker.bind(sessionStore);
  let oldRequestAuthenticated;
  const oldRequestStarted = new Promise((resolve) => { oldRequestAuthenticated = resolve; });
  sessionStore.authenticateWorker = (...args) => {
    const authenticated = authenticateWorker(...args);
    if (args[1] === 'ra_wt_display_one') oldRequestAuthenticated();
    return authenticated;
  };
  let finishDelayedRequest;
  const delayedResponse = new Promise((resolve, reject) => {
    const request = http.request(
      `${workerBase}/v1/internal/worker/${created.id}/display/streams`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ra_wt_display_one',
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      },
      async (response) => {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      },
    );
    request.once('error', reject);
    request.write('{"width":1280,');
    finishDelayedRequest = () => request.end('"height":800}');
  });
  await oldRequestStarted;
  sessionStore.prepareWorker(created.id, 'ra_wt_display_two');
  const replacement = new WorkerClient({
    baseUrl: workerBase,
    token: 'ra_wt_display_two',
    sessionId: created.id,
  });
  const nextCapability = await replacement.openFrameStream({ width: 1280, height: 800 });
  finishDelayedRequest();
  const staleOpen = await delayedResponse;
  assert.equal(staleOpen.status, 401);
  assert.equal(staleOpen.body.error.code, 'WORKER_UNAUTHORIZED');
  assert.equal(displayFrameStore.capability(created.id).streamId, nextCapability.streamId);
  sessionStore.authenticateWorker = authenticateWorker;
  await assert.rejects(
    worker.publishFrame(capability.streamId, {
      sequence: 2,
      capturedAt: '2026-08-30T12:00:01.000Z',
      bytes: frameBytes,
    }),
    (error) => error.status === 401 && error.code === 'WORKER_UNAUTHORIZED',
  );
  assert.notEqual(nextCapability.streamId, capability.streamId);
  await assert.rejects(
    replacement.publishFrame(capability.streamId, {
      sequence: 2,
      capturedAt: '2026-08-30T12:00:01.000Z',
      bytes: frameBytes,
    }),
    (error) => error.status === 404 && error.code === 'DISPLAY_STREAM_NOT_FOUND',
  );
  assert.deepEqual(await replacement.closeFrameStream(nextCapability.streamId), {
    streamId: nextCapability.streamId,
    closed: true,
  });
});

test('display capability reports server-unsupported without a frame store', async (t) => {
  const { base, auth, sessionStore, identity } = await fixture(t, { displayFrames: false });
  const tokens = await pairOverHttp(auth, base);
  sessionStore.setProviderStatus('codex', { available: true, version: 'codex 1' });
  const bytes = Buffer.from('unsupported source');
  const document = await uploadOverHttp(base, tokens.accessToken, bytes, {
    name: 'source.hwpx', kind: 'document',
  });
  sessionStore.createSession(tokens.device, {
    sessionId: 'session_display_unsupported',
    provider: 'codex',
    goal: 'Check display support',
    originDocument: { blobId: document.id, size: document.size, name: 'source.hwpx' },
    resources: [],
    timeline: null,
    limits: { maxDurationSeconds: 3600, maxTurns: 10 },
  });
  const nonce = proofNonce();
  const response = await publicFetch(`${base}/v1/sessions/session_display_unsupported/display`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    proofNonce: nonce,
  });
  assert.deepEqual(await response.clone().json(), {
    kind: 'unavailable',
    sessionId: 'session_display_unsupported',
    reason: 'server-unsupported',
    message: 'This Cloud server does not support live display frames',
    retryable: false,
  });
  await assertResponseProof(response, identity, {
    nonce,
    pathAndQuery: '/rauhwpx-cloud/v1/sessions/session_display_unsupported/display',
  });
});

test('worker result retry survives a lost commit response and immediate origin purge', async (t) => {
  const { base, auth, blobStore, sessionStore, database } = await fixture(t, { workerOnly: true });
  const tokens = auth.redeemPairingCode({
    code: auth.createPairingCode().code,
    deviceName: 'Origin',
  });
  sessionStore.setProviderStatus('codex', { available: true, version: 'codex 1' });
  const source = Buffer.from('source');
  const sourceUpload = await blobStore.initUpload({
    deviceId: tokens.device.id,
    sha256: createHash('sha256').update(source).digest('hex'),
    size: source.length,
    name: 'source.hwpx',
    kind: 'document',
  });
  const document = (await blobStore.appendChunk({
    uploadId: sourceUpload.uploadId,
    deviceId: tokens.device.id,
    offset: 0,
    bytes: source,
  })).blob;
  sessionStore.createSession(tokens.device, {
    sessionId: 'session_result_retry_01',
    provider: 'codex',
    goal: 'Finish reliably',
    originDocument: { blobId: document.id, size: document.size, name: 'source.hwpx' },
    resources: [],
    timeline: null,
    limits: { maxDurationSeconds: 3600, maxTurns: 10 },
  });
  sessionStore.executeCommand(tokens.device, 'session_result_retry_01', {
    commandId: 'activate_result_retry_01',
    type: 'session.activate',
    payload: { expectedVersion: 1 },
  });
  sessionStore.claimNextSession();
  sessionStore.prepareWorker('session_result_retry_01', 'ra_wt_result_retry');
  assert.deepEqual(sessionStore.claimFinish('session_result_retry_01'), { ready: true, messages: [] });

  const resultBytes = Buffer.from('result');
  const resultUpload = await blobStore.initUpload({
    deviceId: tokens.device.id,
    sessionId: 'session_result_retry_01',
    sha256: createHash('sha256').update(resultBytes).digest('hex'),
    size: resultBytes.length,
    name: 'result.hwpx',
    kind: 'result',
  });
  const result = (await blobStore.appendChunk({
    uploadId: resultUpload.uploadId,
    deviceId: tokens.device.id,
    offset: 0,
    bytes: resultBytes,
  })).blob;

  let attempts = 0;
  let committedResolve;
  const committed = new Promise((resolve) => { committedResolve = resolve; });
  const proxy = http.createServer((clientRequest, clientResponse) => {
    attempts += 1;
    const upstream = http.request(new URL(clientRequest.url, base), {
      method: clientRequest.method,
      headers: clientRequest.headers,
    }, (upstreamResponse) => {
      if (attempts === 1) {
        upstreamResponse.resume();
        upstreamResponse.once('end', () => {
          committedResolve();
          clientRequest.socket.destroy();
        });
        return;
      }
      clientResponse.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(clientResponse);
    });
    upstream.once('error', (error) => clientRequest.socket.destroy(error));
    clientRequest.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  });
  const proxyBase = `http://127.0.0.1:${proxy.address().port}`;
  const publish = new WorkerClient({
    baseUrl: proxyBase,
    token: 'ra_wt_result_retry',
    sessionId: 'session_result_retry_01',
  }).publishResult(result);
  await committed;
  assert.equal(sessionStore.getSession('session_result_retry_01').status, 'completed');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM worker_result_retry_receipts WHERE session_id = ?
  `).get('session_result_retry_01').count, 1);
  await sessionStore.confirmResultDownloaded(tokens.device, 'session_result_retry_01', {
    sha256: result.id,
    size: result.size,
  });

  const receipt = await publish;
  assert.equal(receipt.status, 'purged');
  assert.equal(attempts, 2);
  assert.equal(sessionStore.getSession('session_result_retry_01').status, 'purged');
});

test('paired devices import provider auth before a session can be staged', async (t) => {
  const { base, auth, sessionStore, root } = await fixture(t, { withProviderAuth: true });
  const tokens = await pairOverHttp(auth, base);
  sessionStore.setProviderStatus('codex', { available: true, authenticated: false, version: 'codex 1' });
  const document = await uploadOverHttp(base, tokens.accessToken, Buffer.from('source'), {
    name: 'source.hwpx', kind: 'document',
  });
  const blocked = await publicFetch(`${base}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'session_auth_import_01', provider: 'codex', goal: 'Work',
      originDocument: { blobId: document.id, size: document.size, name: 'source.hwpx' },
    }),
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, 'AUTH_REQUIRED');

  const imported = await publicFetch(`${base}/v1/providers/codex/auth`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secrets: { OPENAI_API_KEY: 'sk-proj-http' },
      files: { '.codex/auth.json': '{"token":"imported"}' },
    }),
  });
  assert.equal(imported.status, 200);
  const receipt = await imported.json();
  assert.equal(receipt.provider.authenticated, true);
  assert.equal(
    await fs.readFile(path.join(root, 'provider-auth', 'codex', '.codex', 'auth.json'), 'utf8'),
    '{"token":"imported"}',
  );

  const created = await publicFetch(`${base}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'session_auth_import_01', provider: 'codex', goal: 'Work',
      originDocument: { blobId: document.id, size: document.size, name: 'source.hwpx' },
    }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).status, 'staged');
});

test('a paired device can seed provider credentials for every agent', async (t) => {
  const seeded = [];
  const { base, auth } = await fixture(t, {
    seedProvider: async (input) => {
      seeded.push(input);
      return { provider: input.provider, available: true, authenticated: true };
    },
  });
  const tokens = await pairOverHttp(auth, base);
  for (const provider of ['claude', 'codex', 'grok', 'pi', 'cursor']) {
    const response = await publicFetch(`${base}/v1/providers/${provider}/credentials`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ apiKey: `key-${provider}` }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { provider, available: true, authenticated: true });
  }
  assert.deepEqual(seeded.map((item) => item.provider), ['claude', 'codex', 'grok', 'pi', 'cursor']);
  assert.deepEqual(seeded.map((item) => item.apiKey), ['key-claude', 'key-codex', 'key-grok', 'key-pi', 'key-cursor']);

  const missing = await publicFetch(`${base}/v1/providers/codex/credentials`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'PROVIDER_KEY_REQUIRED');
});

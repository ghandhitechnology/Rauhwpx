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
import { createCloudHttpHandler } from '../src/http-server.mjs';
import { applyProviderAuth, parseProviderAuth } from '../src/provider-auth.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { SecretVault } from '../src/secret-vault.mjs';
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

async function fixture(t, { workerOnly = false, withProviderAuth = false, seedProvider } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cloud-http-'));
  const database = openDatabase(path.join(root, 'cloud.sqlite3'));
  const blobStore = new BlobStore(database, { root: path.join(root, 'objects'), chunkBytes: 8 });
  const auth = new AuthService(database);
  const sessionStore = new SessionStore(database, blobStore);
  const identity = testIdentity();
  const config = { basePath: '/rauhwpx-cloud', maxRunningSessions: 2, maxQueuedSessions: 20 };
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
  const server = http.createServer(createCloudHttpHandler({
    auth, blobStore, sessionStore, identity, config, logger, vault,
    applyProviderAuth: apply,
    seedProvider,
  }, { workerOnly }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { base, database, blobStore, auth, sessionStore, identity, root };
}

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
  const { base, auth, sessionStore, identity } = await fixture(t);
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

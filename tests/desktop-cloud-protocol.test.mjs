import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { CloudClient } from '../desktop/cloud-client.mjs';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';
import { CloudHandoffStore } from '../desktop/cloud-handoff.mjs';
import { normalizeCloudProfile } from '../desktop/cloud-profile.mjs';

const SERVER_IDENTITY = generateKeyPairSync('ed25519');
const SERVER_KEY = `ed25519:${SERVER_IDENTITY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;

function signedFetch(handler, identity = SERVER_IDENTITY) {
  const serverKey = `ed25519:${identity.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;
  return async (url, options = {}) => {
    const response = await handler(url, options);
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentDigest = createHash('sha256').update(bytes).digest('hex');
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
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-rauhwpx-server-key': SERVER_KEY,
    },
  });
}

test('desktop client preserves nested backend error codes and details', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const client = new CloudClient({
    vault: memoryVault({
      'cloud.profile': JSON.stringify(profile),
      'cloud.refresh': 'refresh-token-that-is-long-enough',
    }),
    fetchImpl: signedFetch(async (url) => {
      if (url.endsWith('/v1/token/refresh')) {
        return jsonResponse({
          accessToken: 'access-new',
          accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshToken: 'refresh-new',
        });
      }
      return jsonResponse({
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'codex is not ready on this VPS',
          details: { provider: 'codex', available: false },
        },
      }, 409);
    }),
  });

  await assert.rejects(
    client.profile(),
    (error) => error.code === 'PROVIDER_UNAVAILABLE'
      && error.message === 'codex is not ready on this VPS'
      && error.details?.provider === 'codex',
  );
});

test('concurrent 401 responses share refresh rotation and replay once', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  let refreshes = 0;
  const authorizations = [];
  const client = new CloudClient({
    vault: memoryVault({
      'cloud.profile': JSON.stringify(profile),
      'cloud.refresh': 'refresh-token-that-is-long-enough',
    }),
    fetchImpl: signedFetch(async (url, options) => {
      if (url.endsWith('/v1/token/refresh')) {
        refreshes += 1;
        await delay(5);
        return jsonResponse({
          accessToken: `access-${refreshes}`,
          accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshToken: `refresh-${refreshes}`,
        });
      }
      authorizations.push(options.headers.authorization);
      if (options.headers.authorization === 'Bearer access-1') {
        return jsonResponse({ error: { code: 'ACCESS_TOKEN_INVALID', message: 'expired access token' } }, 401);
      }
      return jsonResponse({ ok: true });
    }),
  });

  const results = await Promise.all([client.profile(), client.profile()]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.equal(refreshes, 2);
  assert.equal(authorizations.filter((value) => value === 'Bearer access-1').length, 2);
  assert.equal(authorizations.filter((value) => value === 'Bearer access-2').length, 2);
});

test('desktop event watcher recovers after an extended network outage', async () => {
  const client = new CloudClient({ vault: memoryVault(), fetchImpl: async () => { throw new Error('unused'); } });
  const controller = new AbortController();
  let reads = 0;
  let delivered = 0;
  client.readEvents = async (_sessionId, sequence, { onEvent }) => {
    reads += 1;
    if (reads <= 12) throw new Error('tailscale offline');
    await onEvent({ sequence: sequence + 1, type: 'session.running' });
    controller.abort();
    return sequence + 1;
  };
  const sequence = await client.watchSession('cloud-1', 0, {
    signal: controller.signal,
    retryBaseMs: 0,
    onEvent: async () => { delivered += 1; },
  });
  assert.equal(reads, 13);
  assert.equal(delivered, 1);
  assert.equal(sequence, 1);
});

test('backend SSE payload advances the durable desktop handoff', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-sse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-1',
    threadId: 'thread-1',
    documentId: 'document-1',
    originPath: path.join(directory, 'source.hwpx'),
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    timeline: null,
    provider: 'codex',
    limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', {
    cloudSessionId: 'cloud-1',
    serverVersion: 1,
  });

  const completedAt = '2026-08-23T10:11:12.000Z';
  const resultDigest = 'b'.repeat(64);
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      watchSession: async (_sessionId, _after, { onEvent }) => {
        await onEvent({
          sessionId: 'cloud-1',
          seq: 9,
          sequence: 9,
          type: 'session.completed',
          event: 'session.completed',
          payload: {
            status: 'completed',
            stateVersion: 4,
            completedAt,
            result: { sha256: resultDigest, size: 12 },
          },
        });
        return 9;
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(() => coordinator.stop());
  await coordinator.start();

  let record;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    record = await store.get(created.id);
    if (record.lastEventSequence === 9) break;
    await delay(10);
  }
  assert.equal(record.state, 'completed');
  assert.equal(record.lastEventSequence, 9);
  assert.equal(record.serverVersion, 4);
  assert.equal(record.resultDigest, resultDigest);
  assert.equal(record.resultSize, 12);
  assert.equal(record.completedAt, completedAt);
});

test('VPS restart can requeue a running durable handoff', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-requeue-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-1',
    threadId: 'thread-1',
    documentId: 'document-1',
    originPath: path.join(directory, 'source.hwpx'),
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    timeline: null,
    provider: 'codex',
    limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-1', serverVersion: 2 });

  const recovered = await store.applyEvent(created.id, {
    sequence: 8,
    state: 'queued',
    patch: { serverVersion: 3, statusMessage: 'Requeued after VPS restart' },
  });
  assert.equal(recovered.state, 'queued');
  assert.equal(recovered.serverVersion, 3);
  assert.equal(recovered.lastEventSequence, 8);
});

test('command response advances state before its matching SSE event arrives', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-command-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-1',
    threadId: 'thread-1',
    documentId: 'document-1',
    originPath: path.join(directory, 'source.hwpx'),
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    timeline: null,
    provider: 'codex',
    limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-1', serverVersion: 2 });

  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      command: async () => ({
        eventSeq: 7,
        session: {
          id: 'cloud-1',
          status: 'suspended',
          stateVersion: 3,
          suspendedReason: { message: 'Paused from this device' },
        },
      }),
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });

  const snapshot = await coordinator.command({
    sessionId: 'cloud-1',
    command: 'pause',
    expectedVersion: 2,
  });
  assert.equal(snapshot.session.kind, 'suspended');
  assert.equal(snapshot.session.version, 3);
  const record = await store.get(created.id);
  assert.equal(record.state, 'suspended');
  assert.equal(record.lastEventSequence, 7);
  assert.equal(record.serverVersion, 3);
});

test('queued message remains accepted when SSE wins the command response race', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-message-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-1', threadId: 'thread-1', documentId: 'document-1',
    documentName: 'source.hwpx', documentBytes: Buffer.from('document'), timeline: null,
    provider: 'codex', limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-1', serverVersion: 2 });

  let deliverEvent;
  let watcherReadyResolve;
  const watcherReady = new Promise((resolve) => { watcherReadyResolve = resolve; });
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      watchSession: async (_sessionId, _after, { signal, onEvent }) => {
        deliverEvent = onEvent;
        watcherReadyResolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      command: async (_sessionId, type, payload, commandId) => {
        assert.equal(type, 'message.queue');
        assert.equal(payload.messageId, 'message-1');
        assert.match(commandId, /^message_[a-f0-9]{64}$/);
        await deliverEvent({
          sequence: 7,
          type: 'message.accepted',
          payload: { status: 'running', stateVersion: 2, messageId: 'message-1' },
        });
        return { messageId: 'message-1', status: 'queued', eventSeq: 6 };
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(() => coordinator.stop());
  await coordinator.start();
  await watcherReady;

  const snapshot = await coordinator.command({
    sessionId: 'cloud-1', command: 'queue-message', expectedVersion: 2,
    message: 'Use the revised totals', messageId: 'message-1',
  });
  assert.deepEqual(snapshot.queuedMessages.map(({ id, state }) => ({ id, state })), [
    { id: 'message-1', state: 'accepted' },
  ]);
  const record = await store.get(created.id);
  assert.equal(record.lastEventSequence, 7);
  assert.equal(record.queuedMessages[0].state, 'accepted');
});

test('activation receipt skips historical staged events before watching live updates', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-activation-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  let watchAfter = null;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      transfer: async ({ sessionId, onProgress, onSessionCreated, onSessionActivated }) => {
        await onProgress({ phase: 'committing', loaded: 1, total: 1 });
        await onSessionCreated({ sessionId, stateVersion: 1 });
        await onSessionActivated({ sessionId, stateVersion: 2, eventSeq: 2 });
        return { id: sessionId, status: 'queued', stateVersion: 2 };
      },
      watchSession: async (_sessionId, after, { signal, onEvent }) => {
        watchAfter = after;
        await onEvent({
          sequence: 3,
          type: 'session.running',
          payload: { status: 'running', stateVersion: 3, startedAt: new Date().toISOString() },
        });
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(() => coordinator.stop());
  await coordinator.transfer({
    threadId: 'thread-1', documentId: 'document-1',
    document: { fileName: 'source.hwpx', bytes: new Uint8Array(Buffer.from('document')) },
    timeline: {
      schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: new Date().toISOString(),
      thread: {
        id: 'thread-1', title: 'Task', createdAt: Date.now(), updatedAt: Date.now(),
        agent: 'codex', model: 'gpt-5.6', effort: 'high', messages: [],
      },
    },
    agent: 'codex', model: 'gpt-5.6', effort: 'high', workflow: 'direct', references: [],
  }, { originSessionId: 'desktop-1' });
  let record = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    [record] = await store.list();
    if (watchAfter !== null && record?.state === 'running') break;
    await delay(5);
  }
  assert.equal(watchAfter, 2);
  assert.equal(record.state, 'running');
  assert.equal(record.lastEventSequence, 3);
  assert.equal(record.serverVersion, 3);
});

test('verified result confirmation resumes after a crash boundary without redownloading', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-confirm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, 'handoffs.json');
  const recoveryDir = path.join(directory, 'recovery');
  const store = new CloudHandoffStore({ filePath: storePath });
  const created = await store.create({
    sessionId: 'desktop-1',
    threadId: 'thread-1',
    documentId: 'document-1',
    originPath: path.join(directory, 'source.hwpx'),
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    timeline: null,
    provider: 'codex',
    limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-1', serverVersion: 2 });
  await store.transition(created.id, 'completed', {
    resultId: 'cloud-1',
    resultDigest: 'a'.repeat(64),
    resultSize: 6,
  });

  const resultBytes = Buffer.from('result');
  const timeline = {
    schema: 'rauhwpx.cloud.timeline',
    version: 1,
    exportedAt: '2026-08-23T10:00:00.000Z',
    thread: { id: 'thread-1', title: 'Cloud task', messages: [] },
  };
  const timelineBytes = Buffer.from(JSON.stringify(timeline));
  let downloads = 0;
  let confirmations = 0;
  const first = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      session: async () => ({ id: 'cloud-1', status: 'completed', result: { id: 'cloud-1' } }),
      downloadTimeline: async () => ({
        bytes: timelineBytes,
        timeline,
        sha256: createDigest(timelineBytes),
        size: timelineBytes.length,
      }),
      downloadResult: async () => {
        downloads += 1;
        return {
          bytes: resultBytes,
          sha256: createDigest(resultBytes),
          size: resultBytes.length,
          name: 'source.hwpx',
        };
      },
      confirmResultDownloaded: async () => {
        confirmations += 1;
        throw new Error('connection lost after server received confirmation');
      },
    },
    store,
    provisioner: {},
    recoveryDir,
  });

  await assert.rejects(first.downloadResult({ sessionId: 'cloud-1' }), /connection lost/);
  const interrupted = await store.get(created.id);
  assert.equal(interrupted.state, 'downloading');
  assert.equal(interrupted.resultDigest, createDigest(resultBytes));
  assert.deepEqual(await readFile(interrupted.recoveryPath), resultBytes);
  assert.deepEqual(await readFile(interrupted.timelineRecoveryPath), timelineBytes);

  const reloaded = new CloudHandoffStore({ filePath: storePath });
  const resumed = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      confirmResultDownloaded: async () => {
        confirmations += 1;
        return { status: 'purged' };
      },
    },
    store: reloaded,
    provisioner: {},
    recoveryDir,
  });
  await resumed.start();
  let recovered;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    recovered = await reloaded.get(created.id);
    if (recovered.state === 'downloaded') break;
    await delay(10);
  }
  assert.equal(recovered.state, 'downloaded');
  assert.equal(downloads, 1);
  assert.equal(confirmations, 2);
});

test('cancelling during activation aborts the transfer and remotely cancels exactly once', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-cancel-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  let createdResolve;
  const created = new Promise((resolve) => { createdResolve = resolve; });
  let remoteStatus = 'queued';
  let remoteCancels = 0;
  const client = {
    loadProfile: async () => null,
    isPaired: async () => false,
    transfer: async ({ signal, onSessionCreated, onSessionActivated }) => {
      await onSessionCreated({ sessionId: 'cloud-race-1', stateVersion: 1 });
      createdResolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await onSessionActivated({ sessionId: 'cloud-race-1', stateVersion: 2 });
      return { id: 'cloud-race-1', status: 'queued', stateVersion: 2 };
    },
    session: async () => ({ id: 'cloud-race-1', status: remoteStatus, stateVersion: 2 }),
    command: async (_sessionId, type) => {
      assert.equal(type, 'session.cancel');
      remoteCancels += 1;
      remoteStatus = 'cancelled';
      return { session: { id: 'cloud-race-1', status: 'cancelled', stateVersion: 3 } };
    },
  };
  const coordinator = new CloudCoordinator({
    client,
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(() => coordinator.stop());
  const transfer = coordinator.transfer({
    threadId: 'thread-1',
    documentId: 'document-1',
    document: { fileName: 'source.hwpx', bytes: new Uint8Array(Buffer.from('document')) },
    timeline: {
      schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: new Date().toISOString(),
      thread: { id: 'thread-1', title: 'Task', messages: [] },
    },
    agent: 'codex', model: 'gpt-5.6', effort: 'high', workflow: 'direct', references: [],
  }, { originSessionId: 'desktop-1' });
  await created;
  const [record] = await store.list();
  const cancellation = coordinator.command({ sessionId: record.id, command: 'cancel' });
  const [transferSnapshot, cancelSnapshot] = await Promise.all([transfer, cancellation]);
  assert.equal(transferSnapshot.session.kind, 'cancelled');
  assert.equal(cancelSnapshot.session.kind, 'cancelled');
  assert.equal(remoteCancels, 1);
  const cancelled = await store.get(record.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.documentStagingPath, null);
});

test('persisted transfer cancellation is remotely finalized after an app restart', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-cancel-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, 'handoffs.json');
  const store = new CloudHandoffStore({ filePath: storePath });
  const created = await store.create({
    sessionId: 'desktop-1', threadId: 'thread-1', documentId: 'document-1',
    documentName: 'source.hwpx', documentBytes: Buffer.from('document'), timeline: null,
    provider: 'codex', limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing', {
    cloudSessionId: created.id,
    serverVersion: 2,
    cancelRequested: true,
  });

  let remoteStatus = 'queued';
  let remoteCancels = 0;
  const reloaded = new CloudHandoffStore({ filePath: storePath });
  const resumed = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      session: async () => ({ id: created.id, status: remoteStatus, stateVersion: 2 }),
      command: async (_sessionId, type, payload, commandId) => {
        assert.equal(type, 'session.cancel');
        assert.equal(payload.expectedVersion, 2);
        assert.equal(commandId, `cancel_transfer_${created.id}`);
        remoteCancels += 1;
        remoteStatus = 'cancelled';
        return { session: { id: created.id, status: 'cancelled', stateVersion: 3 } };
      },
      transfer: async () => { throw new Error('cancel recovery must not re-upload the payload'); },
    },
    store: reloaded,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(() => resumed.stop());
  await resumed.start();

  let recovered;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    recovered = await reloaded.get(created.id);
    if (recovered.state === 'cancelled') break;
    await delay(10);
  }
  assert.equal(recovered.state, 'cancelled');
  assert.equal(recovered.documentStagingPath, null);
  assert.equal(remoteCancels, 1);
});

test('takeover waits for and verifies the frozen checkpoint and timeline boundary', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-takeover-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-1', threadId: 'thread-1', documentId: 'document-1',
    documentName: 'source.hwp', documentBytes: Buffer.from('document'), timeline: null,
    provider: 'codex', limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-1', serverVersion: 2 });
  const timeline = {
    schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: new Date().toISOString(),
    thread: { id: 'thread-1', title: 'Task', messages: [] },
  };
  const checkpointBytes = Buffer.from('stable-hwp');
  const checkpointDigest = createDigest(checkpointBytes);
  const timelineBytes = Buffer.from(JSON.stringify(timeline));
  const timelineDigest = createDigest(timelineBytes);
  const boundary = {
    operationId: 'turn-4-boundary', revision: 7, turnNumber: 4,
    checkpoint: { blobId: checkpointDigest, size: checkpointBytes.length },
    timeline: { blobId: timelineDigest, size: timelineBytes.length },
  };
  let takeoverReads = 0;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      takeoverState: async () => {
        takeoverReads += 1;
        if (takeoverReads === 1) {
          const error = new Error('not requested');
          error.status = 404;
          throw error;
        }
        return { status: 'ready', boundary };
      },
      session: async () => ({
        id: 'cloud-1', status: 'cancelled', stateVersion: 3,
        originDocument: { name: 'source.hwp' },
      }),
      downloadTimeline: async () => ({
        timeline, bytes: timelineBytes, sha256: timelineDigest, size: timelineBytes.length,
        boundaryOperation: boundary.operationId, boundaryRevision: 7, boundaryTurn: 4,
      }),
      downloadCheckpoint: async () => ({
        bytes: checkpointBytes, sha256: checkpointDigest, size: checkpointBytes.length,
        name: 'source.checkpoint-r7.hwp', revision: 7, turn: 4,
        boundaryOperation: boundary.operationId,
      }),
      command: async () => ({
        eventSeq: 8,
        takeover: { status: 'pending' },
        session: { id: 'cloud-1', status: 'running', stateVersion: 3, takeoverRequested: true },
      }),
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  const snapshot = await coordinator.command({ sessionId: 'cloud-1', command: 'takeover', expectedVersion: 2 });
  assert.equal(takeoverReads, 2);
  assert.equal(snapshot.takeover.document.fileName, 'source.hwp');
  assert.match(snapshot.takeover.document.recoveryPath, /takeover\.hwp$/);
  assert.deepEqual(Buffer.from(snapshot.takeover.document.bytes), Buffer.from('stable-hwp'));
});

test('cross-device takeover consumption survives refresh and app restart for only the consumed boundary', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-takeover-consumed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, 'handoffs.json');
  let operationId = 'turn:stable-operation-1';
  const remoteSession = () => ({
    id: 'cloud-remote-1',
    status: 'cancelled',
    stateVersion: 4,
    takeoverReady: true,
    originDocument: { name: 'source.hwp' },
  });
  const client = {
    loadProfile: async () => ({
      name: 'VPS', endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud', transport: 'tailscale',
      ssh: { host: 'cloud.example.ts.net', user: 'cloud', port: 22, keyPath: '' },
    }),
    isPaired: async () => true,
    sessions: async () => [remoteSession()],
    deviceId: async () => 'receiving-device',
    takeoverState: async () => ({ status: 'ready', boundary: { operationId } }),
  };
  const first = new CloudCoordinator({
    client,
    store: new CloudHandoffStore({ filePath: storePath }),
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  let snapshot = await first.refresh({ selectedSessionId: 'cloud-remote-1' });
  assert.equal(snapshot.session.kind, 'taking-over');
  snapshot = await first.completeTakeover({ sessionId: 'cloud-remote-1' });
  assert.equal(snapshot.session.kind, 'cancelled');
  snapshot = await first.refresh({ selectedSessionId: 'cloud-remote-1' });
  assert.equal(snapshot.session.kind, 'cancelled', 'refresh does not replay the consumed boundary');

  const restarted = new CloudCoordinator({
    client,
    store: new CloudHandoffStore({ filePath: storePath }),
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  snapshot = await restarted.refresh({ selectedSessionId: 'cloud-remote-1' });
  assert.equal(snapshot.session.kind, 'cancelled', 'a fresh coordinator honors the durable device receipt');

  operationId = 'turn:stable-operation-2';
  snapshot = await restarted.refresh({ selectedSessionId: 'cloud-remote-1' });
  assert.equal(snapshot.session.kind, 'taking-over', 'a different future frozen boundary remains visible');
});

test('cross-device takeover completion fails closed without a frozen operation receipt', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-takeover-unkeyed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => ({
        name: 'VPS', endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud', transport: 'tailscale',
        ssh: { host: 'cloud.example.ts.net', user: 'cloud', port: 22, keyPath: '' },
      }),
      isPaired: async () => true,
      sessions: async () => [{ id: 'cloud-remote-2', status: 'cancelled', takeoverReady: true }],
      deviceId: async () => 'receiving-device',
      takeoverState: async () => ({ status: 'ready', boundary: null }),
    },
    store: new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') }),
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  await coordinator.refresh({ selectedSessionId: 'cloud-remote-2' });
  await assert.rejects(
    coordinator.completeTakeover({ sessionId: 'cloud-remote-2' }),
    /without its frozen boundary receipt/,
  );
});

test('verified result confirmation retries online without another app restart', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-confirm-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-1', threadId: 'thread-1', documentId: 'document-1',
    documentName: 'source.hwpx', documentBytes: Buffer.from('document'), timeline: null,
    provider: 'codex', limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-1', serverVersion: 2 });
  await store.transition(created.id, 'completed');
  const timeline = { schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: new Date().toISOString(), thread: { id: 'thread-1', title: 'Task', messages: [] } };
  const timelineBytes = Buffer.from(JSON.stringify(timeline));
  const resultBytes = Buffer.from('result');
  let confirmations = 0;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      session: async () => ({ id: 'cloud-1', result: { id: 'result-1' } }),
      downloadTimeline: async () => ({ bytes: timelineBytes, timeline, sha256: createDigest(timelineBytes), size: timelineBytes.length }),
      downloadResult: async () => ({ bytes: resultBytes, sha256: createDigest(resultBytes), size: resultBytes.length, name: 'source.hwpx' }),
      confirmResultDownloaded: async () => {
        confirmations += 1;
        if (confirmations === 1) throw new Error('temporary offline');
        return { status: 'purged' };
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(() => coordinator.stop());
  await assert.rejects(coordinator.downloadResult({ sessionId: 'cloud-1' }), /temporary offline/);
  let recovered;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    recovered = await store.get(created.id);
    if (recovered.state === 'downloaded') break;
    await delay(10);
  }
  assert.equal(recovered.state, 'downloaded');
  assert.equal(confirmations, 2);
});

function createDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { CloudClient } from '../desktop/cloud-client.mjs';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';
import { CloudHandoffStore } from '../desktop/cloud-handoff.mjs';
import { normalizeCloudProfile } from '../desktop/cloud-profile.mjs';
import { collectProviderAuth } from '../desktop/provider-auth.mjs';

function cloudStartTransfer(extra = {}) {
  const text = 'Continue this document';
  const messageId = 'msg-start';
  return {
    startId: extra.startId ?? 'startid01',
    initialMessage: { id: messageId, text, attachmentReferenceIds: [] },
    timeline: {
      schema: 'rauhwpx.cloud.timeline',
      version: 1,
      exportedAt: new Date().toISOString(),
      thread: {
        id: extra.threadId ?? 'thread-1',
        title: 'Task',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        agent: 'codex',
        model: 'gpt-5.6',
        effort: 'high',
        messages: [{ role: 'user', text, messageId }],
      },
    },
    ...extra,
  };
}

test('desktop checkpoint IPC preserves the immutable boundary operation id', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /cloud:download-checkpoint[\s\S]*?\^\[A-Za-z0-9\._:-\]\{1,160\}\$[\s\S]*?downloadCheckpoint\(\{ sessionId, operationId \}\)/);
});

test('desktop takeover completion IPC passes through the applied operation id', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /cloud:complete-takeover[\s\S]*?completeTakeover\(payload\)/,
  );
});

test('desktop result resolution holds one coordinator profile lease', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /cloud:resolve-result[\s\S]*?coordinator\.withActiveHandoff\(payload\.sessionId, async \(handoff\) => \{[\s\S]*?applyCloudRecovery\([\s\S]*?scopedCloudSnapshot\([\s\S]*?coordinator\.recordResolution\(/,
  );
});

test('desktop result download holds one coordinator profile lease through preview and snapshot', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /cloud:download-result[\s\S]*?coordinator\.withActiveHandoff\(payload\.sessionId, async[\s\S]*?coordinator\.downloadResult\(payload\)[\s\S]*?coordinator\.handoffForSession\(payload\?\.sessionId\)[\s\S]*?createWindow\([\s\S]*?scopedCloudSnapshot\(/,
  );
});

const SERVER_IDENTITY = generateKeyPairSync('ed25519');
const SERVER_KEY = `ed25519:${SERVER_IDENTITY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;

test('persistent transfer rejects a one-turn worker before uploading or activating a session', async () => {
  const requests = [];
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const client = new CloudClient({
    vault: memoryVault({ 'cloud.profile': JSON.stringify(profile) }),
    fetchImpl: signedFetch(async (url) => {
      requests.push(new URL(url).pathname);
      return jsonResponse({ ok: true, protocolVersion: 1 });
    }),
  });
  await assert.rejects(client.transfer({
    sessionId: 'persistent-start', provider: 'codex', persistent: true,
    documentName: 'source.hwpx', documentBytes: Buffer.from('document'), timeline: cloudStartTransfer().timeline,
  }), { code: 'CLOUD_RUNTIME_OUTDATED', retryable: false });
  assert.deepEqual(requests, ['/rauhwpx-cloud/v1/health']);
});

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
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
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

test('each stable turn archives exact bytes without overwriting the origin or ending the conversation', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-turn-autosync-'));
  const originPath = path.join(directory, 'source.hwpx');
  const original = Buffer.from('original document');
  const edited = Buffer.from('stable cloud turn one');
  const editedDigest = createHash('sha256').update(edited).digest('hex');
  await writeFile(originPath, original);
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-autosync',
    threadId: 'thread-autosync',
    documentId: 'document-autosync',
    originPath,
    documentName: 'source.hwpx',
    documentBytes: original,
    timeline: null,
    provider: 'codex',
    limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-autosync', serverVersion: 2 });

  let watcherReady;
  const delivered = new Promise((resolve) => { watcherReady = resolve; });
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      downloadCheckpoint: async (_sessionId, { operationId }) => ({
        bytes: edited,
        sha256: editedDigest,
        size: edited.length,
        name: 'source.hwpx',
        boundaryOperation: operationId,
        revision: 3,
        turn: 1,
      }),
      watchSession: async (_sessionId, _after, { signal, onEvent }) => {
        await onEvent({
          sequence: 6,
          type: 'boundary.committed',
          payload: {
            kind: 'turn', operationId: 'turn_1_stable', turnNumber: 1, revision: 3, stateVersion: 3,
          },
        });
        watcherReady();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  await coordinator.start();
  await delivered;

  let record;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    record = await store.get(created.id);
    if (record.lastSyncedBoundaryOperation === 'turn_1_stable') break;
    await delay(10);
  }
  assert.equal(await readFile(originPath, 'utf8'), original.toString());
  assert.equal(record.documentDigest, createHash('sha256').update(original).digest('hex'));
  assert.equal(record.state, 'running');
  assert.equal(record.turnArchives.length, 1);
  assert.equal(record.turnArchives[0].operationId, 'turn_1_stable');
  assert.equal(await readFile(record.turnArchives[0].path, 'utf8'), edited.toString());

  const published = await coordinator.publishCheckpoint({ sessionId: 'cloud-autosync', operationId: 'turn_1_stable' });
  assert.equal(published.publication, 'written');
  assert.equal(await readFile(originPath, 'utf8'), edited.toString());
  assert.equal((await store.get(created.id)).state, 'running');
  assert.equal((await store.get(created.id)).documentDigest, editedDigest);
  const repeated = await coordinator.publishCheckpoint({ sessionId: 'cloud-autosync', operationId: 'turn_1_stable' });
  assert.equal(repeated.publication, 'unchanged');
});

test('a persisted turn-boundary receipt retries after restart without writing the origin', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-turn-receipt-'));
  const storePath = path.join(directory, 'handoffs.json');
  const originPath = path.join(directory, 'source.hwpx');
  const original = Buffer.from('original document');
  const edited = Buffer.from('stable retry document');
  const editedDigest = createHash('sha256').update(edited).digest('hex');
  await writeFile(originPath, original);
  const firstStore = new CloudHandoffStore({ filePath: storePath });
  const created = await firstStore.create({
    sessionId: 'desktop-retry',
    threadId: 'thread-retry',
    documentId: 'document-retry',
    originPath,
    documentName: 'source.hwpx',
    documentBytes: original,
    timeline: null,
    provider: 'codex',
    limits: { maxTurns: 100 },
  });
  await firstStore.transition(created.id, 'uploading');
  await firstStore.transition(created.id, 'committing');
  await firstStore.transition(created.id, 'running', { cloudSessionId: 'cloud-retry', serverVersion: 2 });
  const boundary = {
    kind: 'turn', operationId: 'turn_retry_stable', turnNumber: 1, revision: 3, stateVersion: 3,
  };
  const firstFailure = Promise.withResolvers();
  const first = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      downloadCheckpoint: async () => { firstFailure.resolve(); throw new Error('temporary download failure'); },
      watchSession: async (_sessionId, _after, { onReconnect, onEvent }) => {
        await onReconnect();
        await onEvent({ sequence: 6, type: 'boundary.committed', payload: boundary });
      },
    },
    store: firstStore,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  await first.start();
  await firstFailure.promise;
  let record = await firstStore.get(created.id);
  assert.deepEqual(record.pendingTurnBoundary, {
    operationId: boundary.operationId,
    turnNumber: 1,
    revision: 3,
  });
  assert.equal(record.lastEventSequence, 6);
  const crashReload = new CloudHandoffStore({ filePath: storePath });
  assert.deepEqual((await crashReload.get(created.id)).pendingTurnBoundary, record.pendingTurnBoundary);
  await first.stop();
  await firstStore.flush();

  let successfulDownloads = 0;
  const restarted = Promise.withResolvers();
  const secondStore = new CloudHandoffStore({ filePath: storePath });
  const second = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      downloadCheckpoint: async (_sessionId, { operationId }) => {
        successfulDownloads += 1;
        return {
          bytes: edited,
          sha256: editedDigest,
          size: edited.length,
          name: 'source.hwpx',
          boundaryOperation: operationId,
          revision: 3,
          turn: 1,
        };
      },
      watchSession: async (_sessionId, _after, { signal, onReconnect }) => {
        await onReconnect();
        restarted.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    },
    store: secondStore,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await second.stop();
    await secondStore.flush();
    await rm(directory, { recursive: true, force: true });
  });
  await second.start();
  await restarted.promise;
  for (let index = 0; index < 200; index++) {
    if (!(await secondStore.get(created.id)).pendingTurnBoundary) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  record = await secondStore.get(created.id);
  assert.equal(record.pendingTurnBoundary, null);
  assert.equal(record.lastSyncedBoundaryOperation, boundary.operationId);
  assert.equal(record.turnArchives.length, 1);
  assert.equal(await readFile(originPath, 'utf8'), original.toString());
  assert.equal(await readFile(record.turnArchives[0].path, 'utf8'), edited.toString());
  assert.equal(successfulDownloads, 1);
});

test('VPS restart can requeue a running durable handoff', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-requeue-'));
  t.after(async () => {
    // Watermark-only stream applies persist on a trailing debounce; wait for
    // it so cleanup does not race the final atomic write.
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
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
  t.after(async () => {
    // Watermark-only stream applies persist on a trailing debounce; wait for
    // it so cleanup does not race the final atomic write.
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
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

for (const lostReceipt of [false, true]) {
test(`queued message remains accepted when SSE wins ${lostReceipt ? 'a lost' : 'the'} command response race`, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-message-race-'));
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
        if (lostReceipt) throw Object.assign(new Error('command receipt lost'), { code: 'ETIMEDOUT' });
        return { messageId: 'message-1', status: 'queued', eventSeq: 6 };
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
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
}

for (const explicitIds of [false, true]) {
test(`simultaneous follow-ups retain both durable messages with ${explicitIds ? 'explicit' : 'generated'} ids`, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-concurrent-messages-'));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-concurrent', threadId: 'thread-concurrent', documentId: 'document-concurrent',
    documentName: 'source.hwpx', documentBytes: Buffer.from('document'), timeline: null,
    provider: 'codex', limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-concurrent', serverVersion: 2 });
  const received = [];
  const bothSubmitted = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null, isPaired: async () => false,
      command: async (_sessionId, _type, payload, commandId) => {
        received.push({ ...payload, commandId });
        if (received.length === 2) bothSubmitted.resolve();
        await bothSubmitted.promise;
        return { messageId: payload.messageId, status: 'queued' };
      },
    }, store, provisioner: {},
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.method(Date, 'now', () => 1234567890);
  await Promise.all(['first', 'second'].map((message) => coordinator.command({
    sessionId: 'cloud-concurrent', command: 'queue-message', message,
    ...(explicitIds ? { messageId: `message-${message}` } : {}),
  })));
  const messages = (await store.get(created.id)).queuedMessages;
  assert.deepEqual(messages.map((message) => message.text).sort(), ['first', 'second']);
  assert.equal(new Set(received.map((message) => message.messageId)).size, 2);
  assert.equal(new Set(received.map((message) => message.commandId)).size, 2);
  const reloaded = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  assert.deepEqual((await reloaded.get(created.id)).queuedMessages, messages);
});
}

test('rejected queue command removes exactly its staged durable message', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-message-rejected-'));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-rejected', threadId: 'thread-rejected', documentId: 'document-rejected',
    documentName: 'source.hwpx', documentBytes: Buffer.from('document'), timeline: null,
    provider: 'codex', limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-rejected', serverVersion: 2 });
  await store.patch(created.id, {
    queuedMessages: [{
      id: 'message-existing',
      text: 'existing',
      queuedAt: '2026-08-30T00:00:00.000Z',
      state: 'accepted',
    }],
  });
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      command: async () => { throw new Error('queue rejected'); },
    },
    store,
    provisioner: {},
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(coordinator.command({
    sessionId: 'cloud-rejected', command: 'queue-message', expectedVersion: 2,
    message: 'new message', messageId: 'message-rejected',
  }), /queue rejected/);
  const record = await store.get(created.id);
  assert.deepEqual(record.queuedMessages.map((message) => message.id), ['message-existing']);
});

test('activation receipt skips historical staged events before watching live updates', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-activation-replay-'));
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
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  await coordinator.transfer(cloudStartTransfer({
    startId: 'startwatch',
    threadId: 'thread-1',
    documentId: 'document-1',
    document: { fileName: 'source.hwpx', bytes: new Uint8Array(Buffer.from('document')) },
    agent: 'codex',
    model: 'gpt-5.6',
    effort: 'high',
    workflow: 'direct',
    references: [],
  }), { originSessionId: 'desktop-1' });
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
  let resumed = null;
  t.after(async () => {
    await resumed?.stop();
    await rm(directory, { recursive: true, force: true });
  });
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
  let remoteReads = 0;
  let confirmations = 0;
  const first = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      session: async () => {
        remoteReads += 1;
        return { id: 'cloud-1', status: 'completed', result: { id: 'cloud-1' } };
      },
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

  const firstDownload = await first.downloadResult({ sessionId: 'cloud-1' });
  assert.deepEqual(Buffer.from(firstDownload.bytes), resultBytes);
  const interrupted = await store.get(created.id);
  assert.equal(interrupted.state, 'downloading');
  assert.equal(interrupted.resultDigest, createDigest(resultBytes));
  assert.deepEqual(await readFile(interrupted.recoveryPath), resultBytes);
  assert.deepEqual(await readFile(interrupted.timelineRecoveryPath), timelineBytes);

  const repeatedDownload = await first.downloadResult({ sessionId: 'cloud-1' });
  assert.deepEqual(Buffer.from(repeatedDownload.bytes), resultBytes);
  assert.equal(downloads, 1, 'the verified result is never downloaded again');
  assert.equal(remoteReads, 1, 'a second click does not contact a server that may already have purged the result');
  await first.stop();

  const reloaded = new CloudHandoffStore({ filePath: storePath });
  resumed = new CloudCoordinator({
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
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  const transfer = coordinator.transfer(cloudStartTransfer({
    startId: 'startcncl',
    threadId: 'thread-1',
    documentId: 'document-1',
    document: { fileName: 'source.hwpx', bytes: new Uint8Array(Buffer.from('document')) },
    agent: 'codex',
    model: 'gpt-5.6',
    effort: 'high',
    workflow: 'direct',
    references: [],
  }), { originSessionId: 'desktop-1' });
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
  let resumed = null;
  let reloaded = null;
  t.after(async () => {
    await resumed?.stop();
    await reloaded?.flush();
    await rm(directory, { recursive: true, force: true });
  });
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
  reloaded = new CloudHandoffStore({ filePath: storePath });
  resumed = new CloudCoordinator({
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
  t.after(async () => {
    // Watermark-only stream applies persist on a trailing debounce; wait for
    // it so cleanup does not race the final atomic write.
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
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
  assert.equal(snapshot.takeover.operationId, boundary.operationId);
  assert.equal(snapshot.takeover.document.fileName, 'source.hwp');
  assert.match(snapshot.takeover.document.recoveryPath, /takeover\.hwp$/);
  assert.deepEqual(Buffer.from(snapshot.takeover.document.bytes), Buffer.from('stable-hwp'));
});

test('desktop takeover retries frozen artifact downloads without repeating server mutation', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-takeover-retry-'));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const operationId = 'turn_takeover_retry';
  const checkpointBytes = Buffer.from('retry-checkpoint');
  const timelineBytes = Buffer.from('retry-timeline');
  const boundary = {
    operationId,
    revision: 5,
    turnNumber: 2,
    checkpoint: { blobId: createDigest(checkpointBytes), size: checkpointBytes.length },
    timeline: { blobId: createDigest(timelineBytes), size: timelineBytes.length },
  };
  const receipt = { status: 'ready', boundary };
  const session = {
    id: 'cloud-takeover-retry', status: 'cancelled', stateVersion: 4, takeoverReady: true,
    clientContext: { documentId: 'document-retry', threadId: 'thread-retry' },
    originDocument: { name: 'retry.hwpx' },
  };
  let takeoverCommands = 0;
  let takeoverReads = 0;
  let checkpointDownloads = 0;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      takeoverState: async () => {
        takeoverReads += 1;
        if (takeoverReads === 1) {
          throw Object.assign(new Error('No takeover'), { status: 404, code: 'TAKEOVER_NOT_REQUESTED' });
        }
        return receipt;
      },
      command: async () => {
        takeoverCommands += 1;
        return { takeover: receipt, session };
      },
      session: async () => session,
      downloadTimeline: async () => ({
        bytes: timelineBytes,
        timeline: { schema: 'rauhwpx.cloud.timeline', version: 1, thread: { id: 'thread-retry' } },
        sha256: createDigest(timelineBytes),
        size: timelineBytes.length,
        boundaryOperation: operationId,
        boundaryRevision: 5,
        boundaryTurn: 2,
      }),
      downloadCheckpoint: async (_sessionId, options) => {
        checkpointDownloads += 1;
        assert.equal(options.operationId, operationId);
        if (checkpointDownloads === 1) throw new Error('checkpoint temporarily unavailable');
        return {
          bytes: checkpointBytes,
          sha256: createDigest(checkpointBytes),
          size: checkpointBytes.length,
          name: 'retry.hwpx',
          boundaryOperation: operationId,
          revision: 5,
          turn: 2,
        };
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const command = {
    sessionId: session.id,
    command: 'takeover',
    expectedVersion: 4,
  };
  await assert.rejects(coordinator.command(command), /checkpoint temporarily unavailable/);
  const snapshot = await coordinator.command(command);
  assert.equal(takeoverCommands, 1);
  assert.equal(checkpointDownloads, 2);
  assert.deepEqual(Buffer.from(snapshot.takeover.document.bytes), checkpointBytes);
});

test('stopped profile operations reject before initial or writer-queued work can run', async () => {
  const profileA = normalizeCloudProfile({
    endpoint: 'https://stopped-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'stopped-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://stopped-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'stopped-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  let activeProfile = profileA;
  let sessionReads = 0;
  let storeReads = 0;
  const releaseSessions = Promise.withResolvers();
  const saveStarted = Promise.withResolvers();
  const releaseSave = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => activeProfile,
      isPaired: async () => true,
      sessions: async () => {
        sessionReads += 1;
        await releaseSessions.promise;
        return [];
      },
      deviceId: async () => 'device-stopped',
      saveProfile: async (profile) => {
        saveStarted.resolve();
        await releaseSave.promise;
        activeProfile = profile;
      },
      saveServerMode: async () => 'self-hosted',
    },
    store: {
      list: async () => { storeReads += 1; return []; },
      flush: async () => {},
    },
    provisioner: {},
  });

  const switching = coordinator.saveProfile({
    profile: {
      name: 'Server B', host: 'stopped-b.example.ts.net', sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileB.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await saveStarted.promise;
  const queued = coordinator.refresh().then(
    () => null,
    (error) => error,
  );
  const stopping = coordinator.stop();
  releaseSave.resolve();
  await stopping;
  const queuedSessionReads = sessionReads;
  releaseSessions.resolve();
  assert.equal((await queued)?.code, 'COORDINATOR_STOPPED');
  assert.equal(queuedSessionReads, 0);
  await switching;

  storeReads = 0;
  await assert.rejects(coordinator.refresh(), { code: 'COORDINATOR_STOPPED' });
  assert.equal(storeReads, 0);
  assert.equal(sessionReads, 0);

  const postStopProfileReads = storeReads;
  await assert.rejects(coordinator.saveProfile({ profile: {} }), { code: 'COORDINATOR_STOPPED' });
  await assert.rejects(coordinator.snapshot(), { code: 'COORDINATOR_STOPPED' });
  assert.equal(storeReads, postStopProfileReads);
});

test('a profile writer is admitted before its initial profile load', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-profile-writer-admission-'));
  const profileA = normalizeCloudProfile({
    endpoint: 'https://admission-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'admission-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://admission-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'admission-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  let activeProfile = profileA;
  let pauseNextProfileLoad = true;
  const profileLoadStarted = Promise.withResolvers();
  const releaseProfileLoad = Promise.withResolvers();
  const requestTargets = [];
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => {
        if (pauseNextProfileLoad) {
          pauseNextProfileLoad = false;
          profileLoadStarted.resolve();
          await releaseProfileLoad.promise;
        }
        return activeProfile;
      },
      isPaired: async () => true,
      saveProfile: async (profile) => { activeProfile = profile; },
      saveServerMode: async () => 'self-hosted',
      uploadBlob: async () => {
        requestTargets.push(activeProfile.endpoint);
        return { blobId: 'blob-admission', sha256: 'a'.repeat(64), size: 3 };
      },
      command: async (sessionId) => {
        requestTargets.push(activeProfile.endpoint);
        return { session: { id: sessionId, status: 'running', stateVersion: 2 } };
      },
    },
    store: new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') }),
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const switching = coordinator.saveProfile({
    profile: {
      name: 'Server B', host: profileB.ssh.host, sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileB.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await profileLoadStarted.promise;
  const command = coordinator.command({
    sessionId: 'shared-admission-command',
    command: 'queue-message',
    expectedVersion: 1,
    message: 'Continue',
    messageId: 'message-admission',
    attachments: [{
      id: 'attachment-admission', name: 'note.txt', mimeType: 'text/plain', size: 3,
      bytes: new Uint8Array(Buffer.from('one')),
    }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requestTargets, []);

  releaseProfileLoad.resolve();
  await Promise.all([switching, command]);
  assert.deepEqual(requestTargets, [profileB.endpoint, profileB.endpoint]);
});

test('stop waits for a pair writer admitted before redeem', async () => {
  const profile = normalizeCloudProfile({
    endpoint: 'https://pair-stop.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'pair-stop.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const loadStarted = Promise.withResolvers();
  const releaseLoad = Promise.withResolvers();
  let activated = false;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => {
        loadStarted.resolve();
        await releaseLoad.promise;
        return profile;
      },
      redeemPairingCode: async () => ({ credentials: { device: { id: 'pair-device' } } }),
      health: async () => ({ ok: true, serverPublicKey: SERVER_KEY }),
      activateProfile: async () => { activated = true; },
      saveServerMode: async () => 'self-hosted',
      isPaired: async () => true,
    },
    store: { list: async () => [], flush: async () => {} },
    provisioner: {},
  });

  const pairing = coordinator.pair({ code: 'ABCD-EFGH-IJKL' });
  await loadStarted.promise;
  let stopSettled = false;
  const stopping = coordinator.stop().then(() => { stopSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);
  releaseLoad.resolve();
  await Promise.all([pairing, stopping]);
  assert.equal(activated, true);
});

test('all public profile writers reject after stop before touching profile state', async () => {
  let sideEffects = 0;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => { sideEffects += 1; return null; },
      loadPendingAppSandbox: async () => { sideEffects += 1; return null; },
      saveProfile: async () => { sideEffects += 1; },
      activateProfile: async () => { sideEffects += 1; },
      forgetProfile: async () => { sideEffects += 1; },
    },
    store: { list: async () => [], flush: async () => {} },
    provisioner: { provision: async () => { sideEffects += 1; } },
  });
  await coordinator.stop();

  const writers = [
    coordinator.saveProfile({ profile: {} }),
    coordinator.pair({ code: 'ABCD-EFGH-IJKL' }),
    coordinator.provision(),
    coordinator.spawnAppServer(),
    coordinator.teardownAppServer(),
  ];
  for (const writer of writers) {
    await assert.rejects(writer, { code: 'COORDINATOR_STOPPED' });
  }
  assert.equal(sideEffects, 0);
});

test('an admitted reader can take its final snapshot while stop drains it', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null, isPaired: async () => false },
    store: { list: async () => [], flush: async () => {} },
    provisioner: {},
  });
  const reader = coordinator.withActiveHandoff('missing-handoff', async () => {
    entered.resolve();
    await release.promise;
    return coordinator.snapshot();
  });
  await entered.promise;
  let stopSettled = false;
  const stopping = coordinator.stop().then(() => { stopSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);

  release.resolve();
  const snapshot = await reader;
  await stopping;
  assert.equal(snapshot.profile.kind, 'unconfigured');
  await assert.rejects(coordinator.snapshot(), { code: 'COORDINATOR_STOPPED' });
});

test('a profile writer retains admission through mode persistence and final publication', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-profile-writer-tail-'));
  const profileA = normalizeCloudProfile({
    endpoint: 'https://writer-tail-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'writer-tail-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://writer-tail-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'writer-tail-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  let activeProfile = profileA;
  const modeStarted = Promise.withResolvers();
  const releaseMode = Promise.withResolvers();
  const requestTargets = [];
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => activeProfile,
      isPaired: async () => true,
      saveProfile: async (profile) => { activeProfile = profile; },
      saveServerMode: async () => {
        modeStarted.resolve();
        await releaseMode.promise;
        return 'self-hosted';
      },
      uploadBlob: async () => {
        requestTargets.push(activeProfile.endpoint);
        return { blobId: 'blob-writer-tail', sha256: 'a'.repeat(64), size: 3 };
      },
      command: async (sessionId) => {
        requestTargets.push(activeProfile.endpoint);
        return { session: { id: sessionId, status: 'running', stateVersion: 2 } };
      },
    },
    store: new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') }),
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    releaseMode.resolve();
    await coordinator.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const switching = coordinator.saveProfile({
    profile: {
      name: 'Server B', host: profileB.ssh.host, sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileB.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await modeStarted.promise;
  const command = coordinator.command({
    sessionId: 'shared-writer-tail-command',
    command: 'queue-message',
    expectedVersion: 1,
    message: 'Continue',
    messageId: 'message-writer-tail',
    attachments: [{
      id: 'attachment-writer-tail', name: 'note.txt', mimeType: 'text/plain', size: 3,
      bytes: new Uint8Array(Buffer.from('one')),
    }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requestTargets, []);

  releaseMode.resolve();
  const [switched] = await Promise.all([switching, command]);
  assert.equal(switched.profileEpoch, 1);
  assert.deepEqual(requestTargets, [profileB.endpoint, profileB.endpoint]);
});

test('a profile writer still owns the lease while publishing its final event', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-profile-writer-event-'));
  const profile = normalizeCloudProfile({
    endpoint: 'https://writer-event.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'writer-event.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const requestTargets = [];
  let eventCommand = null;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      redeemPairingCode: async () => ({ credentials: { device: { id: 'writer-event-device' } } }),
      health: async () => ({ ok: true, serverPublicKey: SERVER_KEY }),
      activateProfile: async () => {},
      saveServerMode: async () => 'self-hosted',
      uploadBlob: async () => {
        requestTargets.push(profile.endpoint);
        return { blobId: 'blob-writer-event', sha256: 'a'.repeat(64), size: 3 };
      },
      command: async (sessionId) => {
        requestTargets.push(profile.endpoint);
        return { session: { id: sessionId, status: 'running', stateVersion: 2 } };
      },
    },
    store: new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') }),
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  coordinator.on('event', (event) => {
    if (event.type !== 'paired') return;
    eventCommand = coordinator.command({
      sessionId: 'shared-writer-event-command',
      command: 'queue-message',
      expectedVersion: 1,
      message: 'Continue',
      messageId: 'message-writer-event',
      attachments: [{
        id: 'attachment-writer-event', name: 'note.txt', mimeType: 'text/plain', size: 3,
        bytes: new Uint8Array(Buffer.from('one')),
      }],
    });
    assert.deepEqual(requestTargets, []);
  });
  t.after(async () => {
    await coordinator.stop();
    await rm(directory, { recursive: true, force: true });
  });

  await coordinator.pair({ code: 'ABCD-EFGH-IJKL' });
  await eventCommand;
  assert.deepEqual(requestTargets, [profile.endpoint, profile.endpoint]);
});

test('a failed profile write restores local and remote session watchers', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-profile-watcher-restore-'));
  const profile = normalizeCloudProfile({
    endpoint: 'https://watcher-restore.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'watcher-restore.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-watcher-restore', threadId: 'thread-watcher-restore',
    documentId: 'document-watcher-restore', documentName: 'watcher-restore.hwpx',
    documentBytes: Buffer.from('document'), provider: 'codex', limits: { maxTurns: 100 },
    destination: { endpoint: profile.endpoint, serverPublicKey: profile.serverPublicKey, mode: profile.mode },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', {
    cloudSessionId: 'cloud-local-restore', serverVersion: 2,
  });
  const callbacks = new Map();
  let remoteStatus = 'running';
  const remoteSession = () => ({
    id: 'cloud-remote-restore', status: remoteStatus, stateVersion: 2,
    clientContext: { documentId: 'document-remote-restore', threadId: 'thread-remote-restore' },
    originDocument: { name: 'remote-restore.hwpx' },
  });
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      sessions: async () => [
        { id: 'cloud-local-restore', status: 'running', stateVersion: 2 },
        remoteSession(),
      ],
      deviceId: async () => 'watcher-restore-device',
      session: async () => remoteSession(),
      saveProfile: async () => { throw new Error('forced profile write failure'); },
      watchSession: async (sessionId, _after, { signal, onEvent }) => {
        const entries = callbacks.get(sessionId) ?? [];
        entries.push(onEvent);
        callbacks.set(sessionId, entries);
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });

  await coordinator.refresh();
  assert.equal(callbacks.get('cloud-local-restore')?.length, 1);
  assert.equal(callbacks.get('cloud-remote-restore')?.length, 1);
  await assert.rejects(coordinator.saveProfile({
    profile: {
      name: 'Same server', host: profile.ssh.host, sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profile.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  }), /forced profile write failure/);

  assert.equal(callbacks.get('cloud-local-restore')?.length, 2);
  assert.equal(callbacks.get('cloud-remote-restore')?.length, 2);
  await callbacks.get('cloud-local-restore').at(-1)({
    sequence: 3,
    type: 'session.suspended',
    payload: { status: 'suspended', stateVersion: 3 },
  });
  assert.equal((await store.get(created.id)).state, 'suspended');

  remoteStatus = 'suspended';
  await callbacks.get('cloud-remote-restore').at(-1)({
    sequence: 3,
    type: 'session.suspended',
    payload: { status: 'suspended', stateVersion: 3 },
  });
  const remoteSnapshot = await coordinator.snapshot({ selectedSessionId: 'cloud-remote-restore' });
  assert.equal(remoteSnapshot.session.kind, 'suspended');
});

test('early local and remote watcher callbacks acquire independent profile leases', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-early-watcher-lease-'));
  const profileA = normalizeCloudProfile({
    endpoint: 'https://early-watcher-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'early-watcher-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://early-watcher-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'early-watcher-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  let activeProfile = profileA;
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-early-watcher', threadId: 'thread-early-watcher',
    documentId: 'document-early-watcher', documentName: 'early-watcher.hwpx',
    documentBytes: Buffer.from('document'), provider: 'codex', limits: { maxTurns: 100 },
    destination: { endpoint: profileA.endpoint, serverPublicKey: profileA.serverPublicKey, mode: profileA.mode },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', {
    cloudSessionId: 'cloud-local-early', serverVersion: 2,
  });
  const localCallbackStarted = Promise.withResolvers();
  const remoteCallbackStarted = Promise.withResolvers();
  const releaseLocalCallback = Promise.withResolvers();
  const releaseRemoteCallback = Promise.withResolvers();
  const callbackPromises = [];
  const originalGet = store.get.bind(store);
  let pauseLocalRead = true;
  store.get = async (...args) => {
    if (pauseLocalRead) {
      pauseLocalRead = false;
      localCallbackStarted.resolve();
      await releaseLocalCallback.promise;
    }
    return originalGet(...args);
  };
  let profileSaved = false;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => activeProfile,
      isPaired: async () => true,
      sessions: async () => [
        { id: 'cloud-local-early', status: 'running', stateVersion: 2 },
        {
          id: 'cloud-remote-early', status: 'running', stateVersion: 2,
          clientContext: { documentId: 'document-remote-early', threadId: 'thread-remote-early' },
          originDocument: { name: 'remote-early.hwpx' },
        },
      ],
      deviceId: async () => 'early-watcher-device',
      session: async () => {
        remoteCallbackStarted.resolve();
        await releaseRemoteCallback.promise;
        return {
          id: 'cloud-remote-early', status: 'suspended', stateVersion: 3,
          clientContext: { documentId: 'document-remote-early', threadId: 'thread-remote-early' },
          originDocument: { name: 'remote-early.hwpx' },
        };
      },
      watchSession: async (sessionId, _after, { signal, onEvent }) => {
        callbackPromises.push(onEvent({
          sequence: 3,
          type: 'session.suspended',
          payload: { status: 'suspended', stateVersion: 3 },
        }));
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      saveProfile: async (profile) => {
        profileSaved = true;
        activeProfile = profile;
      },
      saveServerMode: async () => 'self-hosted',
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    releaseLocalCallback.resolve();
    releaseRemoteCallback.resolve();
    await Promise.allSettled(callbackPromises);
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });

  await coordinator.refresh();
  await Promise.all([localCallbackStarted.promise, remoteCallbackStarted.promise]);
  const switching = coordinator.saveProfile({
    profile: {
      name: 'Server B', host: profileB.ssh.host, sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileB.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(profileSaved, false);
  } finally {
    releaseLocalCallback.resolve();
    releaseRemoteCallback.resolve();
  }
  await Promise.all([...callbackPromises, switching]);
  assert.equal(activeProfile.endpoint, profileB.endpoint);
});

test('stop waits for an early watcher callback that outlives its parent refresh', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-early-watcher-stop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = normalizeCloudProfile({
    endpoint: 'https://early-watcher-stop.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'early-watcher-stop.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const callbackStarted = Promise.withResolvers();
  const releaseCallback = Promise.withResolvers();
  let callbackPromise;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      sessions: async () => [{
        id: 'cloud-early-watcher-stop', status: 'running', stateVersion: 2,
        clientContext: { documentId: 'document-early-watcher-stop', threadId: 'thread-early-watcher-stop' },
        originDocument: { name: 'early-watcher-stop.hwpx' },
      }],
      deviceId: async () => 'early-watcher-stop-device',
      session: async () => {
        callbackStarted.resolve();
        await releaseCallback.promise;
        return {
          id: 'cloud-early-watcher-stop', status: 'suspended', stateVersion: 3,
          clientContext: { documentId: 'document-early-watcher-stop', threadId: 'thread-early-watcher-stop' },
          originDocument: { name: 'early-watcher-stop.hwpx' },
        };
      },
      watchSession: async (_sessionId, _after, { signal, onEvent }) => {
        callbackPromise = onEvent({
          sequence: 3,
          type: 'session.suspended',
          payload: { status: 'suspended', stateVersion: 3 },
        });
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    },
    store: new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') }),
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });

  await coordinator.refresh();
  await callbackStarted.promise;
  let stopSettled = false;
  const stopping = coordinator.stop().then(() => { stopSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(stopSettled, false);
  } finally {
    releaseCallback.resolve();
  }
  await Promise.all([callbackPromise, stopping]);
});

test('buffered watcher callbacks reject without store mutations after stop', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-watcher-stop-'));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-watcher-stop', threadId: 'thread-watcher-stop', documentId: 'document-watcher-stop',
    documentName: 'watcher-stop.hwpx', documentBytes: Buffer.from('document'), timeline: null,
    provider: 'codex', limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-watcher-stop', serverVersion: 2 });
  let watcherCallback;
  const watcherReady = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      watchSession: async (_sessionId, _after, { signal, onEvent }) => {
        watcherCallback = onEvent;
        watcherReady.resolve();
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await delay(5);
    await rm(directory, { recursive: true, force: true });
  });
  await coordinator.start();
  await watcherReady.promise;
  await coordinator.stop();

  const before = await store.get(created.id);
  await assert.rejects(watcherCallback({
    sequence: 3,
    type: 'session.suspended',
    payload: { status: 'suspended', stateVersion: 3 },
  }), { code: 'COORDINATOR_STOPPED' });
  const after = await store.get(created.id);
  assert.equal(after.revision, before.revision);
  assert.equal(after.state, 'running');
});

test('a recovery callback already queued by the timer cannot outlive stop', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-recovery-stop-'));
  const profile = normalizeCloudProfile({
    endpoint: 'https://recovery-stop.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'recovery-stop.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-recovery-stop', threadId: 'thread-recovery-stop', documentId: 'document-recovery-stop',
    documentName: 'recovery-stop.hwpx', documentBytes: Buffer.from('document'), timeline: null,
    provider: 'codex', limits: { maxTurns: 100 },
    destination: {
      endpoint: profile.endpoint,
      serverPublicKey: profile.serverPublicKey,
      mode: profile.mode,
      sandboxId: null,
      sandboxProvider: null,
      protocolVersion: 1,
    },
  });
  await store.transition(created.id, 'uploading');
  let readinessCalls = 0;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      assertTransferReady: async () => {
        readinessCalls += 1;
        return { profile, health: { protocolVersion: 1, version: '1.0.0' } };
      },
      transfer: async ({ sessionId, onProgress, onSessionCreated, onSessionActivated }) => {
        await onProgress({ phase: 'committing', loaded: 1, total: 1 });
        await onSessionCreated({ sessionId, stateVersion: 1 });
        await onSessionActivated({ sessionId, stateVersion: 2, eventSeq: 2 });
        return { id: sessionId, status: 'queued', stateVersion: 2 };
      },
      watchSession: async () => {},
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });

  const scheduled = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, timeout, ...args) => {
    if (timeout === 0) {
      const timer = {
        run: () => callback(...args),
        unref() {},
        [Symbol.toPrimitive]: () => -1,
      };
      scheduled.push(timer);
      return timer;
    }
    return originalSetTimeout(callback, timeout, ...args);
  };
  try {
    await coordinator.start();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(scheduled.length, 1);
  await coordinator.stop();
  let postStopEvents = 0;
  coordinator.on('event', (event) => {
    if (event.type === 'session-recovery-error' || event.type === 'session-transfer-recovered') {
      postStopEvents += 1;
    }
  });
  scheduled[0].run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readinessCalls, 0);
  assert.equal(postStopEvents, 0);
  assert.equal((await store.get(created.id)).state, 'uploading');
});

test('takeover completion retains server A until its boundary is consumed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-takeover-profile-race-'));
  const profileA = normalizeCloudProfile({
    endpoint: 'https://takeover-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'takeover-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://takeover-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'takeover-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  let activeProfile = profileA;
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const consumeStarted = Promise.withResolvers();
  const releaseConsume = Promise.withResolvers();
  const originalConsume = store.consumeTakeoverBoundary.bind(store);
  const order = [];
  store.consumeTakeoverBoundary = async (...args) => {
    consumeStarted.resolve();
    await releaseConsume.promise;
    const result = await originalConsume(...args);
    order.push('consume:A');
    return result;
  };
  const remoteA = {
    id: 'cloud-takeover-profile', status: 'cancelled', stateVersion: 4,
    takeoverReady: true,
    takeoverBoundary: { operationId: 'turn_takeover_profile' },
    clientContext: { documentId: 'document-a', threadId: 'thread-a' },
    originDocument: { name: 'document-a.hwpx' },
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => activeProfile,
      isPaired: async () => true,
      sessions: async () => activeProfile.endpoint === profileA.endpoint ? [remoteA] : [],
      deviceId: async () => 'takeover-device',
      watchSession: async (_sessionId, _after, { signal }) => {
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      saveProfile: async (profile) => {
        order.push('save:B');
        activeProfile = profile;
      },
      saveServerMode: async () => 'self-hosted',
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  await coordinator.refresh({ selectedSessionId: remoteA.id });

  const completing = coordinator.completeTakeover({
    sessionId: remoteA.id,
    operationId: remoteA.takeoverBoundary.operationId,
  });
  await consumeStarted.promise;
  const switching = coordinator.saveProfile({
    profile: {
      name: 'Server B', host: 'takeover-b.example.ts.net', sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileB.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeProfile.endpoint, profileA.endpoint);
  releaseConsume.resolve();
  const completedA = await completing;
  const switchedB = await switching;
  assert.equal(completedA.profileEpoch, 0);
  assert.equal(completedA.session.documentId, 'document-a');
  assert.equal(switchedB.profileEpoch, 1);
  assert.equal(switchedB.session.kind, 'idle');
  assert.deepEqual(order, ['consume:A', 'save:B']);
});

test('snapshots wait until a profile writer commits its identity and epoch together', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-profile-snapshot-'));
  const profileA = normalizeCloudProfile({
    endpoint: 'https://snapshot-profile-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'snapshot-profile-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://snapshot-profile-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'snapshot-profile-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  let activeProfile = profileA;
  const saveStarted = Promise.withResolvers();
  const releaseSave = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => activeProfile,
      isPaired: async () => true,
      saveProfile: async (profile) => {
        saveStarted.resolve();
        await releaseSave.promise;
        activeProfile = profile;
      },
      saveServerMode: async () => 'self-hosted',
    },
    store: new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') }),
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const switching = coordinator.saveProfile({
    profile: {
      name: 'Server B', host: profileB.ssh.host, sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileB.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await saveStarted.promise;
  let snapshotSettled = false;
  const pendingSnapshot = coordinator.snapshot().then((snapshot) => {
    snapshotSettled = true;
    return snapshot;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshotSettled, false);

  releaseSave.resolve();
  const [switched, snapshot] = await Promise.all([switching, pendingSnapshot]);
  assert.equal(switched.profileEpoch, 1);
  assert.equal(snapshot.profileEpoch, 1);
  assert.equal(snapshot.profile.profile.host, profileB.ssh.host);
});

test('session dismissal holds its profile lease through deletion and publication', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-dismiss-profile-'));
  const profileA = normalizeCloudProfile({
    endpoint: 'https://dismiss-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'dismiss-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://dismiss-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'dismiss-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  let activeProfile = profileA;
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const record = await store.create({
    sessionId: 'desktop-dismiss', threadId: 'thread-dismiss', documentId: 'document-dismiss',
    documentName: 'dismiss.hwpx', documentBytes: Buffer.from('document'), provider: 'codex',
    destination: {
      endpoint: profileA.endpoint,
      serverPublicKey: profileA.serverPublicKey,
      mode: profileA.mode,
    },
  });
  await store.transition(record.id, 'failed');
  const dismissStarted = Promise.withResolvers();
  const releaseDismiss = Promise.withResolvers();
  const originalDismiss = store.dismiss.bind(store);
  store.dismiss = async (...args) => {
    dismissStarted.resolve();
    await releaseDismiss.promise;
    return originalDismiss(...args);
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => activeProfile,
      isPaired: async () => true,
      saveProfile: async (profile) => { activeProfile = profile; },
      saveServerMode: async () => 'self-hosted',
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });

  const dismissing = coordinator.dismissSession({ sessionId: record.id });
  await dismissStarted.promise;
  const switching = coordinator.saveProfile({
    profile: {
      name: 'Server B', host: profileB.ssh.host, sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileB.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeProfile.endpoint, profileA.endpoint);

  releaseDismiss.resolve();
  const dismissed = await dismissing;
  const switched = await switching;
  assert.equal(dismissed.profileEpoch, 0);
  assert.equal(dismissed.session.kind, 'idle');
  assert.equal(switched.profileEpoch, 1);
  assert.equal(activeProfile.endpoint, profileB.endpoint);
});

test('an active-handoff lease spans irreversible local work and the final snapshot', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-resolution-lease-'));
  const profileA = normalizeCloudProfile({
    endpoint: 'https://resolution-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'resolution-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://resolution-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'resolution-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  let activeProfile = profileA;
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-resolution', threadId: 'thread-resolution', documentId: 'document-resolution',
    documentName: 'resolution.hwpx', documentBytes: Buffer.from('document'), timeline: null,
    provider: 'codex', limits: { maxTurns: 100 },
    destination: {
      endpoint: profileA.endpoint,
      serverPublicKey: profileA.serverPublicKey,
      mode: profileA.mode,
      sandboxId: null,
      sandboxProvider: null,
    },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-resolution', serverVersion: 2 });
  await store.transition(created.id, 'completed');
  const localMutationStarted = Promise.withResolvers();
  const releaseLocalMutation = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => activeProfile,
      isPaired: async () => true,
      saveProfile: async (profile) => { activeProfile = profile; },
      saveServerMode: async () => 'self-hosted',
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });

  const resolving = coordinator.withActiveHandoff('cloud-resolution', async (handoff) => {
    assert.equal(handoff.id, created.id);
    localMutationStarted.resolve();
    await releaseLocalMutation.promise;
    return coordinator.snapshot({ selectedSessionId: handoff.cloudSessionId });
  });
  await localMutationStarted.promise;
  const switching = coordinator.saveProfile({
    profile: {
      name: 'Server B', host: 'resolution-b.example.ts.net', sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileB.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeProfile.endpoint, profileA.endpoint);
  releaseLocalMutation.resolve();
  const resolvedA = await resolving;
  await switching;
  assert.equal(resolvedA.profileEpoch, 0);
  assert.equal(resolvedA.session.documentId, 'document-resolution');
  assert.equal(activeProfile.endpoint, profileB.endpoint);
});

test('a nested result download keeps one profile lease through preview work and its scoped snapshot', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-download-result-lease-'));
  const profileA = normalizeCloudProfile({
    endpoint: 'https://download-lease-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'download-lease-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://download-lease-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'download-lease-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  let activeProfile = profileA;
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-download-lease', threadId: 'thread-download-lease',
    documentId: 'document-download-lease', documentName: 'download-lease.hwpx',
    documentBytes: Buffer.from('document'), provider: 'codex', limits: { maxTurns: 100 },
    destination: { endpoint: profileA.endpoint, serverPublicKey: profileA.serverPublicKey, mode: profileA.mode },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', {
    cloudSessionId: 'cloud-download-lease', serverVersion: 2,
  });
  await store.transition(created.id, 'completed');
  const recoveryBytes = Buffer.from('downloaded result');
  const recoveryPath = path.join(directory, 'recovery', created.id, 'download-lease.hwpx');
  await mkdir(path.dirname(recoveryPath), { recursive: true });
  await writeFile(recoveryPath, recoveryBytes);
  await store.patch(created.id, {
    recoveryPath,
    resultDigest: createHash('sha256').update(recoveryBytes).digest('hex'),
    resultSize: recoveryBytes.length,
    resultName: 'download-lease.hwpx',
  });
  const previewStarted = Promise.withResolvers();
  const releasePreview = Promise.withResolvers();
  let profileSaved = false;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => activeProfile,
      isPaired: async () => true,
      saveProfile: async (profile) => {
        profileSaved = true;
        activeProfile = profile;
      },
      saveServerMode: async () => 'self-hosted',
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    releasePreview.resolve();
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });

  const downloading = coordinator.withActiveHandoff('cloud-download-lease', async () => {
    const result = await coordinator.downloadResult({ sessionId: 'cloud-download-lease' });
    const handoff = await coordinator.handoffForSession('cloud-download-lease');
    assert.equal(handoff.id, created.id);
    previewStarted.resolve();
    await releasePreview.promise;
    return coordinator.snapshot({
      selectedSessionId: result.sessionId,
      extra: { previewOpened: true },
    });
  });
  await previewStarted.promise;
  const switching = coordinator.saveProfile({
    profile: {
      name: 'Server B', host: profileB.ssh.host, sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileB.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(profileSaved, false);

  releasePreview.resolve();
  const downloaded = await downloading;
  await switching;
  assert.equal(downloaded.profileEpoch, 0);
  assert.equal(downloaded.previewOpened, true);
  assert.equal(activeProfile.endpoint, profileB.endpoint);
});

test('an admitted server A refresh completes before a queued profile change', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-profile-epoch-'));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const profileA = normalizeCloudProfile({
    endpoint: 'https://server-a.tailnet.ts.net/rauhwpx-cloud',
    ssh: { host: 'server-a.tailnet.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://server-b.tailnet.ts.net/rauhwpx-cloud',
    ssh: { host: 'server-b.tailnet.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const archivedA = await store.create({
    sessionId: 'desktop-a',
    threadId: 'thread-document-a',
    documentId: 'document-a',
    documentName: 'document-a.hwpx',
    documentBytes: Buffer.from('document-a'),
    timeline: { schema: 'rauhwpx.cloud.timeline', version: 1, thread: { id: 'thread-document-a' } },
    provider: 'codex',
    limits: { maxTurns: 10 },
    destination: {
      endpoint: profileA.endpoint,
      serverPublicKey: profileA.serverPublicKey,
      mode: profileA.mode,
      sandboxId: null,
      sandboxProvider: null,
    },
  });
  await store.transition(archivedA.id, 'uploading');
  await store.transition(archivedA.id, 'committing');
  await store.transition(archivedA.id, 'queued', { cloudSessionId: 'shared-session', serverVersion: 2 });
  const remote = (documentId) => ({
    id: 'shared-session', status: 'suspended', stateVersion: 3,
    clientContext: { documentId, threadId: `thread-${documentId}` },
    originDocument: { name: `${documentId}.hwpx` },
    suspendedReason: { message: 'Waiting' },
  });
  let activeProfile = profileA;
  const serverARefresh = Promise.withResolvers();
  let delayServerA = false;
  const watcherSignals = [];
  const watcherCallbacks = [];
  let staleCallbackActive = false;
  let staleCallbackRequests = 0;
  const timeline = { schema: 'rauhwpx.cloud.timeline', version: 1, thread: { id: 'thread-document-a' } };
  const timelineBytes = Buffer.from(JSON.stringify(timeline));
  const client = {
    loadProfile: async () => activeProfile,
    isPaired: async () => true,
    sessions: async () => {
      if (activeProfile.endpoint === profileA.endpoint && delayServerA) return serverARefresh.promise;
      return [remote(activeProfile.endpoint === profileA.endpoint ? 'document-a' : 'document-b')];
    },
    deviceId: async () => 'device-1',
    downloadTimeline: async () => {
      if (staleCallbackActive) staleCallbackRequests += 1;
      return { bytes: timelineBytes, timeline, sha256: createDigest(timelineBytes), size: timelineBytes.length };
    },
    session: async () => {
      if (staleCallbackActive) staleCallbackRequests += 1;
      return { id: 'shared-session', status: 'completed' };
    },
    watchSession: async (_sessionId, _after, { signal, onEvent }) => {
      watcherSignals.push(signal);
      watcherCallbacks.push(onEvent);
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
    saveProfile: async (profile) => { activeProfile = profile; },
    saveServerMode: async () => 'self-hosted',
    redeemPairingCode: async () => ({ credentials: { device: { id: 'device-2' } } }),
    health: async () => ({ ok: true, serverPublicKey: activeProfile.serverPublicKey }),
    activateProfile: async (profile) => { activeProfile = profile; },
  };
  const coordinator = new CloudCoordinator({
    client,
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const initialA = await coordinator.refresh({ selectedSessionId: 'shared-session' });
  assert.equal(initialA.session.documentId, 'document-a');
  assert.equal(initialA.profileEpoch, 0);
  delayServerA = true;
  const staleA = coordinator.refresh({ selectedSessionId: 'shared-session' });
  await Promise.resolve();
  let switchSettled = false;
  const switching = coordinator.saveProfile({
    profile: {
      name: 'Server B', host: 'server-b.tailnet.ts.net', sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileB.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  }).then((snapshot) => {
    switchSettled = true;
    return snapshot;
  });
  await Promise.resolve();
  assert.equal(switchSettled, false);
  assert.equal(activeProfile.endpoint, profileA.endpoint);
  serverARefresh.resolve([remote('document-a')]);
  const completedA = await staleA;
  assert.equal(completedA.profileEpoch, 0);
  assert.equal(completedA.session.documentId, 'document-a');
  const switched = await switching;
  assert.equal(switched.profileEpoch, 1);
  staleCallbackActive = true;
  let staleCallback;
  assert.doesNotThrow(() => {
    staleCallback = watcherCallbacks[0]({
      type: 'session.completed', sequence: 4, payload: { status: 'completed' },
    });
  });
  await assert.rejects(staleCallback, { code: 'PROFILE_CHANGED' });
  staleCallbackActive = false;
  assert.equal(staleCallbackRequests, 0);

  let snapshot = await coordinator.refresh({ selectedSessionId: 'shared-session' });
  assert.equal(snapshot.profileEpoch, 1);
  assert.equal(snapshot.session.documentId, 'document-b');
  assert.deepEqual(snapshot.sessions.map((session) => session.documentId), ['document-b']);
  assert.equal(snapshot.lease.sessionId, 'shared-session');

  const beforeRepair = snapshot.profileEpoch;
  snapshot = await coordinator.pair({ code: 'ABCD-EFGH-IJKL' });
  assert.equal(snapshot.profileEpoch, beforeRepair + 1);
  assert.equal(snapshot.session.kind, 'idle');
  assert.ok(watcherSignals.every((signal) => signal.aborted));
  delayServerA = false;
});

test('a multi-request command keeps server A until its queued profile change runs', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-profile-reader-first-'));
  const profileA = normalizeCloudProfile({
    endpoint: 'https://reader-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'reader-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://reader-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'reader-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  let activeProfile = profileA;
  const uploadStarted = Promise.withResolvers();
  const releaseUpload = Promise.withResolvers();
  const requestTargets = [];
  let profileSaved = false;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => activeProfile,
      isPaired: async () => true,
      uploadBlob: async () => {
        requestTargets.push(activeProfile.endpoint);
        uploadStarted.resolve();
        await releaseUpload.promise;
        return { blobId: 'blob-1', sha256: 'a'.repeat(64), size: 3 };
      },
      command: async (sessionId) => {
        requestTargets.push(activeProfile.endpoint);
        return { session: { id: sessionId, status: 'running', stateVersion: 2 } };
      },
      saveProfile: async (profile) => {
        profileSaved = true;
        activeProfile = profile;
      },
      saveServerMode: async () => 'self-hosted',
    },
    store: new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') }),
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const command = coordinator.command({
    sessionId: 'shared-command',
    command: 'queue-message',
    expectedVersion: 1,
    message: 'Continue',
    messageId: 'message-reader-first',
    attachments: [{
      id: 'attachment-1', name: 'note.txt', mimeType: 'text/plain', size: 3,
      bytes: new Uint8Array(Buffer.from('one')),
    }],
  });
  await uploadStarted.promise;
  const switching = coordinator.saveProfile({
    profile: {
      name: 'Server B', host: 'reader-b.example.ts.net', sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileB.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await Promise.resolve();
  assert.equal(profileSaved, false);
  releaseUpload.resolve();
  await command;
  await switching;
  assert.deepEqual(requestTargets, [profileA.endpoint, profileA.endpoint]);
  assert.equal(activeProfile.endpoint, profileB.endpoint);
});

test('a queued command waits for an admitted profile writer and starts on server B', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-profile-writer-first-'));
  const profileA = normalizeCloudProfile({
    endpoint: 'https://writer-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'writer-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://writer-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'writer-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  let activeProfile = profileA;
  const saveStarted = Promise.withResolvers();
  const releaseSave = Promise.withResolvers();
  const requestTargets = [];
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => activeProfile,
      isPaired: async () => true,
      saveProfile: async (profile) => {
        saveStarted.resolve();
        await releaseSave.promise;
        activeProfile = profile;
      },
      saveServerMode: async () => 'self-hosted',
      uploadBlob: async () => {
        requestTargets.push(activeProfile.endpoint);
        return { blobId: 'blob-1', sha256: 'a'.repeat(64), size: 3 };
      },
      command: async (sessionId) => {
        requestTargets.push(activeProfile.endpoint);
        return { session: { id: sessionId, status: 'running', stateVersion: 2 } };
      },
    },
    store: new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') }),
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const switching = coordinator.saveProfile({
    profile: {
      name: 'Server B', host: 'writer-b.example.ts.net', sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileB.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await saveStarted.promise;
  const command = coordinator.command({
    sessionId: 'shared-command',
    command: 'queue-message',
    expectedVersion: 1,
    message: 'Continue',
    messageId: 'message-writer-first',
    attachments: [{
      id: 'attachment-1', name: 'note.txt', mimeType: 'text/plain', size: 3,
      bytes: new Uint8Array(Buffer.from('two')),
    }],
  });
  await Promise.resolve();
  assert.deepEqual(requestTargets, []);
  releaseSave.resolve();
  await switching;
  await command;
  assert.deepEqual(requestTargets, [profileB.endpoint, profileB.endpoint]);
});

test('cross-device takeover completion consumes the applied boundary without clearing a newer one', async (t) => {
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
    loadProfile: async () => normalizeCloudProfile({
      name: 'VPS', endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
      ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
      serverPublicKey: SERVER_KEY,
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
  const appliedOperationId = operationId;
  operationId = 'turn:stable-operation-2';
  snapshot = await first.refresh({ selectedSessionId: 'cloud-remote-1' });
  assert.equal(snapshot.session.kind, 'taking-over');
  snapshot = await first.completeTakeover({
    sessionId: 'cloud-remote-1',
    operationId: appliedOperationId,
  });
  assert.equal(snapshot.operationId, appliedOperationId);
  assert.equal(snapshot.session.kind, 'taking-over', 'completing A does not clear future boundary B');

  const restarted = new CloudCoordinator({
    client,
    store: new CloudHandoffStore({ filePath: storePath }),
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  snapshot = await restarted.refresh({ selectedSessionId: 'cloud-remote-1' });
  assert.equal(snapshot.session.kind, 'taking-over', 'a fresh coordinator keeps unconsumed boundary B visible');

  snapshot = await restarted.completeTakeover({
    sessionId: 'cloud-remote-1',
    operationId,
  });
  assert.equal(snapshot.operationId, operationId);
  assert.equal(snapshot.session.kind, 'cancelled');
  snapshot = await restarted.refresh({ selectedSessionId: 'cloud-remote-1' });
  assert.equal(snapshot.session.kind, 'cancelled', 'refresh does not replay consumed boundary B');

  operationId = 'turn:stable-operation-3';
  snapshot = await restarted.refresh({ selectedSessionId: 'cloud-remote-1' });
  assert.equal(snapshot.session.kind, 'taking-over', 'a different future frozen boundary remains visible');
});

test('local takeover completion does not clear a newer watcher boundary', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-local-takeover-cas-'));
  const profile = normalizeCloudProfile({
    endpoint: 'https://local-takeover-cas.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'local-takeover-cas.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const consumeStarted = Promise.withResolvers();
  const releaseConsume = Promise.withResolvers();
  const atomicWrite = async (target, value) => {
    if (value.takeoverReceipts.some((receipt) => receipt.operationId === 'boundary-local-a')) {
      consumeStarted.resolve();
      await releaseConsume.promise;
    }
    await writeFile(target, `${JSON.stringify(value)}\n`);
  };
  const store = new CloudHandoffStore({
    filePath: path.join(directory, 'handoffs.json'),
    atomicWrite,
  });
  const created = await store.create({
    sessionId: 'desktop-local-takeover-cas', threadId: 'thread-local-takeover-cas',
    documentId: 'document-local-takeover-cas', documentName: 'local-takeover-cas.hwpx',
    documentBytes: Buffer.from('document'), provider: 'codex', limits: { maxTurns: 100 },
    destination: { endpoint: profile.endpoint, serverPublicKey: profile.serverPublicKey, mode: profile.mode },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', {
    cloudSessionId: 'cloud-local-takeover-cas', serverVersion: 2,
    takeoverReady: true,
    takeoverBoundary: { operationId: 'boundary-local-a' },
  });
  let watcherCallback;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      sessions: async () => [{ id: 'cloud-local-takeover-cas', status: 'running', stateVersion: 2 }],
      deviceId: async () => 'local-takeover-cas-device',
      watchSession: async (_sessionId, _after, { signal, onEvent }) => {
        watcherCallback = onEvent;
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    releaseConsume.resolve();
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  await coordinator.refresh({ selectedSessionId: 'cloud-local-takeover-cas' });

  const completing = coordinator.completeTakeover({
    sessionId: 'cloud-local-takeover-cas',
    operationId: 'boundary-local-a',
  });
  await consumeStarted.promise;
  await watcherCallback({
    sequence: 3,
    type: 'session.takeover_ready',
    payload: {
      status: 'running', stateVersion: 3,
      boundary: { operationId: 'boundary-local-b' },
    },
  });
  releaseConsume.resolve();
  const snapshot = await completing;
  assert.equal(snapshot.session.kind, 'taking-over');
  assert.equal((await store.get(created.id)).takeoverBoundary.operationId, 'boundary-local-b');
});

test('remote takeover completion does not overwrite a newer watcher boundary', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-remote-takeover-cas-'));
  const profile = normalizeCloudProfile({
    endpoint: 'https://remote-takeover-cas.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'remote-takeover-cas.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const consumeStarted = Promise.withResolvers();
  const releaseConsume = Promise.withResolvers();
  const atomicWrite = async (target, value) => {
    if (value.takeoverReceipts.some((receipt) => receipt.operationId === 'boundary-remote-a')) {
      consumeStarted.resolve();
      await releaseConsume.promise;
    }
    await writeFile(target, `${JSON.stringify(value)}\n`);
  };
  const store = new CloudHandoffStore({
    filePath: path.join(directory, 'handoffs.json'),
    atomicWrite,
  });
  let boundaryOperationId = 'boundary-remote-a';
  let watcherCallback;
  const remoteSession = () => ({
    id: 'cloud-remote-takeover-cas', status: 'running', stateVersion: 3,
    takeoverReady: true,
    takeoverBoundary: { operationId: boundaryOperationId },
    clientContext: { documentId: 'document-remote-takeover-cas', threadId: 'thread-remote-takeover-cas' },
    originDocument: { name: 'remote-takeover-cas.hwpx' },
  });
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      sessions: async () => [remoteSession()],
      session: async () => remoteSession(),
      deviceId: async () => 'remote-takeover-cas-device',
      watchSession: async (_sessionId, _after, { signal, onEvent }) => {
        watcherCallback = onEvent;
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    releaseConsume.resolve();
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  await coordinator.refresh({ selectedSessionId: 'cloud-remote-takeover-cas' });

  const completing = coordinator.completeTakeover({
    sessionId: 'cloud-remote-takeover-cas',
    operationId: 'boundary-remote-a',
  });
  await consumeStarted.promise;
  boundaryOperationId = 'boundary-remote-b';
  await watcherCallback({
    sequence: 4,
    type: 'session.takeover_ready',
    payload: { status: 'running', stateVersion: 4, boundary: { operationId: boundaryOperationId } },
  });
  releaseConsume.resolve();
  const snapshot = await completing;
  assert.equal(snapshot.session.kind, 'taking-over');
});

test('cross-device takeover completion requires the applied operation id', async (t) => {
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
    /operation id is invalid/,
  );
});

test('result download resolves duplicate session ids through the active server destination', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-result-profile-'));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const profileA = normalizeCloudProfile({
    endpoint: 'https://profile-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'profile-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://profile-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'profile-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const destination = (profile) => ({
    endpoint: profile.endpoint,
    serverPublicKey: profile.serverPublicKey,
    mode: profile.mode,
  });
  const createCompleted = async (profile, documentId) => {
    const record = await store.create({
      sessionId: `desktop-${documentId}`,
      threadId: `thread-${documentId}`,
      documentId,
      documentName: `${documentId}.hwpx`,
      documentBytes: Buffer.from(documentId),
      timeline: null,
      provider: 'codex',
      limits: { maxTurns: 100 },
      destination: destination(profile),
    });
    await store.transition(record.id, 'uploading');
    await store.transition(record.id, 'committing');
    await store.transition(record.id, 'running', { cloudSessionId: 'shared-result-session', serverVersion: 2 });
    return store.transition(record.id, 'completed');
  };
  const recordB = await createCompleted(profileB, 'document-b');
  await delay(2);
  const recordA = await createCompleted(profileA, 'document-a');
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profileB,
      isPaired: async () => true,
      session: async () => ({ id: 'shared-result-session', result: { id: 'shared-result' } }),
      downloadTimeline: async () => { throw new Error('profile-b-result-failure'); },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(
    coordinator.downloadResult({ sessionId: 'shared-result-session' }),
    /profile-b-result-failure/,
  );
  assert.equal((await store.get(recordA.id)).revision, recordA.revision);
  assert.ok((await store.get(recordB.id)).revision > recordB.revision);
});

test('server A transfer recovery stays off server B and resumes when A is restored', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-transfer-profile-recovery-'));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const profileA = normalizeCloudProfile({
    endpoint: 'https://transfer-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'transfer-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://transfer-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'transfer-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const created = await store.create({
    sessionId: 'desktop-transfer-recovery',
    threadId: 'thread-transfer-recovery',
    documentId: 'document-transfer-recovery',
    documentName: 'transfer-recovery.hwpx',
    documentBytes: Buffer.from('transfer-recovery'),
    timeline: null,
    provider: 'codex',
    limits: { maxTurns: 100 },
    destination: {
      endpoint: profileA.endpoint,
      serverPublicKey: profileA.serverPublicKey,
      mode: profileA.mode,
      sandboxId: null,
      sandboxProvider: null,
      protocolVersion: 1,
    },
  });
  await store.transition(created.id, 'uploading');
  let activeProfile = profileB;
  const requestTargets = [];
  const recovered = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => activeProfile,
      isPaired: async () => true,
      saveProfile: async (profile) => { activeProfile = profile; },
      saveServerMode: async () => 'self-hosted',
      assertTransferReady: async () => {
        requestTargets.push(['ready', activeProfile.endpoint]);
        return {
          profile: activeProfile,
          health: { ok: true, protocolVersion: 1, version: '1.0.0', serverPublicKey: activeProfile.serverPublicKey },
        };
      },
      transfer: async ({ sessionId, onProgress, onSessionCreated, onSessionActivated }) => {
        requestTargets.push(['transfer', activeProfile.endpoint]);
        await onProgress({ phase: 'committing', loaded: 1, total: 1 });
        await onSessionCreated({ sessionId, stateVersion: 1 });
        await onSessionActivated({ sessionId, stateVersion: 2, eventSeq: 2 });
        recovered.resolve();
        return { id: sessionId, status: 'queued', stateVersion: 2 };
      },
      watchSession: async (_sessionId, _after, { signal }) => {
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });

  await coordinator.start();
  assert.deepEqual(requestTargets, []);
  await coordinator.saveProfile({
    profile: {
      name: 'Server A', host: 'transfer-a.example.ts.net', sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileA.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await recovered.promise;
  let record;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    record = await store.get(created.id);
    if (record.state === 'queued') break;
    await delay(5);
  }
  assert.equal(record.state, 'queued');
  assert.deepEqual(requestTargets, [
    ['ready', profileA.endpoint],
    ['transfer', profileA.endpoint],
  ]);
});

test('server A result confirmation stays off server B and resumes when A is restored', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-result-profile-recovery-'));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const profileA = normalizeCloudProfile({
    endpoint: 'https://result-a.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'result-a.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const profileB = normalizeCloudProfile({
    endpoint: 'https://result-b.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'result-b.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const created = await store.create({
    sessionId: 'desktop-result-recovery',
    threadId: 'thread-result-recovery',
    documentId: 'document-result-recovery',
    documentName: 'result-recovery.hwpx',
    documentBytes: Buffer.from('original'),
    timeline: null,
    provider: 'codex',
    limits: { maxTurns: 100 },
    destination: {
      endpoint: profileA.endpoint,
      serverPublicKey: profileA.serverPublicKey,
      mode: profileA.mode,
      sandboxId: null,
      sandboxProvider: null,
    },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-result-recovery', serverVersion: 2 });
  await store.transition(created.id, 'completed', { resultId: 'result-recovery' });
  await store.transition(created.id, 'downloading');
  const resultBytes = Buffer.from('verified-result');
  const recoveryPath = path.join(directory, 'verified-result.hwpx');
  await writeFile(recoveryPath, resultBytes);
  await store.patch(created.id, {
    recoveryPath,
    resultDigest: createDigest(resultBytes),
    resultSize: resultBytes.length,
    resultName: 'result-recovery.hwpx',
  });
  let activeProfile = profileB;
  const confirmationTargets = [];
  const confirmed = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => activeProfile,
      isPaired: async () => true,
      saveProfile: async (profile) => { activeProfile = profile; },
      saveServerMode: async () => 'self-hosted',
      confirmResultDownloaded: async () => {
        confirmationTargets.push(activeProfile.endpoint);
        confirmed.resolve();
        return { status: 'purged' };
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });

  await coordinator.start();
  assert.deepEqual(confirmationTargets, []);
  await coordinator.saveProfile({
    profile: {
      name: 'Server A', host: 'result-a.example.ts.net', sshUser: 'cloud', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: profileA.endpoint },
      serverPublicKey: SERVER_KEY,
    },
  });
  await confirmed.promise;
  let record;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    record = await store.get(created.id);
    if (record.state === 'downloaded') break;
    await delay(5);
  }
  assert.equal(record.state, 'downloaded');
  assert.deepEqual(confirmationTargets, [profileA.endpoint]);
});

test('verified result confirmation retries online without another app restart', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-confirm-retry-'));
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
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  const downloaded = await coordinator.downloadResult({ sessionId: 'cloud-1' });
  assert.deepEqual(Buffer.from(downloaded.bytes), resultBytes);
  let recovered;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    recovered = await store.get(created.id);
    if (recovered.state === 'downloaded') break;
    await delay(10);
  }
  assert.equal(recovered.state, 'downloaded');
  assert.equal(confirmations, 2);
});

test('a terminated upload returns retrying state and recovers in the background', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-transfer-retry-'));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const profile = normalizeCloudProfile({
    endpoint: 'https://cloud.example.ts.net/rauhwpx-cloud',
    ssh: { host: 'cloud.example.ts.net', user: 'cloud', useTailscaleSsh: true },
    serverPublicKey: SERVER_KEY,
  });
  const readiness = {
    profile,
    health: { ok: true, protocolVersion: 1, version: '1.0.0', serverPublicKey: SERVER_KEY },
  };
  let transfers = 0;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      assertTransferReady: async () => readiness,
      transfer: async ({ sessionId, onProgress, onSessionCreated, onSessionActivated }) => {
        transfers += 1;
        if (transfers === 1) {
          const error = new TypeError('terminated');
          error.cause = { code: 'UND_ERR_SOCKET' };
          throw error;
        }
        await onProgress({ phase: 'committing', loaded: 1, total: 1 });
        await onSessionCreated({ sessionId, stateVersion: 1 });
        await onSessionActivated({ sessionId, stateVersion: 2, eventSeq: 2 });
        return { id: sessionId, status: 'queued', stateVersion: 2 };
      },
      watchSession: async (_sessionId, _after, { signal }) => {
        if (signal.aborted) return;
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => {
    await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });

  const retrying = await coordinator.transfer(cloudStartTransfer({
    startId: 'startretr',
    threadId: 'thread-1',
    documentId: 'document-1',
    document: { fileName: 'source.hwpx', bytes: new Uint8Array(Buffer.from('document')) },
    agent: 'codex',
    model: 'gpt-5.6',
    effort: 'high',
    workflow: 'direct',
    references: [],
  }), { originSessionId: 'desktop-1' });

  assert.equal(retrying.session.kind, 'transferring');
  assert.match(retrying.session.message, /Retrying the transfer automatically/);
  assert.equal(transfers, 1);

  let recovered;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    [recovered] = await store.list();
    if (recovered?.state === 'queued') break;
    await delay(10);
  }
  assert.equal(recovered.state, 'queued');
  assert.equal(transfers, 2);
  assert.equal(recovered.error, null);
});

function createDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('transfer seeds an env-only provider key before creating the remote session', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-seed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const calls = [];
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      seedProviderCredentials: async (auth) => {
        calls.push(['seed', auth]);
        return { provider: auth.provider, authenticated: true };
      },
      transfer: async ({ provider }) => {
        calls.push(['transfer', provider]);
        return { id: 'cloud-1', status: 'queued', stateVersion: 1 };
      },
      watchSession: async () => {},
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
    collectProviderAuth: (provider) => collectProviderAuth(provider, {
      vault: memoryVault(),
      homeDir: path.join(directory, 'missing-home'),
      cliRoot: path.join(directory, 'missing-cli'),
      env: { OPENAI_API_KEY: 'sk-proj-codex' },
    }),
  });
  t.after(() => coordinator.stop());
  await coordinator.transfer(cloudStartTransfer({
    startId: 'startseed',
    threadId: 'thread-1',
    documentId: 'document-1',
    document: { fileName: 'source.hwpx', bytes: new Uint8Array(Buffer.from('document')) },
    agent: 'codex',
    model: 'gpt-5.6',
    effort: 'high',
    workflow: 'direct',
    references: [],
  }), { originSessionId: 'desktop-1' });
  assert.deepEqual(calls, [
    ['seed', { provider: 'codex', apiKey: 'sk-proj-codex', files: [] }],
    ['transfer', 'codex'],
  ]);
});

test('a PUT-only sandbox falls through from seed to transfer-time auth import', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-old-image-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const calls = [];
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      seedProviderCredentials: async () => {
        calls.push(['seed']);
        const error = new Error('Endpoint was not found');
        error.status = 404;
        error.code = 'NOT_FOUND';
        throw error;
      },
      transfer: async ({ providerAuth }) => {
        calls.push(['transfer', providerAuth]);
        return { id: 'cloud-put-only', status: 'queued', stateVersion: 1 };
      },
      watchSession: async () => {},
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
    collectProviderAuth: async (provider) => ({
      provider,
      apiKey: null,
      files: [{ path: '.codex/auth.json', content: '{"token":"oauth"}' }],
    }),
    collectImportedAuth: async () => null,
  });
  t.after(() => coordinator.stop());
  const transferred = await coordinator.transfer(cloudStartTransfer({
    startId: 'startput1',
    threadId: 'thread-1',
    documentId: 'document-1',
    document: { fileName: 'source.hwpx', bytes: new Uint8Array(Buffer.from('document')) },
    agent: 'codex',
    model: 'gpt-5.6',
    effort: 'high',
    workflow: 'direct',
    references: [],
  }), { originSessionId: 'desktop-1' });
  assert.equal(transferred.session.sessionId, 'cloud-put-only');
  assert.deepEqual(calls, [
    ['seed'],
    ['transfer', {
      secrets: {},
      files: { '.codex/auth.json': '{"token":"oauth"}' },
    }],
  ]);
});

test('AUTH_REQUIRED fails the transfer once instead of retrying five times', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rauhwpx-cloud-auth-required-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-1',
    threadId: 'thread-1',
    documentId: 'document-1',
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    timeline: {
      schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: new Date().toISOString(),
      thread: {
        id: 'thread-1', title: 'Task', createdAt: Date.now(), updatedAt: Date.now(),
        agent: 'codex', model: 'gpt-5.6', effort: 'high', messages: [],
      },
    },
    provider: 'codex',
    limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  let transfers = 0;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      isPaired: async () => false,
      transfer: async () => {
        transfers += 1;
        const error = new Error('codex must be authenticated on this VPS');
        error.code = 'AUTH_REQUIRED';
        throw error;
      },
    },
    store,
    provisioner: {},
    recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(() => coordinator.stop());
  await coordinator.start();
  let record = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    record = await store.get(created.id);
    if (record.state === 'failed') break;
    await delay(10);
  }
  assert.equal(record.state, 'failed');
  assert.match(record.error, /must be authenticated on this VPS/);
  assert.doesNotMatch(record.error, /failed 5 times/);
  assert.equal(transfers, 1);
});

test('slow checkpoint mirroring lets later events through and preserves the newer pending revision', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'raucloud-async-checkpoint-'));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const original = Buffer.from('original');
  const originPath = path.join(directory, 'document.hwpx');
  await writeFile(originPath, original);
  const created = await store.create({
    sessionId: 'desktop-async', threadId: 'thread-async', documentId: 'document-async', originPath,
    documentName: 'document.hwpx', documentBytes: original, timeline: null, provider: 'codex', limits: { maxTurns: 10 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-async', serverVersion: 1 });
  const ready = Promise.withResolvers();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let deliver;
  const downloads = [];
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null, isPaired: async () => false,
      watchSession: async (_id, _after, { signal, onEvent }) => {
        deliver = onEvent;
        ready.resolve();
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      downloadCheckpoint: async (_id, { operationId }) => {
        downloads.push(operationId);
        if (operationId === 'revision-1') { started.resolve(); await release.promise; }
        const bytes = Buffer.from(operationId);
        return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
          boundaryOperation: operationId, revision: operationId === 'revision-1' ? 1 : 2, turn: 0 };
      },
    }, store, provisioner: {}, recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => { release.resolve(); await coordinator.stop(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
  await coordinator.start();
  await ready.promise;
  await deliver({ sequence: 2, type: 'boundary.committed', payload: { kind: 'operation', operationId: 'revision-1', turnNumber: 0, revision: 1 } });
  await started.promise;
  await deliver({ sequence: 3, type: 'boundary.committed', payload: { kind: 'operation', operationId: 'revision-2', turnNumber: 0, revision: 2 } });
  await deliver({ sequence: 4, type: 'agent.event', payload: { text: 'arrives during download' } });
  assert.equal((await store.get(created.id)).lastEventSequence, 4);
  assert.equal((await store.get(created.id)).pendingTurnBoundary.operationId, 'revision-2');
  release.resolve();
  for (let index = 0; index < 200; index++) {
    if ((await store.get(created.id)).lastSyncedBoundaryOperation === 'revision-2') break;
    await delay(5);
  }
  assert.equal((await store.get(created.id)).pendingTurnBoundary, null);
  assert.equal(await readFile(originPath, 'utf8'), original.toString());
  assert.deepEqual(downloads, ['revision-1', 'revision-2']);
});

async function publicationFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'raucloud-publication-'));
  const originPath = path.join(directory, 'original.hwpx');
  await writeFile(originPath, 'original');
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'desktop-publish', threadId: 'thread-publish', documentId: 'document-publish',
    originPath, documentName: 'original.hwpx', documentBytes: Buffer.from('original'),
    timeline: null, provider: 'codex', limits: { maxTurns: 10 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'running', { cloudSessionId: 'cloud-publish', serverVersion: 1 });
  const ready = Promise.withResolvers();
  let deliver;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null, isPaired: async () => false,
      downloadCheckpoint: async (_id, { operationId }) => {
        const revision = operationId === 'turn-1' ? 1 : 2;
        const bytes = Buffer.from(`cloud revision ${revision}`);
        return { bytes, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
          name: 'original.hwpx', boundaryOperation: operationId ?? 'turn-2', boundaryKind: 'turn', revision, turn: revision };
      },
      watchSession: async (_id, _after, { onEvent, signal }) => {
        deliver = onEvent;
        ready.resolve();
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    }, store, provisioner: {}, recoveryDir: path.join(directory, 'recovery'),
  });
  t.after(async () => { await coordinator.stop(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
  await coordinator.start();
  await ready.promise;
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      const record = await store.get(created.id);
      if (predicate(record)) return record;
      await delay(5);
    }
    assert.fail('publication did not settle');
  };
  return { coordinator, store, id: created.id, originPath, deliver, waitFor };
}

test('an explicit agent publication updates once and later turns keep the cloud conversation running', async (t) => {
  const fixture = await publicationFixture(t);
  await fixture.deliver({ sequence: 1, type: 'document.publish_requested', payload: { operationId: 'turn-1' } });
  await fixture.waitFor((record) => record.lastPublishedRevision === 1 && record.pendingOriginPublications.length === 0);
  assert.equal(await readFile(fixture.originPath, 'utf8'), 'cloud revision 1');
  await fixture.deliver({ sequence: 2, type: 'boundary.committed', payload: { kind: 'turn', operationId: 'turn-2', revision: 2, turnNumber: 2 } });
  const archived = await fixture.waitFor((record) => record.lastSyncedRevision === 2);
  assert.equal(archived.state, 'running');
  assert.equal(await readFile(fixture.originPath, 'utf8'), 'cloud revision 1');
  await fixture.coordinator.publishCheckpoint({ sessionId: 'cloud-publish', operationId: 'turn-2' });
  await fixture.deliver({ sequence: 3, type: 'document.publish_requested', payload: { operationId: 'turn-1' } });
  const replayed = await fixture.waitFor((record) => record.pendingOriginPublications.length === 0);
  assert.equal(replayed.lastPublishedRevision, 2);
  assert.equal(replayed.state, 'running');
  assert.equal(await readFile(fixture.originPath, 'utf8'), 'cloud revision 2');
});

test('publication preserves an externally edited origin without ending or taking over the cloud session', async (t) => {
  const fixture = await publicationFixture(t);
  await writeFile(fixture.originPath, 'external edit');
  const published = await fixture.coordinator.publishCheckpoint({ sessionId: 'cloud-publish', operationId: 'turn-1' });
  assert.equal(published.publication, 'conflict');
  assert.equal(await readFile(fixture.originPath, 'utf8'), 'external edit');
  assert.equal(await readFile(path.join(path.dirname(fixture.originPath), published.preservedCopyName), 'utf8'), 'cloud revision 1');
  assert.equal((await fixture.store.get(fixture.id)).state, 'running');
  const again = await fixture.coordinator.publishCheckpoint({ sessionId: 'cloud-publish', operationId: 'turn-1' });
  assert.equal(again.publication, 'conflict');
});

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { CloudClient } from '../desktop/cloud-client.mjs';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';
import { CloudConversationRecovery } from '../desktop/cloud-conversation-recovery.mjs';
import { CloudHandoffStore, sha256Hex } from '../desktop/cloud-handoff.mjs';
import { createRaucloudBrokerClient } from '../desktop/cloud-broker.mjs';
import { AuthService } from '../cloud/src/auth.mjs';
import { BlobStore } from '../cloud/src/blob-store.mjs';
import { ConversationBackup } from '../cloud/src/conversation-backup.mjs';
import { openDatabase } from '../cloud/src/database.mjs';
import { createCloudHttpHandler } from '../cloud/src/http-server.mjs';
import { RaucloudLeaseController } from '../cloud/src/raucloud-lease.mjs';
import { SessionStore } from '../cloud/src/session-store.mjs';
import { WorkerClient } from '../cloud/worker/client.mjs';
import { createRauCreditsClient } from '../rhwp/rhwp-agent/rau-credits-client.mjs';
import { createCreditsService, creditsRequestListener } from '../rhwp/rau-credits/service.mjs';
import { createFileMergeStore } from '../rhwp/rau-credits/merge-artifacts.mjs';
import { createMemoryStore } from '../rhwp/rau-credits/store.mjs';

const SESSION_ID = 'start_cloud_acceptance';
const ACCOUNT_TOKEN = `rau_account_v1_${'a'.repeat(43)}`;
const DOCUMENT = Buffer.from('document before cloud edit');

function memoryVault() {
  const values = new Map();
  return { get: async (key) => values.get(key) ?? null,
    set: async (key, value) => values.set(key, value), delete: async (key) => values.delete(key) };
}

function transferPayload() {
  const now = Date.now();
  return { startId: SESSION_ID, threadId: 'thread-1', documentId: 'document-1',
    agent: 'codex', model: 'gpt-5.6', effort: 'high', workflow: 'direct',
    initialMessage: { id: 'message-initial', text: 'Edit the document', attachmentReferenceIds: [] },
    document: { fileName: 'document.hwpx', bytes: DOCUMENT }, references: [],
    timeline: { schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: new Date(now).toISOString(),
      thread: { id: 'thread-1', cloudStartId: SESSION_ID, title: 'Cloud acceptance',
        createdAt: now, updatedAt: now, agent: 'codex', model: 'gpt-5.6', effort: 'high',
        messages: [{ messageId: 'message-initial', role: 'user', text: 'Edit the document' }] } } };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function eventually(read, predicate, label) {
  const deadline = Date.now() + 5_000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

// The broker and worker use their production HTTP handlers and encrypted file
// store. Only local port routing and deterministic network failures are injected.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rau-seamless-http-'));
  const state = createMemoryStore({ users: {}, sessions: {}, accessTokens: {}, accountSessions: {
    [createHash('sha256').update(ACCOUNT_TOKEN).digest('base64url')]: {
      status: 'active', workosUserId: 'user_test',
    },
  }, raucloud: { accounts: {}, runs: {}, idempotency: {} } });
  let brokerServer;
  let brokerUrl;
  let brokerOffline = false;
  let spawnAttempts = 0;
  const workers = [];
  const coordinators = [];
  const handoffPath = path.join(root, 'desktop', 'handoffs.json');
  const recoveryDir = path.join(root, 'desktop', 'results');
  const store = new CloudHandoffStore({ filePath: handoffPath });
  async function launchBroker() {
    await close(brokerServer);
    const service = createCreditsService({ sessionSecret: 'integration-only-secret', origin: 'http://localhost',
      store: state, mergeArtifactStore: createFileMergeStore(path.join(root, 'broker')) });
    const handler = creditsRequestListener(service);
    brokerServer = http.createServer((request, response) => {
      if (brokerOffline) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'TEST_BROKER_UNAVAILABLE' }));
      } else handler(request, response);
    });
    brokerUrl = await listen(brokerServer);
  }
  await launchBroker();
  function brokerClient() {
    const credits = createRauCreditsClient({ baseUrl: brokerUrl });
    return createRaucloudBrokerClient({ baseUrl: brokerUrl,
      getDeviceIdentity: async () => ({ id: 'desktop-1' }),
      authorizeOwnedBackend: (request, options) => credits.authorizeOwnedBackend(ACCOUNT_TOKEN, request, options) });
  }
  async function launchWorker({ durable = true } = {}) {
    await brokerClient().status();
    const index = workers.length + 1;
    const workerToken = `integration-worker-${index}`;
    const workerTokenHash = sha256Hex(Buffer.from(workerToken));
    const runId = `run-${index}`;
    await state.mutate((data) => {
      data.raucloud.accounts.user_test = { ...data.raucloud.accounts.user_test, worker: {
        id: `worker-${index}`, runId, workerTokenHash, status: 'active', ownerDeviceId: 'desktop-1',
      } };
      data.raucloud.runs[runId] = { id: runId, accountId: 'user_test', workerId: `worker-${index}`,
        workerTokenHash, ownerDeviceId: 'desktop-1', status: 'active' };
    });
    const workerRoot = path.join(root, `worker-${index}`);
    const database = openDatabase(path.join(workerRoot, 'cloud.sqlite'));
    const blobStore = new BlobStore(database, { root: path.join(workerRoot, 'objects') });
    const auth = new AuthService(database);
    const sessionStore = new SessionStore(database, blobStore);
    sessionStore.setProviderStatus('codex', { available: true, authenticated: true, version: '1' });
    const keys = generateKeyPairSync('ed25519');
    const encoded = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const identity = { privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      serverPublicKey: `ed25519:${encoded}`, serverId: sha256Hex(Buffer.from(encoded)).slice(0, 24) };
    const lease = new RaucloudLeaseController({ baseUrl: brokerUrl, runId, workerToken });
    const backup = new ConversationBackup({ sessionStore, blobStore, lease });
    const services = { auth, blobStore, sessionStore, identity,
      config: { basePath: '/rauhwpx-cloud', maxRunningSessions: 2, maxQueuedSessions: 20, browserOrigins: [] },
      logger: { error() {} }, vault: { list: () => [], get: () => null }, raucloudLease: lease,
      conversationBackup: durable ? backup : null };
    const server = http.createServer(createCloudHttpHandler(services));
    const controlServer = http.createServer(createCloudHttpHandler(services, { workerOnly: true }));
    const base = await listen(server);
    const controlBase = await listen(controlServer);
    let droppedActivation = false;
    const worker = { auth, database, blobStore, sessionStore, backup, lease, server, runId, base,
      endpoint: `https://worker-${index}.test/rauhwpx-cloud`, serverPublicKey: identity.serverPublicKey,
      failActivationBackup: false, failQueuedBackup: false,
      dropActivationResponse: false, dropQueuedResponse: false, uploadStarts: 0,
      async stop() { await close(server); await close(controlServer); },
      executionClient() {
        assert.equal(sessionStore.claimNextSession().id, SESSION_ID);
        const token = `integration-session-worker-${index}`;
        sessionStore.prepareWorker(SESSION_ID, token);
        return new WorkerClient({ baseUrl: controlBase, token, sessionId: SESSION_ID });
      },
      async client(vault = memoryVault()) {
        const client = new CloudClient({ vault, fetchImpl: async (url, options = {}) => {
          const target = new URL(url);
          const command = target.pathname.endsWith('/commands') ? JSON.parse(options.body) : null;
          if (target.pathname.endsWith('/uploads/init')) worker.uploadStarts += 1;
          if (command?.type === 'session.activate' && worker.failActivationBackup) brokerOffline = true;
          if (command?.type === 'message.queue' && worker.failQueuedBackup) brokerOffline = true;
          const routedWorker = workers.find((entry) => new URL(entry.endpoint).host === target.host);
          assert.ok(routedWorker, `Unknown local worker route: ${target.host}`);
          const response = await fetch(`${routedWorker.base}${target.pathname}${target.search}`, options);
          if (command?.type === 'session.activate' && worker.dropActivationResponse && !droppedActivation && response.ok) {
            droppedActivation = true;
            await response.arrayBuffer();
            throw new TypeError('fetch failed');
          }
          if (command?.type === 'message.queue' && worker.dropQueuedResponse && response.ok) {
            await response.arrayBuffer();
            throw new TypeError('fetch failed');
          }
          return response;
        } });
        await client.redeemPairingCode(auth.createPairingCode().code, 'Acceptance laptop', {
          profile: { mode: 'app-hosted', endpoint: `https://worker-${index}.test/rauhwpx-cloud`,
            serverPublicKey: identity.serverPublicKey, sandbox: { providerId: 'raucloud', sandboxId: runId } },
        });
        return client;
      } };
    workers.push(worker);
    return worker;
  }
  function coordinator(client, localStore = store, overrides = {}) {
    const broker = brokerClient();
    const provider = { ...broker, id: 'raucloud', displayName: 'Raucloud',
      configuration: () => ({ configured: true }),
      spawn() { spawnAttempts += 1; throw new Error('A completed result must not allocate a worker'); },
      status: async () => ({ lifecycle: 'idle', status: 'idle' }), teardown() {},
      accountStatus: async () => ({ signedIn: true }), getLocalCacheIdentity: async () => 'integration-account',
      ...overrides };
    const value = new CloudCoordinator({ client, store: localStore, recoveryDir, appServers: [provider] });
    coordinators.push(value);
    return value;
  }
  t.after(async () => {
    for (const coordinator of coordinators) await coordinator.stop();
    for (const worker of workers) { await worker.stop(); worker.database.close(); }
    await close(brokerServer);
    await rm(root, { recursive: true, force: true });
  });
  return { root, state, store, handoffPath, recoveryDir, launchBroker, launchWorker, brokerClient, coordinator,
    spawnAttempts: () => spawnAttempts,
    setBrokerOffline(value) { brokerOffline = value; } };
}

test('send acknowledgment survives laptop closure, worker replacement and repeated queued-message delivery', async (t) => {
  const f = await fixture(t);
  const first = await f.launchWorker();
  first.dropActivationResponse = true;
  const firstClient = await first.client();
  const laptop = f.coordinator(firstClient);
  await laptop.transfer(transferPayload(), { originSessionId: 'local-1' });
  const handoff = await f.store.get(SESSION_ID);
  assert.ok(Number.isFinite(Date.parse(handoff.handoffAcceptedAt)));
  assert.equal(first.database.prepare('SELECT COUNT(*) AS n FROM commands WHERE id = ?').get(`activate_${SESSION_ID}`).n, 1);
  await laptop.stop();
  const sender = f.coordinator(firstClient, f.store, { status: async () => ({ lifecycle: 'ready' }) });
  const bytes = Buffer.from('Reference for the follow-up');
  const followup = { sessionId: SESSION_ID, command: 'queue-message', messageId: 'followup-1',
    message: 'Also update the title', attachments: [{ id: 'reference-followup-1', name: 'reference.txt',
      mimeType: 'text/plain', size: bytes.length, bytes }] };
  first.dropQueuedResponse = true;
  await assert.rejects(sender.command(followup), { code: 'MESSAGE_DELIVERY_UNCERTAIN' });
  const pending = (await f.store.get(SESSION_ID)).queuedMessages.find((message) => message.id === followup.messageId);
  assert.equal(pending.retryPending, true);
  const uploads = first.uploadStarts;
  const accepted = JSON.parse(first.database.prepare('SELECT response_json FROM commands WHERE id = ?').get(pending.commandId).response_json);
  await sender.stop();
  await first.stop();
  await f.launchBroker();
  let second;
  let allocated = 0;
  first.dropQueuedResponse = false;
  const returned = f.coordinator(firstClient, f.store, {
    status: async (sandbox) => ({ lifecycle: sandbox.sandboxId === second?.runId ? 'ready' : 'idle' }),
    async spawn({ selectedProvider }) {
    allocated += 1;
    assert.equal(selectedProvider, 'codex');
    second = await f.launchWorker();
    return { sandbox: { providerId: 'raucloud', sandboxId: second.runId },
      receipt: { endpoint: second.endpoint, serverPublicKey: second.serverPublicKey,
        pairingCode: second.auth.createPairingCode().code } };
  } });
  const discovery = new CloudConversationRecovery({ store: f.store, provider: () => f.brokerClient() });
  const conversations = await discovery.refresh();
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].sessionId, SESSION_ID);
  assert.ok(Number.isFinite(Date.parse(conversations[0].expiresAt)));
  await returned.reconcileContinuity({ reason: 'wake' });
  assert.equal(allocated, 1);
  assert.equal(second.sessionStore.getSessionRow(SESSION_ID).status, 'queued');
  assert.equal((await f.store.get(SESSION_ID)).destination.endpoint, second.endpoint);
  assert.deepEqual(await firstClient.command(SESSION_ID, 'message.queue', pending.commandPayload, pending.commandId), accepted);
  await returned.command(followup);
  assert.equal(first.uploadStarts, uploads, 'an accepted attachment retry must not re-upload or allocate another message');
  assert.equal(allocated, 1);
  assert.equal(second.database.prepare('SELECT COUNT(*) AS n FROM session_messages WHERE id = ?').get('followup-1').n, 1);
  const session = second.sessionStore.getSessionRow(SESSION_ID);
  const { stream } = second.blobStore.openReadStream(session.origin_sha256);
  const parts = [];
  for await (const part of stream) parts.push(part);
  assert.deepEqual(Buffer.concat(parts), DOCUMENT);
  first.lease.baseUrl = second.lease.baseUrl;
  await assert.rejects(first.backup.save(SESSION_ID), /worker|assign|lease|authoriz/i);
});

test('Cloud does not acknowledge acceptance while the broker cannot retain activation', async (t) => {
  const f = await fixture(t);
  const worker = await f.launchWorker();
  const client = await worker.client();
  await worker.lease.discover();
  worker.lease.brokerGraceMs = 0;
  worker.failActivationBackup = true;
  let acknowledged = false;
  const payload = transferPayload();
  const transfer = () => client.transfer({ sessionId: SESSION_ID, threadId: payload.threadId,
    documentId: payload.documentId, provider: payload.agent, goal: payload.initialMessage.text,
    documentName: payload.document.fileName, documentBytes: payload.document.bytes, timeline: payload.timeline,
    persistent: true, onSessionActivated: () => { acknowledged = true; } });
  await assert.rejects(transfer());
  assert.equal(acknowledged, false);
  worker.failActivationBackup = false;
  f.setBrokerOffline(false);
  await transfer();
  assert.equal(acknowledged, true);
  assert.equal(worker.database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  assert.equal((await f.brokerClient().listConversations()).conversations[0].state, 'queued');
});

test('an older managed v2 worker cannot receive the durable handoff badge', async (t) => {
  const f = await fixture(t);
  const worker = await f.launchWorker({ durable: false });
  const laptop = f.coordinator(await worker.client());
  await assert.rejects(laptop.transfer(transferPayload(), { originSessionId: 'local-1' }),
    { code: 'CLOUD_RUNTIME_OUTDATED' });
  assert.equal((await f.store.get(SESSION_ID)).handoffAcceptedAt, undefined);
  assert.equal(worker.database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('a queued progress event cannot replace the durable follow-up receipt', async (t) => {
  const f = await fixture(t);
  const first = await f.launchWorker();
  const client = await first.client();
  const laptop = f.coordinator(client, f.store, { status: async () => ({ lifecycle: 'ready' }) });
  await laptop.transfer(transferPayload(), { originSessionId: 'local-1' });
  await first.lease.discover();
  first.lease.brokerGraceMs = 0;
  first.failQueuedBackup = true;
  const followup = { sessionId: SESSION_ID, command: 'queue-message',
    messageId: 'followup-provisional', message: 'Keep this queued message through replacement' };
  await assert.rejects(laptop.command(followup));
  await eventually(() => f.store.get(SESSION_ID),
    (record) => record.lastEventSequence >= 3, 'the provisional queued event was not received');
  const pending = (await f.store.get(SESSION_ID)).queuedMessages.find((entry) => entry.id === followup.messageId);
  assert.equal(pending.retryPending, true, 'progress cannot certify broker durability');
  await laptop.stop();
  await first.stop();
  f.setBrokerOffline(false);
  first.failQueuedBackup = false;
  await f.launchBroker();
  let second;
  const returned = f.coordinator(client, f.store, {
    status: async (sandbox) => ({ lifecycle: sandbox.sandboxId === second?.runId ? 'ready' : 'idle' }),
    async spawn() {
      second = await f.launchWorker();
      return { sandbox: { providerId: 'raucloud', sandboxId: second.runId },
        receipt: { endpoint: second.endpoint, serverPublicKey: second.serverPublicKey,
          pairingCode: second.auth.createPairingCode().code } };
    },
  });
  await returned.reconcileContinuity({ reason: 'wake' });
  await returned.command(followup);
  assert.equal(second.database.prepare('SELECT COUNT(*) AS n FROM session_messages WHERE id = ?')
    .get(followup.messageId).n, 1);
  assert.equal((await f.store.get(SESSION_ID)).queuedMessages.find((entry) => entry.id === followup.messageId).retryPending, false);
});

test('returning downloads completed work in the background and reopening offline serves verified local bytes', async (t) => {
  const f = await fixture(t);
  const worker = await f.launchWorker();
  const desktopClient = await worker.client();
  const laptop = f.coordinator(desktopClient);
  await laptop.transfer(transferPayload(), { originSessionId: 'local-1' });
  await laptop.stop();
  const result = Buffer.alloc(512 * 1024 + 37, 59);
  const execution = worker.executionClient();
  await execution.beginTurn({ turnNumber: 1, mode: 'direct' });
  const resultPath = path.join(f.root, 'result.hwpx');
  const timelinePath = path.join(f.root, 'timeline.json');
  const timeline = transferPayload().timeline;
  timeline.thread.messages.push({ role: 'assistant', text: 'The document is updated.' });
  await writeFile(resultPath, result);
  await writeFile(timelinePath, JSON.stringify(timeline));
  const checkpoint = await execution.upload(resultPath, { name: 'document.hwpx', kind: 'document' });
  const savedTimeline = await execution.upload(timelinePath, { name: 'timeline.json', kind: 'timeline' });
  await execution.commitBoundary({ operationId: 'turn-completed', turnNumber: 1, revision: 2, kind: 'turn',
    checkpoint: { blobId: checkpoint.id, size: result.length },
    timeline: { blobId: savedTimeline.id, size: Buffer.byteLength(JSON.stringify(timeline)) } });
  await execution.completeTurn({ outcome: 'completed', boundaryOperationId: 'turn-completed' });
  await eventually(() => f.state.load(), (data) => data.raucloud.runs[worker.runId].status === 'ready',
    'the completed turn did not release active allowance');
  const conversation = (await f.brokerClient().listConversations()).conversations[0];
  assert.equal(conversation.pendingWork, false);
  await worker.stop();
  await f.state.mutate((data) => { data.raucloud.accounts = {}; data.raucloud.runs = {}; });
  await f.launchBroker();
  const returned = f.coordinator(desktopClient);
  await returned.reconcileContinuity({ reason: 'wake' });
  assert.equal(f.spawnAttempts(), 0);
  const saved = await eventually(() => f.store.get(SESSION_ID),
    (handoff) => handoff.mergeArchives?.some((item) => item.cachePath), 'completed work was not downloaded automatically');
  const receipt = saved.mergeArchives.find((item) => item.operationId === 'turn-completed');
  assert.deepEqual(await readFile(receipt.cachePath), result);
  await returned.stop();
  f.setBrokerOffline(true);
  const reopened = f.coordinator({ loadProfile: async () => null }, new CloudHandoffStore({ filePath: f.handoffPath }));
  const snapshot = await reopened.refresh({ documentId: 'document-1' });
  assert.equal(snapshot.mergeRequests[0].localAvailable, true);
  const downloaded = await reopened.downloadCheckpoint({ sessionId: SESSION_ID, operationId: 'turn-completed' });
  assert.deepEqual(Buffer.from(downloaded.bytes), result);
});

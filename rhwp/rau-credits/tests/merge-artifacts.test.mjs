import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCreditsService, creditsRequestListener } from '../service.mjs';
import { createMemoryStore } from '../store.mjs';
import { createRaucloudBroker } from '../cloud-broker.mjs';
import { createMergeArtifacts, createMemoryMergeStore, createFileMergeStore, createPostgresMergeStore,
  MERGE_CHUNK_BYTES, MERGE_RETENTION_MS } from '../merge-artifacts.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const secret = 'test-checkpoint-secret';
function input(bytes, index = 0, overrides = {}) {
  return { sessionId: 'session-1', documentId: 'document-1', threadId: 'thread-1', cloudStartId: 'start-1',
    operationId: 'operation-1', revision: 2, turn: 1, kind: 'turn', fileName: 'document.hwpx',
    sha256: sha(bytes), size: bytes.length, chunkCount: Math.ceil(bytes.length / MERGE_CHUNK_BYTES),
    chunkIndex: index, bytesBase64: bytes.subarray(index * MERGE_CHUNK_BYTES, (index + 1) * MERGE_CHUNK_BYTES).toString('base64'), ...overrides };
}

for (const backend of ['memory', 'file', ...(process.env.RAU_TEST_POSTGRES_URL ? ['postgres'] : [])]) {
  test(`${backend}: conversation generations, resource retention and tombstones survive reconstruction`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rau-conversation-artifacts-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = backend === 'memory' ? createMemoryMergeStore() : backend === 'file' ? createFileMergeStore(directory)
      : await createPostgresMergeStore({ connectionString: process.env.RAU_TEST_POSTGRES_URL });
    t.after(() => store.close?.());
    let clock = Date.now();
    const options = { store, sessionSecret: secret, now: () => clock };
    const snapshots = createMergeArtifacts({ ...options, kind: 'conversation' });
    const resources = createMergeArtifacts({ ...options, kind: 'conversation-resource' });
    const documents = createMergeArtifacts(options);
    const account = `conversation-${randomBytes(8).toString('hex')}`;
    const resource = Buffer.from('private document bytes');
    const resourceInput = input(resource, 0, { kind: 'conversation-resource' });
    const savedResource = await resources.upload(account, 'run-1', resourceInput);
    const descriptor = (generation, state = 'queued') => input(Buffer.from(JSON.stringify({ generation, state })), 0,
      { kind: 'conversation', state, revision: generation, operationId: `generation-${generation}`,
        retentionUntil: savedResource.mergeRequest.expiresAt });
    const old = await snapshots.upload(account, 'run-1', descriptor(1));
    const latest = await snapshots.upload(account, 'run-1', descriptor(2));
    await assert.rejects(snapshots.upload(account, 'run-1', descriptor(1)), { code: 'CLOUD_CONVERSATION_STALE' });
    await assert.rejects(snapshots.chunk(account, old.mergeRequest.id, 0), { code: 'CLOUD_MERGE_NOT_FOUND' });
    assert.deepEqual((await snapshots.list(account)).mergeRequests.map((item) => item.id), [latest.mergeRequest.id]);
    assert.deepEqual((await documents.list(account)).mergeRequests, []);
    await assert.rejects(snapshots.chunk('another-account', latest.mergeRequest.id, 0), { code: 'CLOUD_MERGE_NOT_FOUND' });
    await assert.rejects(snapshots.chunk(account, savedResource.mergeRequest.id, 0), { code: 'CLOUD_MERGE_NOT_FOUND' });
    clock += 24 * 60 * 60_000;
    const renewed = await resources.upload(account, 'run-2', resourceInput);
    assert.equal(renewed.mergeRequest.id, savedResource.mergeRequest.id);
    assert.equal(renewed.mergeRequest.expiresAt, clock + MERGE_RETENTION_MS);
    const tombstone = await snapshots.upload(account, 'run-2', descriptor(3, 'purged'));
    await assert.rejects(resources.chunk(account, savedResource.mergeRequest.id, 0), { code: 'CLOUD_MERGE_NOT_FOUND' });
    const reopened = createMergeArtifacts({ ...options, kind: 'conversation' });
    assert.equal((await reopened.list(account)).mergeRequests[0].state, 'purged');
    assert.equal((await reopened.list(account)).mergeRequests[0].id, tombstone.mergeRequest.id);
    await assert.rejects(reopened.upload(account, 'run-3', descriptor(4)), { code: 'CLOUD_CONVERSATION_STALE' });
  });
}

test('conversation writes hold the worker assignment fence until their durable receipt', async () => {
  const token = 'worker-scoped-token';
  const state = createMemoryStore({ raucloud: { accounts: { account: { worker: {
    id: 'worker', runId: 'run', workerTokenHash: sha(token), status: 'active',
  } } }, runs: { run: { id: 'run', accountId: 'account', workerId: 'worker', workerTokenHash: sha(token), status: 'active' } } } });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let writes = 0;
  const broker = createRaucloudBroker({ store: state, mutate: (task) => state.mutate(task),
    authenticateAccessToken: async () => 'account', conversationArtifacts: {
      async upload(accountId) { writes++; assert.equal(accountId, 'account'); entered.resolve(); await release.promise; return { complete: true }; },
    } });
  const upload = broker.uploadCloudConversation(token, 'run', { kind: 'conversation' });
  await entered.promise;
  let replaced = false;
  const replace = state.mutate((value) => { value.raucloud.accounts.account.worker = null; replaced = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replaced, false);
  release.resolve();
  assert.equal((await upload).complete, true);
  await replace;
  await assert.rejects(broker.uploadCloudConversation(token, 'run', { kind: 'conversation' }), { code: 'CLOUD_WORKER_UNAUTHORIZED' });
  assert.equal(writes, 1);
});

for (const backend of ['memory', 'file', ...(process.env.RAU_TEST_POSTGRES_URL ? ['postgres'] : [])]) {
  test(`${backend}: chunks survive reconstruction, publish atomically, and reject conflicting retries`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rau-merge-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let store = backend === 'memory' ? createMemoryMergeStore() : backend === 'file' ? createFileMergeStore(directory)
      : await createPostgresMergeStore({ connectionString: process.env.RAU_TEST_POSTGRES_URL });
    let clock = Date.now();
    const options = { sessionSecret: secret, now: () => clock };
    let api = createMergeArtifacts({ ...options, store });
    const account = `account-${randomBytes(8).toString('hex')}`;
    const bytes = randomBytes(MERGE_CHUNK_BYTES + 901);
    const first = await api.upload(account, 'run-1', input(bytes));
    assert.equal(first.complete, false);
    assert.deepEqual((await api.list(account, 'session-1')).mergeRequests, []);
    await assert.rejects(api.chunk(account, first.mergeRequest.id, 0), { code: 'CLOUD_MERGE_NOT_FOUND' });
    // Simulate a broker restart between chunks; production reopens PostgreSQL.
    if (backend === 'file') store = createFileMergeStore(directory);
    if (backend === 'postgres') { await store.close(); store = await createPostgresMergeStore({ connectionString: process.env.RAU_TEST_POSTGRES_URL }); }
    t.after(() => store.close?.());
    api = createMergeArtifacts({ ...options, store });
    const final = await api.upload(account, 'run-2', input(bytes, 1));
    assert.equal(final.complete, true);
    assert.equal(final.mergeRequest.id, first.mergeRequest.id);
    assert.equal(final.mergeRequest.runId, 'run-1');
    const downloaded = await Promise.all([0, 1].map(async (index) => Buffer.from((await api.chunk(account, final.mergeRequest.id, index)).bytesBase64, 'base64')));
    assert.deepEqual(Buffer.concat(downloaded), bytes);
    const retries = await Promise.all([api.upload(account, 'run-2', input(bytes, 0)), api.upload(account, 'run-2', input(bytes, 1))]);
    assert(retries.every((receipt) => receipt.complete && receipt.mergeRequest.id === first.mergeRequest.id));
    assert.equal((await api.list(account, 'session-1')).mergeRequests.length, 1);
    assert.deepEqual((await api.list('different-account', 'session-1')).mergeRequests, []);
    await assert.rejects(api.chunk('different-account', final.mergeRequest.id, 0), { code: 'CLOUD_MERGE_NOT_FOUND' });
    await assert.rejects(api.upload(account, 'run-2', input(bytes, 0, { revision: 3 })), { code: 'CLOUD_MERGE_CONFLICT' });
    const wrong = Buffer.from(bytes); wrong[0] ^= 1;
    await assert.rejects(api.upload(account, 'run-2', input(wrong, 0, { sha256: sha(bytes) })), { code: 'CLOUD_MERGE_CONFLICT' });
    const wrongKey = createMergeArtifacts({ ...options, store, sessionSecret: 'wrong-key' });
    await assert.rejects(wrongKey.chunk(account, final.mergeRequest.id, 0));
    if (backend === 'file') {
      const encrypted = await fs.readFile(path.join(directory, sha(account), `${final.mergeRequest.id}.0.enc`));
      assert.equal(encrypted.includes(bytes.subarray(0, 64)), false);
    }
    clock += MERGE_RETENTION_MS + 1;
    assert.deepEqual((await api.list(account, 'session-1')).mergeRequests, []);
    await assert.rejects(api.chunk(account, final.mergeRequest.id, 0), { code: 'CLOUD_MERGE_NOT_FOUND' });
    await api.cleanup();
    assert.equal((await api.upload(account, 'run-3', input(bytes))).complete, false);
  });
}

test('validation, digest verification, and storage quota reject without publishing partial checkpoints', async () => {
  const bytes = Buffer.from('checkpoint contents');
  const store = createMemoryMergeStore();
  const api = createMergeArtifacts({ store, sessionSecret: secret, accountBytes: bytes.length, accountCount: 1 });
  for (const overrides of [{ chunkCount: 2 }, { chunkIndex: 1 }, { size: -1 }, { bytesBase64: '!!!!' },
    { bytesBase64: `${bytes.toString('base64')}\n` }, { sha256: 'invalid' }, { fileName: '../bad.hwpx' }, { revision: 0.5 }, { revision: 0 }, { size: 128 * 1024 * 1024 + 1 }]) {
    await assert.rejects(api.upload('account', 'run', input(bytes, 0, overrides)), { code: 'CLOUD_INVALID_REQUEST' });
  }
  await assert.rejects(api.upload('account', 'run', input(bytes, 0, { sha256: '0'.repeat(64) })), { code: 'CLOUD_MERGE_DIGEST_MISMATCH' });
  assert.deepEqual((await api.list('account', 'session-1')).mergeRequests, []);
  await api.upload('account', 'run', input(bytes));
  await assert.rejects(api.upload('account', 'run', input(bytes, 0, { operationId: 'another' })), { code: 'CLOUD_MERGE_CAPACITY' });
});

test('HTTP account authentication retrieves a checkpoint after worker deletion and broker restart', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rau-merge-http-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const accountToken = `rau_account_v1_${'A'.repeat(43)}`;
  const otherToken = `rau_account_v1_${'B'.repeat(43)}`;
  const workerToken = 'scoped-worker-token';
  const stateStore = createMemoryStore({ users: {}, sessions: {}, accessTokens: {}, accountSessions: {
    [createHash('sha256').update(accountToken).digest('base64url')]: { status: 'active', workosUserId: 'user_1' },
    [createHash('sha256').update(otherToken).digest('base64url')]: { status: 'active', workosUserId: 'user_2' },
  }, raucloud: { runs: { 'run-1': { id: 'run-1', accountId: 'user_1', workerId: 'worker-1', workerTokenHash: sha(workerToken), status: 'active' },
    'run-other': { id: 'run-other', accountId: 'user_2', workerTokenHash: sha('other-worker'), status: 'active' } }, accounts: { user_1: { worker: { id: 'worker-1', runId: 'run-1', workerTokenHash: sha(workerToken), status: 'active' } } }, idempotency: {} } });
  async function start() {
    const service = createCreditsService({ origin: 'http://localhost', sessionSecret: secret, store: stateStore,
      mergeArtifactStore: createFileMergeStore(directory) });
    const server = http.createServer(creditsRequestListener(service));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, origin: `http://127.0.0.1:${server.address().port}` };
  }
  let running = await start();
  t.after(() => new Promise((resolve) => running.server.close(resolve)));
  const request = (route, token, body) => fetch(`${running.origin}${route}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const bytes = randomBytes(MERGE_CHUNK_BYTES + 14);
  const route = '/v1/internal/cloud/runs/run-1/merge-requests';
  assert.equal((await request(route, 'wrong-token', input(bytes))).status, 401);
  assert.equal((await request('/v1/internal/cloud/runs/run-other/merge-requests', workerToken, input(bytes))).status, 401);
  assert.equal((await request(route, workerToken, input(bytes))).status, 200);
  const final = await (await request(route, workerToken, input(bytes, 1))).json();
  assert.equal(final.complete, true);
  // Exact retries are valid on the current warm assignment.
  await stateStore.mutate((state) => {
    state.raucloud.runs['run-1'].status = 'ready';
    state.raucloud.accounts.user_1.worker.status = 'warm';
  });
  assert.equal((await (await request(route, workerToken, input(bytes, 1))).json()).complete, true);
  const live = await stateStore.load();
  for (const retire of [
    (state) => { state.raucloud.runs['run-1'].status = 'stopped'; },
    (state) => { state.raucloud.runs['run-1'].remoteDeletedAt = Date.now(); },
    (state) => { state.raucloud.runs['run-1'].teardownRequestedAt = Date.now(); },
    (state) => { state.raucloud.accounts.user_1.worker = null; },
    (state) => { state.raucloud.accounts.user_1.worker.workerTokenHash = sha('replacement'); },
    (state) => { state.raucloud.accounts.user_1.worker.id = 'replacement-worker'; },
  ]) {
    await stateStore.save(live);
    await stateStore.mutate(retire);
    for (const upload of [input(bytes, 1), input(bytes, 1, { revision: 99 }), input(bytes, 0, { operationId: 'injected' })]) {
      assert.equal((await request(route, workerToken, upload)).status, 401);
    }
  }
  // Warm worker reuse authenticates the new URL run, retaining the original receipt.
  await stateStore.save(live);
  await stateStore.mutate((state) => {
    state.raucloud.runs['run-2'] = { ...state.raucloud.runs['run-1'], id: 'run-2' };
    state.raucloud.accounts.user_1.worker.runId = 'run-2';
  });
  assert.equal((await request(route, workerToken, input(bytes, 1))).status, 401);
  const replay = await (await request('/v1/internal/cloud/runs/run-2/merge-requests', workerToken, input(bytes, 1))).json();
  assert.equal(replay.complete, true);
  assert.equal(replay.mergeRequest.id, final.mergeRequest.id);
  assert.equal(replay.mergeRequest.runId, 'run-1');
  await stateStore.mutate((state) => { delete state.raucloud.runs['run-1']; state.raucloud.accounts = {}; });
  await new Promise((resolve) => running.server.close(resolve));
  running = await start();
  const listRoute = '/v1/cloud/merge-requests?sessionId=session-1';
  assert.equal((await request(listRoute, 'bad-account-token')).status, 401);
  const listed = await (await request(listRoute, accountToken)).json();
  assert.equal(listed.accountId, 'user_1');
  assert.equal(listed.mergeRequests.length, 1);
  assert.equal((await (await request('/v1/cloud/merge-requests', accountToken)).json()).mergeRequests.length, 1);
  assert.equal((await request('/v1/cloud/merge-requests?sessionId=', accountToken)).status, 400);
  const chunkRoute = `/v1/cloud/merge-requests/${final.mergeRequest.id}/chunks/0`;
  assert.equal((await request(chunkRoute, otherToken)).status, 404);
  assert.deepEqual(Buffer.from((await (await request(chunkRoute, accountToken)).json()).bytesBase64, 'base64'), bytes.subarray(0, MERGE_CHUNK_BYTES));
});

if (process.env.RAU_TEST_POSTGRES_URL) test('postgres replicas serialize simultaneous completion and account capacity reservations', async (t) => {
  const stores = await Promise.all([0, 1].map(() => createPostgresMergeStore({ connectionString: process.env.RAU_TEST_POSTGRES_URL })));
  t.after(() => Promise.all(stores.map((store) => store.close())));
  const bytes = randomBytes(MERGE_CHUNK_BYTES + 50);
  const account = `replica-${randomBytes(8).toString('hex')}`;
  const apis = stores.map((store) => createMergeArtifacts({ store, sessionSecret: secret, accountBytes: bytes.length, accountCount: 1 }));
  const receipts = await Promise.all([
    apis[0].upload(account, 'run-1', input(bytes, 0)),
    apis[1].upload(account, 'run-1', input(bytes, 0)),
    apis[0].upload(account, 'run-1', input(bytes, 1)),
    apis[1].upload(account, 'run-1', input(bytes, 1)),
  ]);
  assert.equal(new Set(receipts.map((value) => value.mergeRequest.id)).size, 1);
  assert.equal((await apis[1].list(account, 'session-1')).mergeRequests.length, 1);
  const reconstructed = Buffer.concat(await Promise.all([0, 1].map(async (index) => Buffer.from((await apis[1].chunk(account, receipts[0].mergeRequest.id, index)).bytesBase64, 'base64'))));
  assert.deepEqual(reconstructed, bytes);
  const reservations = await Promise.allSettled(apis.map((api, i) => api.upload(`${account}-capacity`, 'run-1', input(bytes, 0, { operationId: `op-${i}` }))));
  assert.equal(reservations.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(reservations.find((value) => value.status === 'rejected').reason.code, 'CLOUD_MERGE_CAPACITY');
});

if (process.env.RAU_TEST_POSTGRES_URL) test('postgres snapshot replicas cannot publish an older generation over a newer one', async (t) => {
  const stores = await Promise.all([0, 1].map(() => createPostgresMergeStore({ connectionString: process.env.RAU_TEST_POSTGRES_URL })));
  t.after(() => Promise.all(stores.map((store) => store.close())));
  const account = `snapshot-replica-${randomBytes(8).toString('hex')}`;
  const apis = stores.map((store) => createMergeArtifacts({ store, sessionSecret: secret, kind: 'conversation' }));
  const payload = (generation) => input(Buffer.from(`snapshot ${generation}`), 0, { revision: generation,
    operationId: `snapshot-${generation}`, kind: 'conversation', state: 'queued', retentionUntil: Date.now() + MERGE_RETENTION_MS });
  const results = await Promise.allSettled([apis[0].upload(account, 'run-1', payload(2)), apis[1].upload(account, 'run-1', payload(1))]);
  assert.equal(results[0].status, 'fulfilled');
  if (results[1].status === 'rejected') assert.equal(results[1].reason.code, 'CLOUD_CONVERSATION_STALE');
  const listed = (await apis[1].list(account)).mergeRequests;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].revision, 2);
});

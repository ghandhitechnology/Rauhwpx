import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CloudHandoffStore, sha256Hex } from '../desktop/cloud-handoff.mjs';
import { CloudMergeRecovery, validateMergeRequest } from '../desktop/cloud-merge-recovery.mjs';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloud-merge-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'handoffs.json');
  const store = new CloudHandoffStore({ filePath });
  const handoff = await store.create({ sessionId: 'local-session', threadId: 'thread-1', documentId: 'document-1',
    documentName: 'source.hwpx', documentBytes: Buffer.from('original'), provider: 'codex', limits: { maxTurns: 100 } });
  await store.patch(handoff.id, { cloudSessionId: 'cloud-session' });
  const bytes = Buffer.alloc(512 * 1024 + 17, 37);
  const receipt = { id: 'merge-1', runId: 'run-1', sessionId: 'cloud-session', threadId: 'thread-1',
    documentId: 'document-1', cloudStartId: 'start-1', operationId: 'turn-1', revision: 4, turn: 1,
    kind: 'turn', fileName: 'source.hwpx', sha256: sha256Hex(bytes), size: bytes.length, chunkCount: 2 };
  let reads = 0;
  const provider = {
    listMergeRequests: async () => ({ accountId: 'account-1', mergeRequests: [receipt] }),
    downloadMergeChunk: async (_id, index) => {
      reads += 1;
      return { bytesBase64: bytes.subarray(index * 512 * 1024, (index + 1) * 512 * 1024).toString('base64') };
    },
  };
  const recovery = new CloudMergeRecovery({ store, recoveryDir: directory, provider: () => provider });
  return { directory, filePath, store, handoff, receipt, bytes, provider, recovery, reads: () => reads };
}

test('sleeping laptop discovers sent turn after worker deletion and reopening uses verified cached bytes', async (t) => {
  const f = await fixture(t);
  await f.recovery.refresh();
  assert.equal(f.recovery.requests[0].cloudStartId, 'start-1');
  const checkpoint = await f.recovery.download('cloud-session', 'turn-1');
  assert.deepEqual(Buffer.from(checkpoint.bytes), f.bytes);
  assert.equal(checkpoint.kind, 'turn');
  assert.equal(f.reads(), 2);
  const reloaded = new CloudHandoffStore({ filePath: f.filePath });
  f.provider.downloadMergeChunk = async () => { throw new Error('broker download unavailable'); };
  f.provider.listMergeRequests = async () => ({ accountId: 'account-1', mergeRequests: [] });
  const reopened = new CloudMergeRecovery({ store: reloaded, recoveryDir: f.directory, provider: () => f.provider });
  await reopened.refresh();
  assert.equal(reopened.requests[0].localAvailable, true);
  assert.deepEqual(Buffer.from((await reopened.download('cloud-session', 'turn-1')).bytes), f.bytes);
  assert.deepEqual(await readFile((await reloaded.get(f.handoff.id)).mergeArchives[0].cachePath), f.bytes);
});

test('metadata binds the document and thread and account changes hide previous cached requests', async (t) => {
  const f = await fixture(t);
  f.provider.listMergeRequests = async () => ({ accountId: 'account-1', mergeRequests: [{ ...f.receipt, documentId: 'other-document' }] });
  await f.recovery.refresh();
  assert.equal(f.recovery.requests.length, 0);
  f.provider.listMergeRequests = async () => ({ accountId: 'account-1', mergeRequests: [f.receipt] });
  await f.recovery.refresh({ force: true });
  await f.recovery.download('cloud-session', 'turn-1');
  f.provider.listMergeRequests = async () => ({ accountId: 'account-2', mergeRequests: [] });
  await f.recovery.refresh({ force: true });
  assert.equal(f.recovery.requests.length, 0);
  assert.equal(await f.recovery.download('cloud-session', 'turn-1'), null);
});

test('corrupt cache is recovered and mismatched downloads never become usable merge documents', async (t) => {
  const f = await fixture(t);
  await f.recovery.refresh();
  await f.recovery.download('cloud-session', 'turn-1');
  const cachePath = (await f.store.get(f.handoff.id)).mergeArchives[0].cachePath;
  await writeFile(cachePath, Buffer.from('corrupt'));
  await f.recovery.download('cloud-session', 'turn-1');
  assert.deepEqual(await readFile(cachePath), f.bytes);
  await rm(cachePath);
  f.provider.downloadMergeChunk = async (_id, index) => ({ bytesBase64: Buffer.alloc(index ? 17 : 512 * 1024, 99).toString('base64') });
  await assert.rejects(f.recovery.download('cloud-session', 'turn-1'), /digest/);
  await assert.rejects(readFile(cachePath), { code: 'ENOENT' });
});

test('account reset fences an in-flight discovery and invalid receipts fail before download', async (t) => {
  const f = await fixture(t);
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  f.provider.listMergeRequests = () => new Promise((resolve) => { release = resolve; started(); });
  const pending = f.recovery.refresh();
  await ready;
  f.recovery.reset();
  release({ accountId: 'account-1', mergeRequests: [f.receipt] });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.recovery.requests.length, 0);
  for (const patch of [{ size: 129 * 1024 * 1024 }, { chunkCount: 3 }, { fileName: '../secret' }, { sha256: 'bad' }]) {
    assert.throws(() => validateMergeRequest({ ...f.receipt, ...patch }), /invalid/);
  }
});

test('coordinator refresh discovers merge requests with no worker profile and serves exact broker checkpoint', async (t) => {
  const f = await fixture(t);
  const provider = { ...f.provider, id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
    spawn() {}, status() {}, teardown() {}, accountStatus: async () => ({ signedIn: true }) };
  const coordinator = new CloudCoordinator({ client: { loadProfile: async () => null }, store: f.store,
    recoveryDir: f.directory, appServers: [provider] });
  t.after(() => coordinator.stop());
  const snapshot = await coordinator.refresh({ documentId: 'document-1' });
  assert.equal(snapshot.mergeRequests.length, 1);
  assert.deepEqual(Buffer.from((await coordinator.downloadCheckpoint({ sessionId: 'cloud-session', operationId: 'turn-1' })).bytes), f.bytes);
});

test('merge discovery returns before automatic prefetch and publishes offline readiness when verification finishes', async (t) => {
  const f = await fixture(t);
  const release = Promise.withResolvers();
  const started = Promise.withResolvers();
  const originalDownload = f.provider.downloadMergeChunk;
  f.provider.downloadMergeChunk = async (...args) => {
    started.resolve();
    await release.promise;
    return originalDownload(...args);
  };
  const provider = {
    ...f.provider,
    id: 'raucloud',
    displayName: 'Raucloud',
    configuration: () => ({ configured: true }),
    spawn() {}, status() {}, teardown() {},
    accountStatus: async () => ({ signedIn: true }),
  };
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null },
    store: f.store,
    recoveryDir: f.directory,
    appServers: [provider],
  });
  t.after(() => coordinator.stop());
  const refreshed = await coordinator.refresh({ documentId: 'document-1' });
  assert.equal(refreshed.mergeRequests[0].localAvailable, false);
  await started.promise;
  const ready = Promise.withResolvers();
  coordinator.on('event', (event) => {
    if (event.type === 'merge-prefetch-completed') ready.resolve();
  });
  release.resolve();
  await ready.promise;
  const snapshot = await coordinator.snapshot({ documentId: 'document-1' });
  assert.equal(snapshot.mergeRequests[0].localAvailable, true);
  f.provider.listMergeRequests = async () => { throw new Error('offline'); };
  assert.deepEqual(
    Buffer.from((await coordinator.downloadCheckpoint({ sessionId: 'cloud-session', operationId: 'turn-1' })).bytes),
    f.bytes,
  );
});

test('one refresh drains more than eight merge results through bounded background batches', async (t) => {
  const f = await fixture(t);
  const payloads = new Map();
  const receipts = Array.from({ length: 10 }, (_, index) => {
    const number = index + 1;
    const bytes = Buffer.from(`result-${number}`);
    const receipt = {
      ...f.receipt,
      id: `merge-${number}`,
      operationId: `turn-${number}`,
      revision: number,
      turn: number,
      sha256: sha256Hex(bytes),
      size: bytes.length,
      chunkCount: 1,
    };
    payloads.set(receipt.id, bytes);
    return receipt;
  });
  let active = 0;
  let maxActive = 0;
  f.provider.listMergeRequests = async () => ({ accountId: 'account-1', mergeRequests: receipts });
  f.provider.downloadMergeChunk = async (receiptId) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { bytesBase64: payloads.get(receiptId).toString('base64') };
  };
  const provider = {
    ...f.provider,
    id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
    spawn() {}, status() {}, teardown() {}, accountStatus: async () => ({ signedIn: true }),
  };
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null }, store: f.store,
    recoveryDir: f.directory, appServers: [provider],
  });
  t.after(() => coordinator.stop());
  const completed = new Set();
  const allReady = Promise.withResolvers();
  coordinator.on('event', (event) => {
    if (event.type !== 'merge-prefetch-completed') return;
    completed.add(event.operationId);
    if (completed.size === receipts.length) allReady.resolve();
  });
  await coordinator.refresh({ documentId: 'document-1' });
  let timeout;
  try {
    await Promise.race([
      allReady.promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('prefetch did not drain')), 2_000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  const snapshot = await coordinator.snapshot({ documentId: 'document-1' });
  assert.equal(snapshot.mergeRequests.length, 10);
  assert.equal(snapshot.mergeRequests.every((request) => request.localAvailable), true);
  assert.ok(maxActive <= 2);
});

test('a failed prefetch batch stops without busy-retrying or advancing to another batch', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from('merge-result');
  const receipts = Array.from({ length: 10 }, (_, index) => ({
    ...f.receipt,
    id: `merge-${index + 1}`,
    operationId: `turn-${index + 1}`,
    revision: index + 1,
    turn: index + 1,
    sha256: sha256Hex(bytes),
    size: bytes.length,
    chunkCount: 1,
  }));
  f.provider.listMergeRequests = async () => ({ accountId: 'account-1', mergeRequests: receipts });
  let failedReads = 0;
  f.provider.downloadMergeChunk = async (receiptId) => {
    if (receiptId === 'merge-10') {
      failedReads += 1;
      throw new Error('broker temporarily unavailable');
    }
    return { bytesBase64: bytes.toString('base64') };
  };
  await f.recovery.refresh();
  const result = await f.recovery.prefetch();
  assert.equal(result.attempted, 8);
  assert.equal(result.downloaded, 7);
  assert.equal(result.failures.length, 1);
  assert.equal(failedReads, 1);
  assert.equal(f.recovery.requests.filter((request) => request.localAvailable).length, 7);
});

test('expired broker metadata without a local download does not leave an unusable merge offer', async (t) => {
  const f = await fixture(t);
  await f.recovery.refresh();
  assert.equal(f.recovery.requests.length, 1);
  f.provider.listMergeRequests = async () => ({ accountId: 'account-1', mergeRequests: [] });
  await f.recovery.refresh({ force: true });
  assert.equal(f.recovery.requests.length, 0);
});

test('offline reopening restores downloaded requests only for the same local account credential', async (t) => {
  const f = await fixture(t);
  let identity = 'credential-fingerprint-1';
  f.provider.getLocalCacheIdentity = async () => identity;
  await f.recovery.refresh();
  await f.recovery.download('cloud-session', 'turn-1');
  f.provider.listMergeRequests = async () => { throw new Error('network offline'); };
  const reopened = new CloudMergeRecovery({ store: new CloudHandoffStore({ filePath: f.filePath }),
    recoveryDir: f.directory, provider: () => f.provider });
  await reopened.refresh();
  assert.equal(reopened.requests.length, 1);
  assert.deepEqual(Buffer.from((await reopened.download('cloud-session', 'turn-1')).bytes), f.bytes);
  identity = 'another-account-credential';
  reopened.reset();
  await assert.rejects(reopened.refresh(), /network offline/);
  assert.equal(reopened.requests.length, 0);
});

test('account discovery changing during a chunk download fences the previous account result', async (t) => {
  const f = await fixture(t);
  await f.recovery.refresh();
  const normalDownload = f.provider.downloadMergeChunk;
  f.provider.downloadMergeChunk = async (...args) => {
    f.provider.listMergeRequests = async () => ({ accountId: 'account-2', mergeRequests: [] });
    await f.recovery.refresh({ force: true });
    return normalDownload(...args);
  };
  await assert.rejects(f.recovery.download('cloud-session', 'turn-1'), { name: 'AbortError' });
});

test('real worker upload and account HTTP client recover the merge after worker deletion and broker restart', async (t) => {
  const { createHash } = await import('node:crypto');
  const { Readable } = await import('node:stream');
  const http = await import('node:http');
  const { createCreditsService, creditsRequestListener } = await import('../rhwp/rau-credits/service.mjs');
  const { createMemoryStore } = await import('../rhwp/rau-credits/store.mjs');
  const { createFileMergeStore } = await import('../rhwp/rau-credits/merge-artifacts.mjs');
  const { RaucloudLeaseController } = await import('../cloud/src/raucloud-lease.mjs');
  const { createRauCreditsClient } = await import('../rhwp/rhwp-agent/rau-credits-client.mjs');
  const { createRaucloudBrokerClient } = await import('../desktop/cloud-broker.mjs');
  const f = await fixture(t);
  const token = `rau_account_v1_${'a'.repeat(43)}`;
  const workerToken = 'test-worker-token';
  const workerTokenHash = sha256Hex(Buffer.from(workerToken));
  const stateStore = createMemoryStore({ users: {}, sessions: {}, accessTokens: {}, accountSessions: {
    [createHash('sha256').update(token).digest('base64url')]: { status: 'active', workosUserId: 'user_test' },
  }, raucloud: { accounts: { user_test: { worker: { id: 'worker-1', runId: 'run-1', workerTokenHash, status: 'active' } } },
    runs: { 'run-1': { id: 'run-1', accountId: 'user_test', workerId: 'worker-1', workerTokenHash, status: 'active' } }, idempotency: {} } });
  const launch = async () => {
    const service = createCreditsService({ sessionSecret: 'integration-secret', origin: 'http://localhost', store: stateStore,
      mergeArtifactStore: createFileMergeStore(path.join(f.directory, 'broker')) });
    const server = http.createServer(creditsRequestListener(service));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
  };
  let running = await launch();
  t.after(() => new Promise((resolve) => running.server.close(resolve)));
  const lease = new RaucloudLeaseController({ baseUrl: running.baseUrl, runId: 'run-1', workerToken });
  const { id: _id, runId: _runId, chunkCount: _count, ...metadata } = f.receipt;
  const sent = await lease.archiveMergeRequest(metadata, Readable.from([f.bytes]));
  assert.equal(sent.complete, true);
  await stateStore.mutate((state) => { state.raucloud.runs = {}; state.raucloud.accounts = {}; });
  await new Promise((resolve) => running.server.close(resolve));
  running = await launch();
  const credits = createRauCreditsClient({ baseUrl: running.baseUrl });
  const broker = createRaucloudBrokerClient({ baseUrl: running.baseUrl,
    getDeviceIdentity: async () => ({ id: 'device-test' }),
    authorizeOwnedBackend: (request, options) => credits.authorizeOwnedBackend(token, request, options) });
  const recovery = new CloudMergeRecovery({ store: f.store, recoveryDir: f.directory, provider: () => broker });
  await recovery.refresh();
  assert.equal(recovery.requests.length, 1);
  assert.equal(recovery.requests[0].cloudStartId, 'start-1');
  const recovered = await recovery.download('cloud-session', 'turn-1');
  assert.deepEqual(Buffer.from(recovered.bytes), f.bytes);
  assert.equal(recovered.sha256, f.receipt.sha256);
});

test('concurrent inbox refresh preserves a newly persisted download receipt for offline reopening', async (t) => {
  const f = await fixture(t);
  f.provider.getLocalCacheIdentity = async () => 'same-credential';
  await f.recovery.refresh();
  const patch = f.store.patch.bind(f.store);
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const pause = new Promise((resolve) => { release = resolve; });
  let holdRefresh = true;
  f.store.patch = async (...args) => {
    if (holdRefresh) { holdRefresh = false; started(); await pause; }
    return patch(...args);
  };
  const refreshing = f.recovery.refresh({ force: true });
  await ready;
  await f.recovery.download('cloud-session', 'turn-1');
  const beforeRefresh = (await f.store.get(f.handoff.id)).mergeArchives[0].cachePath;
  assert.ok(beforeRefresh);
  release();
  await refreshing;
  assert.equal((await f.store.get(f.handoff.id)).mergeArchives[0].cachePath, beforeRefresh);
  assert.equal(f.recovery.requests[0].localAvailable, true);
  f.provider.listMergeRequests = async () => { throw new Error('offline'); };
  const reopened = new CloudMergeRecovery({ store: new CloudHandoffStore({ filePath: f.filePath }),
    recoveryDir: f.directory, provider: () => f.provider });
  await reopened.refresh();
  assert.deepEqual(Buffer.from((await reopened.download('cloud-session', 'turn-1')).bytes), f.bytes);
});

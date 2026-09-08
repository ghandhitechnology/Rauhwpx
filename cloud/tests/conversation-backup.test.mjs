import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthService } from '../src/auth.mjs';
import { BlobStore } from '../src/blob-store.mjs';
import { ConversationBackup } from '../src/conversation-backup.mjs';
import { openDatabase } from '../src/database.mjs';
import { parseCommand, parseSessionCreate } from '../src/protocol.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { createCloudHttpHandler } from '../src/http-server.mjs';
import { createMergeArtifacts, createMemoryMergeStore, MERGE_CHUNK_BYTES } from '../../rhwp/rau-credits/merge-artifacts.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function durableBroker() {
  const store = createMemoryMergeStore();
  const conversations = createMergeArtifacts({ store, sessionSecret: 'backup-test', kind: 'conversation' });
  const resources = createMergeArtifacts({ store, sessionSecret: 'backup-test', kind: 'conversation-resource' });
  const uploads = [];
  let offline = false;
  return { uploads, setOffline: (value) => { offline = value; },
    lease: { enabled: true, assertCommandAllowed: async () => {},
      async archiveConversation(metadata, stream) {
        if (offline) { stream.destroy(); throw Object.assign(new Error('offline'), { status: 503 }); }
        uploads.push(metadata.kind);
        const parts = [];
        for await (const bytes of stream) parts.push(bytes);
        const bytes = Buffer.concat(parts);
        const api = metadata.kind === 'conversation' ? conversations : resources;
        let receipt;
        for (let index = 0; index < Math.ceil(bytes.length / MERGE_CHUNK_BYTES); index++) {
          receipt = await api.upload('account', 'run', { ...metadata, chunkIndex: index,
            chunkCount: Math.ceil(bytes.length / MERGE_CHUNK_BYTES),
            bytesBase64: bytes.subarray(index * MERGE_CHUNK_BYTES, (index + 1) * MERGE_CHUNK_BYTES).toString('base64') });
        }
        return receipt;
      },
      async downloadConversation(sessionId) {
        const record = (await conversations.list('account', sessionId)).mergeRequests[0];
        if (!record || record.state === 'purged') throw Object.assign(new Error('missing'), { code: 'CONVERSATION_SNAPSHOT_NOT_FOUND' });
        return { record, bytes: await this.downloadConversationArtifact(record) };
      },
      async downloadConversationArtifact(record, resource = false) {
        const api = resource ? resources : conversations;
        const chunks = [];
        for (let index = 0; index < record.chunkCount; index++) chunks.push(Buffer.from((await api.chunk('account', record.id, index)).bytesBase64, 'base64'));
        return Buffer.concat(chunks);
      },
    } };
}

async function fixture(t, lease) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rau-conversation-backup-'));
  const database = openDatabase(path.join(root, 'cloud.sqlite'));
  const blobStore = new BlobStore(database, { root });
  const auth = new AuthService(database);
  const pairing = auth.createPairingCode();
  const { device } = auth.redeemPairingCode({ code: pairing.code, deviceName: 'Laptop' });
  const sessionStore = new SessionStore(database, blobStore);
  sessionStore.setProviderStatus('codex', { available: true, authenticated: true });
  const backup = new ConversationBackup({ sessionStore, blobStore, lease });
  t.after(async () => { database.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function upload(bytes, kind) {
    let result = await blobStore.initUpload({ deviceId: device.id, sha256: sha(bytes), size: bytes.length, name: kind, kind });
    while (result.status !== 'complete') result = await blobStore.appendChunk({ deviceId: device.id,
      uploadId: result.uploadId, offset: result.offset, bytes: bytes.subarray(result.offset, result.offset + result.chunkSize) });
    return { blobId: result.blob.sha256, size: bytes.length };
  }
  return { root, database, sessionStore, blobStore, device, auth, backup, upload,
    async create() {
      const document = await upload(Buffer.from('original document'), 'document');
      const timeline = await upload(Buffer.from(JSON.stringify({ thread: { id: 'thread-1', cloudStartId: 'start-1' } })), 'timeline');
      const session = sessionStore.createSession(device, parseSessionCreate({ sessionId: 'session-1', provider: 'codex',
        persistent: true, goal: 'Edit this document', clientContext: { threadId: 'thread-1', documentId: 'document-1' },
        originDocument: { ...document, name: 'document.hwpx' }, timeline }));
      await backup.save(session.id);
      return session;
    },
    command(type, payload, id = type.replaceAll('.', '_')) { return sessionStore.executeCommand(device, 'session-1', parseCommand({ commandId: id, type, payload })); },
  };
}

test('accepted queue restores on a new worker with the same command receipts and verified resources', async (t) => {
  const broker = durableBroker();
  const first = await fixture(t, broker.lease);
  const created = await first.create();
  first.command('session.activate', { expectedVersion: created.stateVersion });
  const command = parseCommand({ commandId: 'queued-command', type: 'message.queue', payload: { messageId: 'message-1', content: 'Follow up' } });
  const accepted = first.sessionStore.executeCommand(first.device, 'session-1', command);
  await first.backup.save('session-1');
  assert.equal((await broker.lease.downloadConversation('session-1')).record.pendingWork, true);
  const resourceUploads = broker.uploads.filter((kind) => kind === 'conversation-resource').length;
  assert.equal(resourceUploads, 2);
  const snapshot = JSON.parse((await broker.lease.downloadConversation('session-1')).bytes);
  assert.equal(snapshot.session.worker_token_hash, null);
  assert.equal(snapshot.session.sandbox_id, null);
  assert.equal(JSON.stringify(snapshot).includes(first.root), false);
  assert.equal(Object.hasOwn(snapshot, 'devices'), false);
  const second = await fixture(t, broker.lease);
  const restored = await second.backup.restore(second.device, 'session-1');
  assert.equal(restored.session.status, 'queued');
  assert.equal(restored.sourceEventSeq, snapshot.session.next_event_seq - 1);
  assert.equal(restored.restoredEventSeq, restored.sourceEventSeq + 1);
  assert.equal(second.sessionStore.getSessionRow('session-1').origin_device_id, second.device.id);
  assert.deepEqual(second.sessionStore.executeCommand(second.device, 'session-1', command), accepted);
  assert.equal(second.database.prepare('SELECT COUNT(*) AS count FROM session_messages').get().count, 1);
  const repeated = await second.backup.restore(second.device, 'session-1');
  assert.equal(repeated.session.id, restored.session.id);
  assert.equal(repeated.sourceEventSeq, restored.sourceEventSeq);
  assert.equal(repeated.restoredEventSeq, restored.restoredEventSeq);
  assert.equal(second.database.prepare("SELECT COUNT(*) AS count FROM session_events WHERE type = 'session.restored'").get().count, 1);
  assert.equal(broker.uploads.filter((kind) => kind === 'conversation-resource').length, resourceUploads);
  for (const blob of snapshot.blobs) assert.equal(second.blobStore.get(blob.sha256).size, blob.size);
});

test('worker replacement keeps an uncertain turn and its approval pending until explicit resume', async (t) => {
  const broker = durableBroker();
  const first = await fixture(t, broker.lease);
  const created = await first.create();
  first.command('session.activate', { expectedVersion: created.stateVersion });
  first.sessionStore.claimNextSession();
  const turn = first.sessionStore.beginTurn('session-1', { turnNumber: 1, mode: 'plan' });
  const wait = first.sessionStore.createWait('session-1', { turnNumber: 1, kind: 'plan-approval', payload: { planId: 'plan-1' } });
  await first.backup.save('session-1');
  const second = await fixture(t, broker.lease);
  const restored = await second.backup.restore(second.device, 'session-1');
  assert.equal(restored.session.status, 'suspended');
  assert.equal(restored.session.suspendedReason.code, 'WORKER_REPLACED_UNCERTAIN');
  assert.equal(restored.session.currentWait.id, wait.id);
  assert.equal(second.sessionStore.claimNextSession(), null);
  assert.equal(second.database.prepare('SELECT id FROM session_turns').get().id, turn.id);
  second.command('session.resume', { expectedVersion: restored.session.stateVersion });
  assert.equal(second.sessionStore.getSession('session-1').status, 'queued');
  assert.equal(second.database.prepare('SELECT status FROM session_waits').get().status, 'cancelled');
  assert.equal(second.database.prepare('SELECT id, status FROM session_turns').get().status, 'queued');
});

test('failed acknowledgments retain pending backup work and immutable resources through controller reconstruction', async (t) => {
  const broker = durableBroker();
  const first = await fixture(t, broker.lease);
  const created = await first.create();
  first.command('session.activate', { expectedVersion: created.stateVersion });
  broker.setOffline(true);
  await assert.rejects(first.backup.save('session-1'));
  assert.equal(first.database.prepare('SELECT COUNT(*) AS count FROM conversation_backup_pending').get().count, 1);
  broker.setOffline(false);
  const restarted = new ConversationBackup({ sessionStore: first.sessionStore, blobStore: first.blobStore, lease: broker.lease });
  await restarted.flush();
  assert.equal(first.database.prepare('SELECT COUNT(*) AS count FROM conversation_backup_pending').get().count, 0);
  assert.equal((await broker.lease.downloadConversation('session-1')).record.state, 'queued');
  assert.equal(broker.uploads.filter((kind) => kind === 'conversation-resource').length, 2);
});

test('purging a saved conversation publishes a tombstone that blocks replacement restore', async (t) => {
  const broker = durableBroker();
  const first = await fixture(t, broker.lease);
  await first.create();
  first.database.prepare('UPDATE sessions SET expires_at = 1 WHERE id = ?').run('session-1');
  await first.sessionStore.purgeExpiredSession('session-1');
  await first.backup.flush();
  const second = await fixture(t, broker.lease);
  await assert.rejects(second.backup.restore(second.device, 'session-1'), { code: 'CONVERSATION_SNAPSHOT_NOT_FOUND' });
  assert.equal(second.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

for (const completed of [false, true]) {
  test(`a saved turn restores an empty idle queue without rerunning its goal${completed ? '' : ' after a lost completion response'}`, async (t) => {
    const broker = durableBroker();
    const first = await fixture(t, broker.lease);
    const created = await first.create();
    first.command('session.activate', { expectedVersion: created.stateVersion });
    first.sessionStore.claimNextSession();
    const turn = first.sessionStore.beginTurn('session-1', { turnNumber: 1, mode: 'direct' });
    const document = await first.upload(Buffer.from('edited document'), 'document');
    const timeline = await first.upload(Buffer.from(JSON.stringify({ thread: { id: 'thread-1', cloudStartId: 'start-1' }, completed: true })), 'timeline');
    await first.sessionStore.commitBoundary('session-1', { operationId: 'finished-turn', turnNumber: 1,
      revision: 1, kind: 'turn', checkpoint: document, timeline });
    if (completed) {
      first.sessionStore.completeTurn('session-1', { boundaryOperationId: 'finished-turn' });
      assert.equal(first.sessionStore.claimFinish('session-1').waiting, true);
    }
    await first.backup.save('session-1');
    assert.equal((await broker.lease.downloadConversation('session-1')).record.pendingWork, false);
    const second = await fixture(t, broker.lease);
    const restored = await second.backup.restore(second.device, 'session-1');
    assert.equal(restored.session.status, 'queued');
    assert.equal(restored.session.turnsUsed, 1);
    second.sessionStore.claimNextSession();
    assert.deepEqual(second.sessionStore.claimFinish('session-1'), { ready: false, waiting: true, workflow: 'direct', messages: [] });
    assert.equal(second.sessionStore.workerManifest('session-1').latestCheckpoint.blobId, document.blobId);
    assert.equal(second.database.prepare('SELECT id FROM session_turns').get().id, turn.id);
    assert.equal(second.database.prepare('SELECT status FROM session_turns').get().status, 'completed');
  });
}

test('HTTP sleep acknowledgment archives the room and retains a warm lease for presence wake', async (t) => {
  const broker = durableBroker();
  const calls = [];
  broker.lease.complete = async () => { calls.push('complete'); return { worker: { status: 'warm' } }; };
  broker.lease.checkpoint = async () => { assert.fail('sleep must not request worker teardown'); };
  const first = await fixture(t, broker.lease);
  let clock = Date.now();
  first.sessionStore.now = () => clock;
  const created = await first.create();
  first.command('session.activate', { expectedVersion: created.stateVersion });
  first.sessionStore.claimNextSession();
  first.sessionStore.prepareWorker('session-1', 'sleep-worker');
  first.sessionStore.completeTurn('session-1');
  first.sessionStore.claimFinish('session-1');
  clock += 31 * 60_000;
  assert.deepEqual(first.sessionStore.requestIdleSleeps(), ['session-1']);
  const server = http.createServer(createCloudHttpHandler({ auth: first.auth, blobStore: first.blobStore,
    sessionStore: first.sessionStore, conversationBackup: first.backup, raucloudLease: broker.lease,
    config: { basePath: '' }, identity: { serverPublicKey: 'test-key' }, logger: { error() {} } }, { workerOnly: true }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/internal/worker/session-1/sleep-ack`, {
    method: 'POST', headers: { authorization: 'Bearer sleep-worker', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['complete']);
  assert.equal((await response.json()).suspendedReason.code, 'PRESENCE_SLEEP');
  const second = await fixture(t, broker.lease);
  const restored = await second.backup.restore(second.device, 'session-1');
  assert.equal(restored.session.suspendedReason.code, 'PRESENCE_SLEEP');
  assert.equal(second.sessionStore.openPresence('session-1', second.device.id, 'returned-laptop').presence.waking, true);
  assert.equal(second.sessionStore.getSession('session-1').status, 'queued');
});

test('concurrent save retries coalesce while a newer command still waits for its own captured state', async (t) => {
  const broker = durableBroker();
  const first = await fixture(t, broker.lease);
  const created = await first.create();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const archive = broker.lease.archiveConversation;
  let saves = 0;
  broker.lease.archiveConversation = async function (metadata, stream) {
    if (metadata.kind === 'conversation') {
      saves++;
      if (saves === 1) { entered.resolve(); await release.promise; }
      // Continuous progress after capture must not hold the command receipt.
      if (saves === 2) first.sessionStore.appendEvents('session-1', [{ type: 'assistant.delta', payload: { text: 'working' } }]);
    }
    return archive.call(this, metadata, stream);
  };
  first.command('session.activate', { expectedVersion: created.stateVersion });
  const activating = first.backup.save('session-1');
  await entered.promise;
  first.command('message.queue', { messageId: 'follow-up', content: 'Keep going' });
  const expectedSeq = first.sessionStore.getSessionRow('session-1').next_event_seq;
  const retries = Array.from({ length: 10 }, () => first.backup.save('session-1'));
  release.resolve();
  await activating;
  const results = await Promise.all(retries);
  assert.equal(saves, 2);
  assert(results.every((result) => result.eventSeq >= expectedSeq));
  const snapshot = JSON.parse((await broker.lease.downloadConversation('session-1')).bytes);
  assert.equal(snapshot.rows.session_messages[0].id, 'follow-up');
  assert.equal(first.database.prepare('SELECT COUNT(*) AS count FROM conversation_backup_pending').get().count, 1);
});

test('an imported restore remains unacknowledged until its pending snapshot is durable', async (t) => {
  const broker = durableBroker();
  const first = await fixture(t, broker.lease);
  const created = await first.create();
  first.command('session.activate', { expectedVersion: created.stateVersion });
  await first.backup.save('session-1');
  const second = await fixture(t, broker.lease);
  broker.setOffline(true);
  await assert.rejects(second.backup.restore(second.device, 'session-1'));
  await assert.rejects(second.backup.restore(second.device, 'session-1'));
  broker.setOffline(false);
  const receipt = await second.backup.restore(second.device, 'session-1');
  assert.equal(receipt.session.status, 'queued');
  assert.equal(second.database.prepare("SELECT COUNT(*) AS count FROM session_events WHERE type = 'session.restored'").get().count, 1);
  assert.equal(second.database.prepare('SELECT COUNT(*) AS count FROM conversation_backup_pending').get().count, 0);
});

for (const damage of ['unsafe-name', 'missing-resource', 'corrupt-resource']) {
  test(`restore rejects ${damage} before publishing a conversation`, async (t) => {
    const broker = durableBroker();
    const first = await fixture(t, broker.lease);
    await first.create();
    const download = broker.lease.downloadConversation;
    const resource = broker.lease.downloadConversationArtifact;
    broker.lease.downloadConversation = async function (sessionId) {
      const result = await download.call(this, sessionId);
      const snapshot = JSON.parse(result.bytes);
      if (damage === 'unsafe-name') snapshot.rows.session_resources[0].name = '../outside.hwpx';
      if (damage === 'missing-resource') snapshot.blobs.pop();
      return { ...result, bytes: Buffer.from(JSON.stringify(snapshot)) };
    };
    broker.lease.downloadConversationArtifact = async function (record, isResource) {
      if (damage === 'corrupt-resource' && isResource) return Buffer.from('corrupted');
      return resource.call(this, record, isResource);
    };
    const second = await fixture(t, broker.lease);
    await assert.rejects(second.backup.restore(second.device, 'session-1'), { code: 'CONVERSATION_SNAPSHOT_INVALID' });
    assert.equal(second.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  });
}

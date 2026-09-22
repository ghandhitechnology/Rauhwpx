import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CloudConversationRecovery,
  validateConversationSnapshot,
} from '../desktop/cloud-conversation-recovery.mjs';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';
import { CloudHandoffStore } from '../desktop/cloud-handoff.mjs';
import { normalizeCloudProfile } from '../desktop/cloud-profile.mjs';

const SERVER_IDENTITY = generateKeyPairSync('ed25519');
const SERVER_KEY = `ed25519:${SERVER_IDENTITY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;

function snapshot(overrides = {}) {
  return {
    id: `merge_${'a'.repeat(64)}`,
    sessionId: 'cloud-session',
    documentId: 'document-1',
    threadId: 'thread-1',
    cloudStartId: 'cloud-start-1',
    revision: 3,
    turn: 1,
    createdAt: Date.parse('2026-09-08T01:00:00.000Z'),
    expiresAt: Date.parse('2026-10-08T01:00:00.000Z'),
    sha256: 'b'.repeat(64),
    size: 4096,
    state: 'running',
    pendingWork: true,
    ...overrides,
  };
}

async function handoffFixture(t, { state = 'running' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloud-conversation-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'local-session',
    threadId: 'thread-1',
    documentId: 'document-1',
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    timeline: { thread: { cloudStartId: 'cloud-start-1' } },
    provider: 'claude',
    limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, state, {
    cloudSessionId: 'cloud-session',
    handoffAcceptedAt: '2026-09-08T00:59:00.000Z',
  });
  return { directory, store, created };
}

test('conversation descriptors normalize broker timestamps and reject oversized or unbound values', () => {
  assert.deepEqual(validateConversationSnapshot(snapshot()).createdAt, '2026-09-08T01:00:00.000Z');
  for (const patch of [
    { size: 128 * 1024 * 1024 + 1 },
    { sha256: 'bad' },
    { sessionId: '../other' },
    { expiresAt: 0 },
    { pendingWork: undefined },
  ]) assert.throws(() => validateConversationSnapshot(snapshot(patch)), /invalid/);
});

test('broker conversation discovery is account fenced and bound to the local handoff identity', async (t) => {
  const { store } = await handoffFixture(t);
  let identity = 'account-credential-1';
  let response = { accountId: 'account-1', conversations: [snapshot()] };
  const recovery = new CloudConversationRecovery({
    store,
    provider: () => ({
      getLocalCacheIdentity: async () => identity,
      listConversations: async () => response,
    }),
  });
  assert.equal((await recovery.refresh()).length, 1);
  response = { accountId: 'account-1', conversations: [snapshot({ documentId: 'other-document' })] };
  assert.equal((await recovery.refresh()).length, 0);
  const gate = Promise.withResolvers();
  const pending = new CloudConversationRecovery({
    store,
    provider: () => ({
      getLocalCacheIdentity: async () => identity,
      listConversations: async () => gate.promise,
    }),
  }).refresh();
  identity = 'account-credential-2';
  gate.resolve({ accountId: 'account-1', conversations: [snapshot()] });
  await assert.rejects(pending, { name: 'AbortError' });
});

test('refresh restores a missing known session after provider auth is seeded and keeps its event cursor', async (t) => {
  const { directory, store, created } = await handoffFixture(t);
  await store.patch(created.id, { lastEventSequence: 17 });
  const profile = normalizeCloudProfile({
    mode: 'app-hosted',
    endpoint: 'https://replacement.example/rauhwpx-cloud',
    serverPublicKey: SERVER_KEY,
    sandbox: { providerId: 'raucloud', sandboxId: 'run-2', host: 'replacement.example' },
    provider: 'claude',
  });
  const restoredSession = {
    id: 'cloud-session', status: 'suspended', stateVersion: 9, provider: 'claude',
    suspendedReason: { code: 'WORKER_REPLACED_UNCERTAIN', message: 'Confirm before resuming.' },
    clientContext: { documentId: 'document-1', threadId: 'thread-1' },
    originDocument: { name: 'source.hwpx' },
  };
  let restored = false;
  const calls = [];
  const provider = {
    id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
    spawn() {}, status: async () => ({ lifecycle: 'ready' }), teardown() {},
    accountStatus: async () => ({ signedIn: true }),
    getLocalCacheIdentity: async () => 'account-credential-1',
    listConversations: async () => ({ accountId: 'account-1', conversations: [snapshot()] }),
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      deviceId: async () => 'device-1',
      health: async () => ({ ok: true, serverPublicKey: SERVER_KEY, capabilities: { conversationRestore: true } }),
      sessions: async () => restored ? [restoredSession] : [],
      seedProviderCredentials: async (auth) => { calls.push(['seed', auth.provider]); },
      restoreSession: async (sessionId) => {
        calls.push(['restore', sessionId]);
        restored = true;
        return { session: restoredSession, restored: true, sourceEventSeq: 12, restoredEventSeq: 13 };
      },
      watchSession: async (_id, _after, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      }),
    },
    store,
    recoveryDir: path.join(directory, 'recovery'),
    appServers: [provider],
    collectProviderAuth: async () => ({ provider: 'claude', apiKey: 'secret', files: [] }),
  });
  t.after(() => coordinator.stop());
  const result = await coordinator.refresh({ documentId: 'document-1' });
  assert.deepEqual(calls, [['seed', 'claude'], ['restore', 'cloud-session']]);
  assert.equal(result.session.kind, 'suspended');
  assert.equal(result.session.handoffAcceptedAt, '2026-09-08T00:59:00.000Z');
  const record = await store.get(created.id);
  assert.equal(record.lastEventSequence, 12);
  assert.equal(record.destination.endpoint, profile.endpoint);
  assert.equal(record.suspendedCode, 'WORKER_REPLACED_UNCERTAIN');
});

test('confirmed idle worker plus a matching live snapshot starts one replacement with the saved provider', async (t) => {
  const { directory, store, created } = await handoffFixture(t, { state: 'queued' });
  const profile = normalizeCloudProfile({
    mode: 'app-hosted', endpoint: 'https://gone.example/rauhwpx-cloud', serverPublicKey: SERVER_KEY,
    sandbox: { providerId: 'raucloud', sandboxId: 'run-gone', host: 'gone.example' }, provider: 'claude',
  });
  const provider = {
    id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
    spawn() {}, status: async () => ({ lifecycle: 'idle' }), teardown() {},
    accountStatus: async () => ({ signedIn: true }),
    getLocalCacheIdentity: async () => 'account-credential-1',
    listConversations: async () => ({ accountId: 'account-1', conversations: [snapshot({ state: 'queued' })] }),
  };
  await store.patch(created.id, {
    destination: {
      endpoint: profile.endpoint,
      serverPublicKey: profile.serverPublicKey,
      mode: 'app-hosted',
      sandboxId: profile.sandbox.sandboxId,
      sandboxProvider: profile.sandbox.providerId,
      protocolVersion: 2,
      runtimeVersion: null,
    },
  });
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => profile, isPaired: async () => false }, store, recoveryDir: path.join(directory, 'recovery'),
    appServers: [provider],
  });
  t.after(() => coordinator.stop());
  const calls = [];
  coordinator.spawnAppServer = async (options) => { calls.push(options); return { restored: true }; };
  const [first, second] = await Promise.all([
    coordinator.reconcileContinuity({ reason: 'resume' }),
    coordinator.reconcileContinuity({ reason: 'online' }),
  ]);
  assert.deepEqual(first, { restored: true });
  assert.deepEqual(second, { restored: true });
  assert.deepEqual(calls, [{ selectedProvider: 'claude' }]);
});

test('background continuity leaves idle and ended conversations cold', async (t) => {
  for (const descriptor of [
    snapshot({ pendingWork: false }),
    snapshot({ state: 'completed', pendingWork: false }),
  ]) {
    const { directory, store, created } = await handoffFixture(t);
    const profile = normalizeCloudProfile({
      mode: 'app-hosted', endpoint: 'https://gone.example/rauhwpx-cloud', serverPublicKey: SERVER_KEY,
      sandbox: { providerId: 'raucloud', sandboxId: 'run-gone', host: 'gone.example' }, provider: 'claude',
    });
    await store.patch(created.id, {
      destination: {
        endpoint: profile.endpoint, serverPublicKey: profile.serverPublicKey, mode: 'app-hosted',
        sandboxId: profile.sandbox.sandboxId, sandboxProvider: profile.sandbox.providerId,
        protocolVersion: 2, runtimeVersion: null,
      },
    });
    const provider = {
      id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
      spawn() {}, teardown() {},
      status: async () => ({ lifecycle: 'idle' }), accountStatus: async () => ({ signedIn: true }),
      getLocalCacheIdentity: async () => 'account-credential-1',
      listConversations: async () => ({ accountId: 'account-1', conversations: [descriptor] }),
    };
    const coordinator = new CloudCoordinator({
      client: { loadProfile: async () => profile, isPaired: async () => false },
      store, recoveryDir: path.join(directory, 'recovery'),
      appServers: [provider],
    });
    t.after(() => coordinator.stop());
    coordinator.spawnAppServer = async () => assert.fail('idle history must not allocate a worker');
    const result = await coordinator.reconcileContinuity({ reason: 'wake' });
    assert.equal(result.session.kind, 'running');
  }
});

test('explicit follow-up restores an idle conversation before uploading attachments', async (t) => {
  const { directory, store, created } = await handoffFixture(t);
  const profile = normalizeCloudProfile({
    mode: 'app-hosted', endpoint: 'https://gone.example/rauhwpx-cloud', serverPublicKey: SERVER_KEY,
    sandbox: { providerId: 'raucloud', sandboxId: 'run-gone', host: 'gone.example' }, provider: 'claude',
  });
  await store.patch(created.id, {
    destination: {
      endpoint: profile.endpoint, serverPublicKey: profile.serverPublicKey, mode: 'app-hosted',
      sandboxId: profile.sandbox.sandboxId, sandboxProvider: profile.sandbox.providerId,
      protocolVersion: 2, runtimeVersion: null,
    },
  });
  const order = [];
  const provider = {
    id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
    spawn() {}, teardown() {},
    status: async () => ({ lifecycle: 'idle' }), accountStatus: async () => ({ signedIn: true }),
    getLocalCacheIdentity: async () => 'account-credential-1',
    listConversations: async () => ({
      accountId: 'account-1', conversations: [snapshot({ pendingWork: false })],
    }),
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => false,
      uploadBlob: async ({ bytes }) => { order.push('upload'); return { blobId: 'blob-new', size: bytes.length }; },
      command: async () => { order.push('command'); return { messageId: 'message-1', status: 'queued' }; },
    },
    store, recoveryDir: path.join(directory, 'recovery'), appServers: [provider],
  });
  t.after(() => coordinator.stop());
  coordinator.spawnAppServer = async () => { order.push('spawn'); return {}; };
  await coordinator.command({
    sessionId: 'cloud-session', command: 'queue-message', message: 'Use the attachment', messageId: 'message-1',
    attachments: [{ id: 'attachment-1', name: 'note.txt', mimeType: 'text/plain', size: 4, bytes: Buffer.from('note') }],
  });
  assert.deepEqual(order, ['spawn', 'upload', 'command']);
});

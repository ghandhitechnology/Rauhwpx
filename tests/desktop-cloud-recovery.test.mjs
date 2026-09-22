import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';
import { openCloudDisplay } from '../desktop/cloud-display.mjs';

const key = `ed25519:${generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;
const profile = { mode: 'self-hosted', endpoint: 'https://cloud.example.test', serverPublicKey: key,
  transport: 'tailscale', ssh: { host: 'cloud.example.test', user: 'test', port: 22 } };
const store = () => ({ load: async () => [], list: async () => [], flush: async () => {} });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const waitForAbort = (signal) => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('external cancellation during display retry backoff never rejects an unobserved background loop', async () => {
  const controller = new AbortController();
  const retrying = Promise.withResolvers();
  const connection = await openCloudDisplay({
    displayCapability: async () => ({ kind: 'available', sessionId: 'session-1', streamId: 'stream-1' }),
    setDisplayInterest: async () => {},
    readDisplayFrames: async () => { throw Object.assign(new Error('worker stopped'), { code: 'ECONNRESET' }); },
  }, 'session-1', (event) => {
    if (event.state === 'reconnecting') retrying.resolve();
  }, { signal: controller.signal, retryBaseMs: 5000 });
  await retrying.promise;
  controller.abort();
  // No close handler is attached until the next event-loop turn. Node's test
  // runner reports any unhandled rejection in that interval as a test failure.
  await tick();
  await tick();
  await connection.close();
});

test('shutdown interrupts an indefinitely opening preview before acquiring its writer lock', { timeout: 1000 }, async () => {
  const started = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      openDisplay: async (_id, _listener, { signal }) => { started.resolve(); return waitForAbort(signal); },
    }, store: store(),
  });
  const opening = assert.rejects(coordinator.openDisplay('session-1', () => {}), { name: 'AbortError' });
  await started.promise;
  const before = performance.now();
  const result = await coordinator.forceQuitAccountCloud();
  await opening;
  assert.equal(result.lease.owner, 'local');
  assert.ok(performance.now() - before < 250);
  await coordinator.stop();
});

test('shutdown cancels a shared reconnect and the next reconnect remains usable', { timeout: 1000 }, async () => {
  let blocked = true;
  let probes = 0;
  const entered = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile, isPaired: async () => true,
      health: async (_profile, { signal, timeoutMs }) => {
        probes++;
        assert.equal(timeoutMs, 2000);
        if (!blocked) return { ok: true, serverPublicKey: key };
        entered.resolve();
        return waitForAbort(signal);
      },
    }, store: store(),
  });
  const first = coordinator.reconnectCloud();
  const second = coordinator.reconnectCloud();
  assert.equal(first, second);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await entered.promise;
  await coordinator.forceQuitAccountCloud();
  await rejected;
  blocked = false;
  assert.equal((await coordinator.reconnectCloud()).link.kind, 'ready');
  assert.equal(probes, 2);
  await coordinator.stop();
});

test('snapshots return immediately while account status is unavailable', { timeout: 1000 }, async () => {
  const pending = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null }, store: store(),
    appServers: [{ id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
      spawn: async () => {}, status: async () => {}, teardown: async () => {}, accountStatus: () => pending.promise }],
  });
  assert.equal((await coordinator.snapshot()).session.kind, 'idle');
  pending.resolve(null);
  await coordinator.stop();
});

test('confirmed shutdown does not wait for a blocked account status refresh', { timeout: 1000 }, async () => {
  const pending = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null }, store: store(),
    appServers: [{ id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
      spawn: async () => {}, status: async () => {}, teardown: async () => {},
      forceQuitAccount: async () => ({ lifecycle: 'idle' }), accountStatus: () => pending.promise }],
  });
  await coordinator.snapshot();
  const before = performance.now();
  assert.equal((await coordinator.forceQuitAccountCloud()).session.kind, 'idle');
  assert.ok(performance.now() - before < 250);
  pending.resolve(null);
  await coordinator.stop();
});

test('profile replacement awaits display cleanup even when shutdown already started it', async () => {
  const closing = Promise.withResolvers();
  const release = Promise.withResolvers();
  let activated = false;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      saveProfile: async () => { activated = true; },
      saveServerMode: async () => 'self-hosted',
      openDisplay: async () => ({ capability: { kind: 'available' },
        close: async () => { closing.resolve(); await release.promise; } }),
    }, store: store(),
  });
  await coordinator.openDisplay('session-1', () => {});
  const changing = coordinator.saveProfile({ host: 'cloud.tailnet.ts.net', sshUser: 'test', serverPublicKey: key });
  await closing.promise;
  await tick();
  assert.equal(activated, false);
  release.resolve();
  await changing;
  assert.equal(activated, true);
  await coordinator.stop();
});

test('background recovery keeps a failed banner stable and restores the connection when health returns', async () => {
  let healthy = false;
  const events = [];
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => profile, isPaired: async () => true,
      health: async () => { if (!healthy) throw new Error('offline'); return { ok: true, serverPublicKey: key }; } },
    store: store(),
  });
  coordinator.on('event', (event) => events.push(event.type));
  await coordinator.reconnectCloud();
  events.length = 0;
  assert.equal((await coordinator.reconnectCloud({ background: true })).link.kind, 'failed');
  assert.equal(events.includes('cloud-link-reconnecting'), false);
  healthy = true;
  assert.equal((await coordinator.reconnectCloud({ background: true })).link.kind, 'ready');
  await coordinator.stop();
});

test('healthy server with a lost session offers recovery instead of claiming the chat is connected', async () => {
  const records = [{ id: 'handoff-1', cloudSessionId: 'session-lost', state: 'running',
    threadId: 'current-chat', originDocumentId: 'doc-1', createdAt: new Date().toISOString(),
    destination: { endpoint: profile.endpoint, serverPublicKey: key, mode: profile.mode } }];
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => profile, isPaired: async () => true,
      health: async () => ({ ok: true, serverPublicKey: key }), sessions: async () => [] },
    store: { ...store(), list: async () => records },
  });
  assert.equal((await coordinator.reconnectCloud()).link.kind, 'failed');
  const result = await coordinator.snapshot({ threadId: 'current-chat', documentId: 'doc-1' });
  assert.equal(result.session.sessionId, 'session-lost');
  assert.equal(result.lease.owner, 'cloud', 'ownership is retained until explicit restart or shutdown');
  await coordinator.stop();
});

test('chat selection stays on its thread while the document lease remains with its owner', async () => {
  const records = ['chat-newer', 'chat-current'].map((threadId, index) => ({
    id: `handoff-${index}`, cloudSessionId: `session-${index}`, threadId,
    originDocumentId: 'shared-document', originSessionId: 'window-1', state: 'running',
    documentName: 'shared.hwpx', revision: 1, serverVersion: 1, limits: {},
    createdAt: `2026-09-0${2 - index}T00:00:00.000Z`, timeline: { thread: { id: threadId } },
  }));
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null }, store: { ...store(), list: async () => records },
  });
  const result = await coordinator.snapshot({ documentId: 'shared-document', threadId: 'chat-current' });
  assert.equal(result.session.threadId, 'chat-current');
  assert.equal(result.timeline.thread.id, 'chat-current');
  assert.equal(result.lease.sessionId, 'session-0');
  const threadOnly = await coordinator.snapshot({ threadId: 'chat-current' });
  assert.equal(threadOnly.session.threadId, 'chat-current');
  assert.equal(threadOnly.timeline.thread.id, 'chat-current');
  const unrelated = await coordinator.snapshot({ documentId: 'shared-document', threadId: 'new-chat' });
  assert.equal(unrelated.session.kind, 'idle');
  assert.equal(unrelated.timeline, null);
  assert.equal(unrelated.lease.sessionId, 'session-0');
  await coordinator.stop();
});

test('reconnect discovers the existing remote chat without selecting an unrelated session', async () => {
  const remote = { id: 'remote-1', status: 'running', stateVersion: 4,
    clientContext: { threadId: 'current-chat', documentId: 'doc-1' }, originDocument: { name: 'doc.hwpx' } };
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile, isPaired: async () => true,
      health: async () => ({ ok: true, serverPublicKey: key }), sessions: async () => [remote],
      watchSession: async (_id, _after, { signal }) => waitForAbort(signal),
    }, store: store(),
  });
  await coordinator.reconnectCloud();
  assert.equal((await coordinator.snapshot({ documentId: 'doc-1', threadId: 'current-chat' })).session.sessionId, 'remote-1');
  assert.equal((await coordinator.snapshot({ documentId: 'another-doc', threadId: 'another-chat' })).session.kind, 'idle');
  await coordinator.stop();
});

test('a failed rebuild is retryable after the old profile has been removed; duplicate clicks share one rebuild', async () => {
  const sandbox = { providerId: 'raucloud', sandboxId: 'run-1', host: 'worker.example.test', region: 'test', createdAt: new Date().toISOString() };
  let current = { ...profile, mode: 'app-hosted', sandbox };
  let spawnCalls = 0;
  let teardownCalls = 0;
  let deadWorkerRequests = 0;
  const provider = {
    id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
    accountStatus: async () => null,
    forceQuitAccount: async () => ({ lifecycle: 'idle', status: 'stopped' }),
    status: async () => ({ lifecycle: 'ready' }),
    teardown: async () => { teardownCalls++; return { removed: true }; },
    spawn: async () => {
      spawnCalls++;
      if (spawnCalls === 1) throw new Error('temporary provisioning failure');
      return { sandbox, receipt: { endpoint: 'https://worker.example.test', serverPublicKey: key, pairingCode: 'ABCD' } };
    },
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadServerMode: async () => 'app-hosted', saveServerMode: async (mode) => mode,
      loadProfile: async () => current, isPaired: async () => true,
      forgetProfile: async () => { current = null; },
      activateProfile: async (next) => { current = next; },
      redeemPairingCode: async () => ({ credentials: { device: {} } }),
      health: async () => ({ ok: true, serverPublicKey: key }),
      sessions: async () => { deadWorkerRequests++; return []; },
    }, store: store(), appServers: [provider],
  });
  await coordinator.start();
  const first = coordinator.recreateCloud();
  assert.equal(coordinator.recreateCloud(), first);
  assert.equal((await first).link.kind, 'failed');
  assert.equal(current, null);
  assert.equal((await coordinator.snapshot()).link.canRecreate, true);
  const result = await coordinator.recreateCloud();
  assert.equal(result.link.kind, 'ready');
  assert.equal(spawnCalls, 2);
  assert.equal(teardownCalls, 0);
  assert.equal(deadWorkerRequests, 0);
  await coordinator.stop();
});

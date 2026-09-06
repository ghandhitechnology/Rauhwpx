import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { attachSessionSecretBroker, registerStudioHubSession } from '../document-runtime/studio-harness.mjs';
import { authenticateHubSession, HubSessionRegistry } from '../../rhwp/rhwp-agent/hub-session-registry.mjs';
import { createIpcSecretStore } from '../../rhwp/rhwp-agent/secret-store.mjs';

test('Cloud Studio registers generation-bound capabilities for each hub audience', async (t) => {
  const registry = new HubSessionRegistry();
  const token = 'test-owner-token';
  const sessionId = 'cloud-bootstrap-test';
  let incomplete = false;
  const server = createServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, `/sessions/${sessionId}`);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers['x-rhwp-launch-id'], 'test-launch');
    registry.register(sessionId);
    const capabilities = Object.fromEntries(['studio', 'reference', 'template'].map((audience) =>
      [audience, registry.issue(token, sessionId, { audience })]));
    if (incomplete) delete capabilities.reference;
    response.end(JSON.stringify({ status: 'registered', sessionId, capabilities }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const input = { port: server.address().port, token, sessionId, launchId: 'test-launch' };
  const capabilities = await registerStudioHubSession(input);
  for (const [audience, capability] of Object.entries(capabilities)) {
    assert.equal(authenticateHubSession({ masterToken: token, token: capability, sessionId, audience, registry }), sessionId);
  }
  incomplete = true;
  await assert.rejects(registerStudioHubSession(input), { code: 'AGENT_SESSION_REGISTRATION_FAILED' });
});

function secretChannel() {
  const child = new EventEmitter();
  const processRef = new EventEmitter();
  child.connected = true;
  child.send = (message, callback) => { queueMicrotask(() => processRef.emit('message', message)); callback?.(); };
  processRef.env = { RHWP_SECRET_BROKER: 'ipc' };
  processRef.send = (message, callback) => { queueMicrotask(() => child.emit('message', message)); callback?.(); };
  const dispose = attachSessionSecretBroker(child);
  return { store: createIpcSecretStore({ processRef }), dispose, child };
}

test('Cloud hub secrets stay isolated in memory and clear on session teardown', async () => {
  const first = secretChannel();
  const second = secretChannel();
  try {
    assert.equal(first.store.available, true);
    await first.store.set('provider.key', 'session-secret');
    assert.equal(await first.store.get('provider.key'), 'session-secret');
    assert.equal(await second.store.get('provider.key'), null);
    await first.store.delete('provider.key');
    assert.equal(await first.store.get('provider.key'), null);
    await first.store.set('provider.key', 'replacement');
    await first.store.reset();
    assert.equal(await first.store.get('provider.key'), null);
    await assert.rejects(first.store.set('../invalid', 'value'), { code: 'SECRET_STORE_FAILED' });
  } finally {
    first.dispose();
    second.dispose();
  }
  assert.equal(first.child.listenerCount('message'), 0);
  assert.equal(second.child.listenerCount('message'), 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticateHubSession,
  HubSessionRegistry,
  issueScopedHubToken,
  resolveHubIdentity,
  sessionIdFromScopedHubToken,
} from '../hub-session-registry.mjs';

test('registry keeps mutable tenant state in separate Map records', () => {
  const registry = new HubSessionRegistry();
  const alpha = registry.getOrCreate('alpha');
  const beta = registry.getOrCreate('beta');

  alpha.pendingCalls.set(1, { clientId: 10 });
  alpha.userQuestionResponseReceipts.set('response-1', { ok: true });
  alpha.pendingUserQuestion = { interactionId: 'interaction-1' };
  alpha.mcpSockets.add('alpha-socket');
  alpha.nextCapabilityEpoch++;

  assert.equal(registry.records instanceof Map, true);
  assert.equal(registry.get('alpha'), alpha);
  assert.equal(registry.get('beta'), beta);
  assert.notEqual(alpha, beta);
  assert.equal(beta.pendingCalls.size, 0);
  assert.equal(beta.userQuestionResponseReceipts.size, 0);
  assert.equal(beta.pendingUserQuestion, null);
  assert.equal(beta.mcpSockets.size, 0);
  assert.equal(beta.nextCapabilityEpoch, 1);
});

test('scoped credentials authenticate only their matching session', () => {
  const masterToken = 'production-secret';
  const token = issueScopedHubToken(masterToken, 'window-a');

  assert.equal(sessionIdFromScopedHubToken(token), 'window-a');
  assert.equal(authenticateHubSession({ masterToken, token, sessionId: 'window-a' }), 'window-a');
  assert.throws(
    () => authenticateHubSession({ masterToken, token, sessionId: 'window-b' }),
    { code: 'UNAUTHORIZED_SESSION' },
  );
  assert.equal(
    authenticateHubSession({ masterToken, token: masterToken, sessionId: 'window-b' }),
    'window-b',
  );
  assert.throws(
    () => authenticateHubSession({
      masterToken,
      token: masterToken,
      sessionId: 'window-b',
      allowMaster: false,
    }),
    { code: 'UNAUTHORIZED_SESSION' },
  );
});

test('production requires an env token while direct development has explicit defaults', () => {
  assert.throws(
    () => resolveHubIdentity({ NODE_ENV: 'production' }),
    { code: 'HUB_TOKEN_REQUIRED' },
  );
  assert.deepEqual(
    resolveHubIdentity({ RHWP_AGENT_DEV_TOKEN: 'local-token', RHWP_LAUNCH_ID: 'local-launch' }),
    { token: 'local-token', development: true, launchId: 'local-launch' },
  );
});

test('disposeAll clears the Map and visits every session', async () => {
  const registry = new HubSessionRegistry();
  registry.getOrCreate('alpha');
  registry.getOrCreate('beta');
  const disposed = [];

  await registry.disposeAll(async (record) => disposed.push(record.sessionId));

  assert.deepEqual(disposed.sort(), ['alpha', 'beta']);
  assert.equal(registry.records.size, 0);
});

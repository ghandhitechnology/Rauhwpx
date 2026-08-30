import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  authenticateHubSession,
  HUB_CAPABILITY_AUDIENCES,
  HubSessionRegistry,
  issueScopedHubToken,
  mcpProviderResource,
  resolveHubIdentity,
  sessionIdFromScopedHubToken,
} from '../hub-session-registry.mjs';

function generations(...values) {
  let index = 0;
  return () => values[index++];
}

test('registry creates tenant state only through explicit registration', () => {
  const registry = new HubSessionRegistry({ createGeneration: generations(101, 202) });

  assert.equal(registry.get('alpha'), null);
  assert.throws(() => registry.getOrCreate('alpha'), { code: 'SESSION_NOT_REGISTERED' });

  const alpha = registry.register('alpha');
  const beta = registry.register('beta');
  assert.equal(registry.register('alpha'), alpha);

  alpha.pendingCalls.set(1, { clientId: 10 });
  alpha.userQuestionResponseReceipts.set('response-1', { ok: true });
  alpha.pendingUserQuestion = { interactionId: 'interaction-1' };
  alpha.mcpSockets.add('alpha-socket');
  alpha.nextCapabilityEpoch++;

  assert.equal(registry.records instanceof Map, true);
  assert.equal(registry.getOrCreate('alpha'), alpha);
  assert.equal(registry.get('beta'), beta);
  assert.notEqual(alpha, beta);
  assert.equal(alpha.capabilityGeneration, 101);
  assert.equal(beta.capabilityGeneration, 202);
  assert.equal(beta.pendingCalls.size, 0);
  assert.equal(beta.userQuestionResponseReceipts.size, 0);
  assert.equal(beta.pendingUserQuestion, null);
  assert.equal(beta.mcpSockets.size, 0);
  assert.equal(beta.nextCapabilityEpoch, 1);
});

test('rhwp2 capabilities authenticate only their session and audience', () => {
  const masterToken = 'production-secret';
  const registry = new HubSessionRegistry({ createGeneration: generations(11, 22) });
  registry.register('window-a');
  registry.register('window-b');
  const studioToken = registry.issue(masterToken, 'window-a', {
    audience: HUB_CAPABILITY_AUDIENCES.STUDIO,
  });

  assert.match(studioToken, /^rhwp2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(sessionIdFromScopedHubToken(studioToken), 'window-a');
  assert.equal(
    sessionIdFromScopedHubToken(studioToken, { audience: HUB_CAPABILITY_AUDIENCES.STUDIO }),
    'window-a',
  );
  assert.equal(
    sessionIdFromScopedHubToken(studioToken, { audience: HUB_CAPABILITY_AUDIENCES.MCP }),
    null,
  );
  assert.equal(registry.authenticate({
    masterToken,
    token: studioToken,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.STUDIO,
  }), 'window-a');
  assert.throws(() => registry.authenticate({
    masterToken,
    token: studioToken,
    sessionId: 'window-b',
    audience: HUB_CAPABILITY_AUDIENCES.STUDIO,
  }), { code: 'UNAUTHORIZED_SESSION' });
  assert.throws(() => registry.authenticate({
    masterToken,
    token: studioToken,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.MCP,
  }), { code: 'UNAUTHORIZED_SESSION' });
});

test('master credentials need an explicit policy and cannot create sessions', () => {
  const masterToken = 'production-secret';
  const registry = new HubSessionRegistry({ createGeneration: generations(11) });
  registry.register('window-a');

  assert.throws(() => authenticateHubSession({
    masterToken,
    token: masterToken,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.STUDIO,
    registry,
  }), { code: 'UNAUTHORIZED_SESSION' });
  assert.equal(authenticateHubSession({
    masterToken,
    token: masterToken,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.STUDIO,
    registry,
    allowMaster: true,
  }), 'window-a');
  assert.throws(() => authenticateHubSession({
    masterToken,
    token: masterToken,
    sessionId: 'window-b',
    audience: HUB_CAPABILITY_AUDIENCES.STUDIO,
    registry,
    allowMaster: true,
  }), { code: 'UNAUTHORIZED_SESSION' });
  assert.throws(() => authenticateHubSession({
    masterToken: '',
    token: '',
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.STUDIO,
    registry,
    allowMaster: true,
  }), { code: 'HUB_TOKEN_REQUIRED' });
  assert.equal(registry.get('window-b'), null);
});

test('resource capabilities enforce exact resource and expiration', () => {
  const masterToken = 'production-secret';
  const registry = new HubSessionRegistry({ createGeneration: generations(31) });
  registry.register('window-a');
  const artifactToken = registry.issue(masterToken, 'window-a', {
    audience: HUB_CAPABILITY_AUDIENCES.ARTIFACT,
    resource: 'artifact_123',
    expiresAt: 50_000,
  });

  assert.equal(registry.authenticate({
    masterToken,
    token: artifactToken,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.ARTIFACT,
    resource: 'artifact_123',
    now: 49_999,
  }), 'window-a');
  assert.throws(() => registry.authenticate({
    masterToken,
    token: artifactToken,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.ARTIFACT,
    resource: 'artifact_456',
    now: 49_999,
  }), { code: 'UNAUTHORIZED_SESSION' });
  assert.throws(() => registry.authenticate({
    masterToken,
    token: artifactToken,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.ARTIFACT,
    resource: 'artifact_123',
    now: 50_000,
  }), { code: 'UNAUTHORIZED_SESSION' });
  assert.throws(() => registry.issue(masterToken, 'window-a', {
    audience: HUB_CAPABILITY_AUDIENCES.ARTIFACT,
  }), { code: 'CAPABILITY_RESOURCE_REQUIRED' });
  assert.throws(() => registry.issue(masterToken, 'window-a', {
    audience: HUB_CAPABILITY_AUDIENCES.STUDIO,
    resource: 'provider-1',
  }), { code: 'CAPABILITY_RESOURCE_FORBIDDEN' });
});

test('MCP provider resources bind agent, root role, and agent-session generation', () => {
  const masterToken = 'production-secret';
  const registry = new HubSessionRegistry({ createGeneration: generations(33) });
  registry.register('window-a');
  const resource = mcpProviderResource({ agent: 'claude', role: 'chat', generation: 7 });
  const token = registry.issue(masterToken, 'window-a', {
    audience: HUB_CAPABILITY_AUDIENCES.MCP,
    resource,
  });

  assert.equal(resource, 'provider.7.claude.chat');
  assert.equal(registry.authenticate({
    masterToken,
    token,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.MCP,
    resource,
  }), 'window-a');
  for (const mismatch of [
    mcpProviderResource({ agent: 'pi', role: 'chat', generation: 7 }),
    mcpProviderResource({ agent: 'claude', role: 'chat', generation: 8 }),
  ]) {
    assert.throws(() => registry.authenticate({
      masterToken,
      token,
      sessionId: 'window-a',
      audience: HUB_CAPABILITY_AUDIENCES.MCP,
      resource: mismatch,
    }), { code: 'UNAUTHORIZED_SESSION' });
  }
  assert.throws(
    () => mcpProviderResource({ agent: 'claude', role: 'subagent', generation: 7 }),
    { code: 'INVALID_MCP_PROVIDER_ROLE' },
  );
  assert.throws(
    () => mcpProviderResource({ agent: '../pi', role: 'chat', generation: 7 }),
    { code: 'INVALID_MCP_PROVIDER' },
  );
});

test('copy-layout worker capabilities cannot be downgraded to a normal MCP role', () => {
  const masterToken = 'production-secret';
  const registry = new HubSessionRegistry({ createGeneration: generations(35) });
  registry.register('window-a');
  const workerToken = registry.issue(masterToken, 'window-a', {
    audience: HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER,
    resource: 'job-123',
  });

  assert.equal(registry.authenticate({
    masterToken,
    token: workerToken,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER,
    resource: 'job-123',
  }), 'window-a');
  assert.throws(() => registry.authenticate({
    masterToken,
    token: workerToken,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.MCP,
  }), { code: 'UNAUTHORIZED_SESSION' });
  assert.throws(() => registry.authenticate({
    masterToken,
    token: workerToken,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER,
    resource: 'job-456',
  }), { code: 'UNAUTHORIZED_SESSION' });
  assert.throws(() => registry.issue(masterToken, 'window-a', {
    audience: HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER,
  }), { code: 'CAPABILITY_RESOURCE_REQUIRED' });
});

test('generation rotation, deletion, and re-registration revoke old capabilities', () => {
  const masterToken = 'production-secret';
  const registry = new HubSessionRegistry({ createGeneration: generations(41, 42, 43) });
  registry.register('window-a');
  const first = registry.issue(masterToken, 'window-a', {
    audience: HUB_CAPABILITY_AUDIENCES.MCP,
  });

  assert.equal(registry.rotate('window-a'), 42);
  assert.throws(() => registry.authenticate({
    masterToken,
    token: first,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.MCP,
  }), { code: 'UNAUTHORIZED_SESSION' });

  const second = registry.issue(masterToken, 'window-a', {
    audience: HUB_CAPABILITY_AUDIENCES.MCP,
  });
  registry.delete('window-a');
  assert.throws(() => registry.authenticate({
    masterToken,
    token: second,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.MCP,
  }), { code: 'UNAUTHORIZED_SESSION' });

  registry.register('window-a');
  assert.equal(registry.get('window-a').capabilityGeneration, 43);
  assert.throws(() => registry.authenticate({
    masterToken,
    token: second,
    sessionId: 'window-a',
    audience: HUB_CAPABILITY_AUDIENCES.MCP,
  }), { code: 'UNAUTHORIZED_SESSION' });
});

test('re-registration cannot reuse a retired generation', () => {
  const registry = new HubSessionRegistry({ createGeneration: generations(91, 91, 92) });
  registry.register('window-a');
  registry.delete('window-a');

  assert.equal(registry.register('window-a').capabilityGeneration, 92);
});

test('tampered and malformed capabilities are rejected', () => {
  const masterToken = 'production-secret';
  const registry = new HubSessionRegistry({ createGeneration: generations(51) });
  registry.register('window-a');
  const token = registry.issue(masterToken, 'window-a', {
    audience: HUB_CAPABILITY_AUDIENCES.REFERENCE,
  });
  const [prefix, payload, mac] = token.split('.');
  const tamperedMac = `${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`;
  const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
  const nonCanonicalPayload = Buffer.from(
    JSON.stringify({ aud: 'reference', gen: 51, sid: 'window-a' }),
    'utf8',
  ).toString('base64url');
  const nonCanonicalMac = crypto
    .createHmac('sha256', masterToken)
    .update(`rhwp2.${nonCanonicalPayload}`)
    .digest('base64url');

  for (const invalid of [
    `${prefix}.${payload}.${tamperedMac}`,
    `${prefix}.${tamperedPayload}.${mac}`,
    `${prefix}.${nonCanonicalPayload}.${nonCanonicalMac}`,
    'rhwp1.d2luZG93LWE.invalid',
    'rhwp2.!!!.invalid',
  ]) {
    assert.throws(() => registry.authenticate({
      masterToken,
      token: invalid,
      sessionId: 'window-a',
      audience: HUB_CAPABILITY_AUDIENCES.REFERENCE,
    }), { code: 'UNAUTHORIZED_SESSION' });
  }
  // This helper only extracts an embedded session ID for a child process. The
  // hub still verifies the MAC before it trusts that ID.
  assert.equal(sessionIdFromScopedHubToken(`${prefix}.${payload}.${tamperedMac}`), 'window-a');
  assert.equal(sessionIdFromScopedHubToken(`${prefix}.${tamperedPayload}.${mac}`), null);
  assert.equal(sessionIdFromScopedHubToken(`${prefix}.${nonCanonicalPayload}.${nonCanonicalMac}`), null);
  assert.equal(sessionIdFromScopedHubToken('rhwp1.d2luZG93LWE.invalid'), null);
  assert.equal(sessionIdFromScopedHubToken('rhwp2.!!!.invalid'), null);
});

test('session and resource inputs reject unsafe spellings', () => {
  const registry = new HubSessionRegistry({ createGeneration: generations(61) });
  for (const sessionId of ['', '../other', 'window/a', 'window:a', 'window a', 'a'.repeat(129)]) {
    assert.throws(() => registry.register(sessionId), { code: 'INVALID_SESSION_ID' });
  }
  registry.register('window-a');
  for (const resource of ['', '../artifact', 'artifact/1', 'artifact 1', 'a'.repeat(257)]) {
    assert.throws(() => registry.issue('master', 'window-a', {
      audience: HUB_CAPABILITY_AUDIENCES.ARTIFACT,
      resource,
    }), { code: 'INVALID_CAPABILITY_RESOURCE' });
  }
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

test('disposeAll clears the Map and visits every registered session', async () => {
  const registry = new HubSessionRegistry({ createGeneration: generations(71, 72) });
  registry.register('alpha');
  registry.register('beta');
  const disposed = [];

  await registry.disposeAll(async (record) => disposed.push(record.sessionId));

  assert.deepEqual(disposed.sort(), ['alpha', 'beta']);
  assert.equal(registry.records.size, 0);
});

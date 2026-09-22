import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import test from 'node:test';
import { AuthRunRegistry } from '../auth-run-registry.mjs';

// Run the production entrypoints without starting the hub, touching a vault, or
// opening a browser. These slices are executed, rather than pattern-asserted.
const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
function between(start, end) {
  const first = server.indexOf(start);
  const last = server.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing server boundary: ${start}`);
  return server.slice(first, last);
}
const accountLogin = between('function beginAccountLogin(', '\nfunction resolveModel(');
const accountCases = between("    case 'account-login':", "    case 'account-login-cancel':");
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise(setImmediate); };

function fixture(t, { signedIn = false, onFrame = null } = {}) {
  const frames = [];
  const calls = { start: [], complete: [], sync: 0 };
  let active = null;
  let status = { state: signedIn ? 'signed-in' : 'signed-out', signedIn, account: signedIn ? { email: 'user@example.test' } : null, provider: { state: 'ready' } };
  const authRuns = new AuthRunRegistry();
  const accountSession = {
    status: async () => status,
    startLogin: async (options) => {
      if (active) throw Object.assign(new Error('Account login already in progress'), { code: 'ACCOUNT_LOGIN_BUSY' });
      calls.start.push(options);
      active = { loginId: 'login-1', authUrl: 'https://example.test/auth', pairingCode: 'ABCDEF', expiresAt: '2099-01-01T00:00:00Z' };
      return active;
    },
    completeLogin: async (id, proof, options) => {
      assert.equal(id, active?.loginId);
      calls.complete.push({ id, proof });
      options.onCommitted();
      active = null;
      status = { ...status, state: 'signed-in', signedIn: true, account: { email: 'user@example.test' } };
      return status;
    },
    cancelLogin: async () => { active = null; },
    synchronizeProvider: async () => { calls.sync += 1; return status; },
  };
  const push = (frame) => frames.push(frame);
  const context = vm.createContext({
    AbortController, crypto, authRuns, accountSession,
    KNOWN_AGENTS: new Set(['rau', 'pi']), CLI_SETUP_AGENTS: [],
    hubPort: 12345, PROTOCOL_VERSION: 1,
    agentAuthCancelled: (message = 'Cancelled') => Object.assign(new Error(message), { code: 'AGENT_AUTH_CANCELLED' }),
    boundedAgentAuthCode: (code) => String(code).trim(),
    replyToStudio: (_record, _sock, frame) => {
      push(frame);
      onFrame?.(frame, authRuns);
    },
    sendAccountRunFrame: (_run, frame) => push(frame),
    sendAuthRunFrame: (_run, frame) => push(frame),
    sendAccountRunError: (_run, error) => push({ type: 'account-error', code: error.code, message: error.message }),
    sendAuthRunError: (_run, error) => push({ type: 'agent-setup-error', code: error.code, message: error.message }),
    sendAgentSetupError: (_record, _sock, _id, _agent, error) => push({ type: 'agent-setup-error', code: error.code, message: error.message }),
    broadcastAccountStatus: async () => push({ type: 'account-status', status }),
    broadcastFreshAgentSetupStatuses: async () => push({ type: 'agent-setup-status' }),
    rauCredits: { createDeviceSessionV2: async () => ({ id: 'legacy-provider-login', codeVerifier: 'verifier', loginUrl: 'https://example.test/legacy' }) },
    rauManager: { cancelSetup: async () => {}, status: async () => ({ installed: true, authenticated: true }) },
    rauStatus: { installed: true, authenticated: true },
    piManager: { status: async () => ({}) }, piStatus: {},
    refreshOpenRouterCredits: async () => {}, usageSnapshot: () => ({}), log: () => {},
  });
  vm.runInContext(`${accountLogin}\nfunction dispatch(msg, record, sock) { switch (msg.type) { ${accountCases} } }`, context);
  t.after(() => authRuns.cancelForSession('studio-1'));
  return {
    frames, calls, authRuns,
    send: (msg) => context.dispatch(msg, { sessionId: 'studio-1' }, {}),
  };
}
const entry = { type: 'account-login', requestId: 'request-1' };

test('account login installs its callback waiter before publishing the browser URL', async (t) => {
  let completedFromCallback = false;
  const f = fixture(t, {
    onFrame(frame, authRuns) {
      if (frame.type !== 'account-login-started') return;
      const run = authRuns.get('account');
      assert.equal(typeof run?.submitProof, 'function');
      run.submitProof({ kind: 'loopback', code: 'instant-callback' });
      completedFromCallback = true;
    },
  });
  f.send(entry);
  await flush();
  assert.equal(completedFromCallback, true);
  assert.equal(f.calls.complete.length, 1, JSON.stringify(f.frames));
  assert.equal(f.calls.complete[0].proof.kind, 'loopback');
  assert.equal(f.calls.complete[0].proof.code, 'instant-callback');
});

test('account entrypoint commits the account using its manual callback', async (t) => {
  const f = fixture(t);
  f.send(entry);
  await flush();
  assert.equal(f.calls.start.length, 1, JSON.stringify(f.frames));
  assert.equal(f.calls.start[0].redirectUri, 'http://127.0.0.1:12345/oauth/account/callback');
  assert.equal(f.calls.start[0].returnMode, 'hybrid');
  const run = f.authRuns.get('account');
  assert.ok(run);
  f.send({ type: 'account-auth-code', authRunId: run.runId, code: 'manual-code' });
  await flush();
  assert.equal(f.calls.complete.length, 1, JSON.stringify(f.frames));
  assert.equal(f.calls.complete[0].proof.kind, 'manual');
  assert.equal(f.calls.complete[0].proof.code, 'manual-code');
  assert.equal(f.authRuns.get('account'), null);
  assert.ok(f.frames.some((frame) => frame.type === 'account-status' && frame.status.signedIn));
});

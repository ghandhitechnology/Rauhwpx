import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const agentDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readSource(name) {
  return fs.readFile(path.join(agentDir, name), 'utf8');
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} is missing`);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

test('the server owns one generic account-session module behind the Rau backend adapter', async () => {
  const server = await readSource('server.mjs');
  const account = await readSource('account-session.mjs');
  const provider = await readSource('pi-manager.mjs');

  assert.match(server, /const accountSession = createAccountSession\(\{\s*secretStore,\s*creditsClient: rauCredits,\s*\}\)/);
  assert.match(account, /function createRauAccountBackendAdapter\([\s\S]+creditsClient\.createAccountDeviceSessionV2/);
  assert.doesNotMatch(account, /export function createRauAccountBackendAdapter/);
  assert.match(account, /ACCOUNT_SESSION_SECRET_ID = 'rhwp\.account\.session-token'/);
  assert.match(provider, /RAU_SECRET_ID = 'rhwp\.rau\.openrouter-api-key'/);
  assert.doesNotMatch(account, /cloud|quota|allowance/i);
});

test('account login keeps AuthRunRegistry ownership and commit-before-remote-activation fences', async () => {
  const server = await readSource('server.mjs');
  const account = await readSource('account-session.mjs');
  const login = sourceBetween(server, 'function beginAccountLogin(', '\nfunction resolveModel(');
  const completion = sourceBetween(account, '    completeLogin(', '\n    async cancelLogin(');

  assert.match(login, /authRuns\.begin\(\{\s*agent: 'account',\s*ownerSessionId: record\.sessionId/);
  assert.match(login, /const isLiveAuthRun = \(\) => !abort\.signal\.aborted && authRuns\.get\('account'\) === authRun/);
  assert.match(login, /if \(!isLiveAuthRun\(\) \|\| !authRuns\.finish\(authRun\)\) throw agentAuthCancelled\(\)/);
  assert.match(login, /accountSession\.completeLogin\([^;]+signal: abort\.signal,[^;]+onCommitted: commitAuthRun/s);
  assert.ok(completion.indexOf('await secretStore.set(secretId, newToken)')
    < completion.indexOf('await onCommitted()'));
  assert.ok(completion.indexOf('await onCommitted()')
    < completion.indexOf('await ownedBackend.commitSession(newToken'));
  assert.ok(completion.indexOf('await ownedBackend.commitSession(newToken')
    < completion.indexOf('await ownedBackend.acknowledgeLogin'));
});

test('account cancellation aborts completion, cancels V2 remotely, and is owner-scoped', async () => {
  const server = await readSource('server.mjs');
  const account = await readSource('account-session.mjs');
  const client = await readSource('rau-credits-client.mjs');
  const handlers = sourceBetween(server, "    case 'account-status-request':", "    case 'agent-setup-status-request':");
  const cancellation = sourceBetween(
    client,
    '    cancelDeviceSessionV2(',
    '\n    readAccountSession(',
  );

  assert.match(account, /'cancelLogin',[\s\S]+attempt\.abort\.abort\(\)[\s\S]+ownedBackend\.cancelLogin\(attempt\.handle\)/);
  assert.match(cancellation, /\/cancel`/);
  assert.match(cancellation, /JSON\.stringify\(\{ codeVerifier \}\)/);
  assert.match(handlers, /case 'account-auth-code':[\s\S]+authRuns\.requireOwned\(\{[\s\S]+agent: 'account'/);
  assert.match(handlers, /case 'account-login-cancel':[\s\S]+authRuns\.cancelOwned\(\{[\s\S]+ownerSessionId: record\.sessionId/);
  assert.match(server, /authRuns\.cancelForSession\(sessionId, 'owner-session-closed'\)/);
});

test('account websocket frames expose sanitized status and proof metadata, never credentials', async () => {
  const server = await readSource('server.mjs');
  const accountFrames = sourceBetween(server, 'async function accountStatusForOwner(', '\nfunction resolveModel(');
  const handlers = sourceBetween(server, "    case 'account-status-request':", "    case 'agent-setup-status-request':");
  const callback = sourceBetween(
    server,
    "    if (req.method === 'GET' && url.pathname === '/oauth/account/callback')",
    "    if (req.method === 'GET' && url.pathname === '/oauth/rau/callback')",
  );

  for (const source of [accountFrames, handlers]) {
    assert.doesNotMatch(source, /accountToken|Authorization|rau_account_v1_/);
  }
  assert.match(callback, /timingSafeTextEqual\(state, authRun\.callbackState \?\? ''\)/);
  assert.match(callback, /authRun\.submitProof\(\{ kind: 'loopback', code \}\)/);
  assert.match(callback, /'cache-control': 'no-store'/);
});

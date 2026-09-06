import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccountSession, createMemoryAccountBackendAdapter, ACCOUNT_SESSION_SECRET_ID } from '../account-session.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';
import { createRauAccountSession, RAU_ACCOUNT_LINK_SECRET_ID } from '../rau-account-session.mjs';

const PROVIDER_SECRET = 'rhwp.rau.openrouter-api-key';
const oldToken = `rau_account_v1_${'a'.repeat(43)}`;
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture({ initial = {}, initialSessions = [], authorize, installed = true } = {}) {
  const secretStore = createMemorySecretStore(initial);
  const events = [];
  const requests = [];
  const backend = createMemoryAccountBackendAdapter({
    account: { email: 'new@example.com' },
    initialSessions,
    async authorize(identity, request) {
      requests.push(request);
      return authorize ? authorize(identity, request) : { apiKey: 'sk-or-new-key', email: identity.account.email };
    },
  });
  const manager = {
    async status() { return { installed, authenticated: Boolean(await secretStore.get(PROVIDER_SECRET)) }; },
    async clearApiKey() { await secretStore.delete(PROVIDER_SECRET); return this.status(); },
    async setApiKey(key, { signal, account }) {
      assert.equal(signal.aborted, false);
      assert.equal(account, 'new@example.com');
      await secretStore.set(PROVIDER_SECRET, key);
      return this.status();
    },
  };
  function restart(options = {}) {
    return createRauAccountSession({
      accountSession: createAccountSession({ secretStore, backend }),
      rauManager: manager,
      secretStore,
      onProviderChanged: (status, details) => events.push({ status, ...details }),
      ...options,
    });
  }
  return { session: restart(), restart, secretStore, backend, manager, events, requests };
}

async function login(session, options = {}) {
  const started = await session.startLogin();
  return session.completeLogin(started.loginId, { kind: 'manual', code: 'ABCD' }, options);
}

test('Cloud and Rau entry points complete the same account and provider transaction', async () => {
  for (const source of ['cloud', 'rau']) {
    const f = fixture();
    const started = await f.session.startLogin({ source });
    const status = await f.session.completeLogin(started.loginId, { kind: 'manual', code: 'ABCD' });
    assert.equal(status.signedIn, true);
    assert.deepEqual(status.provider, { state: 'ready' });
    assert.equal((await f.manager.status()).authenticated, true);
    assert.match(await f.secretStore.get(ACCOUNT_SESSION_SECRET_ID), /^rau_account_v1_/);
    assert.equal(await f.secretStore.get(RAU_ACCOUNT_LINK_SECRET_ID), 'linked');
    assert.deepEqual(f.requests, [{ pathname: '/v2/account-session/provider', method: 'POST' }]);
    assert.doesNotMatch(JSON.stringify(status), /sk-or|rau_account_v1_/);
    assert.doesNotMatch(JSON.stringify(f.events), /sk-or|rau_account_v1_/);
  }
});

test('restart restores the shared account and ordinary status polling provisions once', async () => {
  const f = fixture();
  await login(f.session);
  f.requests.length = 0;
  const restarted = f.restart();
  const statuses = await Promise.all([restarted.status(), restarted.status(), restarted.status()]);
  assert.ok(statuses.every((status) => status.signedIn && status.provider.state === 'ready'));
  assert.equal(f.requests.length, 1);
});

test('a transient provisioning failure preserves account sign-in and explicit retry is deduplicated', async () => {
  let unavailable = true;
  const f = fixture({ authorize: async () => {
    if (unavailable) throw new Error('private backend response sk-or-secret');
    return { apiKey: 'sk-or-new-key' };
  } });
  const status = await login(f.session);
  assert.equal(status.signedIn, true);
  assert.deepEqual(status.provider, { state: 'error', error: 'RAU_ACCOUNT_PROVIDER_UNAVAILABLE' });
  await f.session.status();
  await f.session.status();
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(f.events), /private backend|sk-or-secret/);
  unavailable = false;
  const [a, b] = await Promise.all([f.session.synchronizeProvider(), f.session.synchronizeProvider()]);
  assert.equal(a.provider.state, 'ready');
  assert.deepEqual(a, b);
  assert.equal(f.requests.length, 2);
});

test('a failed account switch removes the old provider key before provisioning', async () => {
  const f = fixture({
    initial: { [ACCOUNT_SESSION_SECRET_ID]: oldToken, [PROVIDER_SECRET]: 'sk-or-old-key' },
    initialSessions: [{ token: oldToken, account: { email: 'old@example.com' } }],
    authorize: async () => {
      assert.equal(await f.secretStore.get(PROVIDER_SECRET), null);
      throw new Error('backend offline');
    },
  });
  const status = await login(f.session);
  assert.equal(status.account.email, 'new@example.com');
  assert.equal(status.signedIn, true);
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), null);
});

test('failure to clear an old key prevents committing the replacement account', async () => {
  const f = fixture({
    initial: { [ACCOUNT_SESSION_SECRET_ID]: oldToken, [PROVIDER_SECRET]: 'sk-or-old-key' },
    initialSessions: [{ token: oldToken, account: { email: 'old@example.com' } }],
  });
  f.manager.clearApiKey = async () => { throw new Error('vault locked'); };
  await assert.rejects(login(f.session), /vault locked/);
  assert.equal(await f.secretStore.get(ACCOUNT_SESSION_SECRET_ID), oldToken);
  assert.equal(f.requests.length, 0);
});

test('signed-out status preserves legacy provider-only keys and clears persisted account-linked keys', async () => {
  const legacy = fixture({ initial: { [PROVIDER_SECRET]: 'sk-or-legacy' } });
  assert.equal((await legacy.session.status()).signedIn, false);
  assert.equal(await legacy.secretStore.get(PROVIDER_SECRET), 'sk-or-legacy');
  const linked = fixture({ initial: {
    [ACCOUNT_SESSION_SECRET_ID]: oldToken,
    [PROVIDER_SECRET]: 'sk-or-old-key',
    [RAU_ACCOUNT_LINK_SECRET_ID]: 'linked',
  }, initialSessions: [{ token: oldToken, status: 'revoked' }] });
  assert.equal((await linked.restart().status()).state, 'signed-out');
  assert.equal(await linked.secretStore.get(PROVIDER_SECRET), null);
  assert.equal(await linked.secretStore.get(RAU_ACCOUNT_LINK_SECRET_ID), null);
});

test('transient account status failure retains the linked provider key', async () => {
  const f = fixture();
  await login(f.session);
  f.backend.readStatus = async () => { throw new Error('offline'); };
  assert.equal((await f.session.status()).state, 'unknown');
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), 'sk-or-new-key');
});

test('logout clears both credentials and restart does not restore them', async () => {
  const f = fixture();
  await login(f.session);
  const status = await f.session.logout();
  assert.equal(status.state, 'signed-out');
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), null);
  assert.equal(await f.secretStore.get(ACCOUNT_SESSION_SECRET_ID), null);
  assert.equal((await f.restart().status()).signedIn, false);
  assert.equal(f.requests.length, 1);
});

test('failed remote logout leaves the provider cleared and suppresses automatic relink across restart', async () => {
  const f = fixture();
  await login(f.session);
  f.backend.revokeSession = async () => { throw new Error('offline revoke'); };
  await assert.rejects(f.session.logout(), /offline revoke/);
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), null);
  assert.equal(await f.secretStore.get(RAU_ACCOUNT_LINK_SECRET_ID), 'logout-pending');
  assert.equal((await f.restart().status()).provider.state, 'signed-out');
  assert.equal(f.requests.length, 1);
  assert.equal((await f.session.synchronizeProvider()).provider.state, 'ready');
});

test('logout invalidates an in-flight provisioning result before it can publish a key', async () => {
  const entered = deferred();
  const response = deferred();
  const f = fixture({ authorize: async () => { entered.resolve(); return response.promise; } });
  const signingIn = login(f.session);
  await entered.promise;
  const signingOut = f.session.logout();
  response.resolve({ apiKey: 'sk-or-stale' });
  await Promise.all([signingIn, signingOut]);
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), null);
  assert.equal(await f.secretStore.get(ACCOUNT_SESSION_SECRET_ID), null);
  assert.equal(f.events.some((event) => event.status?.authenticated), false);
});

test('cancelling a pending redemption prevents both account and provider publication', async () => {
  const entered = deferred();
  const proceed = deferred();
  const f = fixture();
  const redeem = f.backend.redeemLogin;
  f.backend.redeemLogin = async (...args) => {
    const redeemed = await redeem(...args);
    entered.resolve();
    await proceed.promise;
    return redeemed;
  };
  const started = await f.session.startLogin();
  const completion = f.session.completeLogin(started.loginId, {});
  const rejection = assert.rejects(completion, { code: 'ACCOUNT_LOGIN_CANCELLED' });
  await entered.promise;
  await f.session.cancelLogin(started.loginId);
  proceed.resolve();
  await rejection;
  assert.equal(await f.secretStore.get(ACCOUNT_SESSION_SECRET_ID), null);
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), null);
  assert.equal(f.requests.length, 0);
});

test('cancellation after account commit stops linking while preserving successful account sign-in', async () => {
  const entered = deferred();
  const proceed = deferred();
  const f = fixture({ authorize: async () => { entered.resolve(); return proceed.promise; } });
  const started = await f.session.startLogin();
  const completion = f.session.completeLogin(started.loginId, {});
  await entered.promise;
  await f.session.cancelLogin(started.loginId);
  proceed.resolve({ apiKey: 'sk-or-cancelled' });
  assert.equal((await completion).signedIn, true);
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), null);
});

test('provider installation failure is sanitized and does not undo the committed account', async () => {
  const f = fixture({ installed: false });
  let installs = 0;
  const session = f.restart({ installProvider: async () => { installs += 1; throw new Error('npm private details'); } });
  const status = await login(session);
  assert.equal(status.signedIn, true);
  assert.equal(status.provider.error, 'RAU_ACCOUNT_PROVIDER_UNAVAILABLE');
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), 'sk-or-new-key');
  assert.equal(installs, 1);
  await session.status();
  assert.equal(installs, 1);
});

test('logout cancels a start that has not yet returned its login id', async () => {
  const entered = deferred();
  const proceed = deferred();
  const f = fixture();
  const start = f.backend.startLogin;
  f.backend.startLogin = async (...args) => {
    const value = await start(...args);
    entered.resolve();
    await proceed.promise;
    return value;
  };
  const starting = f.session.startLogin();
  const rejection = assert.rejects(starting, { code: 'ACCOUNT_LOGIN_CANCELLED' });
  await entered.promise;
  const logout = f.session.logout();
  proceed.resolve();
  await Promise.all([rejection, logout]);
  assert.equal(f.backend.inspect().logins.size, 0);
});

test('invalid proof remains cancellable by logout', async () => {
  const f = fixture();
  f.backend.redeemLogin = async () => {
    throw Object.assign(new Error('invalid proof'), { code: 'DEVICE_PROOF_INVALID' });
  };
  const started = await f.session.startLogin();
  await assert.rejects(f.session.completeLogin(started.loginId, {}), { code: 'DEVICE_PROOF_INVALID' });
  assert.equal(f.backend.inspect().logins.size, 1);
  await f.session.logout();
  assert.equal(f.backend.inspect().logins.size, 0);
});

test('a replacement completion discards the previous in-flight provider response', async () => {
  const entered = deferred();
  const proceed = deferred();
  let calls = 0;
  const f = fixture({ authorize: async () => {
    calls += 1;
    if (calls === 1) { entered.resolve(); return proceed.promise; }
    return { apiKey: 'sk-or-replacement' };
  } });
  const first = await f.session.startLogin();
  const replacement = await f.session.startLogin();
  const firstCompletion = f.session.completeLogin(first.loginId, {});
  await entered.promise;
  const replacementCompletion = f.session.completeLogin(replacement.loginId, {});
  proceed.resolve({ apiKey: 'sk-or-stale' });
  await firstCompletion;
  assert.equal((await replacementCompletion).provider.state, 'ready');
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), 'sk-or-replacement');
  assert.equal(f.events.filter((event) => event.status?.authenticated).length, 1);
});

test('logout clears even a manager write that completes after cancellation', async () => {
  const entered = deferred();
  const proceed = deferred();
  const f = fixture();
  f.manager.setApiKey = async (key) => {
    entered.resolve();
    await proceed.promise;
    await f.secretStore.set(PROVIDER_SECRET, key);
    return f.manager.status();
  };
  const signingIn = login(f.session);
  await entered.promise;
  const logout = f.session.logout();
  proceed.resolve();
  await Promise.all([signingIn, logout]);
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), null);
  assert.equal(f.events.some((event) => event.status?.authenticated), false);
});

test('restoring a signed-in account schedules missing provider installation once', async () => {
  const f = fixture({ installed: false });
  await login(f.session);
  let installs = 0;
  const restarted = f.restart({ installProvider: async () => { installs += 1; } });
  assert.equal((await restarted.status()).provider.state, 'ready');
  await restarted.status();
  assert.equal(installs, 1);
});

test('provider processes stop before clearing the previous key or publishing a replacement', async () => {
  const entered = deferred();
  const stopped = deferred();
  const order = [];
  const f = fixture({
    initial: { [ACCOUNT_SESSION_SECRET_ID]: oldToken, [PROVIDER_SECRET]: 'sk-or-old-key' },
    initialSessions: [{ token: oldToken, account: { email: 'old@example.com' } }],
  });
  const clear = f.manager.clearApiKey.bind(f.manager);
  f.manager.clearApiKey = async () => { order.push('clear'); return clear(); };
  const session = f.restart({ beforeProviderChange: async () => {
    order.push('stopping');
    entered.resolve();
    await stopped.promise;
    order.push('stopped');
  } });
  const completion = login(session);
  await entered.promise;
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), 'sk-or-old-key');
  assert.equal(f.requests.length, 0);
  assert.deepEqual(order, ['stopping']);
  stopped.resolve();
  assert.equal((await completion).provider.state, 'ready');
  assert.deepEqual(order, ['stopping', 'stopped', 'clear']);
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), 'sk-or-new-key');
});

test('failure to stop a provider process blocks replacement account commit and key provisioning', async () => {
  const f = fixture({
    initial: { [ACCOUNT_SESSION_SECRET_ID]: oldToken, [PROVIDER_SECRET]: 'sk-or-old-key' },
    initialSessions: [{ token: oldToken, account: { email: 'old@example.com' } }],
  });
  let clears = 0;
  f.manager.clearApiKey = async () => { clears += 1; };
  const failure = new Error('Rau backend could not stop');
  const session = f.restart({ beforeProviderChange: async () => { throw failure; } });
  await assert.rejects(login(session), failure);
  assert.equal(clears, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(await f.secretStore.get(ACCOUNT_SESSION_SECRET_ID), oldToken);
  assert.equal(await f.secretStore.get(PROVIDER_SECRET), 'sk-or-old-key');
  assert.equal((await f.backend.readStatus(oldToken)).signedIn, true);
});

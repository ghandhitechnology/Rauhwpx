import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_SESSION_SECRET_ID,
  createAccountSession,
  createMemoryAccountBackendAdapter,
} from '../account-session.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';

const RAU_PROVIDER_SECRET_ID = 'rhwp.rau.openrouter-api-key';

function token(character) {
  return `rau_account_v1_${character.repeat(43)}`;
}

async function logIn(session, options = {}) {
  const started = await session.startLogin();
  return session.completeLogin(started.loginId, { kind: 'manual', code: 'ABCD' }, options);
}

test('the account module keeps its credential separate and authorizes without exposing it', async () => {
  const backend = createMemoryAccountBackendAdapter({
    account: { email: 'Andy@Example.com' },
    authorize: async (identity, request) => ({ identity, request }),
  });
  const secretStore = createMemorySecretStore({ [RAU_PROVIDER_SECRET_ID]: 'sk-or-v1-provider' });
  const session = createAccountSession({ secretStore, backend });

  const status = await logIn(session);
  assert.deepEqual(status.account, { email: 'andy@example.com' });
  assert.equal(status.signedIn, true);
  assert.equal(JSON.stringify(status).includes('rau_account_v1_'), false);
  assert.equal(await secretStore.get(RAU_PROVIDER_SECRET_ID), 'sk-or-v1-provider');
  assert.notEqual(ACCOUNT_SESSION_SECRET_ID, RAU_PROVIDER_SECRET_ID);

  const authorized = await session.authorizeOwnedBackend({ pathname: '/owned/profile' });
  assert.deepEqual(authorized.identity, { account: { email: 'andy@example.com' } });
  assert.deepEqual(authorized.request, { pathname: '/owned/profile' });
});

test('status stays sanitized when the encrypted local store is unavailable', async () => {
  const unavailable = Object.assign(new Error('desktop broker unavailable'), {
    code: 'SECRET_STORE_UNAVAILABLE',
  });
  const secretStore = {
    async get() { throw unavailable; },
    async set() { throw unavailable; },
    async delete() { throw unavailable; },
  };
  const session = createAccountSession({
    secretStore,
    backend: createMemoryAccountBackendAdapter(),
  });

  const status = await session.status();
  assert.equal(Number.isNaN(Date.parse(status.updatedAt)), false);
  assert.deepEqual({ ...status, updatedAt: '<timestamp>' }, {
    state: 'unknown',
    signedIn: false,
    account: null,
    updatedAt: '<timestamp>',
    error: 'SECRET_STORE_UNAVAILABLE',
  });
});

test('a cancelled credential publication restores the previous account session', async () => {
  const previous = token('a');
  const backend = createMemoryAccountBackendAdapter({
    initialSessions: [{ token: previous, account: { email: 'old@example.com' } }],
    account: { email: 'new@example.com' },
  });
  const secretStore = createMemorySecretStore({ [ACCOUNT_SESSION_SECRET_ID]: previous });
  const session = createAccountSession({ secretStore, backend });
  const started = await session.startLogin();

  await assert.rejects(
    () => session.completeLogin(started.loginId, { kind: 'manual', code: 'ABCD' }, {
      onCommitted() {
        throw Object.assign(new Error('owner closed'), { code: 'AGENT_AUTH_CANCELLED' });
      },
    }),
    (error) => error.code === 'AGENT_AUTH_CANCELLED',
  );

  assert.equal((await session.status()).account.email, 'old@example.com');
  assert.equal(await secretStore.get(ACCOUNT_SESSION_SECRET_ID), previous);
});

test('cancelLogin aborts an in-flight completion and cancels its backend device session', async () => {
  const memory = createMemoryAccountBackendAdapter();
  let redeemStarted;
  const started = new Promise((resolve) => { redeemStarted = resolve; });
  let backendCancelled = false;
  const backend = {
    ...memory,
    redeemLogin(_handle, _proof, { signal }) {
      redeemStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(
          Object.assign(new Error('aborted'), { code: 'RAU_LOGIN_CANCELLED' }),
        ), { once: true });
      });
    },
    async cancelLogin(handle, options) {
      backendCancelled = true;
      return memory.cancelLogin(handle, options);
    },
  };
  const secretStore = createMemorySecretStore();
  const session = createAccountSession({ secretStore, backend });
  const login = await session.startLogin();
  const completion = session.completeLogin(login.loginId, { kind: 'manual', code: 'ABCD' });
  await started;
  assert.equal(await session.cancelLogin(login.loginId), true);
  await assert.rejects(
    () => completion,
    (error) => ['ACCOUNT_LOGIN_CANCELLED', 'RAU_LOGIN_CANCELLED'].includes(error.code),
  );
  assert.equal(backendCancelled, true);
  assert.equal(await secretStore.get(ACCOUNT_SESSION_SECRET_ID), null);
});

test('the start signal cancels a device session before the server can publish its login id', async () => {
  const memory = createMemoryAccountBackendAdapter();
  let backendCancelled = false;
  const backend = {
    ...memory,
    async cancelLogin(handle, options) {
      backendCancelled = true;
      return memory.cancelLogin(handle, options);
    },
  };
  const session = createAccountSession({ secretStore: createMemorySecretStore(), backend });
  const abort = new AbortController();
  const login = await session.startLogin({ signal: abort.signal });

  abort.abort();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(backendCancelled, true);
  await assert.rejects(
    () => session.completeLogin(login.loginId, { kind: 'manual', code: 'ABCD' }),
    (error) => error.code === 'ACCOUNT_LOGIN_NOT_FOUND',
  );
});

test('an invalid manual proof can retry the same owned login attempt', async () => {
  const memory = createMemoryAccountBackendAdapter();
  let attempts = 0;
  const backend = {
    ...memory,
    async redeemLogin(handle, proof, options) {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('wrong code'), { code: 'DEVICE_PROOF_INVALID' });
      }
      return memory.redeemLogin(handle, proof, options);
    },
  };
  const session = createAccountSession({ secretStore: createMemorySecretStore(), backend });
  const login = await session.startLogin();
  await assert.rejects(
    () => session.completeLogin(login.loginId, { kind: 'manual', code: 'WRONG' }),
    (error) => error.code === 'DEVICE_PROOF_INVALID',
  );
  assert.equal((await session.completeLogin(
    login.loginId,
    { kind: 'manual', code: 'RIGHT' },
  )).signedIn, true);
});

test('a definite replacement commit failure preserves the old session', async () => {
  const previous = token('b');
  const memory = createMemoryAccountBackendAdapter({
    initialSessions: [{ token: previous, account: { email: 'old@example.com' } }],
    account: { email: 'new@example.com' },
  });
  const backend = {
    ...memory,
    async commitSession() {
      const error = Object.assign(new Error('rejected'), {
        code: 'ACCOUNT_COMMIT_REJECTED',
        fromCreditsService: true,
      });
      throw error;
    },
  };
  const secretStore = createMemorySecretStore({ [ACCOUNT_SESSION_SECRET_ID]: previous });
  const session = createAccountSession({ secretStore, backend });

  await assert.rejects(() => logIn(session), (error) => error.code === 'ACCOUNT_COMMIT_REJECTED');
  assert.equal((await session.status()).account.email, 'old@example.com');
  assert.equal(await secretStore.get(ACCOUNT_SESSION_SECRET_ID), previous);
});

test('replacement revokes the old session only after local publication commits', async () => {
  const previous = token('c');
  const oldStore = createMemorySecretStore({ [ACCOUNT_SESSION_SECRET_ID]: previous });
  const replacementStore = createMemorySecretStore({ [ACCOUNT_SESSION_SECRET_ID]: previous });
  const memory = createMemoryAccountBackendAdapter({
    initialSessions: [{ token: previous, account: { email: 'old@example.com' } }],
    account: { email: 'new@example.com' },
  });
  let localCommitObserved = false;
  const backend = {
    ...memory,
    async commitSession(nextToken, options) {
      assert.notEqual(nextToken, previous);
      assert.equal(localCommitObserved, true);
      return memory.commitSession(nextToken, options);
    },
  };
  const replacement = createAccountSession({ secretStore: replacementStore, backend });

  const status = await logIn(replacement, {
    onCommitted() { localCommitObserved = true; },
  });
  assert.equal(status.account.email, 'new@example.com');

  const oldSession = createAccountSession({ secretStore: oldStore, backend: memory });
  assert.equal((await oldSession.status()).signedIn, false);
  assert.equal(await oldStore.get(ACCOUNT_SESSION_SECRET_ID), null);
});

test('logout keeps local state when remote revocation is unconfirmed', async () => {
  const current = token('d');
  const memory = createMemoryAccountBackendAdapter({
    initialSessions: [{ token: current, account: { email: 'andy@example.com' } }],
  });
  const backend = {
    ...memory,
    async revokeSession() {
      throw Object.assign(new Error('offline'), { code: 'RAU_CREDITS_UNREACHABLE' });
    },
  };
  const secretStore = createMemorySecretStore({ [ACCOUNT_SESSION_SECRET_ID]: current });
  const session = createAccountSession({ secretStore, backend });

  await assert.rejects(() => session.logout(), (error) => error.code === 'RAU_CREDITS_UNREACHABLE');
  assert.equal(await secretStore.get(ACCOUNT_SESSION_SECRET_ID), current);
  assert.equal((await session.status()).signedIn, true);
});

test('restart commits a locally published pending session and clears a remotely revoked one', async () => {
  const pending = token('e');
  const revoked = token('f');
  const backend = createMemoryAccountBackendAdapter({
    initialSessions: [
      { token: pending, status: 'pending', account: { email: 'pending@example.com' } },
      { token: revoked, status: 'revoked', account: { email: 'revoked@example.com' } },
    ],
  });

  const pendingStore = createMemorySecretStore({ [ACCOUNT_SESSION_SECRET_ID]: pending });
  const restarted = createAccountSession({ secretStore: pendingStore, backend });
  assert.equal((await restarted.status()).signedIn, true);

  const revokedStore = createMemorySecretStore({ [ACCOUNT_SESSION_SECRET_ID]: revoked });
  const revokedSession = createAccountSession({ secretStore: revokedStore, backend });
  assert.equal((await revokedSession.status()).signedIn, false);
  assert.equal(await revokedStore.get(ACCOUNT_SESSION_SECRET_ID), null);
});

test('an uncertain replacement commit keeps the recoverable new token for restart', async () => {
  const previous = token('g');
  const memory = createMemoryAccountBackendAdapter({
    initialSessions: [{ token: previous, account: { email: 'old@example.com' } }],
    account: { email: 'new@example.com' },
  });
  const backend = {
    ...memory,
    async commitSession() {
      throw Object.assign(new Error('connection lost'), { code: 'RAU_CREDITS_UNREACHABLE' });
    },
    async readStatus() {
      throw Object.assign(new Error('connection lost'), { code: 'RAU_CREDITS_UNREACHABLE' });
    },
  };
  const secretStore = createMemorySecretStore({ [ACCOUNT_SESSION_SECRET_ID]: previous });
  const session = createAccountSession({ secretStore, backend });

  await assert.rejects(
    () => logIn(session),
    (error) => error.code === 'ACCOUNT_SESSION_COMMIT_UNCERTAIN',
  );
  assert.notEqual(await secretStore.get(ACCOUNT_SESSION_SECRET_ID), previous);
});

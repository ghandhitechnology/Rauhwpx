import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { encryptSecret, decryptSecret } from '../crypto.mjs';
import { RAU_CREDIT_LIMIT_USD } from '../catalog.mjs';
import {
  DEFAULT_PORT,
  assertCreditsEnv,
  resolveCreditsDbPath,
  resolveCreditsOrigin,
} from '../config.mjs';
import {
  creditsRequestListener,
  createCreditsService,
  markOpenRouterMintNotDispatched,
} from '../service.mjs';
import { renderReadyPage } from '../pages.mjs';
import {
  assertStoreStateFits,
  createFileStore,
  createMemoryStore,
  MAX_STORE_BYTES,
  syncDirectory,
} from '../store.mjs';
import { createRateLimiter } from '../rate-limit.mjs';

function service(overrides = {}) {
  const minted = [];
  return createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    workosClientId: 'client_test',
    store: createMemoryStore(),
    authenticateWorkos: async (code) => {
      if (code !== 'ok-code') throw Object.assign(new Error('bad code'), { code: 'WORKOS_AUTH_FAILED' });
      return { id: 'user_abc' };
    },
    createOpenRouterKey: async ({ name }) => {
      minted.push(name);
      return { key: `sk-or-v1-minted-${minted.length}`, id: `or-key-${minted.length}` };
    },
    ...overrides,
    minted,
  });
}

function pkce(verifier = 'v'.repeat(43)) {
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

function rawHttpRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

test('Rau ready page returns the loopback proof with the exact callback state parameter', () => {
  const html = renderReadyPage({
    pairingCode: 'ABC-DEF',
    manualCode: 'ABCD-EFGH-IJKL',
    redirectUri: 'http://127.0.0.1:4545/oauth/rau/callback',
    callbackState: 's'.repeat(32),
    authorizationCode: 'loopback-proof',
  });
  assert.match(html, /oauth\/rau\/callback\?code=loopback-proof&amp;state=ssss/);
  assert.doesNotMatch(html, /callbackState=/);
});

test('encrypt round-trips the OpenRouter secret', () => {
  const packed = encryptSecret('session', 'sk-or-v1-secret');
  assert.notEqual(packed, 'sk-or-v1-secret');
  assert.equal(decryptSecret('session', packed), 'sk-or-v1-secret');
});

test('legacy desktop-delivered keys rotate on startup without resetting spent credits', async () => {
  const store = createMemoryStore({
    users: {
      user_legacy: {
        keyCiphertext: encryptSecret('test-secret-for-rau-credits', 'sk-or-v1-old-exposed'),
        openrouterKeyId: 'old-hash',
        createdAt: 1,
      },
    },
    sessions: {},
    accessTokens: {},
  });
  const minted = [];
  const deleted = [];
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    store,
    authenticateWorkos: async () => ({ id: 'user_legacy', email: 'legacy@example.com' }),
    inspectOpenRouterKey: async ({ key }) => {
      assert.equal(key, 'sk-or-v1-old-exposed');
      return { limit: 5, usage: 2 };
    },
    createOpenRouterKey: async ({ limit }) => {
      minted.push(limit);
      return { key: 'sk-or-v1-server-only', id: 'new-hash' };
    },
    deleteOpenRouterKey: async ({ id }) => { deleted.push(id); },
    fetchImpl: async () => new Response(JSON.stringify({ data: { limit: 3, usage: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  assert.deepEqual(await credits.migrateLegacyKeys(), { migrated: 1 });
  assert.deepEqual(minted, [3]);
  assert.deepEqual(deleted, ['old-hash']);
  const migrated = (await store.load()).users.user_legacy;
  assert.equal(migrated.credentialVersion, 2);
  assert.equal(migrated.carriedUsageUsd, 2);
  assert.equal(decryptSecret('test-secret-for-rau-credits', migrated.keyCiphertext), 'sk-or-v1-server-only');

  const login = await credits.createDeviceSession();
  await credits.completeLogin('legacy', login.id);
  const token = (await credits.redeemDeviceSession(login.id)).accessToken;
  const keyStatus = await credits.proxyOpenRouter(token, { pathname: '/key', method: 'GET' });
  const visible = await keyStatus.json();
  assert.equal(visible.data.limit, 5);
  assert.equal(visible.data.usage, 3);
  assert.equal(visible.data.limit_remaining, 2);
});

test('rate limiter refuses a new key when cleanup cannot free capacity', () => {
  let clock = 1_000;
  const limiter = createRateLimiter({ now: () => clock, maxKeys: 2 });
  assert.equal(limiter.check('first', 5, 1_000), true);
  assert.equal(limiter.check('second', 5, 1_000), true);
  assert.equal(limiter.check('third', 5, 1_000), false);
  assert.equal(limiter.check('first', 5, 1_000), true);

  clock = 2_001;
  assert.equal(limiter.check('third', 5, 1_000), true);
});

test('first login keeps the $5 key server-side and delivers a distinct Rau token', async () => {
  const minted = [];
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    workosClientId: 'client_test',
    store: createMemoryStore(),
    authenticateWorkos: async () => ({ id: 'user_abc' }),
    createOpenRouterKey: async ({ name }) => {
      minted.push(name);
      return { key: 'sk-or-v1-shared', id: 'or-1' };
    },
  });

  const first = await credits.createDeviceSession();
  await credits.completeLogin('code-1', first.id);
  const redeemed = await credits.redeemDeviceSession(first.id);
  assert.equal(redeemed.status, 'ready');
  assert.match(redeemed.accessToken, /^rau_v1_/);
  assert.doesNotMatch(JSON.stringify(redeemed), /sk-or-v1-shared/);
  assert.equal(minted.length, 1);

  const repeated = await credits.redeemDeviceSession(first.id);
  assert.equal(repeated.status, 'ready');
  assert.equal(repeated.accessToken, redeemed.accessToken);

  await credits.acknowledgeDeviceSession(first.id);
  const already = await credits.redeemDeviceSession(first.id);
  assert.equal(already.status, 'redeemed');
  assert.equal(already.accessToken, undefined);

  const second = await credits.createDeviceSession();
  await credits.completeLogin('code-2', second.id);
  const again = await credits.redeemDeviceSession(second.id);
  assert.match(again.accessToken, /^rau_v1_/);
  assert.notEqual(again.accessToken, redeemed.accessToken);
  assert.equal(minted.length, 1, 'the same WorkOS user must not mint another $5');
});

test('the same email through a second WorkOS identity reuses the first $5 key', async () => {
  const minted = [];
  let magicLoginCount = 0;
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    store: createMemoryStore(),
    authenticateWorkos: async () => ({ id: 'user_google', email: 'Andy@Example.com' }),
    authenticateMagic: async () => ({
      id: 'user_magic',
      email: magicLoginCount++ === 0 ? 'andy@example.com' : null,
    }),
    createOpenRouterKey: async () => {
      minted.push(1);
      return { key: `sk-or-v1-shared-${minted.length}`, id: `or-${minted.length}` };
    },
  });

  const oauth = await credits.createDeviceSession();
  await credits.completeLogin('code-1', oauth.id);
  const magic = await credits.createDeviceSession();
  await credits.completeMagicLogin(magic.id, 'andy@example.com', '123456');

  assert.equal(minted.length, 1, 'the same mailbox must not mint a second $5');
  assert.match((await credits.redeemDeviceSession(magic.id)).accessToken, /^rau_v1_/);

  const repeatedMagic = await credits.createDeviceSession();
  await credits.completeMagicLogin(repeatedMagic.id, 'invalid-email', '123456');
  assert.equal(minted.length, 1, 'the linked WorkOS identity must reuse the key without an email');
});

test('account replacement switches the proxy credential and revokes the previous account token', async () => {
  const upstream = [];
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    store: createMemoryStore(),
    authenticateWorkos: async (code) => ({
      id: code === 'account-b' ? 'user_b' : 'user_a',
      email: code === 'account-b' ? 'b@example.com' : 'a@example.com',
    }),
    createOpenRouterKey: async ({ name }) => ({ key: `sk-or-v1-${name}`, id: `hash-${name}` }),
    fetchImpl: async (url, init = {}) => {
      upstream.push({ url: String(url), authorization: init.headers.Authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const first = await credits.createDeviceSession();
  await credits.completeLogin('account-a', first.id);
  const tokenA = (await credits.redeemDeviceSession(first.id)).accessToken;
  await credits.proxyOpenRouter(tokenA, {
    pathname: '/chat/completions',
    method: 'POST',
    body: { model: 'z-ai/glm-5.3-flash', messages: [] },
  });
  assert.equal(upstream.at(-1).authorization, 'Bearer sk-or-v1-rau-user_a');

  const second = await credits.createDeviceSession({ replaceAccessToken: tokenA });
  await credits.completeLogin('account-b', second.id);
  const tokenB = (await credits.redeemDeviceSession(second.id)).accessToken;
  assert.notEqual(tokenB, tokenA);
  await assert.rejects(
    () => credits.proxyOpenRouter(tokenA, { pathname: '/key', method: 'GET' }),
    { code: 'RAU_ACCESS_INVALID' },
  );
  await credits.proxyOpenRouter(tokenB, {
    pathname: '/chat/completions',
    method: 'POST',
    body: { model: 'qwen/qwen3.8-flash', messages: [] },
  });
  assert.equal(upstream.at(-1).authorization, 'Bearer sk-or-v1-rau-user_b');
});

test('logout revokes the Rau token and the proxy denies arbitrary models and management APIs', async () => {
  let upstreamCalls = 0;
  const credits = service({
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const session = await credits.createDeviceSession();
  await credits.completeLogin('ok-code', session.id);
  const token = (await credits.redeemDeviceSession(session.id)).accessToken;

  await assert.rejects(
    () => credits.proxyOpenRouter(token, {
      pathname: '/chat/completions',
      method: 'POST',
      body: { model: 'openai/gpt-5', messages: [] },
    }),
    { code: 'RAU_MODEL_FORBIDDEN' },
  );
  await assert.rejects(
    () => credits.proxyOpenRouter(token, { pathname: '/keys', method: 'GET' }),
    { code: 'RAU_PROXY_FORBIDDEN' },
  );
  assert.equal(upstreamCalls, 0);

  assert.deepEqual(await credits.revokeAccessToken(token), { revoked: true });
  assert.deepEqual(await credits.revokeAccessToken(token), { revoked: false });
  await assert.rejects(
    () => credits.proxyOpenRouter(token, { pathname: '/key', method: 'GET' }),
    { code: 'RAU_ACCESS_INVALID' },
  );
  assert.equal(upstreamCalls, 0);
});

test('a pending session past the TTL cannot be completed into a minted key', async () => {
  let t = 1_700_000_000_000;
  const minted = [];
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    store: createMemoryStore(),
    authenticateWorkos: async () => ({ id: 'user_late' }),
    createOpenRouterKey: async () => {
      minted.push(1);
      return { key: 'sk-or-v1-late', id: 'or-late' };
    },
    now: () => t,
  });

  const session = await credits.createDeviceSession();
  t += credits.sessionTtlMs + 1;
  await assert.rejects(
    () => credits.completeLogin('code', session.id),
    (error) => error.code === 'DEVICE_SESSION_EXPIRED',
  );
  assert.equal(minted.length, 0);
});

test('an unacknowledged token is revoked when its device session expires', async () => {
  let t = 1_700_000_000_000;
  const credits = service({ now: () => t });
  const session = await credits.createDeviceSession();
  await credits.completeLogin('ok-code', session.id);
  const token = (await credits.redeemDeviceSession(session.id)).accessToken;

  t += credits.sessionTtlMs + 1;
  await credits.createDeviceSession();
  await assert.rejects(
    () => credits.proxyOpenRouter(token, { pathname: '/key', method: 'GET' }),
    { code: 'RAU_ACCESS_INVALID' },
  );
});

test('live device sessions are capped so floods cannot grow the store', async () => {
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    store: createMemoryStore(),
    authenticateWorkos: async () => ({ id: 'user_cap' }),
    createOpenRouterKey: async () => ({ key: 'sk-or-v1-cap', id: 'or-cap' }),
    maxLiveSessions: 2,
  });

  const first = await credits.createDeviceSession();
  await credits.createDeviceSession();
  await assert.rejects(
    () => credits.createDeviceSession(),
    (error) => error.code === 'RATE_LIMITED',
  );

  await credits.completeLogin('code', first.id);
  await credits.acknowledgeDeviceSession(first.id);
  const freed = await credits.createDeviceSession();
  assert.equal(typeof freed.id, 'string');
});

test('a corrupted stored record fails closed instead of minting a second trial key', async () => {
  const minted = [];
  const store = createMemoryStore();
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    store,
    authenticateWorkos: async () => ({ id: 'user_rot', email: 'andy@example.com' }),
    createOpenRouterKey: async () => {
      minted.push(1);
      return { key: `sk-or-v1-rot-${minted.length}`, id: `or-rot-${minted.length}` };
    },
  });
  const session = await credits.createDeviceSession();
  await credits.completeLogin('code-1', session.id);
  assert.equal(minted.length, 1);

  const state = await store.load();
  state.users.user_rot.keyCiphertext = 'not:a:valid:ciphertext';
  await store.save(state);

  const retry = await credits.createDeviceSession();
  await assert.rejects(
    () => credits.completeLogin('code-2', retry.id),
    (error) => error.code === 'TRIAL_KEY_UNREADABLE',
  );
  assert.equal(minted.length, 1, 'an undecryptable record must not mint another $5 key');
});

test('a durable provisioning intent reconciles an orphan before minting a replacement', async () => {
  const backing = createMemoryStore();
  let failKeyCommit = true;
  const store = {
    load: () => backing.load(),
    save: async (state) => {
      if (failKeyCommit && state.users?.user_abc?.keyCiphertext) {
        failKeyCommit = false;
        throw new Error('simulated crash before durable key commit');
      }
      await backing.save(state);
    },
  };
  const events = [];
  const first = service({
    store,
    createOpenRouterKey: async ({ name }) => {
      const durable = await backing.load();
      assert.equal(durable.users.user_abc.provisioning.name, name);
      assert.equal(durable.users.user_abc.provisioning.phase, 'submitting');
      events.push(`mint:${name}`);
      return { key: 'sk-or-v1-orphan', id: 'orphan-hash' };
    },
  });
  const session = await first.createDeviceSession();
  await assert.rejects(
    () => first.completeLogin('ok-code', session.id),
    /simulated crash/,
  );
  const pending = (await backing.load()).users.user_abc.provisioning;
  assert.equal(typeof pending.id, 'string');
  assert.equal(pending.phase, 'submitting');
  assert.equal(events.length, 1);

  const recovered = service({
    store,
    reconcileOpenRouterKey: async (intent) => {
      events.push(`reconcile:${intent.name}`);
      assert.deepEqual(intent, {
        intentId: pending.id,
        name: pending.name,
        createdAt: pending.createdAt,
      });
      return true;
    },
    createOpenRouterKey: async ({ name }) => {
      events.push(`mint:${name}`);
      return { key: 'sk-or-v1-replacement', id: 'replacement-hash' };
    },
  });
  await recovered.completeLogin('ok-code', session.id);
  assert.deepEqual(events.slice(0, 2), [`mint:${pending.name}`, `reconcile:${pending.name}`]);
  assert.equal(events.length, 3);
  assert.notEqual(events[2], `mint:${pending.name}`);
  assert.match((await recovered.redeemDeviceSession(session.id)).accessToken, /^rau_v1_/);
});

test('a prepared provisioning intent resumes without reconciliation', async () => {
  const store = createMemoryStore({
    users: {
      user_abc: {
        provisioning: {
          id: 'intent-prepared',
          name: 'rau-user_abc-intent-prepared',
          createdAt: 10,
          phase: 'prepared',
        },
      },
    },
    sessions: { device: { status: 'pending', createdAt: 10 } },
  });
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    store,
    now: () => 20,
    authenticateWorkos: async () => ({ id: 'user_abc' }),
    reconcileOpenRouterKey: async () => {
      assert.fail('a prepared intent has no provider request to reconcile');
    },
    createOpenRouterKey: async ({ name }) => {
      assert.equal(name, 'rau-user_abc-intent-prepared');
      assert.equal((await store.load()).users.user_abc.provisioning.phase, 'submitting');
      return { key: 'sk-or-v1-prepared', id: 'prepared-hash' };
    },
  });

  await credits.completeLogin('ok-code', 'device');
  assert.match((await credits.redeemDeviceSession('device')).accessToken, /^rau_v1_/);
});

test('a definitely undispatched mint restores prepared state and retries the same intent', async () => {
  const store = createMemoryStore();
  const names = [];
  let calls = 0;
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    store,
    authenticateWorkos: async () => ({ id: 'user_abc' }),
    reconcileOpenRouterKey: async () => {
      assert.fail('a definitely undispatched request must resume prepared state directly');
    },
    createOpenRouterKey: async ({ name }) => {
      calls += 1;
      names.push(name);
      if (calls === 1) {
        throw markOpenRouterMintNotDispatched(new Error('local preflight rejected the request'));
      }
      return { key: 'sk-or-v1-retried-once', id: 'retry-hash' };
    },
  });
  const session = await credits.createDeviceSession();

  await assert.rejects(
    () => credits.completeLogin('ok-code', session.id),
    /local preflight rejected/,
  );
  assert.equal((await store.load()).users.user_abc.provisioning.phase, 'prepared');

  await credits.completeLogin('ok-code', session.id);
  assert.deepEqual(names, [names[0], names[0]], 'the retry reuses the durable intent name');
  assert.match((await credits.redeemDeviceSession(session.id)).accessToken, /^rau_v1_/);
});

test('an ambiguous mint failure stays submitting when reconciliation finds nothing', async () => {
  const store = createMemoryStore();
  const first = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    store,
    authenticateWorkos: async () => ({ id: 'user_abc' }),
    createOpenRouterKey: async () => { throw new Error('connection reset after dispatch'); },
  });
  const session = await first.createDeviceSession();
  await assert.rejects(
    () => first.completeLogin('ok-code', session.id),
    /connection reset after dispatch/,
  );
  assert.equal((await store.load()).users.user_abc.provisioning.phase, 'submitting');

  const recovered = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    store,
    authenticateWorkos: async () => ({ id: 'user_abc' }),
    reconcileOpenRouterKey: async () => false,
    createOpenRouterKey: async () => {
      assert.fail('absence cannot prove an ambiguous provider request was never dispatched');
    },
  });
  await assert.rejects(
    () => recovered.completeLogin('ok-code', session.id),
    { code: 'OPENROUTER_RECONCILE_PENDING' },
  );
  assert.equal((await store.load()).users.user_abc.provisioning.phase, 'submitting');
});

test('durable capacity is reserved for the largest accepted key before paid mint', async () => {
  const initial = {
    users: {
      user_abc: {
        provisioning: {
          id: 'intent-prepared',
          name: 'rau-user_abc-intent-prepared',
          createdAt: 10,
          phase: 'prepared',
        },
      },
    },
    sessions: {
      device: {
        status: 'pending',
        createdAt: 10,
        completionClaim: { workosUserId: 'user_abc', email: null, claimedAt: 10 },
      },
    },
    padding: '',
  };
  const baseBytes = Buffer.byteLength(`${JSON.stringify(initial, null, 2)}\n`, 'utf8');
  initial.padding = 'x'.repeat(MAX_STORE_BYTES - baseBytes - 2_048);
  assertStoreStateFits(initial);
  const submitting = structuredClone(initial);
  submitting.users.user_abc.provisioning = {
    ...submitting.users.user_abc.provisioning,
    phase: 'submitting',
    submittedAt: 20,
  };
  assertStoreStateFits(submitting);

  let mintCalls = 0;
  const store = createMemoryStore(initial);
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    store,
    now: () => 20,
    authenticateWorkos: async () => ({ id: 'user_abc' }),
    createOpenRouterKey: async () => {
      mintCalls += 1;
      return { key: 'must-not-mint', id: 'must-not-mint' };
    },
  });

  await assert.rejects(
    () => credits.completeLogin('ok-code', 'device'),
    { code: 'RAU_CREDITS_CAPACITY_EXCEEDED' },
  );
  assert.equal(mintCalls, 0);
  assert.equal((await store.load()).users.user_abc.provisioning.phase, 'prepared');
});

test('oversized WorkOS identity fields are rejected before session persistence or paid mint', async () => {
  for (const user of [
    { id: 'u'.repeat(257), email: 'ok@example.com' },
    { id: 'user_abc', email: `${'e'.repeat(309)}@example.com` },
  ]) {
    let mintCalls = 0;
    const store = createMemoryStore();
    const credits = createCreditsService({
      origin: 'https://credits.rau.test',
      sessionSecret: 'test-secret-for-rau-credits',
      store,
      authenticateWorkos: async () => user,
      createOpenRouterKey: async () => {
        mintCalls += 1;
        return { key: 'must-not-mint', id: 'must-not-mint' };
      },
    });
    const session = await credits.createDeviceSession();

    await assert.rejects(
      () => credits.completeLogin('ok-code', session.id),
      { code: 'WORKOS_AUTH_FAILED' },
    );
    assert.equal(mintCalls, 0);
    const state = await store.load();
    assert.deepEqual(state.users, {});
    assert.equal(state.sessions[session.id].completionClaim, undefined);
  }
});

test('an empty OpenRouter list does not clear an uncertain provisioning intent', async () => {
  const calls = [];
  const store = createMemoryStore({
    users: {
      user_abc: {
        provisioning: {
          id: 'intent-submitting',
          name: 'rau-user_abc-intent-submitting',
          createdAt: 10,
          submittedAt: 11,
          phase: 'submitting',
        },
      },
    },
    sessions: { device: { status: 'pending', createdAt: 10 } },
  });
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    openRouterProvisioningKey: 'provisioning-secret',
    store,
    now: () => 20,
    authenticateWorkos: async () => ({ id: 'user_abc' }),
    fetchImpl: async (url, init = {}) => {
      calls.push({ method: init.method ?? 'GET', url: String(url) });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });

  await assert.rejects(
    () => credits.completeLogin('ok-code', 'device'),
    (error) => error.code === 'OPENROUTER_RECONCILE_PENDING',
  );
  assert.deepEqual(calls.map(({ method }) => method), ['GET']);
  assert.equal((await store.load()).users.user_abc.provisioning.phase, 'submitting');
});

test('default orphan reconciliation deletes the exact OpenRouter key before provisioning', async () => {
  const calls = [];
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    openRouterProvisioningKey: 'provisioning-secret',
    store: createMemoryStore({
      users: {
        user_abc: {
          provisioning: { id: 'intent-old', name: 'rau-user_abc-intent-old', createdAt: 10 },
        },
      },
      sessions: { device: { status: 'pending', createdAt: 10 } },
    }),
    now: () => 20,
    authenticateWorkos: async () => ({ id: 'user_abc' }),
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(String(url));
      calls.push({ method: init.method ?? 'GET', path: parsed.pathname, search: parsed.search });
      if ((init.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({
          data: [{ name: 'rau-user_abc-intent-old', hash: 'orphan-hash' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (init.method === 'DELETE') {
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }
      return new Response(JSON.stringify({
        key: 'sk-or-v1-after-reconcile',
        data: { hash: 'replacement-hash' },
      }), { status: 201 });
    },
  });

  await credits.completeLogin('ok-code', 'device');
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'GET /api/v1/keys',
    'DELETE /api/v1/keys/orphan-hash',
    'POST /api/v1/keys',
  ]);
  assert.match(calls[0].search, /include_disabled=true/);
  assert.match((await credits.redeemDeviceSession('device')).accessToken, /^rau_v1_/);
});

test('file store atomically round-trips state and rejects oversized snapshots', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rau-credits-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'credits.json');
  const store = createFileStore(filePath);
  const expected = { users: { user: { createdAt: 1 } }, sessions: {} };
  await store.save(expected);
  assert.deepEqual(await store.load(), expected);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(filePath)).mode & 0o077, 0);
  }
  await assert.rejects(
    () => store.save({ users: {}, sessions: {}, padding: 'x'.repeat(8 * 1024 * 1024) }),
    /8 MiB/,
  );
  assert.deepEqual(await store.load(), expected);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['credits.json']);
});

test('directory fsync propagates storage failures', async () => {
  for (const code of ['EIO', 'ENOSPC']) {
    const failure = Object.assign(new Error(`simulated ${code}`), { code });
    let closed = false;
    await assert.rejects(
      () => syncDirectory('/unused', {
        openImpl: async () => ({
          sync: async () => { throw failure; },
          close: async () => { closed = true; },
        }),
        platform: 'linux',
      }),
      (error) => error === failure,
    );
    assert.equal(closed, true);
  }
});

test('directory fsync ignores only explicit unsupported errors', async () => {
  for (const code of ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']) {
    await syncDirectory('/unused', {
      openImpl: async () => ({
        sync: async () => { throw Object.assign(new Error(code), { code }); },
        close: async () => {},
      }),
      platform: 'linux',
    });
  }
  for (const code of ['EACCES', 'EISDIR', 'EPERM']) {
    await syncDirectory('/unused', {
      openImpl: async () => { throw Object.assign(new Error(code), { code }); },
      platform: 'win32',
    });
  }
  await assert.rejects(
    () => syncDirectory('/unused', {
      openImpl: async () => ({
        sync: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
        close: async () => {},
      }),
      platform: 'linux',
    }),
    (error) => error.code === 'EPERM',
  );
});

test('file store rejects when the directory entry cannot be synced', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rau-credits-fsync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const failure = Object.assign(new Error('simulated directory I/O failure'), { code: 'EIO' });
  const store = createFileStore(path.join(directory, 'credits.json'), {
    syncDirectoryImpl: async () => { throw failure; },
  });

  await assert.rejects(
    () => store.save({ users: {}, sessions: {} }),
    (error) => error === failure,
  );

});

test('concurrent session creation cannot overwrite another session', async () => {
  const credits = service();
  const [first, second] = await Promise.all([
    credits.createDeviceSession(),
    credits.createDeviceSession(),
  ]);

  await credits.assertPendingDevice(first.id);
  await credits.assertPendingDevice(second.id);
});

test('concurrent v1 completions bind one device session to one principal before provisioning', async () => {
  const store = createMemoryStore();
  const minted = [];
  let authenticatedCount = 0;
  let releaseAuthenticated;
  const bothAuthenticated = new Promise((resolve) => { releaseAuthenticated = resolve; });
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    store,
    authenticateWorkos: async (code) => {
      authenticatedCount += 1;
      if (authenticatedCount === 2) releaseAuthenticated();
      await bothAuthenticated;
      return {
        id: `user_${code}`,
        email: `${code}@example.com`,
      };
    },
    createOpenRouterKey: async ({ name }) => {
      minted.push(name);
      return { key: `sk-or-v1-concurrent-${minted.length}`, id: `or-${minted.length}` };
    },
  });
  const session = await credits.createDeviceSession();

  const outcomes = await Promise.allSettled([
    credits.completeLogin('first', session.id),
    credits.completeLogin('second', session.id),
  ]);

  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = outcomes.find(({ status }) => status === 'rejected');
  assert.equal(rejected?.reason?.code, 'DEVICE_SESSION_INVALID');
  assert.equal(minted.length, 1, 'one device session must never provision two principals');
  const state = await store.load();
  assert.equal(Object.keys(state.users).length, 1);
  assert.equal(state.sessions[session.id].completionClaim, undefined);
});

test('pending polling is read-only and cannot save stale session state', async () => {
  const backing = createMemoryStore();
  let saves = 0;
  const store = {
    load: () => backing.load(),
    save: async (state) => {
      saves += 1;
      await backing.save(state);
    },
  };
  const credits = service({ store });
  const session = await credits.createDeviceSession();
  assert.equal(saves, 1);

  assert.deepEqual(await credits.redeemDeviceSession(session.id), { status: 'pending' });
  assert.equal(saves, 1);
});

test('redeem hands the logged-in email to the desktop and keeps it for repeat polls', async () => {
  const credits = service({
    authenticateWorkos: async () => ({ id: 'user_abc', email: 'andy@example.com' }),
  });
  const session = await credits.createDeviceSession();
  await credits.completeLogin('code-1', session.id);

  assert.equal((await credits.redeemDeviceSession(session.id)).email, 'andy@example.com');
  assert.equal((await credits.redeemDeviceSession(session.id)).email, 'andy@example.com');
});

test('magic-code login falls back to the submitted email when WorkOS omits it', async () => {
  const credits = service({
    authenticateMagic: async () => ({ id: 'user_magic' }),
  });
  const session = await credits.createDeviceSession();
  await credits.completeMagicLogin(session.id, 'andy@example.com', '123456');
  assert.equal((await credits.redeemDeviceSession(session.id)).email, 'andy@example.com');
});

test('v2 requires confirmation and PKCE before a key can be redeemed', async () => {
  const minted = [];
  const proof = pkce();
  const credits = service({
    createOpenRouterKey: async () => {
      minted.push(1);
      return { key: 'sk-or-v1-v2', id: 'or-v2' };
    },
  });
  const created = await credits.createDeviceSessionV2({
    codeChallenge: proof.challenge,
    codeChallengeMethod: 'S256',
    returnMode: 'manual',
    clientVersion: '1.2.0',
  });
  assert.match(created.pairingCode, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  assert.equal(minted.length, 0);

  const authorize = await credits.authorizationUrlV2(created.id);
  const oauthState = new URL(authorize).searchParams.get('state');
  assert.notEqual(oauthState, created.id);
  const authenticated = await credits.completeLoginV2('ok-code', oauthState);
  assert.equal(authenticated.pairingCode, created.pairingCode);
  assert.equal(minted.length, 0, 'authentication alone must not mint a key');

  const ready = await credits.confirmDeviceSessionV2(created.id, authenticated.confirmationToken);
  assert.equal(minted.length, 1);
  await assert.rejects(
    () => credits.redeemDeviceSessionV2(created.id, {}),
    (error) => error.code === 'DEVICE_PROOF_INVALID',
  );
  await assert.rejects(
    () => credits.redeemDeviceSessionV2(created.id, {
      codeVerifier: 'x'.repeat(43),
      proof: { kind: 'manual', code: ready.manualCode },
    }),
    (error) => error.code === 'DEVICE_PROOF_INVALID',
  );

  const redeemInput = {
    codeVerifier: proof.verifier,
    proof: { kind: 'manual', code: ready.manualCode.toLowerCase() },
  };
  assert.equal((await credits.redeemDeviceSessionV2(created.id, redeemInput)).apiKey, 'sk-or-v1-v2');
  assert.equal((await credits.redeemDeviceSessionV2(created.id, redeemInput)).apiKey, 'sk-or-v1-v2');
  assert.equal((await credits.acknowledgeDeviceSessionV2(created.id, redeemInput)).status, 'redeemed');
  assert.deepEqual(await credits.redeemDeviceSessionV2(created.id, redeemInput), { status: 'redeemed' });
});

test('v2 replays committed one-time responses after authentication and confirmation response loss', async () => {
  const store = createMemoryStore();
  const proof = pkce('r'.repeat(43));
  let authenticationCalls = 0;
  let mintCalls = 0;
  const makeService = () => createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    workosClientId: 'client_test',
    store,
    authenticateWorkos: async () => {
      authenticationCalls += 1;
      return { id: 'user_retry', email: 'retry@example.com' };
    },
    createOpenRouterKey: async () => {
      mintCalls += 1;
      return { key: 'sk-or-retry', id: 'or-retry' };
    },
  });
  const first = makeService();
  const created = await first.createDeviceSessionV2({
    codeChallenge: proof.challenge,
    codeChallengeMethod: 'S256',
    returnMode: 'manual',
  });
  const oauthState = new URL(await first.authorizationUrlV2(created.id)).searchParams.get('state');

  const lostAuthenticationResponse = await first.completeLoginV2('one-time-code', oauthState);
  const afterAuthenticationRestart = makeService();
  const replayedAuthentication = await afterAuthenticationRestart.completeLoginV2(
    'one-time-code',
    oauthState,
  );
  assert.equal(replayedAuthentication.confirmationToken, lostAuthenticationResponse.confirmationToken);
  assert.equal(authenticationCalls, 1, 'a consumed OAuth code must not be sent upstream again');

  const lostConfirmationResponse = await afterAuthenticationRestart.confirmDeviceSessionV2(
    created.id,
    replayedAuthentication.confirmationToken,
  );
  const afterConfirmationRestart = makeService();
  const replayedConfirmation = await afterConfirmationRestart.confirmDeviceSessionV2(
    created.id,
    replayedAuthentication.confirmationToken,
  );
  assert.deepEqual(replayedConfirmation, lostConfirmationResponse);
  assert.equal(mintCalls, 1, 'a lost confirmation response must not provision another key');

  const serialized = JSON.stringify(await store.load());
  assert.doesNotMatch(serialized, new RegExp(lostAuthenticationResponse.confirmationToken));
  assert.doesNotMatch(serialized, new RegExp(lostConfirmationResponse.authorizationCode));
  assert.doesNotMatch(serialized, new RegExp(lostConfirmationResponse.manualCode.replaceAll('-', '')));
});

test('v2 wrong OAuth state does not consume the valid flow', async () => {
  const proof = pkce('a'.repeat(43));
  const credits = service();
  const created = await credits.createDeviceSessionV2({
    codeChallenge: proof.challenge,
    codeChallengeMethod: 'S256',
    returnMode: 'manual',
  });
  const authorize = await credits.authorizationUrlV2(created.id, 'GitHubOAuth');
  const validState = new URL(authorize).searchParams.get('state');
  await assert.rejects(
    () => credits.completeLoginV2('ok-code', 'attacker-state'),
    (error) => error.code === 'OAUTH_STATE_INVALID',
  );
  const completed = await credits.completeLoginV2('ok-code', validState);
  assert.equal(completed.deviceId, created.id);
});

test('v1 and v2 service methods reject sessions from the other protocol', async () => {
  let oauthCalls = 0;
  let magicCalls = 0;
  const proof = pkce('p'.repeat(43));
  const credits = service({
    authenticateWorkos: async () => {
      oauthCalls += 1;
      return { id: 'user_protocol' };
    },
    authenticateMagic: async () => {
      magicCalls += 1;
      return { id: 'user_protocol' };
    },
  });
  const v2 = await credits.createDeviceSessionV2({
    codeChallenge: proof.challenge,
    codeChallengeMethod: 'S256',
    returnMode: 'manual',
  });

  for (const operation of [
    () => credits.authorizationUrl(v2.id),
    () => credits.assertPendingDevice(v2.id),
    () => credits.completeLogin('ok-code', v2.id),
    () => credits.completeMagicLogin(v2.id, 'andy@example.com', '123456'),
  ]) {
    await assert.rejects(operation, (error) => error.code === 'DEVICE_SESSION_INVALID');
  }
  assert.equal(oauthCalls, 0);
  assert.equal(magicCalls, 0);

  const authorize = await credits.authorizationUrlV2(v2.id);
  const authenticated = await credits.completeLoginV2(
    'ok-code',
    new URL(authorize).searchParams.get('state'),
  );
  await credits.confirmDeviceSessionV2(v2.id, authenticated.confirmationToken);
  await assert.rejects(
    () => credits.redeemDeviceSession(v2.id),
    (error) => error.code === 'DEVICE_SESSION_INVALID',
  );
  await assert.rejects(
    () => credits.acknowledgeDeviceSession(v2.id),
    (error) => error.code === 'DEVICE_SESSION_INVALID',
  );

  const v1 = await credits.createDeviceSession();
  for (const operation of [
    () => credits.authorizationUrlV2(v1.id),
    () => credits.completeMagicLoginV2(v1.id, 'andy@example.com', '123456'),
    () => credits.confirmDeviceSessionV2(v1.id, 'invalid-token'),
    () => credits.redeemDeviceSessionV2(v1.id, {}),
    () => credits.acknowledgeDeviceSessionV2(v1.id, {}),
  ]) {
    await assert.rejects(operation, (error) => error.code === 'DEVICE_SESSION_INVALID');
  }
  assert.equal(magicCalls, 0, 'v2 must reject a v1 id before authenticating the magic code');
});

test('OAuth callback cannot downgrade a v2 device id into v1 completion', async () => {
  let oauthCalls = 0;
  const proof = pkce('z'.repeat(43));
  const credits = service({
    authenticateWorkos: async () => {
      oauthCalls += 1;
      return { id: 'user_callback' };
    },
  });
  const created = await credits.createDeviceSessionV2({
    codeChallenge: proof.challenge,
    codeChallengeMethod: 'S256',
    returnMode: 'manual',
  });
  const authorize = await credits.authorizationUrlV2(created.id);
  const validState = new URL(authorize).searchParams.get('state');
  const server = http.createServer(creditsRequestListener(credits));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const invalid = await fetch(
      `http://127.0.0.1:${port}/callback?code=ok-code&state=${encodeURIComponent(created.id)}`,
    );
    assert.equal(invalid.status, 400);
    assert.equal(oauthCalls, 0, 'an invalid v2 state must be rejected before authentication');

    const valid = await fetch(
      `http://127.0.0.1:${port}/callback?code=ok-code&state=${encodeURIComponent(validState)}`,
    );
    assert.equal(valid.status, 200);
    assert.match(await valid.text(), /이 연결을 확인하세요/);
    assert.equal(oauthCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('hosted authentication rejects oversized upstream responses', async () => {
  const proof = pkce('q'.repeat(43));
  let cancelled = false;
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    workosApiKey: 'workos-secret',
    workosClientId: 'client_test',
    store: createMemoryStore(),
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), {
      status: 200,
      headers: { 'content-length': String(70 * 1024) },
    }),
  });
  const created = await credits.createDeviceSessionV2({
    codeChallenge: proof.challenge,
    codeChallengeMethod: 'S256',
    returnMode: 'manual',
  });
  const authorize = await credits.authorizationUrlV2(created.id);
  await assert.rejects(
    () => credits.completeLoginV2('ok-code', new URL(authorize).searchParams.get('state')),
    (error) => error.code === 'UPSTREAM_RESPONSE_TOO_LARGE',
  );
  assert.equal(cancelled, true);
});

test('v2 accepts only an exact 127.0.0.1 loopback callback', async () => {
  const proof = pkce('b'.repeat(43));
  const credits = service();
  const base = {
    codeChallenge: proof.challenge,
    codeChallengeMethod: 'S256',
    returnMode: 'hybrid',
    callbackState: 's'.repeat(32),
  };
  await assert.rejects(
    () => credits.createDeviceSessionV2({ ...base, redirectUri: 'http://localhost:4545/oauth/rau/callback' }),
    (error) => error.code === 'REDIRECT_URI_INVALID',
  );
  await assert.rejects(
    () => credits.createDeviceSessionV2({ ...base, redirectUri: 'https://127.0.0.1:4545/oauth/rau/callback' }),
    (error) => error.code === 'REDIRECT_URI_INVALID',
  );
  const created = await credits.createDeviceSessionV2({
    ...base,
    redirectUri: 'http://127.0.0.1:4545/oauth/rau/callback',
  });
  assert.equal(typeof created.id, 'string');
});

test('v2 manual proof locks after five bad attempts', async () => {
  const proof = pkce('c'.repeat(43));
  const credits = service();
  const created = await credits.createDeviceSessionV2({
    codeChallenge: proof.challenge,
    codeChallengeMethod: 'S256',
    returnMode: 'manual',
  });
  const authorize = await credits.authorizationUrlV2(created.id);
  const authenticated = await credits.completeLoginV2(
    'ok-code',
    new URL(authorize).searchParams.get('state'),
  );
  await credits.confirmDeviceSessionV2(created.id, authenticated.confirmationToken);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => credits.redeemDeviceSessionV2(created.id, {
        codeVerifier: proof.verifier,
        proof: { kind: 'manual', code: `WRONG-${attempt}` },
      }),
      (error) => error.code === (attempt === 4 ? 'DEVICE_PROOF_LOCKED' : 'DEVICE_PROOF_INVALID'),
    );
  }
  await assert.rejects(
    () => credits.redeemDeviceSessionV2(created.id, {
      codeVerifier: proof.verifier,
      proof: { kind: 'manual', code: 'anything' },
    }),
    (error) => error.code === 'DEVICE_PROOF_LOCKED',
  );
});

test('createOpenRouterKey receives the $5 limit contract through the default provisioner', async () => {
  const calls = [];
  const credits = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    workosClientId: 'client_test',
    openRouterProvisioningKey: 'prov-key',
    store: createMemoryStore(),
    authenticateWorkos: async () => ({ id: 'user_xyz' }),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ key: 'sk-or-v1-live', data: { hash: 'h1' } }),
      };
    },
  });
  const session = await credits.createDeviceSession();
  await credits.completeLogin('code', session.id);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /openrouter\.ai\/api\/v1\/keys/);
  assert.equal(calls[0].body.limit, RAU_CREDIT_LIMIT_USD);
  assert.equal(calls[0].body.limit_reset, null);
});

test('HTTP POST creates a session, GET delivers only a Rau token, and acknowledgement consumes it', async () => {
  const credits = service();
  const server = http.createServer(creditsRequestListener(credits));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const created = await fetch(`http://127.0.0.1:${port}/v1/device-sessions`, { method: 'POST' })
      .then((res) => res.json());
    assert.equal(typeof created.id, 'string');
    assert.match(created.loginUrl, /\/login\?device=/);

    const pending = await fetch(`http://127.0.0.1:${port}/v1/device-sessions/${created.id}`)
      .then((res) => res.json());
    assert.equal(pending.status, 'pending');

    await credits.completeLogin('ok-code', created.id);
    const ready = await fetch(`http://127.0.0.1:${port}/v1/device-sessions/${created.id}`)
      .then((res) => res.json());
    assert.equal(ready.status, 'ready');
    assert.match(ready.accessToken, /^rau_v1_/);
    assert.doesNotMatch(JSON.stringify(ready), /sk-or-v1-/);

    const repeated = await fetch(`http://127.0.0.1:${port}/v1/device-sessions/${created.id}`)
      .then((res) => res.json());
    assert.equal(repeated.accessToken, ready.accessToken);

    const acknowledged = await fetch(
      `http://127.0.0.1:${port}/v1/device-sessions/${created.id}/acknowledge`,
      { method: 'POST' },
    ).then((res) => res.json());
    assert.equal(acknowledged.status, 'redeemed');

    const redeemed = await fetch(`http://127.0.0.1:${port}/v1/device-sessions/${created.id}`)
      .then((res) => res.json());
    assert.equal(redeemed.status, 'redeemed');
    assert.equal(redeemed.accessToken, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HTTP proxy forwards a streamed response through a bearer-scoped service call', async () => {
  const calls = [];
  const server = http.createServer(creditsRequestListener({
    async proxyOpenRouter(token, input) {
      calls.push({ token, pathname: input.pathname, method: input.method, body: input.body });
      return new Response('data: {"ok":true}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/openrouter/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer rau_v1_http',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(await response.text(), 'data: {"ok":true}\n\n');
    assert.deepEqual(calls, [{
      token: 'rau_v1_http',
      pathname: '/chat/completions',
      method: 'POST',
      body: { model: 'z-ai/glm-5.3-flash', stream: true },
    }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a malformed Host header is rejected without crashing the async request listener', async () => {
  const credits = service();
  const server = http.createServer(creditsRequestListener(credits));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const malformed = await rawHttpRequest(
      port,
      'GET /healthz HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n',
    );
    assert.match(malformed, /^HTTP\/1\.1 400 /);
    const healthy = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { ok: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HTTP v2 accepts only proof-bearing POST redemption and can retire v1', async () => {
  const proof = pkce('d'.repeat(43));
  const credits = service();
  const server = http.createServer(creditsRequestListener(credits));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const createdResponse = await fetch(`http://127.0.0.1:${port}/v2/device-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codeChallenge: proof.challenge,
        codeChallengeMethod: 'S256',
        returnMode: 'manual',
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();

    const authorize = await credits.authorizationUrlV2(created.id);
    const authenticated = await credits.completeLoginV2(
      'ok-code',
      new URL(authorize).searchParams.get('state'),
    );
    const ready = await credits.confirmDeviceSessionV2(created.id, authenticated.confirmationToken);
    const redeemBody = {
      codeVerifier: proof.verifier,
      proof: { kind: 'manual', code: ready.manualCode },
    };
    const getAttempt = await fetch(`http://127.0.0.1:${port}/v2/device-sessions/${created.id}/redeem`);
    assert.equal(getAttempt.status, 404);
    const redeemed = await fetch(`http://127.0.0.1:${port}/v2/device-sessions/${created.id}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(redeemBody),
    });
    assert.equal(redeemed.status, 200);
    assert.equal((await redeemed.json()).apiKey, 'sk-or-v1-minted-1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const retired = service({ minDeviceProtocol: 2 });
  const retiredServer = http.createServer(creditsRequestListener(retired));
  await new Promise((resolve) => retiredServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port: retiredPort } = retiredServer.address();
    const response = await fetch(`http://127.0.0.1:${retiredPort}/v1/device-sessions`, { method: 'POST' });
    assert.equal(response.status, 426);
    assert.equal((await response.json()).error, 'RAU_CLIENT_UPDATE_REQUIRED');
  } finally {
    await new Promise((resolve) => retiredServer.close(resolve));
  }
});

test('HTTP v2 confirm failures render the browser failure page', async () => {
  const credits = service();
  const server = http.createServer(creditsRequestListener(credits));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/v2/device-sessions/missing-session/confirm`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ confirmationToken: 'invalid-token' }),
      },
    );
    const html = await response.text();
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(html, /연결하지 못했어요/);
    assert.match(html, /로그인 세션이 없거나 만료됐어요/);
    assert.match(html, /\/login\?device=missing-session/);
    assert.doesNotMatch(html, /^\s*\{/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('malformed v2 confirm paths return 400 and still consume the IP rate limit', async () => {
  const credits = service();
  const server = http.createServer(creditsRequestListener(credits));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/v2/device-sessions/%ZZ/confirm`, {
        method: 'POST',
      });
      assert.equal(response.status, 400);
    }
    const throttled = await fetch(`http://127.0.0.1:${port}/v2/device-sessions/%ZZ/confirm`, {
      method: 'POST',
    });
    assert.equal(throttled.status, 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('malformed encoded device paths return 400 and drain POST bodies', async () => {
  const listener = creditsRequestListener(service());
  const cases = [
    { method: 'GET', url: '/v1/device-sessions/%ZZ', html: false },
    { method: 'POST', url: '/v1/device-sessions/%ZZ/acknowledge', html: false },
    { method: 'POST', url: '/v2/device-sessions/%ZZ/redeem', html: false },
    { method: 'POST', url: '/v2/device-sessions/%ZZ/acknowledge', html: false },
    { method: 'POST', url: '/v2/device-sessions/%ZZ/confirm', html: true },
  ];

  for (const entry of cases) {
    let resumed = 0;
    let status = null;
    let body = '';
    const req = {
      method: entry.method,
      url: entry.url,
      headers: { host: '127.0.0.1' },
      socket: { remoteAddress: `test-${entry.url}` },
      resume() { resumed += 1; },
    };
    const res = {
      writeHead(code) { status = code; },
      end(value) { body = String(value ?? ''); },
    };
    await listener(req, res);

    assert.equal(status, 400, entry.url);
    if (entry.html) assert.match(body, /연결하지 못했어요/);
    else assert.equal(JSON.parse(body).error, 'REQUEST_TARGET_INVALID');
    if (entry.method === 'POST') assert.equal(resumed, 1, entry.url);
  }
});

test('login page is Rauhwpx-branded and Google continues to WorkOS', async () => {
  const credits = service();
  const server = http.createServer(creditsRequestListener(credits));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const created = await fetch(`http://127.0.0.1:${port}/v1/device-sessions`, { method: 'POST' })
      .then((res) => res.json());
    const login = await fetch(created.loginUrl.replace('https://credits.rau.test', `http://127.0.0.1:${port}`));
    const html = await login.text();
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('cache-control'), 'no-store');
    assert.equal(login.headers.get('x-frame-options'), 'DENY');
    assert.match(login.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.match(html, /Rauhwpx/);
    assert.match(html, /Rau에 연결/);
    assert.match(html, /Google로 계속/);
    assert.match(html, /GitHub로 계속/);
    assert.doesNotMatch(html, /WorkOS/);

    const cont = await fetch(
      `http://127.0.0.1:${port}/continue?device=${created.id}&provider=GoogleOAuth`,
      { redirect: 'manual' },
    );
    assert.equal(cont.status, 302);
    const location = cont.headers.get('location') ?? '';
    assert.match(location, /user_management\/authorize/);
    assert.match(location, /provider=GoogleOAuth/);
    assert.match(location, /prompt=select_account/);
    assert.match(location, /redirect_uri=https%3A%2F%2Fcredits.rau.test%2Fcallback/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('device-session creation is throttled per client IP', async () => {
  const credits = service();
  const server = http.createServer(creditsRequestListener(credits));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    for (let i = 0; i < 10; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/device-sessions`, { method: 'POST' });
      assert.equal(res.status, 200);
    }
    const blocked = await fetch(`http://127.0.0.1:${port}/v1/device-sessions`, { method: 'POST' });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error, 'RATE_LIMITED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('spoofed X-Forwarded-For hops cannot evade the per-client throttle', async () => {
  const credits = service();
  const server = http.createServer(creditsRequestListener(credits));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    for (let i = 0; i < 10; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/device-sessions`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': `198.51.100.${i}, 203.0.113.7` },
      });
      assert.equal(res.status, 200);
    }
    const blocked = await fetch(`http://127.0.0.1:${port}/v1/device-sessions`, {
      method: 'POST',
      headers: { 'X-Forwarded-For': '198.51.100.99, 203.0.113.7' },
    });
    assert.equal(blocked.status, 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('WorkOS callback is throttled per client IP', async () => {
  let completed = 0;
  const server = http.createServer(creditsRequestListener({
    async completeLogin() { completed += 1; },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/callback?code=${i}&state=session`);
      assert.equal(res.status, 200);
    }
    const blocked = await fetch(`http://127.0.0.1:${port}/callback?code=blocked&state=session`);
    assert.equal(blocked.status, 429);
    assert.equal(completed, 20);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('oversized form bodies are rejected without processing', async () => {
  const credits = service();
  const server = http.createServer(creditsRequestListener(credits));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/login/magic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `device=x&email=y@test.dev&pad=${'x'.repeat(20_000)}`,
    });
    assert.equal(res.status, 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Railway uses the public https origin and /data volume path', () => {
  assert.equal(resolveCreditsOrigin({}), `http://127.0.0.1:${DEFAULT_PORT}`);
  assert.equal(
    resolveCreditsOrigin({ RAILWAY_PUBLIC_DOMAIN: 'rau-credits-prod.up.railway.app' }),
    'https://rau-credits-prod.up.railway.app',
  );
  assert.equal(
    resolveCreditsOrigin({ RAU_CREDITS_ORIGIN: 'https://credits.example/' }),
    'https://credits.example',
  );
  assert.equal(resolveCreditsDbPath({}), path.join('.', 'rau-credits.json'));
  assert.equal(
    resolveCreditsDbPath({ RAILWAY_ENVIRONMENT: 'production' }),
    path.join('/data', 'rau-credits.json'),
  );
  assert.throws(
    () => assertCreditsEnv({ RAILWAY_ENVIRONMENT: 'production', SESSION_SECRET: 'x' }),
    /WORKOS_API_KEY/,
  );
});

test('Railway config pins the production health and restart contract', async () => {
  const config = await fs.readFile(new URL('../railway.toml', import.meta.url), 'utf8');
  assert.match(config, /builder = "RAILPACK"/);
  assert.match(config, /startCommand = "node server\.mjs"/);
  assert.match(config, /healthcheckPath = "\/healthz"/);
  assert.match(config, /restartPolicyType = "ON_FAILURE"/);
  assert.match(config, /restartPolicyMaxRetries = 3/);
});

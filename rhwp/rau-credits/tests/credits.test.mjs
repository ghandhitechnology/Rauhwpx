import assert from 'node:assert/strict';
import http from 'node:http';
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
import { creditsRequestListener, createCreditsService } from '../service.mjs';
import { createMemoryStore } from '../store.mjs';
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

test('a corrupted stored record re-mints instead of locking the account out', async () => {
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
  await credits.completeLogin('code-2', retry.id);
  assert.equal(minted.length, 2, 'an undecryptable record must mint a replacement key');
  assert.match((await credits.redeemDeviceSession(retry.id)).accessToken, /^rau_v1_/);
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

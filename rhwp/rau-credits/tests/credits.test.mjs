import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { encryptSecret, decryptSecret } from '../crypto.mjs';
import { RAU_CREDIT_LIMIT_USD, RAU_MODEL_IDS } from '../catalog.mjs';
import {
  DEFAULT_PORT,
  assertCreditsEnv,
  resolveCreditsDbPath,
  resolveCreditsOrigin,
} from '../config.mjs';
import { creditsRequestListener, createCreditsService } from '../service.mjs';
import { createMemoryStore } from '../store.mjs';

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

test('first login mints a $5 key, delivers it until acknowledged, and reuses it', async () => {
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
  assert.equal(redeemed.apiKey, 'sk-or-v1-shared');
  assert.equal(minted.length, 1);

  const repeated = await credits.redeemDeviceSession(first.id);
  assert.equal(repeated.status, 'ready');
  assert.equal(repeated.apiKey, 'sk-or-v1-shared');

  await credits.acknowledgeDeviceSession(first.id);
  const already = await credits.redeemDeviceSession(first.id);
  assert.equal(already.status, 'redeemed');
  assert.equal(already.apiKey, undefined);

  const second = await credits.createDeviceSession();
  await credits.completeLogin('code-2', second.id);
  const again = await credits.redeemDeviceSession(second.id);
  assert.equal(again.apiKey, 'sk-or-v1-shared');
  assert.equal(minted.length, 1, 'the same WorkOS user must not mint another $5');
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
  assert.deepEqual(calls[0].body.allowed_models, [...RAU_MODEL_IDS]);
});

test('HTTP POST creates a session, GET delivers the key, and acknowledgement consumes it', async () => {
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
    assert.equal(ready.apiKey, 'sk-or-v1-minted-1');

    const repeated = await fetch(`http://127.0.0.1:${port}/v1/device-sessions/${created.id}`)
      .then((res) => res.json());
    assert.equal(repeated.apiKey, 'sk-or-v1-minted-1');

    const acknowledged = await fetch(
      `http://127.0.0.1:${port}/v1/device-sessions/${created.id}/acknowledge`,
      { method: 'POST' },
    ).then((res) => res.json());
    assert.equal(acknowledged.status, 'redeemed');

    const redeemed = await fetch(`http://127.0.0.1:${port}/v1/device-sessions/${created.id}`)
      .then((res) => res.json());
    assert.equal(redeemed.status, 'redeemed');
    assert.equal(redeemed.apiKey, undefined);
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
    assert.match(location, /redirect_uri=https%3A%2F%2Fcredits.rau.test%2Fcallback/);
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

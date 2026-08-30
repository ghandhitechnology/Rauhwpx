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
import { creditsRequestListener, createCreditsService } from '../service.mjs';
import { renderReadyPage } from '../pages.mjs';
import { createFileStore, createMemoryStore, syncDirectory } from '../store.mjs';
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
  assert.equal((await credits.redeemDeviceSession(magic.id)).apiKey, 'sk-or-v1-shared-1');

  const repeatedMagic = await credits.createDeviceSession();
  await credits.completeMagicLogin(repeatedMagic.id, 'invalid-email', '123456');
  assert.equal(minted.length, 1, 'the linked WorkOS identity must reuse the key without an email');
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
  assert.equal((await recovered.redeemDeviceSession(session.id)).apiKey, 'sk-or-v1-replacement');
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
  assert.equal((await credits.redeemDeviceSession('device')).apiKey, 'sk-or-v1-prepared');
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
  assert.equal((await credits.redeemDeviceSession('device')).apiKey, 'sk-or-v1-after-reconcile');
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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPkceProof,
  createRauCreditsClient,
  storeRauAccessToken,
  storeRauApiKey,
} from '../rau-credits-client.mjs';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test('Rau credit polling survives transient connectivity failures', async () => {
  const responses = [
    new TypeError('network down'),
    jsonResponse({ status: 'pending' }),
    jsonResponse({ status: 'ready', accessToken: 'rau_v1_ready' }),
  ];
  let clock = 0;
  const client = createRauCreditsClient({
    baseUrl: 'https://credits.rau.test',
    fetchImpl: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  assert.deepEqual(await client.redeem('device-1'), { key: 'rau_v1_ready', email: null });
  assert.equal(clock, 2_000);
});

test('Rau redeem hands the logged-in account email to the key store', async () => {
  const stored = [];
  const client = createRauCreditsClient({
    baseUrl: 'https://credits.rau.test',
    fetchImpl: async () => jsonResponse({
      status: 'ready',
      accessToken: 'rau_v1_ready',
      email: 'andy@example.com',
    }),
  });
  const redeemed = await client.redeem('device-1');
  const status = await storeRauAccessToken(async (key, opts = {}) => {
    stored.push({ key, account: opts.account ?? null });
    return { setupComplete: true };
  }, redeemed.key, { account: redeemed.email });
  assert.deepEqual(status, { setupComplete: true });
  assert.deepEqual(stored, [{ key: 'rau_v1_ready', account: 'andy@example.com' }]);
});

test('Rau redeem rejects an outdated ready response instead of polling until expiry', async () => {
  let clock = 0;
  const client = createRauCreditsClient({
    baseUrl: 'https://credits.rau.test',
    fetchImpl: async () => jsonResponse({
      status: 'ready',
      apiKey: 'sk-or-v1-legacy-provider-key',
    }),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  await assert.rejects(
    () => client.redeem('device-1'),
    { code: 'RAU_LOGIN_SERVER_INCOMPATIBLE' },
  );
  assert.equal(clock, 0);
});

test('Rau key storage receives the auth-run cancellation signal', async () => {
  const abort = new AbortController();
  let receivedSignal = null;
  let committed = false;
  await storeRauApiKey(async (_key, options = {}) => {
    receivedSignal = options.signal;
    options.onCommitted?.();
    return { setupComplete: true };
  }, 'sk-or-v1-ready', {
    signal: abort.signal,
    onCommitted: () => { committed = true; },
  });

  assert.equal(receivedSignal, abort.signal);
  assert.equal(committed, true);
});

test('Rau credit acknowledgement is sent only after local setup can succeed', async () => {
  const calls = [];
  const client = createRauCreditsClient({
    baseUrl: 'https://credits.rau.test',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET' });
      return jsonResponse({ status: 'redeemed' });
    },
  });

  assert.deepEqual(await client.acknowledgeDeviceSession('device/a'), { status: 'redeemed' });
  assert.deepEqual(calls, [{
    url: 'https://credits.rau.test/v1/device-sessions/device%2Fa/acknowledge',
    method: 'POST',
  }]);
});

test('Rau v2 creates PKCE sessions and sends proof only in POST bodies', async () => {
  const calls = [];
  const client = createRauCreditsClient({
    baseUrl: 'https://credits.rau.test',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith('/v2/device-sessions')) {
        return jsonResponse({ id: 'device/a', loginUrl: 'https://credits.rau.test/login?device=x' }, { status: 201 });
      }
      return jsonResponse({ status: 'ready', apiKey: 'sk-or-v1-v2' });
    },
  });
  const session = await client.createDeviceSessionV2({
    redirectUri: 'http://127.0.0.1:4321/oauth/rau/callback',
    callbackState: 's'.repeat(32),
    clientVersion: '1.2.0',
  });
  assert.match(session.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  const createBody = JSON.parse(calls[0].init.body);
  assert.equal(createBody.codeChallengeMethod, 'S256');
  assert.equal(createBody.codeChallenge.length, 43);
  assert.equal(createBody.codeChallenge.includes(session.codeVerifier), false);

  const proof = { kind: 'manual', code: 'ABCD-EFGH-JKLM' };
  await client.redeemDeviceSessionV2(session.id, session.codeVerifier, proof);
  assert.equal(calls[1].url, 'https://credits.rau.test/v2/device-sessions/device%2Fa/redeem');
  assert.equal(calls[1].url.includes(session.codeVerifier), false);
  assert.deepEqual(JSON.parse(calls[1].init.body), { codeVerifier: session.codeVerifier, proof });
});

test('account requests keep the bearer in headers and cancel V2 sessions with PKCE', async () => {
  const calls = [];
  const accountToken = `rau_account_v1_${'a'.repeat(43)}`;
  const client = createRauCreditsClient({
    baseUrl: 'https://credits.rau.test',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith('/v2/device-sessions')) {
        return jsonResponse({ id: 'account/device', loginUrl: 'https://credits.rau.test/login?device=x' }, { status: 201 });
      }
      return jsonResponse({ state: 'signed-in', signedIn: true, account: { email: 'andy@example.com' } });
    },
  });

  const login = await client.createAccountDeviceSessionV2({ currentToken: accountToken });
  await client.readAccountSession(accountToken);
  await client.commitAccountSession(accountToken);
  await client.revokeAccountSession(accountToken);
  await client.cancelDeviceSessionV2(login.id, login.codeVerifier);
  await client.authorizeOwnedBackend(accountToken, {
    pathname: '/owned/profile?view=compact',
    method: 'POST',
    headers: { Authorization: 'Bearer caller-controlled' },
    body: { refresh: true },
  });

  assert.equal(calls.every((call) => !call.url.includes(accountToken)), true);
  assert.equal(JSON.parse(calls[0].init.body).purpose, 'account');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), `Bearer ${accountToken}`);
  assert.equal(calls[4].url, 'https://credits.rau.test/v2/device-sessions/account%2Fdevice/cancel');
  assert.deepEqual(JSON.parse(calls[4].init.body), { codeVerifier: login.codeVerifier });
  assert.equal(calls[4].url.includes(login.codeVerifier), false);
  assert.equal(calls[5].url, 'https://credits.rau.test/owned/profile?view=compact');
  assert.equal(new Headers(calls[5].init.headers).get('authorization'), `Bearer ${accountToken}`);
});

test('PKCE helper returns an S256 verifier/challenge pair', () => {
  const proof = createPkceProof();
  assert.match(proof.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(proof.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(proof.codeVerifier, proof.codeChallenge);
});

test('new Rau access tokens are retried while proxy state propagates', async () => {
  const delays = [];
  let attempts = 0;
  const status = await storeRauAccessToken(async (key) => {
    attempts += 1;
    assert.equal(key, 'rau_v1_new');
    if (attempts < 3) {
      throw Object.assign(new Error('not ready'), { code: 'OPENROUTER_KEY_INVALID' });
    }
    return { keyConfigured: true };
  }, 'rau_v1_new', {
    sleep: async (ms) => { delays.push(ms); },
  });

  assert.deepEqual(status, { keyConfigured: true });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [250, 500]);
});

test('Rau token setup does not retry storage failures', async () => {
  let attempts = 0;
  await assert.rejects(
    storeRauAccessToken(async () => {
      attempts += 1;
      throw Object.assign(new Error('vault failed'), { code: 'SECRET_STORE_FAILED' });
    }, 'rau_v1_new', { sleep: async () => {} }),
    { code: 'SECRET_STORE_FAILED' },
  );
  assert.equal(attempts, 1);
});

test('Rau client exposes the proxy URL and sends the current token for replacement and revocation', async () => {
  const calls = [];
  const client = createRauCreditsClient({
    baseUrl: 'https://credits.rau.test/',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method, authorization: init.headers?.Authorization ?? null });
      return jsonResponse({ revoked: true, id: 'next' });
    },
  });
  assert.equal(client.openRouterBaseUrl, 'https://credits.rau.test/v1/openrouter');
  await client.createDeviceSession({ replaceAccessToken: 'rau_v1_old' });
  await client.revokeAccessToken('rau_v1_old');
  assert.deepEqual(calls, [
    {
      url: 'https://credits.rau.test/v1/device-sessions',
      method: 'POST',
      authorization: 'Bearer rau_v1_old',
    },
    {
      url: 'https://credits.rau.test/v1/access/revoke',
      method: 'POST',
      authorization: 'Bearer rau_v1_old',
    },
  ]);
});

test('Rau account status uses the shared account token', async () => {
  const calls = [];
  const client = createRauCreditsClient({
    baseUrl: 'https://credits.rau.test',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), authorization: init.headers?.Authorization ?? null });
      return jsonResponse({ account: { id: 'user-1', email: 'andy@example.com' } });
    },
  });

  const response = await client.account('rau_v1_account');
  assert.equal(response.account.email, 'andy@example.com');
  assert.deepEqual(calls, [{
    url: 'https://credits.rau.test/v1/account',
    authorization: 'Bearer rau_v1_account',
  }]);
});

test('Rau account status stays local while logged out', async () => {
  let calls = 0;
  const client = createRauCreditsClient({
    fetchImpl: async () => { calls += 1; return jsonResponse({}); },
  });

  const response = await client.account(null);
  assert.equal(calls, 0);
  assert.equal(response.signedIn, false);
  assert.equal(response.raucloud.state, 'logged-out');
});

test('Rau credit requests time out while reading the response body', async () => {
  const client = createRauCreditsClient({
    timeoutMs: 10,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => new Promise(() => {}),
    }),
  });
  await assert.rejects(
    () => client.createDeviceSession(),
    { code: 'RAU_CREDITS_TIMEOUT' },
  );
});

test('Rau credit responses cancel declared oversized bodies before reading', async () => {
  let cancelled = false;
  const client = createRauCreditsClient({
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), {
      status: 200,
      headers: { 'content-length': String((64 * 1024) + 1) },
    }),
  });

  await assert.rejects(
    () => client.createDeviceSession(),
    { code: 'RAU_CREDITS_RESPONSE_TOO_LARGE' },
  );
  assert.equal(cancelled, true);
});

test('Rau cancellation reaches fetch and is never retried', async () => {
  const abort = new AbortController();
  let attempts = 0;
  const client = createRauCreditsClient({
    fetchImpl: async (_url, { signal }) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
    sleep: async () => {},
  });
  const redeeming = client.redeem('device-1', { signal: abort.signal });
  abort.abort();
  await assert.rejects(redeeming, { code: 'RAU_LOGIN_CANCELLED' });
  assert.equal(attempts, 1);

  for (const request of [
    () => client.createDeviceSession({ signal: abort.signal }),
    () => client.pollDeviceSession('device-1', { signal: abort.signal }),
    () => client.acknowledgeDeviceSession('device-1', { signal: abort.signal }),
  ]) {
    await assert.rejects(request, { code: 'RAU_LOGIN_CANCELLED' });
  }
  assert.equal(attempts, 1);
});

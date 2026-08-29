import assert from 'node:assert/strict';
import test from 'node:test';

import { createRauCreditsClient, storeRauApiKey } from '../rau-credits-client.mjs';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test('Rau credit polling survives transient connectivity failures', async () => {
  const responses = [
    new TypeError('network down'),
    jsonResponse({ status: 'pending' }),
    jsonResponse({ status: 'ready', apiKey: 'sk-or-v1-ready' }),
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

  assert.deepEqual(await client.redeem('device-1'), { key: 'sk-or-v1-ready', email: null });
  assert.equal(clock, 2_000);
});

test('Rau redeem hands the logged-in account email to the key store', async () => {
  const stored = [];
  const client = createRauCreditsClient({
    baseUrl: 'https://credits.rau.test',
    fetchImpl: async () => jsonResponse({
      status: 'ready',
      apiKey: 'sk-or-v1-ready',
      email: 'andy@example.com',
    }),
  });
  const redeemed = await client.redeem('device-1');
  const status = await storeRauApiKey(async (key, opts = {}) => {
    stored.push({ key, account: opts.account ?? null });
    return { setupComplete: true };
  }, redeemed.key, { account: redeemed.email });
  assert.deepEqual(status, { setupComplete: true });
  assert.deepEqual(stored, [{ key: 'sk-or-v1-ready', account: 'andy@example.com' }]);
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

test('new Rau keys are retried while OpenRouter propagates them', async () => {
  const delays = [];
  let attempts = 0;
  const status = await storeRauApiKey(async (key) => {
    attempts += 1;
    assert.equal(key, 'sk-or-v1-new');
    if (attempts < 3) {
      throw Object.assign(new Error('not ready'), { code: 'OPENROUTER_KEY_INVALID' });
    }
    return { keyConfigured: true };
  }, 'sk-or-v1-new', {
    sleep: async (ms) => { delays.push(ms); },
  });

  assert.deepEqual(status, { keyConfigured: true });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [250, 500]);
});

test('Rau key setup does not retry storage failures', async () => {
  let attempts = 0;
  await assert.rejects(
    storeRauApiKey(async () => {
      attempts += 1;
      throw Object.assign(new Error('vault failed'), { code: 'SECRET_STORE_FAILED' });
    }, 'sk-or-v1-new', { sleep: async () => {} }),
    { code: 'SECRET_STORE_FAILED' },
  );
  assert.equal(attempts, 1);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProviderBalancesClient } from '../provider-balances.mjs';
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-balances-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'auth.json');
  await fs.writeFile(file, JSON.stringify({ 'https://accounts.x.ai/sign-in': { key: 'test-token', user_id: 'test-user', auth_mode: 'oidc' } }));
  return { file, client: createProviderBalancesClient({ getGrokAuthPath: () => file, ...options }) };
}
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
test('Grok remote credits and weekly percentage use official schema', async t => {
  const { client } = await fixture(t, { now: () => 123, fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits');
    assert.equal(opts.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
    return response({ config: { prepaidBalance: { val: 1234 }, creditUsagePercent: 28, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-01T00:00:00Z' } } });
  } });
  const data = await client.refresh();
  assert.equal(data.grok.balanceUsd, 12.34); assert.equal(data.grok.windows[0].remainingPercent, 72); assert.equal(data.grok.updatedAt, 123);
});
test('explicit empty Cent means zero but missing credit fields remain unknown', async t => {
  let config = { prepaidBalance: {} };
  const { client } = await fixture(t, { fetchImpl: async () => response({ config }) });
  assert.equal((await client.refresh()).grok.balanceUsd, 0);
  config = {};
  const result = (await client.refresh(true)).grok;
  assert.equal(result.balanceUsd, null); assert.equal(result.status, 'unavailable');
});
test('OpenCode Go fetches remote windows and never fabricates a wallet', async () => {
  const client = createProviderBalancesClient({ getProviderEnv: () => ({ OPENCODE_API_KEY: 'test-key' }), fetchImpl: async url => {
    assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
    return response({ usage: { rolling: { percent: 5 }, weekly: { percent: 41 }, monthly: { percent: 67 } } });
  } });
  const result = (await client.refresh()).opencode;
  assert.deepEqual(result.windows.map(x => x.remainingPercent), [95, 59, 33]); assert.equal(result.balanceUsd, null);
});
test('failed refresh retains old data but changed credentials clear it', async t => {
  let fail = false;
  const { client, file } = await fixture(t, { fetchImpl: async () => fail ? response({ error: 'secret-test-token' }, 401) : response({ config: { prepaidBalance: { val: 500 } } }) });
  await client.refresh(); fail = true;
  let data = (await client.refresh(true)).grok;
  assert.equal(data.balanceUsd, 5); assert.equal(data.status, 'error'); assert.ok(!data.error.includes('secret'));
  await fs.writeFile(file, JSON.stringify({ 'https://accounts.x.ai/sign-in': { key: 'different', user_id: 'other', auth_mode: 'oidc' } }));
  data = (await client.refresh(true)).grok;
  assert.equal(data.balanceUsd, null); assert.equal(data.updatedAt, null);
});
test('xAI management ledger credit sign is converted to available USD', async () => {
  const client = createProviderBalancesClient({ getProviderEnv: () => ({ XAI_MANAGEMENT_API_KEY: 'management', XAI_TEAM_ID: 'team' }), fetchImpl: async () => response({ total: { val: '-1000' } }) });
  assert.equal((await client.refresh()).grok.balanceUsd, 10);
});
test('no credentials perform no requests', async () => {
  const client = createProviderBalancesClient({ fetchImpl: () => assert.fail('unexpected request') });
  const result = await client.refresh(); assert.equal(result.grok.status, 'unavailable'); assert.equal(result.opencode.status, 'unavailable');
});
test('deadline covers fetch and body implementations ignoring abort', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => ({ ok: true, text: () => new Promise(() => {}) })]) {
    const client = createProviderBalancesClient({ timeoutMs: 10, getProviderEnv: () => ({ OPENCODE_API_KEY: 'key' }), fetchImpl });
    assert.equal((await client.refresh()).opencode.status, 'error');
  }
});
test('invalidate prevents an already pending request from repopulating cache', async t => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { client } = await fixture(t, { fetchImpl: () => { started(); return new Promise(resolve => { finish = resolve; }); } });
  const pending = client.refresh(); await ready; client.invalidate(); finish(response({ config: { prepaidBalance: { val: 900 } } })); await pending;
  assert.equal(client.snapshot().grok.balanceUsd, null);
});
test('file rotation during network request discards old account result', async t => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { client, file } = await fixture(t, { fetchImpl: () => { started(); return new Promise(resolve => { finish = resolve; }); } });
  const pending = client.refresh(); await ready;
  await fs.writeFile(file, JSON.stringify({ 'https://auth.x.ai': { key: 'new', user_id: 'new-user', auth_mode: 'oidc' } }));
  finish(response({ config: { prepaidBalance: { val: 900 } } })); await pending;
  assert.equal(client.snapshot().grok.balanceUsd, null);
});
test('OpenCode non-Go entitlement clears stale windows and returns unavailable', async () => {
  let denied = false;
  const client = createProviderBalancesClient({ getProviderEnv: () => ({ OPENCODE_API_KEY: 'key' }), fetchImpl: async () => denied ? response({}, 403) : response({ usage: { weekly: { percent: 2 } } }) });
  await client.refresh(); denied = true;
  const result = (await client.refresh(true)).opencode;
  assert.equal(result.status, 'unavailable'); assert.equal(result.windows, undefined); assert.match(result.error, /Go 구독/);
});
test('ignores symlink credentials and non-xAI auth issuer', async t => {
  const { client, file } = await fixture(t, { fetchImpl: () => assert.fail('must not send foreign credentials') });
  await fs.writeFile(file, JSON.stringify({ 'https://other.example': { key: 'foreign', user_id: 'user', auth_mode: 'oidc' } }));
  assert.equal((await client.refresh()).grok.status, 'unavailable');
  const real = `${file}.real`; await fs.rename(file, real); await fs.symlink(real, file);
  assert.equal((await client.refresh()).grok.status, 'unavailable');
});

test('expired Grok login requests reconnection without sending expired credentials', async t => {
  let calls = 0;
  const { file, client } = await fixture(t, { fetchImpl: async () => { calls++; return response({}); } });
  await fs.writeFile(file, JSON.stringify({ 'https://auth.x.ai': {
    key: 'expired-token', user_id: 'test-user', auth_mode: 'oidc', expires_at: '2000-01-01T00:00:00Z',
  } }));
  const result = (await client.refresh(true)).grok;
  assert.equal(calls, 0);
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /만료/);
  assert.equal(result.balanceUsd, null);
});

test('Grok API-key mode never reuses a different saved OAuth account balance', async t => {
  let apiKey = '';
  let calls = 0;
  const { client } = await fixture(t, {
    getProviderEnv: () => ({ XAI_API_KEY: apiKey }),
    fetchImpl: async () => { calls++; return response({ config: { prepaidBalance: { val: 500 } } }); },
  });
  assert.equal((await client.refresh()).grok.balanceUsd, 5);
  apiKey = 'different-account-api-key';
  const result = (await client.refresh(true)).grok;
  assert.equal(calls, 1);
  assert.equal(result.balanceUsd, null);
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /관리 키/);
});

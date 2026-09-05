import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProviderLimitsClient, readCodexRateLimits } from '../provider-limits.mjs';

const KEY = '9d5522c0-0ee7-45fd-9fa7-4d30c3e56e5b';
const SECOND_KEY = 'edf6b23f-eb63-46f7-95ed-5c0f7fc24701';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const rpcUsage = () => ({
  rateLimits: {
    primary: { usedPercent: 70, windowDurationMins: 300, resetsAt: 1800000000 },
    secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 1800500000 },
    planType: 'pro',
  },
  rateLimitResetCredits: { availableCount: 2, nextExpiresAt: 1800700000 },
});

function fixture(overrides = {}) {
  const calls = [];
  const current = { accountId: 'account-one', token: 'codex-access-secret', failing: false, claude: true, time: 1800000000000 };
  const options = {
    env: {}, platform: 'linux', homeDir: '/fixture-home', resetLedgerPath: null,
    now: () => current.time,
    readCredentials: async (file) => file.endsWith('auth.json')
      ? { tokens: { access_token: current.token, account_id: current.accountId } }
      : current.claude ? { claudeAiOauth: { accessToken: 'claude-secret', subscriptionType: 'max' } } : null,
    codexRpc: async () => {
      if (current.failing) throw new Error('sensitive rpc details');
      return rpcUsage();
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (current.failing) throw new Error('sensitive network details');
      if (url.includes('anthropic.com')) return json({ five_hour: { utilization: 22, resets_at: '2027-01-15T10:00:00Z' }, seven_day: { utilization: 56, resets_at: null } });
      if (url.endsWith('/consume')) return json({ code: 'reset' });
      throw new Error(`Unexpected fixture URL: ${url}`);
    },
    ...overrides,
  };
  return { client: createProviderLimitsClient(options), current, calls, options };
}

test('reads both providers, normalizes quota windows and never exposes credentials', async () => {
  const { client, calls } = fixture();
  const result = await client.refresh();
  assert.equal(result.claude.session.percent, 22);
  assert.equal(result.claude.planType, 'max');
  assert.equal(result.codex.session.percent, 70);
  assert.equal(result.codex.session.resetsAt, 1800000000000);
  assert.equal(result.codex.resetCredits.availableCount, 2);
  assert.equal(result.codex.resetCredits.nextExpiresAt, 1800700000000);
  assert.match(result.codex.accountKey, /^[a-f0-9]{64}$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer claude-secret');
  assert.doesNotMatch(JSON.stringify(result), /secret|account-one/);
  result.codex.session.percent = 0;
  assert.equal(client.snapshot().codex.session.percent, 70);
});

test('coalesces reads, caches polls, and forces a manual refresh', async () => {
  let reads = 0;
  const { client } = fixture({ codexRpc: async () => { reads++; return rpcUsage(); } });
  await Promise.all([client.refresh(), client.refresh(true), client.refresh()]);
  assert.equal(reads, 1);
  await client.refresh();
  assert.equal(reads, 1);
  await client.refresh(true);
  assert.equal(reads, 2);
});

test('preserves stale readings on same-account errors and discards them when the account changes', async () => {
  const { client, current } = fixture();
  await client.refresh();
  current.time += 10_000;
  current.failing = true;
  const stale = await client.refresh(true);
  assert.equal(stale.codex.status, 'error');
  assert.equal(stale.codex.session.percent, 70);
  assert.equal(stale.codex.updatedAt, 1800000000000);
  assert.doesNotMatch(stale.codex.error, /sensitive/);
  current.accountId = 'another-account';
  const changed = await client.refresh(true);
  assert.equal(changed.codex.session.percent, null);
  assert.equal(changed.codex.updatedAt, null);
  assert.notEqual(changed.codex.accountKey, stale.codex.accountKey);
});

test('account keys remain stable across opaque token rotation', async () => {
  const { client, current } = fixture();
  const before = await client.refresh();
  current.token = 'rotated-secret';
  const after = await client.refresh(true);
  assert.equal(after.codex.accountKey, before.codex.accountKey);
});

test('API-key mode and signed-out providers report unavailable without probing subscription usage', async () => {
  const { client, calls } = fixture({ getAuthMethod: () => 'api-key', readCredentials: () => { throw new Error('must not read'); } });
  const result = await client.refresh();
  assert.equal(result.codex.status, 'unavailable');
  assert.equal(result.claude.status, 'unavailable');
  assert.equal(calls.length, 0);
});

test('uses scoped Claude Keychain credentials and never falls back to another keychain account', async () => {
  const services = [];
  const { client } = fixture({ platform: 'darwin', env: { CLAUDE_CONFIG_DIR: '/custom/claude' },
    keychainRead: async (service) => { services.push(service); return { claudeAiOauth: { accessToken: 'scoped-secret' } }; } });
  await client.refresh();
  const suffix = createHash('sha256').update('/custom/claude').digest('hex').slice(0, 8);
  assert.deepEqual(services, [`Claude Code-credentials-${suffix}`, `Claude Code-credentials-${suffix}`]);
});

test('re-reads a rotated Claude login after an authentication failure', async () => {
  let token = 'expired';
  const seen = [];
  const { client } = fixture({
    readCredentials: async (file) => file.endsWith('auth.json') ? null : { claudeAiOauth: { accessToken: token } },
    fetchImpl: async (_url, init) => {
      seen.push(init.headers.Authorization);
      if (token === 'expired') { token = 'rotated'; return json({ secret: 'never expose' }, 401); }
      return json({ five_hour: { utilization: 12 } });
    },
  });
  assert.equal((await client.refresh()).claude.session.percent, 12);
  assert.deepEqual(seen, ['Bearer expired', 'Bearer rotated']);
});

test('selects configured Codex home first and falls back only if its auth file is missing', async () => {
  const homes = [];
  const { client } = fixture({ env: { CODEX_HOME: '/selected/codex' },
    readCredentials: async (file) => file === '/fixture-home/.codex/auth.json' ? { tokens: { access_token: 'test', account_id: 'account' } } : null,
    codexRpc: async ({ env }) => { homes.push(env.CODEX_HOME); return rpcUsage(); } });
  await client.refresh();
  assert.deepEqual(homes, ['/fixture-home/.codex']);
});

test('supplements a weekly-only RPC result with HTTP session usage and detailed reset expiry', async () => {
  const { client } = fixture({
    codexRpc: async () => ({ rateLimits: { primary: rpcUsage().rateLimits.secondary }, rateLimitResetCredits: { availableCount: 2 } }),
    fetchImpl: async (url) => {
      if (url.includes('anthropic')) return json({ five_hour: { utilization: 0 } });
      if (url.endsWith('/usage')) return json({ plan_type: 'pro', rate_limit: { primary_window: { used_percent: 18, limit_window_seconds: 18000, reset_at: 1800000000 } } });
      return json({ credits: [{ status: 'available', expires_at: '2027-01-25T00:00:00Z' }, { status: 'redeemed', expires_at: '2027-01-01T00:00:00Z' }] });
    },
  });
  const { codex } = await client.refresh();
  assert.equal(codex.session.percent, 18);
  assert.equal(codex.week.percent, 45);
  assert.equal(codex.resetCredits.availableCount, 1);
  assert.equal(codex.resetCredits.nextExpiresAt, Date.parse('2027-01-25T00:00:00Z'));
});

test('falls back to HTTP if Codex CLI is absent and rejects malformed quota responses', async () => {
  let malformed = false;
  const { client } = fixture({ codexRpc: async () => { throw new Error('ENOENT'); },
    fetchImpl: async (url) => url.endsWith('/usage') ? json(malformed ? { rate_limit: {} } : { rate_limit: { primary_window: { used_percent: 150, limit_window_seconds: 18000 } } }) : json({ available_count: 0 }),
  });
  assert.equal((await client.refresh()).codex.session.percent, 100);
  malformed = true;
  const { codex } = await client.refresh(true);
  assert.equal(codex.status, 'error');
  assert.equal(codex.session.percent, 100);
});

test('rejects an account change during the RPC read instead of displaying previous account data', async () => {
  const { client, current } = fixture({ codexRpc: async () => { current.accountId = 'changed-during-rpc'; return rpcUsage(); } });
  const result = await client.refresh();
  assert.equal(result.codex.status, 'error');
  assert.equal(result.codex.session.percent, null);
});

test('invalidating an in-flight refresh prevents it from replacing the new account snapshot', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let first = true;
  const { client } = fixture({ codexRpc: async () => {
    if (first) { first = false; await held; return rpcUsage(); }
    const result = rpcUsage();
    result.rateLimits.primary.usedPercent = 8;
    return result;
  } });
  const initial = client.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  client.invalidate();
  assert.equal(client.snapshot().codex.session.percent, null);
  assert.equal((await client.refresh()).codex.session.percent, 8);
  release();
  await initial;
  assert.equal(client.snapshot().codex.session.percent, 8);
});

test('does not publish Claude quotas after a login change during HTTP fetch', async () => {
  let token = 'initial-account';
  const { client } = fixture({
    readCredentials: async (file) => file.endsWith('auth.json') ? null : { claudeAiOauth: { accessToken: token } },
    fetchImpl: async () => { token = 'new-account'; return json({ five_hour: { utilization: 65 } }); },
  });
  const { claude } = await client.refresh();
  assert.equal(claude.status, 'error');
  assert.equal(claude.session.percent, null);
});

test('bounds HTTP response size and sanitizes provider error bodies', async () => {
  const { client } = fixture({ fetchImpl: async () => new Response('secret'.repeat(50000)) });
  const result = await client.refresh();
  assert.equal(result.claude.status, 'error');
  assert.match(result.claude.error, /too large/);
  assert.doesNotMatch(result.claude.error, /secret/);
});

test('serializes duplicate reset clicks, sends a pinned account header and refetches usage', async () => {
  const { client, calls } = fixture();
  const { codex } = await client.refresh();
  const input = { accountKey: codex.accountKey, idempotencyKey: KEY };
  const results = await Promise.all([client.consumeCodexReset(input), client.consumeCodexReset(input)]);
  assert.equal(results[0].outcome, 'reset');
  assert.equal(results[1].outcome, 'reset');
  const requests = calls.filter((call) => call.url.endsWith('/consume'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers['ChatGPT-Account-Id'], 'account-one');
  assert.deepEqual(JSON.parse(requests[0].init.body), { redeem_request_id: KEY });
});

test('rejects stale-account reset actions before making a mutation', async () => {
  const { client, current, calls } = fixture();
  const { codex } = await client.refresh();
  current.accountId = 'another-account';
  await assert.rejects(client.consumeCodexReset({ accountKey: codex.accountKey, idempotencyKey: KEY }), { code: 'PROVIDER_ACCOUNT_CHANGED' });
  assert.equal(calls.filter((call) => call.url.endsWith('/consume')).length, 0);
});

test('recovers ambiguous resets across restart using the original key even if renderer storage was lost', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-provider-limit-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, 'resets.json');
  const initial = fixture({ resetLedgerPath: ledgerPath });
  const originalFetch = initial.options.fetchImpl;
  initial.options.fetchImpl = async (url, init) => {
    if (url.endsWith('/consume')) throw new Error('connection dropped after provider committed');
    return originalFetch(url, init);
  };
  const first = createProviderLimitsClient(initial.options);
  const { codex } = await first.refresh();
  await assert.rejects(first.consumeCodexReset({ accountKey: codex.accountKey, idempotencyKey: KEY }));
  assert.doesNotMatch(await fs.readFile(ledgerPath, 'utf8'), /secret|account-one/);
  const next = fixture({ resetLedgerPath: ledgerPath });
  await next.client.refresh();
  assert.equal((await next.client.consumeCodexReset({ accountKey: codex.accountKey, idempotencyKey: SECOND_KEY })).outcome, 'reset');
  assert.equal((await next.client.consumeCodexReset({ accountKey: codex.accountKey, idempotencyKey: SECOND_KEY })).outcome, 'reset');
  assert.equal((await next.client.consumeCodexReset({ accountKey: codex.accountKey, idempotencyKey: KEY })).outcome, 'reset');
  assert.equal(next.calls.filter((call) => call.url.endsWith('/consume')).length, 1);
  const mutation = next.calls.find((call) => call.url.endsWith('/consume'));
  assert.deepEqual(JSON.parse(mutation.init.body), { redeem_request_id: KEY });
  const reopened = fixture({ resetLedgerPath: ledgerPath });
  await reopened.client.refresh();
  assert.equal((await reopened.client.consumeCodexReset({ accountKey: codex.accountKey, idempotencyKey: SECOND_KEY })).outcome, 'reset');
  assert.equal(reopened.calls.filter((call) => call.url.endsWith('/consume')).length, 0);
});

test('refuses to redeem when the durable reset history is corrupt', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-provider-limit-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const resetLedgerPath = path.join(directory, 'resets.json');
  await fs.writeFile(resetLedgerPath, '{corrupt');
  const { client, calls } = fixture({ resetLedgerPath });
  const { codex } = await client.refresh();
  await assert.rejects(client.consumeCodexReset({ accountKey: codex.accountKey, idempotencyKey: KEY }), { code: 'PROVIDER_RESET_HISTORY_UNAVAILABLE' });
  assert.equal(calls.filter((call) => call.url.endsWith('/consume')).length, 0);
});

test('does not redeem without a reported available credit', async () => {
  const { client, calls } = fixture({ codexRpc: async () => ({ ...rpcUsage(), rateLimitResetCredits: { availableCount: 0 } }) });
  const { codex } = await client.refresh();
  await assert.rejects(client.consumeCodexReset({ accountKey: codex.accountKey, idempotencyKey: KEY }), { code: 'PROVIDER_RESET_UNAVAILABLE' });
  assert.equal(calls.filter((call) => call.url.endsWith('/consume')).length, 0);
});

test('unknown reset outcomes retain the original idempotency key for recovery', async () => {
  const requests = [];
  const base = fixture();
  const client = createProviderLimitsClient({ ...base.options, fetchImpl: (url, init) => {
    if (!url.endsWith('/consume')) return base.options.fetchImpl(url, init);
    requests.push(JSON.parse(init.body).redeem_request_id);
    return Promise.resolve(json({ code: requests.length === 1 ? 'constructor' : 'already_redeemed' }));
  } });
  const { codex } = await client.refresh();
  await assert.rejects(client.consumeCodexReset({ accountKey: codex.accountKey, idempotencyKey: KEY }), { code: 'PROVIDER_RESET_PENDING' });
  assert.equal((await client.consumeCodexReset({ accountKey: codex.accountKey, idempotencyKey: SECOND_KEY })).outcome, 'alreadyRedeemed');
  assert.deepEqual(requests, [KEY, KEY]);
});

for (const [code, outcome] of Object.entries({ nothing_to_reset: 'nothingToReset', no_credit: 'noCredit', already_redeemed: 'alreadyRedeemed' })) {
  test(`maps reset outcome ${code}`, async () => {
    const base = fixture();
    const client = createProviderLimitsClient({ ...base.options, fetchImpl: (url, init) => url.endsWith('/consume') ? Promise.resolve(json({ code })) : base.options.fetchImpl(url, init) });
    const { codex } = await client.refresh();
    assert.equal((await client.consumeCodexReset({ accountKey: codex.accountKey, idempotencyKey: KEY })).outcome, outcome);
  });
}

function fakeRpcProcess(reply) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.exitCode = null;
  child.messages = [];
  child.stdin.end = () => {};
  child.stdin.write = (line) => {
    const message = JSON.parse(line);
    child.messages.push(message);
    queueMicrotask(() => reply(child, message));
  };
  child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); };
  return child;
}

test('Codex app-server initializes, reads quotas, and closes without creating a thread', async () => {
  const child = fakeRpcProcess((proc, message) => {
    if (!message.id) return;
    const line = `${JSON.stringify({ id: message.id, result: message.id === 1 ? {} : rpcUsage() })}\n`;
    proc.stdout.emit('data', Buffer.from(line.slice(0, 12)));
    proc.stdout.emit('data', Buffer.from(line.slice(12)));
  });
  const env = { PATH: '/bin', CODEX_HOME: '/codex', CLAUDE_CODE_OAUTH_TOKEN: 'foreign-secret', OPENROUTER_API_KEY: 'another-secret' };
  const result = await readCodexRateLimits({ env, spawnProcess: (_bin, args, options) => {
    assert.deepEqual(args, ['-s', 'read-only', '-a', 'never', 'app-server']);
    assert.deepEqual(options.env, { PATH: '/bin', CODEX_HOME: '/codex' });
    return child;
  } });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'foreign-secret', 'the parent environment remains unchanged');
  assert.deepEqual(result, rpcUsage());
  assert.deepEqual(child.messages.map((message) => message.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.equal(child.exitCode, 0);
});

test('Codex app-server timeout kills the subprocess and returns a safe error', async () => {
  const child = fakeRpcProcess(() => {});
  await assert.rejects(readCodexRateLimits({ spawnProcess: () => child, timeoutMs: 10 }), { code: 'PROVIDER_TIMEOUT' });
  assert.equal(child.exitCode, 0);
});

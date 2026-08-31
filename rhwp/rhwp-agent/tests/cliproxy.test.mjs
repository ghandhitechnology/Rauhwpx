import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyCliproxyToSummary,
  cliproxyConfigFromEnv,
  createCliproxyClient,
  DEFAULT_CLIPROXY_URL,
  MAX_CLIPROXY_KEY_CHARS,
  normalizeCliproxyUrl,
  parseClaudeUsage,
  parseCodexUsage,
  summarizeAuthFiles,
} from '../cliproxy.mjs';
import { replaceFileAtomically } from '../harness-update.mjs';

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cliproxy-'));
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test('normalizes host-only addresses to the default scheme and strips a trailing slash', () => {
  assert.equal(normalizeCliproxyUrl('127.0.0.1:8317'), 'http://127.0.0.1:8317');
  assert.equal(normalizeCliproxyUrl('http://127.0.0.1:8317/'), 'http://127.0.0.1:8317');
  assert.equal(normalizeCliproxyUrl('https://cpa.example.com'), 'https://cpa.example.com');
});

test('rejects empty, non-http, and credential-bearing URLs', () => {
  assert.throws(() => normalizeCliproxyUrl(''), { code: 'INVALID_CLIPROXY_URL' });
  assert.throws(() => normalizeCliproxyUrl('ftp://127.0.0.1:8317'), { code: 'INVALID_CLIPROXY_URL' });
  assert.throws(() => normalizeCliproxyUrl('http://user:pass@127.0.0.1:8317'), { code: 'INVALID_CLIPROXY_URL' });
});

test('env config fills the default local URL when only the key is set', () => {
  assert.equal(cliproxyConfigFromEnv({}), null);
  assert.deepEqual(
    cliproxyConfigFromEnv({ RHWP_CLIPROXY_KEY: 'secret' }),
    { url: DEFAULT_CLIPROXY_URL, key: 'secret', enabled: true, source: 'env' },
  );
});

test('Claude usage accepts both 0–1 utilization and 0–100 percent', () => {
  assert.deepEqual(
    parseClaudeUsage({
      five_hour: { utilization: 0.234, resets_at: '2026-08-13T06:00:00.000Z' },
      seven_day: { utilization: 81.5, resets_at: '2026-08-18T00:00:00.000Z' },
    }),
    {
      session: { percent: 23.4, resetsAt: Date.parse('2026-08-13T06:00:00.000Z') },
      week: { percent: 81.5, resetsAt: Date.parse('2026-08-18T00:00:00.000Z') },
    },
  );
});

test('Codex usage reads 5h/7d windows from the official rate-limit payload', () => {
  const parsed = parseCodexUsage({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { limit_window_seconds: 18000, used_percent: 12.5, reset_at: 1_776_086_400 },
      secondary_window: { limit_window_seconds: 604800, used_percent: 40, reset_at: 1_776_172_800 },
    },
  });
  assert.equal(parsed.planType, 'plus');
  assert.equal(parsed.session.percent, 12.5);
  assert.equal(parsed.week.percent, 40);
  assert.equal(parsed.session.resetsAt, 1_776_086_400_000);
});

test('auth-file summary keeps enabled Claude/Codex accounts and drops the rest', () => {
  const accounts = summarizeAuthFiles({
    files: [
      { name: 'claude.json', type: 'claude', auth_index: '1', email: 'a@example.com', disabled: false },
      { name: 'old.json', type: 'claude', auth_index: '9', disabled: true },
      { name: 'codex.json', provider: 'codex', auth_index: '2', id_token: { chatgpt_account_id: 'acct_1', plan_type: 'plus' } },
      { name: 'gemini.json', type: 'gemini', auth_index: '3' },
    ],
  });
  assert.deepEqual(accounts.map((account) => account.agent), ['claude', 'codex']);
  assert.equal(accounts[1].accountId, 'acct_1');
  assert.equal(accounts[1].planType, 'plus');
});

test('applyCliproxyToSummary overlays actual percents and keeps local token totals', () => {
  const summary = {
    plans: { claude: 'pro', codex: 'plus' },
    providers: {
      claude: {
        session: { turns: 2, weightedTokens: 100, percent: 0.1 },
        week: { turns: 4, weightedTokens: 400, percent: 0.2 },
        day: { turns: 2, weightedTokens: 100 },
        updatedAt: 1,
      },
      codex: {
        session: { turns: 1, weightedTokens: 10, percent: 0.3 },
        week: { turns: 1, weightedTokens: 10, percent: 0.4 },
        day: { turns: 1, weightedTokens: 10 },
        updatedAt: 1,
      },
    },
  };
  const next = applyCliproxyToSummary(summary, {
    configured: true,
    connected: true,
    url: DEFAULT_CLIPROXY_URL,
    error: null,
    checkedAt: 99,
    accounts: [{
      agent: 'claude',
      name: 'claude.json',
      email: 'a@example.com',
      planType: 'max',
      session: { percent: 18.2, resetsAt: 200 },
      week: { percent: 44, resetsAt: 300 },
      error: null,
    }],
  });
  assert.equal(next.providers.claude.source, 'cliproxy');
  assert.equal(next.providers.claude.session.percent, 18.2);
  assert.equal(next.providers.claude.session.weightedTokens, 100);
  assert.equal(next.providers.claude.week.percent, 44);
  assert.equal(next.providers.claude.updatedAt, 99);
  assert.equal(next.providers.codex.source, 'estimate');
  assert.equal(next.providers.codex.session.percent, 0.3);
  assert.equal(next.cliproxy.connected, true);
});

test('connect persists the key, queries official usage, and never returns the secret', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const calls = [];
  const client = createCliproxyClient({
    rootDir,
    now: () => 1_700_000_000_000,
    env: {},
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, hasKey: String(init.headers.Authorization ?? '').includes('secret-key') });
      if (String(url).endsWith('/auth-files')) {
        return jsonResponse(200, {
          files: [
            { name: 'claude.json', type: 'claude', auth_index: 'c1', email: 'claude@example.com' },
            {
              name: 'codex.json', type: 'codex', auth_index: 'x1',
              id_token: { chatgpt_account_id: 'acct_9', plan_type: 'plus' },
            },
          ],
        });
      }
      const body = JSON.parse(init.body);
      if (body.url.includes('oauth/usage')) {
        return jsonResponse(200, {
          status_code: 200,
          body: { five_hour: { utilization: 0.2 }, seven_day: { utilization: 0.5 } },
        });
      }
      return jsonResponse(200, {
        status_code: 200,
        body: {
          plan_type: 'plus',
          rate_limit: {
            primary_window: { limit_window_seconds: 18000, used_percent: 11 },
            secondary_window: { limit_window_seconds: 604800, used_percent: 22 },
          },
        },
      });
    },
  });
  await client.init();
  const status = await client.connect({ url: '127.0.0.1:8317', key: 'secret-key' });
  assert.equal(status.connected, true);
  assert.equal(status.url, DEFAULT_CLIPROXY_URL);
  assert.equal(JSON.stringify(status).includes('secret-key'), false);
  assert.equal(status.accounts[0].session.percent, 20);
  assert.equal(status.accounts[1].week.percent, 22);
  assert.ok(calls.every((call) => call.hasKey));
  assert.ok(calls.some((call) => call.url.endsWith('/auth-files')));
  assert.ok(calls.some((call) => call.url.endsWith('/api-call')));

  const saved = JSON.parse(await fs.readFile(path.join(rootDir, 'cliproxy.json'), 'utf8'));
  assert.equal(saved.key, 'secret-key');
  assert.equal(
    (await fs.stat(path.join(rootDir, 'cliproxy.json'))).mode & 0o777,
    process.platform === 'win32' ? 0o666 : 0o600,
  );

  const reloaded = await createCliproxyClient({
    rootDir,
    env: {},
    fetchImpl: async () => jsonResponse(200, { files: [] }),
  }).init();
  assert.equal(reloaded.configured(), true);

  await client.disconnect();
  assert.equal(client.status().configured, false);
  const after = JSON.parse(await fs.readFile(path.join(rootDir, 'cliproxy.json'), 'utf8'));
  assert.equal(after.enabled, false);
  assert.equal(after.key, '');
});

test('connect fails closed on a bad management key and does not persist it', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const client = createCliproxyClient({
    rootDir,
    env: {},
    fetchImpl: async () => jsonResponse(401, { error: 'unauthorized' }),
  });
  await client.init();
  await assert.rejects(() => client.connect({ url: DEFAULT_CLIPROXY_URL, key: 'nope' }), /관리 키/);
  await assert.rejects(fs.readFile(path.join(rootDir, 'cliproxy.json')));
});

test('connect bounds management keys before network access and persists a reloadable maximum', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  let fetches = 0;
  const client = await createCliproxyClient({
    rootDir,
    env: {},
    fetchImpl: async () => {
      fetches += 1;
      return jsonResponse(200, { files: [] });
    },
  }).init();

  await assert.rejects(
    client.connect({ url: DEFAULT_CLIPROXY_URL, key: 'k'.repeat(MAX_CLIPROXY_KEY_CHARS + 1) }),
    { code: 'INVALID_CLIPROXY_KEY' },
  );
  assert.equal(fetches, 0);
  await assert.rejects(fs.access(client.configPath), { code: 'ENOENT' });

  await client.connect({
    url: DEFAULT_CLIPROXY_URL,
    key: 'k'.repeat(MAX_CLIPROXY_KEY_CHARS),
  });
  const reloaded = await createCliproxyClient({ rootDir, env: {} }).init();
  assert.equal(reloaded.configured(), true);
});

test('failed CLIProxy persistence leaves memory unchanged and does not poison later writes', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  let failNext = true;
  const client = await createCliproxyClient({
    rootDir,
    env: {},
    fetchImpl: async () => jsonResponse(200, { files: [] }),
    async replaceFile(temp, target, options) {
      if (failNext) {
        failNext = false;
        throw new Error('injected persistence failure');
      }
      return replaceFileAtomically(temp, target, options);
    },
  }).init();

  await assert.rejects(
    client.connect({ url: DEFAULT_CLIPROXY_URL, key: 'first-key' }),
    /injected persistence failure/,
  );
  assert.equal(client.configured(), false);
  await client.connect({ url: DEFAULT_CLIPROXY_URL, key: 'second-key' });
  assert.equal(client.configured(), true);
  assert.equal(JSON.parse(await fs.readFile(client.configPath, 'utf8')).key, 'second-key');
});

test('CLIProxy recovers a Windows config left at the replacement gap', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const configPath = path.join(rootDir, 'cliproxy.json');
  await fs.writeFile(`${configPath}.previous-write`, JSON.stringify({
    url: DEFAULT_CLIPROXY_URL,
    key: 'recovered-key',
    enabled: true,
  }));

  const client = await createCliproxyClient({
    rootDir,
    platform: 'win32',
    env: {},
    fetchImpl: async () => jsonResponse(200, { files: [] }),
  }).init();
  assert.equal(client.configured(), true);
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).key, 'recovered-key');
});

test('init rejects an oversized persistent config before parsing its management key', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(rootDir, 'cliproxy.json'), Buffer.alloc(64 * 1024 + 1, 0x20));

  await assert.rejects(createCliproxyClient({ rootDir, env: {} }).init(), {
    code: 'BOUNDED_FILE_TOO_LARGE',
  });
});

test('management responses above 8 MiB fail without being parsed or persisted', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const client = await createCliproxyClient({
    rootDir,
    env: {},
    fetchImpl: async () => new Response(Buffer.alloc(8 * 1024 * 1024 + 1), { status: 200 }),
  }).init();
  await assert.rejects(
    client.connect({ url: DEFAULT_CLIPROXY_URL, key: 'secret' }),
    (error) => error.code === 'CLIPROXY_RESPONSE_TOO_LARGE',
  );
  await assert.rejects(fs.readFile(path.join(rootDir, 'cliproxy.json')));
});

test('refresh uses the saved config and caches a successful quota for a minute', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  let hits = 0;
  const client = createCliproxyClient({
    rootDir,
    now: () => 1_700_000_000_000,
    env: {},
    fetchImpl: async (url) => {
      hits += 1;
      if (String(url).endsWith('/auth-files')) {
        return jsonResponse(200, {
          files: [{ name: 'claude.json', type: 'claude', auth_index: 'c1' }],
        });
      }
      return jsonResponse(200, {
        status_code: 200,
        body: { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.2 } },
      });
    },
  });
  await client.init();
  await client.connect({ url: DEFAULT_CLIPROXY_URL, key: 'k' });
  const firstHits = hits;
  await client.refresh(false);
  assert.equal(hits, firstHits);
  await client.refresh(true);
  assert.ok(hits > firstHits);
});

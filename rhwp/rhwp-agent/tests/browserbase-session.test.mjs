import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserbaseSession } from '../browserbase-session.mjs';

test('Browserbase serializes actions that share a remote session', async () => {
  const browser = new BrowserbaseSession({ env: {} });
  let active = 0;
  let maxActive = 0;
  browser.client = {
    async callTool() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  browser.chatId = 'chat-a';
  await Promise.all([
    browser.call('chat-a', 'navigate', { url: 'https://example.test/a' }),
    browser.call('chat-a', 'act', { action: 'continue' }),
  ]);
  assert.equal(maxActive, 1);
});

test('Browserbase timeout poisons the sidecar and warns against blind retries', async () => {
  const browser = new BrowserbaseSession({ env: {}, callTimeoutMs: 5 });
  let transportClosed = false;
  browser.client = {
    callTool: async () => new Promise(() => {}),
    async close() {},
  };
  browser.transport = { async close() { transportClosed = true; } };
  browser.chatId = 'chat-a';
  await assert.rejects(
    browser.call('chat-a', 'act', { action: 'submit' }),
    (error) => error.code === 'BROWSERBASE_TIMEOUT' && /may already have applied/.test(error.message),
  );
  assert.equal(transportClosed, true);
  assert.deepEqual(browser.status(), { configured: false, connected: false });
});

test('Browserbase fails before sidecar startup with actionable missing credentials', async () => {
  const browser = new BrowserbaseSession({ env: {} });
  assert.deepEqual(browser.status(), { configured: false, connected: false });
  await assert.rejects(
    browser.ensureConnected(),
    (error) => error.code === 'BROWSERBASE_NOT_CONFIGURED'
      && /BROWSERBASE_API_KEY/.test(error.message)
      && /BROWSERBASE_PROJECT_ID/.test(error.message)
      && /GEMINI_API_KEY/.test(error.message),
  );
});

// ── 자격 증명 해석 · 검증 · 브라우저 묶음 ─────────────────────────────
import {
  BrowserbaseFleet,
  MAIN_BROWSER_ID,
  credentialFingerprint,
  normalizeBrowserbaseOverride,
  resolveBrowserbaseCredentials,
  validateBrowserbaseCredentials,
} from '../browserbase-session.mjs';

const FULL_ENV = { BROWSERBASE_API_KEY: 'bb_env_1234', BROWSERBASE_PROJECT_ID: 'proj-env', GEMINI_API_KEY: 'gem-env' };

/** 사이드카 대신 쓰는 가짜 세션 — 호출만 기록한다. */
function fakeSession(calls, options) {
  return {
    label: options.label,
    client: null,
    getCredentials: options.credentials,
    async call(chatId, name, args) {
      this.client = name === 'end' ? null : {};
      calls.push({ browser: options.label, chatId, name, args, key: options.credentials().apiKey.value });
      return { mcpContent: [{ type: 'text', text: 'ok' }] };
    },
    async cleanup(reason) {
      this.client = null;
      calls.push({ browser: options.label, name: 'cleanup', reason });
    },
  };
}

test('studio override wins per field and falls back to the environment elsewhere', () => {
  const resolved = resolveBrowserbaseCredentials({ env: FULL_ENV, override: { apiKey: ' bb_studio_9999 ', projectId: '' } });
  assert.deepEqual(resolved.apiKey, { value: 'bb_studio_9999', source: 'studio' });
  assert.deepEqual(resolved.projectId, { value: 'proj-env', source: 'env' });
  assert.deepEqual(resolved.geminiApiKey, { value: 'gem-env', source: 'env' });
  assert.equal(normalizeBrowserbaseOverride({ apiKey: '  ', projectId: '' }), null);
  assert.deepEqual(normalizeBrowserbaseOverride({ apiKey: 'k', geminiApiKey: 'g', extra: 'x' }), { apiKey: 'k', geminiApiKey: 'g' });
  assert.throws(() => normalizeBrowserbaseOverride({ apiKey: 'bad\nkey' }), (error) => error.code === 'BROWSERBASE_INVALID_CREDENTIALS');
});

test('fleet status exposes sources and key tail but never the key itself', async () => {
  const fleet = new BrowserbaseFleet({ env: FULL_ENV, createSession: (options) => fakeSession([], options) });
  let status = fleet.status();
  assert.equal(status.configured, true);
  assert.equal(status.keySource, 'env');
  assert.equal(status.keyTail, '1234');
  assert.equal(status.projectId, 'proj-env');
  status = await fleet.setOverride({ apiKey: 'bb_studio_9999', projectId: 'proj-studio' });
  assert.equal(status.keySource, 'studio');
  assert.equal(status.keyTail, '9999');
  assert.equal(status.projectSource, 'studio');
  assert.equal(status.geminiSource, 'env');
  assert.doesNotMatch(JSON.stringify(status), /bb_studio_9999|bb_env_1234/);
  status = await fleet.setOverride(null);
  assert.equal(status.keySource, 'env');
  const bare = new BrowserbaseFleet({ env: {} }).status();
  assert.equal(bare.configured, false);
  assert.deepEqual(bare.missing, ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'GEMINI_API_KEY']);
});

test('validateBrowserbaseCredentials checks the key against the API and picks a project', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, key: init.headers['X-BB-API-Key'] });
    if (init.headers['X-BB-API-Key'] !== 'good') return { ok: false, status: 401, async json() { return {}; } };
    return { ok: true, status: 200, async json() { return [{ id: 'proj-a', name: 'A' }, { id: 'proj-b', name: 'B' }]; } };
  };
  const picked = await validateBrowserbaseCredentials({ apiKey: 'good' }, { fetchImpl });
  assert.equal(picked.projectId, 'proj-a');
  assert.equal(picked.projects.length, 2);
  assert.equal(seen[0].url, 'https://api.browserbase.com/v1/projects');
  const explicit = await validateBrowserbaseCredentials({ apiKey: 'good', projectId: 'proj-b' }, { fetchImpl });
  assert.equal(explicit.projectName, 'B');
  await assert.rejects(
    validateBrowserbaseCredentials({ apiKey: 'good', projectId: 'proj-zzz' }, { fetchImpl }),
    (error) => error.code === 'BROWSERBASE_PROJECT_NOT_FOUND',
  );
  await assert.rejects(
    validateBrowserbaseCredentials({ apiKey: 'bad' }, { fetchImpl }),
    (error) => error.code === 'BROWSERBASE_KEY_INVALID',
  );
  await assert.rejects(
    validateBrowserbaseCredentials({ apiKey: 'good' }, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }),
    (error) => error.code === 'BROWSERBASE_UNREACHABLE' && /ECONNREFUSED/.test(error.message),
  );
});

test('fleet isolates browsers by browserId, caps them, and drops subagent browsers on end or turn end', async () => {
  const calls = [];
  const fleet = new BrowserbaseFleet({ env: FULL_ENV, maxBrowsers: 3, createSession: (options) => fakeSession(calls, options) });
  await fleet.call('chat-a', undefined, 'start', {});
  await fleet.call('chat-a', 'researcher-1', 'navigate', { url: 'https://example.test' });
  await fleet.call('chat-a', 'researcher-2', 'start', {});
  assert.deepEqual(calls.map((c) => c.browser), [MAIN_BROWSER_ID, 'researcher-1', 'researcher-2']);
  assert.deepEqual(fleet.status().browsers.map((b) => b.id), ['main', 'researcher-1', 'researcher-2']);
  await assert.rejects(fleet.call('chat-a', 'researcher-3', 'start', {}), (error) => error.code === 'BROWSERBASE_BROWSER_LIMIT');
  await assert.rejects(fleet.call('chat-a', 'bad id!', 'start', {}), (error) => error.code === 'BROWSERBASE_INVALID_BROWSER_ID');
  await fleet.call('chat-a', 'researcher-2', 'end', {});
  assert.deepEqual(fleet.status().browsers.map((b) => b.id), ['main', 'researcher-1']);
  await fleet.call('chat-a', undefined, 'end', {});
  assert.ok(fleet.status().browsers.some((b) => b.id === 'main'), 'main browser slot survives end');
  await fleet.cleanupExtras('turn ended');
  assert.deepEqual(fleet.status().browsers.map((b) => b.id), ['main']);
  assert.ok(calls.some((c) => c.browser === 'researcher-1' && c.name === 'cleanup' && c.reason === 'turn ended'));
  // 채팅이 바뀌면 묶음 전체가 닫힌다.
  await fleet.call('chat-b', undefined, 'start', {});
  assert.ok(calls.some((c) => c.browser === 'main' && c.name === 'cleanup' && c.reason === 'chat changed'));
});

test('fleet override restarts live browsers and every browser launches with the new key', async () => {
  const calls = [];
  const fleet = new BrowserbaseFleet({ env: FULL_ENV, createSession: (options) => fakeSession(calls, options) });
  await fleet.call('chat-a', undefined, 'start', {});
  assert.equal(calls.at(-1).key, 'bb_env_1234');
  await fleet.setOverride({ apiKey: 'bb_studio_9999' });
  assert.ok(calls.some((c) => c.name === 'cleanup' && c.reason === 'credentials changed'));
  await fleet.call('chat-a', 'helper', 'start', {});
  assert.equal(calls.at(-1).key, 'bb_studio_9999');
  // 턴 중에는(restart=false) 떠 있는 브라우저를 끊지 않는다.
  const before = calls.length;
  await fleet.setOverride(null, { restart: false });
  assert.equal(calls.length, before);
  assert.equal(fleet.status().keySource, 'env');
});

test('session relaunches after the sidecar exits and after credentials change', async () => {
  let key = 'one';
  const browser = new BrowserbaseSession({
    env: {},
    credentials: () => resolveBrowserbaseCredentials({ env: { BROWSERBASE_API_KEY: key, BROWSERBASE_PROJECT_ID: 'p', GEMINI_API_KEY: 'g' } }),
  });
  const client = { async callTool() { return { content: [] }; }, async close() {} };
  browser.client = client;
  browser.transport = { async close() {} };
  browser.liveFingerprint = 'studio:stale';
  let relaunched = 0;
  browser.ensureConnected = async () => {
    if (browser.client) return browser.client;
    relaunched += 1;
    browser.client = client;
    browser.liveFingerprint = credentialFingerprint(browser.getCredentials());
    return client;
  };
  browser.chatId = 'chat-a';
  await browser.call('chat-a', 'act', { action: 'x' });
  assert.equal(relaunched, 1, 'stale fingerprint forces a relaunch before the call');
  await browser.call('chat-a', 'act', { action: 'y' });
  assert.equal(relaunched, 1, 'matching fingerprint reuses the sidecar');
  browser.onSidecarClosed(client, 'crashed');
  assert.equal(browser.client, null);
  await browser.call('chat-a', 'act', { action: 'z' });
  assert.equal(relaunched, 2, 'a dead sidecar relaunches on the next call');
  key = 'two';
  await browser.call('chat-a', 'act', { action: 'w' });
  assert.equal(relaunched, 3, 'changed credentials relaunch before the call');
  browser.clearIdleTimer();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BrowserbaseSession,
  BrowserbaseFleet,
  MAIN_BROWSER_ID,
  credentialFingerprint,
  normalizeBrowserbaseOverride,
  resolveBrowserbaseCredentials,
  validateBrowserbaseCredentials,
} from '../browserbase-session.mjs';

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
  let endRequested = false;
  browser.client = {
    callTool: async ({ name }) => {
      if (name === 'end') {
        endRequested = true;
        return { content: [{ type: 'text', text: '{"success":true}' }] };
      }
      return new Promise(() => {});
    },
    async close() {},
  };
  browser.transport = { async close() { transportClosed = true; } };
  browser.chatId = 'chat-a';
  await assert.rejects(
    browser.call('chat-a', 'act', { action: 'submit' }),
    (error) => error.code === 'BROWSERBASE_TIMEOUT' && /may already have applied/.test(error.message),
  );
  assert.equal(transportClosed, true);
  assert.equal(endRequested, true);
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

function apiResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

test('validateBrowserbaseCredentials discovers a project when only the key is supplied', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, key: init.headers['X-BB-API-Key'] });
    if (init.headers['X-BB-API-Key'] !== 'good') return apiResponse(401, { message: 'Unauthorized' });
    return apiResponse(200, [{ id: 'proj-a', name: 'A' }, { id: 'proj-b', name: 'B' }]);
  };
  const picked = await validateBrowserbaseCredentials({ apiKey: 'good' }, { fetchImpl });
  assert.equal(picked.projectId, 'proj-a');
  assert.equal(picked.projects.length, 2);
  assert.equal(seen[0].url, 'https://api.browserbase.com/v1/projects');
  await assert.rejects(
    validateBrowserbaseCredentials({ apiKey: 'bad' }, { fetchImpl }),
    (error) => error.code === 'BROWSERBASE_KEY_INVALID',
  );
});

test('validateBrowserbaseCredentials checks an explicit project directly', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.endsWith('/proj-b')) return apiResponse(200, { id: 'proj-b', name: 'B' });
    return apiResponse(404, { message: 'Not Found' });
  };
  const explicit = await validateBrowserbaseCredentials({ apiKey: 'good', projectId: 'proj-b' }, { fetchImpl });
  assert.equal(explicit.projectName, 'B');
  assert.equal(seen[0], 'https://api.browserbase.com/v1/projects/proj-b');
  await assert.rejects(
    validateBrowserbaseCredentials({ apiKey: 'good', projectId: 'proj-zzz' }, { fetchImpl }),
    (error) => error.code === 'BROWSERBASE_PROJECT_NOT_FOUND',
  );
});

test('validateBrowserbaseCredentials handles discovery variants and actionable API failures', async () => {
  const wrapped = await validateBrowserbaseCredentials(
    { apiKey: 'good' },
    { fetchImpl: async () => apiResponse(200, { data: [{ id: 'proj-a', name: 'A' }] }) },
  );
  assert.equal(wrapped.projectId, 'proj-a');
  await assert.rejects(
    validateBrowserbaseCredentials({ apiKey: 'good' }, { fetchImpl: async () => apiResponse(404, 'Not Found') }),
    (error) => error.code === 'BROWSERBASE_PROJECT_REQUIRED' && /Project ID/.test(error.message),
  );
  await assert.rejects(
    validateBrowserbaseCredentials({ apiKey: 'good' }, { fetchImpl: async () => apiResponse(200, { unexpected: true }) }),
    (error) => error.code === 'BROWSERBASE_API_ERROR' && /malformed project list/.test(error.message),
  );
  await assert.rejects(
    validateBrowserbaseCredentials(
      { apiKey: 'super-secret' },
      { fetchImpl: async () => apiResponse(429, { message: 'limit for super-secret reached' }) },
    ),
    (error) => error.code === 'BROWSERBASE_API_ERROR'
      && /429/.test(error.message)
      && /\[redacted\]/.test(error.message)
      && !/super-secret/.test(error.message),
  );
  await assert.rejects(
    validateBrowserbaseCredentials({ apiKey: 'good' }, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }),
    (error) => error.code === 'BROWSERBASE_UNREACHABLE' && /ECONNREFUSED/.test(error.message),
  );
  await assert.rejects(
    validateBrowserbaseCredentials(
      { apiKey: 'good' },
      {
        timeoutMs: 5,
        fetchImpl: async (_url, init) => ({
          ok: true,
          status: 200,
          text: () => new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          }),
        }),
      },
    ),
    (error) => error.code === 'BROWSERBASE_UNREACHABLE' && /timed out after 5ms/.test(error.message),
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

test('failed subagent end stays tracked so cleanupExtras can still close it', async () => {
  const calls = [];
  const fleet = new BrowserbaseFleet({
    env: FULL_ENV,
    createSession: (options) => {
      const session = fakeSession(calls, options);
      const original = session.call.bind(session);
      session.call = async (chatId, name, args) => {
        if (name === 'end') throw Object.assign(new Error('end failed'), { code: 'BROWSERBASE_TOOL_FAILED' });
        return original(chatId, name, args);
      };
      return session;
    },
  });
  await fleet.call('chat-a', undefined, 'start', {});
  await fleet.call('chat-a', 'researcher-1', 'navigate', { url: 'https://example.test' });
  await assert.rejects(
    fleet.call('chat-a', 'researcher-1', 'end', {}),
    (error) => error.code === 'BROWSERBASE_TOOL_FAILED',
  );
  assert.deepEqual(fleet.status().browsers.map((b) => b.id), ['main', 'researcher-1']);
  await fleet.cleanupExtras('turn ended');
  assert.deepEqual(fleet.status().browsers.map((b) => b.id), ['main']);
  assert.ok(calls.some((c) => c.browser === 'researcher-1' && c.name === 'cleanup' && c.reason === 'turn ended'));
});

test('failed first subagent call does not consume a fleet slot', async () => {
  const calls = [];
  const failIds = new Set(['researcher-1', 'researcher-2', 'researcher-3']);
  const fleet = new BrowserbaseFleet({
    env: FULL_ENV,
    maxBrowsers: 4,
    createSession: (options) => {
      const session = fakeSession(calls, options);
      const original = session.call.bind(session);
      session.call = async (chatId, name, args) => {
        if (failIds.has(options.label)) {
          throw Object.assign(new Error('start failed'), { code: 'BROWSERBASE_START_FAILED' });
        }
        return original(chatId, name, args);
      };
      return session;
    },
  });
  await fleet.call('chat-a', undefined, 'start', {});
  await assert.rejects(
    fleet.call('chat-a', 'researcher-1', 'start', {}),
    (error) => error.code === 'BROWSERBASE_START_FAILED',
  );
  await assert.rejects(
    fleet.call('chat-a', 'researcher-2', 'start', {}),
    (error) => error.code === 'BROWSERBASE_START_FAILED',
  );
  await assert.rejects(
    fleet.call('chat-a', 'researcher-3', 'start', {}),
    (error) => error.code === 'BROWSERBASE_START_FAILED',
  );
  assert.deepEqual(fleet.status().browsers.map((b) => b.id), ['main']);
  await fleet.call('chat-a', 'researcher-4', 'start', {});
  assert.deepEqual(fleet.status().browsers.map((b) => b.id), ['main', 'researcher-4']);
});

test('stale credential set is dropped after a later clear', async () => {
  const fleet = new BrowserbaseFleet({ env: FULL_ENV, createSession: (options) => fakeSession([], options) });
  const stale = fleet.beginCredentialChange();
  fleet.beginCredentialChange();
  await fleet.setOverride(null);
  const status = await fleet.applyVerifiedOverride({ apiKey: 'bb_stale_0001' }, {}, stale);
  assert.equal(status.keySource, 'env');
  assert.equal(status.keyTail, '1234');
  assert.doesNotMatch(JSON.stringify(status), /bb_stale_0001/);
});

test('later credential set wins when an older validation finishes last', async () => {
  const fleet = new BrowserbaseFleet({ env: FULL_ENV, createSession: (options) => fakeSession([], options) });
  const first = fleet.beginCredentialChange();
  const second = fleet.beginCredentialChange();
  await fleet.applyVerifiedOverride({ apiKey: 'bb_old_1111' }, {}, first);
  assert.equal(fleet.status().keySource, 'env');
  const status = await fleet.applyVerifiedOverride({ apiKey: 'bb_new_2222' }, {}, second);
  assert.equal(status.keySource, 'studio');
  assert.equal(status.keyTail, '2222');
});

test('hub set and clear bump the fleet credential revision', () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /const revision = record\.browserbase\.beginCredentialChange\(\);/);
  assert.match(server, /return record\.browserbase\.applyVerifiedOverride\(/);
  assert.match(
    server,
    /case 'browserbase-credentials-clear': \{[\s\S]*?record\.browserbase\.beginCredentialChange\(\);[\s\S]*?setOverride\(null/,
  );
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

test('Browserbase launches the in-repo sidecar with a 512 MiB heap and Electron Node mode', async () => {
  let launch;
  let clientClosed = false;
  const transport = {
    stderr: null,
    async close() {},
  };
  const client = {
    async connect() {},
    async listTools() {
      return { tools: ['start', 'end', 'navigate', 'act', 'observe', 'extract'].map((name) => ({ name })) };
    },
    async callTool() {
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
    },
    async close() { clientClosed = true; },
  };
  const browser = new BrowserbaseSession({
    env: {
      BROWSERBASE_API_KEY: 'browser-key',
      BROWSERBASE_PROJECT_ID: 'project-id',
      GEMINI_API_KEY: 'model-key',
      ELECTRON_RUN_AS_NODE: '1',
    },
    execPath: '/Applications/Rauhwpx.app/Contents/MacOS/Rauhwpx',
    sidecarPath: '/app/browserbase-sidecar.mjs',
    transportFactory(options) {
      launch = options;
      return transport;
    },
    clientFactory: () => client,
  });

  await browser.ensureConnected();
  assert.equal(launch.command, '/Applications/Rauhwpx.app/Contents/MacOS/Rauhwpx');
  assert.deepEqual(launch.args, ['--max-old-space-size=512', '/app/browserbase-sidecar.mjs']);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(launch.env.BROWSERBASE_API_KEY, 'browser-key');
  await browser.cleanup('test');
  assert.equal(clientClosed, true);
});

test('Browserbase drops a failed sidecar and caps valid UTF-8 text output at 50 KiB', async () => {
  let closes = 0;
  const browser = new BrowserbaseSession({ env: {} });
  browser.client = {
    async callTool() {
      return { content: [{ type: 'text', text: '한'.repeat(30_000) }] };
    },
    async close() { closes += 1; },
  };
  browser.transport = { async close() { closes += 1; } };
  browser.chatId = 'chat-a';
  const result = await browser.call('chat-a', 'extract');
  const text = result.mcpContent.map((block) => block.text ?? '').join('');
  assert.ok(Buffer.byteLength(text, 'utf8') <= 50 * 1024);
  assert.doesNotMatch(text, /�/);
  assert.match(text, /truncated at 51200 bytes/);

  browser.client = {
    async callTool() {
      return { isError: true, content: [{ type: 'text', text: 'remote action failed' }] };
    },
    async close() { closes += 1; },
  };
  browser.transport = { async close() { closes += 1; } };
  browser.chatId = 'chat-a';
  await assert.rejects(
    browser.call('chat-a', 'act', { action: 'click' }),
    (error) => error.code === 'BROWSERBASE_CLEANUP_UNCERTAIN'
      && error.cause?.code === 'BROWSERBASE_TOOL_FAILED'
      && /remote action failed/.test(error.cause?.message),
  );
  assert.equal(browser.status().connected, false);
  assert.equal(browser.uncertainResources.length, 1);
  assert.equal(closes, 2);
});

test('Browserbase cleanup stays false after any unconfirmed remote or local close', async () => {
  const logs = [];
  const browser = new BrowserbaseSession({ env: {}, log: (message) => logs.push(message) });
  browser.client = {
    async callTool({ name }) {
      assert.equal(name, 'end');
      return { isError: true, content: [{ type: 'text', text: 'remote end rejected' }] };
    },
    async close() { throw new Error('client close failed'); },
  };
  browser.transport = {
    async close() { throw new Error('transport close failed'); },
  };
  browser.chatId = 'chat-a';

  assert.equal(await browser.cleanup('session disposed'), false);
  assert.equal(browser.status().connected, false);
  assert.equal(
    await browser.cleanup('hub shutdown'),
    false,
    'a later no-op cleanup must not erase the earlier uncertainty signal',
  );
  assert.ok(logs.some((message) => message.includes('sidecar closed')));
  await assert.rejects(
    browser.ensureConnected(),
    { code: 'BROWSERBASE_CLEANUP_UNCERTAIN', processCleanupUncertain: true },
  );
});

test('Browserbase chat replacement cannot start after its prior cleanup is unconfirmed', async () => {
  let calls = 0;
  const browser = new BrowserbaseSession({ env: {} });
  browser.client = {
    async callTool({ name }) {
      calls += 1;
      if (name === 'end') return { isError: true };
      return { content: [{ type: 'text', text: '{"success":true}' }] };
    },
    async close() {},
  };
  browser.transport = { async close() {} };
  browser.chatId = 'chat-a';

  await assert.rejects(
    browser.call('chat-b', 'navigate', { url: 'https://example.com' }),
    { code: 'BROWSERBASE_CLEANUP_UNCERTAIN', processCleanupUncertain: true },
  );
  assert.equal(calls, 1, 'only end is attempted; the next remote action never starts');
  assert.equal(browser.status().connected, false);
  assert.equal(browser.uncertainResources.length, 1);
});

test('Browserbase surfaces cleanup uncertainty when tool-failure abort cannot close locally', async () => {
  const browser = new BrowserbaseSession({ env: {} });
  browser.client = {
    async callTool({ name }) {
      if (name === 'end') return { content: [{ type: 'text', text: '{"success":true}' }] };
      return { isError: true, content: [{ type: 'text', text: 'action rejected' }] };
    },
    async close() { throw new Error('client survived'); },
  };
  browser.transport = { async close() {} };
  browser.chatId = 'chat-a';

  await assert.rejects(
    browser.call('chat-a', 'act', { action: 'click' }),
    { code: 'BROWSERBASE_CLEANUP_UNCERTAIN', processCleanupUncertain: true },
  );
  await assert.rejects(browser.ensureConnected(), { code: 'BROWSERBASE_CLEANUP_UNCERTAIN' });
  assert.equal(browser.uncertainResources.length, 1);
});

test('a sidecar late-session cleanup error poisons the proxy even when local shutdown succeeds', async () => {
  const browser = new BrowserbaseSession({ env: {} });
  let closes = 0;
  browser.client = {
    async callTool({ name }) {
      if (name === 'end') return { content: [{ type: 'text', text: '{"success":true}' }] };
      return {
        isError: true,
        content: [{
          type: 'text',
          text: 'Error [BROWSERBASE_CLEANUP_UNCERTAIN]: late Browserbase cleanup timed out',
        }],
      };
    },
    async close() { closes += 1; },
  };
  browser.transport = { async close() { closes += 1; } };
  browser.chatId = 'chat-a';

  await assert.rejects(
    browser.call('chat-a', 'start'),
    (error) => error.code === 'BROWSERBASE_CLEANUP_UNCERTAIN'
      && error.cause?.code === 'BROWSERBASE_TOOL_FAILED',
  );
  assert.equal(closes, 2, 'the uncertain sidecar is still shut down locally');
  assert.equal(await browser.cleanup('owner disposed'), false);
  await assert.rejects(browser.ensureConnected(), { code: 'BROWSERBASE_CLEANUP_UNCERTAIN' });
});

test('Browserbase startup cleanup failure remains visible to session disposal', async () => {
  const browser = new BrowserbaseSession({
    env: {
      BROWSERBASE_API_KEY: 'browser-key',
      BROWSERBASE_PROJECT_ID: 'project-id',
      GEMINI_API_KEY: 'model-key',
    },
    transportFactory: () => ({
      stderr: null,
      async close() { throw new Error('startup transport close failed'); },
    }),
    clientFactory: () => ({
      async connect() { throw new Error('startup failed'); },
      async close() {},
    }),
  });

  await assert.rejects(
    browser.ensureConnected(),
    (error) => error.code === 'BROWSERBASE_CLEANUP_UNCERTAIN'
      && /startup failed/.test(error.cause?.message),
  );
  assert.equal(await browser.cleanup('session disposed'), false);
  await assert.rejects(browser.ensureConnected(), { code: 'BROWSERBASE_CLEANUP_UNCERTAIN' });
  assert.equal(browser.uncertainResources.length, 1);
});

test('the real in-repo sidecar advertises the six compatibility tools without opening a browser', async () => {
  const browser = new BrowserbaseSession({
    env: {
      BROWSERBASE_API_KEY: 'unused-browser-key',
      BROWSERBASE_PROJECT_ID: 'unused-project-id',
      GEMINI_API_KEY: 'unused-model-key',
    },
    startupTimeoutMs: 10_000,
  });
  const client = await browser.ensureConnected();
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ['act', 'end', 'extract', 'navigate', 'observe', 'start'],
  );
  await browser.cleanup('test');
});

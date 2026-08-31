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

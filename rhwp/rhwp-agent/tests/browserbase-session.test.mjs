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

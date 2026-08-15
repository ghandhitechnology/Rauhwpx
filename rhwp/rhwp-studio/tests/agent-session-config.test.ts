import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  resolveRendererSessionContext,
  websocketHubUrl,
} from '../src/desktop-integration.ts';

const bridgeSource = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');

test('Electron renderer session context is loaded asynchronously from preload', async () => {
  const expected = {
    launchId: 'launch-desktop',
    sessionId: 'window-2',
    hubUrl: 'http://127.0.0.1:6123',
    hubToken: 'desktop-secret',
  };
  let calls = 0;
  const context = await resolveRendererSessionContext({
    rhwpDesktop: {
      ensureAgentHub: async () => true,
      async getSessionContext() {
        calls += 1;
        return expected;
      },
    },
  }, {
    hubUrl: 'ws://127.0.0.1:5175',
    hubToken: 'dev',
  });

  assert.deepEqual(context, expected);
  assert.equal(calls, 1);
});

test('Electron never falls back to the packaged dev hub when preload context is missing', async () => {
  assert.equal(await resolveRendererSessionContext({
    rhwpDesktop: { ensureAgentHub: async () => true },
  }), null);
});

test('browser/dev context keeps explicit overrides and HTTP hub URLs become WebSockets', async () => {
  const context = await resolveRendererSessionContext({}, {
    launchId: 'browser-launch',
    sessionId: 'browser-window',
    hubUrl: 'https://hub.example.test/base/',
    hubToken: 'browser-token',
  });
  assert.deepEqual(context, {
    launchId: 'browser-launch',
    sessionId: 'browser-window',
    hubUrl: 'https://hub.example.test/base/',
    hubToken: 'browser-token',
  });
  assert.equal(websocketHubUrl(context!.hubUrl), 'wss://hub.example.test/base');
});

test('AgentBridge carries the renderer session on WebSocket and HTTP hub requests', () => {
  assert.match(bridgeSource, /\/studio\?token=.*&sessionId=/);
  assert.match(bridgeSource, /url\.searchParams\.set\('sessionId', this\.sessionId\)/);
  assert.match(bridgeSource, /await this\.refreshSessionContext\(\)/);
  assert.doesNotMatch(bridgeSource, /opts\?\.url \?\?.*5175/);
});

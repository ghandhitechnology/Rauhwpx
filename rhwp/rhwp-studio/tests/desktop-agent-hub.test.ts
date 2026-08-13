import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ensureAgentHub,
  hubHealthUrl,
  isHubHealthy,
  nextHubRestartDelay,
  resolveHubLaunch,
  waitForHub,
} from '../../../desktop/agent-hub.mjs';

const desktopMain = readFileSync(new URL('../../../desktop/main.mjs', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../../../desktop/preload.cjs', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const viteHubPlugin = readFileSync(new URL('../vite-plugin-agent-hub.mjs', import.meta.url), 'utf8');
const rootPackage = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

test('healthz URL is loopback-only', () => {
  assert.equal(hubHealthUrl(5175), 'http://127.0.0.1:5175/healthz');
});

test('isHubHealthy requires ok:true JSON', async () => {
  assert.equal(await isHubHealthy(5175, {
    fetchImpl: async () => jsonResponse({ ok: true }),
  }), true);
  assert.equal(await isHubHealthy(5175, {
    fetchImpl: async () => jsonResponse({ ok: false }),
  }), false);
  assert.equal(await isHubHealthy(5175, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  }), false);
});

test('ensureAgentHub skips spawn when the hub is already healthy', async () => {
  let started = 0;
  const result = await ensureAgentHub({
    port: 5175,
    start: () => {
      started += 1;
      return true;
    },
    isHealthy: async () => true,
    log: { log() {}, warn() {} },
  });
  assert.deepEqual(result, { started: false, ready: true });
  assert.equal(started, 0);
});

test('ensureAgentHub starts the hub when healthz is down and waits until ready', async () => {
  let started = 0;
  let healthy = false;
  const result = await ensureAgentHub({
    port: 5175,
    start: () => {
      started += 1;
      healthy = true;
      return true;
    },
    isHealthy: async () => healthy,
    wait: async () => healthy,
    log: { log() {}, warn() {} },
  });
  assert.deepEqual(result, { started: true, ready: true });
  assert.equal(started, 1);
});

test('ensureAgentHub does not fork a second listener when a process is already alive', async () => {
  let started = 0;
  const result = await ensureAgentHub({
    port: 5175,
    processAlive: true,
    start: () => {
      started += 1;
      return true;
    },
    isHealthy: async () => false,
    wait: async () => true,
    log: { log() {}, warn() {} },
  });
  assert.deepEqual(result, { started: false, ready: true });
  assert.equal(started, 0);
});

test('ensureAgentHub stops if start() cannot launch', async () => {
  const result = await ensureAgentHub({
    port: 5175,
    start: () => false,
    isHealthy: async () => false,
    wait: async () => {
      throw new Error('should not wait');
    },
    log: { log() {}, warn() {} },
  });
  assert.deepEqual(result, { started: false, ready: false });
});

test('waitForHub polls until healthy or timeout', async () => {
  let checks = 0;
  const ready = await waitForHub(5175, {
    timeoutMs: 50,
    intervalMs: 5,
    isHealthy: async () => {
      checks += 1;
      return checks >= 3;
    },
    sleep: async () => {},
    now: (() => {
      let t = 0;
      return () => {
        t += 10;
        return t;
      };
    })(),
  });
  assert.equal(ready, true);
  assert.ok(checks >= 3);
});

test('hub restart delay caps at the last step', () => {
  assert.equal(nextHubRestartDelay(0), 500);
  assert.equal(nextHubRestartDelay(1), 1000);
  assert.equal(nextHubRestartDelay(9), 5000);
});

test('unpackaged launch uses node server.mjs (same as npm start)', () => {
  const files = new Set([
    '/repo/rhwp/rhwp-agent/server.mjs',
    '/opt/homebrew/bin',
    '/opt/homebrew/bin/npm',
    '/opt/homebrew/bin/node',
  ]);
  const launch = resolveHubLaunch({
    packaged: false,
    execPath: '/app/Electron',
    scriptPath: '/repo/rhwp/rhwp-agent/server.mjs',
    agentDir: '/repo/rhwp/rhwp-agent',
    home: '/Users/dev',
    env: { PATH: '/usr/bin', RHWP_AGENT_PORT: '5175', ELECTRON_RUN_AS_NODE: '1', npm_lifecycle_event: 'desktop' },
    exists: (path) => files.has(path),
    platform: 'darwin',
  });
  assert.equal(launch?.via, 'node');
  assert.equal(launch?.command, '/opt/homebrew/bin/node');
  assert.deepEqual(launch?.args, ['/repo/rhwp/rhwp-agent/server.mjs']);
  assert.equal(launch?.cwd, '/repo/rhwp/rhwp-agent');
  assert.equal(launch?.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(launch?.env.npm_lifecycle_event, undefined);
  assert.match(launch?.env.PATH ?? '', /\/opt\/homebrew\/bin/);
});

test('packaged launch prefers system node over npm', () => {
  const files = new Set([
    '/app/rhwp-agent/server.mjs',
    '/opt/homebrew/bin',
    '/opt/homebrew/bin/npm',
    '/opt/homebrew/bin/node',
  ]);
  const launch = resolveHubLaunch({
    packaged: true,
    execPath: '/app/Rauhwpx',
    scriptPath: '/app/rhwp-agent/server.mjs',
    agentDir: '/app/rhwp-agent',
    home: '/Users/dev',
    env: { PATH: '/usr/bin' },
    exists: (path) => files.has(path),
    platform: 'darwin',
  });
  assert.equal(launch?.via, 'node');
  assert.equal(launch?.command, '/opt/homebrew/bin/node');
  assert.deepEqual(launch?.args, ['/app/rhwp-agent/server.mjs']);
});

test('launch falls back to Electron-as-Node when npm and node are missing', () => {
  const launch = resolveHubLaunch({
    packaged: true,
    execPath: '/app/Rauhwpx',
    scriptPath: '/app/rhwp-agent/server.mjs',
    agentDir: '/app/rhwp-agent',
    home: '/Users/dev',
    env: { PATH: '' },
    exists: (path) => path === '/app/rhwp-agent/server.mjs',
    platform: 'darwin',
  });
  assert.equal(launch?.via, 'electron-as-node');
  assert.equal(launch?.command, '/app/Rauhwpx');
  assert.equal(launch?.env.ELECTRON_RUN_AS_NODE, '1');
});

test('desktop shell ensures the hub before showing the window and exposes IPC', () => {
  assert.match(desktopMain, /await ensureAgent\(\);\s*await createWindow\(\);/s);
  assert.match(desktopMain, /ipcMain.handle\('agent-hub:ensure'/);
  assert.match(desktopMain, /preload: PRELOAD_PATH/);
  assert.match(desktopMain, /function scheduleAgentRestart\(\)/);
  assert.match(desktopMain, /resolveHubLaunch\(/);
  assert.match(desktopMain, /spawn\(launch\.command, launch\.args/);
  assert.match(desktopMain, /child\.on\('exit'/);
  assert.doesNotMatch(desktopMain, /utilityProcess/);
  assert.match(desktopMain, /sandbox: false/);
  assert.match(preload, /ensureAgentHub: \(\) => ipcRenderer\.invoke\('agent-hub:ensure'\)/);
});

test('studio dev server and repo npm start both boot the hub', () => {
  assert.match(viteConfig, /rhwpAgentHubPlugin\(__dirname\)/);
  assert.match(viteHubPlugin, /spawn\(process\.execPath, \[script\]/);
  assert.match(viteHubPlugin, /RHWP_SKIP_AGENT_HUB/);
  assert.match(rootPackage, /"start": "node rhwp\/rhwp-agent\/server.mjs"/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureAgentHub,
  hubHealthUrl,
  hubPidFromHealth,
  hubRunPaths,
  isHubHealthy,
  isProcessAlive,
  nextHubRestartDelay,
  readPidFile,
  removePidFile,
  resolveHubLaunch,
  stopHubChild,
  waitForHub,
  writePidFile,
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

test('ensureAgentHub restarts a hung process after it misses the first wait', async () => {
  let stopped = 0;
  let started = 0;
  let waits = 0;
  const result = await ensureAgentHub({
    port: 5175,
    processAlive: true,
    restartUnhealthy: true,
    stop: async () => {
      stopped += 1;
    },
    start: () => {
      started += 1;
      return true;
    },
    isHealthy: async () => false,
    wait: async () => {
      waits += 1;
      return waits >= 2;
    },
    log: { log() {}, warn() {} },
  });
  assert.deepEqual(result, { started: true, ready: true });
  assert.equal(stopped, 1);
  assert.equal(started, 1);
  assert.equal(waits, 2);
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
  assert.match(desktopMain, /spawnHubProcess\(/);
  assert.match(desktopMain, /onExit: \(code, signal\) => \{/);
  assert.doesNotMatch(desktopMain, /utilityProcess/);
  assert.match(desktopMain, /sandbox: false/);
  assert.match(desktopMain, /function stopAgent\(\)/);
  assert.match(desktopMain, /stopHubChild\(/);
  assert.match(desktopMain, /restartUnhealthy:\s*true/);
  assert.match(desktopMain, /if \(agentProcess !== child\) return;/);
  assert.match(preload, /ensureAgentHub: \(\) => ipcRenderer\.invoke\('agent-hub:ensure'\)/);
});

test('studio dev server and repo npm start both boot the hub', () => {
  assert.match(viteConfig, /rhwpAgentHubPlugin\(__dirname\)/);
  assert.match(viteHubPlugin, /spawnHubProcess\(\{/);
  assert.match(viteHubPlugin, /process\.execPath/);
  assert.match(viteHubPlugin, /RHWP_SKIP_AGENT_HUB/);
  assert.match(viteHubPlugin, /\/__rhwp\/ensure-agent-hub/);
  assert.match(viteHubPlugin, /restartUnhealthy:\s*true/);
  assert.match(viteHubPlugin, /stopHubChild\(/);
  assert.match(rootPackage, /"start": "node rhwp\/rhwp-agent\/ctl.mjs start"/);
  assert.match(rootPackage, /"start:fg": "node rhwp\/rhwp-agent\/server.mjs"/);
  assert.match(rootPackage, /"stop": "node rhwp\/rhwp-agent\/ctl.mjs stop"/);
});

test('healthz JSON exposes pid for process control', () => {
  assert.equal(hubPidFromHealth({ ok: true, pid: 1234 }), 1234);
  assert.equal(hubPidFromHealth({ ok: true, pid: 'nope' }), null);
  const server = readFileSync(new URL('../../rhwp-agent/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /function healthzBody\(\)/);
  assert.match(server, /pid: process\.pid/);
  assert.match(server, /name: HUB_NAME/);
});

test('pid files round-trip and ignore junk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-hub-'));
  const paths = hubRunPaths(dir);
  try {
    writePidFile(paths.pid, 4321);
    assert.equal(readPidFile(paths.pid), 4321);
    removePidFile(paths.pid);
    assert.equal(readPidFile(paths.pid), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isProcessAlive reports this process and rejects nonsense', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
});

test('stopHubChild SIGTERM then resolves on exit', async () => {
  const signals = [];
  const child = new EventEmitter();
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', 0, null));
  };
  await stopHubChild(child);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('stopHubChild is a no-op without a child', async () => {
  await stopHubChild(null);
});

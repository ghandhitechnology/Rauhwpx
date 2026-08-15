import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeHubSession,
  createHubToken,
  ensureAgentHub,
  HUB_READY_PREFIX,
  hubHealthUrl,
  hubPidFromHealth,
  hubRunPaths,
  isHubHealthy,
  isProcessAlive,
  issueHubSessionToken,
  nextHubRestartDelay,
  parseHubReadyLine,
  readPidFile,
  removePidFile,
  requestHubShutdown,
  resolveHubLaunch,
  stopHubChild,
  waitForHub,
  waitForHubChildExit,
  waitForHubReadyLine,
  writePidFile,
} from '../../../desktop/agent-hub.mjs';
import { issueScopedHubToken } from '../../rhwp-agent/hub-session-registry.mjs';

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

test('desktop renderer credentials exactly match the hub session scope', () => {
  assert.equal(
    issueHubSessionToken('master-secret', 'window-a'),
    issueScopedHubToken('master-secret', 'window-a'),
  );
});

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

test('desktop shell owns one ephemeral authenticated hub and exposes session IPC', () => {
  assert.match(desktopMain, /app\.requestSingleInstanceLock\(\)/);
  assert.match(desktopMain, /app\.on\('second-instance'/);
  assert.match(desktopMain, /await hubOwner\.ensure\(\);[\s\S]*await createWindow\(request\)/);
  assert.match(desktopMain, /ipcMain\.handle\('desktop:get-session-context'/);
  assert.match(desktopMain, /sessions\.sessionForSender\(event\.sender\)/);
  assert.match(desktopMain, /RHWP_AGENT_PORT: '0'/);
  assert.match(desktopMain, /RHWP_AGENT_TOKEN: hubToken/);
  assert.match(desktopMain, /RHWP_LAUNCH_ID: launchId/);
  assert.match(desktopMain, /RHWP_OWNER_PID: String\(process\.pid\)/);
  assert.match(desktopMain, /RHWP_RUNTIME_DIR: this\.runtimeDir/);
  assert.match(desktopMain, /RHWP_WORK_DIR: this\.workDir/);
  assert.match(desktopMain, /expectedPid: child\.pid/);
  assert.match(desktopMain, /expectedLaunchId: launchId/);
  assert.match(desktopMain, /waitForHubReadyLine\(child, \{ launchId \}\)/);
  assert.doesNotMatch(desktopMain, /DEFAULT_HUB_PORT/);
  assert.doesNotMatch(desktopMain, /startStudioServer/);
  assert.match(desktopMain, /sandbox: false/);
  assert.match(desktopMain, /stopHubChild\(/);
  assert.match(preload, /getSessionContext: \(\) => ipcRenderer\.invoke\('desktop:get-session-context'\)/);
  assert.match(preload, /ensureAgentHub: \(\) => ipcRenderer\.invoke\('agent-hub:ensure'\)/);
});

test('ready-line parser binds readiness to the Electron launch', async () => {
  const line = `${HUB_READY_PREFIX}${JSON.stringify({ launchId: 'launch-a', pid: 44, port: 32123 })}`;
  assert.deepEqual(parseHubReadyLine(line, 'launch-a'), { launchId: 'launch-a', pid: 44, port: 32123 });
  assert.equal(parseHubReadyLine(line, 'launch-b'), null);
  assert.equal(parseHubReadyLine(`${HUB_READY_PREFIX}{bad`, 'launch-a'), null);
  assert.ok(createHubToken().length >= 32);

  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
  child.stdout = new EventEmitter();
  const pending = waitForHubReadyLine(child, { launchId: 'launch-a' });
  child.stdout.emit('data', line.slice(0, 12));
  child.stdout.emit('data', `${line.slice(12)}\n`);
  assert.deepEqual(await pending, { launchId: 'launch-a', pid: 44, port: 32123 });
});

test('owned health checks send launch authentication and verify the child pid', async () => {
  let headers: Record<string, string> = {};
  const healthy = await isHubHealthy(32123, {
    token: 'hub-secret',
    launchId: 'launch-a',
    expectedPid: 44,
    expectedLaunchId: 'launch-a',
    fetchImpl: async (_url, init) => {
      headers = init?.headers as Record<string, string>;
      return jsonResponse({ ok: true, pid: 44, launchId: 'launch-a' });
    },
  });
  assert.equal(healthy, true);
  assert.equal(headers.authorization, 'Bearer hub-secret');
  assert.equal(headers['x-rhwp-launch-id'], 'launch-a');
  assert.equal(await isHubHealthy(32123, {
    expectedPid: 45,
    fetchImpl: async () => jsonResponse({ ok: true, pid: 44 }),
  }), false);
  assert.equal(await isHubHealthy(32123, {
    expectedLaunchId: 'launch-b',
    fetchImpl: async () => jsonResponse({ ok: true, pid: 44, launchId: 'launch-a' }),
  }), false);
});

test('studio dev server and repo npm start both boot the hub', () => {
  assert.match(viteConfig, /rhwpAgentHubPlugin\(__dirname\)/);
  assert.match(viteHubPlugin, /spawnHubProcess\(\{/);
  assert.match(viteHubPlugin, /process\.execPath/);
  assert.match(viteHubPlugin, /RHWP_SKIP_AGENT_HUB/);
  assert.match(viteHubPlugin, /\/__rhwp\/ensure-agent-hub/);
  assert.match(viteHubPlugin, /RHWP_AGENT_PORT: String\(requestedPort\)/);
  assert.match(viteHubPlugin, /RHWP_AGENT_TOKEN: token/);
  assert.match(viteHubPlugin, /RHWP_WORK_DIR:/);
  assert.match(viteHubPlugin, /waitForHubReadyLine\(spawned, \{ launchId \}\)/);
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

test('master lifecycle helpers bind method, launch, and session identity', async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, init });
    return jsonResponse({ status: 'ok' });
  };
  await closeHubSession({
    port: 32123, token: 'secret', launchId: 'launch-a', sessionId: 'window/a', fetchImpl,
  });
  await requestHubShutdown({ port: 32123, token: 'secret', launchId: 'launch-a', fetchImpl });

  assert.equal(calls[0].url, 'http://127.0.0.1:32123/sessions/window%2Fa');
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[1].url, 'http://127.0.0.1:32123/shutdown');
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, {
    authorization: 'Bearer secret',
    'x-rhwp-launch-id': 'launch-a',
  });
});

test('graceful hub shutdown wait observes the owned child exit', async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
  });
  const exited = waitForHubChildExit(child, { timeoutMs: 50 });
  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.equal(await exited, true);
});

test('stopHubChild terminates the owned POSIX group and clears escalation on exit', async () => {
  const signals: Array<[number, string]> = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    rhwpProcessGroup: true,
  });
  const stopped = stopHubChild(child, {
    timeoutMs: 50,
    platform: 'linux',
    killProcess: (pid, signal) => {
      signals.push([pid, signal]);
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
      return true;
    },
  });
  await stopped;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(signals, [[-4321, 'SIGTERM']]);
});

test('stopHubChild is a no-op without a child', async () => {
  await stopHubChild(null);
});

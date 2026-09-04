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
  killPid,
  nextHubRestartDelay,
  parseHubReadyLine,
  readPidFile,
  removePidFile,
  registerHubSession,
  requestHubShutdown,
  resolveHubLaunch,
  startDetachedHub,
  stopHubByPort,
  stopHubChild,
  waitForHub,
  waitForHubChildExit,
  waitForHubReadyLine,
  writeHostStream,
  writePidFile,
} from '../../../desktop/agent-hub.mjs';

const desktopMain = readFileSync(new URL('../../../desktop/main.mjs', import.meta.url), 'utf8');
const agentHubSource = readFileSync(new URL('../../../desktop/agent-hub.mjs', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../../../desktop/preload.cjs', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const viteHubPlugin = readFileSync(new URL('../vite-plugin-agent-hub.mjs', import.meta.url), 'utf8');
const rootPackage = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
const windowsEnv = Object.freeze({ SystemRoot: 'C:\\Windows' });

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

test('desktop registers a session through the owner route and receives scoped capabilities', async () => {
  let request: { url?: string; init?: any } = {};
  const capabilities = await registerHubSession({
    port: 6123,
    token: 'master-secret',
    launchId: 'launch-a',
    sessionId: 'window-a',
    fetchImpl: async (url: string, init: any) => {
      request = { url, init };
      return jsonResponse({
        status: 'registered',
        sessionId: 'window-a',
        capabilities: {
          studio: 'studio-cap', mcp: 'mcp-cap', reference: 'reference-cap', template: 'template-cap',
        },
      });
    },
  });
  assert.deepEqual(capabilities, {
    studio: 'studio-cap',
    mcp: 'mcp-cap',
    reference: 'reference-cap',
    template: 'template-cap',
  });
  assert.equal(request.url, 'http://127.0.0.1:6123/sessions/window-a');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.authorization, 'Bearer master-secret');
  assert.equal(request.init.headers['x-rhwp-launch-id'], 'launch-a');
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

test('health probes cancel unread non-ok bodies before retrying', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  }), { status: 503 });

  assert.equal(await isHubHealthy(5175, { fetchImpl: async () => response }), false);
  assert.equal(cancelled, true);
});

test('hub lifecycle responses are bounded while streaming from an unexpected loopback process', async () => {
  const oversized = () => new Response(new Uint8Array((64 * 1024) + 1), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(await isHubHealthy(5175, { fetchImpl: async () => oversized() }), false);
  await assert.rejects(
    registerHubSession({
      port: 5175,
      token: 'token',
      launchId: 'launch',
      sessionId: 'session',
      fetchImpl: async () => oversized(),
    }),
    /invalid session registration/,
  );
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

test('packaged launch always uses the bundled Electron Node runtime', () => {
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
  assert.equal(launch?.via, 'electron-as-node');
  assert.equal(launch?.command, '/app/Rauhwpx');
  assert.deepEqual(launch?.args, ['/app/rhwp-agent/server.mjs']);
  assert.equal(launch?.env.ELECTRON_RUN_AS_NODE, '1');
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

test('packaged Windows launch also keeps the sidecar on the bundled Node runtime', () => {
  const scriptPath = 'C:\\Program Files\\Rauhwpx\\resources\\app.asar.unpacked\\rhwp\\rhwp-agent\\server.mjs';
  const launch = resolveHubLaunch({
    packaged: true,
    execPath: 'C:\\Program Files\\Rauhwpx\\Rauhwpx.exe',
    scriptPath,
    agentDir: 'C:\\Program Files\\Rauhwpx\\resources\\app.asar.unpacked\\rhwp\\rhwp-agent',
    home: 'C:\\Users\\dev',
    env: { PATH: 'C:\\Windows\\System32' },
    exists: (path) => path === scriptPath,
    platform: 'win32',
  });
  assert.equal(launch?.via, 'electron-as-node');
  assert.equal(launch?.command, 'C:\\Program Files\\Rauhwpx\\Rauhwpx.exe');
  assert.deepEqual(launch?.args, [scriptPath]);
  assert.equal(launch?.env.ELECTRON_RUN_AS_NODE, '1');
});

test('desktop shell owns one ephemeral authenticated hub and exposes session IPC', () => {
  assert.match(desktopMain, /app\.requestSingleInstanceLock\(\)/);
  assert.match(desktopMain, /if \(!app\.isPackaged\)[\s\S]*app\.setPath\('userData', developmentUserData\)/);
  assert.match(desktopMain, /\.run', 'desktop-user-data'/);
  assert.match(desktopMain, /app\.on\('second-instance'/);
  assert.match(desktopMain, /await hubOwner\.ensure\(\);[\s\S]*await createWindow\(request\)/);
  assert.match(desktopMain, /ipcMain\.handle\('desktop:get-session-context'/);
  assert.match(desktopMain, /sessions\.sessionForSender\(event\.sender\)/);
  assert.match(desktopMain, /RHWP_AGENT_PORT: '0'/);
  assert.match(desktopMain, /RHWP_AGENT_TOKEN: hubToken/);
  assert.match(desktopMain, /RHWP_LAUNCH_ID: launchId/);
  assert.match(desktopMain, /RHWP_OWNER_PID: String\(process\.pid\)/);
  assert.match(desktopMain, /RHWP_OWNER_IPC: '1'/);
  assert.match(desktopMain, /RHWP_RUNTIME_DIR: this\.runtimeDir/);
  assert.match(desktopMain, /RHWP_WORK_DIR: this\.workDir/);
  assert.match(desktopMain, /expectedPid: child\.pid/);
  assert.match(desktopMain, /expectedLaunchId: launchId/);
  assert.match(desktopMain, /waitForHubReadyLine\(child, \{ launchId \}\)/);
  assert.doesNotMatch(desktopMain, /DEFAULT_HUB_PORT/);
  assert.doesNotMatch(desktopMain, /startStudioServer/);
  assert.match(desktopMain, /sandbox: true/);
  assert.match(desktopMain, /contextIsolation: true/);
  assert.match(desktopMain, /stopHubChild\(/);
  assert.match(
    desktopMain,
    /cleanupPrepared = response\?\.status === 'prepared'[\s\S]{0,100}response\?\.launchId === launchId/,
  );
  assert.match(desktopMain, /hasPendingLaunchCleanupSync\(this\.workDir\)/);
  assert.match(desktopMain, /retainLaunchRootForProcessCleanupSync\(this\.workDir, \{ launchId \}\)/);
  assert.match(desktopMain, /#restartRequired = false/);
  assert.match(desktopMain, /this\.#restartTimer \|\| this\.#restartRequired/);
  assert.match(desktopMain, /if \(this\.#restartRequired\) throw this\.restartRequiredError\(\)/);
  assert.match(desktopMain, /error\.code = 'AGENT_HUB_RESTART_REQUIRED'/);
  assert.match(
    desktopMain,
    /if \(process\.platform === 'win32'\) \{\s*this\.quarantineUnexpectedWindowsExit\(\);\s*return;/,
  );
  assert.match(
    desktopMain,
    /quarantineUnexpectedWindowsExit\(\)[\s\S]*this\.#restartRequired = true;[\s\S]*retainLaunchRootForProcessCleanupSync\(this\.workDir, \{ launchId \}\)[\s\S]*requiring an app restart/,
  );
  assert.match(
    desktopMain,
    /if \(this\.#stoppingChild === child\) return;[\s\S]*if \(process\.platform === 'win32'\)/,
  );
  assert.doesNotMatch(desktopMain, /onExit: \(code, signal\) => \{[\s\S]{0,300}this\.#child = null/);
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

test('ready-line waiter accepts output emitted before it attaches', async () => {
  const ready = { launchId: 'launch-fast', pid: 55, port: 32124 };
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    rhwpStdoutHistory: string;
  };
  child.stdout = new EventEmitter();
  child.rhwpStdoutHistory = `startup log\n${HUB_READY_PREFIX}${JSON.stringify(ready)}\n`;

  assert.deepEqual(await waitForHubReadyLine(child, { launchId: ready.launchId }), ready);
});

test('ready-line waiter bounds an unterminated stdout line while waiting', async () => {
  const ready = { launchId: 'launch-bounded', pid: 56, port: 32125 };
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    exitCode: number | null;
    signalCode: string | null;
  };
  child.stdout = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const pending = waitForHubReadyLine(child, { launchId: ready.launchId, timeoutMs: 500 });
  child.stdout.emit('data', 'x'.repeat(256 * 1024));
  child.stdout.emit('data', `\n${HUB_READY_PREFIX}${JSON.stringify(ready)}\n`);
  assert.deepEqual(await pending, ready);
  assert.match(agentHubSource, /buffer = buffer\.slice\(-MAX_HUB_READY_LINE_BUFFER_CHARS\)/);
});

test('hub stdio forwarding writes normally and skips unusable host streams', () => {
  const chunks: string[] = [];
  const stream = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write(chunk: string) { chunks.push(String(chunk)); },
  });

  assert.equal(writeHostStream(stream, 'ready\n'), true);
  assert.deepEqual(chunks, ['ready\n']);

  stream.destroyed = true;
  assert.equal(writeHostStream(stream, 'ignored'), false);
  assert.deepEqual(chunks, ['ready\n']);
});

test('hub stdio forwarding tolerates expected host-pipe closures', () => {
  for (const code of ['EIO', 'EPIPE', 'ENOTCONN', 'ERR_STREAM_DESTROYED']) {
    const stream = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writable: true,
      write() { throw Object.assign(new Error(code), { code }); },
    });
    assert.equal(writeHostStream(stream, 'chunk'), false);
    assert.doesNotThrow(() => stream.emit('error', Object.assign(new Error(code), { code })));
  }
});

test('hub stdio forwarding keeps unexpected failures observable', () => {
  const warnings: unknown[][] = [];
  const asyncFailure = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {},
  });
  writeHostStream(asyncFailure, 'chunk', { log: { warn: (...args: unknown[]) => warnings.push(args) } });
  asyncFailure.emit('error', Object.assign(new Error('unexpected async failure'), { code: 'EACCES' }));
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0]), /host stdio stream error/);

  const syncFailure = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() { throw Object.assign(new Error('unexpected sync failure'), { code: 'EACCES' }); },
  });
  assert.throws(() => writeHostStream(syncFailure, 'chunk'), /unexpected sync failure/);
});

test('ready-line waiter rejects a child that already exited', async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    exitCode: number;
  };
  child.stdout = new EventEmitter();
  child.exitCode = 1;

  await assert.rejects(
    waitForHubReadyLine(child, { launchId: 'launch-dead', timeoutMs: 100 }),
    /exited before ready \(1\)/,
  );
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

test('studio development and desktop builds include the agent hub', () => {
  assert.match(viteConfig, /rhwpAgentHubPlugin\(__dirname\)/);
  assert.match(viteHubPlugin, /spawnHubProcess\(\{/);
  assert.match(viteHubPlugin, /process\.execPath/);
  assert.match(viteHubPlugin, /RHWP_SKIP_AGENT_HUB/);
  assert.match(viteHubPlugin, /\/__rhwp\/ensure-agent-hub/);
  assert.match(viteHubPlugin, /RHWP_AGENT_PORT: String\(requestedPort\)/);
  assert.match(viteHubPlugin, /RHWP_AGENT_TOKEN: token/);
  assert.match(viteHubPlugin, /RHWP_OWNER_IPC: '1'/);
  assert.match(viteHubPlugin, /stdio: \['ignore', 'pipe', 'pipe', 'ipc'\]/);
  assert.match(viteHubPlugin, /RHWP_WORK_DIR:/);
  assert.match(viteHubPlugin, /waitForHubReadyLine\(spawned, \{ launchId \}\)/);
  assert.match(viteHubPlugin, /stopHubChild\(/);
  assert.match(viteHubPlugin, /hasPendingLaunchCleanupSync\(join\(candidate, 'work'\)\)/);
  assert.match(viteHubPlugin, /retainLaunchRootForProcessCleanupSync\(join\(currentWorkRoot, 'work'\), \{ launchId \}\)/);
  assert.match(viteHubPlugin, /onExit\(code, signal\)[\s\S]{0,300}Keep the exited leader/);
  assert.doesNotMatch(viteHubPlugin, /onExit\(code, signal\) \{[\s\S]{0,300}(?:child = null|removeOwnedWorkRoot)/);
  assert.match(
    viteHubPlugin,
    /catch \(error\) \{\s*try \{\s*await stopOwnedHub\(\{ removeWork: true \}\);[\s\S]*?catch \(cleanupError\)[\s\S]*?throw error;/,
  );
  assert.doesNotMatch(viteHubPlugin, /waitForHubChildExit/);
  assert.match(
    viteHubPlugin,
    /await requestHubShutdown\([\s\S]{0,500}cleanupPrepared = response\?\.status === 'prepared'[\s\S]{0,100}response\?\.launchId === launchId[\s\S]{0,300}const stopped = await stopHubChild\(current/,
  );
  assert.match(rootPackage, /"start": "node rhwp\/rhwp-agent\/ctl.mjs start"/);
  assert.match(rootPackage, /"start:fg": "node rhwp\/rhwp-agent\/server.mjs"/);
  assert.match(rootPackage, /"stop": "node rhwp\/rhwp-agent\/ctl.mjs stop"/);
  assert.match(rootPackage, /"build:desktop": "npm run build:native && npm run build:studio && npm run build:agent"/);
  assert.match(rootPackage, /"desktop": "npm run build:desktop && electron \."/);
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

test('stopHubByPort waits for health-down and process exit before removing its pid file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-stop-complete-'));
  const pidPath = join(dir, 'rhwp-agent.pid');
  let healthReads = 0;
  let processReads = 0;
  let clock = 0;
  writePidFile(pidPath, 4242);
  try {
    const result = await stopHubByPort(5175, {
      pidPath,
      fetchImpl: async (_url: string, init?: { method?: string }) => {
        if (init?.method === 'POST') {
          return jsonResponse({ status: 'prepared', launchId: 'launch-a' });
        }
        healthReads += 1;
        if (healthReads === 1) return jsonResponse({ ok: true, pid: 4242, launchId: 'launch-a' });
        return { ok: false, json: async () => null };
      },
      timeoutMs: 200,
      wait: async (ms) => { clock += ms; },
      now: () => clock,
      processAlive: () => {
        processReads += 1;
        return processReads < 3;
      },
    });

    assert.deepEqual(result, { stopped: true, ready: false, pid: 4242 });
    assert.equal(readPidFile(pidPath), null);
    assert.equal(processReads, 3);
    assert.ok(clock >= 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopHubByPort lets authenticated cleanup proof outlive the leader polling window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-stop-proof-window-'));
  const pidPath = join(dir, 'rhwp-agent.pid');
  let healthReads = 0;
  let clock = 0;
  let shutdownAborted = false;
  writePidFile(pidPath, 4242);
  try {
    const result = await stopHubByPort(5175, {
      pidPath,
      fetchImpl: async (_url: string, init?: { method?: string; signal?: AbortSignal }) => {
        if (init?.method === 'POST') {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve(jsonResponse({ status: 'prepared', launchId: 'launch-a' }));
            }, 25);
            init.signal?.addEventListener('abort', () => {
              shutdownAborted = true;
              clearTimeout(timer);
              reject(init.signal?.reason ?? new Error('shutdown request aborted'));
            }, { once: true });
          });
        }
        healthReads += 1;
        if (healthReads === 1) return jsonResponse({ ok: true, pid: 4242, launchId: 'launch-a' });
        return { ok: false, json: async () => null };
      },
      // Process-tree preparation is allowed to use its own longer bound. This
      // shorter interval controls only the post-proof leader polling below.
      timeoutMs: 10,
      wait: async (ms) => { clock += ms; },
      now: () => clock,
      processAlive: () => false,
    });

    assert.equal(shutdownAborted, false);
    assert.deepEqual(result, { stopped: true, ready: false, pid: 4242 });
    assert.equal(readPidFile(pidPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopHubByPort reports a timeout and retains the pid file while the process is alive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-stop-timeout-'));
  const pidPath = join(dir, 'rhwp-agent.pid');
  let healthReads = 0;
  let clock = 0;
  writePidFile(pidPath, 4242);
  try {
    const result = await stopHubByPort(5175, {
      pidPath,
      fetchImpl: async (_url: string, init?: { method?: string }) => {
        if (init?.method === 'POST') {
          return jsonResponse({ status: 'prepared', launchId: 'launch-a' });
        }
        healthReads += 1;
        if (healthReads === 1) return jsonResponse({ ok: true, pid: 4242, launchId: 'launch-a' });
        return { ok: false, json: async () => null };
      },
      timeoutMs: 100,
      wait: async (ms) => { clock += ms; },
      now: () => clock,
      processAlive: () => true,
    });

    assert.deepEqual(result, { stopped: false, ready: false, pid: 4242 });
    assert.equal(readPidFile(pidPath), 4242);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopHubByPort retains quarantine after cleanup-unproven even when the leader exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-stop-unproven-'));
  const pidPath = join(dir, 'rhwp-agent.pid');
  let healthReads = 0;
  let clock = 0;
  try {
    const result = await stopHubByPort(5175, {
      pidPath,
      fetchImpl: async (_url: string, init?: { method?: string }) => {
        if (init?.method === 'POST') {
          return jsonResponse({ status: 'cleanup-unproven', launchId: 'launch-a' }, false);
        }
        healthReads += 1;
        if (healthReads === 1) return jsonResponse({ ok: true, pid: 4242, launchId: 'launch-a' });
        return { ok: false, json: async () => null };
      },
      timeoutMs: 100,
      wait: async (ms) => { clock += ms; },
      now: () => clock,
      processAlive: () => false,
    });

    assert.deepEqual(result, { stopped: false, ready: false, pid: 4242 });
    assert.equal(readPidFile(pidPath), 4242);
    const laterStart = await startDetachedHub({
      port: 5175,
      runDir: dir,
      fetchImpl: async () => ({ ok: false, json: async () => null }),
      processAlive: () => true,
    });
    assert.equal(laterStart.error, 'hub-cleanup-unproven');
    assert.equal(laterStart.pid, 4242);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopHubByPort rejects a prepared response from a different launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-stop-wrong-launch-'));
  const pidPath = join(dir, 'rhwp-agent.pid');
  let healthReads = 0;
  let clock = 0;
  writePidFile(pidPath, 4243);
  try {
    const result = await stopHubByPort(5175, {
      pidPath,
      fetchImpl: async (_url: string, init?: { method?: string }) => {
        if (init?.method === 'POST') {
          return jsonResponse({ status: 'prepared', launchId: 'launch-b' });
        }
        healthReads += 1;
        if (healthReads === 1) return jsonResponse({ ok: true, pid: 4243, launchId: 'launch-a' });
        return { ok: false, json: async () => null };
      },
      timeoutMs: 100,
      wait: async (ms) => { clock += ms; },
      now: () => clock,
      processAlive: () => false,
    });

    assert.deepEqual(result, { stopped: false, ready: false, pid: 4243 });
    assert.equal(readPidFile(pidPath), 4243);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startDetachedHub does not bypass a quarantined detached pid record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-start-quarantined-'));
  const paths = hubRunPaths(dir);
  writePidFile(paths.pid, 4244);
  try {
    const result = await startDetachedHub({
      port: 5175,
      runDir: dir,
      fetchImpl: async () => ({ ok: false, json: async () => null }),
      processAlive: () => true,
    });
    assert.deepEqual(result, {
      started: false,
      ready: false,
      pid: 4244,
      log: paths.log,
      error: 'hub-cleanup-unproven',
    });
    assert.equal(readPidFile(paths.pid), 4244);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startDetachedHub recovers a dead pid record with fresh owned roots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-start-dead-record-'));
  const paths = hubRunPaths(dir);
  writePidFile(paths.pid, 4245);
  try {
    const result = await startDetachedHub({
      port: 5175,
      runDir: dir,
      scriptPath: join(dir, 'missing-server.mjs'),
      fetchImpl: async () => ({ ok: false, json: async () => null }),
      processAlive: () => false,
      exists: () => false,
      log: { warn() {} },
    });
    assert.deepEqual(result, {
      started: false,
      ready: false,
      pid: null,
      log: paths.log,
    });
    assert.equal(readPidFile(paths.pid), null);
    assert.match(agentHubSource, /join\(paths\.dir, 'launches', launchRootKey\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startDetachedHub does not derive owned roots from a caller launch id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-start-launch-id-'));
  try {
    await startDetachedHub({
      port: 5175,
      runDir: dir,
      env: { RHWP_LAUNCH_ID: '../../caller-controlled' },
      scriptPath: join(dir, 'missing-server.mjs'),
      fetchImpl: async () => ({ ok: false, json: async () => null }),
      exists: () => false,
      log: { warn() {} },
    });
    assert.match(agentHubSource, /const launchRootKey = randomBytes/);
    assert.doesNotMatch(agentHubSource, /join\(paths\.dir, 'launches', launchId\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startDetachedHub retains a dead pid quarantine for caller-managed roots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-start-external-roots-'));
  const paths = hubRunPaths(dir);
  writePidFile(paths.pid, 4246);
  try {
    const result = await startDetachedHub({
      port: 5175,
      runDir: dir,
      env: {
        RHWP_WORK_DIR: join(dir, 'external-work'),
        RHWP_RUNTIME_DIR: join(dir, 'external-runtime'),
      },
      fetchImpl: async () => ({ ok: false, json: async () => null }),
      processAlive: () => false,
    });
    assert.equal(result.error, 'hub-cleanup-unproven');
    assert.equal(readPidFile(paths.pid), 4246);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    treeAlive: () => false,
  });
  assert.equal(await stopped, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(signals, [[-4321, 'SIGTERM']]);
});

test('stopHubChild force-kills a surviving POSIX group after its leader exits', async () => {
  const signals: Array<[number, string]> = [];
  let groupAlive = true;
  const child = Object.assign(new EventEmitter(), {
    pid: 4322,
    exitCode: null as number | null,
    signalCode: null,
    rhwpProcessGroup: true,
  });
  const stopped = stopHubChild(child, {
    timeoutMs: 20,
    finalGraceMs: 20,
    platform: 'linux',
    treeAlive: () => groupAlive,
    killProcess: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGTERM') queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
      if (signal === 'SIGKILL') groupAlive = false;
      return true;
    },
  });

  assert.equal(await stopped, true);
  assert.deepEqual(signals, [[-4322, 'SIGTERM'], [-4322, 'SIGKILL']]);
});

test('leader crash retains POSIX group identity through restart cleanup', async () => {
  const signals: Array<[number, string]> = [];
  let groupAlive = true;
  const child = Object.assign(new EventEmitter(), {
    pid: 4323,
    exitCode: 1,
    signalCode: null,
    rhwpProcessGroup: true,
  });
  const stopped = stopHubChild(child, {
    timeoutMs: 10,
    finalGraceMs: 10,
    platform: 'linux',
    treeAlive: () => groupAlive,
    killProcess: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGKILL') groupAlive = false;
      return true;
    },
  });

  assert.equal(await stopped, true);
  assert.deepEqual(signals, [[-4323, 'SIGTERM'], [-4323, 'SIGKILL']]);
});

test('prepared Windows cleanup waits for the retained child to exit without resolving its PID again', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 5432,
    exitCode: null as number | null,
    signalCode: null,
  });
  const commands: string[] = [];
  let settled = false;
  const stopped = stopHubChild(child, {
    timeoutMs: 100,
    finalGraceMs: 50,
    platform: 'win32',
    cleanupPrepared: true,
    env: windowsEnv,
    spawnProcess: (command) => {
      commands.push(command);
      return new EventEmitter();
    },
  }).then((value) => {
    settled = true;
    return value;
  });
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true);
  assert.equal(await stopped, true);
  assert.deepEqual(commands, []);
});

test('unprepared Windows cleanup uses only the retained handle and fails closed', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 5436,
    exitCode: null as number | null,
    signalCode: null,
    kill: () => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
      return true;
    },
  });
  const calls: string[][] = [];
  const stopped = stopHubChild(child, {
    timeoutMs: 100,
    finalGraceMs: 50,
    platform: 'win32',
    env: windowsEnv,
    spawnProcess: (_command, args) => {
      calls.push(args);
      return new EventEmitter();
    },
  });

  assert.equal(await stopped, false);
  assert.deepEqual(calls, []);
});

test('stopHubChild never retargets a surviving Windows child by reusable PID', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 5433,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  const calls: string[][] = [];
  const stopped = await stopHubChild(child, {
    timeoutMs: 10,
    finalGraceMs: 10,
    platform: 'win32',
    env: windowsEnv,
    spawnProcess: (_command, args) => {
      calls.push(args);
      const killer = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
      queueMicrotask(() => {
        killer.exitCode = 0;
        killer.emit('close', 0, null);
      });
      return killer;
    },
  });

  assert.equal(stopped, false);
  assert.deepEqual(calls, []);
});

test('a completed prepared shutdown remains proof after the Windows leader exits', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 5437,
    exitCode: 0,
    signalCode: null,
  });
  const calls: string[][] = [];
  assert.equal(await stopHubChild(child, {
    platform: 'win32',
    cleanupPrepared: true,
    spawnProcess: (_command, args) => {
      calls.push(args);
      return new EventEmitter();
    },
  }), true);
  assert.deepEqual(calls, []);
});

test('bare Windows PID cleanup fails closed without spawning taskkill', async () => {
  let helperSpawned = false;
  const result = await killPid(6000, {
    platform: 'win32',
    env: windowsEnv,
    spawnProcess: () => {
      helperSpawned = true;
      return new EventEmitter();
    },
    processAlive: () => true,
  });
  assert.deepEqual(result, { killed: false, alive: true });
  assert.equal(helperSpawned, false);
});

test('exited Windows leader fails closed when task-tree death cannot be proved', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 5434,
    exitCode: 1,
    signalCode: null,
  });
  const calls: string[][] = [];
  const stopped = await stopHubChild(child, {
    timeoutMs: 10,
    finalGraceMs: 10,
    platform: 'win32',
    env: windowsEnv,
    spawnProcess: (_command, args) => {
      calls.push(args);
      const killer = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
      queueMicrotask(() => {
        killer.exitCode = 128;
        killer.emit('close', 128, null);
      });
      return killer;
    },
  });

  assert.equal(stopped, false);
  assert.deepEqual(calls, [], 'an expired PID must never be passed to taskkill');
});

test('Windows hub cleanup never consults a caller-controlled taskkill path', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 5435,
    exitCode: null,
    signalCode: null,
  });
  const calls: string[] = [];
  const stopped = await stopHubChild(child, {
    timeoutMs: 1,
    finalGraceMs: 1,
    platform: 'win32',
    env: { SystemRoot: 'relative' },
    spawnProcess: (command) => {
      calls.push(command);
      return new EventEmitter();
    },
  });

  assert.equal(stopped, false);
  assert.deepEqual(calls, []);
});

test('stopHubChild is a no-op without a child', async () => {
  assert.equal(await stopHubChild(null), true);
});

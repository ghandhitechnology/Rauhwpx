/**
 * Local rhwp-agent hub lifecycle helpers used by the Electron shell.
 *
 * The renderer can only talk WebSocket; this module decides whether a hub is
 * already healthy and how to launch one. Launch matches `npm start` in
 * rhwp-agent when npm is on PATH (including Homebrew/nvm locations GUI apps
 * otherwise miss). Packaged builds fall back to Electron-as-Node.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';

export const DEFAULT_HUB_PORT = 5175;
export const DEFAULT_HEALTH_TIMEOUT_MS = 500;
export const DEFAULT_STOP_TIMEOUT_MS = 5000;
export const DEFAULT_READY_TIMEOUT_MS = 15000;
export const DEFAULT_SHUTDOWN_PREPARE_TIMEOUT_MS = 15000;
export const DEFAULT_POLL_INTERVAL_MS = 150;
export const HUB_RESTART_DELAYS_MS = [500, 1000, 2000, 5000];
export const HUB_READY_PREFIX = 'RHWP_HUB_READY ';
const MAX_HUB_READY_LINE_BUFFER_CHARS = 64 * 1024;
const MAX_HUB_HTTP_RESPONSE_BYTES = 64 * 1024;

async function cancelHubResponse(response) {
  try {
    if (typeof response?.body?.cancel === 'function') await response.body.cancel();
    else response?.body?.destroy?.();
  } catch {}
}

async function readHubJson(response) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_HUB_HTTP_RESPONSE_BYTES) {
    await response?.body?.cancel?.().catch(() => {});
    throw new Error('Agent hub response exceeded 64 KiB');
  }
  if (!response?.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HUB_HTTP_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Agent hub response exceeded 64 KiB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createHubToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function packagedRhwpBinary({
  packaged,
  resourcesPath,
  platform = process.platform,
  exists = existsSync,
}) {
  if (!packaged) return null;
  const platformPath = platform === 'win32' ? win32 : posix;
  const binary = platformPath.join(resourcesPath, 'bin', platform === 'win32' ? 'rhwp.exe' : 'rhwp');
  if (!exists(binary)) throw new Error(`Packaged document extractor is missing: ${binary}`);
  return binary;
}

export function hubHealthUrl(port) {
  return `http://127.0.0.1:${port}/healthz`;
}

function hubOwnerHeaders(token, launchId) {
  return {
    authorization: `Bearer ${token}`,
    'x-rhwp-launch-id': launchId,
  };
}

async function requestHubOwnerRoute(url, {
  method,
  token,
  launchId,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: hubOwnerHeaders(token, launchId),
      signal: ac.signal,
    });
    const body = await readHubJson(response).catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.error?.message || `Agent hub request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function closeHubSession({ port, token, launchId, sessionId, ...options }) {
  const encodedSessionId = encodeURIComponent(String(sessionId));
  return requestHubOwnerRoute(`http://127.0.0.1:${port}/sessions/${encodedSessionId}`, {
    ...options,
    method: 'DELETE',
    token,
    launchId,
  });
}

export async function registerHubSession({ port, token, launchId, sessionId, ...options }) {
  const normalizedSessionId = String(sessionId);
  const encodedSessionId = encodeURIComponent(normalizedSessionId);
  const body = await requestHubOwnerRoute(`http://127.0.0.1:${port}/sessions/${encodedSessionId}`, {
    ...options,
    method: 'POST',
    token,
    launchId,
  });
  const capabilities = body?.capabilities;
  if (
    body?.status !== 'registered'
    || body?.sessionId !== normalizedSessionId
    || typeof capabilities?.studio !== 'string'
    || typeof capabilities?.mcp !== 'string'
    || typeof capabilities?.reference !== 'string'
    || typeof capabilities?.template !== 'string'
  ) throw new Error('Agent hub returned an invalid session registration');
  return Object.freeze({
    studio: capabilities.studio,
    mcp: capabilities.mcp,
    reference: capabilities.reference,
    template: capabilities.template,
  });
}

export function requestHubShutdown({ port, token, launchId, ...options }) {
  return requestHubOwnerRoute(`http://127.0.0.1:${port}/shutdown`, {
    ...options,
    method: 'POST',
    token,
    launchId,
  });
}

export function nextHubRestartDelay(attempt, delays = HUB_RESTART_DELAYS_MS) {
  const index = Math.min(Math.max(0, attempt), delays.length - 1);
  return delays[index];
}

export async function readHubHealth(port, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  token,
  launchId,
} = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(launchId ? { 'x-rhwp-launch-id': launchId } : {}),
  };
  try {
    const response = await fetchImpl(hubHealthUrl(port), { signal: ac.signal, headers });
    if (!response.ok) {
      await cancelHubResponse(response);
      return null;
    }
    const body = await readHubJson(response);
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function isHubHealthy(port, { expectedPid, expectedLaunchId, ...options } = {}) {
  const body = await readHubHealth(port, options);
  if (body?.ok !== true) return false;
  if (expectedPid !== undefined && hubPidFromHealth(body) !== expectedPid) return false;
  return expectedLaunchId === undefined || body.launchId === expectedLaunchId;
}

export function hubPidFromHealth(body) {
  const pid = Number(body?.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function waitForHub(port, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  isHealthy = isHubHealthy,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await isHealthy(port, { fetchImpl })) return true;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return isHealthy(port, { fetchImpl });
}

/**
 * Probe localhost and spawn only when nothing healthy is listening.
 *
 * `start` should return `false` when it could not even launch a process.
 * If a process is already alive, we wait for it instead of forking a second
 * listener onto the same port.
 */
export async function ensureAgentHub({
  port,
  start,
  stop,
  processAlive = false,
  restartUnhealthy = false,
  fetchImpl = globalThis.fetch,
  isHealthy = isHubHealthy,
  wait = waitForHub,
  log = console,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
} = {}) {
  if (await isHealthy(port, { fetchImpl })) {
    log.log?.('[rauhwpx] agent hub already running');
    return { started: false, ready: true };
  }

  let started = false;
  if (!processAlive) {
    const launched = start?.();
    if (launched === false) {
      return { started: false, ready: false };
    }
    started = true;
  }

  let ready = await wait(port, { fetchImpl, isHealthy, timeoutMs: readyTimeoutMs });
  if (ready) return { started, ready: true };

  if (!restartUnhealthy || typeof stop !== 'function') {
    log.warn?.('[rauhwpx] agent hub did not become ready');
    return { started, ready: false };
  }

  await stop();
  const relaunched = start?.();
  if (relaunched === false) {
    return { started: false, ready: false };
  }
  ready = await wait(port, { fetchImpl, isHealthy, timeoutMs: readyTimeoutMs });
  if (!ready) log.warn?.('[rauhwpx] agent hub did not become ready after restart');
  return { started: true, ready };
}

export function pathDelimiter(platform = process.platform) {
  return platform === 'win32' ? ';' : ':';
}

export function extraBinDirs(home, {
  exists = existsSync,
  readFile = readFileSync,
  platform = process.platform,
} = {}) {
  const platformPath = platform === 'win32' ? win32 : posix;
  const dirs = [
    platformPath.join(home, '.local', 'bin'),
    platformPath.join(home, '.fnm', 'aliases', 'default', 'bin'),
    platformPath.join(home, '.volta', 'bin'),
    platformPath.join(home, '.asdf', 'shims'),
    platformPath.join(home, '.nvm', 'current', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  try {
    const alias = String(readFile(platformPath.join(home, '.nvm', 'alias', 'default'), 'utf8')).trim();
    if (alias && !alias.includes('/')) {
      dirs.unshift(platformPath.join(home, '.nvm', 'versions', 'node', alias, 'bin'));
      dirs.unshift(platformPath.join(home, '.nvm', 'versions', 'node', `v${alias}`, 'bin'));
    }
  } catch {
    /* no nvm default alias */
  }
  return dirs.filter((dir) => exists(dir));
}

export function findOnPath(name, pathEnv, exists = existsSync, platform = process.platform) {
  const delim = pathDelimiter(platform);
  const platformPath = platform === 'win32' ? win32 : posix;
  for (const dir of String(pathEnv).split(delim)) {
    if (!dir) continue;
    const candidate = platformPath.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function buildHubPath({
  home,
  envPath = '',
  agentDir,
  extraDirs = [],
  exists = existsSync,
  readFile = readFileSync,
  platform = process.platform,
} = {}) {
  const delim = pathDelimiter(platform);
  const platformPath = platform === 'win32' ? win32 : posix;
  const bins = [
    agentDir ? platformPath.join(agentDir, 'node_modules', '.bin') : null,
    ...extraDirs,
    ...extraBinDirs(home ?? '', { exists, readFile, platform }),
  ].filter(Boolean);
  const parts = [...bins.filter((dir) => exists(dir)), envPath];
  return [...new Set(parts.join(delim).split(delim).filter(Boolean))].join(delim);
}

export function sanitizeHubEnv(env, { electronAsNode = false } = {}) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith('ELECTRON_') || key.startsWith('CHROME_') || key.startsWith('npm_')) {
      delete next[key];
    }
  }
  if (electronAsNode) next.ELECTRON_RUN_AS_NODE = '1';
  return next;
}

/**
 * Prefer `node server.mjs` (what `npm start` in rhwp-agent actually runs).
 * Nested `npm start` from Electron inherits npm_/ELECTRON_ env and often exits.
 * Packaged apps without Node fall back to Electron-as-Node.
 */
export function resolveHubLaunch({
  packaged = false,
  execPath,
  scriptPath,
  agentDir,
  home,
  env = process.env,
  extraDirs = [],
  allowNpm = true,
  exists = existsSync,
  platform = process.platform,
} = {}) {
  const platformPath = platform === 'win32' ? win32 : posix;
  const cwd = agentDir || (scriptPath ? platformPath.dirname(scriptPath) : '');
  if (!scriptPath || !exists(scriptPath)) return null;

  const pathEnv = buildHubPath({
    home,
    envPath: env.PATH ?? env.Path ?? '',
    agentDir: cwd,
    extraDirs,
    exists,
    platform,
  });
  const npmName = platform === 'win32' ? 'npm.cmd' : 'npm';
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const npm = findOnPath(npmName, pathEnv, exists, platform);
  const node = findOnPath(nodeName, pathEnv, exists, platform);
  const baseEnv = sanitizeHubEnv({
    ...env,
    PATH: pathEnv,
    RHWP_AGENT_PORT: String(env.RHWP_AGENT_PORT ?? DEFAULT_HUB_PORT),
  });

  if (packaged && execPath) {
    return {
      command: execPath,
      args: [scriptPath],
      cwd,
      env: sanitizeHubEnv(baseEnv, { electronAsNode: true }),
      via: 'electron-as-node',
    };
  }

  if (node) {
    return { command: node, args: [scriptPath], cwd, env: baseEnv, via: 'node' };
  }

  if (allowNpm && npm && !packaged) {
    return { command: npm, args: ['start'], cwd, env: baseEnv, via: 'npm-start' };
  }

  if (!execPath) {
    if (allowNpm && npm) return { command: npm, args: ['start'], cwd, env: baseEnv, via: 'npm-start' };
    return null;
  }
  return {
    command: execPath,
    args: [scriptPath],
    cwd,
    env: sanitizeHubEnv(baseEnv, { electronAsNode: true }),
    via: 'electron-as-node',
  };
}

export const PID_FILE_NAME = 'rhwp-agent.pid';
export const LOG_FILE_NAME = 'rhwp-agent.log';

export function hubRunDir(repoRoot) {
  return join(repoRoot, '.run');
}

export function hubRunPaths(runDir) {
  return {
    dir: runDir,
    pid: join(runDir, PID_FILE_NAME),
    log: join(runDir, LOG_FILE_NAME),
  };
}

export function ensureRunDir(runDir) {
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

export function writePidFile(pidPath, pid) {
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, `${pid}\n`, 'utf8');
}

export function readPidFile(pidPath) {
  try {
    const n = Number(String(readFileSync(pidPath, 'utf8')).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function removePidFile(pidPath) {
  try {
    unlinkSync(pidPath);
  } catch {
    /* already gone */
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function killPid(pid, {
  processAlive = isProcessAlive,
} = {}) {
  // A bare PID is not a stable process identity. Any signal can be delivered
  // to an unrelated process if the observed hub exits and its PID is reused
  // between the liveness check and the kill operation. Callers with a retained
  // ChildProcess must use stopHubChild; detached hubs stop through the
  // authenticated owner endpoint and otherwise fail closed.
  return { killed: false, alive: processAlive(pid) };
}

/**
 * Spawn the hub as a child of this process. Desktop and Vite keep the child
 * attached so they can restart or tear it down with the parent.
 */
const EXPECTED_HOST_PIPE_CLOSURE_CODES = new Set([
  'EIO',
  'EPIPE',
  'ENOTCONN',
  'ERR_STREAM_DESTROYED',
]);
const guardedHostStreams = new WeakSet();

function guardHostStream(stream, log) {
  if (!stream || typeof stream.on !== 'function' || guardedHostStreams.has(stream)) return;
  guardedHostStreams.add(stream);
  stream.on('error', (error) => {
    if (EXPECTED_HOST_PIPE_CLOSURE_CODES.has(error?.code)) return;
    log.warn?.('[rauhwpx] host stdio stream error:', error);
  });
}

export function writeHostStream(stream, chunk, { log = console } = {}) {
  guardHostStream(stream, log);
  if (!stream || stream.destroyed || stream.writableEnded || stream.writable === false) return false;
  try {
    stream.write(chunk);
    return true;
  } catch (error) {
    if (EXPECTED_HOST_PIPE_CLOSURE_CODES.has(error?.code)) return false;
    throw error;
  }
}

export function spawnHubProcess(launch, {
  platform = process.platform,
  detached = platform !== 'win32',
  stdio,
  windowsHide = true,
  forwardStdio = true,
  unref = detached && !forwardStdio,
  onError,
  onExit,
  onMessage,
  log = console,
} = {}) {
  // Windows에서 .cmd/.bat 셸 스크립트는 셸 없이 spawn하면 EINVAL이 난다
  // (CVE-2024-27980 이후 Node 정책). 이 경로는 npm.cmd start뿐이라 인자
  // 이스케이프 문제는 없다.
  const needsShell = platform === 'win32' && /\.(cmd|bat)$/i.test(launch.command);
  const child = spawn(needsShell ? `"${launch.command}"` : launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    detached,
    stdio: stdio ?? ['ignore', 'pipe', 'pipe'],
    windowsHide,
    shell: needsShell,
  });
  child.rhwpStdoutHistory = '';
  child.stdout?.on('data', (chunk) => {
    child.rhwpStdoutHistory = `${child.rhwpStdoutHistory}${String(chunk)}`.slice(-64 * 1024);
    if (forwardStdio) writeHostStream(process.stdout, chunk, { log });
  });
  if (forwardStdio) {
    child.stderr?.on('data', (chunk) => writeHostStream(process.stderr, chunk, { log }));
  }
  if (typeof onError === 'function') {
    child.on('error', onError);
  } else {
    child.on('error', (error) => {
      log.warn?.('[rauhwpx] agent hub spawn error:', error);
    });
  }
  if (typeof onExit === 'function') {
    child.on('exit', (code, signal) => onExit(code, signal, child));
  }
  if (typeof onMessage === 'function') child.on('message', (message) => onMessage(message, child));
  child.rhwpProcessGroup = detached && platform !== 'win32';
  if (unref) child.unref();
  return child;
}

export function parseHubReadyLine(line, expectedLaunchId) {
  if (!line.startsWith(HUB_READY_PREFIX)) return null;
  try {
    const ready = JSON.parse(line.slice(HUB_READY_PREFIX.length));
    if (ready?.launchId !== expectedLaunchId) return null;
    if (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) return null;
    if (!Number.isInteger(ready.pid) || ready.pid < 1) return null;
    return ready;
  } catch {
    return null;
  }
}

export function waitForHubReadyLine(child, {
  launchId,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let buffer = typeof child.rhwpStdoutHistory === 'string' ? child.rhwpStdoutHistory : '';
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const consumeLines = () => {
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      if (buffer.length > MAX_HUB_READY_LINE_BUFFER_CHARS) {
        buffer = buffer.slice(-MAX_HUB_READY_LINE_BUFFER_CHARS);
      }
      for (const line of lines) {
        const ready = parseHubReadyLine(line, launchId);
        if (!ready) continue;
        cleanup();
        resolve(ready);
        return true;
      }
      return false;
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      consumeLines();
    };
    const onError = (error) => fail(error);
    const onExit = (code, signal) => fail(new Error(`Agent hub exited before ready (${code ?? signal ?? 'unknown'})`));

    if (consumeLines()) return;
    if (child.exitCode != null || child.signalCode != null) {
      fail(new Error(`Agent hub exited before ready (${child.exitCode ?? child.signalCode ?? 'unknown'})`));
      return;
    }
    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    timer = setTimeout(() => fail(new Error('Agent hub ready line timed out')), timeoutMs);
  });
}

export function waitForHubChildExit(child, { timeoutMs = 5000 } = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    // Cleanup callers await this deadline before deciding whether session
    // roots are safe to remove. Keep it referenced so a quiet shutdown cannot
    // exit early and silently skip the liveness proof.
    child.once('exit', onExit);
  });
}

function posixProcessGroupAlive(pid, killProcess) {
  try {
    killProcess(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitForTreeExit(isAlive, {
  timeoutMs,
  wait = sleep,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!isAlive()) return true;
    await wait(Math.min(25, Math.max(1, deadline - now())));
  }
  return !isAlive();
}

export async function stopHubChild(child, {
  timeoutMs = 2000,
  finalGraceMs = 2000,
  platform = process.platform,
  killProcess = process.kill,
  treeAlive,
  wait = sleep,
  now = Date.now,
  cleanupPrepared = false,
} = {}) {
  if (!child) return true;
  const pid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;

  if (platform === 'win32' && pid !== null) {
    // taskkill resolves a numeric PID again inside a separate process and can
    // retarget an unrelated process if the leader exits in that gap. Only the
    // retained ChildProcess handle is stable. A prepared shutdown has already
    // disposed every hub-owned descendant, so only then may leader exit prove
    // cleanup; otherwise the launch root remains quarantined.
    if (cleanupPrepared) {
      if (child.exitCode != null || child.signalCode != null) return true;
      if (await waitForHubChildExit(child, { timeoutMs })) return true;
      try { child.kill('SIGTERM'); } catch {}
      return waitForHubChildExit(child, { timeoutMs: finalGraceMs });
    }
    if (child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGTERM'); } catch {}
      await waitForHubChildExit(child, { timeoutMs });
    }
    return false;
  }

  const ownsProcessGroup = pid !== null && child.rhwpProcessGroup === true;
  const groupAlive = ownsProcessGroup
    ? (treeAlive ?? (() => posixProcessGroupAlive(pid, killProcess)))
    : null;
  const signalTree = (force) => {
    if (ownsProcessGroup) {
      try { killProcess(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {}
      return;
    }
    if (child.exitCode != null || child.signalCode != null) return;
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {}
  };

  signalTree(false);
  const [gracefulExit, gracefulTreeExit] = await Promise.all([
    waitForHubChildExit(child, { timeoutMs }),
    groupAlive
      ? waitForTreeExit(groupAlive, { timeoutMs, wait, now })
      : Promise.resolve(true),
  ]);
  if (gracefulExit && gracefulTreeExit) return true;

  // A detached group can outlive its leader. Force the group even when the
  // child has already emitted exit, then wait once more before cleanup callers
  // are allowed to remove its working directories.
  signalTree(true);
  const [forcedExit, forcedTreeExit] = await Promise.all([
    gracefulExit ? Promise.resolve(true) : waitForHubChildExit(child, { timeoutMs: finalGraceMs }),
    groupAlive
      ? waitForTreeExit(groupAlive, { timeoutMs: finalGraceMs, wait, now })
      : Promise.resolve(true),
  ]);
  return forcedExit && forcedTreeExit;
}

export async function resolveHubPid(port, {
  pidPath,
  fetchImpl = globalThis.fetch,
} = {}) {
  const body = await readHubHealth(port, { fetchImpl });
  return hubPidFromHealth(body) ?? (pidPath ? readPidFile(pidPath) : null);
}

export async function stopHubByPort(port, {
  pidPath,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  token = process.env.RHWP_AGENT_TOKEN ?? process.env.RHWP_AGENT_DEV_TOKEN ?? 'dev',
  wait = sleep,
  now = Date.now,
  processAlive = isProcessAlive,
} = {}) {
  const body = await readHubHealth(port, { fetchImpl, token });
  const pid = hubPidFromHealth(body);
  if (!body?.ok || !pid || typeof body.launchId !== 'string') {
    // A missing health response cannot prove that an earlier detached hub's
    // descendants are gone. Preserve a valid PID record as a quarantine marker
    // instead of silently authorizing the same work roots to be reused.
    return { stopped: false, ready: false, pid: pidPath ? readPidFile(pidPath) : null };
  }

  let cleanupPrepared = false;
  try {
    const response = await requestHubShutdown({
      port,
      token,
      launchId: body.launchId,
      fetchImpl,
      // `/shutdown` replies only after every owned provider/tree cleanup has
      // settled. That proof can legitimately outlive the shorter leader-exit
      // polling window below; aborting it early turns a clean shutdown into a
      // permanent quarantine and makes `ctl restart` fail unnecessarily.
      timeoutMs: Math.max(timeoutMs, DEFAULT_SHUTDOWN_PREPARE_TIMEOUT_MS),
    });
    cleanupPrepared = response?.status === 'prepared'
      && response?.launchId === body.launchId;
  } catch {
    // A response failure does not prove the hub ignored the authenticated
    // request, and the numeric PID may already have been reused. Keep polling
    // the exact launch and fail closed instead of signalling a bare PID.
  }

  const deadline = now() + timeoutMs;
  let ready = true;
  let processExited = false;
  while (now() < deadline) {
    ready = await isHubHealthy(port, { fetchImpl, token, expectedPid: pid, expectedLaunchId: body.launchId });
    // /shutdown closes the HTTP server before the hub finishes deleting
    // owned work/runtime dirs and process.exit. Returning on health-down
    // alone races Windows callers that immediately rm the runDir.
    processExited = !ready && !processAlive(pid);
    if (processExited) break;
    await wait(50);
  }
  // Leader exit is not descendant-cleanup proof. Only the authenticated hub
  // can prepare its owned sessions, and the response must be bound to the exact
  // launch observed above before callers may remove the PID record or restart.
  const stopped = cleanupPrepared && !ready && processExited;
  if (pidPath) {
    if (stopped) removePidFile(pidPath);
    else writePidFile(pidPath, pid);
  }
  return { stopped, ready, pid };
}

export async function startDetachedHub({
  port = DEFAULT_HUB_PORT,
  scriptPath,
  agentDir,
  runDir,
  home,
  env = process.env,
  extraDirs = [],
  exists = existsSync,
  platform = process.platform,
  fetchImpl = globalThis.fetch,
  execPath,
  log = console,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  expectedProtocol,
  processAlive = isProcessAlive,
} = {}) {
  const paths = hubRunPaths(runDir);
  const token = env.RHWP_AGENT_TOKEN ?? env.RHWP_AGENT_DEV_TOKEN ?? 'dev';
  const ownsWorkDir = !env.RHWP_WORK_DIR;
  const ownsRuntimeDir = !env.RHWP_RUNTIME_DIR;
  const health = await readHubHealth(port, { fetchImpl, token });
  if (health?.ok) {
    const compatible = expectedProtocol === undefined
      || Number(health.protocol) === Number(expectedProtocol);
    if (compatible) {
      return {
        started: false,
        ready: true,
        alreadyRunning: true,
        pid: hubPidFromHealth(health),
        log: paths.log,
      };
    }

    // A repository update can leave the previous detached hub alive on the
    // fixed development port. It is authenticated by this same ctl token, so
    // replace it before spawning instead of letting the new child die with
    // EADDRINUSE and surfacing only a readiness timeout.
    log.log?.(`[rauhwpx] replacing protocol v${health.protocol ?? 'unknown'} agent hub with v${expectedProtocol}`);
    const stopped = await stopHubByPort(port, {
      pidPath: paths.pid,
      fetchImpl,
      token,
    });
    if (!stopped.stopped) {
      return {
        started: false,
        ready: false,
        pid: hubPidFromHealth(health),
        log: paths.log,
        error: 'incompatible-hub-still-running',
      };
    }
  }

  // A stale PID file cannot prove process identity or descendant cleanup.
  // Keep the quarantine while the leader may still be alive or the caller
  // supplied roots that a replacement launch would have to reuse.
  const recordedPid = readPidFile(paths.pid);
  if (recordedPid !== null) {
    const canUseFreshRoots = ownsWorkDir && ownsRuntimeDir && !processAlive(recordedPid);
    if (!canUseFreshRoots) {
      return {
        started: false,
        ready: false,
        pid: recordedPid,
        log: paths.log,
        error: 'hub-cleanup-unproven',
      };
    }
    // The old leader is gone, but detached descendants may still own its
    // files. A new launch gets different roots, so clearing this dead record
    // cannot make the two process trees share cleanup state.
    removePidFile(paths.pid);
    log.warn?.(`[rauhwpx] recovering from dead detached agent hub pid ${recordedPid}`);
  }
  // Junk or an already-removed record carries no process identity.
  if (paths.pid) removePidFile(paths.pid);

  const launchId = env.RHWP_LAUNCH_ID || randomBytes(16).toString('hex');
  const launchRoot = join(paths.dir, 'launches', launchId);
  const launch = resolveHubLaunch({
    packaged: false,
    execPath,
    scriptPath,
    agentDir,
    home,
    env: {
      ...env,
      RHWP_AGENT_PORT: String(port),
      RHWP_LAUNCH_ID: launchId,
      RHWP_WORK_DIR: env.RHWP_WORK_DIR ?? join(launchRoot, 'work'),
      RHWP_RUNTIME_DIR: env.RHWP_RUNTIME_DIR ?? join(launchRoot, 'runtime'),
      ...(ownsWorkDir ? { RHWP_OWN_WORK_DIR: '1' } : {}),
      ...(ownsRuntimeDir ? { RHWP_OWN_RUNTIME_DIR: '1' } : {}),
    },
    extraDirs,
    exists,
    platform,
  });
  if (!launch) {
    log.warn?.('[rauhwpx] agent hub launch command not found:', scriptPath);
    return { started: false, ready: false, pid: null, log: paths.log };
  }

  ensureRunDir(paths.dir);
  const logFd = openSync(paths.log, 'a');
  let child;
  try {
    child = spawnHubProcess(launch, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      forwardStdio: false,
      log,
    });
  } finally {
    try {
      closeSync(logFd);
    } catch {
      /* fd handed to child */
    }
  }

  if (!child?.pid) {
    log.warn?.('[rauhwpx] detached agent hub spawn produced no pid');
    return { started: false, ready: false, pid: null, log: paths.log };
  }

  writePidFile(paths.pid, child.pid);
  const ready = await waitForHub(port, {
    fetchImpl,
    timeoutMs: readyTimeoutMs,
    isHealthy: (candidatePort, options) => isHubHealthy(candidatePort, {
      ...options,
      token,
      expectedPid: child.pid,
    }),
  });
  if (!ready) {
    const stopped = await stopHubChild(child, { platform, timeoutMs: DEFAULT_STOP_TIMEOUT_MS });
    if (stopped) removePidFile(paths.pid);
    log.warn?.('[rauhwpx] detached agent hub did not become ready');
    return { started: true, ready: false, pid: child.pid, log: paths.log };
  }
  return { started: true, ready: true, pid: child.pid, log: paths.log };
}

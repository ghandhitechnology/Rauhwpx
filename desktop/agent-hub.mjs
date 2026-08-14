/**
 * Local rhwp-agent hub lifecycle helpers used by the Electron shell.
 *
 * The renderer can only talk WebSocket; this module decides whether a hub is
 * already healthy and how to launch one. Launch matches `npm start` in
 * rhwp-agent when npm is on PATH (including Homebrew/nvm locations GUI apps
 * otherwise miss). Packaged builds fall back to Electron-as-Node.
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_HUB_PORT = 5175;
export const DEFAULT_HEALTH_TIMEOUT_MS = 500;
export const DEFAULT_READY_TIMEOUT_MS = 15000;
export const DEFAULT_POLL_INTERVAL_MS = 150;
export const HUB_RESTART_DELAYS_MS = [500, 1000, 2000, 5000];

export function hubHealthUrl(port) {
  return `http://127.0.0.1:${port}/healthz`;
}

export function nextHubRestartDelay(attempt, delays = HUB_RESTART_DELAYS_MS) {
  const index = Math.min(Math.max(0, attempt), delays.length - 1);
  return delays[index];
}

export async function readHubHealth(port, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetchImpl(hubHealthUrl(port), { signal: ac.signal });
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function isHubHealthy(port, options = {}) {
  const body = await readHubHealth(port, options);
  return body?.ok === true;
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

export function extraBinDirs(home, { exists = existsSync, readFile = readFileSync } = {}) {
  const dirs = [
    join(home, '.local', 'bin'),
    join(home, '.fnm', 'aliases', 'default', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.nvm', 'current', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  try {
    const alias = String(readFile(join(home, '.nvm', 'alias', 'default'), 'utf8')).trim();
    if (alias && !alias.includes('/')) {
      dirs.unshift(join(home, '.nvm', 'versions', 'node', alias, 'bin'));
      dirs.unshift(join(home, '.nvm', 'versions', 'node', `v${alias}`, 'bin'));
    }
  } catch {
    /* no nvm default alias */
  }
  return dirs.filter((dir) => exists(dir));
}

export function findOnPath(name, pathEnv, exists = existsSync, platform = process.platform) {
  const delim = pathDelimiter(platform);
  for (const dir of String(pathEnv).split(delim)) {
    if (!dir) continue;
    const candidate = join(dir, name);
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
  const bins = [
    agentDir ? join(agentDir, 'node_modules', '.bin') : null,
    ...extraDirs,
    ...extraBinDirs(home ?? '', { exists, readFile }),
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
  exists = existsSync,
  platform = process.platform,
} = {}) {
  const cwd = agentDir || (scriptPath ? dirname(scriptPath) : '');
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

  if (node) {
    return { command: node, args: [scriptPath], cwd, env: baseEnv, via: 'node' };
  }

  if (npm && !packaged) {
    return { command: npm, args: ['start'], cwd, env: baseEnv, via: 'npm-start' };
  }

  if (!execPath) {
    if (npm) return { command: npm, args: ['start'], cwd, env: baseEnv, via: 'npm-start' };
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
export const DEFAULT_STOP_TIMEOUT_MS = 5000;

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
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  wait = sleep,
  now = Date.now,
} = {}) {
  if (!isProcessAlive(pid)) return { killed: false, alive: false };
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return { killed: false, alive: isProcessAlive(pid) };
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline && isProcessAlive(pid)) {
    await wait(50);
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return { killed: true, alive: isProcessAlive(pid) };
}

/**
 * Spawn the hub as a child of this process. Desktop and Vite keep the child
 * attached so they can restart or tear it down with the parent.
 */
export function spawnHubProcess(launch, {
  detached = false,
  stdio,
  windowsHide = true,
  forwardStdio = !detached,
  onError,
  onExit,
  log = console,
  platform = process.platform,
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
  if (forwardStdio) {
    child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
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
  if (detached) child.unref();
  return child;
}

export function stopHubChild(child, { timeoutMs = 2000 } = {}) {
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, timeoutMs);
    child.once('exit', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
    }
  });
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
} = {}) {
  const pid = await resolveHubPid(port, { pidPath, fetchImpl });
  if (!pid) {
    if (pidPath) removePidFile(pidPath);
    return { stopped: false, ready: await isHubHealthy(port, { fetchImpl }), pid: null };
  }
  await killPid(pid, { timeoutMs });
  if (pidPath) removePidFile(pidPath);
  const ready = await isHubHealthy(port, { fetchImpl });
  return { stopped: !ready, ready, pid };
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
} = {}) {
  const paths = hubRunPaths(runDir);
  if (await isHubHealthy(port, { fetchImpl })) {
    return {
      started: false,
      ready: true,
      alreadyRunning: true,
      pid: await resolveHubPid(port, { pidPath: paths.pid, fetchImpl }),
      log: paths.log,
    };
  }

  const stalePid = readPidFile(paths.pid);
  if (stalePid && isProcessAlive(stalePid)) {
    await killPid(stalePid);
  }
  if (paths.pid) removePidFile(paths.pid);

  const launch = resolveHubLaunch({
    packaged: false,
    execPath,
    scriptPath,
    agentDir,
    home,
    env: { ...env, RHWP_AGENT_PORT: String(port) },
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
  const ready = await waitForHub(port, { fetchImpl, timeoutMs: readyTimeoutMs });
  if (!ready) {
    await killPid(child.pid);
    removePidFile(paths.pid);
    log.warn?.('[rauhwpx] detached agent hub did not become ready');
    return { started: true, ready: false, pid: child.pid, log: paths.log };
  }
  return { started: true, ready: true, pid: child.pid, log: paths.log };
}

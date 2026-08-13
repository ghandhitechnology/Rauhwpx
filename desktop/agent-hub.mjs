/**
 * Local rhwp-agent hub lifecycle helpers used by the Electron shell.
 *
 * The renderer can only talk WebSocket; this module decides whether a hub is
 * already healthy and how to launch one. Launch matches `npm start` in
 * rhwp-agent when npm is on PATH (including Homebrew/nvm locations GUI apps
 * otherwise miss). Packaged builds fall back to Electron-as-Node.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_HUB_PORT = 5175;
export const DEFAULT_HEALTH_TIMEOUT_MS = 500;
export const DEFAULT_READY_TIMEOUT_MS = 8000;
export const DEFAULT_POLL_INTERVAL_MS = 150;
export const HUB_RESTART_DELAYS_MS = [500, 1000, 2000, 5000];

export function hubHealthUrl(port) {
  return `http://127.0.0.1:${port}/healthz`;
}

export function nextHubRestartDelay(attempt, delays = HUB_RESTART_DELAYS_MS) {
  const index = Math.min(Math.max(0, attempt), delays.length - 1);
  return delays[index];
}

export async function isHubHealthy(port, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetchImpl(hubHealthUrl(port), { signal: ac.signal });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
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
  processAlive = false,
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

  const ready = await wait(port, { fetchImpl, isHealthy, timeoutMs: readyTimeoutMs });
  if (!ready) log.warn?.('[rauhwpx] agent hub did not become ready');
  return { started, ready };
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

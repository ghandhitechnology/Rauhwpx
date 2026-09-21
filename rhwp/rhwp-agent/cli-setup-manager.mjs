import { existsSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { applyManagedCliLaunch, createNodeHost } from './npm-cli-launch.mjs';
import { bundledNpmLaunch } from './npm-runtime.mjs';
import { API_KEY_MAX_BYTES, AUTH_CODE_MAX_BYTES, textFitsByteLimit } from './input-bounds.mjs';
import { redactDiagnosticText } from './agents/backend.mjs';

const require = createRequire(import.meta.url);
let crossSpawn = null;
function spawn(command, args, options) { crossSpawn ??= require('cross-spawn'); return crossSpawn(command, args, options); }
const CONFIG = Object.freeze({
  claude: { package: '@anthropic-ai/claude-code', bin: 'claude', keyEnv: 'ANTHROPIC_API_KEY' },
  codex: { package: '@openai/codex', bin: 'codex', keyEnv: 'OPENAI_API_KEY' },
});
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_TIMEOUT_MS = 10_000;

export function defaultCliSetupRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  if (env.RHWP_CLI_DIR) return pathImpl.resolve(env.RHWP_CLI_DIR);
  if (platform === 'darwin') return pathImpl.join(home, 'Library', 'Application Support', 'rhwp', 'cli');
  if (platform === 'win32') return pathImpl.join(env.APPDATA || pathImpl.join(home, 'AppData', 'Roaming'), 'rhwp', 'cli');
  return pathImpl.join(env.XDG_DATA_HOME || pathImpl.join(home, '.local', 'share'), 'rhwp', 'cli');
}
function setupError(code, message) { const error = new Error(message); error.code = code; return error; }
function keyTail(value) { const text = String(value ?? '').trim(); return text ? text.slice(-4) : null; }
function cleanOutput(value) { return redactDiagnosticText(String(value ?? '')).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim().slice(-1600); }

/** Create the app-managed Claude/Codex CLI setup service. */
export function createCliSetupManager({ rootDir = defaultCliSetupRoot(), spawnProcess = spawn, npmCommand = null, nodeCommand = process.execPath, platform = process.platform, baseEnv = process.env, secretStore = null } = {}) {
  const prefixDir = path.join(rootDir, 'prefix');
  const binDir = path.join(prefixDir, 'node_modules', '.bin');
  const configPath = path.join(rootDir, 'config.json');
  const npmLaunch = bundledNpmLaunch({ nodeCommand, npmCommand });
  const ensureNodeHost = createNodeHost({ rootDir, nodeCommand, platform });
  const apiKeys = { claude: null, codex: null };
  const authProcesses = new Map();
  let nodeHostShimDir = null;
  let loaded = false;
  function assertAgent(agent) { if (!Object.hasOwn(CONFIG, agent)) throw setupError('AGENT_SETUP_INVALID', `지원하지 않는 에이전트예요: ${agent}`); return CONFIG[agent]; }
  function binPath(agent) { const item = assertAgent(agent); return path.join(binDir, platform === 'win32' ? `${item.bin}.cmd` : item.bin); }
  function envFor(agent) { const item = assertAgent(agent); const env = { ...baseEnv }; delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; if (apiKeys[agent]) env[item.keyEnv] = apiKeys[agent]; return env; }
  async function load() {
    if (loaded) return; loaded = true;
    try { const raw = JSON.parse(await fs.readFile(configPath, 'utf8')); for (const agent of Object.keys(CONFIG)) { const key = raw?.[agent]?.key; if (typeof key === 'string' && textFitsByteLimit(key, API_KEY_MAX_BYTES)) apiKeys[agent] = key.trim() || null; } } catch {}
    if (secretStore?.available) for (const agent of Object.keys(CONFIG)) { try { const value = await secretStore.get(`rhwp.${agent}.api-key`); if (typeof value === 'string' && textFitsByteLimit(value, API_KEY_MAX_BYTES)) apiKeys[agent] = value.trim() || null; } catch {} }
  }
  async function persist() { await fs.mkdir(rootDir, { recursive: true, mode: 0o700 }); await fs.writeFile(configPath, `${JSON.stringify(Object.fromEntries(Object.keys(CONFIG).map((agent) => [agent, { key: apiKeys[agent] }])), null, 2)}\n`, { mode: 0o600 }); }
  async function run(command, args, options = {}) {
    const child = spawnProcess(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? baseEnv }); let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); }); child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    return await new Promise((resolve) => { const timer = setTimeout(() => { child.kill?.(); resolve({ code: null, stdout, stderr: `${stderr}\ntimeout` }); }, options.timeoutMs ?? STATUS_TIMEOUT_MS); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); }); });
  }
  async function status(agent) {
    assertAgent(agent); await load(); const bin = binPath(agent); let version = null;
    if (existsSync(bin)) { const result = await run(bin, ['--version'], { env: envFor(agent) }); if (result.code === 0) version = cleanOutput(result.stdout).split(/\s+/)[0] || null; }
    return { installed: Boolean(version || existsSync(bin)), installing: false, version, authenticated: Boolean(apiKeys[agent]), authMethod: apiKeys[agent] ? 'api-key' : null, keyTail: keyTail(apiKeys[agent]), latestVersion: null, updateRequired: false, error: null };
  }
  async function install(agent, onProgress) {
    const item = assertAgent(agent); await load(); onProgress?.({ state: 'installing', phase: 'install', activity: true }); await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const result = await run(npmLaunch.command, [...npmLaunch.args, 'install', '--prefix', prefixDir, `${item.package}@latest`], { env: baseEnv, timeoutMs: INSTALL_TIMEOUT_MS });
    if (result.code !== 0) throw setupError('AGENT_INSTALL_FAILED', cleanOutput(result.stderr || result.stdout) || 'CLI 설치에 실패했어요.'); onProgress?.({ state: 'done' }); return status(agent);
  }
  async function authenticate(agent, method, key, onProgress, { signal, onCommitted, terminal = false } = {}) {
    assertAgent(agent); await load();
    if (method === 'api-key') { if (typeof key !== 'string' || !textFitsByteLimit(key, API_KEY_MAX_BYTES) || !key.trim()) throw setupError('AGENT_KEY_INVALID', 'API 키를 입력해 주세요.'); apiKeys[agent] = key.trim(); if (secretStore?.available) await secretStore.set(`rhwp.${agent}.api-key`, apiKeys[agent]); await persist(); onCommitted?.(); onProgress?.({ state: 'done' }); return status(agent); }
    if (!['oauth', 'login'].includes(method)) throw setupError('AGENT_AUTH_INVALID', '지원하지 않는 로그인 방식이에요.');
    const proc = spawnProcess(binPath(agent), ['login'], { env: envFor(agent), cwd: rootDir, stdio: terminal ? 'pipe' : ['ignore', 'pipe', 'pipe'] }); authProcesses.set(agent, proc); onProgress?.({ state: 'authorizing', activity: true });
    await new Promise((resolve, reject) => { const abort = () => { proc.kill?.(); reject(setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.')); }; signal?.addEventListener('abort', abort, { once: true }); proc.once('close', (code) => { signal?.removeEventListener('abort', abort); code === 0 ? resolve() : reject(setupError('AGENT_AUTH_FAILED', 'CLI 로그인을 완료하지 못했어요.')); }); });
    authProcesses.delete(agent); onProgress?.({ state: 'done' }); return status(agent);
  }
  return {
    rootDir, prefixDir, binDir, codexOAuthStagingDir: path.join(rootDir, 'codex-oauth-staging'), claudeOAuthStagingDir: path.join(rootDir, 'claude-oauth-staging'), binPath, envFor,
    nodeHostDir: () => nodeHostShimDir,
    async init() { await fs.mkdir(rootDir, { recursive: true, mode: 0o700 }); nodeHostShimDir = await ensureNodeHost().catch(() => null); await load(); return this; },
    status, install, authenticate,
    submitAuthCode(agent, code) { assertAgent(agent); if (typeof code !== 'string' || Buffer.byteLength(code) > AUTH_CODE_MAX_BYTES) throw setupError('AGENT_AUTH_CODE_INVALID', '인증 코드가 올바르지 않아요.'); authProcesses.get(agent)?.stdin?.write?.(`${code.trim()}\n`); },
    terminalSnapshot() { return null; }, terminalInput(agent, data) { authProcesses.get(agent)?.stdin?.write?.(String(data ?? '')); }, terminalResize() {},
    async cancel(agent) { const proc = authProcesses.get(agent); if (!proc) return false; proc.kill?.(); authProcesses.delete(agent); return true; },
    async automaticUpdate(agent) { return status(agent); },
  };
}

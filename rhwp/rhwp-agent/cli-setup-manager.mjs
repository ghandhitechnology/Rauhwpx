import { existsSync, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { applyManagedCliLaunch, createNodeHost } from './npm-cli-launch.mjs';
import { bundledNpmLaunch } from './npm-runtime.mjs';
import { API_KEY_MAX_BYTES, AUTH_CODE_MAX_BYTES, textFitsByteLimit } from './input-bounds.mjs';
import { redactDiagnosticText } from './agents/backend.mjs';
import {
  claudeCredentialExpiry,
  parseClaudeOAuthCredential,
  readClaudeCredentialFile,
  readClaudeKeychainCredential,
  readClaudeOAuthCredential,
  writeClaudeCredentialFile,
} from './claude-credentials.mjs';
import { cleanupStaleOAuthCredentialStaging, prepareStagedOAuthCredential } from './oauth-credential-transaction.mjs';
import { createSetupTerminal } from './setup-terminal.mjs';
import { replaceFileAtomically } from './harness-update.mjs';

const require = createRequire(import.meta.url);
let crossSpawn = null;
function spawn(command, args, options) { crossSpawn ??= require('cross-spawn'); return crossSpawn(command, args, options); }
const CONFIG = Object.freeze({
  claude: { package: '@anthropic-ai/claude-code', bin: 'claude', keyEnv: 'ANTHROPIC_API_KEY' },
  codex: { package: '@openai/codex', bin: 'codex', keyEnv: 'OPENAI_API_KEY' },
});
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

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
export function createCliSetupManager({ rootDir = defaultCliSetupRoot(), spawnProcess = spawn, createTerminal = createSetupTerminal, npmCommand = null, nodeCommand = process.execPath, platform = process.platform, baseEnv = process.env, homeDir = os.homedir(), secretStore = null, prepareOAuthCredential = prepareStagedOAuthCredential, readClaudeKeychain = readClaudeKeychainCredential } = {}) {
  const prefixDir = path.join(rootDir, 'prefix');
  const binDir = path.join(prefixDir, 'node_modules', '.bin');
  const configPath = path.join(rootDir, 'config.json');
  const secretsPath = path.join(rootDir, 'secrets.json');
  const platformPath = platform === 'win32' ? path.win32 : path;
  const hostProfileHome = platform === 'win32'
    ? platformPath.resolve(baseEnv.USERPROFILE || homeDir)
    : platformPath.resolve(homeDir);
  const claudeConfigDir = typeof baseEnv.CLAUDE_CONFIG_DIR === 'string' && baseEnv.CLAUDE_CONFIG_DIR.trim()
    ? platformPath.resolve(baseEnv.CLAUDE_CONFIG_DIR)
    : platformPath.join(hostProfileHome, '.claude');
  const claudeCredentialFile = platformPath.join(claudeConfigDir, '.credentials.json');
  const claudeOAuthStagingDir = path.join(rootDir, 'claude-oauth-staging');
  const npmLaunch = bundledNpmLaunch({ nodeCommand, npmCommand });
  const ensureNodeHost = createNodeHost({ rootDir, nodeCommand, platform });
  const apiKeys = { claude: null, codex: null };
  const authProcesses = new Map();
  const authTerminals = new Map();
  let nodeHostShimDir = null;
  let loaded = false;
  async function writePrivateJson(file, value) {
    const temp = `${file}.new-${randomUUID()}`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await replaceFileAtomically(temp, file, { platform });
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
  function assertAgent(agent) { if (!Object.hasOwn(CONFIG, agent)) throw setupError('AGENT_SETUP_INVALID', `지원하지 않는 에이전트예요: ${agent}`); return CONFIG[agent]; }
  function binPath(agent) { const item = assertAgent(agent); return path.join(binDir, platform === 'win32' ? `${item.bin}.cmd` : item.bin); }
  function envFor(agent) { const item = assertAgent(agent); const env = { ...baseEnv }; delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; if (apiKeys[agent]) env[item.keyEnv] = apiKeys[agent]; return env; }
  async function load() {
    if (loaded) return; loaded = true;
    let needsMigration = false;
    try { const raw = JSON.parse(await fs.readFile(configPath, 'utf8')); for (const agent of Object.keys(CONFIG)) { const key = raw?.[agent]?.key; if (typeof key === 'string' && textFitsByteLimit(key, API_KEY_MAX_BYTES)) { apiKeys[agent] = key.trim() || null; needsMigration = needsMigration || Boolean(apiKeys[agent]); } } } catch {}
    if (secretStore?.available) {
      for (const agent of Object.keys(CONFIG)) { try { const value = await secretStore.get(`rhwp.${agent}.api-key`); if (typeof value === 'string' && textFitsByteLimit(value, API_KEY_MAX_BYTES)) apiKeys[agent] = value.trim() || null; } catch {} }
    } else {
      try { const raw = JSON.parse(await fs.readFile(secretsPath, 'utf8')); for (const agent of Object.keys(CONFIG)) { const value = raw?.[`rhwp.${agent}.api-key`]; if (typeof value === 'string' && textFitsByteLimit(value, API_KEY_MAX_BYTES)) apiKeys[agent] = value.trim() || null; } } catch {}
    }
    if (needsMigration) await persist();
  }
  async function persist() {
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const config = Object.fromEntries(Object.keys(CONFIG).map((agent) => [agent, { authMethod: apiKeys[agent] ? 'api-key' : null, keyTail: keyTail(apiKeys[agent]) }]));
    if (secretStore?.available) {
      for (const agent of Object.keys(CONFIG)) if (apiKeys[agent]) await secretStore.set(`rhwp.${agent}.api-key`, apiKeys[agent]);
    } else {
      const secrets = Object.fromEntries(Object.keys(CONFIG).filter((agent) => apiKeys[agent]).map((agent) => [`rhwp.${agent}.api-key`, apiKeys[agent]]));
      await writePrivateJson(secretsPath, secrets);
    }
    await writePrivateJson(configPath, config);
  }
  async function run(command, args, options = {}) {
    const child = spawnProcess(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? baseEnv }); let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); }); child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    return await new Promise((resolve) => { const timer = setTimeout(() => { child.kill?.(); resolve({ code: null, stdout, stderr: `${stderr}\ntimeout` }); }, options.timeoutMs ?? STATUS_TIMEOUT_MS); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); }); });
  }
  async function status(agent) {
    assertAgent(agent); await load(); const bin = binPath(agent); let version = null;
    if (existsSync(bin)) { const result = await run(bin, ['--version'], { env: envFor(agent) }); if (result.code === 0) version = cleanOutput(result.stdout).split(/\s+/)[0] || null; }
    let authenticated = Boolean(apiKeys[agent]);
    let authMethod = authenticated ? 'api-key' : null;
    if (agent === 'claude' && !authenticated) {
      const credential = await readClaudeOAuthCredential({
        homeDir: hostProfileHome,
        env: baseEnv,
        platform,
      }).catch(() => null);
      const parsed = credential ? parseClaudeOAuthCredential(credential.text) : null;
      const expired = claudeCredentialExpiry(parsed) > 0 && claudeCredentialExpiry(parsed) <= Date.now();
      authenticated = Boolean(parsed && !expired);
      authMethod = authenticated ? 'oauth' : null;
    }
    return { installed: Boolean(version || existsSync(bin)), installing: false, version, authenticated, authMethod, keyTail: keyTail(apiKeys[agent]), latestVersion: null, updateRequired: false, error: null };
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
    if (agent !== 'claude') {
      const argv = agent === 'codex' ? ['login', '--device-auth'] : ['login'];
      const proc = spawnProcess(binPath(agent), argv, { env: envFor(agent), cwd: rootDir, stdio: ['pipe', 'pipe', 'pipe'] }); authProcesses.set(agent, proc); onProgress?.({ state: 'authorizing', activity: true });
      await new Promise((resolve, reject) => { const abort = () => { proc.kill?.(); reject(setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.')); }; signal?.addEventListener('abort', abort, { once: true }); proc.once('close', (code) => { signal?.removeEventListener('abort', abort); code === 0 ? resolve() : reject(setupError('AGENT_AUTH_FAILED', 'CLI 로그인을 완료하지 못했어요.')); }); });
      authProcesses.delete(agent); onCommitted?.(); onProgress?.({ state: 'done' }); return status(agent);
    }

    const transaction = await prepareOAuthCredential({
      sourceFile: claudeCredentialFile,
      stagingParent: claudeOAuthStagingDir,
      relativeCredentialPath: '.credentials.json',
      platform,
    });
    const command = existsSync(binPath('claude')) ? binPath('claude') : 'claude';
    const loginEnv = {
      ...envFor('claude'),
      HOME: platform === 'darwin' ? hostProfileHome : transaction.homeDir,
      USERPROFILE: transaction.homeDir,
      CLAUDE_CONFIG_DIR: transaction.configDir,
      ...(platform === 'darwin' ? {} : { CLAUDE_SECURESTORAGE_CONFIG_DIR: transaction.configDir }),
    };
    let published = false;
    onProgress?.({ state: 'authorizing', activity: true });
    try {
      let result;
      if (terminal) {
        const session = createTerminal({
          command,
          argv: ['auth', 'login'],
          env: loginEnv,
          cwd: transaction.homeDir,
          signal,
          timeoutMs: AUTH_TIMEOUT_MS,
          onOutput: (data) => onProgress?.({ state: 'authorizing', terminalData: data }),
        });
        authTerminals.set(agent, session);
        onProgress?.({ state: 'authorizing', terminalReady: true });
        try { result = await session.done; } finally { authTerminals.delete(agent); }
      } else {
        let output = '';
        const proc = spawnProcess(command, ['auth', 'login'], { env: loginEnv, cwd: transaction.homeDir, stdio: ['pipe', 'pipe', 'pipe'] });
        authProcesses.set(agent, proc);
        const collect = (chunk) => {
          output = `${output}${String(chunk)}`.slice(-16_000);
          const clean = redactDiagnosticText(output);
          const authUrl = clean.match(/https?:\/\/[^\s<>"'\x07\]]+/)?.[0];
          onProgress?.({ state: 'authorizing', ...(authUrl ? { authUrl } : {}) });
        };
        proc.stdout?.on('data', collect); proc.stderr?.on('data', collect);
        result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { proc.kill?.(); reject(setupError('AGENT_AUTH_TIMEOUT', '로그인 시간이 만료됐어요. 다시 시도해 주세요.')); }, AUTH_TIMEOUT_MS);
          const abort = () => { proc.kill?.(); clearTimeout(timer); reject(setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.')); };
          signal?.addEventListener('abort', abort, { once: true });
          proc.once('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
          proc.once('close', (code, signalCode) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ code, signal: signalCode, stdout: output, stderr: output }); });
        });
        authProcesses.delete(agent);
      }
      if (result?.code !== 0) throw setupError('AGENT_AUTH_FAILED', 'Claude 로그인을 완료하지 못했어요. 브라우저 로그인을 끝낸 뒤 다시 시도해 주세요.');
      if (!await readClaudeCredentialFile(transaction.credentialFile)) {
        const harvested = platform === 'darwin'
          ? await readClaudeKeychain({ configDir: transaction.configDir, hasConfigDir: true, platform }).catch(() => null)
          : null;
        if (harvested) await writeClaudeCredentialFile(transaction.credentialFile, JSON.stringify(harvested));
      }
      if (!await readClaudeCredentialFile(transaction.credentialFile)) throw setupError('AGENT_AUTH_FAILED', 'Claude 로그인이 완료됐지만 인증 정보를 저장하지 못했어요. 다시 시도해 주세요.');
      await transaction.publish();
      published = true;
      apiKeys.claude = null;
      if (secretStore?.available) await secretStore.delete?.('rhwp.claude.api-key').catch?.(() => {});
      await persist();
      try { onCommitted?.(); } finally { transaction.markCommitted(); }
      await transaction.cleanup();
      onProgress?.({ state: 'done' });
      return status(agent);
    } catch (error) {
      if (!published) await transaction.rollback().catch(() => {});
      else await transaction.cleanup().catch(() => {});
      throw error;
    }
  }
  return {
    rootDir, prefixDir, binDir, codexOAuthStagingDir: path.join(rootDir, 'codex-oauth-staging'), claudeOAuthStagingDir, binPath, envFor,
    nodeHostDir: () => nodeHostShimDir,
    async init() { await fs.mkdir(rootDir, { recursive: true, mode: 0o700 }); await cleanupStaleOAuthCredentialStaging(claudeOAuthStagingDir).catch(() => {}); nodeHostShimDir = await ensureNodeHost().catch(() => null); await load(); return this; },
    status, install, authenticate,
    async submitAuthCode(agent, code) { assertAgent(agent); if (typeof code !== 'string' || Buffer.byteLength(code) > AUTH_CODE_MAX_BYTES) throw setupError('AGENT_AUTH_CODE_INVALID', '인증 코드가 올바르지 않아요.'); if (authTerminals.has(agent)) authTerminals.get(agent).write(`${code.trim()}\n`); else authProcesses.get(agent)?.stdin?.write?.(`${code.trim()}\n`); },
    terminalSnapshot(agent) { return authTerminals.get(agent)?.snapshot() ?? null; }, terminalInput(agent, data) { authTerminals.get(agent)?.write(String(data ?? '')); }, terminalResize(agent, cols, rows) { authTerminals.get(agent)?.resize(cols, rows); },
    async cancel(agent) { const terminal = authTerminals.get(agent); if (terminal) return terminal.cancel().catch(() => false); const proc = authProcesses.get(agent); if (!proc) return false; proc.kill?.(); authProcesses.delete(agent); return true; },
    async automaticUpdate(agent) { return status(agent); },
  };
}

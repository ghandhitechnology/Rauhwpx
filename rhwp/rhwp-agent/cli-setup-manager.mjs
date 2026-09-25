import { existsSync, promises as fs, readFileSync } from 'node:fs';
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
import { fetchLatestPackage, replaceFileAtomically } from './harness-update.mjs';

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

/** 앱에 번들된 Agent SDK 가 쓰는 Claude Code 버전. 관리형 CLI 가 없을 때 실제로 실행되는 런타임이다. */
export function bundledClaudeCodeVersion(resolve = (id) => require.resolve(id)) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8'));
    return typeof manifest.claudeCodeVersion === 'string' ? manifest.claudeCodeVersion : null;
  } catch { return null; }
}

/** `candidate` 가 `current` 보다 새 버전이면 true. 프리릴리스 꼬리표는 비교하지 않는다. */
export function isNewerVersion(candidate, current) {
  const parts = (value) => String(value ?? '').replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate); const b = parts(current);
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

/** Create the app-managed Claude/Codex CLI setup service. */
export function createCliSetupManager({ rootDir = defaultCliSetupRoot(), spawnProcess = spawn, createTerminal = createSetupTerminal, npmCommand = null, nodeCommand = process.execPath, platform = process.platform, baseEnv = process.env, homeDir = os.homedir(), secretStore = null, prepareOAuthCredential = prepareStagedOAuthCredential, readClaudeKeychain = readClaudeKeychainCredential, fetchImpl = globalThis.fetch, bundledClaudeVersion = bundledClaudeCodeVersion() } = {}) {
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
  const latestVersions = { claude: null, codex: null };
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
  /** `codex login` 이 남긴 auth.json 을 확인한다. 허브도 같은 파일을 세션에 연결해 쓴다. */
  async function readCodexLogin() {
    const codexHome = typeof baseEnv.CODEX_HOME === 'string' && baseEnv.CODEX_HOME.trim()
      ? platformPath.resolve(baseEnv.CODEX_HOME)
      : platformPath.join(hostProfileHome, '.codex');
    try {
      const auth = JSON.parse(await fs.readFile(platformPath.join(codexHome, 'auth.json'), 'utf8'));
      return Boolean(auth?.tokens?.refresh_token || auth?.tokens?.access_token || auth?.OPENAI_API_KEY);
    } catch { return false; }
  }
  async function status(agent) {
    assertAgent(agent); await load(); const bin = binPath(agent); let version = null;
    if (existsSync(bin)) { const result = await run(bin, ['--version'], { env: envFor(agent) }); if (result.code === 0) version = cleanOutput(result.stdout).split(/\s+/)[0] || null; }
    let authenticated = Boolean(apiKeys[agent]);
    let authMethod = authenticated ? 'api-key' : null;
    if (agent === 'codex' && !authenticated && await readCodexLogin()) {
      authenticated = true;
      authMethod = 'oauth';
    }
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
    // 관리형 CLI 가 없으면 Claude 는 SDK 번들 런타임으로 실행되므로 그 버전을 기준으로 삼는다.
    const runtimeVersion = version ?? (agent === 'claude' ? bundledClaudeVersion : null);
    const latestVersion = latestVersions[agent];
    const updateRequired = Boolean(runtimeVersion && latestVersion && isNewerVersion(latestVersion, runtimeVersion));
    return { installed: Boolean(version || existsSync(bin)), installing: false, version: runtimeVersion, authenticated, authMethod, keyTail: keyTail(apiKeys[agent]), latestVersion, updateRequired, error: null };
  }
  async function install(agent, onProgress) {
    const item = assertAgent(agent); await load(); onProgress?.({ state: 'installing', phase: 'install', activity: true }); await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const result = await run(npmLaunch.command, [...npmLaunch.leadingArgs, 'install', '--prefix', prefixDir, `${item.package}@latest`], { env: baseEnv, timeoutMs: INSTALL_TIMEOUT_MS });
    if (result.code !== 0) throw setupError('AGENT_INSTALL_FAILED', cleanOutput(result.stderr || result.stdout) || 'CLI 설치에 실패했어요.'); onProgress?.({ state: 'done' }); return status(agent);
  }
  async function authenticate(agent, method, key, onProgress, { signal, onCommitted, terminal = false } = {}) {
    assertAgent(agent); await load();
    if (method === 'api-key') { if (typeof key !== 'string' || !textFitsByteLimit(key, API_KEY_MAX_BYTES) || !key.trim()) throw setupError('AGENT_KEY_INVALID', 'API 키를 입력해 주세요.'); apiKeys[agent] = key.trim(); if (secretStore?.available) await secretStore.set(`rhwp.${agent}.api-key`, apiKeys[agent]); await persist(); onCommitted?.(); onProgress?.({ state: 'done' }); return status(agent); }
    if (!['oauth', 'login'].includes(method)) throw setupError('AGENT_AUTH_INVALID', '지원하지 않는 로그인 방식이에요.');
    if (agent !== 'claude') {
      const argv = agent === 'codex' ? ['login', '--device-auth'] : ['login'];
      // 앱이 설치한 CLI 가 없으면 PATH 의 CLI 로 로그인한다. 없는 경로를 실행하면 아무 출력 없이 멈춘다.
      const command = existsSync(binPath(agent)) ? binPath(agent) : CONFIG[agent].bin;
      onProgress?.({ state: 'authorizing', activity: true });
      let code;
      if (terminal) {
        // Studio 는 로그인 터미널을 열고 출력만 기다리므로 CLI 출력(기기 코드·주소)을 그대로 넘긴다.
        const session = createTerminal({
          command,
          argv,
          env: envFor(agent),
          cwd: rootDir,
          signal,
          timeoutMs: AUTH_TIMEOUT_MS,
          onOutput: (data) => onProgress?.({ state: 'authorizing', terminalData: data }),
        });
        authTerminals.set(agent, session);
        onProgress?.({ state: 'authorizing', terminalReady: true });
        try { ({ code } = await session.done); } finally { if (authTerminals.get(agent) === session) authTerminals.delete(agent); }
      } else {
        const proc = spawnProcess(command, argv, { env: envFor(agent), cwd: rootDir, stdio: ['pipe', 'pipe', 'pipe'] }); authProcesses.set(agent, proc);
        let output = '';
        const collect = (chunk) => {
          output = `${output}${String(chunk)}`.slice(-16_000);
          const clean = redactDiagnosticText(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
          const authUrl = clean.match(/https?:\/\/[^\s<>"'\x07\]]+/)?.[0];
          const userCode = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0];
          onProgress?.({ state: 'authorizing', ...(authUrl ? { authUrl } : {}), ...(userCode ? { userCode } : {}) });
        };
        proc.stdout?.on('data', collect); proc.stderr?.on('data', collect);
        try {
          code = await new Promise((resolve, reject) => {
            const abort = () => { proc.kill?.(); reject(setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.')); };
            signal?.addEventListener('abort', abort, { once: true });
            proc.once('error', (error) => { signal?.removeEventListener('abort', abort); reject(setupError('AGENT_AUTH_FAILED', `${command} 을 실행하지 못했어요: ${error?.message ?? error}`)); });
            proc.once('close', (exitCode) => { signal?.removeEventListener('abort', abort); resolve(exitCode); });
          });
        } finally { if (authProcesses.get(agent) === proc) authProcesses.delete(agent); }
      }
      if (code !== 0) throw setupError('AGENT_AUTH_FAILED', 'CLI 로그인을 완료하지 못했어요.');
      onCommitted?.(); onProgress?.({ state: 'done' }); return status(agent);
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
        try { result = await session.done; } finally { if (authTerminals.get(agent) === session) authTerminals.delete(agent); }
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
    /** registry 최신 버전만 확인한다. 설치는 사용자가 업데이트를 누를 때 install() 로 진행한다. */
    async automaticUpdate(agent) {
      const item = assertAgent(agent);
      const current = await status(agent);
      if (!current.version) return current;
      try { latestVersions[agent] = (await fetchLatestPackage(fetchImpl, item.package)).version; } catch { return current; }
      return status(agent);
    },
  };
}

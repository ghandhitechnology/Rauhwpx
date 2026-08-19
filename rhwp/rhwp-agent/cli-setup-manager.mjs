import { existsSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { fetchLatestPackage, replaceFileAtomically, updatePrefixAtomically } from './harness-update.mjs';
import { bundledNpmLaunch } from './npm-runtime.mjs';
import {
  processTreeSpawnOptions,
  terminateProcessTree,
  waitForProcessTreeExit,
} from './process-tree.mjs';
import { setupFailureMessage } from './setup-errors.mjs';

const require = createRequire(import.meta.url);
let crossSpawn = null;

function spawn(command, argv, options) {
  crossSpawn ??= require('cross-spawn');
  return crossSpawn(command, argv, options);
}

/**
 * 앱이 관리하는 CLI 목록.
 * kind 'npm'  — 공용 prefix 에 npm 으로 설치·갱신한다.
 * kind 'script' — 공식 셸 설치 스크립트로 전용 홈에 설치한다 (cursor 는 npm 배포가
 * 없다; npm 의 cursor-agent 패키지는 무관한 이름 선점 패키지라 절대 설치하지 않는다).
 */
const CLI_CONFIG = {
  codex: {
    package: '@openai/codex', bin: 'codex', kind: 'npm',
    secretId: 'rhwp.codex.api-key', keyEnv: 'OPENAI_API_KEY',
  },
  claude: {
    package: '@anthropic-ai/claude-code', bin: 'claude', kind: 'npm',
    secretId: 'rhwp.claude.api-key', keyEnv: 'ANTHROPIC_API_KEY',
  },
  grok: {
    package: '@xai-official/grok', bin: 'grok', kind: 'npm',
    secretId: 'rhwp.grok.api-key', keyEnv: 'XAI_API_KEY',
  },
  cursor: {
    bin: 'cursor-agent', kind: 'script',
    secretId: 'rhwp.cursor.api-key', keyEnv: 'CURSOR_API_KEY',
  },
};
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_TIMEOUT_MS = 10_000;
const REGISTRY_TIMEOUT_MS = 10_000;
const PROGRESS_INTERVAL_MS = 160;
const CURSOR_MODELS_TIMEOUT_MS = 15_000;
const CURSOR_MODELS_TTL_MS = 10 * 60 * 1000;
const CURSOR_INSTALL_COMMAND = 'curl -fsS https://cursor.com/install | bash';
const KEY_CHECK_TIMEOUT_MS = 10_000;
const KEY_INVALID_MESSAGE = 'API 키가 유효하지 않아요. 키를 확인해 주세요.';

/**
 * 기기 인증(device auth) 코드 한 줄. URL 줄은 통째로 비교하기 때문에 절대 걸리지 않는다.
 * 예: `ZRRX-M38IS`, `C879-V6G4`.
 */
const DEVICE_CODE_PATTERN = /^[A-Z0-9]{3,10}-[A-Z0-9]{3,10}$/;

/** API 키 검증용 모델 목록 엔드포인트 (cursor 는 CLI 로 확인한다). */
const KEY_CHECK_ENDPOINTS = {
  claude: {
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  codex: {
    url: 'https://api.openai.com/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  grok: {
    url: 'https://api.x.ai/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

function setupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stripTerminalEscapes(text) {
  return String(text ?? '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)?/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B./g, '');
}

function cleanTail(text) {
  return stripTerminalEscapes(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-5)
    .join(' / ')
    .slice(-1600);
}

/** 로그인 출력에서 마지막으로 나온 기기 인증 코드를 찾는다. 없으면 null. */
function findDeviceCode(text) {
  const raw = String(text ?? '');
  const lines = raw.split(/\r?\n/);
  // 청크 경계에서 잘린 미완성 줄은 다음 청크에서 다시 본다 — 잘린 코드를 내보내지 않는다.
  if (!/[\r\n]$/.test(raw)) lines.pop();
  const codes = lines
    .map((line) => line.trim())
    .filter((line) => DEVICE_CODE_PATTERN.test(line));
  return codes.at(-1) ?? null;
}

function keyTail(key) {
  const value = String(key ?? '').trim();
  return value ? value.slice(-4) : null;
}

/**
 * CLI stdout 에서 JSON 본문을 뽑는다. `cursor-agent status --format json` 은 한 줄이
 * 아니라 여러 줄로 들여쓴 JSON 을 내므로 첫 `{` 부터 마지막 `}` 까지를 통째로 판다.
 * 그래도 실패하면 NDJSON 을 가정해 줄 단위로 한 번 더 시도한다.
 */
function parseJsonOutput(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed);
    } catch {}
  }
  return null;
}

/** cursor --list-models 출력에서 모델 id 로 볼 수 없는 줄(안내문 등)을 거른다. */
function looksLikeCursorModelId(line) {
  return line.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._/[\]=,-]*$/.test(line);
}

export function defaultCliSetupRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (env.RHWP_CLI_DIR) return platformPath.resolve(env.RHWP_CLI_DIR);
  if (platform === 'darwin') return platformPath.join(home, 'Library', 'Application Support', 'rhwp', 'cli');
  if (platform === 'win32') {
    return platformPath.join(env.APPDATA || platformPath.join(home, 'AppData', 'Roaming'), 'rhwp', 'cli');
  }
  return platformPath.join(env.XDG_DATA_HOME || platformPath.join(home, '.local', 'share'), 'rhwp', 'cli');
}

/**
 * 설정 카드로 그대로 중계되는 진행 이벤트. install 은 phase/percent 계열을,
 * authenticate 는 로그인 URL 과 기기 코드를 채운다.
 *
 * @typedef {Object} SetupProgress
 * @property {'installing'|'authorizing'|'done'} state
 * @property {string} [phase]
 * @property {number} [percent]
 * @property {string} [detail]
 * @property {true} [activity] 진행률을 모르는 구간 — 카드가 무한 표시로 바꾼다.
 * @property {string} [authUrl] 사용자가 열어야 하는 로그인 URL.
 * @property {string} [userCode] 기기 인증 코드 — URL 과 함께 카드에 붙는다.
 */

/** App-managed CLI installers (Codex/Claude/Grok/Cursor) plus their local authentication state. */
export function createCliSetupManager({
  rootDir = defaultCliSetupRoot(),
  spawnProcess = spawn,
  npmCommand = null,
  nodeCommand = process.execPath,
  platform = process.platform,
  baseEnv = process.env,
  homeDir = os.homedir(),
  fetchImpl = globalThis.fetch,
  secretStore = null,
} = {}) {
  const prefixDir = path.join(rootDir, 'prefix');
  const configPath = path.join(rootDir, 'config.json');
  /** OS 보안 저장소가 없을 때 쓰는 대체 보관소 (0600). vault 가 생기면 이관 후 지운다. */
  const secretsPath = path.join(rootDir, 'secrets.json');
  const binDir = path.join(prefixDir, 'node_modules', '.bin');
  /** grok 관리형 로그인 홈 — `grok login` 이 auth.json 을 여기에 만든다. */
  const grokHomeDir = path.join(rootDir, 'grok');
  /** cursor 설치·로그인 전용 홈 — 설치 스크립트와 `cursor-agent login` 의 HOME. */
  const cursorHomeDir = path.join(rootDir, 'cursor-home');
  const cursorBinFile = path.join(cursorHomeDir, '.local', 'bin', 'cursor-agent');
  /** 세션 시딩용 영속 `.cursor` 디렉터리 (auth 토큰 등이 산다). */
  const cursorSourceDir = path.join(cursorHomeDir, '.cursor');
  const installs = new Map();
  const authRuns = new Map();
  /** 카드에서 취소한 로그인 — 실패 메시지 대신 취소로 보고한다. */
  const cancelledAuth = new Set();
  const activeProcesses = new Map();
  const updateInfo = new Map([
    ['claude', { latestVersion: null, updateRequired: false, error: null }],
    ['codex', { latestVersion: null, updateRequired: false, error: null }],
    ['grok', { latestVersion: null, updateRequired: false, error: null }],
    ['cursor', { latestVersion: null, updateRequired: false, error: null }],
  ]);
  const npmLaunch = bundledNpmLaunch({ nodeCommand, npmCommand });
  let updateChain = Promise.resolve();
  let loaded = false;
  /** 에이전트별 저장 API 키 (보안 저장소에서 로드). */
  const apiKeys = { claude: null, codex: null, grok: null, cursor: null };
  let cursorModelsCache = { models: [], fetchedAt: 0 };
  let cursorModelsInFlight = null;
  let secretStoreError = null;
  let config = {
    claudeAuthMethod: null,
    codexAuthMethod: null,
    codexKeyTail: null,
    grokAuthMethod: null,
    grokKeyTail: null,
    cursorAuthMethod: null,
    cursorKeyTail: null,
  };

  function assertAgent(agent) {
    const item = CLI_CONFIG[agent];
    if (!item) {
      throw setupError('AGENT_SETUP_INVALID', `지원하지 않는 에이전트예요: ${agent}`);
    }
    return item;
  }

  function binPath(agent) {
    const item = assertAgent(agent);
    if (item.kind === 'script') {
      // 관리형 설치본이 있으면 절대 경로, 없으면 PATH 의 시스템 설치본을 쓴다.
      return existsSync(cursorBinFile) ? cursorBinFile : item.bin;
    }
    return path.join(binDir, platform === 'win32' ? `${item.bin}.cmd` : item.bin);
  }

  function packageJsonPath(agent, basePrefix = prefixDir) {
    const item = assertAgent(agent);
    return path.join(basePrefix, 'node_modules', ...item.package.split('/'), 'package.json');
  }

  function readAuthMethod(raw, key) {
    return raw?.[key] === 'api-key' || raw?.[key] === 'oauth' ? raw[key] : null;
  }

  /** 파일 보관소를 읽는다. 없거나 깨졌으면 빈 객체. */
  async function readFileSecrets() {
    try {
      const raw = JSON.parse(await fs.readFile(secretsPath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return Object.fromEntries(
        Object.entries(raw).filter(([, value]) => typeof value === 'string' && value.trim()),
      );
    } catch {
      return {};
    }
  }

  /** config.json 과 같은 방식으로 원자적으로 바꿔 쓴다. 빈 보관소는 파일째 지운다. */
  async function writeFileSecrets(secrets) {
    const entries = Object.entries(secrets).filter(([, value]) => typeof value === 'string' && value.trim());
    if (entries.length === 0) {
      await fs.rm(secretsPath, { force: true }).catch(() => {});
      return;
    }
    await fs.mkdir(rootDir, { recursive: true });
    const temp = `${secretsPath}.tmp-${process.pid}-${Date.now()}`;
    const body = `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
    await fs.writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
    await replaceFileAtomically(temp, secretsPath, { platform });
  }

  /** vault 가 있으면 vault, 없으면 파일 보관소에 저장한다. */
  async function storeSecret(secretId, value) {
    if (secretStore?.available) {
      await secretStore.set(secretId, value);
      const secrets = await readFileSecrets();
      if (secretId in secrets) {
        delete secrets[secretId];
        await writeFileSecrets(secrets);
      }
      return;
    }
    const secrets = await readFileSecrets();
    secrets[secretId] = value;
    await writeFileSecrets(secrets);
  }

  /** 두 저장소 어디에 있든 지운다. */
  async function deleteSecret(secretId) {
    if (secretStore?.available) await secretStore.delete(secretId);
    const secrets = await readFileSecrets();
    if (!(secretId in secrets)) return;
    delete secrets[secretId];
    await writeFileSecrets(secrets);
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    let raw = {};
    try {
      raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch {}
    const legacyClaudeKey = typeof raw?.claudeApiKey === 'string' && raw.claudeApiKey.trim()
      ? raw.claudeApiKey.trim() : null;
    config.claudeAuthMethod = readAuthMethod(raw, 'claudeAuthMethod');
    config.codexAuthMethod = readAuthMethod(raw, 'codexAuthMethod');
    config.codexKeyTail = typeof raw?.codexKeyTail === 'string' ? raw.codexKeyTail : null;
    config.grokAuthMethod = readAuthMethod(raw, 'grokAuthMethod');
    config.grokKeyTail = typeof raw?.grokKeyTail === 'string' ? raw.grokKeyTail : null;
    config.cursorAuthMethod = readAuthMethod(raw, 'cursorAuthMethod');
    config.cursorKeyTail = typeof raw?.cursorKeyTail === 'string' ? raw.cursorKeyTail : null;
    const agents = Object.keys(CLI_CONFIG);
    const fileSecrets = await readFileSecrets();
    try {
      if (secretStore?.available) {
        const values = await Promise.all(agents.map((agent) => secretStore.get(CLI_CONFIG[agent].secretId)));
        agents.forEach((agent, index) => { apiKeys[agent] = values[index]; });
        // 파일에 남은 키는 vault 로 옮기고 파일에서 지운다 (legacy claudeApiKey 이관과 같은 규칙).
        let migrated = false;
        for (const agent of agents) {
          const secretId = CLI_CONFIG[agent].secretId;
          const stored = fileSecrets[secretId]?.trim();
          if (!stored) continue;
          if (!apiKeys[agent]) {
            await secretStore.set(secretId, stored);
            apiKeys[agent] = await secretStore.get(secretId);
            // 이관이 확인되지 않으면 파일 사본을 남겨 둔다.
            if (apiKeys[agent] !== stored) continue;
          }
          delete fileSecrets[secretId];
          migrated = true;
        }
        if (migrated) await writeFileSecrets(fileSecrets);
        if (!apiKeys.claude && legacyClaudeKey) {
          await secretStore.set(CLI_CONFIG.claude.secretId, legacyClaudeKey);
          apiKeys.claude = await secretStore.get(CLI_CONFIG.claude.secretId);
          if (apiKeys.claude === legacyClaudeKey) await persist();
        }
      } else {
        for (const agent of agents) apiKeys[agent] = fileSecrets[CLI_CONFIG[agent].secretId] ?? null;
        // Keep a legacy key usable until the desktop vault is available; never write it back.
        apiKeys.claude ??= legacyClaudeKey;
      }
    } catch (error) {
      for (const agent of agents) apiKeys[agent] ??= fileSecrets[CLI_CONFIG[agent].secretId] ?? null;
      apiKeys.claude ??= legacyClaudeKey;
      secretStoreError = error?.message ?? 'OS 보안 저장소를 열지 못했어요.';
    }
  }

  async function persist() {
    await fs.mkdir(rootDir, { recursive: true });
    const temp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await replaceFileAtomically(temp, configPath, { platform });
  }

  /** 관리형 cursor 설치본 버전 — 실측 부작용을 막으려 CONFIG_DIR/HOME 을 전용 경로로 돌린다. */
  async function cursorInstalledVersion() {
    if (!existsSync(cursorBinFile)) return null;
    try {
      const result = await run(cursorBinFile, ['--version'], {
        timeoutMs: STATUS_TIMEOUT_MS,
        env: {
          ...baseEnv,
          HOME: cursorHomeDir,
          CURSOR_CONFIG_DIR: path.join(cursorHomeDir, '.cursor-probe'),
        },
      });
      if (result.code !== 0) return null;
      return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
    } catch {
      return null;
    }
  }

  async function installedVersion(agent, basePrefix = prefixDir) {
    if (assertAgent(agent).kind === 'script') return cursorInstalledVersion();
    try {
      const raw = JSON.parse(await fs.readFile(packageJsonPath(agent, basePrefix), 'utf8'));
      return typeof raw?.version === 'string' ? raw.version : null;
    } catch {
      return null;
    }
  }

  function envFor(agent) {
    const item = assertAgent(agent);
    const env = { ...baseEnv, PATH: `${binDir}${path.delimiter}${baseEnv.PATH ?? ''}` };
    if (item.keyEnv && apiKeys[agent]) env[item.keyEnv] = apiKeys[agent];
    return env;
  }

  function run(command, argv, {
    input = null, timeoutMs = STATUS_TIMEOUT_MS, env = baseEnv, onOutput, operationKey = null,
    keepStdinOpen = false,
  } = {}) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer = null;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (operationKey && activeProcesses.get(operationKey) === proc) activeProcesses.delete(operationKey);
        if (error) reject(error);
        else resolve(result);
      };
      let proc;
      try {
        proc = spawnProcess(command, argv, {
          ...processTreeSpawnOptions(platform),
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        finish(error);
        return;
      }
      if (operationKey) activeProcesses.set(operationKey, proc);
      timer = setTimeout(() => {
        terminateProcessTree(proc, { platform, spawnProcess });
        void waitForProcessTreeExit(proc).finally(() => {
          finish(setupError('AGENT_SETUP_TIMEOUT', '설정 작업이 제한 시간 안에 끝나지 않았어요.'));
        });
      }, timeoutMs);
      timer.unref?.();
      const collect = (target, chunk) => {
        const text = chunk.toString();
        if (target === 'stdout') stdout += text;
        else stderr += text;
        if (typeof onOutput === 'function') onOutput(text);
      };
      proc.stdout?.on?.('data', (chunk) => collect('stdout', chunk));
      proc.stderr?.on?.('data', (chunk) => collect('stderr', chunk));
      proc.on('error', (error) => finish(error));
      proc.on('close', (code, signal) => finish(null, { code, signal, stdout, stderr }));
      if (input !== null) proc.stdin?.end(input);
      else if (!keepStdinOpen) proc.stdin?.end();
    });
  }

  /**
   * grok 세션 토큰 파일의 실제 위치. 우선순위: 프로세스 GROK_HOME → ~/.grok →
   * 관리형 홈. 심볼릭 링크 원본은 세션 시딩에 안전하지 않아 건너뛴다.
   */
  async function grokAuthPath() {
    const candidates = [
      baseEnv.GROK_HOME ? path.join(baseEnv.GROK_HOME, 'auth.json') : null,
      path.join(homeDir, '.grok', 'auth.json'),
      path.join(grokHomeDir, 'auth.json'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
      } catch {}
    }
    return null;
  }

  async function authState(agent) {
    await load();
    const item = assertAgent(agent);
    if (apiKeys[agent]) {
      return { authenticated: true, authMethod: 'api-key', keyTail: keyTail(apiKeys[agent]) };
    }
    if (agent === 'grok') {
      // grok 에는 상태 확인 서브커맨드가 없다 — auth.json 존재로 판단한다 (스폰 없음).
      const authenticated = Boolean(await grokAuthPath());
      return {
        authenticated,
        authMethod: authenticated ? (config.grokAuthMethod ?? 'oauth') : null,
        keyTail: null,
      };
    }
    if (agent === 'cursor') {
      try {
        // 종료 코드는 로그아웃 상태에서도 0 이다 — JSON 본문만 믿는다.
        const result = await run(binPath('cursor'), ['status', '--format', 'json'], {
          env: { ...envFor('cursor'), HOME: cursorHomeDir },
        });
        const parsed = parseJsonOutput(result.stdout);
        const authenticated = typeof parsed?.isAuthenticated === 'boolean' ? parsed.isAuthenticated : false;
        return {
          authenticated,
          authMethod: authenticated ? (config.cursorAuthMethod ?? 'oauth') : null,
          keyTail: null,
        };
      } catch {
        return { authenticated: false, authMethod: null, keyTail: null };
      }
    }
    const version = await installedVersion(agent);
    const command = version ? binPath(agent) : item.bin;
    try {
      const argv = agent === 'codex' ? ['login', 'status'] : ['auth', 'status'];
      const result = await run(command, argv, { env: envFor(agent) });
      return {
        authenticated: result.code === 0,
        authMethod: result.code === 0
          ? (agent === 'codex' ? config.codexAuthMethod : config.claudeAuthMethod) ?? 'oauth'
          : null,
        keyTail: result.code === 0 && agent === 'codex' && config.codexAuthMethod === 'api-key'
          ? config.codexKeyTail
          : null,
      };
    } catch {
      return { authenticated: false, authMethod: null, keyTail: null };
    }
  }

  async function status(agent) {
    assertAgent(agent);
    await load();
    const version = await installedVersion(agent);
    const auth = await authState(agent);
    const update = updateInfo.get(agent);
    return {
      agent,
      installed: Boolean(version),
      installing: installs.has(agent),
      version,
      ...auth,
      authenticating: authRuns.has(agent),
      setupComplete: Boolean(version) && auth.authenticated,
      latestVersion: update?.latestVersion ?? null,
      updateRequired: update?.updateRequired === true,
      error: update?.error ?? secretStoreError,
    };
  }

  function makeInstallProgress(onProgress) {
    const state = { percent: 0 };
    const emit = (phase, nextPercent, detail, activity = false) => {
      state.percent = Math.max(state.percent, Math.min(100, nextPercent));
      onProgress?.({
        state: phase === 'done' ? 'done' : 'installing',
        phase,
        percent: state.percent,
        ...(detail ? { detail } : {}),
        ...(activity ? { activity: true } : {}),
      });
    };
    return { emit, state };
  }

  async function runNpmInstall(agent, item, onProgress) {
    let lastActivity = 0;
    const { emit, state } = makeInstallProgress(onProgress);
    await load();
    emit('preparing', 8, `${item.bin} CLI 설치 준비 중`);
    await fs.mkdir(prefixDir, { recursive: true });
    emit('resolving', 20, `${item.bin} 패키지 확인 중`);
    emit('installing', 28, `${item.bin} CLI 설치 중`);
    const result = await run(
      npmLaunch.command,
      [...npmLaunch.leadingArgs, 'install', '--prefix', prefixDir, '--no-fund', '--no-audit', item.package],
      {
        timeoutMs: INSTALL_TIMEOUT_MS,
        operationKey: `install:${agent}`,
        onOutput: () => {
          const now = Date.now();
          if (now - lastActivity < PROGRESS_INTERVAL_MS) return;
          lastActivity = now;
          emit('installing', Math.min(84, state.percent + 1.5), `${item.bin} CLI 설치 중`, true);
        },
      },
    );
    if (result.code !== 0) {
      const detail = cleanTail(result.stderr || result.stdout);
      throw setupError(
        'AGENT_INSTALL_FAILED',
        setupFailureMessage(null, detail, `${item.bin} 설치가 실패했어요.`),
      );
    }
    emit('verifying', 92, `${item.bin} CLI 확인 중`);
    const version = await installedVersion(agent);
    if (!version) throw setupError('AGENT_INSTALL_FAILED', `${item.bin} 설치본을 확인하지 못했어요.`);
    const update = updateInfo.get(agent);
    if (update?.latestVersion === version) update.updateRequired = false;
    emit('done', 100, version);
    return status(agent);
  }

  async function runScriptInstall(agent, item, onProgress) {
    if (platform === 'win32') {
      throw setupError(
        'AGENT_INSTALL_FAILED',
        'Windows에서는 Cursor CLI 자동 설치를 지원하지 않아요. cursor.com/install 의 공식 설치 방법으로 설치한 뒤 다시 확인해 주세요.',
      );
    }
    let lastActivity = 0;
    const { emit, state } = makeInstallProgress(onProgress);
    await load();
    emit('preparing', 8, `${item.bin} CLI 설치 준비 중`);
    await fs.mkdir(cursorHomeDir, { recursive: true });
    emit('resolving', 20, `${item.bin} 설치 스크립트 확인 중`);
    emit('installing', 28, `${item.bin} CLI 설치 중`);
    const result = await run('/bin/bash', ['-c', CURSOR_INSTALL_COMMAND], {
      timeoutMs: INSTALL_TIMEOUT_MS,
      operationKey: `install:${agent}`,
      env: { ...baseEnv, HOME: cursorHomeDir },
      onOutput: () => {
        const now = Date.now();
        if (now - lastActivity < PROGRESS_INTERVAL_MS) return;
        lastActivity = now;
        emit('installing', Math.min(84, state.percent + 1.5), `${item.bin} CLI 설치 중`, true);
      },
    });
    if (result.code !== 0) {
      const detail = cleanTail(result.stderr || result.stdout);
      throw setupError(
        'AGENT_INSTALL_FAILED',
        setupFailureMessage(null, detail, `${item.bin} 설치가 실패했어요.`),
      );
    }
    emit('verifying', 92, `${item.bin} CLI 확인 중`);
    const version = await installedVersion(agent);
    if (!version) throw setupError('AGENT_INSTALL_FAILED', `${item.bin} 설치본을 확인하지 못했어요.`);
    emit('done', 100, version);
    return status(agent);
  }

  /**
   * @param {string} agent
   * @param {(progress: SetupProgress) => void} [onProgress]
   */
  async function install(agent, onProgress) {
    const item = assertAgent(agent);
    if (installs.has(agent)) return installs.get(agent);
    const running = item.kind === 'script'
      ? runScriptInstall(agent, item, onProgress)
      : runNpmInstall(agent, item, onProgress);
    installs.set(agent, running);
    try {
      return await running;
    } finally {
      if (installs.get(agent) === running) installs.delete(agent);
    }
  }

  /** cursor 자기 갱신 — 레지스트리 메타데이터가 없어 latestVersion/updateRequired 는 유지된다. */
  async function runCursorAutomaticUpdate(agent) {
    const update = updateInfo.get(agent);
    // 시스템 설치본만 있으면 손대지 않는다.
    if (!existsSync(cursorBinFile)) return status(agent);
    try {
      const result = await run(cursorBinFile, ['update'], {
        timeoutMs: INSTALL_TIMEOUT_MS,
        env: { ...baseEnv, HOME: cursorHomeDir },
      });
      if (result.code !== 0) {
        throw setupError('AGENT_UPDATE_FAILED', cleanTail(result.stderr || result.stdout) || 'cursor update failed');
      }
      update.error = null;
    } catch (error) {
      update.error = setupFailureMessage(error, '', '자동 업데이트를 완료하지 못했어요.');
    }
    return status(agent);
  }

  async function runAutomaticUpdate(agent, canActivate) {
    const item = assertAgent(agent);
    if (item.kind === 'script') return runCursorAutomaticUpdate(agent);
    const installed = await installedVersion(agent);
    if (!installed) return status(agent);
    const update = updateInfo.get(agent);

    let latest;
    try {
      latest = await fetchLatestPackage(fetchImpl, item.package, REGISTRY_TIMEOUT_MS);
    } catch (error) {
      update.error = setupFailureMessage(error, '', '최신 버전을 확인하지 못했어요.');
      return status(agent);
    }
    update.latestVersion = latest.version;
    update.updateRequired = latest.version !== installed;
    if (!update.updateRequired) return status(agent);

    try {
      await updatePrefixAtomically({
        prefixDir,
        label: agent,
        platform,
        canActivate,
        install: async (stagingDir) => {
          const result = await run(
            npmLaunch.command,
            [...npmLaunch.leadingArgs, 'install', '--prefix', stagingDir, '--no-fund', '--no-audit', `${item.package}@${latest.version}`],
            { timeoutMs: INSTALL_TIMEOUT_MS },
          );
          if (result.code !== 0) throw setupError('AGENT_UPDATE_FAILED', 'harness update failed');
        },
        verify: async (stagingDir) => {
          if (await installedVersion(agent, stagingDir) !== latest.version) {
            throw setupError('AGENT_UPDATE_FAILED', 'updated harness version did not verify');
          }
        },
      });
      update.updateRequired = false;
      update.error = null;
    } catch (error) {
      // 자동 갱신 실패는 작업을 끊지 않는다. 기존 prefix 를 유지하고 상태 카드로만 알린다.
      update.updateRequired = true;
      update.error = setupFailureMessage(error, '', '자동 업데이트를 완료하지 못했어요.');
    }
    return status(agent);
  }

  /**
   * cursor 는 공개 검증 엔드포인트가 없어 CLI 에 키를 물려 상태를 물어본다.
   * JSON 을 받지 못하면(미설치·오프라인) 판단을 보류하고 통과시킨다.
   */
  async function verifyCursorApiKey(value) {
    let result;
    try {
      // 로그인 세션이 남은 cursorHomeDir 로 물으면 키와 무관하게 인증됨으로 나온다 —
      // 검증 전용 빈 HOME 에서 키만으로 판정한다.
      const checkHome = path.join(cursorHomeDir, 'key-check');
      await fs.mkdir(checkHome, { recursive: true });
      result = await run(binPath('cursor'), ['status', '--format', 'json'], {
        timeoutMs: KEY_CHECK_TIMEOUT_MS,
        env: { ...envFor('cursor'), HOME: checkHome, CURSOR_API_KEY: value },
      });
    } catch {
      return;
    }
    const parsed = parseJsonOutput(result.stdout);
    if (!parsed) return;
    if (parsed.isAuthenticated !== true) throw setupError('AGENT_KEY_INVALID', KEY_INVALID_MESSAGE);
  }

  /**
   * 키를 저장하기 전에 실제로 통하는지 확인한다. 확실한 거절(401)만 오류로 보고,
   * 그 밖의 응답이나 네트워크 실패는 통과시킨다 — 권한이 좁은 프로젝트 키(403)와
   * 오프라인 환경을 막지 않는다.
   */
  async function verifyApiKey(agent, value) {
    if (agent === 'cursor') {
      await verifyCursorApiKey(value);
      return;
    }
    const endpoint = KEY_CHECK_ENDPOINTS[agent];
    if (!endpoint || typeof fetchImpl !== 'function') return;
    let response;
    try {
      response = await fetchImpl(endpoint.url, {
        method: 'GET',
        headers: endpoint.headers(value),
        signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
      });
    } catch {
      return;
    }
    if (response?.status === 401) {
      throw setupError('AGENT_KEY_INVALID', KEY_INVALID_MESSAGE);
    }
    // x.ai 는 잘못된 키에 400 을 준다 — 본문이 키 오류를 말할 때만 거절해 권한이
    // 좁은 프로젝트 키(403)의 다른 사유를 오판하지 않는다.
    if (response?.status === 400 || response?.status === 403) {
      let body = '';
      try {
        body = String(await response.text());
      } catch {}
      if (/api[-_ ]?key|authentication/i.test(body)) {
        throw setupError('AGENT_KEY_INVALID', KEY_INVALID_MESSAGE);
      }
    }
  }

  /**
   * @param {string} agent
   * @param {'api-key'|'oauth'} method
   * @param {string} [key] api-key 방식에서만 쓴다.
   * @param {(progress: SetupProgress) => void} [onProgress]
   */
  async function authenticate(agent, method, key, onProgress) {
    const item = assertAgent(agent);
    if (authRuns.has(agent)) throw setupError('AGENT_AUTH_BUSY', '이미 로그인 작업이 진행 중이에요.');
    const running = (async () => {
      await load();
      const managedVersion = await installedVersion(agent);
      const command = managedVersion ? binPath(agent) : item.bin;
      onProgress?.({ state: 'authorizing' });
      if (method === 'api-key') {
        const value = String(key ?? '').trim();
        if (!value) throw setupError('AGENT_KEY_INVALID', 'API 키를 입력해 주세요.');
        await verifyApiKey(agent, value);
        await storeSecret(item.secretId, value);
        apiKeys[agent] = value;
        secretStoreError = null;
        config[`${agent}AuthMethod`] = 'api-key';
        // claude 는 기존 설정 파일 스키마를 유지한다 — keyTail 을 저장하지 않는다.
        if (agent !== 'claude') config[`${agent}KeyTail`] = keyTail(value);
        await persist();
        onProgress?.({ state: 'done' });
        return status(agent);
      }
      if (method !== 'oauth') throw setupError('AGENT_AUTH_INVALID', '지원하지 않는 로그인 방식이에요.');
      await deleteSecret(item.secretId);
      apiKeys[agent] = null;
      if (agent === 'claude') await persist();
      const loginSpec = {
        // 기기 인증만 쓴다 — 기본 로그인은 허브 기기의 localhost 콜백 서버를 띄우기
        // 때문에 원격에서 스튜디오를 여는 사용자는 로그인을 끝낼 수 없다.
        codex: {
          argv: ['login', '--device-auth'],
          env: envFor('codex'),
          keepStdinOpen: false,
        },
        // claude 는 TTY 없이 실행되면 브라우저 로그인 뒤 인증 코드를 stdin 으로 받아야 끝난다.
        claude: { argv: ['auth', 'login'], env: envFor('claude'), keepStdinOpen: true },
        // grok 로그인은 관리형 GROK_HOME 에 auth.json 을 만든다.
        grok: { argv: ['login'], env: { ...envFor('grok'), GROK_HOME: grokHomeDir }, keepStdinOpen: false },
        // cursor 는 브라우저 왕복이 끝나면 프로세스가 스스로 종료된다.
        cursor: {
          argv: ['login'],
          env: { ...envFor('cursor'), HOME: cursorHomeDir, NO_OPEN_BROWSER: '1' },
          keepStdinOpen: false,
        },
      }[agent];
      if (agent === 'grok') await fs.mkdir(grokHomeDir, { recursive: true });
      if (agent === 'cursor') await fs.mkdir(cursorHomeDir, { recursive: true });
      let buffered = '';
      const result = await run(command, loginSpec.argv, {
        timeoutMs: AUTH_TIMEOUT_MS,
        operationKey: `auth:${agent}`,
        env: loginSpec.env,
        keepStdinOpen: loginSpec.keepStdinOpen,
        onOutput: (text) => {
          buffered = (buffered + text).slice(-8000);
          const clean = stripTerminalEscapes(buffered);
          const url = clean.match(/https?:\/\/[^\s<>"'\x07\]]+/)?.[0];
          const userCode = findDeviceCode(clean);
          onProgress?.({
            state: 'authorizing',
            ...(url ? { authUrl: url } : {}),
            ...(userCode ? { userCode } : {}),
          });
        },
      });
      if (result.code !== 0) {
        // 사용자가 카드에서 취소한 로그인은 실패가 아니다 — CLI 출력 꼬리를 보여주지 않는다.
        if (cancelledAuth.delete(agent)) {
          throw setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.');
        }
        const detail = cleanTail(result.stderr || result.stdout);
        throw setupError('AGENT_AUTH_FAILED', setupFailureMessage(null, detail, '로그인을 완료하지 못했어요.'));
      }
      config[`${agent}AuthMethod`] = 'oauth';
      if (agent !== 'claude') config[`${agent}KeyTail`] = null;
      await persist();
      onProgress?.({ state: 'done' });
      return status(agent);
    })();
    authRuns.set(agent, running);
    try {
      return await running;
    } finally {
      if (authRuns.get(agent) === running) authRuns.delete(agent);
    }
  }

  async function submitAuthCode(agent, code) {
    assertAgent(agent);
    const value = String(code ?? '').trim();
    if (!value) throw setupError('AGENT_AUTH_CODE_INVALID', '인증 코드를 입력해 주세요.');
    const proc = activeProcesses.get(`auth:${agent}`);
    if (!proc || !authRuns.has(agent)) {
      throw setupError('AGENT_AUTH_NOT_RUNNING', '진행 중인 로그인이 없어요. 브라우저 로그인부터 다시 시작해 주세요.');
    }
    proc.stdin?.write?.(`${value}\n`);
  }

  /**
   * `cursor-agent --list-models` 결과를 TTL 캐시와 함께 돌려준다. 인증 여부는
   * 호출자가 판단한다 — 미인증 상태의 실행은 빈 목록으로 끝난다.
   */
  async function cursorModels({ refresh = false } = {}) {
    const nowMs = Date.now();
    if (!refresh && cursorModelsCache.fetchedAt && nowMs - cursorModelsCache.fetchedAt < CURSOR_MODELS_TTL_MS) {
      return [...cursorModelsCache.models];
    }
    // 동시 요청은 진행 중인 조회 하나에 합류한다 — 스튜디오 탭이 여럿이어도 스폰은 한 번.
    if (cursorModelsInFlight) return cursorModelsInFlight;
    cursorModelsInFlight = fetchCursorModels(nowMs).finally(() => { cursorModelsInFlight = null; });
    return cursorModelsInFlight;
  }

  async function fetchCursorModels(nowMs) {
    // 실패도 TTL 에 기록한다 — 고장난 CLI 를 상태 집계마다 다시 스폰하지 않는다.
    const rememberFailure = () => {
      cursorModelsCache = { models: cursorModelsCache.models, fetchedAt: nowMs };
      return [...cursorModelsCache.models];
    };
    try {
      const result = await run(binPath('cursor'), ['--list-models'], {
        timeoutMs: CURSOR_MODELS_TIMEOUT_MS,
        env: { ...envFor('cursor'), HOME: cursorHomeDir },
      });
      if (result.code !== 0) return rememberFailure();
      const models = [...new Set(
        result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && looksLikeCursorModelId(line)),
      )];
      cursorModelsCache = { models, fetchedAt: nowMs };
      return [...models];
    } catch {
      return rememberFailure();
    }
  }

  return {
    rootDir,
    prefixDir,
    binDir,
    grokHomeDir,
    cursorHomeDir,
    cursorSourceDir,
    binPath,
    envFor,
    grokAuthPath,
    cursorModels,
    async init() {
      await fs.mkdir(rootDir, { recursive: true }).catch(() => {});
      await load();
      return this;
    },
    status,
    install,
    authenticate,
    submitAuthCode,
    async cancel(agent) {
      assertAgent(agent);
      if (activeProcesses.has(`auth:${agent}`)) cancelledAuth.add(agent);
      const processes = [`install:${agent}`, `auth:${agent}`]
        .map((key) => activeProcesses.get(key))
        .filter(Boolean);
      for (const proc of processes) terminateProcessTree(proc, { platform, spawnProcess });
      await Promise.all(processes.map((proc) => waitForProcessTreeExit(proc)));
      return processes.length > 0;
    },
    automaticUpdate(agent, { canActivate = () => true } = {}) {
      const runUpdate = updateChain.then(
        () => runAutomaticUpdate(agent, canActivate),
        () => runAutomaticUpdate(agent, canActivate),
      );
      updateChain = runUpdate.then(() => undefined, () => undefined);
      return runUpdate;
    },
  };
}

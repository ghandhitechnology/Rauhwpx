import { constants as fsConstants, existsSync, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { isOpenCodeModelId, redactDiagnosticText } from './agents/backend.mjs';
import { readUtf8FileBounded } from './bounded-file.mjs';
import {
  fetchLatestPackage,
  recoverInterruptedFileReplacement,
  removeFileAndReplacementBackup,
  replaceFileAtomically,
  updatePrefixAtomically,
} from './harness-update.mjs';
import { bundledNpmLaunch } from './npm-runtime.mjs';
import {
  cleanupStaleOAuthCredentialStaging,
  isValidOAuthRecoveryBackupPath,
  prepareStagedOAuthCredential,
  recoverOAuthCredentialPublication,
} from './oauth-credential-transaction.mjs';
import {
  API_KEY_MAX_BYTES,
  AUTH_CODE_MAX_BYTES,
  textFitsByteLimit,
} from './input-bounds.mjs';
import { readResponseTextBounded } from './response-bounds.mjs';
import { openCodeRuntimeEnv } from './opencode-env.mjs';
import { isReusableOpenCodeAuthContent } from './opencode-auth.mjs';
import {
  processTreeSpawnOptions,
  terminateAndWaitForProcessTreeExit,
  terminateProcessTree,
} from './process-tree.mjs';
import { createSetupTerminal } from './setup-terminal.mjs';
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
  opencode: {
    package: 'opencode-ai', bin: 'opencode', kind: 'npm',
    secretId: 'rhwp.opencode.api-key', keyEnv: 'OPENCODE_API_KEY',
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
const OPENCODE_MODELS_TIMEOUT_MS = 20_000;
const OPENCODE_MODELS_TTL_MS = 10 * 60 * 1000;
const CURSOR_INSTALL_COMMAND = 'curl -fsS https://cursor.com/install | bash';
const KEY_CHECK_TIMEOUT_MS = 10_000;
const OAUTH_CREDENTIAL_SNAPSHOT_MAX_BYTES = 1024 * 1024;
const KEY_INVALID_MESSAGE = 'API 키가 유효하지 않아요. 키를 확인해 주세요.';
const SHORT_STDOUT_LIMIT_BYTES = 64 * 1024;
const SHORT_STDERR_LIMIT_BYTES = 16 * 1024;
const STRUCTURED_STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;
const STRUCTURED_STDERR_LIMIT_BYTES = 64 * 1024;
const SECRET_FILE_MAX_BYTES = 64 * 1024;
const CONFIG_FILE_MAX_BYTES = 64 * 1024;
const PACKAGE_MANIFEST_MAX_BYTES = 1024 * 1024;
const OAUTH_AUTH_JOURNAL_MAX_BYTES = 16 * 1024;

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

function submittedApiKey(raw) {
  if (typeof raw !== 'string') {
    throw setupError('AGENT_KEY_INVALID', 'API 키를 입력해 주세요.');
  }
  const value = raw;
  if (!textFitsByteLimit(value, API_KEY_MAX_BYTES)) {
    throw setupError('AGENT_KEY_TOO_LARGE', 'API 키가 허용된 길이를 넘었어요.');
  }
  const trimmed = value.trim();
  if (!trimmed) throw setupError('AGENT_KEY_INVALID', 'API 키를 입력해 주세요.');
  return trimmed;
}

function submittedAuthCode(raw) {
  if (typeof raw !== 'string') {
    throw setupError('AGENT_AUTH_CODE_INVALID', '인증 코드를 입력해 주세요.');
  }
  const value = raw;
  if (!textFitsByteLimit(value, AUTH_CODE_MAX_BYTES)) {
    throw setupError('AGENT_AUTH_CODE_TOO_LARGE', '인증 코드가 허용된 길이를 넘었어요.');
  }
  const trimmed = value.trim();
  if (!trimmed) throw setupError('AGENT_AUTH_CODE_INVALID', '인증 코드를 입력해 주세요.');
  return trimmed;
}

function storedApiKey(raw) {
  if (raw == null) return null;
  if (!textFitsByteLimit(raw, API_KEY_MAX_BYTES) || !raw.trim()) {
    throw setupError('SECRET_STORE_CORRUPT', '저장된 API 키가 허용된 길이 또는 형식이 아니에요.');
  }
  return raw.trim();
}

function throwIfAuthCancelled(signal) {
  if (signal?.aborted) {
    throw setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.');
  }
}

function authRollbackError(original, rollback) {
  const error = new AggregateError(
    [original, rollback],
    'Authentication failed and its credential rollback also failed.',
    { cause: original },
  );
  error.code = 'AGENT_AUTH_ROLLBACK_FAILED';
  return error;
}

function stripTerminalEscapes(text) {
  return String(text ?? '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)?/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B./g, '');
}

function cleanTail(text) {
  return redactDiagnosticText(stripTerminalEscapes(text))
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
    const profile = env.USERPROFILE || home;
    return platformPath.join(env.APPDATA || platformPath.join(profile, 'AppData', 'Roaming'), 'rhwp', 'cli');
  }
  return platformPath.join(env.XDG_DATA_HOME || platformPath.join(home, '.local', 'share'), 'rhwp', 'cli');
}

/** Cursor documents its native Windows config under %USERPROFILE%\.cursor. */
export function defaultCursorHomeDir(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  if (platform === 'win32') return path.win32.resolve(env.USERPROFILE || home);
  return path.resolve(home);
}

export function defaultCursorConfigDir(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  return platformPath.join(defaultCursorHomeDir(env, platform, home), '.cursor');
}

export function defaultOpenCodeAuthPath(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const dataHome = typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim()
    ? platformPath.resolve(env.XDG_DATA_HOME)
    : platformPath.join(platformPath.resolve(home), '.local', 'share');
  return platformPath.join(dataHome, 'opencode', 'auth.json');
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

/**
 * App-managed CLI installers (Codex/Claude/Grok/Cursor/OpenCode) plus their local authentication state.
 *
 * @param {{ rootDir?: string, spawnProcess?: typeof spawn, npmCommand?: string | null,
 *           nodeCommand?: string, platform?: NodeJS.Platform, baseEnv?: NodeJS.ProcessEnv,
 *           createTerminal?: typeof createSetupTerminal,
 *           homeDir?: string, fetchImpl?: typeof fetch, secretStore?: object | null,
 *           prepareOAuthCredential?: typeof prepareStagedOAuthCredential,
 *           replaceConfigFile?: typeof replaceFileAtomically,
 *           terminateProcessTreeImpl?: typeof terminateProcessTree,
 *           createCursorKeyCheckHome?: typeof fs.mkdtemp,
 *           removeCursorKeyCheckHome?: typeof fs.rm }} [deps]
 */
export function createCliSetupManager({
  rootDir = defaultCliSetupRoot(),
  spawnProcess = spawn,
  createTerminal = createSetupTerminal,
  npmCommand = null,
  nodeCommand = process.execPath,
  platform = process.platform,
  baseEnv = process.env,
  homeDir = os.homedir(),
  fetchImpl = globalThis.fetch,
  secretStore = null,
  prepareOAuthCredential = prepareStagedOAuthCredential,
  replaceConfigFile = replaceFileAtomically,
  terminateProcessTreeImpl = terminateProcessTree,
  createCursorKeyCheckHome = (prefix) => fs.mkdtemp(prefix),
  removeCursorKeyCheckHome = (home, options) => fs.rm(home, options),
} = {}) {
  const platformPath = platform === 'win32' ? path.win32 : path;
  const prefixDir = path.join(rootDir, 'prefix');
  const configPath = path.join(rootDir, 'config.json');
  /** OS 보안 저장소가 없을 때 쓰는 대체 보관소 (0600). vault 가 생기면 이관 후 지운다. */
  const secretsPath = path.join(rootDir, 'secrets.json');
  const binDir = path.join(prefixDir, 'node_modules', '.bin');
  /** grok 관리형 로그인 홈 — `grok login` 이 auth.json 을 여기에 만든다. */
  const grokHomeDir = path.join(rootDir, 'grok');
  /**
   * Unix installs stay app-managed. Native Windows Cursor reads configuration
   * from %USERPROFILE%\.cursor, so HOME and USERPROFILE must name that profile.
   */
  const cursorHomeDir = platform === 'win32'
    ? defaultCursorHomeDir(baseEnv, platform, homeDir)
    : path.join(rootDir, 'cursor-home');
  const cursorBinFile = platformPath.join(
    cursorHomeDir,
    '.local',
    'bin',
    platform === 'win32' ? 'cursor-agent.exe' : 'cursor-agent',
  );
  const managedCursorBinFile = platform === 'win32' ? null : cursorBinFile;
  /** 세션 시딩용 영속 `.cursor` 디렉터리 (auth 토큰 등이 산다). */
  const cursorSourceDir = defaultCursorConfigDir(baseEnv, platform, cursorHomeDir);
  /** OpenCode probes must not inherit the user's config, plugins, or project rules. */
  const openCodeProbeHomeDir = path.join(rootDir, 'opencode-probe-home');
  const openCodeSourceAuthFile = defaultOpenCodeAuthPath(baseEnv, platform, homeDir);
  // rootDir is always native to the host performing filesystem I/O. Tests may
  // inject another target platform, but applying that platform's path dialect
  // here would turn an absolute temp path into a relative filename on the host.
  const cursorOAuthStagingDir = path.join(rootDir, 'cursor-oauth-staging');
  const codexOAuthStagingDir = path.join(rootDir, 'codex-oauth-staging');
  const claudeOAuthStagingDir = path.join(rootDir, 'claude-oauth-staging');
  const openCodeOAuthStagingDir = path.join(rootDir, 'opencode-oauth-staging');
  let openCodeTerminal = null;
  const hostProfileHome = platform === 'win32'
    ? platformPath.resolve(baseEnv.USERPROFILE || homeDir)
    : platformPath.resolve(homeDir);
  const defaultCodexHomeDir = platformPath.join(hostProfileHome, '.codex');
  const configuredCodexHomeDir = typeof baseEnv.CODEX_HOME === 'string' && baseEnv.CODEX_HOME.trim()
    ? platformPath.resolve(baseEnv.CODEX_HOME)
    : null;
  const claudeConfigDir = typeof baseEnv.CLAUDE_CONFIG_DIR === 'string'
    && baseEnv.CLAUDE_CONFIG_DIR.trim()
    ? platformPath.resolve(baseEnv.CLAUDE_CONFIG_DIR)
    : platformPath.join(hostProfileHome, '.claude');
  const claudeCredentialFile = platformPath.join(
    claudeConfigDir,
    '.credentials.json',
  );
  const installs = new Map();
  const authRuns = new Map();
  /** 카드에서 취소한 로그인 — 실패 메시지 대신 취소로 보고한다. */
  const cancelledAuth = new Set();
  const activeProcesses = new Map();
  const processCleanupPromises = new WeakMap();
  const processEnvironments = new WeakMap();
  const updateInfo = new Map([
    ['claude', { latestVersion: null, updateRequired: false, error: null }],
    ['codex', { latestVersion: null, updateRequired: false, error: null }],
    ['grok', { latestVersion: null, updateRequired: false, error: null }],
    ['cursor', { latestVersion: null, updateRequired: false, error: null }],
    ['opencode', { latestVersion: null, updateRequired: false, error: null }],
  ]);
  const npmLaunch = bundledNpmLaunch({ nodeCommand, npmCommand });
  /** 공용 prefix 를 건드리는 작업(설치·자동 업데이트)의 직렬화 큐. */
  let prefixChain = Promise.resolve();
  let authPersistenceChain = Promise.resolve();
  let loaded = false;
  /** 에이전트별 저장 API 키 (보안 저장소에서 로드). */
  const apiKeys = { claude: null, codex: null, grok: null, cursor: null, opencode: null };
  let cursorModelsCache = { models: [], fetchedAt: 0 };
  let cursorModelsInFlight = null;
  let openCodeModelsCache = { models: [], fetchedAt: 0 };
  let openCodeModelsInFlight = null;
  let oauthSnapshotSeq = 0;
  let secretStoreError = null;
  let secretFileFailure = null;
  let config = {
    claudeAuthMethod: null,
    codexAuthMethod: null,
    codexKeyTail: null,
    grokAuthMethod: null,
    grokKeyTail: null,
    cursorAuthMethod: null,
    cursorKeyTail: null,
    opencodeAuthMethod: null,
    opencodeKeyTail: null,
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
      // 표준 홈 설치본이 있으면 절대 경로, 없으면 PATH 의 시스템 설치본을 쓴다.
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

  function corruptSecretFileError() {
    return setupError(
      'SECRET_FILE_CORRUPT',
      '저장된 API 키 파일을 안전하게 읽지 못했어요. 원본을 보존했으니 파일을 복구하거나 격리한 뒤 앱을 다시 시작해 주세요.',
    );
  }

  function rememberSecretFileFailure() {
    secretFileFailure ??= corruptSecretFileError();
    secretStoreError ??= secretFileFailure.message;
    return secretFileFailure;
  }

  /** Read the fallback vault once through a bounded, no-follow descriptor. */
  async function readFileSecrets() {
    if (secretFileFailure) throw secretFileFailure;
    let handle = null;
    try {
      const pathStat = await fs.lstat(secretsPath);
      if (pathStat.isSymbolicLink()) throw rememberSecretFileFailure();
      const noFollow = platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
      handle = await fs.open(secretsPath, fsConstants.O_RDONLY | noFollow);
      const stat = await handle.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0
        || stat.size > SECRET_FILE_MAX_BYTES) {
        throw rememberSecretFileFailure();
      }
      const bytes = Buffer.allocUnsafe(SECRET_FILE_MAX_BYTES + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > SECRET_FILE_MAX_BYTES) throw rememberSecretFileFailure();
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
      } catch {
        throw rememberSecretFileFailure();
      }
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        throw rememberSecretFileFailure();
      }
      const entries = raw && typeof raw === 'object' && !Array.isArray(raw)
        && Object.getPrototypeOf(raw) === Object.prototype
        ? Object.entries(raw)
        : null;
      const knownSecretIds = new Set(Object.values(CLI_CONFIG).map((item) => item.secretId));
      if (!entries || entries.length > knownSecretIds.size || entries.some(
        ([key, value]) => !knownSecretIds.has(key)
          || !textFitsByteLimit(value, API_KEY_MAX_BYTES)
          || !value.trim(),
      )) {
        throw rememberSecretFileFailure();
      }
      return Object.fromEntries(entries.map(([key, value]) => [key, value.trim()]));
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      if (error?.code === 'SECRET_FILE_CORRUPT') throw error;
      throw rememberSecretFileFailure();
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** config.json 과 같은 방식으로 원자적으로 바꿔 쓴다. 빈 보관소는 파일째 지운다. */
  async function writeFileSecrets(secrets) {
    const entries = Object.entries(secrets)
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([key, value]) => [key, submittedApiKey(value)]);
    if (entries.length === 0) {
      await removeFileAndReplacementBackup(secretsPath, { platform });
      return;
    }
    const body = `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
    if (Buffer.byteLength(body, 'utf8') > SECRET_FILE_MAX_BYTES) {
      throw setupError('SECRET_FILE_TOO_LARGE', 'API 키 파일이 허용된 크기를 넘었어요.');
    }
    await fs.mkdir(rootDir, { recursive: true });
    const temp = `${secretsPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await replaceFileAtomically(temp, secretsPath, { platform });
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  /** vault 가 있으면 vault, 없으면 파일 보관소에 저장한다. */
  async function storeSecret(secretId, value) {
    const boundedValue = submittedApiKey(value);
    const secrets = await readFileSecrets();
    if (secretStore?.available) {
      await secretStore.set(secretId, boundedValue);
      if (secretId in secrets) {
        delete secrets[secretId];
        await writeFileSecrets(secrets);
      }
      return;
    }
    secrets[secretId] = boundedValue;
    await writeFileSecrets(secrets);
  }

  /** 두 저장소 어디에 있든 지운다. */
  async function deleteSecret(secretId) {
    const secrets = await readFileSecrets();
    if (secretStore?.available) await secretStore.delete(secretId);
    if (!(secretId in secrets)) return;
    delete secrets[secretId];
    await writeFileSecrets(secrets);
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    let raw = {};
    try {
      raw = JSON.parse(await readUtf8FileBounded(configPath, {
        maxBytes: CONFIG_FILE_MAX_BYTES,
        label: 'CLI setup config',
        platform,
      }));
    } catch {}
    let legacyClaudeKey = null;
    try { legacyClaudeKey = storedApiKey(raw?.claudeApiKey); } catch {}
    config.claudeAuthMethod = readAuthMethod(raw, 'claudeAuthMethod');
    config.codexAuthMethod = readAuthMethod(raw, 'codexAuthMethod');
    config.codexKeyTail = typeof raw?.codexKeyTail === 'string' ? raw.codexKeyTail : null;
    config.grokAuthMethod = readAuthMethod(raw, 'grokAuthMethod');
    config.grokKeyTail = typeof raw?.grokKeyTail === 'string' ? raw.grokKeyTail : null;
    config.cursorAuthMethod = readAuthMethod(raw, 'cursorAuthMethod');
    config.cursorKeyTail = typeof raw?.cursorKeyTail === 'string' ? raw.cursorKeyTail : null;
    config.opencodeAuthMethod = readAuthMethod(raw, 'opencodeAuthMethod');
    config.opencodeKeyTail = typeof raw?.opencodeKeyTail === 'string' ? raw.opencodeKeyTail : null;
    const agents = Object.keys(CLI_CONFIG);
    let fileSecrets = {};
    try {
      fileSecrets = await readFileSecrets();
    } catch (error) {
      if (error?.code !== 'SECRET_FILE_CORRUPT') throw error;
    }
    try {
      if (secretStore?.available) {
        const values = await Promise.all(agents.map((agent) => secretStore.get(CLI_CONFIG[agent].secretId)));
        const boundedValues = values.map(storedApiKey);
        agents.forEach((agent, index) => { apiKeys[agent] = boundedValues[index]; });
        // 파일에 남은 키는 vault 로 옮기고 파일에서 지운다 (legacy claudeApiKey 이관과 같은 규칙).
        let migrated = false;
        if (!secretFileFailure) {
          for (const agent of agents) {
            const secretId = CLI_CONFIG[agent].secretId;
            const stored = fileSecrets[secretId]?.trim();
            if (!stored) continue;
            if (!apiKeys[agent]) {
              await secretStore.set(secretId, stored);
              apiKeys[agent] = storedApiKey(await secretStore.get(secretId));
              // 이관이 확인되지 않으면 파일 사본을 남겨 둔다.
              if (apiKeys[agent] !== stored) continue;
            }
            delete fileSecrets[secretId];
            migrated = true;
          }
          if (migrated) await writeFileSecrets(fileSecrets);
        }
        if (!secretFileFailure && !apiKeys.claude && legacyClaudeKey) {
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
      secretStoreError ??= error?.message ?? 'OS 보안 저장소를 열지 못했어요.';
    }
  }

  async function persist() {
    await writePrivateFileAtomically(
      configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      replaceConfigFile,
    );
  }

  async function writePrivateFileAtomically(target, body, replaceFile = replaceFileAtomically) {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    let handle = null;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await replaceFile(temp, target, { platform });
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  function oauthJournalPath(agent) {
    return path.join(rootDir, `oauth-auth-${agent}.journal.json`);
  }

  function oauthJournalError(message) {
    return setupError('AGENT_AUTH_RECOVERY_REQUIRED', message);
  }

  async function writeOAuthJournal(agent, previous, credential, phase = 'ready') {
    const journal = {
      version: 1,
      agent,
      phase,
      previousAuthMethod: previous.authMethod ?? null,
      previousKeyTail: previous.keyTail ?? null,
      credential,
    };
    const body = `${JSON.stringify(journal, null, 2)}\n`;
    if (Buffer.byteLength(body) > OAUTH_AUTH_JOURNAL_MAX_BYTES) {
      throw oauthJournalError('OAuth authentication recovery metadata is too large.');
    }
    await writePrivateFileAtomically(oauthJournalPath(agent), body);
    return journal;
  }

  async function removeOAuthJournal(agent) {
    await removeFileAndReplacementBackup(oauthJournalPath(agent), { platform });
  }

  async function expectedOAuthCredentialPath(agent) {
    if (agent === 'opencode') return openCodeSourceAuthFile;
    if (agent === 'codex') return codexCredentialFile();
    if (agent === 'claude') return claudeCredentialFile;
    if (agent === 'cursor' && platform === 'win32') {
      return platformPath.join(cursorSourceDir, 'cli-config.json');
    }
    return managedOAuthCredentialPath(agent);
  }

  function validateOAuthJournal(raw, expectedAgent) {
    const keys = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.keys(raw).sort()
      : [];
    const credential = raw?.credential;
    const credentialKeys = credential && typeof credential === 'object' && !Array.isArray(credential)
      ? Object.keys(credential).sort()
      : [];
    const digestPattern = /^[0-9a-f]{64}$/;
    if (
      keys.join(',') !== 'agent,credential,phase,previousAuthMethod,previousKeyTail,version'
      || raw.version !== 1
      || raw.agent !== expectedAgent
      || (raw.phase !== 'login' && raw.phase !== 'ready')
      || ![null, 'api-key', 'oauth'].includes(raw.previousAuthMethod)
      || !(raw.previousKeyTail === null
        || (typeof raw.previousKeyTail === 'string' && raw.previousKeyTail.length <= 16))
      || credentialKeys.join(',') !== 'backupFile,initialDigest,initialState,publishedDigest,sourceFile,version'
      || credential.version !== 1
      || typeof credential.sourceFile !== 'string'
      || !credential.sourceFile
      || !['absent', 'file'].includes(credential.initialState)
      || (credential.initialState === 'absent' && credential.initialDigest !== null)
      || (credential.initialState === 'file' && !digestPattern.test(credential.initialDigest))
      || !(digestPattern.test(credential.publishedDigest)
        || (raw.phase === 'login' && credential.publishedDigest === null))
      || (credential.initialState === 'absent' && credential.backupFile !== null)
      || (credential.initialState === 'file'
        && !isValidOAuthRecoveryBackupPath(
          credential.sourceFile,
          credential.backupFile,
          platform,
        ))
    ) {
      throw oauthJournalError('OAuth authentication recovery metadata is invalid.');
    }
    return raw;
  }

  async function readConfigForOAuthRecovery() {
    try {
      const text = await readUtf8FileBounded(configPath, {
        maxBytes: CONFIG_FILE_MAX_BYTES,
        label: 'CLI setup config recovery',
        platform,
      });
      const raw = JSON.parse(text);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config is not an object');
      return raw;
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw oauthJournalError('CLI authentication config could not be read during recovery.');
    }
  }

  async function persistRecoveredConfig(raw) {
    const body = `${JSON.stringify(raw, null, 2)}\n`;
    if (Buffer.byteLength(body) > CONFIG_FILE_MAX_BYTES) {
      throw oauthJournalError('Recovered CLI authentication config exceeds its size limit.');
    }
    await writePrivateFileAtomically(configPath, body, replaceConfigFile);
  }

  async function recoverOAuthJournal(agent) {
    const journalPath = oauthJournalPath(agent);
    await recoverInterruptedFileReplacement(journalPath, { platform });
    let raw;
    try {
      raw = JSON.parse(await readUtf8FileBounded(journalPath, {
        maxBytes: OAUTH_AUTH_JOURNAL_MAX_BYTES,
        label: `${agent} OAuth authentication recovery journal`,
        platform,
      }));
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw oauthJournalError('OAuth authentication recovery journal could not be read.');
    }
    const journal = validateOAuthJournal(raw, agent);
    const expectedSource = await expectedOAuthCredentialPath(agent);
    if (
      typeof expectedSource !== 'string'
      || platformPath.resolve(journal.credential.sourceFile) !== platformPath.resolve(expectedSource)
    ) {
      throw oauthJournalError('OAuth authentication recovery journal names an unexpected credential file.');
    }

    const recoveredConfig = await readConfigForOAuthRecovery();
    const methodKey = `${agent}AuthMethod`;
    const tailKey = `${agent}KeyTail`;
    if (journal.phase === 'login') {
      if (!managedOAuthCredentialPath(agent)) {
        throw oauthJournalError('OAuth login-phase recovery is not valid for this provider.');
      }
      const current = await snapshotManagedOAuthCredential(agent);
      await recoverOAuthCredentialPublication({
        ...journal.credential,
        publishedDigest: current?.existed ? oauthDigest(current.bytes) : '0'.repeat(64),
      }, { commit: false, platform });
      recoveredConfig[methodKey] = journal.previousAuthMethod;
      if (agent !== 'claude') recoveredConfig[tailKey] = journal.previousKeyTail;
      await persistRecoveredConfig(recoveredConfig);
      await removeOAuthJournal(agent);
      return true;
    }
    const configSaysOAuth = recoveredConfig[methodKey] === 'oauth'
      && (agent === 'claude' || recoveredConfig[tailKey] == null);
    let committed = false;
    if (configSaysOAuth) {
      try {
        await recoverOAuthCredentialPublication(journal.credential, { commit: true, platform });
        committed = true;
      } catch (error) {
        if (journal.previousAuthMethod !== 'oauth') throw error;
        await recoverOAuthCredentialPublication(journal.credential, { commit: false, platform });
      }
    } else {
      await recoverOAuthCredentialPublication(journal.credential, { commit: false, platform });
    }

    if (committed) {
      recoveredConfig[methodKey] = 'oauth';
      if (agent !== 'claude') recoveredConfig[tailKey] = null;
      await persistRecoveredConfig(recoveredConfig);
      await deleteSecret(CLI_CONFIG[agent].secretId);
    } else {
      recoveredConfig[methodKey] = journal.previousAuthMethod;
      if (agent !== 'claude') recoveredConfig[tailKey] = journal.previousKeyTail;
      await persistRecoveredConfig(recoveredConfig);
    }
    await removeOAuthJournal(agent);
    return true;
  }

  function serializeAuthPersistence(operation) {
    const result = authPersistenceChain.then(operation, operation);
    authPersistenceChain = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Cursor version probe with config writes redirected away from the live config. */
  async function cursorInstalledVersion() {
    try {
      const result = await run(binPath('cursor'), ['--version'], {
        timeoutMs: STATUS_TIMEOUT_MS,
        env: cursorEnv({ CURSOR_CONFIG_DIR: platformPath.join(cursorHomeDir, '.cursor-probe') }),
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
      const raw = JSON.parse(await readUtf8FileBounded(packageJsonPath(agent, basePrefix), {
        maxBytes: PACKAGE_MANIFEST_MAX_BYTES,
        label: `${agent} package manifest`,
        platform,
      }));
      return typeof raw?.version === 'string' ? raw.version : null;
    } catch {
      return null;
    }
  }

  function envFor(agent) {
    const item = assertAgent(agent);
    const delimiter = platform === 'win32' ? ';' : path.delimiter;
    const sourceEnv = agent === 'opencode'
      ? openCodeRuntimeEnv(baseEnv, apiKeys.opencode)
      : { ...baseEnv };
    const env = {
      ...sourceEnv,
      PATH: sourceEnv.PATH ? `${binDir}${delimiter}${sourceEnv.PATH}` : binDir,
    };
    // 허브가 관리하는 키는 자기 프로바이더의 자식에게만 간다 — 허브 프로세스 환경에
    // 올라온 다른 프로바이더의 키는 여기서 지운다.
    for (const [name, other] of Object.entries(CLI_CONFIG)) {
      if (name === agent || !other.keyEnv) continue;
      delete env[other.keyEnv];
    }
    if (item.keyEnv && apiKeys[agent]) env[item.keyEnv] = apiKeys[agent];
    return env;
  }

  /**
   * cursor 스폰 공통 환경. 상속된 CURSOR_CONFIG_DIR 은 HOME 기반 격리보다 우선해
   * 다른 계정의 설정·인증 상태를 읽게 만든다 — 지우고 나서 호출자 값을 얹는다.
   *
   * @param {NodeJS.ProcessEnv} [extra]
   */
  function cursorEnv(extra = {}) {
    const env = {
      ...envFor('cursor'),
      HOME: cursorHomeDir,
      ...(platform === 'win32' ? { USERPROFILE: cursorHomeDir } : {}),
    };
    delete env.CURSOR_CONFIG_DIR;
    return { ...env, ...extra };
  }

  /** Read a host OpenCode credential without following links or accepting malformed state. */
  async function openCodeAuthContent() {
    try {
      const raw = await readUtf8FileBounded(openCodeSourceAuthFile, {
        maxBytes: OAUTH_CREDENTIAL_SNAPSHOT_MAX_BYTES,
        label: 'OpenCode auth',
        platform,
      });
      if (!isReusableOpenCodeAuthContent(raw)) return null;
      return raw;
    } catch {
      return null;
    }
  }

  async function openCodeAuthPath() {
    return await openCodeAuthContent() ? openCodeSourceAuthFile : null;
  }

  /** Fully isolate model probes from the user's OpenCode config and project plugins. */
  async function openCodeProbeEnv(extra = {}) {
    const configHome = path.join(openCodeProbeHomeDir, '.config');
    const dataHome = path.join(openCodeProbeHomeDir, '.local', 'share');
    const cacheHome = path.join(openCodeProbeHomeDir, '.cache');
    const stateHome = path.join(openCodeProbeHomeDir, '.local', 'state');
    const authContent = await openCodeAuthContent();
    const env = {
      ...envFor('opencode'),
      HOME: openCodeProbeHomeDir,
      USERPROFILE: openCodeProbeHomeDir,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_STATE_HOME: stateHome,
      OPENCODE_CONFIG_DIR: path.join(configHome, 'opencode'),
      OPENCODE_CONFIG_CONTENT: '{}',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    };
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_DB;
    delete env.OPENCODE_AUTH_CONTENT;
    delete env.OPENCODE_PERMISSION;
    if (authContent) env.OPENCODE_AUTH_CONTENT = authContent;
    return { ...env, ...extra };
  }

  /** Match the server's CODEX_HOME-first lookup, then choose the CLI's write target if both are absent. */
  async function codexCredentialFile() {
    const homes = [...new Set([
      configuredCodexHomeDir,
      defaultCodexHomeDir,
    ].filter(Boolean))];
    for (const candidateHome of homes) {
      const candidate = platformPath.join(candidateHome, 'auth.json');
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return platformPath.join(homes[0] ?? defaultCodexHomeDir, 'auth.json');
  }

  function run(command, argv, {
    input = null, timeoutMs = STATUS_TIMEOUT_MS, env = baseEnv, onOutput, operationKey = null,
    keepStdinOpen = false,
    maxStdoutBytes = SHORT_STDOUT_LIMIT_BYTES,
    maxStderrBytes = SHORT_STDERR_LIMIT_BYTES,
  } = {}) {
    return new Promise((resolve, reject) => {
      if (operationKey && activeProcesses.has(operationKey)) {
        reject(setupError(
          'AGENT_SETUP_CLEANUP_PENDING',
          '이전 설정 프로세스의 종료를 확인하지 못했어요. 앱을 다시 시작한 뒤 재시도해 주세요.',
        ));
        return;
      }
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let forcedError = null;
      let timer = null;
      const finish = (error, result, { retainProcess = false } = {}) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (!retainProcess && operationKey && activeProcesses.get(operationKey) === proc) {
          activeProcesses.delete(operationKey);
        }
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
      processEnvironments.set(proc, env);
      if (operationKey) activeProcesses.set(operationKey, proc);
      const cleanupProcess = () => {
        const current = processCleanupPromises.get(proc);
        if (current) return current;
        const cleanup = terminateAndWaitForProcessTreeExit(proc, {
          terminateProcess: terminateProcessTreeImpl,
          terminateOptions: { platform, spawnProcess, env },
        }).catch(() => false);
        processCleanupPromises.set(proc, cleanup);
        return cleanup;
      };
      const finishAfterCleanup = (error, result) => {
        void cleanupProcess().then((cleaned) => {
          if (!cleaned) {
            const cleanupError = error ?? setupError(
              'AGENT_SETUP_CLEANUP_UNCERTAIN',
              '설정 프로세스의 종료를 확인하지 못했어요. 앱을 다시 시작한 뒤 상태를 확인해 주세요.',
            );
            cleanupError.processCleanupUncertain = true;
            finish(cleanupError, null, { retainProcess: true });
            return;
          }
          finish(error, result);
        });
      };
      const forceFailure = (error) => {
        if (settled || forcedError) return;
        forcedError = error;
        if (timer) clearTimeout(timer);
        finishAfterCleanup(error, null);
      };
      timer = setTimeout(() => {
        forceFailure(setupError('AGENT_SETUP_TIMEOUT', '설정 작업이 제한 시간 안에 끝나지 않았어요.'));
      }, timeoutMs);
      timer.unref?.();
      const collect = (target, chunk) => {
        if (settled || forcedError) return;
        const text = chunk.toString();
        const chunkBytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(text);
        if (target === 'stdout') {
          stdoutBytes += chunkBytes;
          if (stdoutBytes > maxStdoutBytes) {
            forceFailure(setupError('AGENT_SETUP_OUTPUT_TOO_LARGE', 'CLI stdout exceeded its safety limit.'));
            return;
          }
          stdout += text;
        } else {
          stderrBytes += chunkBytes;
          if (stderrBytes > maxStderrBytes) {
            forceFailure(setupError('AGENT_SETUP_OUTPUT_TOO_LARGE', 'CLI stderr exceeded its safety limit.'));
            return;
          }
          stderr += text;
        }
        if (typeof onOutput === 'function') {
          try {
            onOutput(text);
          } catch {
            // Output is emitted from EventEmitter listeners. UI/progress failures must
            // never escape that stack and crash the hub process.
          }
        }
      };
      proc.stdout?.on?.('data', (chunk) => collect('stdout', chunk));
      proc.stderr?.on?.('data', (chunk) => collect('stderr', chunk));
      proc.on('error', (error) => {
        if (forcedError) return;
        if (processCleanupPromises.has(proc)) finishAfterCleanup(error, null);
        else finish(error);
      });
      proc.on('close', (code, signal) => {
        if (forcedError) return;
        const result = { code, signal, stdout, stderr };
        if (processCleanupPromises.has(proc)) finishAfterCleanup(null, result);
        else finish(null, result);
      });
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
          env: cursorEnv(),
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
    if (agent === 'opencode') {
      const authenticated = Boolean(await openCodeAuthPath());
      return {
        authenticated,
        authMethod: authenticated ? (config.opencodeAuthMethod ?? 'oauth') : null,
        keyTail: null,
      };
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

  async function runNpmInstall(agent, item, progress) {
    let lastActivity = 0;
    const { emit, state } = progress;
    await load();
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
        maxStdoutBytes: STRUCTURED_STDOUT_LIMIT_BYTES,
        maxStderrBytes: STRUCTURED_STDERR_LIMIT_BYTES,
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
    if (agent === 'opencode') resetOpenCodeModelsCache();
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
      maxStdoutBytes: STRUCTURED_STDOUT_LIMIT_BYTES,
      maxStderrBytes: STRUCTURED_STDERR_LIMIT_BYTES,
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
    let running;
    if (item.kind === 'script') {
      running = runScriptInstall(agent, item, onProgress);
    } else {
      // npm 설치는 자동 업데이트와 같은 prefix 를 쓴다 — 같은 큐에 세워 원자적 교체와
      // 겹치지 않게 한다. 준비 단계는 큐에 넣기 전에 알려 카드가 바로 반응한다.
      const progress = makeInstallProgress(onProgress);
      progress.emit('preparing', 8, `${item.bin} CLI 설치 준비 중`);
      running = enqueuePrefixOp(() => runNpmInstall(agent, item, progress));
    }
    installs.set(agent, running);
    try {
      return await running;
    } finally {
      if (installs.get(agent) === running) installs.delete(agent);
    }
  }

  /**
   * 공용 prefix 를 건드리는 작업을 한 줄로 세운다 — 사용자 설치와 자동 업데이트가
   * 같은 디렉터리를 동시에 바꾸지 못하게 한다.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function enqueuePrefixOp(fn) {
    const running = prefixChain.then(fn, fn);
    prefixChain = running.then(() => undefined, () => undefined);
    return running;
  }

  /** cursor 자기 갱신 — 레지스트리 메타데이터가 없어 latestVersion/updateRequired 는 유지된다. */
  async function runCursorAutomaticUpdate(agent, canActivate) {
    const update = updateInfo.get(agent);
    // 시스템 설치본만 있으면 손대지 않는다.
    if (!managedCursorBinFile || !existsSync(managedCursorBinFile)) return status(agent);
    // `cursor-agent update` 는 실행 중인 바이너리를 그 자리에서 바꾼다 — npm 경로의
    // 원자적 교체와 같은 기준으로, 스폰 직전에 한가한지 다시 확인한다.
    if (!canActivate()) return status(agent);
    try {
      const result = await run(managedCursorBinFile, ['update'], {
        timeoutMs: INSTALL_TIMEOUT_MS,
        env: cursorEnv(),
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
    if (item.kind === 'script') return runCursorAutomaticUpdate(agent, canActivate);
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
            {
              timeoutMs: INSTALL_TIMEOUT_MS,
              maxStdoutBytes: STRUCTURED_STDOUT_LIMIT_BYTES,
              maxStderrBytes: STRUCTURED_STDERR_LIMIT_BYTES,
            },
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
      if (agent === 'opencode') resetOpenCodeModelsCache();
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
  async function verifyCursorApiKey(value, { signal } = {}) {
    let result;
    let checkHome;
    try {
      throwIfAuthCancelled(signal);
      checkHome = await createCursorKeyCheckHome(path.join(rootDir, 'cursor-key-check-'));
    } catch (error) {
      if (error?.code === 'AGENT_AUTH_CANCELLED') throw error;
      throw setupError(
        'AGENT_KEY_CHECK_ISOLATION_FAILED',
        'Cursor API 키를 격리해 확인할 수 없어요. 앱을 다시 시작한 뒤 재시도해 주세요.',
      );
    }
    let retainCheckHome = false;
    try {
      throwIfAuthCancelled(signal);
      // 로그인 세션이 남은 cursorHomeDir 로 물으면 키와 무관하게 인증됨으로 나온다 —
      // 매번 새 검증 HOME 을 만들어 이전 상태 없이 키만으로 판정한다.
      result = await run(binPath('cursor'), ['status', '--format', 'json'], {
        timeoutMs: KEY_CHECK_TIMEOUT_MS,
        operationKey: 'auth:cursor',
        env: cursorEnv({
          HOME: checkHome,
          USERPROFILE: checkHome,
          CURSOR_CONFIG_DIR: checkHome,
          CURSOR_API_KEY: value,
        }),
      });
    } catch (error) {
      if (error?.processCleanupUncertain === true) {
        retainCheckHome = true;
        throw error;
      }
      if (error?.code === 'AGENT_SETUP_CLEANUP_PENDING') throw error;
      if (cancelledAuth.delete('cursor')) {
        throw setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.');
      }
      throwIfAuthCancelled(signal);
      return;
    } finally {
      if (checkHome && !retainCheckHome) {
        try {
          await removeCursorKeyCheckHome(checkHome, {
            recursive: true,
            force: true,
            ...(platform === 'win32' ? { maxRetries: 3, retryDelay: 100 } : {}),
          });
        } catch {
          throw setupError(
            'AGENT_KEY_CHECK_CLEANUP_FAILED',
            'Cursor API 키 확인용 임시 프로필을 정리하지 못했어요. 앱을 다시 시작한 뒤 재시도해 주세요.',
          );
        }
      }
    }
    if (cancelledAuth.delete('cursor')) {
      throw setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.');
    }
    throwIfAuthCancelled(signal);
    const parsed = parseJsonOutput(result.stdout);
    if (!parsed) return;
    if (parsed.isAuthenticated !== true) throw setupError('AGENT_KEY_INVALID', KEY_INVALID_MESSAGE);
  }

  /**
   * 키를 저장하기 전에 실제로 통하는지 확인한다. 확실한 거절(401)만 오류로 보고,
   * 그 밖의 응답이나 네트워크 실패는 통과시킨다 — 권한이 좁은 프로젝트 키(403)와
   * 오프라인 환경을 막지 않는다.
   */
  async function verifyApiKey(agent, value, { signal } = {}) {
    throwIfAuthCancelled(signal);
    if (agent === 'cursor') {
      await verifyCursorApiKey(value, { signal });
      return;
    }
    const endpoint = KEY_CHECK_ENDPOINTS[agent];
    if (!endpoint || typeof fetchImpl !== 'function') return;
    const timeoutSignal = AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await fetchImpl(endpoint.url, {
        method: 'GET',
        headers: endpoint.headers(value),
        signal: requestSignal,
      });
    } catch {
      throwIfAuthCancelled(signal);
      return;
    }
    throwIfAuthCancelled(signal);
    if (response?.status !== 400 && response?.status !== 403) {
      try { await response?.body?.cancel?.(); } catch {}
      throwIfAuthCancelled(signal);
    }
    if (response?.status === 401) {
      throw setupError('AGENT_KEY_INVALID', KEY_INVALID_MESSAGE);
    }
    // x.ai 는 잘못된 키에 400 을 준다 — 본문이 키 오류를 말할 때만 거절해 권한이
    // 좁은 프로젝트 키(403)의 다른 사유를 오판하지 않는다.
    if (response?.status === 400 || response?.status === 403) {
      let body = '';
      try {
        body = await readResponseTextBounded(response, {
          maxBytes: SHORT_STDOUT_LIMIT_BYTES,
          label: `${agent} API key check response`,
        });
      } catch {}
      throwIfAuthCancelled(signal);
      if (/api[-_ ]?key|authentication/i.test(body)) {
        throw setupError('AGENT_KEY_INVALID', KEY_INVALID_MESSAGE);
      }
    }
  }

  function authStateSnapshot(agent) {
    return {
      apiKey: apiKeys[agent],
      authMethod: config[`${agent}AuthMethod`],
      keyTail: config[`${agent}KeyTail`],
      secretStoreError,
      cursorModelsCache: agent === 'cursor'
        ? { models: [...cursorModelsCache.models], fetchedAt: cursorModelsCache.fetchedAt }
        : null,
      openCodeModelsCache: agent === 'opencode'
        ? { models: [...openCodeModelsCache.models], fetchedAt: openCodeModelsCache.fetchedAt }
        : null,
    };
  }

  function restoreAuthMemory(agent, previous) {
    apiKeys[agent] = previous.apiKey;
    secretStoreError = previous.secretStoreError;
    config[`${agent}AuthMethod`] = previous.authMethod;
    if (agent !== 'claude') config[`${agent}KeyTail`] = previous.keyTail;
    if (previous.cursorModelsCache) cursorModelsCache = previous.cursorModelsCache;
    if (previous.openCodeModelsCache) openCodeModelsCache = previous.openCodeModelsCache;
  }

  async function restoreAuthSecret(item, previous) {
    if (previous.apiKey) await storeSecret(item.secretId, previous.apiKey);
    else await deleteSecret(item.secretId);
  }

  /** Only app-owned OAuth files are safe to restore without racing another user CLI. */
  function managedOAuthCredentialPath(agent) {
    if (agent === 'grok') return path.join(grokHomeDir, 'auth.json');
    if (agent === 'cursor' && platform !== 'win32') return path.join(cursorSourceDir, 'cli-config.json');
    return null;
  }

  async function snapshotManagedOAuthCredential(agent) {
    const file = managedOAuthCredentialPath(agent);
    if (!file) return null;
    let handle = null;
    try {
      const pathStat = await fs.lstat(file);
      if (pathStat.isSymbolicLink()) {
        throw setupError(
          'AGENT_AUTH_SNAPSHOT_FAILED',
          '기존 로그인 파일이 심볼릭 링크라 안전하게 로그인을 시작할 수 없어요.',
        );
      }
      const noFollow = platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
      handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 0 || stat.size > OAUTH_CREDENTIAL_SNAPSHOT_MAX_BYTES) {
        throw setupError(
          'AGENT_AUTH_SNAPSHOT_FAILED',
          '안전하게 보관할 수 없는 기존 로그인 파일이 있어요.',
        );
      }
      const bytes = Buffer.allocUnsafe(OAUTH_CREDENTIAL_SNAPSHOT_MAX_BYTES + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > OAUTH_CREDENTIAL_SNAPSHOT_MAX_BYTES) {
        throw setupError(
          'AGENT_AUTH_SNAPSHOT_FAILED',
          '기존 로그인 파일이 너무 커서 안전하게 로그인을 시작할 수 없어요.',
        );
      }
      return { file, existed: true, bytes: Buffer.from(bytes.subarray(0, offset)), mode: stat.mode & 0o777 };
    } catch (error) {
      if (error?.code === 'ENOENT') return { file, existed: false, bytes: null, mode: 0o600 };
      if (error?.code === 'AGENT_AUTH_SNAPSHOT_FAILED') throw error;
      throw setupError(
        'AGENT_AUTH_SNAPSHOT_FAILED',
        `기존 로그인 파일을 안전하게 보관하지 못했어요: ${error?.message ?? error}`,
      );
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function restoreManagedOAuthCredential(snapshot) {
    if (!snapshot) return;
    if (!snapshot.existed) {
      await removeFileAndReplacementBackup(snapshot.file, { platform });
      return;
    }
    await fs.mkdir(path.dirname(snapshot.file), { recursive: true });
    const temp = `${snapshot.file}.oauth-rollback-${process.pid}-${(oauthSnapshotSeq += 1)}`;
    try {
      await fs.writeFile(temp, snapshot.bytes, { mode: snapshot.mode });
      await replaceFileAtomically(temp, snapshot.file, { platform });
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  function oauthDigest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
  }

  async function prepareDirectOAuthRecovery(agent, previous, snapshot) {
    if (!snapshot) return null;
    const backupFile = snapshot.existed
      ? `${snapshot.file}.oauth-${process.pid}-${randomUUID()}.held`
      : null;
    const recovery = {
      version: 1,
      sourceFile: snapshot.file,
      initialState: snapshot.existed ? 'file' : 'absent',
      initialDigest: snapshot.existed ? oauthDigest(snapshot.bytes) : null,
      publishedDigest: null,
      backupFile,
    };
    try {
      await writeOAuthJournal(agent, previous, recovery, 'login');
      if (backupFile) {
        let handle = null;
        try {
          handle = await fs.open(backupFile, 'wx', 0o600);
          await handle.writeFile(snapshot.bytes);
          await handle.sync();
        } finally {
          await handle?.close().catch(() => {});
        }
      }
    } catch (error) {
      if (backupFile) await fs.rm(backupFile, { force: true }).catch(() => {});
      await removeOAuthJournal(agent).catch(() => {});
      throw error;
    }
    return { previous, recovery };
  }

  async function markDirectOAuthRecoveryReady(agent, state) {
    const published = await snapshotManagedOAuthCredential(agent);
    if (!published?.existed) {
      await finishDirectOAuthRollback(agent, state);
      return null;
    }
    try {
      const parsed = JSON.parse(published.bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid object');
    } catch {
      throw setupError('AGENT_AUTH_CREDENTIAL_INVALID', 'OAuth login created an invalid credential file.');
    }
    state.recovery.publishedDigest = oauthDigest(published.bytes);
    await writeOAuthJournal(agent, state.previous, state.recovery, 'ready');
    return state;
  }

  async function finishDirectOAuthRollback(agent, state) {
    if (!state) return;
    await recoverOAuthCredentialPublication({
      ...state.recovery,
      publishedDigest: state.recovery.publishedDigest ?? '0'.repeat(64),
    }, { commit: false, platform });
    await removeOAuthJournal(agent);
  }

  async function commitApiKey(agent, item, value, signal, onCommitted) {
    return serializeAuthPersistence(async () => {
      const authMethodKey = `${agent}AuthMethod`;
      const keyTailKey = `${agent}KeyTail`;
      const previous = authStateSnapshot(agent);
      let commitStarted = false;
      try {
        throwIfAuthCancelled(signal);
        // Corrupt fallback storage is a precondition failure, not a partial commit.
        await readFileSecrets();
        throwIfAuthCancelled(signal);
        commitStarted = true;
        await storeSecret(item.secretId, value);
        throwIfAuthCancelled(signal);

        // These assignments are synchronous, so one fence immediately before the block
        // covers the complete in-memory commit.
        apiKeys[agent] = value;
        secretStoreError = null;
        config[authMethodKey] = 'api-key';
        // claude 는 기존 설정 파일 스키마를 유지한다 — keyTail 을 저장하지 않는다.
        if (agent !== 'claude') config[keyTailKey] = keyTail(value);
        if (agent === 'cursor') resetCursorModelsCache();
        if (agent === 'opencode') resetOpenCodeModelsCache();

        throwIfAuthCancelled(signal);
        await persist();
        throwIfAuthCancelled(signal);
        onCommitted?.();
      } catch (error) {
        if (!commitStarted) throw error;
        // A vault or config write may already have completed. Until onCommitted returns,
        // every failure restores both persistence and the live provider environment.
        const rollbackErrors = [];
        restoreAuthMemory(agent, previous);
        try { await restoreAuthSecret(item, previous); } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        try { await persist(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        if (rollbackErrors.length > 0) {
          throw authRollbackError(
            error,
            new AggregateError(rollbackErrors, 'One or more credential rollback steps failed.'),
          );
        }
        throw error;
      }
    });
  }

  async function commitOAuth(
    agent,
    item,
    signal,
    onCommitted,
    credentialTransaction = null,
    directCredentialRecovery = null,
  ) {
    return serializeAuthPersistence(async () => {
      const previous = authStateSnapshot(agent);
      let commitStarted = false;
      let journalWritten = false;
      let credentialCommitted = false;
      try {
        throwIfAuthCancelled(signal);
        // Check this before publishing the staged host credential. Otherwise a
        // corrupt fallback store would force a rollback after host publication.
        await readFileSecrets();
        throwIfAuthCancelled(signal);
        const credentialRecovery = directCredentialRecovery
          ?? await credentialTransaction?.prepareRecovery?.();
        if (directCredentialRecovery) {
          journalWritten = true;
        } else if (credentialRecovery) {
          await writeOAuthJournal(agent, previous, credentialRecovery);
          journalWritten = true;
        }
        throwIfAuthCancelled(signal);
        await credentialTransaction?.publish();
        throwIfAuthCancelled(signal);
        commitStarted = true;

        apiKeys[agent] = null;
        secretStoreError = null;
        config[`${agent}AuthMethod`] = 'oauth';
        if (agent !== 'claude') config[`${agent}KeyTail`] = null;
        if (agent === 'cursor') resetCursorModelsCache();
        if (agent === 'opencode') resetOpenCodeModelsCache();

        // Config is the durable commit marker. Keep the API secret until that
        // marker exists, so a crash before it can restore the old credential
        // without storing the API key in the journal.
        throwIfAuthCancelled(signal);
        await persist();
        throwIfAuthCancelled(signal);
        await deleteSecret(item.secretId);
        throwIfAuthCancelled(signal);
        await credentialTransaction?.cleanup();
        throwIfAuthCancelled(signal);
        onCommitted?.();
        // onCommitted is the synchronous registry boundary: once it returns,
        // later cancellation must not undo the published host credential.
        credentialCommitted = true;
        if (credentialTransaction?.finalizeCommit) {
          await credentialTransaction.finalizeCommit();
        } else if (directCredentialRecovery) {
          await recoverOAuthCredentialPublication(directCredentialRecovery, {
            commit: true,
            platform,
          });
        } else {
          credentialTransaction?.markCommitted();
        }
        if (journalWritten) {
          await removeOAuthJournal(agent);
          journalWritten = false;
        }
      } catch (error) {
        if (credentialCommitted) throw error;
        const rollbackErrors = [];
        if (commitStarted) {
          restoreAuthMemory(agent, previous);
          try { await restoreAuthSecret(item, previous); } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
          try { await persist(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        try { await credentialTransaction?.rollback(); } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (directCredentialRecovery) {
          try {
            await recoverOAuthCredentialPublication(directCredentialRecovery, {
              commit: false,
              platform,
            });
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        try { await credentialTransaction?.cleanup(); } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (journalWritten && rollbackErrors.length === 0) {
          try {
            await removeOAuthJournal(agent);
            journalWritten = false;
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw authRollbackError(
            error,
            new AggregateError(rollbackErrors, 'One or more credential rollback steps failed.'),
          );
        }
        throw error;
      }
    });
  }

  /**
   * @param {string} agent
   * @param {'api-key'|'oauth'} method
   * @param {string} [key] api-key 방식에서만 쓴다.
   * @param {(progress: SetupProgress) => void} [onProgress]
   * @param {{ signal?: AbortSignal, onCommitted?: () => void }} [options]
   */
  async function authenticate(agent, method, key, onProgress, { signal, onCommitted } = {}) {
    const item = assertAgent(agent);
    throwIfAuthCancelled(signal);
    if (agent === 'opencode' && openCodeTerminal) throw setupError('AGENT_SETUP_CLEANUP_PENDING', '이전 로그인 종료를 확인하지 못했어요. 앱을 다시 시작해 주세요.');
    if (authRuns.has(agent)) throw setupError('AGENT_AUTH_BUSY', '이미 로그인 작업이 진행 중이에요.');
    // Reject oversized credentials before load() can migrate or rewrite any
    // persisted state, and before a provider request can build a huge header.
    const apiKeyValue = method === 'api-key' ? submittedApiKey(key) : null;
    // 지난 로그인에서 남은 취소 표시는 이번 시도와 무관하다 — 진짜 실패를 취소로
    // 둔갑시키지 않도록 시작할 때 지운다.
    cancelledAuth.delete(agent);
    const running = (async () => {
      await load();
      throwIfAuthCancelled(signal);
      if (method === 'oauth' && agent === 'claude' && platform === 'darwin') {
        // Claude Code stores OAuth state in the macOS Keychain. A file transaction
        // cannot isolate or roll that state back, so setup must not start the CLI.
        throw setupError(
          'AGENT_AUTH_OAUTH_UNSUPPORTED',
          'macOS에서는 Claude OAuth 로그인을 안전하게 격리할 수 없어요. Claude API 키를 사용해 주세요.',
        );
      }
      const managedVersion = await installedVersion(agent);
      throwIfAuthCancelled(signal);
      const command = managedVersion ? binPath(agent) : item.bin;
      onProgress?.({ state: 'authorizing' });
      if (method === 'api-key') {
        await verifyApiKey(agent, apiKeyValue, { signal });
        await commitApiKey(agent, item, apiKeyValue, signal, onCommitted);
        onProgress?.({ state: 'done' });
        return status(agent);
      }
      if (method !== 'oauth') throw setupError('AGENT_AUTH_INVALID', '지원하지 않는 로그인 방식이에요.');
      throwIfAuthCancelled(signal);
      let credentialSnapshot = null;
      let credentialTransaction = null;
      let directOAuthRecoveryState = null;
      let credentialCommitAttempted = false;
      let buffered = '';
      let oauthCommitted = false;
      try {
        if (agent === 'cursor' && platform === 'win32') {
          credentialTransaction = await prepareOAuthCredential({
            sourceFile: platformPath.join(cursorSourceDir, 'cli-config.json'),
            stagingParent: cursorOAuthStagingDir,
            platform,
          });
        } else if (agent === 'opencode') {
          credentialTransaction = await prepareOAuthCredential({
            sourceFile: openCodeSourceAuthFile,
            stagingParent: openCodeOAuthStagingDir,
            relativeCredentialPath: path.join('data', 'opencode', 'auth.json'),
            platform,
          });
        } else if (agent === 'codex') {
          credentialTransaction = await prepareOAuthCredential({
            sourceFile: await codexCredentialFile(),
            stagingParent: codexOAuthStagingDir,
            relativeCredentialPath: 'auth.json',
            platform,
          });
        } else if (agent === 'claude') {
          credentialTransaction = await prepareOAuthCredential({
            sourceFile: claudeCredentialFile,
            stagingParent: claudeOAuthStagingDir,
            relativeCredentialPath: '.credentials.json',
            platform,
          });
        } else {
          credentialSnapshot = await snapshotManagedOAuthCredential(agent);
          directOAuthRecoveryState = await prepareDirectOAuthRecovery(
            agent,
            authStateSnapshot(agent),
            credentialSnapshot,
          );
        }
        throwIfAuthCancelled(signal);
        const loginEnv = (env) => {
          const isolated = { ...env };
          if (item.keyEnv) delete isolated[item.keyEnv];
          return isolated;
        };
        const loginSpec = {
          opencode: {
            argv: ['auth', 'login'],
            env: loginEnv({ ...envFor('opencode'),
              ...Object.fromEntries(['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']
                .filter(key => typeof baseEnv[key] === 'string').map(key => [key, baseEnv[key]])),
              HOME: credentialTransaction?.homeDir, USERPROFILE: credentialTransaction?.homeDir,
              XDG_DATA_HOME: path.join(credentialTransaction?.homeDir ?? rootDir, 'data'),
              XDG_CONFIG_HOME: path.join(credentialTransaction?.homeDir ?? rootDir, 'config'),
              XDG_CACHE_HOME: path.join(credentialTransaction?.homeDir ?? rootDir, 'cache'),
              OPENCODE_CONFIG_DIR: path.join(credentialTransaction?.homeDir ?? rootDir, 'config', 'opencode'),
              OPENCODE_CONFIG_CONTENT: '{}',
            }),
          },
          // 기기 인증만 쓴다 — 기본 로그인은 허브 기기의 localhost 콜백 서버를 띄우기
          // 때문에 원격에서 스튜디오를 여는 사용자는 로그인을 끝낼 수 없다.
          codex: {
            argv: ['login', '--device-auth'],
            env: loginEnv({
              ...envFor('codex'),
              ...(credentialTransaction ? { CODEX_HOME: credentialTransaction.homeDir } : {}),
            }),
            keepStdinOpen: false,
          },
          // claude 는 TTY 없이 실행되면 브라우저 로그인 뒤 인증 코드를 stdin 으로 받아야 끝난다.
          claude: {
            argv: ['auth', 'login'],
            env: loginEnv({
              ...envFor('claude'),
              ...(credentialTransaction ? {
                HOME: credentialTransaction.homeDir,
                USERPROFILE: credentialTransaction.homeDir,
                CLAUDE_CONFIG_DIR: credentialTransaction.configDir,
              } : {}),
            }),
            keepStdinOpen: true,
          },
          // grok 로그인은 관리형 GROK_HOME 에 auth.json 을 만든다.
          grok: {
            argv: ['login'],
            env: loginEnv({ ...envFor('grok'), GROK_HOME: grokHomeDir }),
            keepStdinOpen: false,
          },
          // Native Windows Cursor receives an isolated managed profile. Its one
          // authored credential is CAS-published only at the app commit boundary.
          cursor: {
            argv: ['login'],
            env: loginEnv(cursorEnv({
              ...(credentialTransaction ? {
                HOME: credentialTransaction.homeDir,
                USERPROFILE: credentialTransaction.homeDir,
                CURSOR_CONFIG_DIR: credentialTransaction.configDir,
              } : {}),
              NO_OPEN_BROWSER: '1',
            })),
            keepStdinOpen: false,
          },
        }[agent];
        if (agent === 'grok') await fs.mkdir(grokHomeDir, { recursive: true });
        if (agent === 'cursor' && platform !== 'win32') await fs.mkdir(cursorHomeDir, { recursive: true });
        throwIfAuthCancelled(signal);
        const result = agent === 'opencode' ? await (async () => {
          openCodeTerminal = createTerminal({ command, argv: loginSpec.argv, env: loginSpec.env,
            cwd: credentialTransaction.homeDir, signal, timeoutMs: AUTH_TIMEOUT_MS,
            onOutput: terminalData => onProgress?.({ state: 'authorizing', terminalData }),
          });
          onProgress?.({ state: 'authorizing', terminalReady: true });
          let cleanupUncertain = false;
          try { return await openCodeTerminal.done; }
          catch (error) { cleanupUncertain = error?.processCleanupUncertain === true; throw error; }
          finally { if (!cleanupUncertain) openCodeTerminal = null; }
        })() : await run(command, loginSpec.argv, {
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
        throwIfAuthCancelled(signal);
        if (result.code !== 0) {
          // 사용자가 카드에서 취소한 로그인은 실패가 아니다 — CLI 출력 꼬리를 보여주지 않는다.
          if (cancelledAuth.delete(agent)) {
            throw setupError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.');
          }
          const detail = cleanTail(result.stderr || result.stdout);
          throw setupError('AGENT_AUTH_FAILED', setupFailureMessage(null, detail, '로그인을 완료하지 못했어요.'));
        }
        // 성공으로 끝난 실행이 취소 표시를 남기면 다음 실패가 취소로 보고된다.
        cancelledAuth.delete(agent);
        throwIfAuthCancelled(signal);
        if (directOAuthRecoveryState) {
          directOAuthRecoveryState = await markDirectOAuthRecoveryReady(
            agent,
            directOAuthRecoveryState,
          );
        }
        if (agent === 'opencode') {
          const credential = await readUtf8FileBounded(credentialTransaction.credentialFile, {
            maxBytes: 1024 * 1024, label: 'OpenCode login credential', platform,
          }).catch(() => '');
          if (!isReusableOpenCodeAuthContent(credential)) {
            throw setupError('AGENT_AUTH_FAILED', 'OpenCode 로그인을 확인하지 못했어요. 다시 시도하거나 API 키로 연결해 주세요.');
          }
        }
        credentialCommitAttempted = true;
        await commitOAuth(
          agent,
          item,
          signal,
          onCommitted,
          credentialTransaction,
          directOAuthRecoveryState?.recovery ?? null,
        );
        oauthCommitted = true;
        onProgress?.({ state: 'done' });
        return status(agent);
      } catch (error) {
        if (!oauthCommitted && error?.processCleanupUncertain !== true) {
          try {
            if (credentialTransaction && !credentialCommitAttempted) {
              await credentialTransaction.rollback();
              await credentialTransaction.cleanup();
            } else if (!credentialTransaction) {
              await restoreManagedOAuthCredential(credentialSnapshot);
              await finishDirectOAuthRollback(agent, directOAuthRecoveryState);
            }
          } catch (rollbackError) {
            throw authRollbackError(error, rollbackError);
          }
        }
        throw error;
      }
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
    const value = submittedAuthCode(code);
    const proc = activeProcesses.get(`auth:${agent}`);
    if (!proc || !authRuns.has(agent)) {
      throw setupError('AGENT_AUTH_NOT_RUNNING', '진행 중인 로그인이 없어요. 브라우저 로그인부터 다시 시작해 주세요.');
    }
    proc.stdin?.write?.(`${value}\n`);
  }

  /**
   * TTL 을 만료시켜 다음 조회가 곧바로 CLI 를 다시 보게 한다. 로그인 직전의
   * 미인증 조회가 남긴 빈 목록을 10 분 동안 붙들고 있지 않도록 하는 장치다.
   */
  function resetCursorModelsCache() {
    cursorModelsCache = { models: cursorModelsCache.models, fetchedAt: 0 };
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
        env: cursorEnv(),
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

  function resetOpenCodeModelsCache() {
    openCodeModelsCache = { models: openCodeModelsCache.models, fetchedAt: 0 };
  }

  /** Return OpenCode's provider-qualified catalog without loading host or project config. */
  async function openCodeModels({ refresh = false } = {}) {
    let nowMs = Date.now();
    if (!refresh && openCodeModelsCache.fetchedAt
      && nowMs - openCodeModelsCache.fetchedAt < OPENCODE_MODELS_TTL_MS) {
      return [...openCodeModelsCache.models];
    }
    if (openCodeModelsInFlight) {
      const active = openCodeModelsInFlight;
      if (!refresh) return active;
      await active.catch(() => []);
      if (openCodeModelsInFlight && openCodeModelsInFlight !== active) {
        return openCodeModelsInFlight;
      }
      nowMs = Date.now();
    }
    openCodeModelsInFlight = fetchOpenCodeModels(nowMs, refresh)
      .finally(() => { openCodeModelsInFlight = null; });
    return openCodeModelsInFlight;
  }

  async function fetchOpenCodeModels(nowMs, refresh = false) {
    const rememberFailure = () => {
      openCodeModelsCache = { models: openCodeModelsCache.models, fetchedAt: nowMs };
      return [...openCodeModelsCache.models];
    };
    try {
      await fs.mkdir(openCodeProbeHomeDir, { recursive: true, mode: 0o700 });
      const managedVersion = await installedVersion('opencode');
      const command = managedVersion ? binPath('opencode') : CLI_CONFIG.opencode.bin;
      const result = await run(command, refresh ? ['models', '--refresh'] : ['models'], {
        timeoutMs: OPENCODE_MODELS_TIMEOUT_MS,
        env: await openCodeProbeEnv(),
        maxStdoutBytes: STRUCTURED_STDOUT_LIMIT_BYTES,
        maxStderrBytes: STRUCTURED_STDERR_LIMIT_BYTES,
      });
      if (result.code !== 0) return rememberFailure();
      const models = [...new Set(
        stripTerminalEscapes(result.stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => isOpenCodeModelId(line)),
      )];
      openCodeModelsCache = { models, fetchedAt: nowMs };
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
    openCodeProbeHomeDir,
    openCodeSourceAuthFile,
    codexOAuthStagingDir,
    claudeOAuthStagingDir,
    binPath,
    envFor,
    grokAuthPath,
    cursorModels,
    openCodeAuthPath,
    openCodeModels,
    async init() {
      await fs.mkdir(rootDir, { recursive: true }).catch(() => {});
      await recoverInterruptedFileReplacement(configPath, { platform });
      await recoverInterruptedFileReplacement(secretsPath, { platform });
      await recoverInterruptedFileReplacement(path.join(grokHomeDir, 'auth.json'), { platform });
      for (const agent of Object.keys(CLI_CONFIG)) {
        await recoverOAuthJournal(agent);
      }
      // A hard crash cannot run the transaction finally path. Reap only
      // expired profiles whose recorded owner process is no longer alive.
      const stagingDirs = [codexOAuthStagingDir, openCodeOAuthStagingDir];
      if (platform !== 'darwin') stagingDirs.push(claudeOAuthStagingDir);
      if (platform === 'win32') stagingDirs.push(cursorOAuthStagingDir);
      await Promise.all(stagingDirs.map(
        (stagingDir) => cleanupStaleOAuthCredentialStaging(stagingDir).catch(() => {}),
      ));
      await load();
      return this;
    },
    status,
    install,
    authenticate,
    submitAuthCode,
    terminalSnapshot(agent) { return agent === 'opencode' ? openCodeTerminal?.snapshot() ?? null : null; },
    terminalInput(agent, data) { if (agent === 'opencode') openCodeTerminal?.write(data); },
    terminalResize(agent, cols, rows) { if (agent === 'opencode') openCodeTerminal?.resize(cols, rows); },
    async cancel(agent) {
      assertAgent(agent);
      if (agent === 'opencode' && openCodeTerminal) return openCodeTerminal.cancel().catch(() => false);
      if (activeProcesses.has(`auth:${agent}`)) cancelledAuth.add(agent);
      const entries = [`install:${agent}`, `auth:${agent}`]
        .map((key) => [key, activeProcesses.get(key)])
        .filter((entry) => Boolean(entry[1]));
      const results = await Promise.all(entries.map(async ([key, proc]) => {
        let cleanup = processCleanupPromises.get(proc);
        if (!cleanup) {
          cleanup = terminateAndWaitForProcessTreeExit(proc, {
            terminateProcess: terminateProcessTreeImpl,
            terminateOptions: {
              platform,
              spawnProcess,
              env: processEnvironments.get(proc) ?? baseEnv,
            },
          }).catch(() => false);
          processCleanupPromises.set(proc, cleanup);
        }
        const cleaned = await cleanup;
        if (!cleaned) activeProcesses.set(key, proc);
        return cleaned;
      }));
      return entries.length > 0 && results.every(Boolean);
    },
    automaticUpdate(agent, { canActivate = () => true } = {}) {
      return enqueuePrefixOp(() => runAutomaticUpdate(agent, canActivate));
    },
  };
}

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RAU_DEFAULT_MODEL_ID, RAU_LOCKED_MODELS } from '../rau-credits/catalog.mjs';
import { readUtf8FileBounded } from './bounded-file.mjs';
import { createOpenRouter } from './openrouter.mjs';
import {
  fetchLatestPackage,
  recoverInterruptedFileReplacement,
  replaceFileAtomically,
  updatePrefixAtomically,
} from './harness-update.mjs';
import { bundledNpmLaunch } from './npm-runtime.mjs';
import { API_KEY_MAX_BYTES, textFitsByteLimit } from './input-bounds.mjs';
import { cancelResponseBody, readResponseJsonBounded } from './response-bounds.mjs';
import {
  processTreeSpawnOptions,
  terminateAndWaitForProcessTreeExit,
  terminateProcessTree,
} from './process-tree.mjs';
import { setupFailureMessage, shouldUseNpmNetworkPath } from './setup-errors.mjs';

const require = createRequire(import.meta.url);
let crossSpawn = null;

/**
 * cross-spawn: Windows에서 npm .cmd 심을 인자 이스케이프 손상 없이 실행한다.
 * 스폰이 실제로 필요할 때 늦게 불러온다 — 스폰을 주입하는 쪽은 의존성이 없어도 된다.
 */
function spawn(command, argv, options) {
  crossSpawn ??= require('cross-spawn');
  return crossSpawn(command, argv, options);
}

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const CONFIG_FILE = 'config.json';
const CONFIG_VERSION = 1;
const MAX_MODELS = 3;
export const PI_MODEL_ID_MAX_CHARS = 256;
export const PI_MODEL_NAME_MAX_CHARS = 256;
export const PI_API_KEY_MAX_CHARS = API_KEY_MAX_BYTES;
export const PI_SETTINGS_MAX_BYTES = 64 * 1024;
const PI_PACKAGE_MANIFEST_MAX_BYTES = 1024 * 1024;
const PI_ACCOUNT_MAX_CHARS = 320;
/** OpenRouter 의 reasoning_effort 가 받는 값 — 우리는 이 셋만 노출한다. */
const EFFORTS = /** @type {const} */ (['low', 'medium', 'high']);
const DEFAULT_EFFORT = 'medium';
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
const STDERR_TAIL_LIMIT = 1_200;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 10_000;
const OAUTH_EXCHANGE_TIMEOUT_MS = 20_000;
const OAUTH_RESPONSE_LIMIT_BYTES = 64 * 1024;
export const PI_TARBALL_MAX_BYTES = 256 * 1024 * 1024;
const INSTALL_STDERR_LIMIT_BYTES = 64 * 1024;
/** 진행 이벤트는 이 간격으로만 내보낸다 — 청크마다 WS 를 두드리지 않는다. */
const PROGRESS_INTERVAL_MS = 150;
export const PI_SECRET_ID = 'rhwp.pi.openrouter-api-key';
export const RAU_SECRET_ID = 'rhwp.rau.openrouter-api-key';
const OPENROUTER_SECRET_ID = PI_SECRET_ID;
export { RAU_DEFAULT_MODEL_ID, RAU_LOCKED_MODELS };
const INSTALL_PROGRESS = Object.freeze({
  preparing: 8,
  downloadStart: 12,
  downloadEnd: 58,
  installStart: 64,
  installEnd: 86,
  configuring: 92,
  verifying: 97,
  done: 100,
});

/** 이 파일 기준 경로 — 확장/스킬은 저장소 안에 있고, pi 홈은 그것을 가리키기만 한다. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(MODULE_DIR, 'pi', 'extension', 'rhwp.ts');
const SUBAGENT_EXTENSION_PATH = path.join(MODULE_DIR, 'pi', 'extension', 'subagents.ts');
const SKILLS_SOURCE_DIR = path.join(MODULE_DIR, 'pi', 'skills');

/**
 * @typedef {Object} PiModelConfig
 * @property {string} id OpenRouter 모델 id
 * @property {string} name 사용자가 붙인 표시 이름
 * @property {boolean} reasoning
 * @property {boolean} supportsImages
 * @property {string[]} efforts
 * @property {string|null} defaultEffort
 * @property {number|null} contextLength
 * @property {{ prompt: number, completion: number }} pricing
 */

/**
 * @typedef {Object} PiStatus
 * @property {boolean} installed
 * @property {boolean} installing
 * @property {string|null} version
 * @property {boolean} keyConfigured
 * @property {string|null} keyTail
 * @property {string|null} account
 * @property {PiModelConfig[]} models
 * @property {string|null} defaultModelId
 * @property {boolean} setupComplete
 * @property {string|null} latestVersion
 * @property {boolean} updateRequired
 * @property {string|null} error
 */

function piError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfAuthCancelled(signal) {
  if (signal?.aborted) {
    throw piError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.');
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

function modelRollbackError(original, rollback) {
  const error = new AggregateError(
    [original, rollback],
    'Model configuration failed and its settings rollback also failed.',
    { cause: original },
  );
  error.code = 'PI_MODELS_ROLLBACK_FAILED';
  return error;
}

function stderrTail(text) {
  return String(text ?? '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' / ')
    .slice(-STDERR_TAIL_LIMIT);
}

function appendUtf8Tail(current, chunk, maxBytes) {
  const combined = Buffer.concat([Buffer.from(current, 'utf8'), Buffer.from(chunk)]);
  if (combined.byteLength <= maxBytes) return combined.toString('utf8');
  let start = combined.byteLength - maxBytes;
  while (start < combined.byteLength && (combined[start] & 0xc0) === 0x80) start += 1;
  return combined.subarray(start).toString('utf8');
}

/** 토큰 1개당 USD → 100만 토큰당 USD. 부동소수 찌꺼기는 6자리에서 자른다. */
function perMillion(price) {
  return Math.round(Number(price) * 1e12) / 1e6;
}

function keyTailOf(key) {
  const trimmed = String(key ?? '').trim();
  return trimmed ? trimmed.slice(-4) : null;
}

/** 저장된 로그인 계정 — 이메일 형식이 아니면 버린다. */
function storedAccount(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0
    && value.length <= PI_ACCOUNT_MAX_CHARS
    && value.includes('@')
    && !/[\x00-\x1f\x7f]/u.test(value)
    ? value
    : null;
}

function normalizedModelId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0
    && value.length <= PI_MODEL_ID_MAX_CHARS
    && !/[\s\x00-\x1f\x7f]/u.test(value)
    ? value
    : null;
}

function normalizedModelName(raw, fallback) {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
  return typeof value === 'string'
    && value.length > 0
    && value.length <= PI_MODEL_NAME_MAX_CHARS
    && !/[\x00-\x1f\x7f]/u.test(value)
    ? value
    : null;
}

async function boundedJsonResponse(response, limit = OAUTH_RESPONSE_LIMIT_BYTES) {
  try {
    return await readResponseJsonBounded(response, {
      maxBytes: limit,
      label: 'OpenRouter OAuth response',
    }) ?? {};
  } catch (error) {
    if (error?.code === 'RESPONSE_BODY_TOO_LARGE') {
      throw piError('OPENROUTER_OAUTH_RESPONSE_TOO_LARGE', 'OpenRouter 로그인 응답이 너무 커요');
    }
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

/** reasoning 모델에만 붙는다 — pi 의 thinking 레벨을 OpenRouter effort 로 매핑한다. */
function thinkingLevelMap() {
  return {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: null,
    max: null,
  };
}

export function defaultPiRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (env.RHWP_PI_DIR) return platformPath.resolve(env.RHWP_PI_DIR);
  if (platform === 'darwin') return platformPath.join(home, 'Library', 'Application Support', 'rhwp', 'pi');
  if (platform === 'win32') {
    return platformPath.join(env.APPDATA || platformPath.join(home, 'AppData', 'Roaming'), 'rhwp', 'pi');
  }
  return platformPath.join(env.XDG_DATA_HOME || platformPath.join(home, '.local', 'share'), 'rhwp', 'pi');
}

export function defaultRauRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (env.RHWP_RAU_DIR) return platformPath.resolve(env.RHWP_RAU_DIR);
  if (platform === 'darwin') return platformPath.join(home, 'Library', 'Application Support', 'rhwp', 'rau');
  if (platform === 'win32') {
    return platformPath.join(env.APPDATA || platformPath.join(home, 'AppData', 'Roaming'), 'rhwp', 'rau');
  }
  return platformPath.join(env.XDG_DATA_HOME || platformPath.join(home, '.local', 'share'), 'rhwp', 'rau');
}

/**
 * pi CLI 설치본과 그 에이전트 홈(모델·키·스킬)을 관리한다.
 * 설치는 single-flight 이고, 루트가 없어도 status() 는 그냥 미설치로 답한다.
 *
 * @param {{ rootDir?: string, prefixDir?: string, spawnProcess?: typeof spawn, fetchImpl?: typeof fetch,
 *           now?: () => number, openRouter?: ReturnType<typeof createOpenRouter>,
 *           npmCommand?: string, nodeCommand?: string, packageSpec?: string, platform?: string,
 *           baseEnv?: NodeJS.ProcessEnv, secretStore?: object, secretId?: string,
 *           lockedModels?: readonly object[] | null, skipLegacyKey?: boolean,
 *           providerBaseUrl?: string, credentialPrefix?: string|null,
 *           tarballMaxBytes?: number, oauthExchangeTimeoutMs?: number,
 *           replaceFile?: typeof replaceFileAtomically }} [deps]
 */
export function createPiManager({
  rootDir = defaultPiRoot(),
  prefixDir: prefixDirOverride = null,
  spawnProcess = spawn,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  openRouter = null,
  npmCommand = null,
  nodeCommand = process.execPath,
  packageSpec = PI_PACKAGE,
  platform = process.platform,
  baseEnv = process.env,
  secretStore = null,
  secretId = OPENROUTER_SECRET_ID,
  lockedModels = null,
  skipLegacyKey = false,
  providerBaseUrl = 'https://openrouter.ai/api/v1',
  credentialPrefix = null,
  tarballMaxBytes = PI_TARBALL_MAX_BYTES,
  oauthExchangeTimeoutMs = OAUTH_EXCHANGE_TIMEOUT_MS,
  replaceFile = replaceFileAtomically,
} = {}) {
  const tarballLimitBytes = Number.isSafeInteger(tarballMaxBytes) && tarballMaxBytes > 0
    ? Math.min(tarballMaxBytes, PI_TARBALL_MAX_BYTES)
    : PI_TARBALL_MAX_BYTES;
  const oauthTimeoutMs = Number.isSafeInteger(oauthExchangeTimeoutMs) && oauthExchangeTimeoutMs > 0
    ? Math.min(oauthExchangeTimeoutMs, OAUTH_EXCHANGE_TIMEOUT_MS)
    : OAUTH_EXCHANGE_TIMEOUT_MS;
  const prefixDir = prefixDirOverride ?? path.join(rootDir, 'prefix');
  const locked = Array.isArray(lockedModels) && lockedModels.length > 0
    ? lockedModels.map((model) => ({ ...model, pricing: { ...model.pricing } }))
    : null;
  const modelCap = locked ? locked.length : MAX_MODELS;
  const agentDir = path.join(rootDir, 'agent');
  const sessionsDir = path.join(rootDir, 'sessions');
  const configPath = path.join(rootDir, CONFIG_FILE);
  const modelsPath = path.join(agentDir, 'models.json');
  const settingsPath = path.join(agentDir, 'settings.json');
  const skillsDir = path.join(agentDir, 'skills');
  const piBin = path.join(prefixDir, 'node_modules', '.bin', platform === 'win32' ? 'pi.cmd' : 'pi');
  const packageJsonPath = (basePrefix = prefixDir) => path.join(
    basePrefix, 'node_modules', ...packageSpec.split('/'), 'package.json',
  );
  const client = openRouter ?? createOpenRouter({ fetchImpl, now, cacheDir: rootDir });
  const npmLaunch = bundledNpmLaunch({ nodeCommand, npmCommand });

  let config = {
    version: CONFIG_VERSION,
    installedVersion: null,
    keyTail: null,
    /** 로그인한 계정 이메일 — Rau 체험 로그인이 알려 준다. */
    account: null,
    models: [],
    defaultModelId: null,
    setupComplete: false,
  };
  /** 실제 키는 Electron의 OS-backed vault 안에만 산다. */
  let apiKey = null;
  /** @type {Promise<void> | null} 첫 로드는 한 번만 돈다 — 동시에 들어와도 공유한다. */
  let loadPromise = null;
  let installedVersion = null;
  let installing = false;
  let lastError = null;
  let latestVersion = null;
  let updateRequired = false;
  let secretStoreError = null;
  /** @type {Promise<PiStatus> | null} */
  let installInFlight = null;
  let installProcess = null;
  const installCleanupPromises = new WeakMap();
  /** @type {Set<(progress: { state: string, detail?: string }) => void>} */
  const installListeners = new Set();
  /** 설정 파일 쓰기는 직렬화한다 — 키/모델 갱신이 겹쳐도 순서가 흐트러지지 않도록. */
  let writeChain = Promise.resolve();
  let tempSeq = 0;
  /** 진행 중인 OpenRouter PKCE 로그인. 브라우저 콜백이 오면 한 번만 소비한다. */
  let oauthFlow = null;

  async function writeAtomic(file, text, mode = 0o600) {
    if (Buffer.byteLength(text, 'utf8') > PI_SETTINGS_MAX_BYTES) {
      throw piError(
        'PI_SETTINGS_TOO_LARGE',
        `Pi 설정 파일은 ${PI_SETTINGS_MAX_BYTES}바이트를 넘을 수 없어요`,
      );
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${now()}-${(tempSeq += 1)}`;
    try {
      await fs.writeFile(temp, text, { encoding: 'utf8', mode, flag: 'wx' });
      await replaceFile(temp, file, { platform });
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  function serialized(task) {
    const next = writeChain.then(task, task);
    writeChain = next.then(() => {}, () => {});
    return next;
  }

  function normalizeStoredModel(raw) {
    const id = normalizedModelId(raw?.id);
    if (!id) return null;
    const name = normalizedModelName(raw?.name, id);
    if (!name) return null;
    const reasoning = Boolean(raw.reasoning);
    const efforts = reasoning && Array.isArray(raw.efforts)
      ? raw.efforts.filter((effort) => EFFORTS.includes(effort))
      : (reasoning ? [...EFFORTS] : []);
    const defaultEffort = efforts.includes(raw.defaultEffort)
      ? raw.defaultEffort
      : (efforts.length > 0 ? DEFAULT_EFFORT : null);
    const contextLength = Number(raw.contextLength);
    return {
      id,
      name,
      reasoning,
      supportsImages: raw.supportsImages === true,
      efforts,
      defaultEffort,
      contextLength: Number.isFinite(contextLength) && contextLength > 0 ? Math.round(contextLength) : null,
      pricing: {
        prompt: Number(raw?.pricing?.prompt) || 0,
        completion: Number(raw?.pricing?.completion) || 0,
      },
    };
  }

  async function readInstalledVersion(basePrefix = prefixDir) {
    try {
      const raw = JSON.parse(await readUtf8FileBounded(packageJsonPath(basePrefix), {
        maxBytes: PI_PACKAGE_MANIFEST_MAX_BYTES,
        label: 'Pi package manifest',
        platform,
      }));
      return typeof raw?.version === 'string' && raw.version ? raw.version : null;
    } catch {
      return null;
    }
  }

  async function readLegacyStoredKey() {
    try {
      const raw = JSON.parse(await readUtf8FileBounded(modelsPath, {
        maxBytes: PI_SETTINGS_MAX_BYTES,
        label: 'Pi models config',
        platform,
      }));
      const key = raw?.providers?.openrouter?.apiKey;
      if (!textFitsByteLimit(key, API_KEY_MAX_BYTES)) return null;
      const trimmed = key.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  async function readConfig() {
    let discardedCredential = false;
    try {
      const raw = JSON.parse(await readUtf8FileBounded(configPath, {
        maxBytes: PI_SETTINGS_MAX_BYTES,
        label: 'Pi config',
        platform,
      }));
      const models = (Array.isArray(raw?.models) ? raw.models : [])
        .map(normalizeStoredModel)
        .filter(Boolean)
        .slice(0, modelCap);
      const defaultModelId = models.some((model) => model.id === raw?.defaultModelId)
        ? raw.defaultModelId
        : (models[0]?.id ?? null);
      config = {
        version: CONFIG_VERSION,
        installedVersion: typeof raw?.installedVersion === 'string' ? raw.installedVersion : null,
        keyTail: typeof raw?.keyTail === 'string' ? raw.keyTail : null,
        account: storedAccount(raw?.account),
        models,
        defaultModelId,
        setupComplete: false,
      };
    } catch {
      // 설정 파일이 없거나 깨졌으면 빈 상태로 시작한다.
    }
    const legacyKey = skipLegacyKey ? null : await readLegacyStoredKey();
    if (secretStore?.available) {
      try {
        const stored = await secretStore.get(secretId);
        if (stored != null && (!textFitsByteLimit(stored, API_KEY_MAX_BYTES) || !stored.trim())) {
          throw piError('OPENROUTER_KEY_TOO_LARGE', '저장된 OpenRouter 키가 허용된 길이를 넘었어요');
        }
        apiKey = stored?.trim() || null;
        if (!apiKey && legacyKey) {
          await secretStore.set(secretId, legacyKey);
          const migrated = await secretStore.get(secretId);
          apiKey = textFitsByteLimit(migrated, API_KEY_MAX_BYTES) ? migrated.trim() : null;
          if (apiKey === legacyKey) await writeModelsJson();
        }
      } catch (error) {
        apiKey = legacyKey;
        secretStoreError = error?.message ?? 'OS 보안 저장소를 열지 못했어요.';
      }
    } else {
      // Preserve access until the desktop vault can migrate it; new keys are never stored here.
      apiKey = legacyKey;
    }
    // Rau used to persist a reusable OpenRouter key. Proxy-backed builds accept
    // only revocable Rau tokens and remove the old secret during migration.
    if (apiKey && credentialPrefix && !apiKey.startsWith(credentialPrefix)) {
      if (secretStore?.available) {
        try { await secretStore.delete(secretId); }
        catch (error) { secretStoreError = error?.message ?? '이전 자격증명을 지우지 못했어요.'; }
      }
      apiKey = null;
      config.keyTail = null;
      config.account = null;
      discardedCredential = true;
    }
    if (locked) {
      config.models = locked.map((model) => normalizeStoredModel(model)).filter(Boolean);
      config.defaultModelId = config.models.some((model) => model.id === config.defaultModelId)
        ? config.defaultModelId
        : (config.models.find((model) => model.id === RAU_DEFAULT_MODEL_ID)?.id ?? config.models[0]?.id ?? null);
    }
    installedVersion = await readInstalledVersion();
    config.setupComplete = Boolean(apiKey) && config.models.length > 0;
    if (discardedCredential) {
      await writeModelsJson();
      await persistConfig();
    }
  }

  function load() {
    if (!loadPromise) loadPromise = readConfig();
    return loadPromise;
  }

  function persistConfig() {
    const payload = {
      version: CONFIG_VERSION,
      installedVersion: installedVersion ?? config.installedVersion ?? null,
      keyTail: config.keyTail,
      account: config.account,
      models: config.models,
      defaultModelId: config.defaultModelId,
      setupComplete: config.setupComplete,
    };
    return writeAtomic(configPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  /** agent/models.json에는 비밀이 아닌 모델 설정만 쓴다. */
  async function writeModelsJson() {
    const provider = {
      baseUrl: providerBaseUrl,
      api: 'openai-completions',
      models: config.models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: model.supportsImages ? ['text', 'image'] : ['text'],
        contextWindow: model.contextLength ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        ...(model.reasoning ? { thinkingLevelMap: thinkingLevelMap() } : {}),
        cost: {
          // OpenRouter 는 토큰 1개당 USD, pi 는 100만 토큰당 USD 를 쓴다.
          input: perMillion(model.pricing.prompt),
          output: perMillion(model.pricing.completion),
          cacheRead: 0,
          cacheWrite: 0,
        },
      })),
    };
    // Vault가 없거나 현재 열리지 않으면 legacy 키를 보존한다. transport가
    // available이라고 광고하는 것만으로 유일한 사용 가능 복사본을 지우면 안 된다.
    // 검증된 vault 읽기/쓰기가 성공해 secretStoreError가 사라진 뒤에만 scrub한다.
    if (apiKey && (!secretStore?.available || secretStoreError)) provider.apiKey = apiKey;
    const payload = { providers: { openrouter: provider } };
    await writeAtomic(modelsPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  function snapshotSettingsState() {
    return {
      apiKey,
      config: structuredClone(config),
      secretStoreError,
      vaultSnapshot: /** @type {{ present: boolean, value: unknown } | null} */ (null),
    };
  }

  async function captureVaultSnapshot(previous) {
    if (!secretStore?.available) return;
    const value = await secretStore.get(secretId);
    previous.vaultSnapshot = {
      present: value !== null && value !== undefined,
      value,
    };
  }

  async function rollbackSettingsState(previous, {
    restoreSecret = false,
    restoreFiles = true,
    clearClientCache = false,
  } = {}) {
    apiKey = previous.apiKey;
    config = structuredClone(previous.config);
    secretStoreError = previous.secretStoreError;
    const rollbackErrors = [];
    if (restoreSecret && secretStore?.available) {
      try {
        if (!previous.vaultSnapshot) {
          throw new Error('Cannot restore a vault value that was not snapshotted.');
        }
        if (previous.vaultSnapshot.present) {
          await secretStore.set(secretId, previous.vaultSnapshot.value);
        } else {
          await secretStore.delete(secretId);
        }
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (restoreFiles) {
      try { await writeModelsJson(); } catch (error) { rollbackErrors.push(error); }
      try { await persistConfig(); } catch (error) { rollbackErrors.push(error); }
    }
    if (clearClientCache) {
      try { client.clearCache(); } catch (error) { rollbackErrors.push(error); }
    }
    return rollbackErrors;
  }

  /**
   * 레지스트리에서 최신 타르볼 주소와 무결성 해시를 알아낸다.
   * 버전이 박힌 스펙이면 npm 에 그대로 맡기려고 null 을 돌려준다.
   */
  async function resolveDist() {
    if (packageSpec.lastIndexOf('@') > 0) return null;
    const dist = await fetchLatestPackage(fetchImpl, packageSpec, REGISTRY_TIMEOUT_MS);
    if (!dist.tarball) throw new Error('registry: tarball 주소가 없어요');
    return dist;
  }

  /**
   * 타르볼을 직접 내려받아 바이트 단위 진행률을 emit 한다. content-length 가 없으면
   * totalBytes 는 null 이고, UI 는 새 바이트가 올 때만 움직이는 막대로 처리한다.
   * 무결성 실패는 PI_INSTALL_FAILED 로 던진다 — npm 폴백으로 넘어가지 않는다.
   */
  async function downloadTarball(dist, emit) {
    // 무결성 메타데이터가 없으면 검증 없이 설치하는 셈이므로 실패로 처리한다.
    if (!dist.integrity?.startsWith('sha512-')) {
      throw piError('PI_INSTALL_FAILED', 'pi 패키지 무결성 정보가 없어 설치할 수 없어요');
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, INSTALL_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(dist.tarball, { signal: controller.signal });
    } catch (error) {
      clearTimeout(timeout);
      if (timedOut || error?.name === 'AbortError') {
        throw piError('PI_INSTALL_FAILED', 'pi 패키지 다운로드가 제한 시간 안에 끝나지 않았어요');
      }
      throw error;
    }
    if (!response.ok || !response.body) {
      clearTimeout(timeout);
      const error = new Error(`tarball HTTP ${response.status}`);
      await cancelResponseBody(response, error);
      throw error;
    }
    const declared = Number(response.headers?.get?.('content-length'));
    const totalBytes = Number.isSafeInteger(declared) && declared > 0 ? declared : null;
    if (totalBytes !== null && totalBytes > tarballLimitBytes) {
      const error = piError('PI_INSTALL_FAILED', 'pi 패키지가 256 MiB 다운로드 한도를 초과해요');
      controller.abort(error);
      try { await response.body.cancel?.(error); } catch {}
      clearTimeout(timeout);
      throw error;
    }
    const cacheDir = path.join(rootDir, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const filePath = path.join(cacheDir, 'pi-package.tgz');
    const hash = createHash('sha512');
    let receivedBytes = 0;
    let lastEmit = 0;
    const handle = await fs.open(filePath, 'w', 0o600);
    let reader = null;
    try {
      const consume = async (rawChunk) => {
        const chunk = Buffer.from(rawChunk);
        receivedBytes += chunk.length;
        if (receivedBytes > tarballLimitBytes) {
          const error = piError('PI_INSTALL_FAILED', 'pi 패키지가 256 MiB 다운로드 한도를 초과해요');
          controller.abort(error);
          try { await reader?.cancel?.(error); } catch {}
          throw error;
        }
        hash.update(chunk);
        await handle.write(chunk);
        const ts = now();
        if (ts - lastEmit >= PROGRESS_INTERVAL_MS) {
          lastEmit = ts;
          const percent = totalBytes
            ? INSTALL_PROGRESS.downloadStart
              + Math.min(1, receivedBytes / totalBytes)
                * (INSTALL_PROGRESS.downloadEnd - INSTALL_PROGRESS.downloadStart)
            : undefined;
          emit({
            state: 'downloading',
            receivedBytes,
            totalBytes,
            ...(Number.isFinite(percent) ? { percent } : {}),
          });
        }
      };
      if (response.body.getReader) {
        reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await consume(value);
        }
      } else {
        for await (const rawChunk of response.body) await consume(rawChunk);
      }
    } catch (error) {
      controller.abort(error);
      try { await response.body.cancel?.(error); } catch {}
      await handle.close().catch(() => {});
      await fs.unlink(filePath).catch(() => {});
      if (timedOut || error?.name === 'AbortError') {
        throw piError('PI_INSTALL_FAILED', 'pi 패키지 다운로드가 제한 시간 안에 끝나지 않았어요');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      reader?.releaseLock?.();
      await handle.close().catch(() => {});
    }
    if (`sha512-${hash.digest('base64')}` !== dist.integrity) {
      await fs.unlink(filePath).catch(() => {});
      throw piError('PI_INSTALL_FAILED', '내려받은 pi 패키지가 무결성 검증에 실패했어요');
    }
    emit({
      state: 'downloading',
      receivedBytes,
      totalBytes: totalBytes ?? receivedBytes,
      percent: INSTALL_PROGRESS.downloadEnd,
    });
    return filePath;
  }

  function runNpmInstall(emit, localTarball = null, targetPrefix = prefixDir) {
    return new Promise((resolve, reject) => {
      const argv = [
        'install', '--prefix', targetPrefix, '--no-fund', '--no-audit',
        // 폴백(npm 이 직접 내려받는) 경로에서는 http 로그가 활동 신호가 된다.
        localTarball ? '--loglevel=error' : '--loglevel=http',
        localTarball ?? packageSpec,
      ];
      let settled = false;
      let stderrText = '';
      let lastActivity = 0;
      let activityPercent = INSTALL_PROGRESS.installStart;
      let forcedError = null;
      /** @type {NodeJS.Timeout | null} */
      let timer = null;

      const done = (error, { retainProcess = false } = {}) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (!retainProcess && installProcess === proc) installProcess = null;
        if (error) reject(error);
        else resolve();
      };

      let proc;
      try {
        proc = spawnProcess(npmLaunch.command, [...npmLaunch.leadingArgs, ...argv], {
          ...processTreeSpawnOptions(platform),
          stdio: ['ignore', 'pipe', 'pipe'], env: baseEnv,
        });
      } catch (error) {
        done(piError('PI_INSTALL_FAILED', setupFailureMessage(error, '', 'npm 실행에 실패했어요.')));
        return;
      }
      installProcess = proc;

      const cleanupProcess = () => {
        const current = installCleanupPromises.get(proc);
        if (current) return current;
        const cleanup = terminateAndWaitForProcessTreeExit(proc, {
          terminateProcess: terminateProcessTree,
          terminateOptions: { platform, spawnProcess, env: baseEnv },
        }).catch(() => false);
        installCleanupPromises.set(proc, cleanup);
        return cleanup;
      };
      const cleanupError = () => {
        const error = piError(
          'PI_INSTALL_CLEANUP_UNCERTAIN',
          'npm install 프로세스의 종료를 확인하지 못했어요. 앱을 다시 시작한 뒤 상태를 확인해 주세요.',
        );
        error.processCleanupUncertain = true;
        return error;
      };
      const finishAfterCleanup = (error) => {
        void cleanupProcess().then((cleaned) => {
          if (!cleaned) {
            done(cleanupError(), { retainProcess: true });
            return;
          }
          done(error);
        });
      };

      timer = setTimeout(() => {
        forcedError = piError('PI_INSTALL_FAILED', 'npm install 이 10분 안에 끝나지 않았어요');
        finishAfterCleanup(forcedError);
      }, INSTALL_TIMEOUT_MS);

      // npm 출력이 나올 때마다 "일이 진행 중" 신호를 흘린다 — 멈추면 UI 막대도 멈춘다.
      const noteActivity = () => {
        const ts = now();
        if (ts - lastActivity < PROGRESS_INTERVAL_MS) return;
        lastActivity = ts;
        activityPercent = Math.min(INSTALL_PROGRESS.installEnd, activityPercent + 1.5);
        emit({ state: 'installing', percent: activityPercent, activity: true });
      };
      proc.stdout?.on?.('data', noteActivity);
      proc.stdout?.on?.('error', () => {});
      proc.stderr?.on?.('data', (chunk) => {
        noteActivity();
        stderrText = appendUtf8Tail(stderrText, chunk, INSTALL_STDERR_LIMIT_BYTES);
      });
      proc.stderr?.on?.('error', () => {});
      proc.on('error', (error) => {
        if (forcedError) return;
        const hint = setupFailureMessage(error, '', '번들된 npm 런타임을 시작하지 못했어요.');
        const failure = piError('PI_INSTALL_FAILED', hint);
        if (installCleanupPromises.has(proc)) finishAfterCleanup(failure);
        else done(failure);
      });
      const finish = (code, signal) => {
        if (forcedError) return;
        let error = null;
        if (code === 0) {
          error = null;
        } else {
          const exit = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
          const detail = stderrTail(stderrText);
          error = piError(
            'PI_INSTALL_FAILED',
            setupFailureMessage(null, detail, `pi 설치가 실패했어요 (${exit})`),
          );
        }
        if (installCleanupPromises.has(proc)) finishAfterCleanup(error);
        else done(error);
      };
      proc.on('close', finish);
      // 일부 스텁/플랫폼은 close 없이 exit 만 낸다 — 한 틱 늦춰 마감한다.
      proc.on('exit', (code, signal) => setImmediate(() => finish(code, signal)));
    });
  }

  function currentStatus() {
    return {
      installed: Boolean(installedVersion),
      installing,
      version: installedVersion,
      keyConfigured: Boolean(apiKey),
      keyTail: apiKey ? keyTailOf(apiKey) : null,
      account: config.account,
      models: config.models.map((model) => ({ ...model, pricing: { ...model.pricing } })),
      defaultModelId: config.defaultModelId,
      setupComplete: config.setupComplete,
      latestVersion,
      updateRequired,
      error: lastError ?? secretStoreError,
    };
  }

  async function syncAssets() {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await writeAtomic(settingsPath, `${JSON.stringify({
      defaultProjectTrust: 'never',
      enableSkillCommands: false,
      enableInstallTelemetry: false,
      extensions: [EXTENSION_PATH, SUBAGENT_EXTENSION_PATH],
    }, null, 2)}\n`);
    try {
      await fs.cp(SKILLS_SOURCE_DIR, skillsDir, { recursive: true, force: true });
    } catch (error) {
      // 스킬 디렉터리는 아직 없을 수 있다 — 없으면 그냥 넘어간다.
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  return {
    rootDir,
    prefixDir,
    agentDir,
    sessionsDir,
    configPath,
    modelsPath,
    settingsPath,
    piBin,
    extensionPath: EXTENSION_PATH,
    subagentExtensionPath: SUBAGENT_EXTENSION_PATH,

    /** 루트를 만들고 저장된 설정을 읽는다. 루트가 없어도 실패하지 않는다. */
    async init() {
      await fs.mkdir(rootDir, { recursive: true }).catch(() => {});
      await recoverInterruptedFileReplacement(configPath, { platform });
      await recoverInterruptedFileReplacement(modelsPath, { platform });
      await load();
      return this;
    },

    /** 스폰 없이 파일만 본다 — 부팅/웰컴 푸시에서 자주 불린다. */
    async status() {
      await load();
      installedVersion = await readInstalledVersion();
      return currentStatus();
    },

    /**
     * pi CLI 를 설치하고 확장/스킬/설정을 동기화한다. 동시에 부르면 하나만 돈다.
     *
     * @param {(progress: { state: string, detail?: string, percent?: number,
     *   receivedBytes?: number, totalBytes?: number|null, activity?: boolean }) => void} [onProgress]
     * @returns {Promise<PiStatus>}
     */
    async install(onProgress) {
      if (typeof onProgress === 'function') installListeners.add(onProgress);
      const emit = (progress) => {
        for (const listener of installListeners) {
          try { listener(progress); } catch {}
        }
      };
      if (installInFlight) {
        try {
          return await installInFlight;
        } finally {
          if (typeof onProgress === 'function') installListeners.delete(onProgress);
        }
      }
      if (installProcess) {
        throw piError(
          'PI_INSTALL_CLEANUP_PENDING',
          '이전 npm install 프로세스의 종료를 확인하지 못했어요. 앱을 다시 시작한 뒤 재시도해 주세요.',
        );
      }
      installing = true;
      lastError = null;
      // await 없이 곧바로 in-flight 를 세워야 동시에 들어온 호출이 하나로 합쳐진다.
      const running = (async () => {
        try {
          await load();
          emit({ state: 'preparing', percent: INSTALL_PROGRESS.preparing });
          await fs.mkdir(prefixDir, { recursive: true });
          // 결정적 진행률: 타르볼을 직접 받아 바이트를 센다. 레지스트리/네트워크가
          // 협조하지 않으면 npm 폴백으로 넘어가 활동 신호만 흘린다.
          let tarballPath = null;
          try {
            emit({ state: 'downloading', percent: INSTALL_PROGRESS.downloadStart });
            const dist = shouldUseNpmNetworkPath(baseEnv) ? null : await resolveDist();
            if (dist) tarballPath = await downloadTarball(dist, emit);
          } catch (error) {
            if (error?.code === 'PI_INSTALL_FAILED') throw error; // 무결성 실패는 폴백 금지
            tarballPath = null;
          }
          emit({ state: 'installing', percent: INSTALL_PROGRESS.installStart });
          await runNpmInstall(emit, tarballPath);
          if (tarballPath) await fs.unlink(tarballPath).catch(() => {});
          emit({ state: 'configuring', percent: INSTALL_PROGRESS.configuring });
          await syncAssets();
          emit({ state: 'verifying', percent: INSTALL_PROGRESS.verifying });
          installedVersion = await readInstalledVersion();
          if (latestVersion === installedVersion) updateRequired = false;
          config.installedVersion = installedVersion;
          config.setupComplete = Boolean(apiKey) && config.models.length > 0;
          await serialized(() => persistConfig());
          installing = false;
          emit({ state: 'done', detail: installedVersion ?? undefined, percent: INSTALL_PROGRESS.done });
          return currentStatus();
        } catch (error) {
          lastError = error?.message ?? String(error);
          throw error;
        } finally {
          installing = false;
        }
      })();
      installInFlight = running;
      try {
        return await running;
      } finally {
        if (installInFlight === running) installInFlight = null;
        if (typeof onProgress === 'function') installListeners.delete(onProgress);
      }
    },

    /** 앱 관리 Pi CLI 를 확인하고, 실패해도 현재 prefix 는 그대로 둔다. */
    async automaticUpdate({ canActivate = () => true } = {}) {
      await load();
      if (!installedVersion) return currentStatus();

      let dist;
      try {
        dist = await resolveDist();
      } catch {
        return currentStatus();
      }
      if (!dist) return currentStatus();
      latestVersion = dist.version;
      updateRequired = latestVersion !== installedVersion;
      if (!updateRequired) return currentStatus();

      let tarballPath = null;
      let cleanupUncertain = false;
      try {
        tarballPath = await downloadTarball(dist, () => {});
        await updatePrefixAtomically({
          prefixDir,
          label: 'pi',
          platform,
          canActivate,
          install: (stagingDir) => runNpmInstall(() => {}, tarballPath, stagingDir),
          verify: async (stagingDir) => {
            if (await readInstalledVersion(stagingDir) !== latestVersion) {
              throw piError('PI_UPDATE_FAILED', 'updated harness version did not verify');
            }
          },
        });
        installedVersion = await readInstalledVersion();
        config.installedVersion = installedVersion;
        updateRequired = installedVersion !== latestVersion;
        await serialized(() => persistConfig());
      } catch (error) {
        cleanupUncertain = error?.processCleanupUncertain === true;
        installedVersion = await readInstalledVersion();
        updateRequired = installedVersion !== latestVersion;
      } finally {
        if (tarballPath && !cleanupUncertain) await fs.unlink(tarballPath).catch(() => {});
      }
      return currentStatus();
    },

    /** 확장 경로가 담긴 settings.json 을 쓰고 저장소 스킬을 pi 홈으로 복사한다. */
    async syncAssets() {
      await load();
      await serialized(() => syncAssets());
      return currentStatus();
    },

    /**
     * OpenRouter 키를 확인하고 OS-backed vault에 저장한다.
     *
     * @param {string} key
     * @param {{ account?: string|null, signal?: AbortSignal, onCommitted?: () => void }} [opts]
     * 로그인한 계정 이메일과 취소 신호 (Rau 체험 로그인).
     */
    async setApiKey(key, { account = null, signal, onCommitted } = {}) {
      if (typeof key !== 'string') {
        throw piError('OPENROUTER_KEY_INVALID', 'OpenRouter 키를 입력하세요');
      }
      const rawKey = key;
      if (!textFitsByteLimit(rawKey, API_KEY_MAX_BYTES)) {
        throw piError('OPENROUTER_KEY_TOO_LARGE', 'OpenRouter 키가 허용된 길이를 넘었어요');
      }
      const trimmed = rawKey.trim();
      if (!trimmed) throw piError('OPENROUTER_KEY_INVALID', 'OpenRouter 키를 입력하세요');
      if (credentialPrefix && !trimmed.startsWith(credentialPrefix)) {
        throw piError('OPENROUTER_KEY_INVALID', 'Rau 접근 토큰 형식을 확인할 수 없어요');
      }
      await load();
      throwIfAuthCancelled(signal);
      const check = await client.validateKey(trimmed);
      throwIfAuthCancelled(signal);
      if (!check.valid) throw piError('OPENROUTER_KEY_INVALID', 'OpenRouter 키가 거절됐어요');
      await serialized(async () => {
        // Validation runs outside the write queue. Snapshot only after entering it so a
        // cancelled rollback can never overwrite a newer queued settings change.
        const previous = snapshotSettingsState();
        // readConfig may have fallen back after a transient vault read failure. Capture
        // the actual current value here, before mutation, so rollback never substitutes
        // stale in-memory state for a different credential that is still in the vault.
        await captureVaultSnapshot(previous);
        let commitStarted = false;
        try {
          throwIfAuthCancelled(signal);
          // 보안 저장소가 없으면 models.json(0600)에 보관한다. load() 가 읽고, vault 가
          // 생기면 기존 이관 경로가 vault 로 옮긴 뒤 파일에서 지운다.
          if (secretStore?.available) {
            throwIfAuthCancelled(signal);
            commitStarted = true;
            await secretStore.set(secretId, trimmed);
            throwIfAuthCancelled(signal);
          }
          throwIfAuthCancelled(signal);
          commitStarted = true;
          apiKey = trimmed;
          secretStoreError = null;
          config.keyTail = keyTailOf(trimmed);
          // 계정이 함께 오면 갱신한다. 없으면(API 키 직접 입력) 이전 값을 지운다.
          config.account = storedAccount(account);
          if (locked && config.models.length === 0) {
            config.models = locked.map((model) => normalizeStoredModel(model)).filter(Boolean);
            config.defaultModelId = config.models.find((model) => model.id === RAU_DEFAULT_MODEL_ID)?.id
              ?? config.models[0]?.id ?? null;
          }
          config.setupComplete = config.models.length > 0;
          throwIfAuthCancelled(signal);
          await writeModelsJson();
          throwIfAuthCancelled(signal);
          await persistConfig();
          throwIfAuthCancelled(signal);
          onCommitted?.();
        } catch (error) {
          if (!commitStarted) throw error;
          // Any failure can land after an async vault/file write has taken effect. Restore
          // the exact pre-run state before releasing the write queue; the transaction is
          // not committed until onCommitted returns.
          const rollbackErrors = await rollbackSettingsState(previous, {
            restoreSecret: true,
            clearClientCache: true,
          });
          if (rollbackErrors.length > 0) {
            throw authRollbackError(
              error,
              new AggregateError(rollbackErrors, 'One or more credential rollback steps failed.'),
            );
          }
          throw error;
        }
      });
      client.clearCache();
      return currentStatus();
    },

    /** OpenRouter PKCE 로그인 URL을 만든다. 키 교환은 completeOAuth가 맡는다. */
    beginOAuth(callbackUrl) {
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const state = randomBytes(18).toString('base64url');
      oauthFlow = { verifier, state, createdAt: now() };
      const url = new URL('https://openrouter.ai/auth');
      const callback = new URL(callbackUrl);
      callback.searchParams.set('state', state);
      url.searchParams.set('callback_url', callback.toString());
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      return { authUrl: url.toString(), state };
    },

    /**
     * 브라우저 콜백의 일회용 코드를 OpenRouter API 키로 바꾸고 기존 키 저장 경로를 탄다.
     * @param {string} code
     * @param {string} state
     * @param {{ signal?: AbortSignal, onCommitted?: () => void }} [options]
     */
    async completeOAuth(code, state, { signal, onCommitted } = {}) {
      throwIfAuthCancelled(signal);
      const flow = oauthFlow;
      if (!flow || now() - flow.createdAt > 10 * 60 * 1000) {
        if (oauthFlow === flow) oauthFlow = null;
        throw piError('OPENROUTER_OAUTH_EXPIRED', 'OpenRouter 로그인 요청이 만료됐어요');
      }
      if (state !== flow.state) {
        throw piError('OPENROUTER_OAUTH_INVALID', 'OpenRouter 로그인 응답을 확인하지 못했어요');
      }
      if (flow.completing) {
        throw piError('OPENROUTER_OAUTH_BUSY', 'OpenRouter 로그인을 이미 완료하고 있어요');
      }
      flow.completing = true;
      const controller = new AbortController();
      const exchangeSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      let rejectTimeout;
      const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
      let rejectCancellation;
      const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
      const onAbort = () => {
        controller.abort();
        rejectCancellation(piError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        controller.abort();
        rejectTimeout(piError('OPENROUTER_OAUTH_TIMEOUT', 'OpenRouter 로그인 응답이 너무 느려요'));
      }, oauthTimeoutMs);
      try {
        const operation = (async () => {
          const response = await fetchImpl('https://openrouter.ai/api/v1/auth/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: String(code ?? ''),
              code_verifier: flow.verifier,
              code_challenge_method: 'S256',
            }),
            signal: exchangeSignal,
          });
          const body = await boundedJsonResponse(response);
          throwIfAuthCancelled(exchangeSignal);
          if (!response.ok || typeof body?.key !== 'string' || !body.key) {
            throw piError('OPENROUTER_OAUTH_FAILED', 'OpenRouter 로그인을 완료하지 못했어요');
          }
          throwIfAuthCancelled(exchangeSignal);
          const status = await this.setApiKey(body.key, { signal: exchangeSignal, onCommitted });
          // onCommitted synchronously removes the exact auth run. If it did not,
          // the same signal still fences this late exchange from reporting success.
          throwIfAuthCancelled(exchangeSignal);
          return status;
        })();
        const status = await Promise.race([operation, timeout, cancellation]);
        if (oauthFlow === flow) oauthFlow = null;
        return status;
      } catch (error) {
        if (signal?.aborted) {
          if (oauthFlow === flow) oauthFlow = null;
          throw piError('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.');
        }
        if (error?.name === 'AbortError') {
          throw piError('OPENROUTER_OAUTH_TIMEOUT', 'OpenRouter 로그인 응답이 너무 느려요');
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (oauthFlow === flow) flow.completing = false;
      }
    },

    /** 로컬 키만 지운다. 호스티드 $5 키는 서버에 남는다. */
    async clearApiKey() {
      await load();
      return serialized(async () => {
        const previous = snapshotSettingsState();
        // Deletion is reversible only when the precise pre-delete value is known.
        await captureVaultSnapshot(previous);
        let vaultTouched = false;
        let stateMutated = false;
        let deleteFailureMessage = null;
        try {
          if (secretStore?.available) {
            vaultTouched = true;
            try {
              await secretStore.delete(secretId);
            } catch (error) {
              deleteFailureMessage = error?.message ?? 'OS 보안 저장소에서 키를 지우지 못했어요.';
              secretStoreError = deleteFailureMessage;
              throw piError('SECRET_DELETE_FAILED', deleteFailureMessage);
            }
            secretStoreError = null;
          }
          stateMutated = true;
          apiKey = null;
          config.keyTail = null;
          config.account = null;
          config.setupComplete = false;
          await writeModelsJson();
          await persistConfig();
          client.clearCache();
          return currentStatus();
        } catch (error) {
          const rollbackErrors = await rollbackSettingsState(previous, {
            restoreSecret: vaultTouched,
            restoreFiles: stateMutated,
          });
          // Keep the existing diagnostics for a vault deletion failure after the
          // credential itself has been restored successfully.
          if (deleteFailureMessage && rollbackErrors.length === 0) {
            secretStoreError = deleteFailureMessage;
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
    },

    async cancelSetup() {
      oauthFlow = null;
      const proc = installProcess;
      if (!proc) return false;
      let cleanup = installCleanupPromises.get(proc);
      if (!cleanup) {
        cleanup = terminateAndWaitForProcessTreeExit(proc, {
          terminateProcess: terminateProcessTree,
          terminateOptions: { platform, spawnProcess, env: baseEnv },
        }).catch(() => false);
        installCleanupPromises.set(proc, cleanup);
      }
      return cleanup;
    },

    /**
     * 쓸 모델을 최대 3개 고른다. id 는 라이브 카탈로그로 검증한다.
     *
     * @param {Array<{ id: string, name?: string, effortDefault?: string }>} models
     */
    async setModels(models) {
      await load();
      const requested = Array.isArray(models) ? models : [];
      if (requested.length === 0) throw piError('PI_MODELS_EMPTY', '모델을 하나 이상 고르세요');
      if (locked) {
        throw piError('PI_MODELS_LOCKED', 'Rau 모델은 앱이 정해 둔 목록만 씁니다');
      }
      if (requested.length > MAX_MODELS) {
        throw piError('PI_TOO_MANY_MODELS', `모델은 최대 ${MAX_MODELS}개까지 고를 수 있어요`);
      }
      const normalizedRequested = requested.map((item) => {
        const rawId = typeof item?.id === 'string' ? item.id.trim() : '';
        const id = normalizedModelId(rawId);
        if (rawId && !id) {
          throw piError('PI_MODEL_INVALID', '모델 ID가 허용된 길이 또는 형식이 아니에요');
        }
        const rawName = typeof item?.name === 'string' ? item.name.trim() : '';
        const name = rawName ? normalizedModelName(rawName, '') : null;
        if (rawName && !name) {
          throw piError('PI_MODEL_NAME_INVALID', '모델 이름이 허용된 길이 또는 형식이 아니에요');
        }
        return { item, id: id ?? '', name };
      });
      const catalog = await client.catalog(false, apiKey);
      const byId = new Map(catalog.flatMap((entry) => {
        const id = normalizedModelId(entry?.id);
        return id ? [[id, entry]] : [];
      }));
      const seen = new Set();
      /** @type {PiModelConfig[]} */
      const next = [];
      for (const { item, id, name: requestedName } of normalizedRequested) {
        const entry = byId.get(id);
        if (!entry) throw piError('PI_MODEL_UNKNOWN', `OpenRouter 에 없는 모델이에요: ${id || '(빈 값)'}`);
        if (seen.has(id)) continue;
        seen.add(id);
        const name = requestedName ?? normalizedModelName(entry.name, id) ?? id;
        const efforts = entry.reasoning ? [...EFFORTS] : [];
        const defaultEffort = efforts.includes(item?.effortDefault)
          ? item.effortDefault
          : (efforts.length > 0 ? DEFAULT_EFFORT : null);
        next.push({
          id,
          name,
          reasoning: entry.reasoning,
          supportsImages: entry.supportsImages,
          efforts,
          defaultEffort,
          contextLength: entry.contextLength,
          pricing: { ...entry.pricing },
        });
      }
      return serialized(async () => {
        const previous = snapshotSettingsState();
        try {
          config.models = next;
          config.defaultModelId = next.some((model) => model.id === config.defaultModelId)
            ? config.defaultModelId
            : next[0].id;
          config.setupComplete = Boolean(apiKey) && next.length > 0;
          await writeModelsJson();
          await persistConfig();
          return currentStatus();
        } catch (error) {
          const rollbackErrors = await rollbackSettingsState(previous);
          if (rollbackErrors.length > 0) {
            throw modelRollbackError(
              error,
              new AggregateError(rollbackErrors, 'One or more model rollback steps failed.'),
            );
          }
          throw error;
        }
      });
    },

    /** 설정된 모델 중 출력 단가가 가장 싼 것. 없으면 null. */
    cheapestModel() {
      let cheapest = null;
      for (const model of config.models) {
        if (!cheapest || model.pricing.completion < cheapest.pricing.completion) cheapest = model;
      }
      return cheapest ? { ...cheapest, pricing: { ...cheapest.pricing } } : null;
    },

    /** 기본 모델(없으면 첫 모델). */
    defaultModel() {
      const found = config.models.find((model) => model.id === config.defaultModelId);
      const model = found ?? config.models[0] ?? null;
      return model ? { ...model, pricing: { ...model.pricing } } : null;
    },

    /** 허브 내부 전용 — OpenRouter 직접 호출(제목·스킬 초안)에 쓴다. */
    apiKey() {
      return apiKey;
    },

    /** 카탈로그 조회는 그대로 위임한다. */
    catalog(refresh = false) {
      return client.catalog(refresh, apiKey);
    },

    /** 잔액. 키가 없으면 null 을 돌려준다. */
    async credits(refresh = false) {
      if (!apiKey) return null;
      return client.credits(apiKey, refresh);
    },

    /** 진행 중인 설정 파일 쓰기가 끝날 때까지 기다린다 (테스트/종료용). */
    flush() {
      return writeChain;
    },
  };
}

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOpenRouter } from './openrouter.mjs';

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
/** OpenRouter 의 reasoning_effort 가 받는 값 — 우리는 이 셋만 노출한다. */
const EFFORTS = /** @type {const} */ (['low', 'medium', 'high']);
const DEFAULT_EFFORT = 'medium';
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
const STDERR_TAIL_LIMIT = 1_200;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const REGISTRY_BASE = 'https://registry.npmjs.org';
const REGISTRY_TIMEOUT_MS = 10_000;
/** 진행 이벤트는 이 간격으로만 내보낸다 — 청크마다 WS 를 두드리지 않는다. */
const PROGRESS_INTERVAL_MS = 150;

/** 이 파일 기준 경로 — 확장/스킬은 저장소 안에 있고, pi 홈은 그것을 가리키기만 한다. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(MODULE_DIR, 'pi', 'extension', 'rhwp.ts');
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
 * @property {PiModelConfig[]} models
 * @property {string|null} defaultModelId
 * @property {boolean} setupComplete
 * @property {string|null} error
 */

function piError(code, message) {
  const error = new Error(message);
  error.code = code;
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

/** 토큰 1개당 USD → 100만 토큰당 USD. 부동소수 찌꺼기는 6자리에서 자른다. */
function perMillion(price) {
  return Math.round(Number(price) * 1e12) / 1e6;
}

function keyTailOf(key) {
  const trimmed = String(key ?? '').trim();
  return trimmed ? trimmed.slice(-4) : null;
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
  if (env.RHWP_PI_DIR) return path.resolve(env.RHWP_PI_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'rhwp', 'pi');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'rhwp', 'pi');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rhwp', 'pi');
}

/**
 * pi CLI 설치본과 그 에이전트 홈(모델·키·스킬)을 관리한다.
 * 설치는 single-flight 이고, 루트가 없어도 status() 는 그냥 미설치로 답한다.
 *
 * @param {{ rootDir?: string, spawnProcess?: typeof spawn, fetchImpl?: typeof fetch,
 *           now?: () => number, openRouter?: ReturnType<typeof createOpenRouter>,
 *           npmCommand?: string, packageSpec?: string, platform?: string }} [deps]
 */
export function createPiManager({
  rootDir = defaultPiRoot(),
  spawnProcess = spawn,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  openRouter = null,
  npmCommand = 'npm',
  packageSpec = PI_PACKAGE,
  platform = process.platform,
} = {}) {
  const prefixDir = path.join(rootDir, 'prefix');
  const agentDir = path.join(rootDir, 'agent');
  const sessionsDir = path.join(rootDir, 'sessions');
  const configPath = path.join(rootDir, CONFIG_FILE);
  const modelsPath = path.join(agentDir, 'models.json');
  const settingsPath = path.join(agentDir, 'settings.json');
  const skillsDir = path.join(agentDir, 'skills');
  const piBin = path.join(prefixDir, 'node_modules', '.bin', platform === 'win32' ? 'pi.cmd' : 'pi');
  const packageJsonPath = path.join(prefixDir, 'node_modules', ...packageSpec.split('/'), 'package.json');
  const client = openRouter ?? createOpenRouter({ fetchImpl, now, cacheDir: rootDir });

  let config = {
    version: CONFIG_VERSION,
    installedVersion: null,
    keyTail: null,
    models: [],
    defaultModelId: null,
    setupComplete: false,
  };
  /** 실제 키는 config.json 이 아니라 agent/models.json 안에만 산다. */
  let apiKey = null;
  /** @type {Promise<void> | null} 첫 로드는 한 번만 돈다 — 동시에 들어와도 공유한다. */
  let loadPromise = null;
  let installedVersion = null;
  let installing = false;
  let lastError = null;
  /** @type {Promise<PiStatus> | null} */
  let installInFlight = null;
  /** @type {Set<(progress: { state: string, detail?: string }) => void>} */
  const installListeners = new Set();
  /** 설정 파일 쓰기는 직렬화한다 — 키/모델 갱신이 겹쳐도 순서가 흐트러지지 않도록. */
  let writeChain = Promise.resolve();
  let tempSeq = 0;

  async function writeAtomic(file, text, mode = 0o600) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${now()}-${(tempSeq += 1)}`;
    await fs.writeFile(temp, text, { encoding: 'utf8', mode });
    await fs.rename(temp, file);
  }

  function serialized(task) {
    const next = writeChain.then(task, task);
    writeChain = next.then(() => {}, () => {});
    return next;
  }

  function normalizeStoredModel(raw) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
    const reasoning = Boolean(raw.reasoning);
    const efforts = reasoning && Array.isArray(raw.efforts)
      ? raw.efforts.filter((effort) => EFFORTS.includes(effort))
      : (reasoning ? [...EFFORTS] : []);
    const defaultEffort = efforts.includes(raw.defaultEffort)
      ? raw.defaultEffort
      : (efforts.length > 0 ? DEFAULT_EFFORT : null);
    const contextLength = Number(raw.contextLength);
    return {
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : raw.id,
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

  async function readInstalledVersion() {
    try {
      const raw = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      return typeof raw?.version === 'string' && raw.version ? raw.version : null;
    } catch {
      return null;
    }
  }

  async function readStoredKey() {
    try {
      const raw = JSON.parse(await fs.readFile(modelsPath, 'utf8'));
      const key = raw?.providers?.openrouter?.apiKey;
      return typeof key === 'string' && key.trim() ? key.trim() : null;
    } catch {
      return null;
    }
  }

  async function readConfig() {
    try {
      const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const models = (Array.isArray(raw?.models) ? raw.models : [])
        .map(normalizeStoredModel)
        .filter(Boolean)
        .slice(0, MAX_MODELS);
      const defaultModelId = models.some((model) => model.id === raw?.defaultModelId)
        ? raw.defaultModelId
        : (models[0]?.id ?? null);
      config = {
        version: CONFIG_VERSION,
        installedVersion: typeof raw?.installedVersion === 'string' ? raw.installedVersion : null,
        keyTail: typeof raw?.keyTail === 'string' ? raw.keyTail : null,
        models,
        defaultModelId,
        setupComplete: false,
      };
    } catch {
      // 설정 파일이 없거나 깨졌으면 빈 상태로 시작한다.
    }
    apiKey = await readStoredKey();
    installedVersion = await readInstalledVersion();
    config.setupComplete = Boolean(apiKey) && config.models.length > 0;
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
      models: config.models,
      defaultModelId: config.defaultModelId,
      setupComplete: config.setupComplete,
    };
    return writeAtomic(configPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  /** agent/models.json 을 통째로 다시 쓴다 — 키와 모델이 한 파일에 같이 산다. */
  async function writeModelsJson() {
    const provider = {
      baseUrl: 'https://openrouter.ai/api/v1',
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
    if (apiKey) provider.apiKey = apiKey;
    const payload = { providers: { openrouter: provider } };
    await writeAtomic(modelsPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  /**
   * 레지스트리에서 최신 타르볼 주소와 무결성 해시를 알아낸다.
   * 버전이 박힌 스펙이면 npm 에 그대로 맡기려고 null 을 돌려준다.
   */
  async function resolveDist() {
    if (packageSpec.lastIndexOf('@') > 0) return null;
    const url = `${REGISTRY_BASE}/${packageSpec.replace('/', '%2F')}/latest`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
    const meta = await response.json();
    const tarball = meta?.dist?.tarball;
    if (typeof tarball !== 'string' || !tarball) throw new Error('registry: tarball 주소가 없어요');
    return {
      tarball,
      integrity: typeof meta?.dist?.integrity === 'string' ? meta.dist.integrity : null,
    };
  }

  /**
   * 타르볼을 직접 내려받아 바이트 단위 진행률을 emit 한다. content-length 가 없으면
   * totalBytes 는 null 이고, UI 는 새 바이트가 올 때만 움직이는 막대로 처리한다.
   * 무결성 실패는 PI_INSTALL_FAILED 로 던진다 — npm 폴백으로 넘어가지 않는다.
   */
  async function downloadTarball(dist, emit) {
    const response = await fetchImpl(dist.tarball, { signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) });
    if (!response.ok || !response.body) throw new Error(`tarball HTTP ${response.status}`);
    const declared = Number(response.headers?.get?.('content-length'));
    const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
    const cacheDir = path.join(rootDir, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const filePath = path.join(cacheDir, 'pi-package.tgz');
    const hash = createHash('sha512');
    let receivedBytes = 0;
    let lastEmit = 0;
    const handle = await fs.open(filePath, 'w', 0o600);
    try {
      for await (const rawChunk of response.body) {
        const chunk = Buffer.from(rawChunk);
        receivedBytes += chunk.length;
        hash.update(chunk);
        await handle.write(chunk);
        const ts = now();
        if (ts - lastEmit >= PROGRESS_INTERVAL_MS) {
          lastEmit = ts;
          emit({ state: 'downloading', receivedBytes, totalBytes });
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }
    if (dist.integrity?.startsWith('sha512-')) {
      if (`sha512-${hash.digest('base64')}` !== dist.integrity) {
        await fs.unlink(filePath).catch(() => {});
        throw piError('PI_INSTALL_FAILED', '내려받은 pi 패키지가 무결성 검증에 실패했어요');
      }
    }
    emit({ state: 'downloading', receivedBytes, totalBytes: totalBytes ?? receivedBytes });
    return filePath;
  }

  function runNpmInstall(emit, localTarball = null) {
    return new Promise((resolve, reject) => {
      const argv = [
        'install', '--prefix', prefixDir, '--no-fund', '--no-audit',
        // 폴백(npm 이 직접 내려받는) 경로에서는 http 로그가 활동 신호가 된다.
        localTarball ? '--loglevel=error' : '--loglevel=http',
        localTarball ?? packageSpec,
      ];
      let settled = false;
      let stderrText = '';
      let lastActivity = 0;
      /** @type {NodeJS.Timeout | null} */
      let timer = null;

      const done = (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      let proc;
      try {
        proc = spawnProcess(npmCommand, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        done(piError('PI_INSTALL_FAILED', `npm 실행에 실패했어요: ${error?.message ?? error}`));
        return;
      }

      timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        done(piError('PI_INSTALL_FAILED', 'npm install 이 10분 안에 끝나지 않았어요'));
      }, INSTALL_TIMEOUT_MS);
      if (timer?.unref) timer.unref();

      // npm 출력이 나올 때마다 "일이 진행 중" 신호를 흘린다 — 멈추면 UI 막대도 멈춘다.
      const noteActivity = () => {
        const ts = now();
        if (ts - lastActivity < PROGRESS_INTERVAL_MS) return;
        lastActivity = ts;
        emit({ state: 'installing', activity: true });
      };
      proc.stdout?.on?.('data', noteActivity);
      proc.stdout?.on?.('error', () => {});
      proc.stderr?.on?.('data', (chunk) => {
        noteActivity();
        stderrText += chunk.toString();
      });
      proc.stderr?.on?.('error', () => {});
      proc.on('error', (error) => {
        const hint = error?.code === 'ENOENT'
          ? 'npm 명령을 찾을 수 없어요 — Node.js 설치를 확인하세요'
          : `npm 실행에 실패했어요: ${error?.message ?? error}`;
        done(piError('PI_INSTALL_FAILED', hint));
      });
      const finish = (code, signal) => {
        if (code === 0) {
          done(null);
          return;
        }
        const exit = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
        const detail = stderrTail(stderrText);
        done(piError(
          'PI_INSTALL_FAILED',
          detail
            ? `pi 설치가 실패했어요 (${exit}): ${detail}`
            : `pi 설치가 실패했어요 (${exit})`,
        ));
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
      models: config.models.map((model) => ({ ...model, pricing: { ...model.pricing } })),
      defaultModelId: config.defaultModelId,
      setupComplete: config.setupComplete,
      error: lastError,
    };
  }

  async function syncAssets() {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await writeAtomic(settingsPath, `${JSON.stringify({
      defaultProjectTrust: 'never',
      enableSkillCommands: false,
      enableInstallTelemetry: false,
      extensions: [EXTENSION_PATH],
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

    /** 루트를 만들고 저장된 설정을 읽는다. 루트가 없어도 실패하지 않는다. */
    async init() {
      await fs.mkdir(rootDir, { recursive: true }).catch(() => {});
      await load();
      return this;
    },

    /** 스폰 없이 파일만 본다 — 부팅/웰컴 푸시에서 자주 불린다. */
    async status() {
      await load();
      return currentStatus();
    },

    /**
     * pi CLI 를 설치하고 확장/스킬/설정을 동기화한다. 동시에 부르면 하나만 돈다.
     *
     * @param {(progress: { state: string, detail?: string, receivedBytes?: number,
     *   totalBytes?: number|null, activity?: boolean }) => void} [onProgress]
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
      installing = true;
      lastError = null;
      // await 없이 곧바로 in-flight 를 세워야 동시에 들어온 호출이 하나로 합쳐진다.
      const running = (async () => {
        try {
          await load();
          emit({ state: 'downloading' });
          await fs.mkdir(prefixDir, { recursive: true });
          // 결정적 진행률: 타르볼을 직접 받아 바이트를 센다. 레지스트리/네트워크가
          // 협조하지 않으면 npm 폴백으로 넘어가 활동 신호만 흘린다.
          let tarballPath = null;
          try {
            const dist = await resolveDist();
            if (dist) tarballPath = await downloadTarball(dist, emit);
          } catch (error) {
            if (error?.code === 'PI_INSTALL_FAILED') throw error; // 무결성 실패는 폴백 금지
            tarballPath = null;
          }
          emit({ state: 'installing' });
          await runNpmInstall(emit, tarballPath);
          if (tarballPath) await fs.unlink(tarballPath).catch(() => {});
          emit({ state: 'configuring' });
          await syncAssets();
          installedVersion = await readInstalledVersion();
          config.installedVersion = installedVersion;
          config.setupComplete = Boolean(apiKey) && config.models.length > 0;
          await serialized(() => persistConfig());
          installing = false;
          emit({ state: 'done', detail: installedVersion ?? undefined });
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

    /** 확장 경로가 담긴 settings.json 을 쓰고 저장소 스킬을 pi 홈으로 복사한다. */
    async syncAssets() {
      await load();
      await serialized(() => syncAssets());
      return currentStatus();
    },

    /**
     * OpenRouter 키를 확인하고 agent/models.json 에만 저장한다(0600).
     *
     * @param {string} key
     */
    async setApiKey(key) {
      await load();
      const trimmed = String(key ?? '').trim();
      if (!trimmed) throw piError('OPENROUTER_KEY_INVALID', 'OpenRouter 키를 입력하세요');
      const check = await client.validateKey(trimmed);
      if (!check.valid) throw piError('OPENROUTER_KEY_INVALID', 'OpenRouter 키가 거절됐어요');
      apiKey = trimmed;
      config.keyTail = keyTailOf(trimmed);
      config.setupComplete = config.models.length > 0;
      await serialized(async () => {
        await writeModelsJson();
        await persistConfig();
      });
      client.clearCache();
      return currentStatus();
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
      if (requested.length > MAX_MODELS) {
        throw piError('PI_TOO_MANY_MODELS', `모델은 최대 ${MAX_MODELS}개까지 고를 수 있어요`);
      }
      const catalog = await client.catalog(false, apiKey);
      const byId = new Map(catalog.map((entry) => [entry.id, entry]));
      const seen = new Set();
      /** @type {PiModelConfig[]} */
      const next = [];
      for (const item of requested) {
        const id = typeof item?.id === 'string' ? item.id.trim() : '';
        const entry = byId.get(id);
        if (!entry) throw piError('PI_MODEL_UNKNOWN', `OpenRouter 에 없는 모델이에요: ${id || '(빈 값)'}`);
        if (seen.has(id)) continue;
        seen.add(id);
        const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : entry.name;
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
      config.models = next;
      config.defaultModelId = next.some((model) => model.id === config.defaultModelId)
        ? config.defaultModelId
        : next[0].id;
      config.setupComplete = Boolean(apiKey) && next.length > 0;
      await serialized(async () => {
        await writeModelsJson();
        await persistConfig();
      });
      return currentStatus();
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

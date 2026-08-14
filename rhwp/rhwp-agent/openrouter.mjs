import { promises as fs } from 'node:fs';
import path from 'node:path';

const API_BASE = 'https://openrouter.ai/api/v1';
/** 카탈로그는 1시간, 잔액은 5분 캐시한다 — 목록은 잘 안 바뀌고 잔액은 자주 본다. */
const CATALOG_TTL_MS = 60 * 60 * 1000;
const CREDITS_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const CHAT_TIMEOUT_MS = 60_000;
const CATALOG_CACHE_FILE = 'models-cache.json';

/**
 * @typedef {Object} CatalogModel
 * @property {string} id
 * @property {string} name
 * @property {string} provider
 * @property {number|null} contextLength
 * @property {{ prompt: number, completion: number }} pricing 토큰 1개당 USD (OpenRouter 원본 단위)
 * @property {boolean} reasoning
 */

function openRouterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toPrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function toUsd(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

/** 텍스트를 넣고 텍스트를 받을 수 있는 모델만 남긴다. 필드가 없으면 통과시킨다. */
function isTextModel(entry) {
  const arch = entry?.architecture ?? {};
  const modality = typeof arch.modality === 'string' ? arch.modality : '';
  const inputs = arch.input_modalities;
  const outputs = arch.output_modalities;
  const inputOk = Array.isArray(inputs)
    ? inputs.includes('text')
    : (modality ? modality.split('->')[0].includes('text') : true);
  const outputOk = Array.isArray(outputs)
    ? outputs.includes('text')
    : (modality ? modality.split('->').at(-1).includes('text') : true);
  return inputOk && outputOk;
}

/** @returns {CatalogModel} */
function mapModel(entry) {
  const id = String(entry.id);
  const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
  const contextLength = Number(entry.context_length);
  return {
    id,
    name,
    provider: id.includes('/') ? id.split('/')[0] : 'openrouter',
    contextLength: Number.isFinite(contextLength) && contextLength > 0 ? Math.round(contextLength) : null,
    pricing: {
      prompt: toPrice(entry?.pricing?.prompt),
      completion: toPrice(entry?.pricing?.completion),
    },
    reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
  };
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'string' ? block : (block?.text ?? '')))
      .join('');
  }
  return '';
}

/**
 * OpenRouter REST 클라이언트. 네트워크는 전부 fetchImpl 로 주입 가능하다.
 *
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, cacheDir?: string|null,
 *           baseUrl?: string, timeoutMs?: number }} [deps]
 */
export function createOpenRouter({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheDir = null,
  baseUrl = API_BASE,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const cachePath = cacheDir ? path.join(cacheDir, CATALOG_CACHE_FILE) : null;
  /** @type {{ models: CatalogModel[], fetchedAt: number } | null} */
  let catalogCache = null;
  /** @type {Promise<CatalogModel[]> | null} */
  let catalogInFlight = null;
  /** @type {{ credits: object, fetchedAt: number } | null} */
  let creditsCache = null;
  /** @type {Promise<object> | null} */
  let creditsInFlight = null;

  async function request(pathname, { method = 'GET', key = null, body, timeout = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    if (timer.unref) timer.unref();
    let response;
    try {
      /** @type {Record<string, string>} */
      const headers = { Accept: 'application/json', 'X-Title': 'rhwp' };
      if (key) headers.Authorization = `Bearer ${key}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      response = await fetchImpl(`${baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw openRouterError('OPENROUTER_TIMEOUT', 'OpenRouter 응답이 너무 느려요');
      }
      throw openRouterError('OPENROUTER_UNREACHABLE', 'OpenRouter에 닿지 못했어요. 네트워크를 확인하세요');
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text().catch(() => '');
    let parsed = null;
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { ok: response.ok, status: response.status, parsed, text };
  }

  function httpError(result, what) {
    const detail = String(result.parsed?.error?.message ?? result.text ?? '').trim().slice(0, 180);
    return openRouterError(
      'OPENROUTER_HTTP',
      detail
        ? `OpenRouter ${what} 요청이 실패했어요 (HTTP ${result.status}): ${detail}`
        : `OpenRouter ${what} 요청이 실패했어요 (HTTP ${result.status})`,
    );
  }

  async function readDiskCache() {
    if (!cachePath) return null;
    try {
      const raw = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      const fetchedAt = Number(raw?.fetchedAt);
      if (!Array.isArray(raw?.models) || !Number.isFinite(fetchedAt)) return null;
      return { models: raw.models, fetchedAt };
    } catch {
      return null;
    }
  }

  async function writeDiskCache(entry) {
    if (!cachePath) return;
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      const temp = `${cachePath}.tmp-${process.pid}-${now()}`;
      await fs.writeFile(temp, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, cachePath);
    } catch {
      // 캐시 저장 실패는 무시한다 — 다음 요청에서 다시 받아오면 된다.
    }
  }

  async function fetchCatalog(key) {
    const result = await request('/models', { key });
    if (!result.ok) throw httpError(result, '모델 목록');
    const data = Array.isArray(result.parsed?.data) ? result.parsed.data : [];
    const models = data
      .filter((entry) => entry && typeof entry.id === 'string')
      .filter((entry) => Array.isArray(entry.supported_parameters)
        && entry.supported_parameters.includes('tools'))
      .filter(isTextModel)
      .map(mapModel)
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    return models;
  }

  return {
    /**
     * 키가 유효한지 확인한다. 401/403 은 예외가 아니라 valid:false 로 돌려준다.
     *
     * @param {string} key
     */
    async validateKey(key) {
      const trimmed = String(key ?? '').trim();
      if (!trimmed) return { valid: false, label: null, limit: null, usage: null, isFreeTier: false };
      const result = await request('/key', { key: trimmed });
      if (result.status === 401 || result.status === 403) {
        return { valid: false, label: null, limit: null, usage: null, isFreeTier: false };
      }
      if (!result.ok) throw httpError(result, '키 확인');
      const data = result.parsed?.data ?? {};
      return {
        valid: true,
        label: typeof data.label === 'string' ? data.label : null,
        limit: data.limit === null || data.limit === undefined ? null : Number(data.limit),
        usage: Number.isFinite(Number(data.usage)) ? Number(data.usage) : 0,
        isFreeTier: Boolean(data.is_free_tier),
      };
    },

    /**
     * 도구 호출을 지원하는 텍스트 모델 목록. 메모리 1시간 + 디스크 캐시를 쓴다.
     *
     * @param {boolean} [refresh]
     * @param {string|null} [key] 있으면 같이 보낸다 (이 엔드포인트는 키가 없어도 된다)
     * @returns {Promise<CatalogModel[]>}
     */
    async catalog(refresh = false, key = null) {
      if (!refresh && catalogCache && now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
        return catalogCache.models;
      }
      if (!refresh && catalogInFlight) return catalogInFlight;
      const loading = (async () => {
        if (!refresh) {
          const disk = await readDiskCache();
          if (disk && now() - disk.fetchedAt < CATALOG_TTL_MS) {
            catalogCache = disk;
            return disk.models;
          }
        }
        const models = await fetchCatalog(key);
        catalogCache = { models, fetchedAt: now() };
        await writeDiskCache(catalogCache);
        return models;
      })();
      catalogInFlight = loading;
      try {
        return await loading;
      } finally {
        if (catalogInFlight === loading) catalogInFlight = null;
      }
    },

    /**
     * 크레딧 잔액. 5분 캐시하고 refresh 로 건너뛴다.
     *
     * @param {string} key
     * @param {boolean} [refresh]
     */
    async credits(key, refresh = false) {
      const trimmed = String(key ?? '').trim();
      if (!trimmed) throw openRouterError('OPENROUTER_KEY_MISSING', 'OpenRouter 키가 없어요');
      if (!refresh && creditsCache && now() - creditsCache.fetchedAt < CREDITS_TTL_MS) {
        return creditsCache.credits;
      }
      if (!refresh && creditsInFlight) return creditsInFlight;
      const loading = (async () => {
        const result = await request('/credits', { key: trimmed });
        if (result.status === 401 || result.status === 403) {
          throw openRouterError('OPENROUTER_KEY_INVALID', 'OpenRouter 키가 거절됐어요');
        }
        if (!result.ok) throw httpError(result, '잔액');
        const data = result.parsed?.data ?? {};
        const totalCreditsUsd = toUsd(data.total_credits);
        const totalUsageUsd = toUsd(data.total_usage);
        const credits = {
          balanceUsd: Math.round((totalCreditsUsd - totalUsageUsd) * 1e6) / 1e6,
          totalCreditsUsd,
          totalUsageUsd,
          checkedAt: now(),
        };
        creditsCache = { credits, fetchedAt: now() };
        return credits;
      })();
      creditsInFlight = loading;
      try {
        return await loading;
      } finally {
        if (creditsInFlight === loading) creditsInFlight = null;
      }
    },

    /**
     * 비스트리밍 한 번 호출 — 제목 생성·스킬 초안·문체 분석 폴백에 쓴다.
     *
     * @param {{ key: string, model: string, messages: Array<object>, maxTokens?: number,
     *           temperature?: number, timeout?: number }} opts
     * @returns {Promise<string>} 어시스턴트 텍스트
     */
    async chat({ key, model, messages, maxTokens, temperature, timeout = CHAT_TIMEOUT_MS }) {
      const trimmed = String(key ?? '').trim();
      if (!trimmed) throw openRouterError('OPENROUTER_KEY_MISSING', 'OpenRouter 키가 없어요');
      if (!model) throw openRouterError('OPENROUTER_MODEL_MISSING', '모델이 지정되지 않았어요');
      const body = { model, messages, stream: false };
      if (Number.isFinite(maxTokens)) body.max_tokens = Math.round(maxTokens);
      if (Number.isFinite(temperature)) body.temperature = temperature;
      const result = await request('/chat/completions', {
        method: 'POST', key: trimmed, body, timeout,
      });
      if (result.status === 401 || result.status === 403) {
        throw openRouterError('OPENROUTER_KEY_INVALID', 'OpenRouter 키가 거절됐어요');
      }
      if (!result.ok) throw httpError(result, '응답 생성');
      const choice = result.parsed?.choices?.[0];
      if (!choice) throw openRouterError('OPENROUTER_BAD_RESPONSE', 'OpenRouter 응답이 비어 있어요');
      return messageText(choice.message);
    },

    /** 테스트/키 교체용 — 캐시를 비운다. */
    clearCache() {
      catalogCache = null;
      creditsCache = null;
    },
  };
}

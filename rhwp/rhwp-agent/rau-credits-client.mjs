const DEFAULT_URL = 'https://rau-credits-production.up.railway.app';
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSIENT_POLL_RETRIES = 5;
const KEY_VALIDATION_RETRY_MS = [250, 500, 1_000, 2_000];

function creditsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function abortError() {
  return creditsError('RAU_LOGIN_CANCELLED', 'Rau 로그인을 취소했어요.');
}

/**
 * A newly provisioned OpenRouter child key can briefly be unavailable to the
 * validation endpoint. Retry only the read-only validation step before the
 * manager persists the key.
 */
export async function storeRauApiKey(setApiKey, key, {
  signal,
  account = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryMs = KEY_VALIDATION_RETRY_MS,
} = {}) {
  const retryable = new Set([
    'OPENROUTER_KEY_INVALID',
    'OPENROUTER_HTTP',
    'OPENROUTER_TIMEOUT',
    'OPENROUTER_UNREACHABLE',
  ]);
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw abortError();
    try {
      return await setApiKey(key, { account });
    } catch (error) {
      if (!retryable.has(error?.code) || attempt >= retryMs.length) throw error;
      await sleep(retryMs[attempt]);
    }
  }
}

export function rauCreditsUrl(env = process.env) {
  const raw = typeof env.RAU_CREDITS_URL === 'string' ? env.RAU_CREDITS_URL.trim() : '';
  return raw ? raw.replace(/\/$/, '') : DEFAULT_URL;
}

/**
 * 로컬 허브가 호스티드 rau-credits 에 세션을 열고 키를 받는다.
 *
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, now?: () => number,
 *           sleep?: (ms: number) => Promise<void> }} [deps]
 */
export function createRauCreditsClient({
  baseUrl = rauCreditsUrl(),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const origin = String(baseUrl).replace(/\/$/, '');

  async function request(pathname, init) {
    let response;
    try {
      response = await fetchImpl(`${origin}${pathname}`, init);
    } catch {
      throw creditsError('RAU_CREDITS_UNREACHABLE', 'Rau 크레딧 서버에 닿지 못했어요.');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw creditsError(
        body?.error ?? body?.code ?? 'RAU_CREDITS_HTTP',
        body?.message ?? body?.error ?? `Rau 크레딧 서버가 ${response.status} 을 돌려줬어요.`,
      );
    }
    return body;
  }

  return {
    origin,
    createDeviceSession() {
      return request('/v1/device-sessions', { method: 'POST' });
    },
    pollDeviceSession(id) {
      return request(`/v1/device-sessions/${encodeURIComponent(id)}`);
    },
    acknowledgeDeviceSession(id) {
      return request(`/v1/device-sessions/${encodeURIComponent(id)}/acknowledge`, { method: 'POST' });
    },
    /**
     * ready 가 될 때까지 폴링한다. 저장 확인 전까지 같은 키를 다시 받을 수 있다.
     * 로그인한 계정 이메일은 redeem 응답에 한 번만 실려 오므로 함께 돌려준다.
     *
     * @param {string} id
     * @param {{ signal?: AbortSignal }} [opts]
     * @returns {Promise<{ key: string, email: string|null }>}
     */
    async redeem(id, { signal } = {}) {
      const started = now();
      let transientFailures = 0;
      while (true) {
        if (signal?.aborted) throw abortError();
        let next;
        try {
          next = await this.pollDeviceSession(id);
          transientFailures = 0;
        } catch (error) {
          if (error?.code !== 'RAU_CREDITS_UNREACHABLE' || transientFailures >= TRANSIENT_POLL_RETRIES) {
            throw error;
          }
          transientFailures += 1;
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        if (next.status === 'ready' && typeof next.apiKey === 'string' && next.apiKey) {
          return { key: next.apiKey, email: typeof next.email === 'string' ? next.email : null };
        }
        if (next.status === 'redeemed') {
          throw creditsError('RAU_LOGIN_REDEEMED', '이 로그인 세션은 이미 사용됐어요. 다시 연결해 주세요.');
        }
        if (next.status === 'expired') {
          throw creditsError('RAU_LOGIN_EXPIRED', 'Rau 로그인이 만료됐어요. 다시 연결해 주세요.');
        }
        if (now() - started > POLL_TIMEOUT_MS) {
          throw creditsError('RAU_LOGIN_EXPIRED', 'Rau 로그인이 만료됐어요. 다시 연결해 주세요.');
        }
        await sleep(POLL_INTERVAL_MS);
      }
    },
  };
}

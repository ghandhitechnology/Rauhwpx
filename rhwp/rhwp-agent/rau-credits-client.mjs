const DEFAULT_URL = 'https://rau-credits-production.up.railway.app';
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function creditsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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
    /**
     * ready 가 될 때까지 폴링한다. 키는 한 세션에 한 번만 온다.
     * @param {string} id
     * @param {{ signal?: AbortSignal }} [opts]
     */
    async redeem(id, { signal } = {}) {
      const started = now();
      while (true) {
        if (signal?.aborted) throw creditsError('RAU_LOGIN_CANCELLED', 'Rau 로그인을 취소했어요.');
        const next = await this.pollDeviceSession(id);
        if (next.status === 'ready' && typeof next.apiKey === 'string' && next.apiKey) {
          return next.apiKey;
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

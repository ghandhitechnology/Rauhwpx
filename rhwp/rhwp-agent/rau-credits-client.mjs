const DEFAULT_URL = 'https://rau-credits-production.up.railway.app';
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
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
 * A newly issued Rau access token can briefly race the proxy's persisted state.
 * Retry only the read-only validation step before the manager persists it.
 */
export async function storeRauAccessToken(setAccessToken, token, {
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
      return await setAccessToken(token, { account });
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
 *           sleep?: (ms: number) => Promise<void>, timeoutMs?: number }} [deps]
 */
export function createRauCreditsClient({
  baseUrl = rauCreditsUrl(),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const origin = String(baseUrl).replace(/\/$/, '');

  async function request(pathname, init = {}, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const onAbort = () => {
      controller.abort();
      rejectDeadline(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectDeadline(creditsError('RAU_CREDITS_TIMEOUT', 'Rau 크레딧 서버 응답이 너무 느려요.'));
    }, timeoutMs);
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(`${origin}${pathname}`, { ...init, signal: controller.signal });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw creditsError(
              body?.error ?? body?.code ?? 'RAU_CREDITS_HTTP',
              body?.message ?? body?.error ?? `Rau 크레딧 서버가 ${response.status} 을 돌려줬어요.`,
            );
          }
          return body;
        })(),
        deadline,
      ]);
    } catch (error) {
      if (signal?.aborted || error?.code === 'RAU_LOGIN_CANCELLED') throw abortError();
      if (timedOut || error?.code === 'RAU_CREDITS_TIMEOUT') {
        throw creditsError('RAU_CREDITS_TIMEOUT', 'Rau 크레딧 서버 응답이 너무 느려요.');
      }
      if (typeof error?.code === 'string' && error.code.startsWith('RAU_')) throw error;
      throw creditsError('RAU_CREDITS_UNREACHABLE', 'Rau 크레딧 서버에 닿지 못했어요.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    origin,
    openRouterBaseUrl: `${origin}/v1/openrouter`,
    createDeviceSession({ signal, replaceAccessToken = null } = {}) {
      return request('/v1/device-sessions', {
        method: 'POST',
        ...(replaceAccessToken ? { headers: { Authorization: `Bearer ${replaceAccessToken}` } } : {}),
      }, { signal });
    },
    pollDeviceSession(id, { signal } = {}) {
      return request(`/v1/device-sessions/${encodeURIComponent(id)}`, {}, { signal });
    },
    acknowledgeDeviceSession(id, { signal } = {}) {
      return request(`/v1/device-sessions/${encodeURIComponent(id)}/acknowledge`, { method: 'POST' }, { signal });
    },
    revokeAccessToken(token, { signal } = {}) {
      const value = String(token ?? '').trim();
      if (!value) return Promise.resolve({ revoked: false });
      return request('/v1/access/revoke', {
        method: 'POST',
        headers: { Authorization: `Bearer ${value}` },
      }, { signal });
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
          next = await this.pollDeviceSession(id, { signal });
          transientFailures = 0;
        } catch (error) {
          if (!['RAU_CREDITS_UNREACHABLE', 'RAU_CREDITS_TIMEOUT'].includes(error?.code)
            || transientFailures >= TRANSIENT_POLL_RETRIES) {
            throw error;
          }
          transientFailures += 1;
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        if (next.status === 'ready' && typeof next.accessToken === 'string' && next.accessToken) {
          return { key: next.accessToken, email: typeof next.email === 'string' ? next.email : null };
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

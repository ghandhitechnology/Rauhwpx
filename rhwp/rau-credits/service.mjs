import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { decryptSecret, encryptSecret } from './crypto.mjs';
import { RAU_CREDIT_LIMIT_USD } from './catalog.mjs';
import {
  renderCodePage,
  renderDonePage,
  renderFailPage,
  renderLoginPage,
} from './pages.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { createMemoryStore } from './store.mjs';

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const WORKOS_AUTHORIZE = 'https://api.workos.com/user_management/authorize';
const WORKOS_AUTHENTICATE = 'https://api.workos.com/user_management/authenticate';
const WORKOS_MAGIC_AUTH = 'https://api.workos.com/user_management/magic_auth';
const OPENROUTER_KEYS = 'https://openrouter.ai/api/v1/keys';
const WORKOS_PROVIDERS = new Set(['GoogleOAuth', 'GitHubOAuth']);
const RAU_ICON_PATH = fileURLToPath(new URL('./public/rau.png', import.meta.url));

function creditsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** WorkOS 가 돌려준 계정 이메일. 없으면 null — 데스크톱은 키 꼬리로 대체한다. */
function loginEmail(body) {
  const raw = body?.user?.email ?? body?.email;
  return typeof raw === 'string' && raw.includes('@') ? raw.trim() : null;
}

/**
 * WorkOS + one $5 OpenRouter key per user.
 *
 * @param {{
 *   origin: string,
 *   sessionSecret: string,
 *   workosApiKey?: string,
 *   workosClientId?: string,
 *   openRouterProvisioningKey?: string,
 *   store?: ReturnType<typeof createMemoryStore>,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   authenticateWorkos?: (code: string) => Promise<{ id: string, email?: string|null }>,
 *   authenticateMagic?: (email: string, code: string) => Promise<{ id: string, email?: string|null }>,
 *   sendMagicAuth?: (email: string) => Promise<void>,
 *   createOpenRouterKey?: (input: { name: string }) => Promise<{ key: string, id?: string }>,
 *   maxLiveSessions?: number,
 * }} deps
 */
export function createCreditsService({
  origin,
  sessionSecret,
  workosApiKey = '',
  workosClientId = '',
  openRouterProvisioningKey = '',
  store = createMemoryStore(),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  authenticateWorkos = null,
  authenticateMagic = null,
  sendMagicAuth = null,
  createOpenRouterKey = null,
  maxLiveSessions = 2000,
} = {}) {
  if (!origin) throw new Error('origin is required');
  if (!sessionSecret) throw new Error('sessionSecret is required');

  const redirectUri = `${origin.replace(/\/$/, '')}/callback`;
  let mutationChain = Promise.resolve();

  function mutate(task) {
    const running = mutationChain.then(async () => {
      const state = await store.load();
      const result = await task(state);
      await store.save(state);
      return result;
    });
    mutationChain = running.then(() => undefined, () => undefined);
    return running;
  }

  function pruneSessions(state) {
    const cutoff = now() - SESSION_TTL_MS;
    for (const [id, session] of Object.entries(state.sessions)) {
      if (session.createdAt < cutoff) delete state.sessions[id];
    }
  }

  function liveSessionCount(state) {
    let count = 0;
    for (const session of Object.values(state.sessions)) {
      if (session.status === 'pending' || session.status === 'ready') count += 1;
    }
    return count;
  }

  async function defaultAuthenticate(code) {
    const response = await fetchImpl(WORKOS_AUTHENTICATE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: workosClientId,
        client_secret: workosApiKey,
        grant_type: 'authorization_code',
        code,
      }),
    });
    const body = await response.json().catch(() => ({}));
    const id = body?.user?.id;
    if (!response.ok || typeof id !== 'string' || !id) {
      throw creditsError('WORKOS_AUTH_FAILED', '로그인을 완료하지 못했어요');
    }
    return { id, email: loginEmail(body) };
  }

  async function defaultAuthenticateMagic(email, code) {
    const response = await fetchImpl(WORKOS_AUTHENTICATE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: workosClientId,
        client_secret: workosApiKey,
        grant_type: 'urn:workos:oauth:grant-type:magic-auth:code',
        email,
        code,
      }),
    });
    const body = await response.json().catch(() => ({}));
    const id = body?.user?.id;
    if (!response.ok || typeof id !== 'string' || !id) {
      throw creditsError('WORKOS_AUTH_FAILED', '코드를 확인하지 못했어요');
    }
    return { id, email: loginEmail(body) ?? String(email ?? '').trim() };
  }

  async function defaultSendMagic(email) {
    const response = await fetchImpl(WORKOS_MAGIC_AUTH, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${workosApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });
    if (!response.ok) {
      throw creditsError('MAGIC_SEND_FAILED', '코드를 보내지 못했어요');
    }
  }

  async function defaultCreateKey({ name }) {
    const response = await fetchImpl(OPENROUTER_KEYS, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterProvisioningKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        limit: RAU_CREDIT_LIMIT_USD,
        limit_reset: null,
      }),
    });
    const body = await response.json().catch(() => ({}));
    const key = body?.key ?? body?.data?.key;
    const id = body?.data?.hash ?? body?.data?.id ?? body?.id ?? null;
    if (!response.ok || typeof key !== 'string' || !key) {
      throw creditsError('OPENROUTER_PROVISION_FAILED', '체험 키를 만들지 못했어요');
    }
    return { key, id: typeof id === 'string' ? id : null };
  }

  const resolveUser = authenticateWorkos ?? defaultAuthenticate;
  const resolveMagicUser = authenticateMagic ?? defaultAuthenticateMagic;
  const sendMagic = sendMagicAuth ?? defaultSendMagic;
  const mintKey = createOpenRouterKey ?? defaultCreateKey;

  /**
   * 계정당 키 하나. WorkOS 사용자 id 와 검증된 이메일을 둘 다 인덱스로 걸어,
   * 같은 메일함을 다른 인증 수단으로 들어와도 두 번째 $5 가 만들어지지 않게 한다.
   */
  async function keyForUser(workosUserId, email = null) {
    const normalizedEmail = typeof email === 'string' && email.includes('@')
      ? email.trim().toLowerCase()
      : null;
    return mutate(async (state) => {
      const byEmail = normalizedEmail ? state.emailIndex?.[normalizedEmail] : null;
      const existingId = state.users[workosUserId] ? workosUserId : byEmail;
      const existing = existingId ? state.users[existingId] : null;
      if (existing?.keyCiphertext) {
        if (normalizedEmail) {
          state.emailIndex ??= {};
          state.emailIndex[normalizedEmail] = existingId;
        }
        return decryptSecret(sessionSecret, existing.keyCiphertext);
      }
      const minted = await mintKey({ name: `rau-${workosUserId.slice(0, 12)}` });
      state.users[workosUserId] = {
        keyCiphertext: encryptSecret(sessionSecret, minted.key),
        openrouterKeyId: minted.id,
        createdAt: now(),
      };
      if (normalizedEmail) {
        state.emailIndex ??= {};
        state.emailIndex[normalizedEmail] = workosUserId;
      }
      return minted.key;
    });
  }

  async function finishDeviceLogin(deviceId, userId, email = null) {
    const accountEmail = typeof email === 'string' && email.includes('@') ? email.trim() : null;
    const session = (await store.load()).sessions[deviceId];
    if (!session || session.status !== 'pending') {
      throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없거나 만료됐어요');
    }
    if (now() - session.createdAt > SESSION_TTL_MS) {
      throw creditsError('DEVICE_SESSION_EXPIRED', '로그인 세션이 만료됐어요');
    }
    const apiKey = await keyForUser(userId, accountEmail);
    await mutate((state) => {
      const current = state.sessions[deviceId];
      if (!current || current.status !== 'pending') {
        throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없거나 만료됐어요');
      }
      if (now() - current.createdAt > SESSION_TTL_MS) {
        throw creditsError('DEVICE_SESSION_EXPIRED', '로그인 세션이 만료됐어요');
      }
      current.status = 'ready';
      current.workosUserId = userId;
      current.email = accountEmail;
      current.apiKeyCiphertext = encryptSecret(sessionSecret, apiKey);
    });
    return { deviceId, workosUserId: userId, email: accountEmail };
  }

  return {
    origin,
    redirectUri,
    sessionTtlMs: SESSION_TTL_MS,

    loginUrl(deviceId) {
      return `${origin.replace(/\/$/, '')}/login?device=${encodeURIComponent(deviceId)}`;
    },

    authorizationUrl(deviceId, provider = 'GoogleOAuth') {
      const chosen = WORKOS_PROVIDERS.has(provider) ? provider : 'GoogleOAuth';
      const url = new URL(WORKOS_AUTHORIZE);
      url.searchParams.set('client_id', workosClientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('provider', chosen);
      // IdP 세션이 남아 있어도 로그아웃한 사용자가 다른 계정을 고를 수 있어야 한다.
      url.searchParams.set('prompt', 'select_account');
      url.searchParams.set('state', deviceId);
      return url.toString();
    },

    async assertPendingDevice(deviceId) {
      const id = String(deviceId ?? '');
      const session = (await store.load()).sessions[id];
      if (!session || session.status !== 'pending') {
        throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없거나 만료됐어요');
      }
      if (now() - session.createdAt > SESSION_TTL_MS) {
        throw creditsError('DEVICE_SESSION_EXPIRED', '로그인 세션이 만료됐어요');
      }
      return id;
    },

    async createDeviceSession() {
      const id = randomBytes(24).toString('base64url');
      await mutate((state) => {
        pruneSessions(state);
        if (liveSessionCount(state) >= maxLiveSessions) {
          throw creditsError('RATE_LIMITED', '로그인 요청이 너무 많아요. 잠시 후 다시 시도해 주세요');
        }
        state.sessions[id] = { status: 'pending', createdAt: now() };
      });
      return { id, loginUrl: this.loginUrl(id) };
    },

    async sendMagicCode(email) {
      const trimmed = String(email ?? '').trim();
      if (!trimmed.includes('@')) {
        throw creditsError('MAGIC_EMAIL_INVALID', '이메일 주소를 확인해 주세요');
      }
      await sendMagic(trimmed);
      return trimmed;
    },

    async completeLogin(code, state) {
      const user = await resolveUser(String(code ?? ''));
      return finishDeviceLogin(String(state ?? ''), user.id, user.email ?? null);
    },

    async completeMagicLogin(deviceId, email, code) {
      const submitted = String(email ?? '').trim();
      const user = await resolveMagicUser(submitted, String(code ?? '').trim());
      return finishDeviceLogin(String(deviceId ?? ''), user.id, user.email ?? submitted);
    },

    async redeemDeviceSession(id) {
      const session = (await store.load()).sessions[id];
      if (!session) throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없어요');
      if (now() - session.createdAt > SESSION_TTL_MS) return { status: 'expired' };
      if (session.status === 'pending') return { status: 'pending' };
      if (session.status === 'redeemed') return { status: 'redeemed' };
      const ciphertext = session.apiKeyCiphertext;
      const apiKey = typeof ciphertext === 'string'
        ? decryptSecret(sessionSecret, ciphertext)
        : session.apiKey;
      if (session.status !== 'ready' || typeof apiKey !== 'string' || !apiKey) {
        throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션을 확인할 수 없어요');
      }
      // 이메일은 로그인한 계정을 카드에 보여 주는 용도 — redeem 응답에 한 번만 실린다.
      const accountEmail = typeof session.email === 'string' && session.email.includes('@')
        ? session.email
        : null;
      return { status: 'ready', apiKey, ...(accountEmail ? { email: accountEmail } : {}) };
    },

    async acknowledgeDeviceSession(id) {
      return mutate((state) => {
        pruneSessions(state);
        const session = state.sessions[id];
        if (!session) throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없어요');
        if (session.status === 'redeemed') return { status: 'redeemed' };
        if (session.status !== 'ready') {
          throw creditsError('DEVICE_SESSION_INVALID', '완료되지 않은 로그인 세션이에요');
        }
        session.status = 'redeemed';
        session.redeemedAt = now();
        delete session.apiKey;
        delete session.apiKeyCiphertext;
        return { status: 'redeemed' };
      });
    },
  };
}

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw creditsError('BODY_TOO_LARGE', '요청 본문이 너무 커요');
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

function htmlErrorStatus(error) {
  if (error?.code === 'DEVICE_SESSION_INVALID' || error?.code === 'DEVICE_SESSION_EXPIRED') return 400;
  if (error?.code === 'RATE_LIMITED') return 429;
  if (error?.code === 'BODY_TOO_LARGE') return 413;
  return 500;
}

export function creditsRequestListener(service) {
  const limiter = createRateLimiter();
  const MINUTE = 60 * 1000;
  const TEN_MINUTES = 10 * MINUTE;
  return async (req, res) => {
    const host = req.headers.host ?? '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const ip = clientIp(req);
    const send = (status, body, headers = {}) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
        ...headers,
      });
      res.end(payload);
    };
    const fail = (error, device = '') => {
      send(htmlErrorStatus(error), renderFailPage({
        message: error?.message ?? '잠시 후 다시 시도해 주세요',
        device,
      }));
    };
    const throttled = (device = '') => fail(
      creditsError('RATE_LIMITED', '요청이 너무 많아요. 잠시 후 다시 시도해 주세요'),
      device,
    );
    try {
      if (req.method === 'GET' && (url.pathname === '/rau.png' || url.pathname === '/favicon.ico')) {
        const icon = await readFile(RAU_ICON_PATH);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(icon);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        send(200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/device-sessions') {
        if (!limiter.check(`create:${ip}`, 10, TEN_MINUTES)) {
          send(429, { error: 'RATE_LIMITED', message: '로그인 요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        send(200, await service.createDeviceSession());
        return;
      }
      const redeem = url.pathname.match(/^\/v1\/device-sessions\/([^/]+)$/);
      if (req.method === 'GET' && redeem) {
        if (!limiter.check(`redeem:${ip}`, 300, MINUTE)) {
          send(429, { error: 'RATE_LIMITED', message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        send(200, await service.redeemDeviceSession(decodeURIComponent(redeem[1])));
        return;
      }
      const acknowledge = url.pathname.match(/^\/v1\/device-sessions\/([^/]+)\/acknowledge$/);
      if (req.method === 'POST' && acknowledge) {
        if (!limiter.check(`ack:${ip}`, 30, MINUTE)) {
          send(429, { error: 'RATE_LIMITED', message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        send(200, await service.acknowledgeDeviceSession(decodeURIComponent(acknowledge[1])));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/login') {
        const device = url.searchParams.get('device');
        if (!device) {
          send(400, renderFailPage({ message: '로그인 세션이 없어요' }));
          return;
        }
        if (!limiter.check(`page:${ip}`, 60, MINUTE)) {
          throttled(device);
          return;
        }
        await service.assertPendingDevice(device);
        send(200, renderLoginPage({ device, notice: url.searchParams.get('notice') ?? '' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/continue') {
        const device = url.searchParams.get('device');
        const provider = url.searchParams.get('provider') ?? 'GoogleOAuth';
        if (!limiter.check(`page:${ip}`, 60, MINUTE)) {
          throttled(device);
          return;
        }
        await service.assertPendingDevice(device);
        send(302, '', { Location: service.authorizationUrl(device, provider) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login/magic') {
        const form = await readForm(req);
        const device = form.get('device') ?? '';
        if (!limiter.check(`magic:${ip}`, 5, TEN_MINUTES)) {
          throttled(device);
          return;
        }
        await service.assertPendingDevice(device);
        const email = String(form.get('email') ?? '').trim();
        if (!limiter.check(`magic-email:${email.toLowerCase()}`, 3, TEN_MINUTES)) {
          throttled(device);
          return;
        }
        try {
          const sent = await service.sendMagicCode(email);
          send(200, renderCodePage({ device, email: sent }));
        } catch (error) {
          send(400, renderLoginPage({
            device,
            email: form.get('email') ?? '',
            notice: error?.message ?? '코드를 보내지 못했어요',
          }));
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login/magic/verify') {
        const form = await readForm(req);
        const device = form.get('device') ?? '';
        const email = form.get('email') ?? '';
        if (!limiter.check(`verify:${ip}`, 10, TEN_MINUTES)) {
          throttled(device);
          return;
        }
        try {
          await service.completeMagicLogin(device, email, form.get('code'));
          send(200, renderDonePage());
        } catch (error) {
          if (error?.code === 'DEVICE_SESSION_INVALID' || error?.code === 'DEVICE_SESSION_EXPIRED') {
            fail(error, device);
            return;
          }
          send(400, renderCodePage({
            device,
            email,
            notice: error?.message ?? '코드를 확인하지 못했어요',
          }));
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/callback') {
        try {
          await service.completeLogin(url.searchParams.get('code'), url.searchParams.get('state'));
          send(200, renderDonePage());
        } catch (error) {
          fail(error, url.searchParams.get('state') ?? '');
        }
        return;
      }
      send(404, { error: 'not found' });
    } catch (error) {
      if (url.pathname.startsWith('/v1') || url.pathname === '/healthz') {
        send(htmlErrorStatus(error), {
          error: error?.code ?? 'RAU_CREDITS_FAILED',
          message: error?.message ?? String(error),
        });
        return;
      }
      fail(error, url.searchParams.get('device') ?? url.searchParams.get('state') ?? '');
    }
  };
}

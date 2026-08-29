import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { decryptSecret, encryptSecret } from './crypto.mjs';
import { RAU_CREDIT_LIMIT_USD, RAU_MODEL_IDS } from './catalog.mjs';
import {
  renderCodePage,
  renderDonePage,
  renderFailPage,
  renderLoginPage,
} from './pages.mjs';
import { createMemoryStore } from './store.mjs';

const SESSION_TTL_MS = 10 * 60 * 1000;
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
 *   authenticateWorkos?: (code: string) => Promise<{ id: string }>,
 *   authenticateMagic?: (email: string, code: string) => Promise<{ id: string }>,
 *   sendMagicAuth?: (email: string) => Promise<void>,
 *   createOpenRouterKey?: (input: { name: string }) => Promise<{ key: string, id?: string }>,
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
} = {}) {
  if (!origin) throw new Error('origin is required');
  if (!sessionSecret) throw new Error('sessionSecret is required');

  const redirectUri = `${origin.replace(/\/$/, '')}/callback`;

  async function mutate(task) {
    const state = await store.load();
    const result = await task(state);
    await store.save(state);
    return result;
  }

  function pruneSessions(state) {
    const cutoff = now() - SESSION_TTL_MS;
    for (const [id, session] of Object.entries(state.sessions)) {
      if (session.status === 'pending' && session.createdAt < cutoff) delete state.sessions[id];
    }
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
    return { id };
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
    return { id };
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
        // OpenRouter ignores unknown fields; when supported this locks the trial SKUs.
        allowed_models: [...RAU_MODEL_IDS],
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

  async function keyForUser(workosUserId) {
    return mutate(async (state) => {
      const existing = state.users[workosUserId];
      if (existing?.keyCiphertext) {
        return decryptSecret(sessionSecret, existing.keyCiphertext);
      }
      const minted = await mintKey({ name: `rau-${workosUserId.slice(0, 12)}` });
      state.users[workosUserId] = {
        keyCiphertext: encryptSecret(sessionSecret, minted.key),
        openrouterKeyId: minted.id,
        createdAt: now(),
      };
      return minted.key;
    });
  }

  async function finishDeviceLogin(deviceId, userId) {
    const session = (await store.load()).sessions[deviceId];
    if (!session || session.status !== 'pending') {
      throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없거나 만료됐어요');
    }
    if (now() - session.createdAt > SESSION_TTL_MS) {
      throw creditsError('DEVICE_SESSION_EXPIRED', '로그인 세션이 만료됐어요');
    }
    const apiKey = await keyForUser(userId);
    await mutate((state) => {
      const current = state.sessions[deviceId];
      if (!current || current.status !== 'pending') {
        throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없거나 만료됐어요');
      }
      current.status = 'ready';
      current.workosUserId = userId;
      current.apiKey = apiKey;
    });
    return { deviceId, workosUserId: userId };
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
      return finishDeviceLogin(String(state ?? ''), user.id);
    },

    async completeMagicLogin(deviceId, email, code) {
      const user = await resolveMagicUser(String(email ?? '').trim(), String(code ?? '').trim());
      return finishDeviceLogin(String(deviceId ?? ''), user.id);
    },

    async redeemDeviceSession(id) {
      return mutate((state) => {
        pruneSessions(state);
        const session = state.sessions[id];
        if (!session) throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없어요');
        if (session.status === 'pending') return { status: 'pending' };
        if (session.status === 'redeemed') return { status: 'redeemed' };
        if (session.status !== 'ready' || !session.apiKey) {
          throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션을 확인할 수 없어요');
        }
        const apiKey = session.apiKey;
        session.status = 'redeemed';
        session.redeemedAt = now();
        delete session.apiKey;
        return { status: 'ready', apiKey };
      });
    },
  };
}

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function htmlErrorStatus(error) {
  return error?.code === 'DEVICE_SESSION_INVALID' || error?.code === 'DEVICE_SESSION_EXPIRED'
    ? 400
    : 500;
}

export function creditsRequestListener(service) {
  return async (req, res) => {
    const host = req.headers.host ?? '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);
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
        send(200, await service.createDeviceSession());
        return;
      }
      const redeem = url.pathname.match(/^\/v1\/device-sessions\/([^/]+)$/);
      if (req.method === 'GET' && redeem) {
        send(200, await service.redeemDeviceSession(decodeURIComponent(redeem[1])));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/login') {
        const device = url.searchParams.get('device');
        if (!device) {
          send(400, renderFailPage({ message: '로그인 세션이 없어요' }));
          return;
        }
        await service.assertPendingDevice(device);
        send(200, renderLoginPage({ device, notice: url.searchParams.get('notice') ?? '' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/continue') {
        const device = url.searchParams.get('device');
        const provider = url.searchParams.get('provider') ?? 'GoogleOAuth';
        await service.assertPendingDevice(device);
        send(302, '', { Location: service.authorizationUrl(device, provider) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login/magic') {
        const form = await readForm(req);
        const device = form.get('device') ?? '';
        await service.assertPendingDevice(device);
        try {
          const email = await service.sendMagicCode(form.get('email'));
          send(200, renderCodePage({ device, email }));
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

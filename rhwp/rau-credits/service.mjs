import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { decryptSecret, encryptSecret } from './crypto.mjs';
import { createRaucloudBroker } from './cloud-broker.mjs';
import { RAU_CREDIT_LIMIT_USD, RAU_MODEL_IDS } from './catalog.mjs';
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
const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const OPENROUTER_KEYS = 'https://openrouter.ai/api/v1/keys';
const WORKOS_PROVIDERS = new Set(['GoogleOAuth', 'GitHubOAuth']);
const RAU_MODELS = new Set(RAU_MODEL_IDS);
const ACCESS_TOKEN_PREFIX = 'rau_v1_';
const PROXY_BODY_BYTES = 24 * 1024 * 1024;
const RAU_ICON_PATH = fileURLToPath(new URL('./public/rau.png', import.meta.url));

function creditsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function accessTokenHash(token) {
  return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

function newAccessToken() {
  return `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function ensureState(state) {
  state.users ??= {};
  state.sessions ??= {};
  state.emailIndex ??= {};
  state.accessTokens ??= {};
  return state;
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
 *   createOpenRouterKey?: (input: { name: string, limit?: number }) => Promise<{ key: string, id?: string }>,
 *   inspectOpenRouterKey?: (input: { key: string }) => Promise<{ limit: number, usage: number }>,
 *   deleteOpenRouterKey?: (input: { id: string }) => Promise<void>,
 *   maxLiveSessions?: number,
 *   cloudWorkerSecret?: string,
 *   cloudProvisioner?: { provision: Function, teardown: Function }|null,
 *   cloudProvisionerRequired?: boolean,
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
  inspectOpenRouterKey = null,
  deleteOpenRouterKey = null,
  maxLiveSessions = 2000,
  cloudWorkerSecret = '',
  cloudProvisioner = null,
  cloudProvisionerRequired = false,
} = {}) {
  if (!origin) throw new Error('origin is required');
  if (!sessionSecret) throw new Error('sessionSecret is required');

  const redirectUri = `${origin.replace(/\/$/, '')}/callback`;
  let mutationChain = Promise.resolve();

  function mutate(task) {
    if (typeof store.mutate === 'function') {
      return store.mutate((state) => task(ensureState(state)));
    }
    const running = mutationChain.then(async () => {
      const state = ensureState(await store.load());
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
      if (session.createdAt >= cutoff) continue;
      // A ready-but-unacknowledged token was never safely persisted by the app.
      // Revoke it while pruning instead of leaving an orphan proxy credential.
      if (session.status === 'ready' && session.accessHash) {
        delete state.accessTokens[session.accessHash];
      }
      delete state.sessions[id];
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

  async function defaultCreateKey({ name, limit = RAU_CREDIT_LIMIT_USD }) {
    const response = await fetchImpl(OPENROUTER_KEYS, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterProvisioningKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        limit,
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

  async function defaultInspectKey({ key }) {
    const response = await fetchImpl(`${OPENROUTER_API}/key`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    const body = await response.json().catch(() => ({}));
    const limit = Number(body?.data?.limit);
    const usage = Number(body?.data?.usage);
    if (!response.ok || !Number.isFinite(limit) || !Number.isFinite(usage)) {
      throw creditsError('OPENROUTER_KEY_INSPECT_FAILED', '기존 체험 키 잔액을 확인하지 못했어요');
    }
    return { limit, usage };
  }

  async function defaultDeleteKey({ id }) {
    const response = await fetchImpl(`${OPENROUTER_KEYS}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${openRouterProvisioningKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!response.ok && response.status !== 404) {
      throw creditsError('OPENROUTER_KEY_DELETE_FAILED', '기존 체험 키를 폐기하지 못했어요');
    }
  }

  const resolveUser = authenticateWorkos ?? defaultAuthenticate;
  const resolveMagicUser = authenticateMagic ?? defaultAuthenticateMagic;
  const sendMagic = sendMagicAuth ?? defaultSendMagic;
  const mintKey = createOpenRouterKey ?? defaultCreateKey;
  const inspectKey = inspectOpenRouterKey ?? defaultInspectKey;
  const deleteKey = deleteOpenRouterKey ?? defaultDeleteKey;

  /**
   * 계정당 키 하나. WorkOS 사용자 id 와 검증된 이메일을 둘 다 인덱스로 걸어,
   * 같은 메일함을 다른 인증 수단으로 들어와도 두 번째 $5 가 만들어지지 않게 한다.
   */
  async function keyForUser(workosUserId, email = null) {
    const accountEmail = typeof email === 'string' && email.includes('@') ? email.trim() : null;
    const normalizedEmail = accountEmail?.toLowerCase() ?? null;
    return mutate(async (state) => {
      const byEmail = normalizedEmail ? state.emailIndex?.[normalizedEmail] : null;
      const existingId = state.users[workosUserId] ? workosUserId : byEmail;
      const existing = existingId ? state.users[existingId] : null;
      let existingKey = null;
      if (existing?.keyCiphertext) {
        try {
          existingKey = decryptSecret(sessionSecret, existing.keyCiphertext);
        } catch {
          // SESSION_SECRET 회전 등으로 복호화가 깨진 레코드는 없는 것으로 본다 — 재발급으로 잠금을 푼다.
          existingKey = null;
        }
      }
      if (existingKey) {
        if (accountEmail) existing.email = accountEmail;
        const accountId = existing.accountId ?? existingId;
        existing.accountId = accountId;
        if (existingId !== workosUserId) {
          state.users[workosUserId] = { ...state.users[existingId], accountId };
        }
        if (normalizedEmail) {
          state.emailIndex ??= {};
          state.emailIndex[normalizedEmail] = accountId;
        }
        return { key: existingKey, accountId };
      }
      const minted = await mintKey({ name: `rau-${workosUserId.slice(0, 12)}` });
      state.users[workosUserId] = {
        keyCiphertext: encryptSecret(sessionSecret, minted.key),
        openrouterKeyId: minted.id,
        credentialVersion: 2,
        accountId: workosUserId,
        carriedUsageUsd: 0,
        ...(accountEmail ? { email: accountEmail } : {}),
        createdAt: now(),
      };
      if (normalizedEmail) {
        state.emailIndex ??= {};
        state.emailIndex[normalizedEmail] = workosUserId;
      }
      return { key: minted.key, accountId: workosUserId };
    });
  }

  async function finishDeviceLogin(deviceId, userId, email = null) {
    const accountEmail = typeof email === 'string' && email.includes('@') ? email.trim() : null;
    const session = ensureState(await store.load()).sessions[deviceId];
    if (!session || session.status !== 'pending') {
      throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없거나 만료됐어요');
    }
    if (now() - session.createdAt > SESSION_TTL_MS) {
      throw creditsError('DEVICE_SESSION_EXPIRED', '로그인 세션이 만료됐어요');
    }
    // The provider key never leaves this service. The desktop receives a random,
    // revocable Rau token that is accepted only by the constrained proxy below.
    const account = await keyForUser(userId, accountEmail);
    const accessToken = newAccessToken();
    const accessHash = accessTokenHash(accessToken);
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
      current.accessHash = accessHash;
      current.accessTokenCiphertext = encryptSecret(sessionSecret, accessToken);
      state.accessTokens[accessHash] = {
        workosUserId: userId,
        accountId: account.accountId,
        createdAt: now(),
      };
      if (current.replaceAccessHash && current.replaceAccessHash !== accessHash) {
        delete state.accessTokens[current.replaceAccessHash];
      }
    });
    return { deviceId, workosUserId: userId, email: accountEmail };
  }

  async function accessRecord(token) {
    const trimmed = String(token ?? '').trim();
    if (!trimmed.startsWith(ACCESS_TOKEN_PREFIX)) {
      throw creditsError('RAU_ACCESS_INVALID', 'Rau 로그인이 만료되었어요. 다시 로그인해 주세요');
    }
    const state = ensureState(await store.load());
    const grant = state.accessTokens[accessTokenHash(trimmed)];
    const user = grant ? state.users[grant.workosUserId] : null;
    if (!grant || !user?.keyCiphertext) {
      throw creditsError('RAU_ACCESS_INVALID', 'Rau 로그인이 만료되었어요. 다시 로그인해 주세요');
    }
    let apiKey;
    try {
      apiKey = decryptSecret(sessionSecret, user.keyCiphertext);
    } catch {
      throw creditsError('RAU_ACCESS_INVALID', 'Rau 계정 키를 갱신해야 해요. 다시 로그인해 주세요');
    }
    return { grant, user, apiKey };
  }

  const cloudBroker = createRaucloudBroker({
    store,
    mutate,
    now,
    workerSecret: cloudWorkerSecret,
    provisioner: cloudProvisioner,
    provisionerRequired: cloudProvisionerRequired,
    authenticateAccessToken: async (token, deviceId = null) => {
      const trimmed = String(token ?? '').trim();
      const { grant } = await accessRecord(trimmed);
      if (deviceId) {
        await mutate((state) => {
          const current = state.accessTokens[accessTokenHash(trimmed)];
          if (!current) throw creditsError('RAU_ACCESS_INVALID', 'Rau 로그인이 만료되었어요. 다시 로그인해 주세요');
          if (current.cloudDeviceId && current.cloudDeviceId !== deviceId) {
            throw creditsError('CLOUD_DEVICE_MISMATCH', 'This account token is already bound to another Cloud device');
          }
          current.cloudDeviceId ??= deviceId;
        });
      }
      return grant.accountId ?? grant.workosUserId;
    },
  });

  return {
    origin,
    redirectUri,
    sessionTtlMs: SESSION_TTL_MS,

    /**
     * One-time migration for builds that previously handed child keys to the
     * desktop. Rotate each unique legacy key, preserve its remaining allowance,
     * and delete the formerly extractable key with the management credential.
     */
    async migrateLegacyKeys() {
      const snapshot = ensureState(await store.load());
      const legacy = new Map();
      for (const [userId, user] of Object.entries(snapshot.users)) {
        if (user?.credentialVersion === 2 || !user?.keyCiphertext || !user?.openrouterKeyId) continue;
        if (!legacy.has(user.openrouterKeyId)) legacy.set(user.openrouterKeyId, { userId, user });
      }
      let migrated = 0;
      for (const [oldKeyId, { userId, user }] of legacy) {
        const oldKey = decryptSecret(sessionSecret, user.keyCiphertext);
        const balance = await inspectKey({ key: oldKey });
        const priorLimit = Math.min(RAU_CREDIT_LIMIT_USD, Math.max(0, balance.limit));
        const carriedUsageUsd = Math.min(priorLimit, Math.max(0, balance.usage));
        const remaining = Math.max(0, priorLimit - carriedUsageUsd);
        const replacement = await mintKey({
          name: `rau-${userId.slice(0, 12)}-proxy`,
          limit: remaining,
        });
        if (!replacement?.key || !replacement?.id) {
          throw creditsError('OPENROUTER_PROVISION_FAILED', '교체용 체험 키를 만들지 못했어요');
        }
        await deleteKey({ id: oldKeyId });
        await mutate((state) => {
          for (const record of Object.values(state.users)) {
            if (record?.openrouterKeyId !== oldKeyId) continue;
            record.keyCiphertext = encryptSecret(sessionSecret, replacement.key);
            record.openrouterKeyId = replacement.id;
            record.credentialVersion = 2;
            record.carriedUsageUsd = carriedUsageUsd;
          }
        });
        migrated += 1;
      }
      return { migrated };
    },

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
      const session = ensureState(await store.load()).sessions[id];
      if (!session || session.status !== 'pending') {
        throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없거나 만료됐어요');
      }
      if (now() - session.createdAt > SESSION_TTL_MS) {
        throw creditsError('DEVICE_SESSION_EXPIRED', '로그인 세션이 만료됐어요');
      }
      return id;
    },

    async createDeviceSession({ replaceAccessToken = null } = {}) {
      const id = randomBytes(24).toString('base64url');
      const replacement = String(replaceAccessToken ?? '').trim();
      await mutate((state) => {
        pruneSessions(state);
        if (liveSessionCount(state) >= maxLiveSessions) {
          throw creditsError('RATE_LIMITED', '로그인 요청이 너무 많아요. 잠시 후 다시 시도해 주세요');
        }
        const replaceAccessHash = replacement.startsWith(ACCESS_TOKEN_PREFIX)
          && state.accessTokens[accessTokenHash(replacement)]
          ? accessTokenHash(replacement)
          : null;
        state.sessions[id] = {
          status: 'pending',
          createdAt: now(),
          ...(replaceAccessHash ? { replaceAccessHash } : {}),
        };
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
      const session = ensureState(await store.load()).sessions[id];
      if (!session) throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없어요');
      if (now() - session.createdAt > SESSION_TTL_MS) return { status: 'expired' };
      if (session.status === 'pending') return { status: 'pending' };
      if (session.status === 'redeemed') return { status: 'redeemed' };
      const ciphertext = session.accessTokenCiphertext;
      const accessToken = typeof ciphertext === 'string'
        ? decryptSecret(sessionSecret, ciphertext)
        : session.accessToken;
      if (session.status !== 'ready' || typeof accessToken !== 'string' || !accessToken) {
        throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션을 확인할 수 없어요');
      }
      // 이메일은 로그인한 계정을 카드에 보여 주는 용도 — redeem 응답에 한 번만 실린다.
      const accountEmail = typeof session.email === 'string' && session.email.includes('@')
        ? session.email
        : null;
      return { status: 'ready', accessToken, ...(accountEmail ? { email: accountEmail } : {}) };
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
        delete session.accessToken;
        delete session.accessTokenCiphertext;
        return { status: 'redeemed' };
      });
    },

    /** Idempotently revoke a device token. The provider key remains server-side. */
    async revokeAccessToken(token, { deviceId = null } = {}) {
      const trimmed = String(token ?? '').trim();
      if (!trimmed) return { revoked: false };
      if (deviceId) await cloudBroker.logoutCloudDevice(trimmed, deviceId);
      return mutate((state) => {
        const hash = accessTokenHash(trimmed);
        const revoked = Object.hasOwn(state.accessTokens, hash);
        delete state.accessTokens[hash];
        return { revoked };
      });
    },

    /**
     * Forward only the OpenRouter operations Rau needs. The caller can choose
     * only the product allowlist; management APIs and arbitrary models are denied.
     */
    async proxyOpenRouter(token, { pathname, method, body = null, signal = undefined } = {}) {
      const route = String(pathname ?? '');
      const verb = String(method ?? 'GET').toUpperCase();
      const allowedRead = verb === 'GET' && (route === '/key' || route === '/credits');
      const allowedChat = verb === 'POST' && route === '/chat/completions';
      if (!allowedRead && !allowedChat) {
        throw creditsError('RAU_PROXY_FORBIDDEN', '이 Rau API 작업은 허용되지 않아요');
      }
      if (allowedChat) {
        const model = typeof body?.model === 'string' ? body.model : '';
        if (!RAU_MODELS.has(model)) {
          throw creditsError('RAU_MODEL_FORBIDDEN', '이 모델은 Rau 체험에서 사용할 수 없어요');
        }
      }
      const { user, apiKey } = await accessRecord(token);
      const upstream = await fetchImpl(`${OPENROUTER_API}${route}`, {
        method: verb,
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Title': 'Rauhwpx',
        },
        body: allowedChat ? JSON.stringify(body) : undefined,
      });
      const carriedUsageUsd = Number(user.carriedUsageUsd) || 0;
      if (route !== '/key' || !upstream.ok || carriedUsageUsd <= 0) return upstream;
      const payload = await upstream.json().catch(() => null);
      if (!payload?.data) return new Response(JSON.stringify(payload ?? {}), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      });
      const currentUsage = Number(payload.data.usage) || 0;
      payload.data.limit = RAU_CREDIT_LIMIT_USD;
      payload.data.usage = Math.min(RAU_CREDIT_LIMIT_USD, carriedUsageUsd + currentUsage);
      payload.data.limit_remaining = Math.max(0, RAU_CREDIT_LIMIT_USD - payload.data.usage);
      return new Response(JSON.stringify(payload), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      });
    },

    ...cloudBroker,
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

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw creditsError('BODY_TOO_LARGE', '요청 본문이 너무 커요');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw creditsError('INVALID_JSON', '요청 본문을 확인할 수 없어요');
  }
}

function bearerToken(req) {
  const match = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

/** Railway 엣지가 덧붙이는 마지막 XFF 홉이 실제 접속 주소다. 첫 홉은 클라이언트가 위조할 수 있다. */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

function htmlErrorStatus(error) {
  if (error?.code === 'DEVICE_SESSION_INVALID' || error?.code === 'DEVICE_SESSION_EXPIRED') return 400;
  if (error?.code === 'RAU_ACCESS_INVALID') return 401;
  if (error?.code === 'RAU_PROXY_FORBIDDEN' || error?.code === 'RAU_MODEL_FORBIDDEN') return 403;
  if (error?.code === 'INVALID_JSON') return 400;
  if (error?.code === 'RATE_LIMITED') return 429;
  if (error?.code === 'BODY_TOO_LARGE') return 413;
  if (error?.code === 'CLOUD_WORKER_UNAUTHORIZED' || error?.code === 'RAU_ACCESS_INVALID') return 401;
  if (error?.code === 'CLOUD_RUN_NOT_FOUND') return 404;
  if (error?.code === 'CLOUD_DEVICE_MISMATCH') return 403;
  if (error?.code === 'CLOUD_UNAVAILABLE' || error?.code === 'CLOUD_PROVISION_FAILED') return 503;
  if (error?.code === 'CLOUD_QUOTA_EXHAUSTED'
    || error?.code === 'CLOUD_COLD_START_RATE_LIMITED'
    || error?.code === 'CLOUD_TIMEZONE_CHANGE_RATE_LIMITED') return 429;
  if (error?.code?.startsWith?.('CLOUD_OWNED_')
    || error?.code === 'CLOUD_RUN_ALREADY_ACTIVE'
    || error?.code === 'CLOUD_TEARDOWN_PENDING'
    || error?.code === 'CLOUD_TAKEOVER_NOT_READY'
    || error?.code === 'CLOUD_RUN_STATE_INVALID') return 409;
  if (error?.code?.startsWith?.('CLOUD_')) return 400;
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
      if (req.method === 'GET' && url.pathname === '/v1/account') {
        send(200, await service.getAccount(bearerToken(req)));
        return;
      }
      if (req.method === 'PATCH' && (url.pathname === '/v1/account' || url.pathname === '/v1/account/timezone')) {
        const body = await readJson(req);
        send(200, await service.setAccountTimezone(bearerToken(req), body.timezone));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/cloud/status') {
        send(200, await service.getCloudStatus(bearerToken(req), {
          deviceId: url.searchParams.get('deviceId') ?? '',
          timezone: url.searchParams.get('timezone'),
          runId: url.searchParams.get('runId'),
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/cloud/runs') {
        const body = await readJson(req);
        send(201, await service.createCloudRun(bearerToken(req), {
          ...body,
          idempotencyKey: body.idempotencyKey ?? req.headers['idempotency-key'],
        }));
        return;
      }
      const takeover = url.pathname.match(/^\/v1\/cloud\/runs\/([^/]+)\/takeover$/);
      if (req.method === 'POST' && takeover) {
        const body = await readJson(req);
        send(201, await service.takeoverCloudRun(
          bearerToken(req),
          decodeURIComponent(takeover[1]),
          { ...body, idempotencyKey: body.idempotencyKey ?? req.headers['idempotency-key'] },
        ));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/cloud/force-quit') {
        const body = await readJson(req);
        send(200, await service.forceQuitAccountCloud(bearerToken(req), body));
        return;
      }
      const stop = url.pathname.match(/^\/v1\/cloud\/runs\/([^/]+)\/stop$/);
      if (req.method === 'POST' && stop) {
        const body = await readJson(req);
        send(200, await service.stopCloudRun(bearerToken(req), decodeURIComponent(stop[1]), body));
        return;
      }
      const internal = url.pathname.match(/^\/v1\/internal\/cloud\/runs\/([^/]+)\/(allocation|heartbeat|checkpoint|complete|release)$/);
      if (req.method === 'POST' && internal) {
        const body = await readJson(req);
        const secret = bearerToken(req);
        const runId = decodeURIComponent(internal[1]);
        const action = internal[2];
        let result;
        if (action === 'allocation') result = await service.confirmCloudAllocation(secret, runId);
        if (action === 'heartbeat') result = await service.heartbeatCloudRun(secret, runId);
        if (action === 'checkpoint') result = await service.checkpointCloudRun(secret, runId, body.checkpointId);
        if (action === 'complete') result = await service.completeCloudRun(secret, runId, body);
        if (action === 'release') result = await service.releaseCloudRun(secret, runId, body);
        send(200, result);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/internal/cloud/lease') {
        send(200, await service.getCloudLease(bearerToken(req)));
        return;
      }
      const proxy = url.pathname.match(/^\/v1\/openrouter(\/.*)$/);
      if (proxy) {
        const token = bearerToken(req);
        const fingerprint = accessTokenHash(token).slice(0, 24);
        if (!limiter.check(`proxy:${fingerprint}:${ip}`, 180, MINUTE)) {
          send(429, { error: 'RATE_LIMITED', message: 'Rau 요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        const body = req.method === 'POST' ? await readJson(req, PROXY_BODY_BYTES) : null;
        const proxyAbort = new AbortController();
        const abortProxy = () => {
          if (!res.writableEnded) proxyAbort.abort();
        };
        req.once('aborted', abortProxy);
        res.once('close', abortProxy);
        const upstream = await service.proxyOpenRouter(token, {
          pathname: proxy[1],
          method: req.method,
          body,
          signal: proxyAbort.signal,
        });
        const headers = {};
        for (const name of ['content-type', 'cache-control', 'x-request-id']) {
          const value = upstream.headers?.get?.(name);
          if (value) headers[name] = value;
        }
        res.writeHead(upstream.status, headers);
        if (!upstream.body) {
          res.end();
          return;
        }
        const bodyStream = Readable.fromWeb(upstream.body);
        bodyStream.once('error', () => res.destroy());
        bodyStream.pipe(res);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/access/revoke') {
        const body = await readJson(req);
        send(200, await service.revokeAccessToken(bearerToken(req), { deviceId: body.deviceId ?? null }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/device-sessions') {
        if (!limiter.check(`create:${ip}`, 10, TEN_MINUTES)) {
          send(429, { error: 'RATE_LIMITED', message: '로그인 요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        send(200, await service.createDeviceSession({ replaceAccessToken: bearerToken(req) || null }));
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
        if (!limiter.check(`callback:${ip}`, 20, TEN_MINUTES)) {
          throttled(url.searchParams.get('state') ?? '');
          return;
        }
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
          ...(error?.details === undefined ? {} : { details: error.details }),
        });
        return;
      }
      fail(error, url.searchParams.get('device') ?? url.searchParams.get('state') ?? '');
    }
  };
}

import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { decryptSecret, encryptSecret } from './crypto.mjs';
import { createRaucloudBroker } from './cloud-broker.mjs';
import { RAU_CREDIT_LIMIT_USD, RAU_MODEL_IDS } from './catalog.mjs';
import {
  renderCodePage,
  renderConfirmPage,
  renderDonePage,
  renderFailPage,
  renderLoginPage,
  renderReadyPage,
  renderUniqueInstallsPage,
} from './pages.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { assertStoreStateFits, createMemoryStore } from './store.mjs';
import {
  createUniqueInstallsService,
  emptyUniqueInstallsState,
} from './unique-installs.mjs';

const SESSION_TTL_MS = 10 * 60 * 1000;
const AUTHORIZATION_TTL_MS = 2 * 60 * 1000;
const ACCOUNT_SESSION_PENDING_TTL_MS = 10 * 60 * 1000;
const ACCOUNT_SESSION_REVOKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_UPSTREAM_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_MANUAL_ATTEMPTS = 5;
const MAX_KEY_RECONCILE_PAGES = 10;
const MAX_WORKOS_USER_ID_BYTES = 256;
const MAX_LOGIN_EMAIL_BYTES = 320;
const MAX_OPENROUTER_KEY_BYTES = 8 * 1024;
const MAX_OPENROUTER_KEY_ID_BYTES = 1024;
const MAX_ACCOUNT_TOKEN_BYTES = 256;
const MAX_PROVISIONING_INTENT_ID_BYTES = 64;
const MAX_PROVISIONING_INTENT_NAME_BYTES = 320;
const MANUAL_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const WORKOS_AUTHORIZE = 'https://api.workos.com/user_management/authorize';
const WORKOS_AUTHENTICATE = 'https://api.workos.com/user_management/authenticate';
const WORKOS_MAGIC_AUTH = 'https://api.workos.com/user_management/magic_auth';
const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const OPENROUTER_KEYS = 'https://openrouter.ai/api/v1/keys';
const RAU_MODELS = new Set(RAU_MODEL_IDS);
const ACCESS_TOKEN_PREFIX = 'rau_v1_';
const PROXY_BODY_BYTES = 24 * 1024 * 1024;
const WORKOS_PROVIDERS = new Set(['GoogleOAuth', 'GitHubOAuth']);
const RAU_ICON_PATH = fileURLToPath(new URL('./public/rau.png', import.meta.url));
const OPENROUTER_MINT_NOT_DISPATCHED = Symbol('openrouter-mint-not-dispatched');
const ACCOUNT_TOKEN_PREFIX = 'rau_account_v1_';

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
  state.accountSessions ??= {};
  return state;
}

function bearerToken(req) {
  const match = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

/**
 * Mark only failures for which the adapter can prove that no paid provider
 * request was dispatched. Ordinary fetch/network failures remain uncertain.
 */
export function markOpenRouterMintNotDispatched(error) {
  const marked = error instanceof Error ? error : new Error(String(error ?? 'OpenRouter mint failed'));
  Object.defineProperty(marked, OPENROUTER_MINT_NOT_DISPATCHED, { value: true });
  return marked;
}

function isOpenRouterMintNotDispatched(error) {
  return error?.[OPENROUTER_MINT_NOT_DISPATCHED] === true;
}

function boundedUtf8(value, maxBytes) {
  return typeof value === 'string'
    && value.length <= maxBytes
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function validatedWorkosUserId(value) {
  if (!boundedUtf8(value, MAX_WORKOS_USER_ID_BYTES)
    || !/^user_[A-Za-z0-9_-]+$/.test(value)) {
    throw creditsError('WORKOS_AUTH_FAILED', '로그인 계정 정보를 확인하지 못했어요');
  }
  return value;
}

function validatedAccountEmail(value) {
  if (value == null) return null;
  if (!boundedUtf8(value, MAX_LOGIN_EMAIL_BYTES)) {
    throw creditsError('WORKOS_AUTH_FAILED', '로그인 이메일 정보를 확인하지 못했어요');
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized.includes('@')) return null;
  return normalized;
}

function validatedMintedKey(value) {
  if (!boundedUtf8(value, MAX_OPENROUTER_KEY_BYTES) || !value.trim()) {
    throw creditsError('OPENROUTER_PROVISION_FAILED', '발급된 체험 키 형식을 확인하지 못했어요');
  }
  return value.trim();
}

function validatedMintedKeyId(value) {
  if (value == null) return null;
  if (!boundedUtf8(value, MAX_OPENROUTER_KEY_ID_BYTES)
    || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw creditsError('OPENROUTER_PROVISION_FAILED', '발급된 체험 키 식별자를 확인하지 못했어요');
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('base64url');
}

function sameDigest(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function accountTokenDigest(value, { optional = false } = {}) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token && optional) return null;
  if (!boundedUtf8(token, MAX_ACCOUNT_TOKEN_BYTES)
    || !/^rau_account_v1_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw creditsError('ACCOUNT_SESSION_INVALID', '계정 세션을 확인할 수 없어요');
  }
  return digest(token);
}

function accountSnapshot(record) {
  if (!record || record.status !== 'active') {
    return { state: record?.status === 'pending' ? 'pending' : 'signed-out', signedIn: false, account: null };
  }
  return {
    state: 'signed-in',
    signedIn: true,
    account: {
      email: typeof record.email === 'string' ? record.email : null,
    },
  };
}

function randomManualCode() {
  const bytes = randomBytes(12);
  let code = '';
  for (const byte of bytes) code += MANUAL_CODE_ALPHABET[byte & 31];
  return code;
}

function displayCode(code) {
  return String(code).match(/.{1,4}/g)?.join('-') ?? String(code);
}

function normalizeManualCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function readBoundedUpstreamJson(response) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BODY_BYTES) {
    try { await response?.body?.cancel?.(); } catch {}
    throw creditsError('UPSTREAM_RESPONSE_TOO_LARGE', '인증 서버 응답이 너무 커요');
  }
  let text = '';
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let complete = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          complete = true;
          break;
        }
        total += value.byteLength;
        if (total > MAX_UPSTREAM_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          throw creditsError('UPSTREAM_RESPONSE_TOO_LARGE', '인증 서버 응답이 너무 커요');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (!complete) await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock?.();
    }
    text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
  } else if (typeof response?.text === 'function') {
    text = await response.text();
  } else if (typeof response?.json === 'function') {
    text = JSON.stringify(await response.json());
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_UPSTREAM_BODY_BYTES) {
    throw creditsError('UPSTREAM_RESPONSE_TOO_LARGE', '인증 서버 응답이 너무 커요');
  }
  try { return text.trim() ? JSON.parse(text) : {}; }
  catch { return {}; }
}

function validPkceChallenge(value) {
  const challenge = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return false;
  try {
    return Buffer.from(challenge, 'base64url').length === 32;
  } catch {
    return false;
  }
}

function validatedLoopbackUri(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw creditsError('REDIRECT_URI_INVALID', '돌아갈 Rauhwpx 주소가 올바르지 않아요');
  }
  if (url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || !url.port
    || Number(url.port) < 1
    || Number(url.port) > 65_535
    || !['/oauth/rau/callback', '/oauth/account/callback'].includes(url.pathname)
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw creditsError('REDIRECT_URI_INVALID', '돌아갈 Rauhwpx 주소가 올바르지 않아요');
  }
  return url.toString();
}

function authorizationProof(session, input, now) {
  const verifier = String(input?.codeVerifier ?? '');
  if (verifier.length < 43 || verifier.length > 128
    || !sameDigest(digest(verifier), session.codeChallenge)) {
    throw creditsError('DEVICE_PROOF_INVALID', '로그인 증명을 확인할 수 없어요');
  }
  if (session.authorizationExpiresAt < now()) {
    throw creditsError('DEVICE_PROOF_EXPIRED', '로그인 증명이 만료됐어요');
  }
  const proof = input?.proof;
  if (proof?.kind === 'loopback' && sameDigest(digest(proof.code), session.authorizationCodeDigest)) {
    return 'loopback';
  }
  if (proof?.kind === 'manual' && sameDigest(
    digest(normalizeManualCode(proof.code)),
    session.manualCodeDigest,
  )) {
    return 'manual';
  }
  throw creditsError('DEVICE_PROOF_INVALID', '로그인 증명을 확인할 수 없어요');
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
 *   reconcileOpenRouterKey?: (input: { intentId: string, name: string, createdAt: number }) => Promise<boolean>,
 *   maxLiveSessions?: number,
 *   minDeviceProtocol?: number,
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
  reconcileOpenRouterKey = null,
  inspectOpenRouterKey = null,
  deleteOpenRouterKey = null,
  maxLiveSessions = 2000,
  minDeviceProtocol = 1,
  cloudWorkerSecret = '',
  cloudProvisioner = null,
  cloudProvisionerRequired = false,
} = {}) {
  if (!origin) throw new Error('origin is required');
  if (!sessionSecret) throw new Error('sessionSecret is required');

  const redirectUri = `${origin.replace(/\/$/, '')}/callback`;
  let mutationChain = Promise.resolve();

  async function upstreamJson(url, init) {
    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      rejectDeadline(creditsError('UPSTREAM_TIMEOUT', '인증 서버 응답이 너무 느려요'));
    }, UPSTREAM_TIMEOUT_MS);
    timer.unref?.();
    try {
      const operation = (async () => {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        return { response, body: await readBoundedUpstreamJson(response) };
      })();
      return await Promise.race([operation, deadline]);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw creditsError('UPSTREAM_TIMEOUT', '인증 서버 응답이 너무 느려요');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function serializeMutation(task) {
    const running = mutationChain.then(task);
    mutationChain = running.then(() => undefined, () => undefined);
    return running;
  }

  function mutate(task) {
    if (typeof store.mutate === 'function') {
      return store.mutate((state) => task(ensureState(state)));
    }
    return serializeMutation(async () => {
      const state = ensureState(await store.load());
      const result = await task(state);
      await store.save(state);
      return result;
    });
  }

  function pruneSessions(state) {
    const cutoff = now() - SESSION_TTL_MS;
    for (const [id, session] of Object.entries(state.sessions)) {
      if (session.createdAt >= cutoff) continue;
      if (session.status === 'ready' && session.accessHash) {
        delete state.accessTokens[session.accessHash];
      }
      delete state.sessions[id];
    }
  }

  function accountSessionsIn(state) {
    state.accountSessions ??= {};
    if (typeof state.accountSessions !== 'object' || Array.isArray(state.accountSessions)) {
      throw creditsError('ACCOUNT_SESSION_UNREADABLE', '저장된 계정 세션 정보를 읽을 수 없어요');
    }
    return state.accountSessions;
  }

  function pruneAccountSessions(state) {
    const records = accountSessionsIn(state);
    for (const [tokenDigest, record] of Object.entries(records)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      if (record.status === 'pending' && record.pendingExpiresAt < now()) {
        record.status = 'revoked';
        record.revokedAt = now();
        delete record.pendingExpiresAt;
      }
      if (record.status === 'revoked'
        && Number.isFinite(record.revokedAt)
        && now() - record.revokedAt > ACCOUNT_SESSION_REVOKED_RETENTION_MS) {
        delete records[tokenDigest];
      }
    }
    return records;
  }

  function activeReplacementDigest(state, token) {
    const tokenDigest = accountTokenDigest(token, { optional: true });
    if (!tokenDigest) return null;
    const record = accountSessionsIn(state)[tokenDigest];
    return record?.status === 'active' ? tokenDigest : null;
  }

  function liveSessionCount(state) {
    let count = 0;
    for (const session of Object.values(state.sessions)) {
      if (session.status === 'pending'
        || session.status === 'authenticated'
        || session.status === 'ready') count += 1;
    }
    return count;
  }

  async function defaultAuthenticate(code) {
    const { response, body } = await upstreamJson(WORKOS_AUTHENTICATE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: workosClientId,
        client_secret: workosApiKey,
        grant_type: 'authorization_code',
        code,
      }),
    });
    const id = body?.user?.id;
    if (!response.ok || typeof id !== 'string' || !id) {
      throw creditsError('WORKOS_AUTH_FAILED', '로그인을 완료하지 못했어요');
    }
    return { id, email: loginEmail(body) };
  }

  async function defaultAuthenticateMagic(email, code) {
    const { response, body } = await upstreamJson(WORKOS_AUTHENTICATE, {
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
    const id = body?.user?.id;
    if (!response.ok || typeof id !== 'string' || !id) {
      throw creditsError('WORKOS_AUTH_FAILED', '코드를 확인하지 못했어요');
    }
    return { id, email: loginEmail(body) ?? String(email ?? '').trim() };
  }

  async function defaultSendMagic(email) {
    const { response } = await upstreamJson(WORKOS_MAGIC_AUTH, {
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
    if (!boundedUtf8(openRouterProvisioningKey, MAX_OPENROUTER_KEY_BYTES)
      || !openRouterProvisioningKey.trim()) {
      throw markOpenRouterMintNotDispatched(creditsError(
        'OPENROUTER_PROVISION_FAILED',
        '체험 키 발급 설정을 확인하지 못했어요',
      ));
    }
    const { response, body } = await upstreamJson(OPENROUTER_KEYS, {
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
    const key = body?.key ?? body?.data?.key;
    const id = body?.data?.hash ?? body?.data?.id ?? body?.id ?? null;
    if (!response.ok || typeof key !== 'string' || !key) {
      throw creditsError('OPENROUTER_PROVISION_FAILED', '체험 키를 만들지 못했어요');
    }
    return { key, id: typeof id === 'string' ? id : null };
  }

  async function defaultReconcileKey({ name }) {
    let removed = false;
    for (let page = 0; page < MAX_KEY_RECONCILE_PAGES; page += 1) {
      const offset = page * 100;
      const url = new URL(OPENROUTER_KEYS);
      url.searchParams.set('include_disabled', 'true');
      url.searchParams.set('offset', String(offset));
      const { response, body } = await upstreamJson(url, {
        headers: { Authorization: `Bearer ${openRouterProvisioningKey}` },
      });
      if (!response.ok || !Array.isArray(body?.data)) {
        throw creditsError(
          'OPENROUTER_RECONCILE_FAILED',
          '중단된 체험 키 발급을 확인하지 못했어요. 새 키를 만들지 않았습니다',
        );
      }
      for (const candidate of body.data) {
        if (candidate?.name !== name || typeof candidate?.hash !== 'string' || !candidate.hash) {
          continue;
        }
        const deletion = await upstreamJson(`${OPENROUTER_KEYS}/${encodeURIComponent(candidate.hash)}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${openRouterProvisioningKey}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        if (!deletion.response.ok && deletion.response.status !== 404) {
          throw creditsError(
            'OPENROUTER_RECONCILE_FAILED',
            '중단된 체험 키를 안전하게 정리하지 못했어요. 새 키를 만들지 않았습니다',
          );
        }
        removed = true;
      }
      if (body.data.length < 100) return removed;
    }
    throw creditsError(
      'OPENROUTER_RECONCILE_FAILED',
      '중단된 체험 키 검색 범위를 초과했어요. 새 키를 만들지 않았습니다',
    );
  }

  const resolveUser = authenticateWorkos ?? defaultAuthenticate;
  const resolveMagicUser = authenticateMagic ?? defaultAuthenticateMagic;
  const sendMagic = sendMagicAuth ?? defaultSendMagic;
  async function defaultInspectKey({ key }) {
    const { response, body } = await upstreamJson(`${OPENROUTER_API}/key`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    const limit = Number(body?.data?.limit);
    const usage = Number(body?.data?.usage);
    if (!response.ok || !Number.isFinite(limit) || !Number.isFinite(usage)) {
      throw creditsError('OPENROUTER_KEY_INSPECT_FAILED', '기존 체험 키 잔액을 확인하지 못했어요');
    }
    return { limit, usage };
  }

  async function defaultDeleteKey({ id }) {
    const { response } = await upstreamJson(`${OPENROUTER_KEYS}/${encodeURIComponent(id)}`, {
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

  const mintKey = createOpenRouterKey ?? defaultCreateKey;
  const reconcileKey = reconcileOpenRouterKey ?? defaultReconcileKey;
  const inspectKey = inspectOpenRouterKey ?? defaultInspectKey;
  const deleteKey = deleteOpenRouterKey ?? defaultDeleteKey;

  function assertFinalKeyRecordFits(state, ownerId, workosUserId, normalizedEmail, createdAt) {
    const projected = structuredClone(state);
    const maximumRecord = {
      keyCiphertext: encryptSecret(sessionSecret, 'k'.repeat(MAX_OPENROUTER_KEY_BYTES)),
      openrouterKeyId: 'i'.repeat(MAX_OPENROUTER_KEY_ID_BYTES),
      createdAt,
    };
    projected.users[ownerId] = maximumRecord;
    if (ownerId !== workosUserId) projected.users[workosUserId] = { ...maximumRecord };
    if (normalizedEmail) {
      projected.emailIndex ??= {};
      projected.emailIndex[normalizedEmail] = workosUserId;
    }
    try {
      assertStoreStateFits(projected);
    } catch (error) {
      if (error?.code !== 'RAU_CREDITS_STORE_TOO_LARGE') throw error;
      throw creditsError(
        'RAU_CREDITS_CAPACITY_EXCEEDED',
        '체험 키를 안전하게 저장할 공간이 부족해 새 키를 만들지 않았습니다',
      );
    }
  }

  /**
   * 계정당 키 하나. WorkOS 사용자 id 와 검증된 이메일을 둘 다 인덱스로 걸어,
   * 같은 메일함을 다른 인증 수단으로 들어와도 두 번째 $5 가 만들어지지 않게 한다.
   */
  async function keyForUserWithinMutation(workosUserId, email = null) {
    workosUserId = validatedWorkosUserId(workosUserId);
    const normalizedEmail = validatedAccountEmail(email);
    const state = ensureState(await store.load());
    if (typeof state.users !== 'object' || Array.isArray(state.users)
      || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) {
      throw creditsError('TRIAL_KEY_UNREADABLE', '저장된 체험 키 정보를 읽을 수 없어요');
    }
    const directUser = Object.hasOwn(state.users, workosUserId);
    const byEmail = normalizedEmail && state.emailIndex
      && typeof state.emailIndex === 'object' && !Array.isArray(state.emailIndex)
      && Object.hasOwn(state.emailIndex, normalizedEmail)
      ? state.emailIndex[normalizedEmail]
      : null;
    const existingId = directUser ? workosUserId : byEmail;
    const existing = typeof existingId === 'string' && Object.hasOwn(state.users, existingId)
      ? state.users[existingId]
      : null;
    if (byEmail && !existing) {
      throw creditsError(
        'TRIAL_KEY_UNREADABLE',
        '기존 체험 키 연결 정보가 손상됐어요. 새 키를 만들지 않았습니다',
      );
    }
    let existingKey = null;
    if (existing?.keyCiphertext) {
      try {
        existingKey = validatedMintedKey(decryptSecret(sessionSecret, existing.keyCiphertext));
      } catch {
        throw creditsError(
          'TRIAL_KEY_UNREADABLE',
          '기존 체험 키를 읽을 수 없어요. 새 키를 만들기 전에 지원팀에서 기존 키를 해지해야 합니다',
        );
      }
    }
    if (existingKey) {
      const accountId = existing.accountId ?? existingId;
      existing.accountId = accountId;
      if (existingId !== workosUserId) {
        state.users[workosUserId] = { ...state.users[existingId], accountId };
      }
      if (normalizedEmail) {
        state.emailIndex ??= {};
        state.emailIndex[normalizedEmail] = accountId;
      }
      await store.save(state);
      return { key: existingKey, accountId };
    }

    if (existing && !existing.provisioning) {
      throw creditsError(
        'TRIAL_KEY_UNREADABLE',
        '기존 체험 키 정보가 불완전해요. 새 키를 만들지 않았습니다',
      );
    }
    const ownerId = existingId == null ? workosUserId : validatedWorkosUserId(existingId);
    let intent = null;
    if (existing?.provisioning) {
      const pending = existing.provisioning;
      if (!boundedUtf8(pending.id, MAX_PROVISIONING_INTENT_ID_BYTES)
        || !/^[A-Za-z0-9_-]+$/.test(pending.id)
        || !boundedUtf8(pending.name, MAX_PROVISIONING_INTENT_NAME_BYTES)
        || !/^[A-Za-z0-9_-]+$/.test(pending.name)
        || !Number.isFinite(pending.createdAt)
        || (pending.phase !== undefined
          && pending.phase !== 'prepared'
          && pending.phase !== 'submitting')) {
        throw creditsError(
          'TRIAL_KEY_UNREADABLE',
          '중단된 체험 키 발급 정보가 손상됐어요. 새 키를 만들지 않았습니다',
        );
      }
      if (pending.phase === 'prepared') {
        // The external call always follows a durable `submitting` save, so a
        // prepared intent is proof that no request was sent yet.
        intent = pending;
      } else {
        // Missing phase is the compatibility form of an older uncertain
        // intent. OpenRouter returns plaintext only once and list results may
        // lag creation, so absence can never authorize another paid POST.
        const removed = await reconcileKey({
          intentId: pending.id,
          name: pending.name,
          createdAt: pending.createdAt,
        });
        if (removed !== true) {
          throw creditsError(
            'OPENROUTER_RECONCILE_PENDING',
            '중단된 체험 키가 아직 확인되지 않아 새 키를 만들지 않았습니다. 잠시 후 다시 시도해 주세요',
          );
        }
      }
    }

    if (!intent) {
      const intentId = randomBytes(12).toString('base64url');
      intent = {
        id: intentId,
        name: `rau-${ownerId.slice(0, 12)}-${intentId}`,
        createdAt: now(),
        phase: 'prepared',
      };
      state.users[ownerId] = { provisioning: intent };
      if (normalizedEmail) {
        state.emailIndex ??= {};
        state.emailIndex[normalizedEmail] = ownerId;
      }
      // Persist a no-side-effect state first. A crash here can safely resume
      // the same intent without querying or minting a replacement.
      await store.save(state);
    }

    const recordCreatedAt = now();
    // Prove that the largest accepted key record can be committed before the
    // paid mutation. This uses the exact serializer and cap as the file store.
    assertFinalKeyRecordFits(
      state,
      ownerId,
      workosUserId,
      normalizedEmail,
      recordCreatedAt,
    );

    intent = { ...intent, phase: 'submitting', submittedAt: now() };
    state.users[ownerId] = { provisioning: intent };
    // This phase must be durable before the paid external mutation. Any
    // crash after it is uncertain and must reconcile positively or fail.
    await store.save(state);

    let minted;
    try {
      minted = await mintKey({ name: intent.name });
    } catch (error) {
      if (!isOpenRouterMintNotDispatched(error)) throw error;
      const prepared = {
        id: intent.id,
        name: intent.name,
        createdAt: intent.createdAt,
        phase: 'prepared',
      };
      state.users[ownerId] = { provisioning: prepared };
      try {
        await store.save(state);
      } catch (rollbackError) {
        const failure = new AggregateError(
          [error, rollbackError],
          'OpenRouter mint was not dispatched, but restoring the prepared intent failed.',
          { cause: error },
        );
        failure.code = 'OPENROUTER_PROVISION_ROLLBACK_FAILED';
        throw failure;
      }
      throw error;
    }
    const mintedKey = validatedMintedKey(minted?.key);
    const mintedId = validatedMintedKeyId(minted?.id);
    const record = {
      keyCiphertext: encryptSecret(sessionSecret, mintedKey),
      openrouterKeyId: mintedId,
      credentialVersion: 2,
      accountId: ownerId,
      carriedUsageUsd: 0,
      createdAt: recordCreatedAt,
    };
    state.users[ownerId] = record;
    if (ownerId !== workosUserId) state.users[workosUserId] = { ...record };
    if (normalizedEmail) {
      state.emailIndex ??= {};
      state.emailIndex[normalizedEmail] = ownerId;
    }
    await store.save(state);
    return { key: mintedKey, accountId: ownerId };
  }

  function keyForUser(workosUserId, email = null) {
    return serializeMutation(async () => {
      const account = await keyForUserWithinMutation(workosUserId, email);
      return account.key;
    });
  }

  function isV1Session(session) {
    return Boolean(session) && (session.protocol === undefined || session.protocol === 1);
  }

  function assertV1Session(session) {
    if (!isV1Session(session)) {
      throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없거나 만료됐어요');
    }
    return session;
  }

  function assertLiveV1Session(session) {
    const current = assertV1Session(session);
    if (now() - current.createdAt > SESSION_TTL_MS) {
      throw creditsError('DEVICE_SESSION_EXPIRED', '로그인 세션이 만료됐어요');
    }
    return current;
  }

  function assertPendingV1Session(session) {
    const current = assertLiveV1Session(session);
    if (current.status !== 'pending') {
      throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없거나 만료됐어요');
    }
    return current;
  }

  async function finishDeviceLogin(deviceId, userId, email = null) {
    userId = validatedWorkosUserId(userId);
    const requestedEmail = validatedAccountEmail(email);
    const accountEmail = await mutate((state) => {
      const current = assertPendingV1Session(state.sessions[deviceId]);
      const claim = current.completionClaim;
      if (claim !== undefined && (
        !claim || typeof claim !== 'object'
        || typeof claim.workosUserId !== 'string'
        || claim.workosUserId !== userId
      )) {
        throw creditsError(
          'DEVICE_SESSION_INVALID',
          '이미 다른 계정으로 처리 중인 로그인 세션이에요',
        );
      }
      const nextEmail = claim?.email != null
        ? validatedAccountEmail(claim.email)
        : requestedEmail;
      if (claim === undefined) {
        current.completionClaim = {
          workosUserId: userId,
          email: nextEmail,
          claimedAt: now(),
        };
        // Bind the session before any paid provider mutation. The same
        // principal can resume a durable provisioning intent after failure,
        // while a different principal cannot consume the session.
      }
      return nextEmail;
    });

    const account = await keyForUserWithinMutation(userId, accountEmail);
    const accessToken = newAccessToken();
    const accessHash = accessTokenHash(accessToken);
    await mutate((state) => {
      const current = assertPendingV1Session(state.sessions[deviceId]);
      if (current.completionClaim?.workosUserId !== userId) {
        throw creditsError(
          'DEVICE_SESSION_INVALID',
          '로그인 세션의 계정 연결 정보를 확인할 수 없어요',
        );
      }
      current.status = 'ready';
      current.workosUserId = userId;
      current.email = accountEmail;
      current.apiKeyCiphertext = encryptSecret(sessionSecret, account.key);
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
      delete current.completionClaim;
    });
    return { deviceId, workosUserId: userId, email: accountEmail };
  }

  function assertLiveV2Session(session) {
    if (!session || session.protocol !== 2) {
      throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없거나 만료됐어요');
    }
    if (now() - session.createdAt > SESSION_TTL_MS) {
      throw creditsError('DEVICE_SESSION_EXPIRED', '로그인 세션이 만료됐어요');
    }
    return session;
  }

  function authenticatedV2Result(deviceId, session) {
    try {
      return {
        deviceId,
        pairingCode: session.pairingCode,
        confirmationToken: decryptSecret(sessionSecret, session.confirmationTokenCiphertext),
      };
    } catch {
      throw creditsError('DEVICE_SESSION_INVALID', '로그인 확인 정보를 읽을 수 없어요');
    }
  }

  function readyV2Result(session) {
    try {
      return {
        pairingCode: session.pairingCode,
        redirectUri: session.redirectUri,
        callbackState: session.callbackState,
        returnMode: session.returnMode,
        authorizationCode: decryptSecret(sessionSecret, session.authorizationCodeCiphertext),
        manualCode: displayCode(decryptSecret(sessionSecret, session.manualCodeCiphertext)),
        expiresAt: new Date(session.authorizationExpiresAt).toISOString(),
      };
    } catch {
      throw creditsError('DEVICE_SESSION_INVALID', '로그인 반환 정보를 읽을 수 없어요');
    }
  }

  async function markV2Authenticated(deviceId, userId, email = null, magicRetryDigest = null) {
    userId = validatedWorkosUserId(userId);
    const confirmationToken = randomBytes(24).toString('base64url');
    const accountEmail = validatedAccountEmail(email);
    return mutate((state) => {
      const session = assertLiveV2Session(state.sessions[deviceId]);
      if (session.status === 'authenticated') {
        if (session.workosUserId !== userId
          || (magicRetryDigest !== null
            && !sameDigest(session.magicRetryDigest, magicRetryDigest))) {
          throw creditsError('DEVICE_SESSION_INVALID', '이미 다른 계정으로 처리된 로그인 세션이에요');
        }
        return authenticatedV2Result(deviceId, session);
      }
      if (session.status !== 'pending') {
        throw creditsError('DEVICE_SESSION_INVALID', '이미 처리된 로그인 세션이에요');
      }
      session.status = 'authenticated';
      session.workosUserId = userId;
      session.email = accountEmail;
      session.confirmationTokenDigest = digest(confirmationToken);
      session.confirmationTokenCiphertext = encryptSecret(sessionSecret, confirmationToken);
      if (magicRetryDigest !== null) session.magicRetryDigest = magicRetryDigest;
      return { deviceId, pairingCode: session.pairingCode, confirmationToken };
    });
  }

  async function findV2SessionByOauthState(oauthState) {
    const wanted = digest(String(oauthState ?? ''));
    const state = await store.load();
    for (const [deviceId, session] of Object.entries(state.sessions)) {
      if (session?.protocol === 2
        && (session.status === 'pending' || session.status === 'authenticated')
        && sameDigest(session.oauthStateDigest, wanted)) {
        assertLiveV2Session(session);
        return { deviceId, status: session.status };
      }
    }
    throw creditsError('OAUTH_STATE_INVALID', '로그인 요청을 확인할 수 없어요');
  }

  async function oauthCallbackTarget(oauthState) {
    const rawState = String(oauthState ?? '');
    const wanted = digest(rawState);
    const state = await store.load();
    for (const [deviceId, session] of Object.entries(state.sessions)) {
      if (session?.protocol === 2
        && (session.status === 'pending' || session.status === 'authenticated')
        && sameDigest(session.oauthStateDigest, wanted)) {
        assertLiveV2Session(session);
        return { protocol: 2, deviceId, status: session.status };
      }
    }

    const v1Session = state.sessions[rawState];
    if (!isV1Session(v1Session)) {
      throw creditsError('OAUTH_STATE_INVALID', '로그인 요청을 확인할 수 없어요');
    }
    assertPendingV1Session(v1Session);
    return { protocol: 1, deviceId: rawState };
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
      const tokenDigest = accountTokenDigest(token);
      return mutate((state) => {
        const records = pruneAccountSessions(state);
        const current = records[tokenDigest];
        if (!current || current.status !== 'active') {
          throw creditsError('ACCOUNT_SESSION_UNAUTHORIZED', '계정 로그인이 필요해요');
        }
        if (deviceId) {
          if (current.cloudDeviceId && current.cloudDeviceId !== deviceId) {
            throw creditsError('CLOUD_DEVICE_MISMATCH', 'This account session is already bound to another Cloud device');
          }
          current.cloudDeviceId ??= deviceId;
        }
        return validatedWorkosUserId(current.workosUserId);
      });
    },
  });

  return {
    origin,
    redirectUri,
    sessionTtlMs: SESSION_TTL_MS,
    authorizationTtlMs: AUTHORIZATION_TTL_MS,
    minDeviceProtocol: Number(minDeviceProtocol) >= 2 ? 2 : 1,

    loginUrl(deviceId) {
      return `${origin.replace(/\/$/, '')}/login?device=${encodeURIComponent(deviceId)}`;
    },

    async authorizationUrl(deviceId, provider = 'GoogleOAuth') {
      const id = String(deviceId ?? '');
      assertPendingV1Session((await store.load()).sessions[id]);
      const chosen = WORKOS_PROVIDERS.has(provider) ? provider : 'GoogleOAuth';
      const url = new URL(WORKOS_AUTHORIZE);
      url.searchParams.set('client_id', workosClientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('provider', chosen);
      // IdP 세션이 남아 있어도 로그아웃한 사용자가 다른 계정을 고를 수 있어야 한다.
      url.searchParams.set('prompt', 'select_account');
      url.searchParams.set('state', id);
      return url.toString();
    },

    async assertPendingDevice(deviceId) {
      const id = String(deviceId ?? '');
      assertPendingV1Session((await store.load()).sessions[id]);
      return id;
    },

    async deviceLoginContext(deviceId) {
      const id = String(deviceId ?? '');
      const session = (await store.load()).sessions[id];
      if (!session || session.status !== 'pending') {
        throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없거나 만료됐어요');
      }
      if (now() - session.createdAt > SESSION_TTL_MS) {
        throw creditsError('DEVICE_SESSION_EXPIRED', '로그인 세션이 만료됐어요');
      }
      const protocol = session.protocol === 2 ? 2 : isV1Session(session) ? 1 : null;
      if (protocol === null) {
        throw creditsError('DEVICE_SESSION_INVALID', '로그인 세션이 없거나 만료됐어요');
      }
      return { id, protocol, pairingCode: protocol === 2 ? session.pairingCode : null };
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
          protocol: 1,
          status: 'pending',
          createdAt: now(),
          ...(replaceAccessHash ? { replaceAccessHash } : {}),
        };
      });
      return { id, loginUrl: this.loginUrl(id) };
    },

    async createDeviceSessionV2(input = {}) {
      if (input.codeChallengeMethod !== 'S256' || !validPkceChallenge(input.codeChallenge)) {
        throw creditsError('PKCE_CHALLENGE_INVALID', '로그인 보안 정보를 확인할 수 없어요');
      }
      const purpose = input.purpose === 'account' ? 'account' : 'provider';
      if (input.purpose !== undefined && !['account', 'provider'].includes(input.purpose)) {
        throw creditsError('DEVICE_PURPOSE_INVALID', '지원하지 않는 로그인 목적이에요');
      }
      const requestedMode = String(input.returnMode ?? 'hybrid');
      if (!['hybrid', 'loopback', 'manual'].includes(requestedMode)) {
        throw creditsError('RETURN_MODE_INVALID', '지원하지 않는 로그인 반환 방식이에요');
      }
      const loopbackUri = validatedLoopbackUri(input.redirectUri);
      if (requestedMode === 'loopback' && !loopbackUri) {
        throw creditsError('REDIRECT_URI_INVALID', 'loopback 로그인에는 돌아갈 주소가 필요해요');
      }
      const callbackState = loopbackUri ? String(input.callbackState ?? '') : null;
      if (loopbackUri && !/^[A-Za-z0-9_-]{32,128}$/.test(callbackState)) {
        throw creditsError('CALLBACK_STATE_INVALID', '돌아갈 Rauhwpx 상태값이 올바르지 않아요');
      }
      const id = randomBytes(24).toString('base64url');
      const pairingRaw = randomManualCode().slice(0, 6);
      const pairingCode = `${pairingRaw.slice(0, 3)}-${pairingRaw.slice(3)}`;
      const returnMode = loopbackUri ? requestedMode : 'manual';
      await mutate((state) => {
        pruneSessions(state);
        pruneAccountSessions(state);
        if (liveSessionCount(state) >= maxLiveSessions) {
          throw creditsError('RATE_LIMITED', '로그인 요청이 너무 많아요. 잠시 후 다시 시도해 주세요');
        }
        state.sessions[id] = {
          protocol: 2,
          purpose,
          status: 'pending',
          createdAt: now(),
          codeChallenge: String(input.codeChallenge),
          returnMode,
          redirectUri: loopbackUri,
          callbackState,
          pairingCode,
          clientVersion: String(input.clientVersion ?? '').slice(0, 64),
          ...(purpose === 'account'
            ? { replaceAccountTokenDigest: activeReplacementDigest(state, input.replaceAccountToken) }
            : {}),
        };
      });
      return {
        id,
        loginUrl: this.loginUrl(id),
        pairingCode,
        expiresAt: new Date(now() + SESSION_TTL_MS).toISOString(),
      };
    },

    async authorizationUrlV2(deviceId, provider = 'GoogleOAuth') {
      const chosen = WORKOS_PROVIDERS.has(provider) ? provider : 'GoogleOAuth';
      const oauthState = randomBytes(24).toString('base64url');
      await mutate((state) => {
        const session = assertLiveV2Session(state.sessions[String(deviceId ?? '')]);
        if (session.status !== 'pending') {
          throw creditsError('DEVICE_SESSION_INVALID', '이미 처리된 로그인 세션이에요');
        }
        session.oauthStateDigest = digest(oauthState);
      });
      const url = new URL(WORKOS_AUTHORIZE);
      url.searchParams.set('client_id', workosClientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('provider', chosen);
      url.searchParams.set('prompt', 'select_account');
      url.searchParams.set('state', oauthState);
      return url.toString();
    },

    async completeLoginV2(code, oauthState) {
      const target = await findV2SessionByOauthState(oauthState);
      if (target.status === 'authenticated') {
        const session = assertLiveV2Session((await store.load()).sessions[target.deviceId]);
        return authenticatedV2Result(target.deviceId, session);
      }
      const user = await resolveUser(String(code ?? ''));
      return markV2Authenticated(target.deviceId, user.id, user.email ?? null);
    },

    async completeMagicLoginV2(deviceId, email, code) {
      const id = String(deviceId ?? '');
      const snapshot = assertLiveV2Session((await store.load()).sessions[id]);
      const submitted = String(email ?? '').trim();
      const submittedCode = String(code ?? '').trim();
      const retryDigest = digest(`${submitted.toLowerCase()}\0${submittedCode}`);
      if (snapshot.status === 'authenticated') {
        if (!sameDigest(snapshot.magicRetryDigest, retryDigest)) {
          throw creditsError('DEVICE_SESSION_INVALID', '이미 처리된 로그인 세션이에요');
        }
        return authenticatedV2Result(id, snapshot);
      }
      if (snapshot.status !== 'pending') {
        throw creditsError('DEVICE_SESSION_INVALID', '이미 처리된 로그인 세션이에요');
      }
      const user = await resolveMagicUser(submitted, submittedCode);
      return markV2Authenticated(id, user.id, user.email ?? submitted, retryDigest);
    },

    async confirmDeviceSessionV2(deviceId, confirmationToken) {
      const id = String(deviceId ?? '');
      const snapshot = assertLiveV2Session((await store.load()).sessions[id]);
      const confirmationDigest = digest(confirmationToken);
      if (snapshot.status === 'ready'
        && sameDigest(confirmationDigest, snapshot.confirmationTokenDigest)) {
        if (snapshot.authorizationExpiresAt < now()) {
          throw creditsError('CONFIRMATION_INVALID', '로그인 확인 요청이 만료됐거나 올바르지 않아요');
        }
        return readyV2Result(snapshot);
      }
      if (snapshot.status !== 'authenticated'
        || !sameDigest(confirmationDigest, snapshot.confirmationTokenDigest)) {
        throw creditsError('CONFIRMATION_INVALID', '로그인 확인 요청이 만료됐거나 올바르지 않아요');
      }
      const apiKey = snapshot.purpose === 'account'
        ? null
        : await keyForUser(snapshot.workosUserId, snapshot.email);
      const authorizationCode = randomBytes(32).toString('base64url');
      const manualCode = randomManualCode();
      const authorizationExpiresAt = now() + AUTHORIZATION_TTL_MS;
      return mutate((state) => {
        const session = assertLiveV2Session(state.sessions[id]);
        if (session.status === 'ready'
          && sameDigest(confirmationDigest, session.confirmationTokenDigest)) {
          if (session.authorizationExpiresAt < now()) {
            throw creditsError('CONFIRMATION_INVALID', '로그인 확인 요청이 만료됐거나 올바르지 않아요');
          }
          return readyV2Result(session);
        }
        if (session.status !== 'authenticated'
          || !sameDigest(confirmationDigest, session.confirmationTokenDigest)) {
          throw creditsError('CONFIRMATION_INVALID', '로그인 확인 요청이 만료됐거나 올바르지 않아요');
        }
        session.status = 'ready';
        if (session.purpose !== 'account') {
          session.apiKeyCiphertext = encryptSecret(sessionSecret, apiKey);
        }
        session.authorizationCodeDigest = digest(authorizationCode);
        session.manualCodeDigest = digest(manualCode);
        session.authorizationCodeCiphertext = encryptSecret(sessionSecret, authorizationCode);
        session.manualCodeCiphertext = encryptSecret(sessionSecret, manualCode);
        session.authorizationExpiresAt = authorizationExpiresAt;
        session.manualAttempts = 0;
        delete session.confirmationTokenCiphertext;
        delete session.oauthStateDigest;
        delete session.magicRetryDigest;
        return readyV2Result(session);
      });
    },

    async redeemDeviceSessionV2(deviceId, input = {}) {
      const result = await mutate((state) => {
        const session = assertLiveV2Session(state.sessions[String(deviceId ?? '')]);
        if (session.status === 'redeemed') return { status: 'redeemed' };
        if (session.purpose === 'account' && session.status === 'transferred') {
          return { status: 'redeemed' };
        }
        if (session.status !== 'ready') return { status: session.status };
        if (session.manualAttempts >= MAX_MANUAL_ATTEMPTS) {
          throw creditsError('DEVICE_PROOF_LOCKED', '반환 코드를 너무 많이 틀렸어요. 로그인을 다시 시작해 주세요');
        }
        try {
          authorizationProof(session, input, now);
        } catch (error) {
          if (input?.proof?.kind === 'manual' && error?.code === 'DEVICE_PROOF_INVALID') {
            session.manualAttempts += 1;
            if (session.manualAttempts >= MAX_MANUAL_ATTEMPTS) {
              return {
                proofError: {
                  code: 'DEVICE_PROOF_LOCKED',
                  message: '반환 코드를 너무 많이 틀렸어요. 로그인을 다시 시작해 주세요',
                },
              };
            }
          }
          return { proofError: { code: error.code, message: error.message } };
        }
        if (session.purpose === 'account') {
          const records = pruneAccountSessions(state);
          let accountToken;
          let tokenDigest;
          do {
            accountToken = `${ACCOUNT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
            tokenDigest = accountTokenDigest(accountToken);
          } while (Object.hasOwn(records, tokenDigest));
          records[tokenDigest] = {
            status: 'pending',
            workosUserId: session.workosUserId,
            email: session.email ?? null,
            createdAt: now(),
            pendingExpiresAt: now() + ACCOUNT_SESSION_PENDING_TTL_MS,
            replaces: session.replaceAccountTokenDigest ?? null,
          };
          try {
            assertStoreStateFits(state);
          } catch (error) {
            if (error?.code !== 'RAU_CREDITS_STORE_TOO_LARGE') throw error;
            throw creditsError(
              'RAU_CREDITS_CAPACITY_EXCEEDED',
              '계정 세션을 안전하게 저장할 공간이 부족해요',
            );
          }
          session.status = 'transferred';
          session.issuedAccountDigest = tokenDigest;
          return {
            status: 'ready',
            accountToken,
            account: { email: session.email ?? null },
          };
        }
        let apiKey;
        try {
          apiKey = decryptSecret(sessionSecret, session.apiKeyCiphertext);
        } catch {
          throw creditsError('TRIAL_KEY_UNREADABLE', '체험 키를 읽을 수 없어요');
        }
        return {
          status: 'ready',
          apiKey,
          ...(session.email ? { email: session.email } : {}),
        };
      });
      if (result?.proofError) {
        throw creditsError(result.proofError.code, result.proofError.message);
      }
      return result;
    },

    async acknowledgeDeviceSessionV2(deviceId, input = {}) {
      return mutate((state) => {
        const session = assertLiveV2Session(state.sessions[String(deviceId ?? '')]);
        if (session.status === 'redeemed') return { status: 'redeemed' };
        const expectedStatus = session.purpose === 'account' ? 'transferred' : 'ready';
        if (session.status !== expectedStatus) {
          throw creditsError('DEVICE_SESSION_INVALID', '완료되지 않은 로그인 세션이에요');
        }
        authorizationProof(session, input, now);
        session.status = 'redeemed';
        session.redeemedAt = now();
        delete session.apiKeyCiphertext;
        delete session.confirmationTokenDigest;
        delete session.confirmationTokenCiphertext;
        delete session.authorizationCodeDigest;
        delete session.authorizationCodeCiphertext;
        delete session.manualCodeDigest;
        delete session.manualCodeCiphertext;
        delete session.issuedAccountDigest;
        delete session.replaceAccountTokenDigest;
        return { status: 'redeemed' };
      });
    },

    async cancelDeviceSessionV2(deviceId, codeVerifier) {
      return mutate((state) => {
        const session = assertLiveV2Session(state.sessions[String(deviceId ?? '')]);
        const verifier = String(codeVerifier ?? '');
        if (verifier.length < 43 || verifier.length > 128
          || !sameDigest(digest(verifier), session.codeChallenge)) {
          throw creditsError('DEVICE_PROOF_INVALID', '로그인 증명을 확인할 수 없어요');
        }
        if (session.status === 'cancelled' || session.status === 'redeemed') {
          return { status: session.status };
        }
        if (session.purpose === 'account' && typeof session.issuedAccountDigest === 'string') {
          const record = accountSessionsIn(state)[session.issuedAccountDigest];
          if (record?.status === 'pending') {
            record.status = 'revoked';
            record.revokedAt = now();
            delete record.pendingExpiresAt;
          }
        }
        session.status = 'cancelled';
        session.cancelledAt = now();
        delete session.confirmationTokenDigest;
        delete session.confirmationTokenCiphertext;
        delete session.authorizationCodeDigest;
        delete session.authorizationCodeCiphertext;
        delete session.manualCodeDigest;
        delete session.manualCodeCiphertext;
        delete session.issuedAccountDigest;
        delete session.replaceAccountTokenDigest;
        return { status: 'cancelled' };
      });
    },

    async readAccountSession(token) {
      const tokenDigest = accountTokenDigest(token);
      return mutate((state) => {
        const records = pruneAccountSessions(state);
        return accountSnapshot(records[tokenDigest]);
      });
    },

    async commitAccountSession(token) {
      const tokenDigest = accountTokenDigest(token);
      return mutate((state) => {
        const records = pruneAccountSessions(state);
        const record = records[tokenDigest];
        if (!record || record.status === 'revoked') {
          throw creditsError('ACCOUNT_SESSION_INVALID', '계정 세션을 확인할 수 없어요');
        }
        if (record.status === 'pending') {
          record.status = 'active';
          record.activatedAt = now();
          delete record.pendingExpiresAt;
          const previous = typeof record.replaces === 'string'
            ? records[record.replaces]
            : null;
          if (previous && previous.status !== 'revoked') {
            previous.status = 'revoked';
            previous.revokedAt = now();
            previous.replacedBy = tokenDigest;
          }
        }
        return accountSnapshot(record);
      });
    },

    async revokeAccountSession(token) {
      const tokenDigest = accountTokenDigest(token);
      return mutate((state) => {
        const records = pruneAccountSessions(state);
        const record = records[tokenDigest];
        if (record && record.status !== 'revoked') {
          record.status = 'revoked';
          record.revokedAt = now();
          delete record.pendingExpiresAt;
        }
        return { state: 'signed-out', signedIn: false, account: null };
      });
    },

    async authorizeAccountSession(token) {
      const tokenDigest = accountTokenDigest(token);
      const records = accountSessionsIn(await store.load());
      const record = records[tokenDigest];
      if (!record || record.status !== 'active') {
        throw creditsError('ACCOUNT_SESSION_UNAUTHORIZED', '계정 로그인이 필요해요');
      }
      return {
        subject: validatedWorkosUserId(record.workosUserId),
        email: validatedAccountEmail(record.email),
      };
    },

    async sendMagicCode(email) {
      let trimmed;
      try { trimmed = validatedAccountEmail(email); } catch {}
      if (!trimmed) {
        throw creditsError('MAGIC_EMAIL_INVALID', '이메일 주소를 확인해 주세요');
      }
      await sendMagic(trimmed);
      return trimmed;
    },

    async completeLogin(code, state) {
      const deviceId = String(state ?? '');
      assertPendingV1Session((await store.load()).sessions[deviceId]);
      const user = await resolveUser(String(code ?? ''));
      return finishDeviceLogin(deviceId, user.id, user.email ?? null);
    },

    async completeMagicLogin(deviceId, email, code) {
      const id = String(deviceId ?? '');
      assertPendingV1Session((await store.load()).sessions[id]);
      const submitted = String(email ?? '').trim();
      const user = await resolveMagicUser(submitted, String(code ?? '').trim());
      return finishDeviceLogin(id, user.id, user.email ?? submitted);
    },

    async completeOAuthLogin(code, state) {
      const target = await oauthCallbackTarget(state);
      if (target.protocol === 2 && target.status === 'authenticated') {
        const session = assertLiveV2Session((await store.load()).sessions[target.deviceId]);
        return { protocol: 2, ...authenticatedV2Result(target.deviceId, session) };
      }
      const user = await resolveUser(String(code ?? ''));
      if (target.protocol === 2) {
        const completed = await markV2Authenticated(
          target.deviceId,
          user.id,
          user.email ?? null,
        );
        return { protocol: 2, ...completed };
      }
      const completed = await finishDeviceLogin(target.deviceId, user.id, user.email ?? null);
      return { protocol: 1, ...completed };
    },

    async redeemDeviceSession(id) {
      const session = assertV1Session((await store.load()).sessions[id]);
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
        const session = assertLiveV1Session(state.sessions[id]);
        if (session.status === 'redeemed') return { status: 'redeemed' };
        if (session.status !== 'ready') {
          throw creditsError('DEVICE_SESSION_INVALID', '완료되지 않은 로그인 세션이에요');
        }
        session.status = 'redeemed';
        session.redeemedAt = now();
        delete session.apiKey;
        delete session.apiKeyCiphertext;
        delete session.accessToken;
        delete session.accessTokenCiphertext;
        return { status: 'redeemed' };
      });
    },

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

async function readJson(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw creditsError('BODY_TOO_LARGE', '요청 본문이 너무 커요');
    }
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw creditsError('JSON_INVALID', '요청 본문을 읽을 수 없어요');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw creditsError('JSON_INVALID', '요청 본문을 읽을 수 없어요');
  }
  return parsed;
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

function requestBearerToken(req, { optional = false } = {}) {
  const authorization = req.headers.authorization;
  if (authorization === undefined && optional) return null;
  if (typeof authorization !== 'string'
    || !boundedUtf8(authorization, MAX_ACCOUNT_TOKEN_BYTES + 16)
    || !authorization.startsWith('Bearer ')) {
    throw creditsError('ACCOUNT_SESSION_INVALID', '계정 세션을 확인할 수 없어요');
  }
  return authorization.slice('Bearer '.length);
}

function decodeRequestPathSegment(req, encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    // Keep the connection reusable after rejecting a malformed POST target.
    // The limiter must run before this decoder at every call site.
    req.resume?.();
    throw creditsError('REQUEST_TARGET_INVALID', '요청 주소가 올바르지 않아요');
  }
}

function htmlErrorStatus(error) {
  if (error?.code === 'ACCOUNT_SESSION_UNAUTHORIZED') return 401;
  if (error?.code === 'ACCOUNT_SESSION_INVALID') return 401;
  if (error?.code === 'DEVICE_SESSION_INVALID' || error?.code === 'DEVICE_SESSION_EXPIRED') return 400;
  if (error?.code === 'RAU_ACCESS_INVALID' || error?.code === 'CLOUD_WORKER_UNAUTHORIZED') return 401;
  if (error?.code === 'RAU_PROXY_FORBIDDEN' || error?.code === 'RAU_MODEL_FORBIDDEN'
    || error?.code === 'CLOUD_DEVICE_MISMATCH') return 403;
  if (error?.code === 'CLOUD_RUN_NOT_FOUND') return 404;
  if (error?.code === 'RATE_LIMITED' || error?.code === 'DEVICE_PROOF_LOCKED'
    || error?.code === 'CLOUD_QUOTA_EXHAUSTED'
    || error?.code === 'CLOUD_COLD_START_RATE_LIMITED'
    || error?.code === 'CLOUD_TIMEZONE_CHANGE_RATE_LIMITED') return 429;
  if (error?.code === 'BODY_TOO_LARGE') return 413;
  if (error?.code === 'UNIQUE_INSTALLS_CAPACITY_EXCEEDED') return 503;
  if (error?.code === 'ERR_INVALID_URL' || error?.code === 'REQUEST_TARGET_INVALID') return 400;
  if (error?.code === 'TRIAL_KEY_UNREADABLE') return 409;
  if (error?.code === 'CLOUD_UNAVAILABLE' || error?.code === 'CLOUD_PROVISION_FAILED') return 503;
  if (error?.code?.startsWith?.('CLOUD_OWNED_')
    || error?.code === 'CLOUD_RUN_ALREADY_ACTIVE'
    || error?.code === 'CLOUD_TEARDOWN_PENDING'
    || error?.code === 'CLOUD_TAKEOVER_NOT_READY'
    || error?.code === 'CLOUD_RUN_STATE_INVALID') return 409;
  if (error?.code?.startsWith?.('CLOUD_')) return 400;
  if (error?.code?.endsWith('_INVALID') || error?.code === 'DEVICE_PROOF_EXPIRED') return 400;
  return 500;
}

function responseSecurityHeaders(isHtml) {
  const common = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  if (!isHtml) return common;
  return {
    ...common,
    'Content-Security-Policy': "default-src 'none'; img-src 'self' http://127.0.0.1:*; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
  };
}

export function creditsRequestListener(service, {
  uniqueInstalls = createUniqueInstallsService({
    store: createMemoryStore(emptyUniqueInstallsState()),
  }),
} = {}) {
  const limiter = createRateLimiter();
  const MINUTE = 60 * 1000;
  const TEN_MINUTES = 10 * MINUTE;
  return async (req, res) => {
    let url = null;
    const ip = clientIp(req);
    const send = (status, body, headers = {}) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      const isHtml = typeof body === 'string';
      res.writeHead(status, {
        'Content-Type': isHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        ...responseSecurityHeaders(isHtml),
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
      const host = req.headers.host;
      if (typeof host === 'string' && host) {
        // Validate the untrusted Host only for request hygiene; routing always
        // uses a fixed loopback base so Host can never control URL parsing.
        new URL(`http://${host}`);
      }
      const requestTarget = typeof req.url === 'string' ? req.url : '/';
      if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) {
        throw creditsError('REQUEST_TARGET_INVALID', '요청 주소가 올바르지 않아요');
      }
      url = new URL(requestTarget, 'http://127.0.0.1');
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
      if (req.method === 'GET' && url.pathname === '/unique-installs') {
        if (!limiter.check(`unique-install-page:${ip}`, 120, MINUTE)) {
          throttled();
          return;
        }
        const summary = await uniqueInstalls.summary();
        send(200, renderUniqueInstallsPage(summary));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/unique-installs') {
        if (!limiter.check(`unique-install-read:${ip}`, 120, MINUTE)) {
          send(429, { error: 'RATE_LIMITED', message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        send(200, await uniqueInstalls.summary(), {
          'Access-Control-Allow-Origin': '*',
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/unique-installs') {
        if (!limiter.check(`unique-install-write:${ip}`, 30, TEN_MINUTES)) {
          req.resume?.();
          send(429, { error: 'RATE_LIMITED', message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        send(200, await uniqueInstalls.record(await readJson(req)));
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
      if (url.pathname === '/v2/account-session') {
        if (!limiter.check(`account:${ip}`, 60, MINUTE)) {
          req.resume?.();
          send(429, { error: 'RATE_LIMITED', message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        const token = requestBearerToken(req);
        if (req.method === 'GET') {
          send(200, await service.readAccountSession(token));
          return;
        }
        if (req.method === 'POST') {
          req.resume?.();
          send(200, await service.commitAccountSession(token));
          return;
        }
        if (req.method === 'DELETE') {
          req.resume?.();
          send(200, await service.revokeAccountSession(token));
          return;
        }
      }
      if (url.pathname.startsWith('/v1/device-sessions') && service.minDeviceProtocol >= 2) {
        send(426, {
          error: 'RAU_CLIENT_UPDATE_REQUIRED',
          message: 'Rau 로그인을 계속하려면 Rauhwpx를 업데이트해 주세요',
        });
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
        send(200, await service.redeemDeviceSession(decodeRequestPathSegment(req, redeem[1])));
        return;
      }
      const acknowledge = url.pathname.match(/^\/v1\/device-sessions\/([^/]+)\/acknowledge$/);
      if (req.method === 'POST' && acknowledge) {
        if (!limiter.check(`ack:${ip}`, 30, MINUTE)) {
          req.resume?.();
          send(429, { error: 'RATE_LIMITED', message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        send(200, await service.acknowledgeDeviceSession(
          decodeRequestPathSegment(req, acknowledge[1]),
        ));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v2/device-sessions') {
        if (!limiter.check(`create-v2:${ip}`, 10, TEN_MINUTES)) {
          send(429, { error: 'RATE_LIMITED', message: '로그인 요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        const input = await readJson(req);
        send(201, await service.createDeviceSessionV2({
          ...input,
          ...(input.purpose === 'account'
            ? { replaceAccountToken: requestBearerToken(req, { optional: true }) }
            : {}),
        }));
        return;
      }
      const redeemV2 = url.pathname.match(/^\/v2\/device-sessions\/([^/]+)\/redeem$/);
      if (req.method === 'POST' && redeemV2) {
        if (!limiter.check(`redeem-v2:${ip}`, 30, MINUTE)) {
          req.resume?.();
          send(429, { error: 'RATE_LIMITED', message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        send(200, await service.redeemDeviceSessionV2(
          decodeRequestPathSegment(req, redeemV2[1]),
          await readJson(req),
        ));
        return;
      }
      const acknowledgeV2 = url.pathname.match(/^\/v2\/device-sessions\/([^/]+)\/acknowledge$/);
      if (req.method === 'POST' && acknowledgeV2) {
        if (!limiter.check(`ack-v2:${ip}`, 30, MINUTE)) {
          req.resume?.();
          send(429, { error: 'RATE_LIMITED', message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        send(200, await service.acknowledgeDeviceSessionV2(
          decodeRequestPathSegment(req, acknowledgeV2[1]),
          await readJson(req),
        ));
        return;
      }
      const cancelV2 = url.pathname.match(/^\/v2\/device-sessions\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelV2) {
        if (!limiter.check(`cancel-v2:${ip}`, 30, MINUTE)) {
          req.resume?.();
          send(429, { error: 'RATE_LIMITED', message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요' });
          return;
        }
        const input = await readJson(req);
        send(200, await service.cancelDeviceSessionV2(
          decodeRequestPathSegment(req, cancelV2[1]),
          input.codeVerifier,
        ));
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
        const context = await service.deviceLoginContext(device);
        send(200, renderLoginPage({
          device,
          pairingCode: context.pairingCode,
          notice: url.searchParams.get('notice') ?? '',
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/continue') {
        const device = url.searchParams.get('device');
        const provider = url.searchParams.get('provider') ?? 'GoogleOAuth';
        if (!limiter.check(`page:${ip}`, 60, MINUTE)) {
          throttled(device);
          return;
        }
        const context = await service.deviceLoginContext(device);
        const location = context.protocol === 2
          ? await service.authorizationUrlV2(device, provider)
          : await service.authorizationUrl(device, provider);
        send(302, '', { Location: location });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login/magic') {
        const form = await readForm(req);
        const device = form.get('device') ?? '';
        if (!limiter.check(`magic:${ip}`, 5, TEN_MINUTES)) {
          throttled(device);
          return;
        }
        const context = await service.deviceLoginContext(device);
        const email = String(form.get('email') ?? '').trim();
        if (!limiter.check(`magic-email:${email.toLowerCase()}`, 3, TEN_MINUTES)) {
          throttled(device);
          return;
        }
        try {
          const sent = await service.sendMagicCode(email);
          send(200, renderCodePage({
            device,
            email: sent,
            pairingCode: context.pairingCode,
          }));
        } catch (error) {
          send(400, renderLoginPage({
            device,
            email: form.get('email') ?? '',
            pairingCode: context.pairingCode,
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
          const context = await service.deviceLoginContext(device);
          if (context.protocol === 2) {
            const completed = await service.completeMagicLoginV2(device, email, form.get('code'));
            send(200, renderConfirmPage(completed));
          } else {
            await service.completeMagicLogin(device, email, form.get('code'));
            send(200, renderDonePage());
          }
        } catch (error) {
          if (error?.code === 'DEVICE_SESSION_INVALID' || error?.code === 'DEVICE_SESSION_EXPIRED') {
            fail(error, device);
            return;
          }
          send(400, renderCodePage({
            device,
            email,
            pairingCode: null,
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
          if (typeof service.completeOAuthLogin === 'function') {
            const completed = await service.completeOAuthLogin(
              url.searchParams.get('code'),
              url.searchParams.get('state'),
            );
            send(200, completed.protocol === 2
              ? renderConfirmPage(completed)
              : renderDonePage());
          } else if (typeof service.completeLoginV2 === 'function') {
            throw creditsError('OAUTH_STATE_INVALID', '로그인 요청을 확인할 수 없어요');
          } else {
            await service.completeLogin(url.searchParams.get('code'), url.searchParams.get('state'));
            send(200, renderDonePage());
          }
        } catch (error) {
          fail(error, url.searchParams.get('state') ?? '');
        }
        return;
      }
      const confirmV2 = url.pathname.match(/^\/v2\/device-sessions\/([^/]+)\/confirm$/);
      if (req.method === 'POST' && confirmV2) {
        // Charge the IP budget before decoding the attacker-controlled path.
        // Malformed percent escapes must not bypass the limiter by throwing.
        if (!limiter.check(`confirm-v2:${ip}`, 10, TEN_MINUTES)) {
          req.resume?.();
          throttled();
          return;
        }
        let deviceId = '';
        try {
          deviceId = decodeRequestPathSegment(req, confirmV2[1]);
        } catch (error) {
          fail(error);
          return;
        }
        try {
          const form = await readForm(req);
          const ready = await service.confirmDeviceSessionV2(
            deviceId,
            form.get('confirmationToken'),
          );
          send(200, renderReadyPage(ready));
        } catch (error) {
          fail(error, deviceId);
        }
        return;
      }
      send(404, { error: 'not found' });
    } catch (error) {
      const pathname = url?.pathname ?? '';
      if (pathname.startsWith('/v1') || pathname.startsWith('/v2') || pathname === '/healthz'
        || error?.code === 'REQUEST_TARGET_INVALID' || error instanceof TypeError) {
        send(htmlErrorStatus(error), {
          error: error?.code ?? 'RAU_CREDITS_FAILED',
          message: error?.message ?? String(error),
          ...(error?.details === undefined ? {} : { details: error.details }),
        });
        return;
      }
      fail(error, url?.searchParams.get('device') ?? url?.searchParams.get('state') ?? '');
    }
  };
}

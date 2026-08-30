import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CLOUD_SERVER_MODES, normalizeCloudEndpoint, normalizeCloudProfile } from './cloud-profile.mjs';

const PROFILE_SECRET = 'cloud.profile';
const REFRESH_SECRET = 'cloud.refresh';
const DEVICE_SECRET = 'cloud.device';
const SERVER_MODE_SECRET = 'cloud.server-mode';
const PENDING_APP_SANDBOX_SECRET = 'cloud.pending-app-sandbox';
const PAIRING_CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const SERVER_KEY_RE = /^ed25519:[A-Za-z0-9_-]{59}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_TIMELINE_BYTES = 100 * 1024 * 1024;
const RESPONSE_PROOF_VERSION = 'RAUHWpx-response-v1';
const SSE_PROOF_VERSION = 'RAUHWpx-sse-event-v1';
const SSE_STREAM_PROTOCOL = 'rauhwpx-sse-v1';
const SSE_STREAM_DIGEST = digest(Buffer.from(SSE_STREAM_PROTOCOL));
const RESPONSE_PROOF_CONTEXT = Symbol('rauhwpx-response-proof-context');
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 200;
const SAFE_REQUEST_ATTEMPTS = 4;
const TRANSFER_READINESS_ATTEMPTS = 5;
const UPLOAD_REQUEST_ATTEMPTS = 5;
const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const TRANSIENT_TRANSPORT_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export class CloudHttpError extends Error {
  constructor(message, { status = 0, code = '', details = null, retryable = null } = {}) {
    super(message);
    this.name = 'CloudHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = typeof retryable === 'boolean' ? retryable : null;
  }
}

function retryableHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function boundedAttempts(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : fallback;
}

function normalizePendingAppSandbox(raw) {
  const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const providerId = String(record?.providerId ?? '');
  const sandbox = record?.sandbox;
  if (record?.version !== 1
    || !/^[a-z][a-z0-9-]{1,31}$/.test(providerId)
    || !sandbox || typeof sandbox !== 'object'
    || sandbox.providerId !== providerId
    || typeof sandbox.sandboxId !== 'string' || !sandbox.sandboxId.trim()) {
    throw new CloudHttpError('Pending app sandbox journal is invalid', {
      code: 'SANDBOX_JOURNAL_INVALID',
      retryable: false,
    });
  }
  return {
    version: 1,
    providerId,
    sandbox: { ...sandbox },
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
  };
}

function directHttpsTarget(endpoint, serverPublicKey = '') {
  return Object.freeze({
    kind: 'direct-https',
    endpoint: normalizeCloudEndpoint(endpoint),
    serverPublicKey,
  });
}

function transportErrorCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const code = String(current.code ?? '').toUpperCase();
    if (code) return code;
    current = current.cause;
  }
  return '';
}

function normalizeTransportError(error) {
  if (error instanceof CloudHttpError) return error;
  const code = transportErrorCode(error);
  const message = String(error?.message ?? error ?? '').trim();
  const typeErrorTransportMessage = error?.name === 'TypeError'
    && /^(?:fetch failed|failed to fetch|networkerror|terminated)$/i.test(message);
  if (!TRANSIENT_TRANSPORT_CODES.has(code) && !typeErrorTransportMessage) return error;
  const normalized = new CloudHttpError(message || 'Cloud transport failed', {
    code: code || 'CLOUD_TRANSPORT_ERROR',
    retryable: true,
    details: code ? { causeCode: code } : null,
  });
  normalized.cause = error;
  return normalized;
}

function abortReason(signal, fallback) {
  return signal?.reason ?? fallback ?? new DOMException('The operation was aborted', 'AbortError');
}

async function retryDelay(attempt, { baseMs = DEFAULT_RETRY_BASE_MS, signal } = {}) {
  if (signal?.aborted) throw abortReason(signal);
  const normalizedBase = Math.max(0, Math.min(Number(baseMs) || 0, 10_000));
  const waitMs = Math.min(5_000, normalizedBase * (2 ** Math.max(0, attempt - 1)));
  if (waitMs === 0) {
    await Promise.resolve();
    if (signal?.aborted) throw abortReason(signal);
    return;
  }
  try {
    await delay(waitMs, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal, error);
    throw error;
  }
}

async function boundedResponseBytes(response, maximum = Infinity, { timeoutMs = 0 } = {}) {
  const limit = Number.isFinite(maximum) && maximum >= 0 ? maximum : Infinity;
  const declaredHeader = response.headers.get('content-length');
  const declared = declaredHeader === null ? NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && declared > limit) {
    throw new CloudHttpError('Cloud response is too large', {
      status: response.status,
      code: 'CLOUD_RESPONSE_TOO_LARGE',
      retryable: false,
    });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let timedOut = false;
  const timeoutError = new CloudHttpError('Cloud response body timed out', {
    code: 'ETIMEDOUT',
    retryable: true,
  });
  const timeout = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    void reader.cancel(timeoutError).catch(() => {});
  }, timeoutMs) : null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) throw timeoutError;
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new CloudHttpError('Cloud response is too large', {
          status: response.status,
          code: 'CLOUD_RESPONSE_TOO_LARGE',
          retryable: false,
        });
      }
      chunks.push(chunk);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validTokenBundle(value) {
  return value
    && typeof value.accessToken === 'string'
    && value.accessToken
    && typeof value.refreshToken === 'string'
    && value.refreshToken;
}

function validPortableTimeline(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schema !== 'rauhwpx.cloud.timeline' || value.version !== 1) return false;
  if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) return false;
  const thread = value.thread;
  return Boolean(
    thread
    && typeof thread === 'object'
    && !Array.isArray(thread)
    && typeof thread.id === 'string'
    && thread.id
    && typeof thread.title === 'string'
    && typeof thread.createdAt === 'number'
    && Number.isFinite(thread.createdAt)
    && typeof thread.updatedAt === 'number'
    && Number.isFinite(thread.updatedAt)
    && ['claude', 'codex', 'pi', 'grok', 'cursor'].includes(thread.agent)
    && typeof thread.model === 'string'
    && typeof thread.effort === 'string'
    && Array.isArray(thread.messages)
    && thread.messages.every((message) => (
      message
      && typeof message === 'object'
      && !Array.isArray(message)
      && ['user', 'assistant', 'system'].includes(message.role)
      && typeof message.text === 'string'
    )),
  );
}

function joinEndpoint(endpoint, pathname) {
  const base = `${endpoint.replace(/\/+$/, '')}/`;
  return new URL(String(pathname).replace(/^\/+/, ''), base).toString();
}

async function responseJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new CloudHttpError('Cloud response is too large', {
      status: response.status,
      code: 'CLOUD_RESPONSE_TOO_LARGE',
      retryable: false,
    });
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) {
    throw new CloudHttpError('Cloud response is too large', {
      status: response.status,
      code: 'CLOUD_RESPONSE_TOO_LARGE',
      retryable: false,
    });
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    throw new CloudHttpError('Cloud returned invalid JSON', {
      status: response.status,
      code: 'CLOUD_RESPONSE_INVALID',
      retryable: false,
    });
  }
}

function verifyServerPin(profile, response, body = null) {
  if (!profile.serverPublicKey) return;
  const received = response.headers.get('x-rauhwpx-server-key') || body?.serverPublicKey || '';
  if (received !== profile.serverPublicKey) {
    throw new CloudHttpError('Cloud server identity does not match the paired VPS', {
      status: response.status,
      code: 'SERVER_IDENTITY_MISMATCH',
      retryable: retryableHttpStatus(response.status),
    });
  }
}

function pinnedPublicKey(serverPublicKey) {
  const encoded = String(serverPublicKey ?? '').replace(/^ed25519:/, '');
  try {
    return createPublicKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'spki' });
  } catch {
    throw new CloudHttpError('Pinned cloud server identity is invalid', {
      code: 'SERVER_IDENTITY_INVALID',
    });
  }
}

function canonicalResponse({ nonce, method, pathAndQuery, status, digest: contentDigest }) {
  return `${RESPONSE_PROOF_VERSION}\n${nonce}\n${method}\n${pathAndQuery}\n${status}\n${contentDigest}`;
}

function canonicalSseEvent({ nonce, method, pathAndQuery, status, sequence, event, contentDigest }) {
  return `${SSE_PROOF_VERSION}\n${nonce}\n${method}\n${pathAndQuery}\n${status}\n${sequence}\n${event}\n${contentDigest}`;
}

function proofSignature(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 64 && bytes.toString('base64url') === value ? bytes : null;
}

function verifyResponseProof(profile, response, context) {
  verifyServerPin(profile, response);
  if (!profile.serverPublicKey) return null;
  const contentDigest = response.headers.get('x-rauhwpx-content-sha256') || '';
  const signature = proofSignature(response.headers.get('x-rauhwpx-response-signature'));
  if (!/^[a-f0-9]{64}$/.test(contentDigest) || !signature) {
    throw new CloudHttpError('Cloud response is missing a valid identity proof', {
      status: response.status,
      code: 'SERVER_PROOF_MISSING',
      retryable: retryableHttpStatus(response.status),
    });
  }
  const canonical = canonicalResponse({ ...context, status: response.status, digest: contentDigest });
  if (!verify(null, Buffer.from(canonical, 'utf8'), pinnedPublicKey(profile.serverPublicKey), signature)) {
    throw new CloudHttpError('Cloud response identity proof is invalid', {
      status: response.status,
      code: 'SERVER_PROOF_INVALID',
      retryable: retryableHttpStatus(response.status),
    });
  }
  return contentDigest;
}

function verifySseFrame(profile, frame, context) {
  const sequence = Number(frame.id);
  const contentDigest = digest(Buffer.from(frame.data, 'utf8'));
  const signature = proofSignature(frame.signature);
  if (!Number.isSafeInteger(sequence) || sequence < 1
    || frame.sha256 !== contentDigest || !signature) {
    throw new CloudHttpError('Cloud event identity proof is invalid', { code: 'SSE_PROOF_INVALID' });
  }
  const canonical = canonicalSseEvent({
    ...context,
    status: 200,
    sequence,
    event: frame.event,
    contentDigest,
  });
  if (!verify(null, Buffer.from(canonical, 'utf8'), pinnedPublicKey(profile.serverPublicKey), signature)) {
    throw new CloudHttpError('Cloud event identity proof is invalid', { code: 'SSE_PROOF_INVALID' });
  }
  return sequence;
}

function sseFrames(buffer) {
  const frames = [];
  let rest = buffer.replace(/\r\n/g, '\n');
  let boundary;
  while ((boundary = rest.indexOf('\n\n')) !== -1) {
    const raw = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    let event = 'message';
    let id = '';
    let sha256 = '';
    let signature = '';
    const data = [];
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'rauhwpx-sha256') sha256 = value;
      else if (field === 'rauhwpx-signature') signature = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) frames.push({ event, id, sha256, signature, data: data.join('\n') });
  }
  return { frames, rest };
}

export class CloudClient {
  #vault;
  #fetch;
  #transport;
  #profile = null;
  #accessToken = '';
  #accessExpiresAt = 0;
  #refreshPromise = null;
  #profileGeneration = 0;
  #credentialChain = Promise.resolve();

  constructor({ vault, fetchImpl = globalThis.fetch, transport = null } = {}) {
    if (!vault) throw new Error('CloudClient requires a secret vault');
    if (typeof fetchImpl !== 'function') throw new Error('CloudClient requires fetch');
    this.#vault = vault;
    this.#fetch = fetchImpl;
    this.#transport = transport;
  }

  async loadProfile() {
    if (this.#profile) return this.#profile;
    const stored = await this.#vault.get(PROFILE_SECRET);
    if (!stored) return null;
    this.#profile = normalizeCloudProfile(JSON.parse(stored));
    return this.#profile;
  }

  async saveProfile(raw) {
    const profile = normalizeCloudProfile(raw);
    const previous = await this.loadProfile().catch(() => null);
    return this.activateProfile(profile, {
      preserveCredentials: Boolean(
        previous
        && previous.serverPublicKey
        && previous.serverPublicKey === profile.serverPublicKey,
      ),
    });
  }

  async activateProfile(raw, {
    tokens = null,
    device,
    preserveCredentials = false,
  } = {}) {
    const profile = normalizeCloudProfile(raw);
    if (tokens && !validTokenBundle(tokens)) {
      throw new CloudHttpError('Cloud pairing response is invalid');
    }
    return this.#withCredentialLock(async () => {
      this.#profileGeneration += 1;
      try {
        const previous = {
          profile: await this.#vault.get(PROFILE_SECRET),
          refresh: await this.#vault.get(REFRESH_SECRET),
          device: await this.#vault.get(DEVICE_SECRET),
          cachedProfile: this.#profile,
          accessToken: this.#accessToken,
          accessExpiresAt: this.#accessExpiresAt,
        };
        const restore = async (key, value) => {
          if (value === null) await this.#vault.delete(key);
          else await this.#vault.set(key, value);
        };
        try {
          await this.#vault.set(PROFILE_SECRET, JSON.stringify(profile));
          if (tokens) await this.#vault.set(REFRESH_SECRET, tokens.refreshToken);
          else if (!preserveCredentials) await this.#vault.delete(REFRESH_SECRET);
          if (device !== undefined) {
            if (device === null) await this.#vault.delete(DEVICE_SECRET);
            else await this.#vault.set(DEVICE_SECRET, JSON.stringify(device));
          } else if (!preserveCredentials) {
            await this.#vault.delete(DEVICE_SECRET);
          }
        } catch (error) {
          this.#profile = previous.cachedProfile;
          this.#accessToken = previous.accessToken;
          this.#accessExpiresAt = previous.accessExpiresAt;
          try {
            await restore(PROFILE_SECRET, previous.profile);
            await restore(REFRESH_SECRET, previous.refresh);
            await restore(DEVICE_SECRET, previous.device);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Cloud profile activation failed and the previous credentials could not be fully restored',
            );
          }
          throw error;
        }
        this.#profile = profile;
        if (tokens) {
          this.#accessToken = tokens.accessToken;
          this.#accessExpiresAt = Number(tokens.accessExpiresAt) || Date.parse(tokens.accessExpiresAt) || Date.now() + 14 * 60_000;
        } else if (!preserveCredentials) {
          this.#accessToken = '';
          this.#accessExpiresAt = 0;
        }
        return profile;
      } finally {
        this.#profileGeneration += 1;
      }
    });
  }

  async disconnect() {
    return this.#withCredentialLock(async () => {
      this.#profileGeneration += 1;
      try {
        this.#accessToken = '';
        this.#accessExpiresAt = 0;
        await Promise.all([
          this.#vault.delete(REFRESH_SECRET).catch(() => false),
          this.#vault.delete(DEVICE_SECRET).catch(() => false),
        ]);
      } finally {
        this.#profileGeneration += 1;
      }
    });
  }

  async isPaired() {
    return Boolean(await this.#vault.get(REFRESH_SECRET));
  }

  async assertTransferReady({
    retryAttempts = TRANSFER_READINESS_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    timeoutMs = 10_000,
    signal,
  } = {}) {
    let profile;
    try {
      profile = await this.#requiredProfile();
    } catch (error) {
      if (error?.code === 'CLOUD_NOT_CONFIGURED') throw error;
      throw new CloudHttpError('Stored cloud profile could not be read', {
        code: 'CLOUD_PROFILE_UNREADABLE',
        retryable: false,
        details: { cause: String(error?.message ?? error) },
      });
    }
    let paired;
    try {
      paired = await this.isPaired();
    } catch (error) {
      throw new CloudHttpError('Cloud pairing credentials could not be read', {
        code: 'CLOUD_CREDENTIALS_UNAVAILABLE',
        retryable: false,
        details: { cause: String(error?.message ?? error) },
      });
    }
    if (!paired) {
      throw new CloudHttpError('This device must be paired with the VPS', {
        status: 401,
        code: 'PAIRING_REQUIRED',
        retryable: false,
      });
    }
    const health = await this.health(profile, {
      retryAttempts,
      retryBaseMs,
      timeoutMs,
      signal,
    });
    if (health?.protocolVersion !== 1) {
      throw new CloudHttpError('Cloud server protocol is not compatible with this app', {
        code: 'CLOUD_PROTOCOL_INCOMPATIBLE',
        retryable: false,
        details: { expected: 1, received: health?.protocolVersion ?? null },
      });
    }
    return { profile, health };
  }

  /** 사용자가 마지막으로 고른 서버 방식을 기억해 다음 설정을 그 화면에서 시작한다. */
  async loadServerMode() {
    const stored = await this.#vault.get(SERVER_MODE_SECRET).catch(() => null);
    return CLOUD_SERVER_MODES.includes(stored) ? stored : null;
  }

  async saveServerMode(mode) {
    if (!CLOUD_SERVER_MODES.includes(mode)) throw new CloudHttpError('Unsupported cloud server mode');
    await this.#vault.set(SERVER_MODE_SECRET, mode);
    return mode;
  }

  async loadPendingAppSandbox() {
    const stored = await this.#vault.get(PENDING_APP_SANDBOX_SECRET);
    return stored ? normalizePendingAppSandbox(stored) : null;
  }

  async savePendingAppSandbox({ providerId, sandbox, createdAt = new Date().toISOString() }) {
    const record = normalizePendingAppSandbox({
      version: 1,
      providerId,
      sandbox,
      createdAt,
    });
    await this.#vault.set(PENDING_APP_SANDBOX_SECRET, JSON.stringify(record));
    return record;
  }

  async clearPendingAppSandbox() {
    await this.#vault.delete(PENDING_APP_SANDBOX_SECRET);
    return true;
  }

  /** 샌드박스를 철거할 때 프로필과 자격 증명을 함께 지운다. */
  async forgetProfile() {
    return this.#withCredentialLock(async () => {
      this.#profileGeneration += 1;
      try {
        this.#profile = null;
        this.#accessToken = '';
        this.#accessExpiresAt = 0;
        await Promise.all([
          this.#vault.delete(PROFILE_SECRET).catch(() => false),
          this.#vault.delete(REFRESH_SECRET).catch(() => false),
          this.#vault.delete(DEVICE_SECRET).catch(() => false),
        ]);
        return true;
      } finally {
        this.#profileGeneration += 1;
      }
    });
  }

  /** 핀 없는 엔드포인트의 health를 읽어 샌드박스가 살아났는지 확인한다. */
  async probeEndpointHealth(endpoint, { signal } = {}) {
    return this.#request('/v1/health', {
      auth: false,
      target: directHttpsTarget(endpoint),
      retryAttempts: 1,
      timeoutMs: 10_000,
      signal,
    });
  }

  /**
   * SSH가 없는 앱 제공 샌드박스는 배포 시 주입한 부트스트랩 토큰으로 첫 페어링 코드를 받는다.
   * 응답은 방금 만든 nonce에 묶인 서버 서명으로 검증하므로 재생된 영수증은 통과하지 못한다.
   */
  async bootstrapPairing({
    endpoint,
    bootstrapToken,
    deviceName = '',
    serverPublicKey,
    signal,
    retryAttempts = SAFE_REQUEST_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    timeoutMs = 10_000,
  } = {}) {
    const normalizedEndpoint = normalizeCloudEndpoint(endpoint);
    if (!SERVER_KEY_RE.test(String(serverPublicKey ?? ''))) {
      throw new CloudHttpError('App sandbox did not present a valid server identity', {
        code: 'SERVER_IDENTITY_INVALID',
      });
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(String(bootstrapToken ?? ''))) {
      throw new CloudHttpError('App sandbox bootstrap token is invalid', { code: 'BOOTSTRAP_TOKEN_INVALID' });
    }
    const target = directHttpsTarget(normalizedEndpoint, serverPublicKey);
    const result = await this.#request('/v1/pairing/bootstrap', {
      method: 'POST',
      auth: false,
      target,
      headers: { authorization: `Bearer ${bootstrapToken}` },
      body: { deviceName: String(deviceName ?? '').slice(0, 120) },
      signal,
      retryAttempts,
      retryBaseMs,
      timeoutMs,
    });
    if (result.serverPublicKey !== serverPublicKey) {
      throw new CloudHttpError('App sandbox identity changed during pairing', {
        code: 'SERVER_IDENTITY_MISMATCH',
      });
    }
    if (!PAIRING_CODE_RE.test(String(result.code ?? ''))) {
      throw new CloudHttpError('App sandbox returned an invalid pairing code', {
        code: 'BOOTSTRAP_RECEIPT_INVALID',
      });
    }
    return { endpoint: normalizedEndpoint, serverPublicKey, pairingCode: result.code };
  }

  async deviceId() {
    const stored = await this.#vault.get(DEVICE_SECRET);
    if (!stored) return null;
    try {
      const device = JSON.parse(stored);
      return typeof device?.id === 'string' ? device.id : null;
    } catch {
      return null;
    }
  }

  async health(profileOverride = null, options = {}) {
    const profile = profileOverride ? normalizeCloudProfile(profileOverride) : await this.#requiredProfile();
    return this.#request('/v1/health', {
      auth: false,
      expectedPin: Boolean(profile.serverPublicKey),
      profile,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      retryAttempts: options.retryAttempts,
      retryBaseMs: options.retryBaseMs,
    });
  }

  async redeemPairingCode(code, deviceName, {
    profile: profileOverride = null,
    persist = true,
    signal,
    retryAttempts = SAFE_REQUEST_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    timeoutMs = 10_000,
  } = {}) {
    const profile = profileOverride ? normalizeCloudProfile(profileOverride) : await this.#requiredProfile();
    // The server durably binds this id to the first issued token family.  A
    // dropped response can therefore be retried without consuming another
    // one-time pairing code or creating another device.
    const requestId = randomUUID();
    const result = await this.#request('/v1/pairing/redeem', {
      method: 'POST',
      auth: false,
      expectedPin: Boolean(profile.serverPublicKey),
      body: {
        code: String(code ?? '').trim(),
        deviceName: String(deviceName ?? '').trim(),
        requestId,
      },
      profile,
      signal,
      retryAttempts,
      retryBaseMs,
      timeoutMs,
    });
    if (!validTokenBundle(result)) throw new CloudHttpError('Cloud pairing response is invalid');
    if (persist) {
      await this.activateProfile(profile, { tokens: result, device: result.device ?? null });
    }
    return {
      device: result.device,
      accessExpiresAt: result.accessExpiresAt,
      ...(persist ? {} : { credentials: {
        accessToken: result.accessToken,
        accessExpiresAt: result.accessExpiresAt,
        refreshToken: result.refreshToken,
        device: result.device ?? null,
      } }),
    };
  }

  async profile({ signal } = {}) {
    return this.#request('/v1/profile', { signal });
  }

  async seedProviderCredentials({ provider, apiKey = null, files = [] } = {}) {
    return this.#request(`/v1/providers/${encodeURIComponent(provider)}/credentials`, {
      method: 'POST',
      body: {
        ...(apiKey ? { apiKey } : {}),
        ...(files.length ? { files } : {}),
      },
    });
  }

  async createPairingCode(deviceName = '') {
    return this.#request('/v1/pairing', { method: 'POST', body: { deviceName } });
  }

  async putProviderAuth(provider, providerAuth, { signal } = {}) {
    try {
      return await this.#request(`/v1/providers/${encodeURIComponent(provider)}/auth`, {
        method: 'PUT',
        signal,
        body: {
          secrets: providerAuth?.secrets ?? {},
          files: providerAuth?.files ?? {},
        },
      });
    } catch (error) {
      if (error instanceof CloudHttpError && (
        error.status === 404
        || (error.status === 501 && error.code === 'AUTH_IMPORT_UNAVAILABLE')
      )) return null;
      throw error;
    }
  }

  async transfer({
    sessionId,
    threadId,
    documentId,
    provider,
    executionConfig,
    goal,
    documentName,
    documentBytes,
    timeline = [],
    resources = [],
    persistent = false,
    limits,
    providerAuth = null,
    onProgress = () => {},
    onSessionCreated = () => {},
    onSessionActivated = () => {},
    signal,
  }) {
    const document = Buffer.from(documentBytes ?? []);
    if (!document.length) throw new Error('A saved document is required for cloud transfer');
    if (document.length > MAX_RESULT_BYTES) throw new Error('Document exceeds the 64 MiB cloud limit');
    if (!validPortableTimeline(timeline)) throw new Error('Portable cloud timeline is invalid');
    if (providerAuth && (Object.keys(providerAuth.secrets ?? {}).length || Object.keys(providerAuth.files ?? {}).length)) {
      const imported = await this.putProviderAuth(provider, providerAuth, { signal });
      if (imported === null) {
        // A POST-only sandbox may already have accepted the coordinator's seed.
        // Only reject after both import protocols are unavailable and the remote
        // still reports that the selected provider is unauthenticated.
        const remote = await this.profile({ signal });
        const status = remote?.providers?.find((item) => item.provider === provider);
        if (!status?.authenticated) {
          throw new CloudHttpError(
            `${provider} is signed in on this computer, but this cloud server cannot import that login. Update or replace it with a compatible cloud runtime, then try again.`,
            {
              status: 409,
              code: 'SANDBOX_AUTH_UNSUPPORTED',
              details: status ?? null,
            },
          );
        }
      }
    }
    const documentUpload = await this.uploadBlob({
      bytes: document,
      name: documentName,
      kind: 'document',
      sessionId,
      signal,
      onProgress: (progress) => onProgress({ phase: 'document', ...progress }),
    });
    const uploadedResources = [];
    for (let index = 0; index < resources.length; index += 1) {
      const resource = resources[index];
      const upload = await this.uploadBlob({
        bytes: Buffer.from(resource.bytes ?? []),
        name: resource.name,
        kind: 'reference',
        sessionId,
        signal,
        onProgress: (progress) => onProgress({
          phase: 'resource',
          index,
          totalResources: resources.length,
          ...progress,
        }),
      });
      uploadedResources.push({
        name: resource.name,
        sha256: upload.sha256,
        size: upload.size,
        blobId: upload.blobId,
        kind: 'reference',
      });
    }
    const timelineBytes = Buffer.from(JSON.stringify(timeline), 'utf8');
    const timelineUpload = await this.uploadBlob({
      bytes: timelineBytes,
      name: 'timeline.json',
      kind: 'timeline',
      sessionId,
      signal,
      onProgress: (progress) => onProgress({ phase: 'timeline', ...progress }),
    });
    await onProgress({ phase: 'committing', loaded: 1, total: 1 });
    const created = await this.#request('/v1/sessions', {
      method: 'POST',
      signal,
      body: {
        sessionId,
        provider,
        persistent,
        executionConfig,
        goal,
        clientContext: { threadId, documentId },
        originDocument: {
          name: documentName,
          size: documentUpload.size,
          blobId: documentUpload.blobId,
        },
        resources: uploadedResources,
        timeline: { blobId: timelineUpload.blobId, size: timelineUpload.size },
        limits: {
          maxDurationSeconds: limits?.maxDurationSeconds
            ?? (Number(limits?.maxDurationMinutes) * 60 || undefined),
          maxTurns: limits?.maxTurns,
        },
      },
    });
    const cloudSessionId = created.id ?? created.sessionId ?? sessionId;
    await onSessionCreated({
      sessionId: cloudSessionId,
      stateVersion: created.stateVersion ?? created.version ?? 1,
      session: created,
    });
    const activated = await this.command(
      cloudSessionId,
      'session.activate',
      { expectedVersion: created.stateVersion ?? created.version ?? 1 },
      `activate_${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}`,
      { signal },
    );
    await onSessionActivated({
      sessionId: cloudSessionId,
      stateVersion: activated.session?.stateVersion ?? activated.session?.version
        ?? activated.stateVersion ?? activated.version ?? 2,
      eventSeq: Number(activated.eventSeq) || 0,
      session: activated.session ?? activated,
    });
    return activated.session ?? created;
  }

  async uploadBlob({
    bytes,
    name,
    kind,
    sessionId,
    onProgress = () => {},
    signal,
    retryAttempts = UPLOAD_REQUEST_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }) {
    const payload = Buffer.from(bytes ?? []);
    const sha256 = digest(payload);
    const maximumAttempts = boundedAttempts(retryAttempts, UPLOAD_REQUEST_ATTEMPTS);
    const initBody = { sha256, size: payload.length, name, kind, sessionId };
    let failures = 0;
    let reportedOffset = -1;

    const retryableUploadError = (error) => error?.retryable === true || [
      'UPLOAD_DIGEST_MISMATCH',
      'UPLOAD_NOT_FOUND',
      'UPLOAD_OFFSET_MISMATCH',
    ].includes(String(error?.code ?? '').toUpperCase());
    const recover = async (rawError) => {
      const error = normalizeTransportError(rawError);
      if (signal?.aborted) throw abortReason(signal, error);
      failures += 1;
      if (!retryableUploadError(error) || failures >= maximumAttempts) throw error;
      await retryDelay(failures, { baseMs: retryBaseMs, signal });
    };
    const normalizeState = (raw) => {
      const offset = Number(raw?.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > payload.length) {
        throw new CloudHttpError('Cloud upload returned an invalid offset', {
          code: 'INVALID_UPLOAD_OFFSET',
          retryable: false,
        });
      }
      const advertisedChunkSize = Number(raw?.chunkSize);
      const chunkSize = Number.isSafeInteger(advertisedChunkSize) && advertisedChunkSize > 0
        ? Math.min(advertisedChunkSize, MAX_UPLOAD_CHUNK_BYTES)
        : 1024 * 1024;
      const complete = raw?.blobExists === true || raw?.status === 'complete';
      if (!complete && (typeof raw?.uploadId !== 'string' || !raw.uploadId)) {
        throw new CloudHttpError('Cloud upload did not return an upload id', {
          code: 'INVALID_UPLOAD_ID',
          retryable: false,
        });
      }
      return { raw, offset, chunkSize, complete };
    };
    const initializeOnce = async () => normalizeState(await this.#request('/v1/uploads/init', {
      method: 'POST',
      signal,
      timeoutMs,
      retryAttempts: 1,
      body: initBody,
    }));
    const initialize = async () => {
      for (;;) {
        try {
          return await initializeOnce();
        } catch (error) {
          await recover(error);
        }
      }
    };
    const reportProgress = async (offset) => {
      if (offset === reportedOffset) return;
      reportedOffset = offset;
      await onProgress({ loaded: offset, total: payload.length });
    };

    let state = await initialize();
    let durableOffset = state.complete ? payload.length : state.offset;
    failures = 0;
    if (state.offset > 0 || state.complete) await reportProgress(state.complete ? payload.length : state.offset);
    for (;;) {
      if (state.complete) {
        await reportProgress(payload.length);
        return {
          ...state.raw,
          sha256,
          size: payload.length,
          offset: payload.length,
          blobId: state.raw.blob?.id ?? sha256,
        };
      }
      if (state.offset >= payload.length) {
        throw new CloudHttpError('Cloud upload completed without a stored blob', {
          code: 'INVALID_UPLOAD_STATE',
          retryable: false,
        });
      }
      const offset = state.offset;
      const chunk = payload.subarray(offset, Math.min(offset + state.chunkSize, payload.length));
      try {
        const progress = await this.#request(
          `/v1/uploads/${encodeURIComponent(state.raw.uploadId)}/chunks`,
          {
            method: 'POST',
            signal,
            timeoutMs,
            retryAttempts: 1,
            headers: {
              'content-type': 'application/octet-stream',
              'x-upload-offset': String(offset),
            },
            rawBody: chunk,
          },
        );
        const next = normalizeState(progress);
        if (next.offset <= offset) {
          throw new CloudHttpError('Cloud upload returned an invalid offset', {
            code: 'INVALID_UPLOAD_OFFSET',
            retryable: false,
          });
        }
        state = next;
        durableOffset = state.complete ? payload.length : state.offset;
        failures = 0;
        await reportProgress(state.complete ? payload.length : state.offset);
      } catch (error) {
        let terminalError = null;
        try {
          await recover(error);
        } catch (caught) {
          terminalError = caught;
        }
        if (terminalError) {
          // The final allowed chunk may have committed before its response was
          // lost. One last authoritative init is a read/reconcile operation,
          // not a replay; accept it only when it proves durable progress.
          if (retryableUploadError(terminalError) && !signal?.aborted) {
            try {
              const reconciled = await initializeOnce();
              const reconciledOffset = reconciled.complete ? payload.length : reconciled.offset;
              if (reconciledOffset > durableOffset) {
                state = reconciled;
                durableOffset = reconciledOffset;
                failures = 0;
                await reportProgress(reconciledOffset);
                continue;
              }
            } catch {
              // Preserve the original ambiguous chunk failure when the final
              // reconciliation itself is unavailable or proves no progress.
            }
          }
          throw terminalError;
        }
        // A chunk POST is ambiguous when its response is lost. Re-running init
        // asks the server for its durable offset instead of blindly duplicating
        // a write that may already have committed.
        state = await initialize();
        const reconciledOffset = state.complete ? payload.length : state.offset;
        if (reconciledOffset > durableOffset) {
          durableOffset = reconciledOffset;
          failures = 0;
        }
        if (state.offset > 0 || state.complete) {
          await reportProgress(state.complete ? payload.length : state.offset);
        }
      }
    }
  }

  async session(sessionId, options = {}) {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}`, options);
  }

  async sessions(options = {}) {
    const result = await this.#request('/v1/sessions', options);
    return Array.isArray(result.sessions) ? result.sessions : [];
  }

  async takeoverState(sessionId, options = {}) {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/takeover`, options);
  }

  async downloadTimeline(sessionId, options = {}) {
    const response = await this.#rawRequest(`/v1/sessions/${encodeURIComponent(sessionId)}/timeline`, {
      ...options,
      maxResponseBytes: MAX_TIMELINE_BYTES,
    });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TIMELINE_BYTES) {
      throw new CloudHttpError('Cloud timeline exceeds 100 MiB');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_TIMELINE_BYTES) {
      throw new CloudHttpError('Cloud timeline size is invalid');
    }
    const expected = response.headers.get('x-content-sha256') || '';
    const sha256 = digest(bytes);
    if (!expected || expected !== sha256) {
      throw new CloudHttpError('Cloud timeline failed integrity verification');
    }
    let timeline;
    try {
      timeline = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new CloudHttpError('Cloud timeline is invalid JSON');
    }
    if (!validPortableTimeline(timeline)) {
      throw new CloudHttpError('Cloud timeline does not match the portable timeline schema');
    }
    return {
      bytes,
      timeline,
      sha256,
      size: bytes.length,
      boundaryOperation: response.headers.get('x-boundary-operation') || '',
      boundaryRevision: Number(response.headers.get('x-boundary-revision')) || 0,
      boundaryTurn: Number(response.headers.get('x-boundary-turn')) || 0,
    };
  }

  async downloadCheckpoint(sessionId, options = {}) {
    const { operationId = null, ...requestOptions } = options;
    const query = operationId ? `?operationId=${encodeURIComponent(operationId)}` : '';
    const response = await this.#rawRequest(`/v1/sessions/${encodeURIComponent(sessionId)}/checkpoint${query}`, {
      ...requestOptions,
      maxResponseBytes: MAX_RESULT_BYTES,
    });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESULT_BYTES) {
      throw new CloudHttpError('Cloud checkpoint exceeds 64 MiB');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_RESULT_BYTES) {
      throw new CloudHttpError('Cloud checkpoint size is invalid');
    }
    const expected = response.headers.get('x-content-sha256') || '';
    const sha256 = digest(bytes);
    if (!expected || expected !== sha256) {
      throw new CloudHttpError('Cloud checkpoint failed integrity verification');
    }
    const encodedName = response.headers.get('x-document-name') || '';
    let name = encodedName;
    try { name = decodeURIComponent(encodedName); } catch {}
    return {
      bytes,
      sha256,
      size: bytes.length,
      name,
      revision: Number(response.headers.get('x-checkpoint-revision')) || 0,
      turn: Number(response.headers.get('x-checkpoint-turn')) || 0,
      boundaryOperation: response.headers.get('x-boundary-operation') || '',
      boundaryKind: response.headers.get('x-boundary-kind') || 'turn',
    };
  }

  async command(sessionId, type, payload = {}, commandId = randomUUID(), options = {}) {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/commands`, {
      method: 'POST',
      signal: options.signal,
      retryAttempts: options.retryAttempts ?? SAFE_REQUEST_ATTEMPTS,
      retryBaseMs: options.retryBaseMs,
      timeoutMs: options.timeoutMs ?? 10_000,
      body: { commandId, type, payload },
    });
  }

  async readEvents(sessionId, after = 0, {
    signal,
    onEvent = () => {},
    nonStreamTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    const response = await this.#rawRequest(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${encodeURIComponent(after)}`,
      {
        headers: { accept: 'text/event-stream' },
        signal,
        timeoutMs: 0,
        retryAttempts: 1,
        stream: true,
        maxResponseBytes: MAX_JSON_BYTES,
        nonStreamTimeoutMs,
      },
    );
    const profile = await this.#requiredProfile();
    const proofContext = response[RESPONSE_PROOF_CONTEXT];
    if (!proofContext || response.headers.get('x-rauhwpx-stream-protocol') !== SSE_STREAM_PROTOCOL
      || response.headers.get('x-rauhwpx-content-sha256') !== SSE_STREAM_DIGEST) {
      throw new CloudHttpError('Cloud event stream identity proof is invalid', { code: 'SSE_PROOF_INVALID' });
    }
    if (!response.body) throw new CloudHttpError('Cloud event stream is unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastSequence = after;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_JSON_BYTES) throw new CloudHttpError('Cloud event frame is too large');
        const parsed = sseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          const verifiedSequence = verifySseFrame(profile, frame, proofContext);
          let data;
          try { data = JSON.parse(frame.data); } catch {
            throw new CloudHttpError('Cloud event payload is invalid JSON', { code: 'SSE_PAYLOAD_INVALID' });
          }
          const declaredSequence = Number(data.sequence ?? data.seq ?? verifiedSequence);
          if (declaredSequence !== verifiedSequence) {
            throw new CloudHttpError('Cloud event sequence does not match its identity proof', { code: 'SSE_PROOF_INVALID' });
          }
          if (verifiedSequence <= lastSequence) continue;
          lastSequence = verifiedSequence;
          await onEvent({ ...data, sequence: verifiedSequence, event: frame.event });
        }
      }
    } finally {
      reader.releaseLock();
    }
    return lastSequence;
  }

  async watchSession(sessionId, after = 0, { signal, onEvent = () => {}, retryBaseMs = 500 } = {}) {
    let sequence = after;
    let failures = 0;
    while (!signal?.aborted) {
      try {
        sequence = await this.readEvents(sessionId, sequence, { signal, onEvent });
        failures = 0;
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') break;
        // A missing session or a broken stream proof never recovers by retrying;
        // surface it instead of looping in silence.
        if (error?.status === 404
          || error?.code === 'SESSION_NOT_FOUND'
          || error?.code === 'SSE_PROOF_INVALID'
          || error?.code === 'SSE_PAYLOAD_INVALID') {
          throw error;
        }
        failures += 1;
        // Long outages (sleep/wake, tunnel drops) must recover, so the cap is
        // generous; a permanently failing handler still terminates with an
        // error instead of looping in silence.
        if (failures >= 20) throw error;
      }
      await delay(Math.min(30_000, retryBaseMs * (2 ** failures)), undefined, { signal }).catch(() => {});
    }
    return sequence;
  }

  async downloadResult(resultId, options = {}) {
    const response = await this.#rawRequest(`/v1/results/${encodeURIComponent(resultId)}`, {
      ...options,
      maxResponseBytes: MAX_RESULT_BYTES,
    });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESULT_BYTES) {
      throw new CloudHttpError('Cloud result exceeds 64 MiB');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_RESULT_BYTES) throw new CloudHttpError('Cloud result size is invalid');
    const expected = response.headers.get('x-content-sha256') || '';
    const sha256 = digest(bytes);
    if (!expected || expected !== sha256) throw new CloudHttpError('Cloud result digest does not match');
    const encodedName = response.headers.get('x-document-name') || '';
    let name = encodedName;
    try { name = decodeURIComponent(encodedName); } catch {}
    return { bytes, sha256, size: bytes.length, name };
  }

  async confirmResultDownloaded(resultId, { sha256, size }, options = {}) {
    return this.#request(`/v1/results/${encodeURIComponent(resultId)}/download-confirmed`, {
      method: 'POST',
      signal: options.signal,
      retryAttempts: options.retryAttempts ?? 1,
      retryBaseMs: options.retryBaseMs,
      timeoutMs: options.timeoutMs,
      body: { sha256, size },
    });
  }

  async #requiredProfile() {
    const profile = await this.loadProfile();
    if (!profile) {
      throw new CloudHttpError('Cloud server is not configured', {
        code: 'CLOUD_NOT_CONFIGURED',
        retryable: false,
      });
    }
    return profile;
  }

  #withCredentialLock(operation) {
    const run = this.#credentialChain.then(operation, operation);
    this.#credentialChain = run.catch(() => {});
    return run;
  }

  async #acceptTokens(tokens) {
    this.#accessToken = tokens.accessToken;
    this.#accessExpiresAt = Number(tokens.accessExpiresAt) || Date.parse(tokens.accessExpiresAt) || Date.now() + 14 * 60_000;
    await this.#vault.set(REFRESH_SECRET, tokens.refreshToken);
  }

  async #ensureAccessToken() {
    if (this.#accessToken && this.#accessExpiresAt - Date.now() > 30_000) return this.#accessToken;
    if (!this.#refreshPromise) {
      const profileGeneration = this.#profileGeneration;
      this.#refreshPromise = (async () => {
        const refreshToken = await this.#vault.get(REFRESH_SECRET);
        if (!refreshToken) throw new CloudHttpError('This device must be paired with the VPS', {
          status: 401,
          code: 'PAIRING_REQUIRED',
          retryable: false,
        });
        const tokens = await this.#request('/v1/token/refresh', {
          method: 'POST',
          auth: false,
          body: { refreshToken },
          retryAuth: false,
          retryAttempts: SAFE_REQUEST_ATTEMPTS,
          timeoutMs: 10_000,
        });
        if (!validTokenBundle(tokens)) throw new CloudHttpError('Cloud token response is invalid');
        return this.#withCredentialLock(async () => {
          if (profileGeneration !== this.#profileGeneration) {
            throw new CloudHttpError('Cloud profile changed during token refresh', {
              code: 'PROFILE_CHANGED',
            });
          }
          await this.#acceptTokens(tokens);
          return this.#accessToken;
        });
      })().finally(() => { this.#refreshPromise = null; });
    }
    return this.#refreshPromise;
  }

  async #request(pathname, options = {}) {
    const response = await this.#rawRequest(pathname, {
      ...options,
      maxResponseBytes: options.maxResponseBytes ?? MAX_JSON_BYTES,
    });
    const body = await responseJson(response);
    const profile = options.target?.kind === 'direct-https'
      ? options.target
      : options.profile ?? await this.#requiredProfile();
    verifyServerPin(profile, response, body);
    return body;
  }

  async #rawRequest(pathname, options = {}) {
    const method = String(options.method ?? 'GET').toUpperCase();
    const defaultAttempts = method === 'GET' && options.stream !== true ? SAFE_REQUEST_ATTEMPTS : 1;
    const maximumAttempts = boundedAttempts(options.retryAttempts, defaultAttempts);
    let attempt = 0;
    for (;;) {
      try {
        return await this.#rawRequestOnce(pathname, options);
      } catch (rawError) {
        const error = normalizeTransportError(rawError);
        if (options.signal?.aborted) throw abortReason(options.signal, error);
        attempt += 1;
        if (error?.retryable !== true || attempt >= maximumAttempts) throw error;
        await retryDelay(attempt, { baseMs: options.retryBaseMs, signal: options.signal });
      }
    }
  }

  async #rawRequestOnce(pathname, options = {}) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const direct = options.target?.kind === 'direct-https';
    const profile = direct ? options.target : options.profile ?? await this.#requiredProfile();
    const auth = options.auth !== false;
    const headers = { ...(options.headers ?? {}) };
    const method = String(options.method ?? 'GET').toUpperCase();
    if (auth) headers.authorization = `Bearer ${await this.#ensureAccessToken()}`;
    let body = options.rawBody;
    if (body == null && options.body != null) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const lease = direct || !this.#transport
      ? { baseUrl: profile.endpoint, release() {} }
      : await this.#transport.acquire(profile, { signal: options.signal });
    const requestUrl = joinEndpoint(lease.baseUrl, pathname);
    const parsedRequestUrl = new URL(requestUrl);
    const proofContext = profile.serverPublicKey ? {
      nonce: randomBytes(24).toString('base64url'),
      method,
      pathAndQuery: `${parsedRequestUrl.pathname}${parsedRequestUrl.search}`,
    } : null;
    if (proofContext) headers['x-rauhwpx-request-nonce'] = proofContext.nonce;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const abort = controller ? () => controller.abort(options.signal?.reason) : null;
    if (abort) {
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    }
    const timeoutError = new CloudHttpError('Cloud request timed out', {
      code: 'ETIMEDOUT',
      retryable: true,
    });
    let timedOut = false;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError);
      }, timeoutMs)
      : null;
    let response;
    try {
      response = await this.#fetch(requestUrl, {
        method,
        headers,
        body,
        // Streaming requests have no request timeout. Passing the caller's
        // signal directly keeps cancellation attached after headers arrive and
        // throughout a blocked response-body read without a relay to clean up.
        signal: controller?.signal ?? options.signal,
        cache: 'no-store',
      });
      const expectedDigest = proofContext ? verifyResponseProof(profile, response, proofContext) : null;
      const isEventStream = options.stream === true
        && response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream');
      if (!isEventStream) {
        const bytes = await boundedResponseBytes(response, options.maxResponseBytes, {
          // Real SSE streams are intentionally unbounded in time. If a proxy
          // serves a non-streaming error body instead, bound that body just like
          // every ordinary control response.
          timeoutMs: options.stream === true && timeoutMs === 0
            ? options.nonStreamTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
            : 0,
        });
        if (proofContext && digest(bytes) !== expectedDigest) {
          throw new CloudHttpError('Cloud response body failed identity verification', {
            status: response.status,
            code: 'SERVER_BODY_TAMPERED',
            retryable: false,
          });
        }
        response = new Response(bytes.length ? bytes : null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      if (proofContext) Object.defineProperty(response, RESPONSE_PROOF_CONTEXT, { value: proofContext });
    } catch (rawError) {
      if (options.signal?.aborted) throw abortReason(options.signal, rawError);
      if (timedOut) throw timeoutError;
      throw normalizeTransportError(rawError);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abort) options.signal?.removeEventListener('abort', abort);
      lease.release();
    }
    if (response.status === 401 && auth && options.retryAuth !== false) {
      this.#accessToken = '';
      this.#accessExpiresAt = 0;
      await this.#ensureAccessToken();
      return this.#rawRequestOnce(pathname, { ...options, retryAuth: false });
    }
    if (!response.ok) {
      const payload = await responseJson(response).catch(() => ({}));
      const cloudError = payload.error && typeof payload.error === 'object' ? payload.error : payload;
      throw new CloudHttpError(cloudError.message || `Cloud request failed with HTTP ${response.status}`, {
        status: response.status,
        code: cloudError.code,
        details: cloudError.details,
        retryable: typeof cloudError.retryable === 'boolean'
          ? cloudError.retryable
          : retryableHttpStatus(response.status),
      });
    }
    return response;
  }
}

export const __test = {
  sseFrames,
  joinEndpoint,
  verifyServerPin,
  verifyResponseProof,
  verifySseFrame,
  canonicalResponse,
  canonicalSseEvent,
  validPortableTimeline,
};

import crypto from 'node:crypto';

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const RESOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/;
const MCP_PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CAPABILITY_GENERATION_MAX = 0xffffffffffff;
const SCOPED_TOKEN_PREFIX = 'rhwp2';
const MAX_ENCODED_ENVELOPE_LENGTH = 2_048;
const MAC_BYTES = 32;
export const MAX_HUB_SESSIONS = 64;

export const HUB_CAPABILITY_AUDIENCES = Object.freeze({
  STUDIO: 'studio',
  MCP: 'mcp',
  COPY_LAYOUT_WORKER: 'copy-layout-worker',
  REFERENCE: 'reference',
  TEMPLATE: 'template',
  ARTIFACT: 'artifact',
  DOWNLOAD: 'download',
  SNAPSHOT: 'snapshot',
});

const CAPABILITY_AUDIENCES = new Set(Object.values(HUB_CAPABILITY_AUDIENCES));
const RESOURCE_REQUIRED_AUDIENCES = new Set([
  HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER,
  HUB_CAPABILITY_AUDIENCES.ARTIFACT,
  HUB_CAPABILITY_AUDIENCES.DOWNLOAD,
  HUB_CAPABILITY_AUDIENCES.SNAPSHOT,
]);
const RESOURCE_FORBIDDEN_AUDIENCES = new Set([
  HUB_CAPABILITY_AUDIENCES.STUDIO,
]);

function registryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unauthorizedSession() {
  return registryError('UNAUTHORIZED_SESSION', 'invalid hub capability for session');
}

function requireMasterToken(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw registryError('HUB_TOKEN_REQUIRED', 'a non-empty hub master token is required');
  }
  return value;
}

function requireCapabilityGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > CAPABILITY_GENERATION_MAX) {
    throw registryError(
      'INVALID_CAPABILITY_GENERATION',
      `capability generation must be an integer from 1 to ${CAPABILITY_GENERATION_MAX}`,
    );
  }
  return value;
}

export function requireCapabilityAudience(value) {
  if (typeof value !== 'string' || !CAPABILITY_AUDIENCES.has(value)) {
    throw registryError('INVALID_CAPABILITY_AUDIENCE', 'unknown hub capability audience');
  }
  return value;
}

export function requireCapabilityResource(value) {
  if (typeof value !== 'string' || !RESOURCE_PATTERN.test(value)) {
    throw registryError(
      'INVALID_CAPABILITY_RESOURCE',
      'capability resource must be 1-256 URL-safe characters',
    );
  }
  return value;
}

export function mcpProviderResource({ agent, role = 'chat', generation } = {}) {
  if (typeof agent !== 'string' || !MCP_PROVIDER_PATTERN.test(agent)) {
    throw registryError(
      'INVALID_MCP_PROVIDER',
      'MCP provider must be 1-64 lowercase letters, digits, or hyphens',
    );
  }
  if (role !== 'chat') {
    throw registryError('INVALID_MCP_PROVIDER_ROLE', 'root MCP providers must use the chat role');
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw registryError(
      'INVALID_MCP_PROVIDER_GENERATION',
      'MCP provider generation must be a positive safe integer',
    );
  }
  return `provider.${generation}.${agent}.${role}`;
}

function normalizeResource(audience, resource) {
  if (resource === undefined) {
    if (RESOURCE_REQUIRED_AUDIENCES.has(audience)) {
      throw registryError(
        'CAPABILITY_RESOURCE_REQUIRED',
        `${audience} capabilities require an exact resource`,
      );
    }
    return undefined;
  }
  if (RESOURCE_FORBIDDEN_AUDIENCES.has(audience)) {
    throw registryError(
      'CAPABILITY_RESOURCE_FORBIDDEN',
      `${audience} capabilities cannot carry a resource`,
    );
  }
  return requireCapabilityResource(resource);
}

function normalizeExpiration(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw registryError(
      'INVALID_CAPABILITY_EXPIRATION',
      'capability expiration must be a positive epoch timestamp in milliseconds',
    );
  }
  return value;
}

function capabilityEnvelope({ sessionId, generation, audience, resource, expiresAt }) {
  const sid = requireSessionId(sessionId);
  const gen = requireCapabilityGeneration(generation);
  const aud = requireCapabilityAudience(audience);
  const normalizedResource = normalizeResource(aud, resource);
  const exp = normalizeExpiration(expiresAt);
  return {
    sid,
    gen,
    aud,
    ...(normalizedResource === undefined ? {} : { resource: normalizedResource }),
    ...(exp === undefined ? {} : { exp }),
  };
}

function encodeEnvelope(envelope) {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

function decodeCanonicalBase64Url(value, maxLength = MAX_ENCODED_ENVELOPE_LENGTH) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}

function parseEnvelope(encodedEnvelope) {
  const bytes = decodeCanonicalBase64Url(encodedEnvelope);
  if (!bytes) return null;
  const json = bytes.toString('utf8');
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.some((key) => !['sid', 'gen', 'aud', 'resource', 'exp'].includes(key))) return null;
  try {
    const normalized = capabilityEnvelope({
      sessionId: raw.sid,
      generation: raw.gen,
      audience: raw.aud,
      ...(Object.hasOwn(raw, 'resource') ? { resource: raw.resource } : {}),
      ...(Object.hasOwn(raw, 'exp') ? { expiresAt: raw.exp } : {}),
    });
    // The issuer uses one canonical property order. Reject duplicate keys,
    // alternate escapes, whitespace, and other ambiguous JSON spellings.
    return JSON.stringify(normalized) === json ? normalized : null;
  } catch {
    return null;
  }
}

function parseTokenParts(token) {
  if (typeof token !== 'string' || token.length > 4_096) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== SCOPED_TOKEN_PREFIX) return null;
  const [, encodedEnvelope, encodedMac] = parts;
  if (!encodedEnvelope || !encodedMac) return null;
  return { encodedEnvelope, encodedMac };
}

function verifyTokenMac(masterToken, encodedEnvelope, encodedMac) {
  const expected = crypto
    .createHmac('sha256', requireMasterToken(masterToken))
    .update(`${SCOPED_TOKEN_PREFIX}.${encodedEnvelope}`)
    .digest();
  const decoded = decodeCanonicalBase64Url(encodedMac, 64);
  const received = decoded?.length === MAC_BYTES ? decoded : Buffer.alloc(MAC_BYTES);
  const matches = crypto.timingSafeEqual(received, expected);
  return decoded?.length === MAC_BYTES && matches;
}

function tokenEnvelope(masterToken, token) {
  const parts = parseTokenParts(token);
  if (!parts) return null;
  if (!verifyTokenMac(masterToken, parts.encodedEnvelope, parts.encodedMac)) return null;
  return parseEnvelope(parts.encodedEnvelope);
}

function monotonicCapabilityGeneration() {
  let next = 0;
  while (next === 0) next = crypto.randomBytes(6).readUIntBE(0, 6);
  return () => {
    const generation = next;
    next = next === CAPABILITY_GENERATION_MAX ? 1 : next + 1;
    return generation;
  };
}

export function timingSafeTextEqual(left, right) {
  const received = Buffer.from(String(left ?? ''), 'utf8');
  const expected = Buffer.from(String(right ?? ''), 'utf8');
  if (received.length !== expected.length) {
    crypto.timingSafeEqual(
      crypto.createHash('sha256').update(received).digest(),
      crypto.createHash('sha256').update(expected).digest(),
    );
    return false;
  }
  return crypto.timingSafeEqual(received, expected);
}

export function requireSessionId(value) {
  const sessionId = typeof value === 'string' ? value : '';
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw registryError('INVALID_SESSION_ID', 'sessionId must be 1-128 URL-safe characters');
  }
  return sessionId;
}

export function resolveHubIdentity(env = process.env) {
  const production = env.NODE_ENV === 'production' || env.RHWP_AGENT_MODE === 'production';
  const suppliedToken = typeof env.RHWP_AGENT_TOKEN === 'string' ? env.RHWP_AGENT_TOKEN.trim() : '';
  if (production && !suppliedToken) {
    throw registryError('HUB_TOKEN_REQUIRED', 'RHWP_AGENT_TOKEN is required in production');
  }
  return {
    token: suppliedToken || env.RHWP_AGENT_DEV_TOKEN || 'dev',
    development: !production && !suppliedToken,
    launchId: env.RHWP_LAUNCH_ID || crypto.randomUUID(),
  };
}

export function issueScopedHubToken(masterToken, sessionId, {
  generation,
  audience,
  resource,
  expiresAt,
} = {}) {
  const envelope = capabilityEnvelope({ sessionId, generation, audience, resource, expiresAt });
  const encodedEnvelope = encodeEnvelope(envelope);
  const signature = crypto
    .createHmac('sha256', requireMasterToken(masterToken))
    .update(`${SCOPED_TOKEN_PREFIX}.${encodedEnvelope}`)
    .digest('base64url');
  return `${SCOPED_TOKEN_PREFIX}.${encodedEnvelope}.${signature}`;
}

// Child processes use this to fill RHWP_SESSION_ID from their environment. It
// parses the envelope but cannot authenticate it without the hub's master key.
// The hub must still call authenticateHubSession before trusting the result.
export function sessionIdFromScopedHubToken(token, { audience } = {}) {
  const parts = parseTokenParts(token);
  if (!parts) return null;
  const envelope = parseEnvelope(parts.encodedEnvelope);
  if (!envelope) return null;
  if (audience !== undefined) {
    try {
      if (envelope.aud !== requireCapabilityAudience(audience)) return null;
    } catch {
      return null;
    }
  }
  return envelope.sid;
}

export function authenticateHubSession({
  masterToken,
  token,
  sessionId,
  audience,
  resource,
  registry,
  allowMaster = false,
  now = Date.now(),
}) {
  const normalizedMasterToken = requireMasterToken(masterToken);
  const normalizedSessionId = requireSessionId(sessionId);
  const normalizedAudience = requireCapabilityAudience(audience);
  const normalizedResource = normalizeResource(normalizedAudience, resource);
  if (
    !registry
    || typeof registry.get !== 'function'
    || typeof registry.capabilityGeneration !== 'function'
  ) {
    throw registryError('SESSION_REGISTRY_REQUIRED', 'hub capability authentication requires a session registry');
  }
  const record = registry.get(normalizedSessionId);
  if (!record) throw unauthorizedSession();
  if (allowMaster && timingSafeTextEqual(token, normalizedMasterToken)) return normalizedSessionId;

  const envelope = tokenEnvelope(normalizedMasterToken, token);
  if (
    !envelope
    || envelope.sid !== normalizedSessionId
    || envelope.gen !== registry.capabilityGeneration(normalizedSessionId)
    || envelope.aud !== normalizedAudience
    || envelope.resource !== normalizedResource
    || (envelope.exp !== undefined && (!Number.isSafeInteger(now) || now >= envelope.exp))
  ) throw unauthorizedSession();
  return normalizedSessionId;
}

export function authenticateMasterToken(masterToken, token) {
  requireMasterToken(masterToken);
  if (timingSafeTextEqual(token, masterToken)) return true;
  throw registryError('UNAUTHORIZED', 'invalid hub token');
}

export function createHubSessionRecord(sessionId) {
  return {
    sessionId: requireSessionId(sessionId),
    createdAt: Date.now(),
    lastConnectedAt: Date.now(),
    studioSocket: null,
    mcpSockets: new Set(),
    agentSession: null,
    pendingReferenceMessage: null,
    nextCapabilityEpoch: 1,
    pendingCalls: new Map(),
    pendingUserQuestion: null,
    suppressedUserQuestionCallIds: new Set(),
    pendingUserQuestionScopes: [],
    userQuestionResponseReceipts: new Map(),
    nextHubId: 1,
    sessionGeneration: 0,
    missedTurnEnd: null,
    styleCalibration: null,
    browserbaseSession: null,
  };
}

export class HubSessionRegistry {
  #capabilityGenerations = new Map();

  constructor({
    createRecord = createHubSessionRecord,
    createGeneration = monotonicCapabilityGeneration(),
    now = Date.now,
    maxSessions = MAX_HUB_SESSIONS,
  } = {}) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > MAX_HUB_SESSIONS) {
      throw new TypeError(`maxSessions must be an integer from 1 to ${MAX_HUB_SESSIONS}`);
    }
    this.records = new Map();
    this.createRecord = createRecord;
    this.createGeneration = createGeneration;
    this.lastCapabilityGeneration = null;
    this.now = now;
    this.maxSessions = maxSessions;
  }

  get(sessionId) {
    return this.records.get(requireSessionId(sessionId)) ?? null;
  }

  require(sessionId) {
    const normalizedSessionId = requireSessionId(sessionId);
    const record = this.records.get(normalizedSessionId);
    if (!record) throw registryError('SESSION_NOT_REGISTERED', 'hub session is not registered');
    record.lastConnectedAt = this.now();
    return record;
  }

  register(sessionId) {
    const normalizedSessionId = requireSessionId(sessionId);
    const existing = this.records.get(normalizedSessionId);
    if (existing) {
      existing.lastConnectedAt = this.now();
      return existing;
    }
    // Refuse before invoking createRecord: the production factory creates
    // per-session credential mirrors and directories, so a rejected request
    // must not leave any of those resources behind.
    if (this.records.size >= this.maxSessions) {
      throw registryError(
        'SESSION_LIMIT_REACHED',
        `hub session limit of ${this.maxSessions} has been reached`,
      );
    }
    const record = this.createRecord(normalizedSessionId);
    if (!record || typeof record !== 'object' || record.sessionId !== normalizedSessionId) {
      throw registryError('INVALID_SESSION_RECORD', 'session record factory returned an invalid record');
    }
    const capabilityGeneration = this.#nextGeneration();
    this.#capabilityGenerations.set(normalizedSessionId, capabilityGeneration);
    Object.defineProperty(record, 'capabilityGeneration', {
      configurable: false,
      enumerable: true,
      get: () => this.#capabilityGenerations.get(normalizedSessionId) ?? null,
    });
    this.records.set(normalizedSessionId, record);
    record.lastConnectedAt = this.now();
    return record;
  }

  // Kept as a migration guard for old call sites. It cannot create a session.
  getOrCreate(sessionId) {
    return this.require(sessionId);
  }

  rotate(sessionId) {
    const record = this.require(sessionId);
    const generation = this.#nextGeneration(this.capabilityGeneration(record.sessionId));
    this.#capabilityGenerations.set(record.sessionId, generation);
    return generation;
  }

  capabilityGeneration(sessionId) {
    return this.#capabilityGenerations.get(requireSessionId(sessionId)) ?? null;
  }

  issue(masterToken, sessionId, { audience, resource, expiresAt } = {}) {
    const record = this.require(sessionId);
    return issueScopedHubToken(masterToken, record.sessionId, {
      generation: this.capabilityGeneration(record.sessionId),
      audience,
      resource,
      expiresAt,
    });
  }

  authenticate(options) {
    return authenticateHubSession({ ...options, registry: this });
  }

  delete(sessionId) {
    const normalizedSessionId = requireSessionId(sessionId);
    this.#capabilityGenerations.delete(normalizedSessionId);
    return this.records.delete(normalizedSessionId);
  }

  values() {
    return this.records.values();
  }

  summaries(toSummary = (record) => ({ sessionId: record.sessionId })) {
    return [...this.records.values()].map(toSummary);
  }

  async disposeAll(dispose) {
    const records = [...this.records.values()];
    this.records.clear();
    this.#capabilityGenerations.clear();
    const results = await Promise.allSettled(records.map(async (record) => dispose(record)));
    return results.every((result) => result.status === 'fulfilled' && result.value === true);
  }

  #nextGeneration(previous) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const generation = requireCapabilityGeneration(this.createGeneration());
      if (generation !== previous && generation !== this.lastCapabilityGeneration) {
        this.lastCapabilityGeneration = generation;
        return generation;
      }
    }
    throw registryError('CAPABILITY_GENERATION_FAILED', 'could not allocate a new capability generation');
  }
}

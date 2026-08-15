import crypto from 'node:crypto';

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCOPED_TOKEN_PREFIX = 'rhwp1';

function timingSafeTextEqual(left, right) {
  const received = Buffer.from(String(left ?? ''), 'utf8');
  const expected = Buffer.from(String(right ?? ''), 'utf8');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

export function requireSessionId(value) {
  const sessionId = typeof value === 'string' ? value : '';
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    const error = new Error('sessionId must be 1-128 URL-safe characters');
    error.code = 'INVALID_SESSION_ID';
    throw error;
  }
  return sessionId;
}

export function resolveHubIdentity(env = process.env) {
  const production = env.NODE_ENV === 'production' || env.RHWP_AGENT_MODE === 'production';
  const suppliedToken = typeof env.RHWP_AGENT_TOKEN === 'string' ? env.RHWP_AGENT_TOKEN.trim() : '';
  if (production && !suppliedToken) {
    const error = new Error('RHWP_AGENT_TOKEN is required in production');
    error.code = 'HUB_TOKEN_REQUIRED';
    throw error;
  }
  return {
    token: suppliedToken || env.RHWP_AGENT_DEV_TOKEN || 'dev',
    development: !production && !suppliedToken,
    launchId: env.RHWP_LAUNCH_ID || crypto.randomUUID(),
  };
}

export function issueScopedHubToken(masterToken, sessionId) {
  const normalizedSessionId = requireSessionId(sessionId);
  const encodedSessionId = Buffer.from(normalizedSessionId, 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', String(masterToken))
    .update(`${SCOPED_TOKEN_PREFIX}.${encodedSessionId}`)
    .digest('base64url');
  return `${SCOPED_TOKEN_PREFIX}.${encodedSessionId}.${signature}`;
}

export function sessionIdFromScopedHubToken(token) {
  const [prefix, encodedSessionId, signature, extra] = String(token ?? '').split('.');
  if (prefix !== SCOPED_TOKEN_PREFIX || !encodedSessionId || !signature || extra) return null;
  try {
    return requireSessionId(Buffer.from(encodedSessionId, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function authenticateHubSession({ masterToken, token, sessionId, allowMaster = true }) {
  const normalizedSessionId = requireSessionId(sessionId);
  if (allowMaster && timingSafeTextEqual(token, masterToken)) return normalizedSessionId;
  const expected = issueScopedHubToken(masterToken, normalizedSessionId);
  if (timingSafeTextEqual(token, expected)) return normalizedSessionId;
  const error = new Error('invalid hub token for session');
  error.code = 'UNAUTHORIZED_SESSION';
  throw error;
}

export function authenticateMasterToken(masterToken, token) {
  if (timingSafeTextEqual(token, masterToken)) return true;
  const error = new Error('invalid hub token');
  error.code = 'UNAUTHORIZED';
  throw error;
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
    nextHubId: 1,
    sessionGeneration: 0,
    missedTurnEnd: null,
    styleCalibration: null,
    browserbaseSession: null,
  };
}

export class HubSessionRegistry {
  constructor({ createRecord = createHubSessionRecord } = {}) {
    this.records = new Map();
    this.createRecord = createRecord;
  }

  get(sessionId) {
    return this.records.get(requireSessionId(sessionId)) ?? null;
  }

  getOrCreate(sessionId) {
    const normalizedSessionId = requireSessionId(sessionId);
    let record = this.records.get(normalizedSessionId);
    if (!record) {
      record = this.createRecord(normalizedSessionId);
      this.records.set(normalizedSessionId, record);
    }
    record.lastConnectedAt = Date.now();
    return record;
  }

  delete(sessionId) {
    return this.records.delete(requireSessionId(sessionId));
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
    await Promise.allSettled(records.map((record) => dispose(record)));
  }
}

import { createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';

export const CLOUD_PROVIDERS = Object.freeze(['claude', 'codex', 'pi', 'grok', 'cursor']);
export const DEFAULT_CLOUD_LIMITS = Object.freeze({
  maxRunningSessions: 2,
  maxQueuedSessions: 20,
  maxDurationMinutes: 8 * 60,
  maxTurns: 100,
});

const SSH_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/i;
const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

function requiredString(value, label, maxLength = 2048) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  if (result.length > maxLength) throw new Error(`${label} is too long`);
  if (result.includes('\0')) throw new Error(`${label} is invalid`);
  return result;
}

function boundedInteger(value, fallback, min, max, label) {
  const number = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

export function normalizeTailscaleHttpsPort(value, fallback = 443) {
  return boundedInteger(value, fallback, 1, 65535, 'Tailscale HTTPS port');
}

export function isTailscaleHost(host) {
  const value = String(host ?? '').trim().toLowerCase();
  if (value.endsWith('.ts.net')) return true;
  if (value && !value.includes('.') && HOST_RE.test(value)) return true;
  if (isIP(value) !== 4) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

export function normalizeCloudEndpoint(raw) {
  let url;
  try {
    url = new URL(requiredString(raw, 'Cloud endpoint'));
  } catch (error) {
    if (error instanceof Error && error.message === 'Cloud endpoint is required') throw error;
    throw new Error('Cloud endpoint must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:') throw new Error('Cloud endpoint must use HTTPS');
  if (url.username || url.password) throw new Error('Cloud endpoint must not contain credentials');
  if (url.search || url.hash) throw new Error('Cloud endpoint must not contain a query or fragment');
  url.pathname = `${url.pathname.replace(/\/+$/, '') || ''}/`;
  return url.toString().replace(/\/$/, '');
}

export function normalizeSshConfig(raw = {}) {
  const host = requiredString(raw.host, 'SSH host', 253);
  if (isIP(host) === 0 && !HOST_RE.test(host)) throw new Error('SSH host is invalid');
  const user = requiredString(raw.user, 'SSH user', 32);
  if (!SSH_USER_RE.test(user)) throw new Error('SSH user is invalid');
  const port = boundedInteger(raw.port, 22, 1, 65535, 'SSH port');
  const keyPath = String(raw.keyPath ?? '').trim();
  if (keyPath.includes('\0') || keyPath.length > 4096) throw new Error('SSH key path is invalid');
  const useTailscaleSsh = raw.useTailscaleSsh !== false;
  if (useTailscaleSsh && !isTailscaleHost(host)) {
    throw new Error('Tailscale SSH requires a Tailscale IP or MagicDNS hostname');
  }
  return Object.freeze({ host, user, port, keyPath, useTailscaleSsh });
}

export function normalizeCloudLimits(raw = {}) {
  return Object.freeze({
    maxRunningSessions: boundedInteger(
      raw.maxRunningSessions,
      DEFAULT_CLOUD_LIMITS.maxRunningSessions,
      1,
      8,
      'Running session limit',
    ),
    maxQueuedSessions: boundedInteger(
      raw.maxQueuedSessions,
      DEFAULT_CLOUD_LIMITS.maxQueuedSessions,
      1,
      100,
      'Queued session limit',
    ),
    maxDurationMinutes: boundedInteger(
      raw.maxDurationMinutes,
      DEFAULT_CLOUD_LIMITS.maxDurationMinutes,
      15,
      24 * 60,
      'Duration limit',
    ),
    maxTurns: boundedInteger(raw.maxTurns, DEFAULT_CLOUD_LIMITS.maxTurns, 1, 500, 'Turn limit'),
  });
}

export function normalizeCloudProfile(raw = {}) {
  const endpoint = normalizeCloudEndpoint(raw.endpoint);
  const ssh = normalizeSshConfig(raw.ssh);
  const provider = raw.provider == null ? 'codex' : String(raw.provider).toLowerCase();
  if (!CLOUD_PROVIDERS.includes(provider)) throw new Error(`Unsupported cloud provider: ${provider}`);
  const serverPublicKey = String(raw.serverPublicKey ?? '').trim();
  if (serverPublicKey) {
    if (!/^ed25519:[A-Za-z0-9_-]{59}$/.test(serverPublicKey)) {
      throw new Error('Pinned server public key is invalid');
    }
    try {
      const encoded = serverPublicKey.slice('ed25519:'.length);
      const key = createPublicKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519'
        || key.export({ format: 'der', type: 'spki' }).toString('base64url') !== encoded) {
        throw new Error('not Ed25519');
      }
    } catch {
      throw new Error('Pinned server public key is invalid');
    }
  }
  const transport = raw.transport === 'public-https' || raw.transport === 'tailscale'
    ? raw.transport
    : isTailscaleHost(ssh.host) ? 'tailscale' : 'public-https';
  const endpointPort = Number(new URL(endpoint).port || 443);
  const tailscaleHttpsPort = normalizeTailscaleHttpsPort(
    raw.tailscaleHttpsPort,
    transport === 'tailscale' ? endpointPort : 443,
  );
  if (transport === 'tailscale' && endpointPort !== tailscaleHttpsPort) {
    throw new Error('Cloud endpoint port must match the Tailscale HTTPS port');
  }
  return Object.freeze({
    version: 1,
    id: 'personal-vps',
    name: String(raw.name ?? '').trim().slice(0, 80) || 'Personal VPS',
    endpoint,
    ssh,
    provider,
    limits: normalizeCloudLimits(raw.limits),
    serverPublicKey,
    transport,
    tailscaleHttpsPort,
  });
}

export function cloudProfileWithoutSecrets(profile) {
  if (!profile) return null;
  const normalized = normalizeCloudProfile(profile);
  return {
    ...normalized,
    ssh: { ...normalized.ssh, keyPath: normalized.ssh.keyPath ? '<configured>' : '' },
  };
}

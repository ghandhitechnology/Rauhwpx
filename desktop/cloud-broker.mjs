import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerError } from './cloud-app-server.mjs';

export const RAUCLOUD_PROVIDER_ID = 'raucloud';
export const RAUCLOUD_ACCESS_SECRET = 'rhwp.rau.openrouter-api-key';
export const RAUCLOUD_DEFAULT_URL = 'https://rau-credits-production.up.railway.app';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
// Older brokers kept create requests open. Stay below Railway's five-minute
// silent-request limit while allowing those builds more time during rollout.
const SETUP_REQUEST_TIMEOUT_MS = 4 * 60_000 + 30_000;
export const RAUCLOUD_SETUP_TIMEOUT_MS = 30 * 60_000;
const ACCESS_TOKEN_RE = /^rau_v1_[A-Za-z0-9_-]{8,4096}$/;

const LIFECYCLE = Object.freeze({
  requested: 'provisioning',
  queued: 'provisioning',
  provisioning: 'provisioning',
  allocating: 'provisioning',
  warming: 'provisioning',
  allocated: 'ready',
  ready: 'ready',
  running: 'ready',
  active: 'ready',
  warm: 'ready',
  'warm-idle': 'ready',
  stopping: 'tearing-down',
  checkpointing: 'tearing-down',
  checkpointed: 'idle',
  completed: 'idle',
  stopped: 'idle',
  deleted: 'idle',
  released: 'idle',
  expired: 'idle',
  idle: 'idle',
  failed: 'error',
  error: 'error',
});

function trimmed(value, limit = 2048) {
  const result = String(value ?? '').trim();
  return result.length <= limit ? result : '';
}

function brokerBaseUrl(value) {
  let url;
  try { url = new URL(trimmed(value, 4096)); } catch {
    throw new Error('Raucloud broker URL is invalid');
  }
  const localDevelopment = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localDevelopment) {
    throw new Error('Raucloud broker must use HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Raucloud broker URL must not contain credentials, a query, or a fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

export function raucloudBrokerUrl(environment = process.env) {
  return brokerBaseUrl(
    environment.RAUHWpx_CLOUD_BROKER_URL
      || environment.RAU_CREDITS_URL
      || RAUCLOUD_DEFAULT_URL,
  );
}

function endpoint(baseUrl, pathname, query = null) {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function runEnvelope(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return payload.run ?? payload.cloudRun ?? payload.activeRun ?? payload.instance ?? payload.worker ?? payload;
}

function runId(payload) {
  const run = runEnvelope(payload);
  return trimmed(run.id ?? run.runId ?? run.lease?.runId ?? payload?.runId, 128);
}

function receiptFrom(payload) {
  const run = runEnvelope(payload);
  const receipt = payload?.receipt ?? run?.receipt ?? run?.profile ?? payload?.profile ?? {};
  const result = {
    endpoint: trimmed(receipt.endpoint ?? run.endpoint, 4096),
    serverPublicKey: trimmed(receipt.serverPublicKey ?? run.serverPublicKey, 512),
    pairingCode: trimmed(receipt.pairingCode ?? run.pairingCode, 64),
  };
  return result.endpoint && result.serverPublicKey && result.pairingCode ? result : null;
}

function normalizedStatus(payload, fallback = 'idle') {
  const run = runEnvelope(payload);
  const worker = payload?.worker && typeof payload.worker === 'object' ? payload.worker : null;
  const suppliedStatus = trimmed(
    run.status ?? run.lifecycle ?? worker?.status ?? payload?.status,
    64,
  ).toLowerCase() || fallback;
  const rawStatus = run.inputBlocked === true && suppliedStatus === 'active' ? 'stopping' : suppliedStatus;
  const lifecycle = LIFECYCLE[rawStatus] ?? (payload?.error ? 'error' : fallback);
  const ownerDeviceId = trimmed(run.ownerDeviceId ?? worker?.ownerDeviceId, 128);
  const controller = run.controller ?? payload?.controller ?? (ownerDeviceId ? { deviceId: ownerDeviceId } : null);
  const quota = payload?.quota ?? run.quota ?? null;
  const warmUntil = run.warmUntil ?? worker?.warmUntil ?? payload?.warmUntil ?? null;
  const gate = payload?.gate && typeof payload.gate === 'object' ? payload.gate : null;
  return {
    lifecycle,
    status: rawStatus,
    message: trimmed(payload?.message ?? run.message, 1024) || null,
    raucloud: {
      runId: runId(payload) || null,
      status: rawStatus,
      lifecycle,
      controller: controller && typeof controller === 'object' ? controller : null,
      readOnly: run.readOnly === true || payload?.readOnly === true || gate?.state === 'owned_elsewhere',
      takeoverRequired: run.takeoverRequired === true || payload?.takeoverRequired === true || gate?.state === 'owned_elsewhere',
      warmUntil: typeof warmUntil === 'string' ? warmUntil : null,
      reused: run.reused === true || payload?.reused === true,
      quota: quota && typeof quota === 'object' ? quota : null,
      gate,
    },
  };
}

function isoTime(value, fallback = null) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  const epoch = Number(value);
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : fallback;
}

function accountSnapshotFrom(payload, { signedIn = true, reason = null } = {}) {
  const updatedAt = new Date().toISOString();
  if (!signedIn) {
    return { signedIn: false, account: null, quota: null, raucloud: { kind: 'logged-out' }, updatedAt };
  }
  const account = payload?.account && typeof payload.account === 'object' ? payload.account : null;
  const rawQuota = payload?.quota && typeof payload.quota === 'object' ? payload.quota : null;
  const activeRun = payload?.activeRun ?? payload?.run ?? null;
  const worker = payload?.worker && typeof payload.worker === 'object' ? payload.worker : null;
  const gate = payload?.gate && typeof payload.gate === 'object' ? payload.gate : null;
  const resetAt = isoTime(rawQuota?.resetsAt, updatedAt);
  const quota = rawQuota ? {
    dailyLimitMs: Math.max(0, Number(rawQuota.limitMs ?? rawQuota.dailyLimitMs) || 0),
    usedMs: Math.max(0, Number(rawQuota.usedMs) || 0),
    remainingMs: Math.max(0, Number(rawQuota.remainingMs) || 0),
    debtMs: Math.max(0, Number(rawQuota.debtMs ?? rawQuota.grace?.debtMs) || 0),
    graceUsedMs: Math.max(0, Number(rawQuota.graceUsedMs ?? rawQuota.grace?.usedMs) || 0),
    resetAt,
    timeZone: trimmed(rawQuota.timeZone ?? rawQuota.timezone ?? account?.timezone, 120) || 'UTC',
    activeRun: activeRun ? {
      runId: trimmed(activeRun.id ?? activeRun.runId, 128),
      deviceId: trimmed(activeRun.ownerDeviceId ?? activeRun.deviceId, 128),
      deviceName: trimmed(activeRun.ownerDeviceName ?? activeRun.deviceName, 120) || null,
      startedAt: isoTime(activeRun.allocatedAt ?? activeRun.startedAt ?? activeRun.createdAt, updatedAt),
      controllingThisDevice: gate?.state !== 'owned_elsewhere',
    } : null,
    coldStarts: {
      usedToday: Math.max(0, Number(rawQuota.coldStarts?.usedToday) || 0),
      dailyLimit: Math.max(0, Number(rawQuota.coldStarts?.dailyLimit) || 0),
      recent: Math.max(0, Number(rawQuota.coldStarts?.recent) || 0),
      recentLimit: Math.max(0, Number(rawQuota.coldStarts?.recentLimit) || 0),
    },
    graceEndsAt: isoTime(activeRun?.graceDeadlineAt, null),
  } : null;
  let raucloud;
  // `canStart: false` with a ready gate means this device already controls the
  // active run. It must stay interactive even though a second run is forbidden.
  if (gate?.state === 'ready') raucloud = { kind: 'available' };
  else if (gate?.state === 'quota_exhausted' || (quota && quota.remainingMs <= 0 && !activeRun)) {
    raucloud = { kind: 'exhausted', resetAt };
  } else if (gate?.state === 'owned_elsewhere') {
    raucloud = {
      kind: 'active-elsewhere',
      runId: trimmed(activeRun?.id ?? activeRun?.runId ?? worker?.runId, 128),
      deviceName: trimmed(activeRun?.ownerDeviceName ?? activeRun?.deviceName, 120) || null,
    };
  } else {
    raucloud = {
      kind: 'unavailable',
      reason: trimmed(reason ?? gate?.reason, 512) || 'Raucloud is unavailable',
    };
  }
  return {
    signedIn: true,
    account: account ? {
      id: trimmed(account.id, 160),
      email: trimmed(account.email, 320),
      displayName: trimmed(account.displayName, 160) || null,
    } : null,
    quota,
    raucloud,
    updatedAt,
  };
}

function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

const LEGACY_RAUCLOUD_ERROR_PREFIX = 'MANAGED_CLOUD_'; // raucloud-legacy: normalize responses from an older broker.

function stableErrorCode(status, payload) {
  const supplied = trimmed(
    typeof payload?.error === 'string' ? payload.error : payload?.error?.code ?? payload?.code,
    96,
  ).toUpperCase();
  if (supplied.startsWith(LEGACY_RAUCLOUD_ERROR_PREFIX)) {
    return `RAUCLOUD_${supplied.slice(LEGACY_RAUCLOUD_ERROR_PREFIX.length)}`;
  }
  if (supplied) return supplied;
  if (status === 401) return 'RAUCLOUD_AUTH_REQUIRED';
  if (status === 403) return 'RAUCLOUD_FORBIDDEN';
  if (status === 409) return 'RAUCLOUD_TAKEOVER_REQUIRED';
  if (status === 402 || status === 429) return 'RAUCLOUD_QUOTA_EXHAUSTED';
  if (status >= 500) return 'RAUCLOUD_UNAVAILABLE';
  return 'RAUCLOUD_REQUEST_FAILED';
}

async function responsePayload(response, signal) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new AppServerError('Raucloud response is too large', {
      code: 'RAUCLOUD_RESPONSE_INVALID', retryable: false,
    });
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => void reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new AppServerError('Raucloud response is too large', {
          code: 'RAUCLOUD_RESPONSE_INVALID', retryable: false,
        });
      }
      chunks.push(chunk);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch {}
  }
  const text = Buffer.concat(chunks, size).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    throw new AppServerError('Raucloud returned invalid JSON', {
      code: 'RAUCLOUD_RESPONSE_INVALID', retryable: false,
    });
  }
}

function publicError(error, fallback = 'Raucloud is unavailable') {
  if (error instanceof AppServerError) return error;
  if (error?.name === 'AbortError') return error;
  return new AppServerError(fallback, {
    code: 'RAUCLOUD_UNAVAILABLE', retryable: true, cause: error,
  });
}

export function createRaucloudBrokerClient({
  baseUrl = raucloudBrokerUrl(),
  getAccessToken,
  getDeviceIdentity,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  setupRequestTimeoutMs = SETUP_REQUEST_TIMEOUT_MS,
  sleep = (ms, options) => delay(ms, undefined, options),
} = {}) {
  const normalizedBaseUrl = brokerBaseUrl(baseUrl);
  if (typeof getAccessToken !== 'function') throw new Error('Raucloud broker requires account token access');
  if (typeof getDeviceIdentity !== 'function') throw new Error('Raucloud broker requires a device identity');
  if (typeof fetchImpl !== 'function') throw new Error('Raucloud broker requires fetch');

  async function accountToken() {
    const token = trimmed(await getAccessToken(), 8192);
    if (!ACCESS_TOKEN_RE.test(token)) {
      throw new AppServerError('Sign in to Rauhwpx to use Raucloud', {
        code: 'RAUCLOUD_AUTH_REQUIRED', retryable: false,
      });
    }
    return token;
  }

  async function request(pathname, {
    method = 'GET', body = null, query = null, signal = null, idempotencyKey = null,
    timeoutMs = requestTimeoutMs,
  } = {}) {
    const token = await accountToken();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new DOMException('Raucloud request timed out', 'AbortError')),
      Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
    );
    try {
      const headers = {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      };
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
      const response = await fetchImpl(endpoint(normalizedBaseUrl, pathname, query), {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      });
      const payload = await responsePayload(response, controller.signal);
      if (!response.ok) {
        const message = trimmed(payload?.error?.message ?? payload?.message, 1024)
          || (response.status === 401
            ? 'Sign in to Rauhwpx to use Raucloud'
            : 'Raucloud could not complete the request');
        const error = new AppServerError(message, {
          code: stableErrorCode(response.status, payload),
          retryable: retryableStatus(response.status),
        });
        error.status = response.status;
        error.details = payload?.error?.details ?? payload?.details ?? null;
        error.retryAfter = response.headers?.get?.('retry-after') ?? null;
        throw error;
      }
      return payload;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (controller.signal.aborted) {
        throw new AppServerError('Raucloud took too long to respond', {
          code: 'RAUCLOUD_TIMEOUT', retryable: true, cause: error,
        });
      }
      throw publicError(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function device(deviceName = '') {
    const identity = await getDeviceIdentity();
    const id = trimmed(identity?.id ?? identity?.deviceId, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(id)) {
      throw new AppServerError('Raucloud device identity is unavailable', {
        code: 'RAUCLOUD_DEVICE_INVALID', retryable: false,
      });
    }
    return { id, name: trimmed(deviceName || identity?.name, 120) || 'Rauhwpx desktop' };
  }

  return {
    baseUrl: normalizedBaseUrl,
    async status({ runId: id = null, signal = null } = {}) {
      const currentDevice = await device();
      return request('/v1/cloud/status', {
        query: { deviceId: currentDevice.id, ...(id ? { runId: id } : {}) },
        signal,
      });
    },
    async createRun({ deviceName, provider = 'codex', signal = null, idempotencyKey = randomUUID() } = {}) {
      const currentDevice = await device(deviceName);
      return request('/v1/cloud/runs', {
        method: 'POST', signal, idempotencyKey, timeoutMs: setupRequestTimeoutMs,
        body: {
          deviceId: currentDevice.id,
          deviceName: currentDevice.name,
          provider,
        },
      });
    },
    async takeoverRun(id, {
      deviceName, checkpointId, signal = null, idempotencyKey = randomUUID(),
    } = {}) {
      const safeId = encodeURIComponent(trimmed(id, 128));
      if (!safeId) throw new AppServerError('Raucloud run id is invalid', { code: 'RAUCLOUD_RUN_INVALID', retryable: false });
      const currentDevice = await device(deviceName);
      return request(`/v1/cloud/runs/${safeId}/takeover`, {
        method: 'POST', signal, idempotencyKey, timeoutMs: setupRequestTimeoutMs,
        body: {
          deviceId: currentDevice.id,
          checkpointId: trimmed(checkpointId, 160),
        },
      });
    },
    async forceQuitAccount({
      signal = null, reason = 'force-quit', idempotencyKey = randomUUID(),
    } = {}) {
      return request('/v1/cloud/force-quit', {
        method: 'POST', signal, idempotencyKey,
        body: {
          deviceId: (await device()).id,
          reason,
        },
      });
    },
    async stopRun(id, {
      signal = null, reason = 'user-request', finishCurrentTurn = false, checkpoint = true,
      idempotencyKey = randomUUID(),
    } = {}) {
      const safeId = encodeURIComponent(trimmed(id, 128));
      if (!safeId) throw new AppServerError('Raucloud run id is invalid', { code: 'RAUCLOUD_RUN_INVALID', retryable: false });
      return request(`/v1/cloud/runs/${safeId}/stop`, {
        method: 'POST', signal, idempotencyKey,
        body: {
          deviceId: (await device()).id,
          reason,
          finishCurrentTurn,
          checkpoint,
        },
      });
    },
    // Exposed for deterministic retry tests without delaying the suite.
    sleep,
  };
}

export function createRaucloudBrokerProvider(options = {}) {
  const client = options.client ?? createRaucloudBrokerClient(options);
  const allocationPollMs = Math.max(10, Math.min(10_000, Number(options.allocationPollMs) || 2_500));
  const defaultAllocationAttempts = Math.ceil(RAUCLOUD_SETUP_TIMEOUT_MS / allocationPollMs);
  const allocationAttempts = Math.max(
    1,
    Math.min(180_000, Math.trunc(Number(options.allocationAttempts)) || defaultAllocationAttempts),
  );
  return {
    id: RAUCLOUD_PROVIDER_ID,
    displayName: 'Raucloud',
    configuration() {
      return { configured: true, missing: [], brokerUrl: client.baseUrl, accountRequired: true };
    },
    async spawn({
      deviceName = 'Rauhwpx desktop', selectedProvider = 'codex', signal,
      onLine = () => {}, onSandboxCreated = async () => {}, onSandboxRemoved = async () => {},
    } = {}) {
      onLine('Checking account and daily Cloud allowance');
      let payload;
      try {
        payload = await client.createRun({ deviceName, provider: selectedProvider, signal });
      } catch (error) {
        if (error?.code !== 'RAUCLOUD_TIMEOUT' && error?.code !== 'CLOUD_RUN_ALREADY_ACTIVE') throw error;
        const recovered = await client.status({ signal }).catch(() => {
          throw error;
        });
        if (!runId(recovered) || !['provisioning', 'ready'].includes(normalizedStatus(recovered, 'idle').lifecycle)) {
          throw error;
        }
        payload = recovered;
        onLine('Reconnecting to the Cloud worker already being prepared');
      }
      const id = runId(payload);
      if (!id) throw new AppServerError('Raucloud returned no run id', {
        code: 'RAUCLOUD_RESPONSE_INVALID', retryable: false,
      });
      let receipt = receiptFrom(payload);
      let state = normalizedStatus(payload, 'provisioning');
      const createdAt = runEnvelope(payload).createdAt;
      const sandbox = {
        providerId: RAUCLOUD_PROVIDER_ID,
        sandboxId: id,
        projectId: '',
        environmentId: '',
        domainId: '',
        region: trimmed(runEnvelope(payload).region, 128),
        host: receipt ? new URL(receipt.endpoint).hostname : '',
        createdAt: typeof createdAt === 'string'
          ? createdAt
          : Number.isFinite(Number(createdAt)) ? new Date(Number(createdAt)).toISOString() : new Date().toISOString(),
      };
      await onSandboxCreated(sandbox);
      try {
        onLine(state.raucloud.reused ? 'Reconnecting to your warm Cloud worker' : 'Preparing your private Cloud worker');
        for (let attempt = 0; !receipt && attempt < allocationAttempts; attempt += 1) {
          await client.sleep(allocationPollMs, { signal });
          payload = await client.status({ runId: id, signal });
          state = normalizedStatus(payload, 'provisioning');
          receipt = receiptFrom(payload);
          if (state.lifecycle === 'error' || ['failed', 'stopped', 'expired'].includes(state.status)) {
            throw new AppServerError(state.message ?? 'Raucloud worker could not be prepared', {
              code: 'RAUCLOUD_ALLOCATION_FAILED', retryable: true,
            });
          }
          if (!receipt && attempt === 0) onLine('Allocating secure worker capacity');
        }
        if (!receipt) {
          throw new AppServerError('Raucloud worker preparation timed out', {
            code: 'RAUCLOUD_ALLOCATION_TIMEOUT', retryable: true,
          });
        }
        sandbox.host = new URL(receipt.endpoint).hostname;
        return {
          sandbox,
          receipt,
          raucloud: state.raucloud,
          account: accountSnapshotFrom(payload),
        };
      } catch (error) {
        await client.stopRun(id, {
          reason: signal?.aborted ? 'allocation-cancelled' : 'allocation-failed',
          checkpoint: false,
        }).then(onSandboxRemoved, () => {});
        throw error;
      }
    },
    async status(sandbox, { signal = null } = {}) {
      const payload = await client.status({ runId: sandbox?.sandboxId, signal });
      return { ...normalizedStatus(payload), account: accountSnapshotFrom(payload) };
    },
    async accountStatus({ signal = null } = {}) {
      try {
        return accountSnapshotFrom(await client.status({ signal }));
      } catch (error) {
        if (error?.code === 'RAUCLOUD_AUTH_REQUIRED' || error?.status === 401) {
          return accountSnapshotFrom(null, { signedIn: false });
        }
        return accountSnapshotFrom(null, {
          signedIn: true,
          reason: error?.message ?? 'Raucloud status could not be loaded',
        });
      }
    },
    async takeover(sandbox, { deviceName = 'Rauhwpx desktop', signal = null } = {}) {
      const status = await client.status({ runId: sandbox?.sandboxId, signal });
      const source = status?.run ?? status?.takeoverRun ?? status?.activeRun ?? runEnvelope(status);
      const checkpointId = trimmed(source?.checkpointId, 160);
      const sourceRunId = trimmed(source?.id ?? source?.runId ?? sandbox?.sandboxId, 160);
      if (!checkpointId || !sourceRunId) {
        throw new AppServerError('The other device must finish its checkpoint before takeover.', {
          code: 'CLOUD_TAKEOVER_NOT_READY', retryable: true,
        });
      }
      const payload = await client.takeoverRun(sourceRunId, {
        deviceName, checkpointId, signal,
      });
      const receipt = receiptFrom(payload);
      if (!receipt) {
        throw new AppServerError('Raucloud takeover returned no pairing receipt', {
          code: 'RAUCLOUD_RESPONSE_INVALID', retryable: false,
        });
      }
      return {
        sandbox: {
          providerId: RAUCLOUD_PROVIDER_ID,
          sandboxId: runId(payload),
          projectId: '',
          environmentId: '',
          domainId: '',
          region: trimmed(runEnvelope(payload).region, 128),
          host: new URL(receipt.endpoint).hostname,
          createdAt: new Date().toISOString(),
        },
        receipt,
        raucloud: normalizedStatus(payload).raucloud,
        account: accountSnapshotFrom(payload),
      };
    },
    async forceQuitAccount({ signal = null } = {}) {
      const payload = await client.forceQuitAccount({ signal, reason: 'force-quit' });
      return { ...normalizedStatus(payload, 'idle'), account: accountSnapshotFrom(payload) };
    },
    async teardown(sandbox, { signal = null } = {}) {
      const payload = await client.stopRun(sandbox?.sandboxId, {
        signal, reason: 'user-request', finishCurrentTurn: false, checkpoint: true,
      });
      const state = normalizedStatus(payload, 'idle');
      return {
        removed: ['idle', 'stopped', 'deleted', 'released'].includes(state.status),
        ...state,
        account: accountSnapshotFrom(payload),
      };
    },
    async logout(sandbox, { signal = null } = {}) {
      const payload = await client.stopRun(sandbox?.sandboxId, {
        signal, reason: 'logout', finishCurrentTurn: true, checkpoint: true,
      });
      return { ...normalizedStatus(payload, 'stopping'), account: accountSnapshotFrom(payload) };
    },
  };
}

export const __test = Object.freeze({ accountSnapshotFrom, normalizedStatus, receiptFrom, runId, stableErrorCode });

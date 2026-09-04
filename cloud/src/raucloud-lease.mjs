const MAX_RESPONSE_BYTES = 1024 * 1024;
const BLOCKED_COMMANDS = new Set(['message.queue', 'session.resume', 'turn.redirect', 'session.takeover']);

function raucloudError(code, message, cause, status = 503) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.status = status;
  return error;
}

async function jsonBody(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) throw raucloudError('RAUCLOUD_BROKER_INVALID', 'Raucloud broker response is too large');
  try { return bytes.length ? JSON.parse(bytes.toString('utf8')) : {}; } catch (error) {
    throw raucloudError('RAUCLOUD_BROKER_INVALID', 'Raucloud broker returned invalid JSON', error);
  }
}

export class RaucloudLeaseController {
  constructor({ baseUrl = '', runId = '', workerToken = '', fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.runId = String(runId);
    this.workerToken = String(workerToken);
    this.fetch = fetchImpl;
    this.enabled = Boolean(this.baseUrl && this.runId && this.workerToken);
    this.active = false;
    this.terminal = false;
    this.inputBlocked = false;
    this.mustStop = false;
    this.latestCheckpointId = null;
    this.allocation = null;
    this.heartbeatRequest = null;
    this.failures = 0;
    this.graceTimer = null;
  }

  async #fetch(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.workerToken}`, 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw raucloudError('RAUCLOUD_BROKER_UNREACHABLE', 'Raucloud broker is unreachable', error);
    }
    const payload = await jsonBody(response);
    if (!response.ok) {
      throw raucloudError(
        typeof payload.error === 'string' ? payload.error : payload.error?.code ?? 'RAUCLOUD_BROKER_REJECTED',
        payload.message ?? payload.error?.message ?? 'Raucloud broker rejected the worker',
        undefined,
        response.status,
      );
    }
    const graceActive = payload.quota?.grace?.active === true;
    if (payload.run?.inputBlocked === true || Number(payload.quota?.remainingMs) <= 0 || graceActive) {
      this.inputBlocked = true;
    }
    if (payload.mustStop === true) {
      this.mustStop = true;
      this.inputBlocked = true;
    }
    const rawDeadline = payload.run?.graceDeadlineAt;
    const graceDeadline = Number.isFinite(Number(rawDeadline))
      ? Number(rawDeadline)
      : Date.parse(rawDeadline ?? '');
    if (graceActive && Number.isFinite(graceDeadline)) this.#armGraceDeadline(graceDeadline);
    return payload;
  }

  #armGraceDeadline(deadline) {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.mustStop = true;
      this.inputBlocked = true;
    }, Math.max(0, deadline - Date.now()));
    this.graceTimer.unref?.();
  }

  #finish() {
    this.active = false;
    this.terminal = true;
    this.inputBlocked = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  #request(action, body = {}) {
    return this.#fetch(`/v1/internal/cloud/runs/${encodeURIComponent(this.runId)}/${action}`, {
      method: 'POST',
      body,
    });
  }

  async discover() {
    if (!this.enabled) return { raucloud: false };
    const payload = await this.#fetch('/v1/internal/cloud/lease');
    const nextRunId = String(payload.runId ?? payload.run?.id ?? '').trim();
    if (!nextRunId) throw raucloudError('RAUCLOUD_BROKER_INVALID', 'Raucloud broker did not identify the current lease');
    if (nextRunId !== this.runId) {
      this.runId = nextRunId;
      this.terminal = false;
      this.inputBlocked = payload.inputBlocked === true;
      this.mustStop = false;
      this.latestCheckpointId = null;
      this.allocation = null;
      this.failures = 0;
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = null;
    } else if (payload.inputBlocked === true) {
      this.inputBlocked = true;
    }
    this.active = payload.status === 'active';
    if (this.active && !this.allocation) this.allocation = Promise.resolve(payload);
    return payload;
  }

  async assertCommandAllowed(type) {
    if (!this.enabled || !BLOCKED_COMMANDS.has(type)) return;
    await this.discover();
    if (this.inputBlocked) {
      throw raucloudError('RAUCLOUD_INPUT_BLOCKED', 'Raucloud is finishing the current turn; new input is blocked', undefined, 409);
    }
  }

  async beforeTurnStart() {
    if (!this.enabled) return Promise.resolve({ raucloud: false });
    await this.discover();
    if (this.terminal || this.inputBlocked) {
      throw raucloudError('RAUCLOUD_INPUT_BLOCKED', 'Raucloud cannot start another turn', undefined, 409);
    }
    if (!this.allocation) {
      this.allocation = this.#request('allocation').then((payload) => {
        this.active = true;
        this.failures = 0;
        return payload;
      }, (error) => {
        this.inputBlocked = true;
        throw error;
      });
    }
    return this.allocation;
  }

  heartbeat() {
    if (!this.enabled || !this.active || this.terminal) return Promise.resolve({ mustStop: this.mustStop });
    if (this.mustStop) return Promise.resolve({ mustStop: true });
    if (this.heartbeatRequest) return this.heartbeatRequest;
    this.heartbeatRequest = this.#request('heartbeat').then((payload) => {
      this.failures = 0;
      return payload;
    }, (error) => {
      this.failures += 1;
      if (this.failures >= 3) {
        this.inputBlocked = true;
        this.mustStop = true;
        return { mustStop: true, degraded: true };
      }
      throw error;
    }).finally(() => { this.heartbeatRequest = null; });
    return this.heartbeatRequest;
  }

  rememberCheckpoint(checkpointId) {
    const value = String(checkpointId ?? '').trim();
    if (value) this.latestCheckpointId = value;
  }

  async checkpoint(checkpointId = this.latestCheckpointId) {
    if (!this.enabled || !this.active || this.terminal || !checkpointId) return { raucloud: this.enabled, skipped: true };
    const payload = await this.#request('checkpoint', { checkpointId });
    this.#finish();
    return payload;
  }

  async complete(checkpointId = this.latestCheckpointId) {
    if (!this.enabled || !this.active || this.terminal) return { raucloud: this.enabled, skipped: true };
    const payload = await this.#request('complete', { ...(checkpointId ? { checkpointId } : {}) });
    const reusable = ['ready', 'warm'].includes(payload.run?.status) || payload.worker?.status === 'warm';
    if (reusable && !this.inputBlocked && payload.mustStop !== true && payload.run?.inputBlocked !== true) {
      this.active = false;
      this.terminal = false;
      this.inputBlocked = false;
      this.allocation = null;
      this.latestCheckpointId = null;
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = null;
    } else {
      this.#finish();
    }
    return payload;
  }

  async release(failureCode = 'WORKER_RELEASED') {
    if (!this.enabled) return { raucloud: false, skipped: true };
    if (this.terminal || !this.active) {
      try { await this.discover(); } catch {
        return { raucloud: true, skipped: true };
      }
    }
    if (this.terminal) return { raucloud: true, skipped: true };
    const payload = await this.#request('release', { failureCode });
    this.#finish();
    return payload;
  }
}

export function raucloudLeaseFromConfig(config, options = {}) {
  return new RaucloudLeaseController({
    baseUrl: config.raucloudBrokerUrl,
    runId: config.raucloudRunId,
    workerToken: config.raucloudWorkerToken,
    ...options,
  });
}

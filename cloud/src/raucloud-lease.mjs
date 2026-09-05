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
  constructor({ baseUrl = '', runId = '', workerToken = '', fetchImpl = globalThis.fetch,
    now = Date.now, brokerGraceMs = 90_000, reportStore = null } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.runId = String(runId);
    this.workerToken = String(workerToken);
    this.fetch = fetchImpl;
    this.now = now;
    this.brokerGraceMs = brokerGraceMs;
    this.lastBrokerSuccessAt = now();
    this.lastDiscoveryAt = null;
    this.discoveryRequest = null;
    this.activityAt = null;
    this.reportedActivityAt = null;
    this.reportStore = reportStore;
    this.pendingCompletion = reportStore?.load?.() ?? null;
    this.completionRequest = null;
    this.enabled = Boolean(this.baseUrl && this.runId && this.workerToken);
    this.active = false;
    this.terminal = false;
    this.inputBlocked = false;
    this.mustStop = false;
    this.latestCheckpointId = null;
    this.allocation = null;
    this.heartbeatRequest = null;
    this.failures = 0;
    this.brokerFailureSince = null;
    this.graceTimer = null;
  }

  async #fetch(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.workerToken}`, 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
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
    this.lastBrokerSuccessAt = this.now();
    this.failures = 0;
    this.brokerFailureSince = null;
    const graceActive = payload.quota?.grace?.active === true;
    if (payload.run?.inputBlocked === true
      || payload.quota?.remainingMs != null && Number(payload.quota.remainingMs) <= 0 || graceActive) {
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
    }, Math.max(0, deadline - this.now()));
    this.graceTimer.unref?.();
  }

  #finish() {
    this.active = false;
    this.terminal = true;
    this.inputBlocked = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.lastDiscoveryAt = null;
  }

  #request(action, body = {}) {
    return this.#fetch(`/v1/internal/cloud/runs/${encodeURIComponent(this.runId)}/${action}`, {
      method: 'POST',
      body,
    });
  }

  async discover() {
    if (!this.enabled) return { raucloud: false };
    if (this.discoveryRequest) return this.discoveryRequest;
    this.discoveryRequest = this.#discover().finally(() => { this.discoveryRequest = null; });
    return this.discoveryRequest;
  }

  async #discover() {
    const payload = await this.#fetch('/v1/internal/cloud/lease');
    this.lastDiscoveryAt = this.now();
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
    if (this.lastDiscoveryAt === null || this.now() - this.lastDiscoveryAt >= 15_000) {
      try { await this.discover(); } catch (error) {
        if (!this.#transient(error) || this.now() - this.lastBrokerSuccessAt >= this.brokerGraceMs) throw error;
      }
    }
    if (this.inputBlocked) {
      throw raucloudError('RAUCLOUD_INPUT_BLOCKED', 'Raucloud is finishing the current turn; new input is blocked', undefined, 409);
    }
  }

  async beforeTurnStart() {
    if (!this.enabled) return Promise.resolve({ raucloud: false });
    await this.#flushCompletion();
    if (this.lastDiscoveryAt === null || this.now() - this.lastDiscoveryAt >= 15_000) await this.discover();
    if (this.terminal || this.inputBlocked) {
      throw raucloudError('RAUCLOUD_INPUT_BLOCKED', 'Raucloud cannot start another turn', undefined, 409);
    }
    if (!this.allocation) {
      this.allocation = this.#request('allocation').then((payload) => {
        this.active = true;
        this.failures = 0;
        return payload;
      }, (error) => {
        this.allocation = null;
        if (!this.#transient(error)) this.inputBlocked = true;
        throw error;
      });
    }
    return this.allocation;
  }

  noteActivity() {
    if (this.enabled && !this.terminal && !this.mustStop) this.activityAt = this.now();
  }

  status() {
    if (this.enabled && this.brokerFailureSince !== null
      && this.now() - this.brokerFailureSince >= this.brokerGraceMs) {
      this.mustStop = true;
      this.inputBlocked = true;
    }
    return { mustStop: this.mustStop, degraded: this.failures > 0 };
  }

  #transient(error) {
    return error.code === 'RAUCLOUD_BROKER_UNREACHABLE' || error.status === 408
      || error.status === 429 || error.status >= 500;
  }

  heartbeat() {
    this.status();
    if (!this.enabled || this.terminal) return Promise.resolve({ mustStop: this.mustStop });
    if (this.mustStop) return Promise.resolve({ mustStop: true });
    if (this.heartbeatRequest) return this.heartbeatRequest;
    this.heartbeatRequest = (async () => {
      await this.#flushCompletion();
      if (this.active) return this.#request('heartbeat');
      const activityAt = this.activityAt;
      if (activityAt !== null && activityAt !== this.reportedActivityAt) {
        const payload = await this.#request('activity');
        this.reportedActivityAt = activityAt;
        return payload;
      }
      return { mustStop: this.mustStop };
    })().then((payload) => {
      this.failures = 0;
      this.brokerFailureSince = null;
      return payload;
    }, (error) => {
      this.failures += 1;
      this.brokerFailureSince ??= this.now();
      if (!this.#transient(error) || this.now() - this.brokerFailureSince >= this.brokerGraceMs) {
        this.inputBlocked = true;
        this.mustStop = true;
        return { mustStop: true, degraded: true };
      }
      return { mustStop: false, degraded: true };
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

  queueCompletion(checkpointId = this.latestCheckpointId) {
    if (!this.enabled || !this.active || this.terminal) return false;
    const pending = { runId: this.runId, checkpointId };
    this.reportStore?.save?.(pending);
    this.pendingCompletion = pending;
    return true;
  }

  async complete(checkpointId = this.latestCheckpointId) {
    if (!this.queueCompletion(checkpointId)) return { raucloud: this.enabled, skipped: true };
    try { return await this.#flushCompletion(); } catch (error) {
      if (!this.#transient(error)) throw error;
      this.failures += 1;
      return { pending: true, degraded: true };
    }
  }

  async #flushCompletion() {
    if (this.completionRequest) return this.completionRequest;
    this.completionRequest = this.#sendCompletion().finally(() => { this.completionRequest = null; });
    return this.completionRequest;
  }

  async #sendCompletion() {
    const pending = this.pendingCompletion;
    if (!pending) return { skipped: true };
    const payload = await this.#fetch(`/v1/internal/cloud/runs/${encodeURIComponent(pending.runId)}/complete`, {
      method: 'POST', body: { ...(pending.checkpointId ? { checkpointId: pending.checkpointId } : {}) },
    });
    this.reportStore?.clear?.();
    this.pendingCompletion = null;
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

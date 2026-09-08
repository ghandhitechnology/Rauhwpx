import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MERGE_CHUNK_BYTES = 512 * 1024;
const MAX_MERGE_BYTES = 128 * 1024 * 1024;
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
    now = Date.now, brokerGraceMs = 10 * 60_000, reportStore = null } = {}) {
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
    this.quotaDeadlineAt = null;
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
    if (payload.run?.status === 'active' && Number.isFinite(payload.quota?.remainingMs)
      && Number.isFinite(payload.quota?.grace?.remainingMs)) {
      // The last metered allowance bounds offline execution even when the
      // broker cannot deliver its next quota response.
      this.quotaDeadlineAt = this.now() + Math.max(0, payload.quota.remainingMs)
        + Math.max(0, payload.quota.grace.remainingMs);
      this.#armGraceDeadline(this.quotaDeadlineAt);
    }
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

  async #archiveRequest(path, body) {
    const started = this.now();
    for (;;) {
      try { return await this.#fetch(path, { method: 'POST', body }); }
      catch (error) {
        if (!this.#transient(error) || this.now() - started >= this.brokerGraceMs) throw error;
        this.failures += 1;
        this.brokerFailureSince ??= this.now();
        await delay(1_000);
      }
    }
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
      this.mustStop = payload.mustStop === true;
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
    if (this.active && this.quotaDeadlineAt !== null && this.now() >= this.quotaDeadlineAt) {
      this.mustStop = true;
      this.inputBlocked = true;
    }
    if (this.enabled && this.brokerFailureSince !== null
      && this.now() - this.brokerFailureSince >= this.brokerGraceMs) {
      this.mustStop = true;
      this.inputBlocked = true;
    }
    return { mustStop: this.mustStop, degraded: this.failures > 0 };
  }

  #transient(error) {
    if (['CLOUD_MERGE_CAPACITY', 'CLOUD_QUOTA_EXHAUSTED'].includes(error.code)) return false;
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

  archiveMergeRequest(metadata, stream) {
    return this.archiveArtifact(metadata, stream, 'merge-requests');
  }

  archiveConversation(metadata, stream) {
    return this.archiveArtifact(metadata, stream, 'conversations');
  }

  async downloadConversation(sessionId) {
    const listing = await this.#fetch(`/v1/internal/cloud/conversations?sessionId=${encodeURIComponent(sessionId)}`);
    const record = listing.conversations?.find((item) => item.sessionId === sessionId);
    if (!record || record.state === 'purged') throw raucloudError('CONVERSATION_SNAPSHOT_NOT_FOUND', 'Saved cloud conversation was not found', undefined, 404);
    return { record, bytes: await this.downloadConversationArtifact(record) };
  }

  async downloadConversationArtifact(record, resource = false) {
    if (!Number.isSafeInteger(record.size) || record.size < 1 || record.size > MAX_MERGE_BYTES
      || !/^merge_[a-f0-9]{64}$/.test(record.id) || !/^[a-f0-9]{64}$/.test(record.sha256)
      || record.chunkCount !== Math.ceil(record.size / MERGE_CHUNK_BYTES)) {
      throw raucloudError('RAUCLOUD_BROKER_INVALID', 'Saved conversation size is invalid');
    }
    const chunks = [];
    let total = 0;
    for (let index = 0; index < record.chunkCount; index++) {
      const chunk = await this.#fetch(`/v1/internal/cloud/${resource ? 'conversation-resources' : 'conversations'}/${encodeURIComponent(record.id)}/chunks/${index}`);
      const bytes = Buffer.from(chunk.bytesBase64 ?? '', 'base64');
      total += bytes.length;
      if (total > record.size || bytes.length > MERGE_CHUNK_BYTES) throw raucloudError('RAUCLOUD_BROKER_INVALID', 'Saved conversation chunk is invalid');
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== record.size || createHash('sha256').update(bytes).digest('hex') !== record.sha256) {
      throw raucloudError('RAUCLOUD_BROKER_INVALID', 'Saved conversation failed integrity verification');
    }
    return bytes;
  }

  async archiveArtifact(metadata, stream, collection) {
    if (!this.enabled) return { raucloud: false, skipped: true };
    const { size, sha256 } = metadata;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MERGE_BYTES
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      stream.destroy();
      throw raucloudError('RAUCLOUD_ARTIFACT_INVALID', 'Cloud document size or digest is invalid', undefined, 400);
    }
    // A warm worker can discover another lease while an upload is in flight.
    // Keep every chunk scoped to the lease that accepted this boundary.
    const runId = this.runId;
    const chunkCount = Math.ceil(size / MERGE_CHUNK_BYTES);
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(MERGE_CHUNK_BYTES);
    let buffered = 0;
    let total = 0;
    let chunkIndex = 0;
    const send = () => this.#archiveRequest(`/v1/internal/cloud/runs/${encodeURIComponent(runId)}/${collection}`,
      { ...metadata, chunkIndex, chunkCount, bytesBase64: buffer.subarray(0, buffered).toString('base64') });
    for await (const bytes of stream) {
      total += bytes.length;
      if (total > size) throw raucloudError('RAUCLOUD_ARTIFACT_INVALID', 'Cloud document exceeds its declared size', undefined, 400);
      digest.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const length = Math.min(buffer.length - buffered, bytes.length - offset);
        bytes.copy(buffer, buffered, offset, offset + length);
        buffered += length;
        offset += length;
        if (buffered === buffer.length && chunkIndex < chunkCount - 1) {
          await send();
          chunkIndex += 1;
          buffered = 0;
        }
      }
    }
    // Hold the final chunk until EOF and the local digest agree. A successful
    // final response is the broker's durable receipt, not merely an upload ack.
    if (total !== size || digest.digest('hex') !== sha256) {
      throw raucloudError('RAUCLOUD_ARTIFACT_INVALID', 'Cloud document failed integrity verification', undefined, 400);
    }
    const receipt = await send();
    if (receipt.complete !== true || !receipt.mergeRequest?.id
      || receipt.mergeRequest.sha256 !== sha256 || receipt.mergeRequest.size !== size
      || receipt.mergeRequest.operationId !== metadata.operationId) {
      throw raucloudError('RAUCLOUD_ARTIFACT_UNCONFIRMED', 'Cloud document storage was not confirmed');
    }
    return receipt;
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

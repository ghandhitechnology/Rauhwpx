import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CloudInputQueue } from './cloud-input-queue.mjs';

export const DISPLAY_FRAME_PROTOCOL = 'rauhwpx-frame-v1';
export const DISPLAY_INPUT_PROTOCOL = 'rauhwpx-input-v1';
export const MAX_DISPLAY_FRAME_BYTES = 512 * 1024;
export const MAX_DISPLAY_FPS = 12;
export const MAX_DISPLAY_INPUT_EVENTS_PER_SECOND = 60;

const DISPLAY_REASONS = new Set([
  'server-unsupported',
  'session-not-running',
  'stream-unavailable',
  'client-unsupported',
]);
const INTEGRITY_CODES = new Set([
  'CLOUD_RESPONSE_TOO_LARGE',
  'DISPLAY_CAPABILITY_INVALID',
  'DISPLAY_FRAME_INTEGRITY_FAILED',
  'DISPLAY_FRAME_METADATA_INVALID',
  'DISPLAY_INTEREST_INVALID',
  'SERVER_BODY_TAMPERED',
  'SERVER_IDENTITY_INVALID',
  'SERVER_IDENTITY_MISMATCH',
  'SERVER_PROOF_INVALID',
  'SERVER_PROOF_MISSING',
  'SSE_PAYLOAD_INVALID',
  'SSE_PROOF_INVALID',
]);
const TRANSIENT_CODES = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETDOWN',
  'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

function displayError(message, code, { status = 0, retryable = false } = {}) {
  return Object.assign(new Error(message), { code, status, retryable });
}

function unavailableFailure(capability) {
  return displayError(
    `Cloud display unavailable (${capability.reason}): ${capability.message}`,
    'DISPLAY_UNAVAILABLE',
  );
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function dimension(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 4096 ? value : null;
}

function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : null;
}

function canonicalIso(value) {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value ? null : value;
}

function expectedFramePath(sessionId, streamId, sequence) {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/display/frames/${encodeURIComponent(streamId)}/${sequence}`;
}

export function unavailableDisplay(sessionId, reason, message, retryable) {
  return Object.freeze({ kind: 'unavailable', sessionId, reason, message, retryable });
}

export function parseDisplayCapability(value, expectedSessionId) {
  const raw = record(value);
  const sessionId = identifier(raw?.sessionId);
  if (!raw || !sessionId || sessionId !== expectedSessionId) {
    throw displayError('Cloud display capability is invalid', 'DISPLAY_CAPABILITY_INVALID');
  }
  if (raw.kind === 'available') {
    const streamId = identifier(raw.streamId);
    const width = dimension(raw.width);
    const height = dimension(raw.height);
    if (raw.protocol !== DISPLAY_FRAME_PROTOCOL || !streamId || width === null || height === null
      || raw.reason !== undefined || raw.message !== undefined || raw.retryable !== undefined
      || raw.maxFrameBytes !== MAX_DISPLAY_FRAME_BYTES || raw.maxFps !== MAX_DISPLAY_FPS
      || raw.inputProtocol !== DISPLAY_INPUT_PROTOCOL
      || raw.maxInputEventsPerSecond !== MAX_DISPLAY_INPUT_EVENTS_PER_SECOND
      || raw.supportsClickCount !== undefined && typeof raw.supportsClickCount !== 'boolean'
      || raw.inputBatchSize !== undefined && raw.inputBatchSize !== 32) {
      throw displayError('Cloud display capability is invalid', 'DISPLAY_CAPABILITY_INVALID');
    }
    return Object.freeze({
      kind: 'available',
      protocol: DISPLAY_FRAME_PROTOCOL,
      sessionId,
      streamId,
      width,
      height,
      maxFrameBytes: MAX_DISPLAY_FRAME_BYTES,
      maxFps: MAX_DISPLAY_FPS,
      inputProtocol: DISPLAY_INPUT_PROTOCOL,
      maxInputEventsPerSecond: MAX_DISPLAY_INPUT_EVENTS_PER_SECOND,
      ...(raw.supportsClickCount === true ? { supportsClickCount: true } : {}),
      ...(raw.inputBatchSize === 32 ? { inputBatchSize: 32 } : {}),
    });
  }
  if (raw.kind !== 'unavailable' || raw.protocol !== undefined || raw.streamId !== undefined
    || raw.width !== undefined || raw.height !== undefined
    || raw.maxFrameBytes !== undefined || raw.maxFps !== undefined
    || raw.supportsClickCount !== undefined
    || raw.inputProtocol !== undefined || raw.maxInputEventsPerSecond !== undefined
    || !DISPLAY_REASONS.has(raw.reason)
    || typeof raw.message !== 'string' || !raw.message || typeof raw.retryable !== 'boolean') {
    throw displayError('Cloud display capability is invalid', 'DISPLAY_CAPABILITY_INVALID');
  }
  return unavailableDisplay(sessionId, raw.reason, raw.message, raw.retryable);
}

export function parseDisplayInterest(value, { streamId, active }) {
  const raw = record(value);
  const expiresAt = raw?.expiresAt === null ? null : canonicalIso(raw?.expiresAt);
  if (!raw || raw.streamId !== streamId || raw.interested !== active
    || raw.maxFps !== (active ? MAX_DISPLAY_FPS : 0)
    || (active ? !expiresAt : raw.expiresAt !== null)) {
    throw displayError('Cloud display interest response is invalid', 'DISPLAY_INTEREST_INVALID');
  }
  return Object.freeze({ streamId, interested: active, expiresAt, maxFps: raw.maxFps });
}

export function parseDisplayFrameMetadata(value, capability) {
  const raw = record(value);
  const sessionId = identifier(raw?.sessionId) ?? capability?.sessionId ?? null;
  const streamId = identifier(raw?.streamId);
  const sequence = positiveInteger(raw?.sequence);
  const capturedAt = canonicalIso(raw?.capturedAt);
  const width = dimension(raw?.width);
  const height = dimension(raw?.height);
  const byteLength = positiveInteger(raw?.byteLength, MAX_DISPLAY_FRAME_BYTES);
  const sha256 = typeof raw?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(raw.sha256) ? raw.sha256 : null;
  if (!raw || !sessionId || !streamId || sequence === null || !capturedAt || width === null || height === null
    || raw.mimeType !== 'image/jpeg' || byteLength === null || !sha256
    || capability.kind !== 'available'
    || sessionId !== capability.sessionId || streamId !== capability.streamId
    || width !== capability.width || height !== capability.height
    || raw.protocol !== undefined || raw.maxFrameBytes !== undefined || raw.maxFps !== undefined
    || raw.reason !== undefined || raw.retryable !== undefined
    || raw.framePath !== expectedFramePath(capability.sessionId, streamId, sequence)) {
    throw displayError('Cloud display frame metadata is invalid', 'DISPLAY_FRAME_METADATA_INVALID');
  }
  return Object.freeze({
    sessionId,
    streamId,
    sequence,
    capturedAt,
    width,
    height,
    mimeType: 'image/jpeg',
    byteLength,
    sha256,
    framePath: raw.framePath,
  });
}

export function parseDisplayFrameEnvelope(value, capability, verifiedSequence, eventName) {
  const raw = record(value);
  if (!raw || eventName !== 'display.frame' || raw.type !== 'display.frame'
    || raw.sessionId !== capability.sessionId || raw.seq !== verifiedSequence) {
    throw displayError('Cloud display event payload is invalid', 'SSE_PAYLOAD_INVALID');
  }
  const metadata = parseDisplayFrameMetadata(raw.payload, capability);
  if (metadata.sequence !== verifiedSequence) {
    throw displayError('Cloud display sequence does not match its proof', 'SSE_PROOF_INVALID');
  }
  return metadata;
}

export function isDisplayIntegrityFailure(error) {
  return INTEGRITY_CODES.has(String(error?.code ?? '').toUpperCase());
}

export function isTransientDisplayFailure(error) {
  if (isDisplayIntegrityFailure(error)) return false;
  const status = Number(error?.status);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase();
  return error?.retryable === true || TRANSIENT_CODES.has(code)
    || error?.name === 'TypeError' && /fetch failed|failed to fetch|networkerror|terminated|socket hang up/i.test(error.message);
}

function abortReason(signal) {
  return signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function relayAbort(source, target) {
  if (!source) return () => {};
  const abort = () => target.abort(source.reason);
  source.addEventListener('abort', abort, { once: true });
  if (source.aborted) abort();
  return () => source.removeEventListener('abort', abort);
}

class CloudDisplayConnectionImpl {
  #client;
  #sessionId;
  #viewerId = randomUUID();
  #listener;
  #controller = new AbortController();
  #removeExternalAbort = () => {};
  #capability = null;
  #loop = null;
  #closePromise = null;
  #closed = false;
  #activeInterestStream = null;
  #phase = null;
  #pending = null;
  #downloading = null;
  #lastSequence = 0;
  #inputSequence = 0;
  #inputQueue;
  #interestRenewMs;
  #retryBaseMs;
  #retryMaxMs;
  #maxReconnectAttempts;

  constructor(client, sessionId, listener, options = {}) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.#listener = typeof listener === 'function' ? listener : () => {};
    this.#interestRenewMs = Math.max(1, Number(options.interestRenewMs) || 12_000);
    this.#retryBaseMs = Math.max(0, Number(options.retryBaseMs) || 250);
    this.#retryMaxMs = Math.max(this.#retryBaseMs, Number(options.retryMaxMs) || 5_000);
    this.#maxReconnectAttempts = Math.max(1, Number(options.maxReconnectAttempts) || Infinity);
    this.#inputQueue = new CloudInputQueue(async (streamId, events) => {
      if (this.#closed || this.#controller.signal.aborted) throw abortReason(this.#controller.signal);
      if (this.#capability?.kind !== 'available' || this.#capability.streamId !== streamId) {
        throw displayError('Cloud display stream was replaced', 'DISPLAY_STREAM_REPLACED');
      }
      const signal = this.#phase?.controller.signal ?? this.#controller.signal;
      if (this.#capability.inputBatchSize && typeof this.#client.sendDisplayInputs === 'function') {
        const batch = events.map((event) => ({ sequence: ++this.#inputSequence, event }));
        await this.#client.sendDisplayInputs(this.#sessionId, streamId, this.#viewerId, batch, { signal });
      } else {
        await this.#client.sendDisplayInput(this.#sessionId, streamId, this.#viewerId,
          ++this.#inputSequence, events[0], { signal, timeoutMs: 3_000 });
      }
    }, () => this.#capability?.inputBatchSize && typeof this.#client.sendDisplayInputs === 'function' ? 32 : 1);
    this.#removeExternalAbort = relayAbort(options.signal, this.#controller);
  }

  get capability() {
    return this.#capability;
  }

  async start() {
    this.#emit({
      kind: 'connection', state: 'connecting', sessionId: this.#sessionId,
      streamId: null, retryable: true,
    });
    let attempt = 0;
    for (;;) {
      try {
        this.#capability = await this.#client.displayCapability(this.#sessionId, {
          signal: this.#controller.signal,
        });
        break;
      } catch (error) {
        if (this.#controller.signal.aborted) throw abortReason(this.#controller.signal);
        if (isDisplayIntegrityFailure(error) || !isTransientDisplayFailure(error)
          || ++attempt >= this.#maxReconnectAttempts) throw error;
        this.#emitReconnect(attempt, error, null);
        await this.#backoff(attempt);
      }
    }
    if (this.#capability.kind === 'unavailable') this.#emit(this.#capability);
    else this.#emitConnected(this.#capability);
    this.#loop = this.#run(this.#capability).finally(async () => {
      this.#loop = null;
      if (!this.#closed) await this.#releaseInterest();
    });
    return this;
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  sendInput(event) {
    const capability = this.#capability;
    if (this.#closed || !this.#phase || this.#phase.controller.signal.aborted || capability?.kind !== 'available') {
      return Promise.reject(displayError('Cloud display input is unavailable', 'DISPLAY_INPUT_UNAVAILABLE'));
    }
    // Existing workers use exact pointer fields and reject even clickCount: 1.
    if (capability.supportsClickCount !== true && event.kind === 'pointer' && 'clickCount' in event) {
      const { clickCount: _clickCount, ...legacyEvent } = event;
      return this.#inputQueue.enqueue(capability.streamId, legacyEvent);
    }
    return this.#inputQueue.enqueue(capability.streamId, event);
  }

  async #close() {
    this.#closed = true;
    this.#removeExternalAbort();
    this.#controller.abort();
    this.#phase?.controller.abort();
    this.#pending = null;
    await Promise.allSettled([this.#loop, this.#downloading, this.#inputQueue.close()].filter(Boolean));
    await this.#releaseInterest();
  }

  async #run(initialCapability) {
    let capability = initialCapability;
    let failures = 0;
    while (!this.#closed) {
      try {
        if (capability.kind === 'unavailable') {
          if (!capability.retryable) return;
          await this.#backoff(Math.max(1, failures + 1));
          const previous = capability;
          const next = await this.#client.displayCapability(this.#sessionId, {
            signal: this.#controller.signal,
          });
          if (next.kind === 'unavailable') {
            capability = next;
            this.#capability = next;
            this.#emit(next);
            failures += 1;
            if (failures >= this.#maxReconnectAttempts) {
              this.#emitFailure(unavailableFailure(next));
              return;
            }
            continue;
          }
          await this.#adoptAvailableCapability(previous, next);
          capability = next;
        }
        if (this.#activeInterestStream && this.#activeInterestStream !== capability.streamId) {
          await this.#releaseInterest();
        }
        if (this.#capability?.kind !== 'available' || this.#capability.streamId !== capability.streamId) {
          this.#capability = capability;
          this.#lastSequence = 0;
          this.#pending = null;
          this.#emitConnected(capability);
        }
        await this.#runStream(capability, () => { failures = 0; });
        throw displayError('Cloud display stream ended', 'DISPLAY_STREAM_ENDED', { retryable: true });
      } catch (error) {
        if (this.#closed || this.#controller.signal.aborted) return;
        if (isDisplayIntegrityFailure(error) || (!isTransientDisplayFailure(error)
          && error?.code !== 'DISPLAY_STREAM_NOT_FOUND')) {
          this.#emitFailure(error);
          return;
        }
        failures += 1;
        if (failures > this.#maxReconnectAttempts) {
          this.#emitFailure(error);
          return;
        }
        this.#emitReconnect(failures, error, capability.kind === 'available' ? capability.streamId : null);
        await this.#backoff(failures);
        try {
          const next = await this.#client.displayCapability(this.#sessionId, {
            signal: this.#controller.signal,
          });
          if (next.kind === 'available' && (capability.kind !== 'available' || next.streamId !== capability.streamId)) {
            await this.#adoptAvailableCapability(capability, next);
          } else if (next.kind === 'unavailable') {
            this.#capability = next;
            this.#emit(next);
          }
          capability = next;
        } catch (capabilityError) {
          if (isDisplayIntegrityFailure(capabilityError)) {
            this.#emitFailure(capabilityError);
            return;
          }
          capability = this.#capability;
        }
      }
    }
  }

  async #runStream(capability, markHealthy) {
    const controller = new AbortController();
    const removeAbort = relayAbort(this.#controller.signal, controller);
    let rejectFailure;
    const failure = new Promise((_, reject) => { rejectFailure = reject; });
    const phase = {
      capability,
      controller,
      failed: false,
      markHealthy,
      fail: (error, terminal = false) => {
        if (phase.failed || controller.signal.aborted) return;
        phase.failed = true;
        if (terminal) this.#pending = null;
        rejectFailure(error);
      },
    };
    this.#phase = phase;
    try {
      await this.#client.setDisplayInterest(this.#sessionId, capability.streamId, this.#viewerId, true, {
        signal: controller.signal,
      });
      this.#activeInterestStream = capability.streamId;
      const watch = this.#client.readDisplayFrames(this.#sessionId, capability, this.#lastSequence, {
        signal: controller.signal,
        onMetadata: (metadata) => this.#queueMetadata(metadata, phase),
        onFrame: (frame) => {
          if (this.#closed || this.#phase !== phase || frame.sessionId !== this.#sessionId
            || frame.streamId !== capability.streamId || frame.sequence <= this.#lastSequence) return;
          this.#lastSequence = frame.sequence;
          phase.markHealthy();
          this.#emit(frame);
        },
      });
      const renew = this.#renewInterest(capability, controller.signal);
      await Promise.race([watch, renew, failure]);
    } finally {
      controller.abort();
      this.#inputQueue.reset();
      removeAbort();
      if (this.#phase === phase) this.#phase = null;
      await this.#downloading?.catch(() => {});
    }
  }

  async #renewInterest(capability, signal) {
    for (;;) {
      await delay(this.#interestRenewMs, undefined, { signal });
      await this.#client.setDisplayInterest(
        this.#sessionId,
        capability.streamId,
        this.#viewerId,
        true,
        { signal },
      );
    }
  }

  #queueMetadata(metadata, phase) {
    if (this.#closed || phase.failed || this.#phase !== phase || metadata.sessionId !== this.#sessionId
      || metadata.streamId !== phase.capability.streamId || metadata.sequence <= this.#lastSequence) return;
    if (!this.#pending || metadata.sequence > this.#pending.sequence) this.#pending = metadata;
    if (!this.#downloading) this.#downloadNext(phase);
  }

  #downloadNext(phase) {
    const metadata = this.#pending;
    if (!metadata || this.#closed || phase.failed || this.#phase !== phase) return;
    this.#pending = null;
    const operation = this.#client.downloadDisplayFrame(metadata, { signal: phase.controller.signal })
      .then((frame) => {
        if (this.#closed || this.#phase !== phase
          || frame.sessionId !== this.#sessionId || frame.streamId !== phase.capability.streamId
          || frame.sequence <= this.#lastSequence) return;
        this.#lastSequence = frame.sequence;
        phase.markHealthy();
        this.#emit(frame);
      })
      .catch((error) => {
        if (this.#closed || phase.controller.signal.aborted) return;
        if (error?.code === 'DISPLAY_FRAME_NOT_FOUND') return;
        phase.fail(error, isDisplayIntegrityFailure(error));
      })
      .finally(() => {
        if (this.#downloading !== operation) return;
        this.#downloading = null;
        this.#downloadNext(phase);
      });
    this.#downloading = operation;
  }

  async #releaseInterest() {
    const streamId = this.#activeInterestStream;
    this.#activeInterestStream = null;
    if (!streamId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    timeout.unref?.();
    try {
      await this.#client.setDisplayInterest(this.#sessionId, streamId, this.#viewerId, false, {
        retryAttempts: 1,
        signal: controller.signal,
      });
    } catch {
      // The server TTL is the final cleanup fence when release cannot be delivered.
    } finally {
      clearTimeout(timeout);
    }
  }

  async #adoptAvailableCapability(previous, next) {
    if (previous.kind === 'available' && previous.streamId === next.streamId) {
      this.#capability = next;
      return;
    }
    if (this.#phase) this.#phase.failed = true;
    this.#pending = null;
    this.#phase?.controller.abort();
    await this.#downloading?.catch(() => {});
    await this.#releaseInterest();
    this.#lastSequence = 0;
    this.#capability = next;
    this.#emitConnected(next);
  }

  async #backoff(attempt) {
    const timeout = Math.min(this.#retryMaxMs, this.#retryBaseMs * (2 ** Math.min(attempt - 1, 8)));
    if (timeout === 0) return Promise.resolve();
    await delay(timeout, undefined, { signal: this.#controller.signal });
  }

  #emitConnected(capability) {
    this.#emit({
      kind: 'connection', state: 'connected', sessionId: this.#sessionId,
      streamId: capability.streamId, retryable: true, capability,
    });
  }

  #emitReconnect(attempt, error, streamId) {
    this.#emit({
      kind: 'connection', state: 'reconnecting', sessionId: this.#sessionId,
      streamId, retryable: true, attempt,
      message: String(error?.message ?? error),
    });
  }

  #emitFailure(error) {
    this.#emit({
      kind: 'connection', state: 'failed', sessionId: this.#sessionId,
      streamId: this.#capability?.kind === 'available' ? this.#capability.streamId : null,
      retryable: false,
      code: String(error?.code ?? 'DISPLAY_CONNECTION_FAILED'),
      message: String(error?.message ?? error),
    });
  }

  #emit(event) {
    if (this.#closed) return;
    try { this.#listener(event); } catch { /* Display listeners are isolated. */ }
  }
}

export async function openCloudDisplay(client, sessionId, listener, options = {}) {
  if (!identifier(sessionId)) throw displayError('Cloud display session id is invalid', 'INVALID_REQUEST');
  const connection = new CloudDisplayConnectionImpl(client, sessionId, listener, options);
  try {
    return await connection.start();
  } catch (error) {
    await connection.close();
    throw error;
  }
}

export const __test = {
  expectedFramePath,
  isDisplayIntegrityFailure,
  isTransientDisplayFailure,
};

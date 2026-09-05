import { CloudInputQueue } from '../../../../desktop/cloud-input-queue.mjs';
import type {
  CloudDisplayAvailableCapability,
  CloudDisplayCapability,
  CloudDisplayConnection,
  CloudDisplayEvent,
  CloudDisplayFrame,
  CloudDisplayFrameMetadata,
  CloudDisplayInputEvent,
} from './types.ts';

export interface CloudDisplayTransport {
  capability(sessionId: string, options: { signal: AbortSignal }): Promise<CloudDisplayCapability>;
  interest(
    sessionId: string,
    streamId: string,
    viewerId: string,
    active: boolean,
    options: { signal?: AbortSignal },
  ): Promise<void>;
  frames(
    sessionId: string,
    capability: CloudDisplayAvailableCapability,
    after: number,
    options: { signal: AbortSignal; onMetadata: (metadata: CloudDisplayFrameMetadata) => void; onFrame?: (frame: CloudDisplayFrame) => void },
  ): Promise<number>;
  frame(metadata: CloudDisplayFrameMetadata, options: { signal: AbortSignal }): Promise<CloudDisplayFrame>;
  inputs?(sessionId: string, streamId: string, viewerId: string,
    events: Array<{ sequence: number; event: CloudDisplayInputEvent }>, options: { signal: AbortSignal }): Promise<void>;
  input(
    sessionId: string,
    streamId: string,
    viewerId: string,
    sequence: number,
    event: CloudDisplayInputEvent,
    options: { signal: AbortSignal },
  ): Promise<void>;
}

export interface CloudDisplayConnectionOptions {
  signal?: AbortSignal;
  interestRenewMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxReconnectAttempts?: number;
}

const INTEGRITY_CODES = new Set([
  'CLOUD_RESPONSE_TOO_LARGE', 'DISPLAY_CAPABILITY_INVALID', 'DISPLAY_FRAME_INTEGRITY_FAILED',
  'DISPLAY_FRAME_METADATA_INVALID', 'DISPLAY_INTEREST_INVALID', 'SERVER_BODY_TAMPERED',
  'SERVER_IDENTITY_INVALID', 'SERVER_IDENTITY_MISMATCH', 'SERVER_PROOF_INVALID',
  'SERVER_PROOF_MISSING', 'SSE_PAYLOAD_INVALID', 'SSE_PROOF_INVALID',
]);
const TRANSIENT_CODES = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETDOWN',
  'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

type DisplayError = Error & { code?: string; status?: number; retryable?: boolean };
type DisplayPhase = {
  capability: CloudDisplayAvailableCapability;
  controller: AbortController;
  failed: boolean;
  markHealthy(): void;
  fail(error: DisplayError, terminal?: boolean): void;
};

function integrityFailure(error: DisplayError): boolean {
  return INTEGRITY_CODES.has(String(error.code ?? '').toUpperCase());
}

function transientFailure(error: DisplayError): boolean {
  if (integrityFailure(error)) return false;
  const status = Number(error.status);
  const cause = error.cause && typeof error.cause === 'object'
    ? error.cause as { code?: string }
    : null;
  const code = String(error.code ?? cause?.code ?? '').toUpperCase();
  return error.retryable === true || status === 408 || status === 425 || status === 429 || status >= 500
    || TRANSIENT_CODES.has(code)
    || error.name === 'TypeError' && /fetch failed|failed to fetch|networkerror|terminated|socket hang up/i.test(error.message);
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const abort = () => target.abort(source.reason);
  source.addEventListener('abort', abort, { once: true });
  if (source.aborted) abort();
  return () => source.removeEventListener('abort', abort);
}

function streamEnded(): DisplayError {
  return Object.assign(new Error('Cloud display stream ended'), {
    code: 'DISPLAY_STREAM_ENDED', retryable: true,
  });
}

function unavailableFailure(
  capability: Extract<CloudDisplayCapability, { kind: 'unavailable' }>,
): DisplayError {
  return Object.assign(
    new Error(`Cloud display unavailable (${capability.reason}): ${capability.message}`),
    { code: 'DISPLAY_UNAVAILABLE' },
  );
}

class VerifiedDisplayConnection implements CloudDisplayConnection {
  readonly #transport: CloudDisplayTransport;
  readonly #sessionId: string;
  readonly #viewerId = globalThis.crypto.randomUUID();
  readonly #listener: (event: CloudDisplayEvent) => void;
  readonly #controller = new AbortController();
  readonly #interestRenewMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #maxReconnectAttempts: number;
  #removeExternalAbort: () => void;
  #capability: CloudDisplayCapability | null = null;
  #loop: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #closed = false;
  #interestStream: string | null = null;
  #phase: DisplayPhase | null = null;
  #pending: CloudDisplayFrameMetadata | null = null;
  #downloading: Promise<void> | null = null;
  #lastSequence = 0;
  #inputSequence = 0;
  #inputQueue: CloudInputQueue;

  constructor(
    transport: CloudDisplayTransport,
    sessionId: string,
    listener: (event: CloudDisplayEvent) => void,
    options: CloudDisplayConnectionOptions,
  ) {
    this.#transport = transport;
    this.#sessionId = sessionId;
    this.#listener = listener;
    this.#interestRenewMs = Math.max(1, Number(options.interestRenewMs) || 12_000);
    this.#retryBaseMs = Math.max(0, Number(options.retryBaseMs) || 250);
    this.#retryMaxMs = Math.max(this.#retryBaseMs, Number(options.retryMaxMs) || 5_000);
    this.#maxReconnectAttempts = Math.max(1, Number(options.maxReconnectAttempts) || Infinity);
    this.#inputQueue = new CloudInputQueue(async (streamId, events) => {
      if (this.#closed || this.#controller.signal.aborted) throw this.#controller.signal.reason;
      if (this.#capability?.kind !== 'available' || this.#capability.streamId !== streamId) {
        throw Object.assign(new Error('Cloud display stream was replaced'), { code: 'DISPLAY_STREAM_REPLACED' });
      }
      const signal = this.#phase?.controller.signal ?? this.#controller.signal;
      if (this.#capability.inputBatchSize && this.#transport.inputs) {
        await this.#transport.inputs(this.#sessionId, streamId, this.#viewerId,
          events.map((event) => ({ sequence: ++this.#inputSequence, event })), { signal });
      } else await this.#transport.input(this.#sessionId, streamId, this.#viewerId, ++this.#inputSequence, events[0], { signal });
    }, () => this.#capability?.kind === 'available' && this.#capability.inputBatchSize && this.#transport.inputs ? 32 : 1);
    this.#removeExternalAbort = relayAbort(options.signal, this.#controller);
  }

  get capability(): CloudDisplayCapability {
    if (!this.#capability) throw new Error('Cloud display connection has not started');
    return this.#capability;
  }

  async start(): Promise<this> {
    this.#emit({ kind: 'connection', state: 'connecting', sessionId: this.#sessionId, streamId: null, retryable: true });
    let attempt = 0;
    for (;;) {
      try {
        this.#capability = await this.#transport.capability(this.#sessionId, { signal: this.#controller.signal });
        break;
      } catch (rawError) {
        const error = rawError as DisplayError;
        if (this.#controller.signal.aborted) throw this.#controller.signal.reason;
        if (integrityFailure(error) || !transientFailure(error) || ++attempt >= this.#maxReconnectAttempts) throw error;
        this.#emitReconnect(attempt, error, null);
        await this.#backoff(attempt);
      }
    }
    if (this.#capability.kind === 'unavailable') this.#emit(this.#capability);
    else this.#emitConnected(this.#capability);
    this.#loop = this.#run(this.#capability).catch((error: DisplayError) => {
      if (!this.#closed && !this.#controller.signal.aborted) this.#emitFailure(error);
    }).finally(async () => {
      this.#loop = null;
      if (!this.#closed) await this.#releaseInterest();
    });
    return this;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  sendInput(event: CloudDisplayInputEvent): Promise<void> {
    const capability = this.#capability;
    if (this.#closed || !this.#phase || this.#phase.controller.signal.aborted || capability?.kind !== 'available') {
      return Promise.reject(Object.assign(new Error('Cloud display input is unavailable'), {
        code: 'DISPLAY_INPUT_UNAVAILABLE',
      }));
    }
    // Existing workers use exact pointer fields and reject even clickCount: 1.
    if (capability.supportsClickCount !== true && event.kind === 'pointer' && 'clickCount' in event) {
      const { clickCount: _clickCount, ...legacyEvent } = event;
      return this.#inputQueue.enqueue(capability.streamId, legacyEvent);
    }
    return this.#inputQueue.enqueue(capability.streamId, event);
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#removeExternalAbort();
    this.#controller.abort();
    this.#phase?.controller.abort();
    this.#pending = null;
    await Promise.allSettled([this.#loop, this.#downloading, this.#inputQueue.close()].filter(Boolean) as Promise<void>[]);
    await this.#releaseInterest();
  }

  async #run(initial: CloudDisplayCapability): Promise<void> {
    let capability = initial;
    let failures = 0;
    while (!this.#closed) {
      try {
        if (capability.kind === 'unavailable') {
          if (!capability.retryable) return;
          await this.#backoff(Math.max(1, failures + 1));
          const previous = capability;
          const next = await this.#transport.capability(this.#sessionId, { signal: this.#controller.signal });
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
        if (this.#interestStream && this.#interestStream !== capability.streamId) await this.#releaseInterest();
        if (this.#capability?.kind !== 'available' || this.#capability.streamId !== capability.streamId) {
          this.#capability = capability;
          this.#lastSequence = 0;
          this.#pending = null;
          this.#emitConnected(capability);
        }
        await this.#runStream(capability, () => { failures = 0; });
        throw streamEnded();
      } catch (rawError) {
        const error = rawError as DisplayError;
        if (this.#closed || this.#controller.signal.aborted) return;
        if (integrityFailure(error) || (!transientFailure(error) && error.code !== 'DISPLAY_STREAM_NOT_FOUND')) {
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
          const next = await this.#transport.capability(this.#sessionId, { signal: this.#controller.signal });
          if (next.kind === 'available' && (capability.kind !== 'available' || next.streamId !== capability.streamId)) {
            await this.#adoptAvailableCapability(capability, next);
          } else if (next.kind === 'unavailable') {
            this.#capability = next;
            this.#emit(next);
          }
          capability = next;
        } catch (rawCapabilityError) {
          const capabilityError = rawCapabilityError as DisplayError;
          if (integrityFailure(capabilityError)) {
            this.#emitFailure(capabilityError);
            return;
          }
          capability = this.capability;
        }
      }
    }
  }

  async #runStream(capability: CloudDisplayAvailableCapability, markHealthy: () => void): Promise<void> {
    const controller = new AbortController();
    const removeAbort = relayAbort(this.#controller.signal, controller);
    let rejectFailure!: (error: DisplayError) => void;
    const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
    const phase: DisplayPhase = {
      capability,
      controller,
      failed: false,
      markHealthy,
      fail: (error: DisplayError, terminal = false) => {
        if (phase.failed || controller.signal.aborted) return;
        phase.failed = true;
        if (terminal) this.#pending = null;
        rejectFailure(error);
      },
    };
    this.#phase = phase;
    try {
      await this.#transport.interest(
        this.#sessionId,
        capability.streamId,
        this.#viewerId,
        true,
        { signal: controller.signal },
      );
      this.#interestStream = capability.streamId;
      const frames = this.#transport.frames(this.#sessionId, capability, this.#lastSequence, {
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
      await Promise.race([frames, renew, failure]);
    } finally {
      controller.abort();
      this.#inputQueue.reset();
      removeAbort();
      if (this.#phase === phase) this.#phase = null;
      await this.#downloading?.catch(() => {});
    }
  }

  async #renewInterest(capability: CloudDisplayAvailableCapability, signal: AbortSignal): Promise<never> {
    for (;;) {
      await wait(this.#interestRenewMs, signal);
      await this.#transport.interest(this.#sessionId, capability.streamId, this.#viewerId, true, { signal });
    }
  }

  #queueMetadata(metadata: CloudDisplayFrameMetadata, phase: DisplayPhase): void {
    if (this.#closed || phase.failed || this.#phase !== phase || metadata.sessionId !== this.#sessionId
      || metadata.streamId !== phase.capability.streamId || metadata.sequence <= this.#lastSequence) return;
    if (!this.#pending || metadata.sequence > this.#pending.sequence) this.#pending = metadata;
    if (!this.#downloading) this.#downloadNext(phase);
  }

  #downloadNext(phase: DisplayPhase): void {
    const metadata = this.#pending;
    if (!metadata || this.#closed || phase.failed || this.#phase !== phase) return;
    this.#pending = null;
    const operation = this.#transport.frame(metadata, { signal: phase.controller.signal })
      .then((frame) => {
        if (this.#closed || this.#phase !== phase || frame.sessionId !== this.#sessionId
          || frame.streamId !== phase.capability.streamId || frame.sequence <= this.#lastSequence) return;
        this.#lastSequence = frame.sequence;
        phase.markHealthy();
        this.#emit(frame);
      })
      .catch((error: DisplayError) => {
        if (this.#closed || phase.controller.signal.aborted) return;
        if (error.code === 'DISPLAY_FRAME_NOT_FOUND') return;
        phase.fail(error, integrityFailure(error));
      })
      .finally(() => {
        if (this.#downloading !== operation) return;
        this.#downloading = null;
        this.#downloadNext(phase);
      });
    this.#downloading = operation;
  }

  async #releaseInterest(): Promise<void> {
    const streamId = this.#interestStream;
    this.#interestStream = null;
    if (!streamId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      await this.#transport.interest(this.#sessionId, streamId, this.#viewerId, false, { signal: controller.signal });
    } catch {
      // The server TTL is the final cleanup fence when release cannot be delivered.
    } finally {
      clearTimeout(timeout);
    }
  }

  async #adoptAvailableCapability(
    previous: CloudDisplayCapability,
    next: CloudDisplayAvailableCapability,
  ): Promise<void> {
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

  #backoff(attempt: number): Promise<void> {
    const milliseconds = Math.min(this.#retryMaxMs, this.#retryBaseMs * 2 ** Math.min(attempt - 1, 8));
    return milliseconds === 0 ? Promise.resolve() : wait(milliseconds, this.#controller.signal);
  }

  #emitConnected(capability: CloudDisplayAvailableCapability): void {
    this.#emit({
      kind: 'connection', state: 'connected', sessionId: this.#sessionId,
      streamId: capability.streamId, retryable: true, capability,
    });
  }

  #emitReconnect(attempt: number, error: DisplayError, streamId: string | null): void {
    this.#emit({
      kind: 'connection', state: 'reconnecting', sessionId: this.#sessionId,
      streamId, retryable: true, attempt, message: error.message,
    });
  }

  #emitFailure(error: DisplayError): void {
    this.#emit({
      kind: 'connection', state: 'failed', sessionId: this.#sessionId,
      streamId: this.#capability?.kind === 'available' ? this.#capability.streamId : null,
      retryable: false, code: error.code ?? 'DISPLAY_CONNECTION_FAILED', message: error.message,
    });
  }

  #emit(event: CloudDisplayEvent): void {
    if (this.#closed) return;
    try { this.#listener(event); } catch { /* Display listeners are isolated. */ }
  }
}

export async function openDisplayConnection(
  transport: CloudDisplayTransport,
  sessionId: string,
  listener: (event: CloudDisplayEvent) => void,
  options: CloudDisplayConnectionOptions = {},
): Promise<CloudDisplayConnection> {
  const connection = new VerifiedDisplayConnection(transport, sessionId, listener, options);
  try {
    return await connection.start();
  } catch (error) {
    await connection.close();
    throw error;
  }
}

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { childProcessEnvironment, createSessionDisplayMode } from './session-display.mjs';

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const MAX_DISPLAY_FPS = 12;
const MAX_DISPLAY_FRAME_BYTES = 512 * 1024;
const STDERR_TAIL_BYTES = 4 * 1024;

function aborted(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function streamMissing(error) {
  return error?.code === 'DISPLAY_STREAM_NOT_FOUND';
}

function authorizationFailure(error) {
  return error?.status === 401 || error?.status === 403
    || ['WORKER_UNAUTHORIZED', 'DISPLAY_WORKER_REPLACED'].includes(error?.code);
}

function transient(error) {
  const status = Number(error?.status);
  if (status === 408 || status === 429 || status >= 500) return true;
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase();
  return [
    'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETDOWN',
    'ENETUNREACH', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  ].includes(code) || /socket hang up|terminated|timed out/i.test(String(error?.message ?? ''));
}

export class SessionFramePublisher {
  constructor({
    client,
    sessionDisplay,
    displayMode = createSessionDisplayMode(sessionDisplay),
    ffmpegBin = 'ffmpeg',
    spawnProcess = spawn,
    now = Date.now,
    onEvent = () => {},
    maxFrameBytes = MAX_DISPLAY_FRAME_BYTES,
    retryBaseMs = 100,
    retryMaxMs = 2_000,
    environment = process.env,
  } = {}) {
    if (!client) throw new Error('SessionFramePublisher requires a worker client');
    this.client = client;
    this.sessionDisplay = sessionDisplay;
    this.displayMode = displayMode;
    this.width = displayMode.geometry.width;
    this.height = displayMode.geometry.height;
    this.ffmpegBin = ffmpegBin;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.onEvent = onEvent;
    this.maxFrameBytes = Math.min(MAX_DISPLAY_FRAME_BYTES, maxFrameBytes);
    this.retryBaseMs = Math.max(1, retryBaseMs);
    this.retryMaxMs = Math.max(this.retryBaseMs, retryMaxMs);
    this.environment = environment;
    this.status = 'stopped';
    this.streamId = null;
    this.sequence = 0;
    this.demandVersion = 0;
    this.lastPublishedDigest = null;
    this.lastError = null;
    this.child = null;
    this.captureBuffer = Buffer.alloc(0);
    this.current = null;
    this.pending = null;
    this.uploading = null;
    this.loop = null;
    this.controller = null;
    this.demandController = null;
    this.uploadController = null;
    this.stopPromise = null;
    this.stopping = false;
    this.terminal = false;
    this.reportedError = null;
    this.expectedExits = new WeakSet();
    this.ready = false;
    this.interested = false;
    this.captureRetry = null;
    this.captureFailures = 0;
    this.generation = 0;
    this.inputHandler = null;
    this.appliedInputs = new Map();
  }

  snapshot() {
    return {
      status: this.status,
      streamId: this.streamId,
      sequence: this.sequence,
      capturing: Boolean(this.child),
      uploading: Boolean(this.uploading),
      pending: Boolean(this.pending),
      ready: this.ready,
      interested: this.interested,
      retrying: Boolean(this.captureRetry),
      lastError: this.lastError,
    };
  }

  async start() {
    if (this.loop || this.streamId) return this.snapshot();
    this.stopping = false;
    this.terminal = false;
    this.stopPromise = null;
    this.streamId = null;
    this.sequence = 0;
    this.demandVersion = 0;
    this.lastPublishedDigest = null;
    this.lastError = null;
    this.current = null;
    this.pending = null;
    this.reportedError = null;
    this.ready = false;
    this.interested = false;
    this.#invalidatePublication();
    if (this.displayMode.kind !== 'headed' || !this.#displayAvailable()) {
      this.status = 'unavailable';
      this.lastError = 'Session display is unavailable';
      return this.snapshot();
    }
    this.status = 'connecting';
    this.controller = new AbortController();
    this.loop = this.#run().finally(() => { this.loop = null; });
    await Promise.resolve();
    return this.snapshot();
  }

  async stop({ drainInput = false } = {}) {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.#stop(drainInput).catch((error) => { this.stopPromise = null; throw error; });
    return this.stopPromise;
  }

  async #stop(drainInput) {
    this.stopping = true;
    this.ready = false;
    this.interested = false;
    this.#invalidatePublication();
    this.controller?.abort();
    this.demandController?.abort();
    await this.#stopCapture();
    await this.uploading?.catch(() => {});
    await this.loop?.catch(() => {});
    this.current = null;
    const streamId = this.streamId;
    if (drainInput && streamId && this.inputHandler && this.client.sealFrameInput) {
      const demand = await this.client.sealFrameInput(streamId, this.demandVersion);
      await this.#applyInputs(demand.inputEvents ?? [], streamId);
      this.demandVersion = demand.version;
    }
    this.streamId = null;
    if (streamId) await this.client.closeFrameStream(streamId).catch((error) => this.#fail(error));
    this.status = 'stopped';
    return this.snapshot();
  }

  markReady() {
    if (this.stopping || this.terminal || !this.loop || !this.#displayAvailable()) {
      return this.snapshot();
    }
    this.ready = true;
    if (this.interested) this.#startCapture();
    return this.snapshot();
  }

  setInputHandler(handler) {
    if (handler !== null && typeof handler !== 'function') {
      throw new Error('Display input handler must be a function');
    }
    this.inputHandler = handler;
    return this.snapshot();
  }

  async markUnavailable() {
    this.ready = false;
    this.#invalidatePublication();
    await this.#stopCapture();
    if (!this.stopping && !this.terminal) this.status = 'unavailable';
    return this.snapshot();
  }

  async #run() {
    let failures = 0;
    while (!this.stopping && !this.terminal) {
      if (!this.streamId) {
        try {
          const capability = await this.client.openFrameStream({
            width: this.width,
            height: this.height,
            signal: this.controller.signal,
          });
          this.streamId = capability.streamId;
          this.sequence = 0;
          this.demandVersion = 0;
          this.lastPublishedDigest = null;
          if (this.current) this.current.sequence = null;
          if (this.pending) this.pending.sequence = null;
          this.status = 'waiting';
          failures = 0;
          this.captureFailures = 0;
          this.#pump();
        } catch (error) {
          if (this.stopping || aborted(error)) break;
          if (authorizationFailure(error) || !transient(error)) {
            this.#stopForError(error);
            break;
          }
          this.#fail(error);
          this.status = 'connecting';
          await this.#backoff(failures += 1, this.controller.signal);
          continue;
        }
      }

      const demandStreamId = this.streamId;
      try {
        this.demandController = new AbortController();
        const demand = await this.client.frameDemand(demandStreamId, {
          after: this.demandVersion,
          signal: this.demandController.signal,
        });
        this.demandController = null;
        if (!demand || demand.closed) {
          await this.#loseStream(demandStreamId);
          continue;
        }
        failures = 0;
        const inputEvents = Array.isArray(demand.inputEvents) ? demand.inputEvents : [];
        if (inputEvents.length > 0) {
          if (!this.inputHandler) {
            await this.#backoff(1, this.controller.signal);
            continue;
          }
          await this.#applyInputs(inputEvents, demandStreamId);
        }
        this.demandVersion = demand.version;
        this.interested = demand.interested === true;
        if (this.interested && this.ready) this.#startCapture();
        else if (!this.interested) {
          this.#invalidatePublication();
          await this.#stopCapture();
        }
      } catch (error) {
        this.demandController = null;
        if (this.stopping || this.terminal) break;
        if (aborted(error) && !this.streamId) continue;
        if (streamMissing(error)) {
          await this.#loseStream(demandStreamId);
          continue;
        }
        if (authorizationFailure(error) || !transient(error)) {
          this.#stopForError(error);
          break;
        }
        this.#fail(error);
        await this.#stopCapture();
        await this.#backoff(failures += 1, this.controller.signal);
      }
    }
    await this.#stopCapture();
  }

  async #loseStream(expectedStreamId) {
    if (expectedStreamId && this.streamId !== expectedStreamId) return;
    this.#invalidatePublication();
    this.streamId = null;
    this.sequence = 0;
    this.demandVersion = 0;
    this.appliedInputs.clear();
    this.lastPublishedDigest = null;
    this.interested = false;
    this.demandController?.abort();
    this.status = 'connecting';
    await this.#stopCapture();
  }

  async #applyInputs(inputs, streamId) {
    const results = [];
    let failed = false;
    for (const input of inputs) {
      let result = this.appliedInputs.get(input.version);
      if (!result) {
        try {
          if (failed) throw new Error("Skipped after an earlier input failed");
          await this.inputHandler(input.event);
          result = { version: input.version, ok: true };
        } catch (error) {
          result = { version: input.version, ok: false, error: String(error?.message ?? error).slice(0, 256) };
          this.onEvent({ type: 'display-input-failed', sequence: input.sequence, error: result.error });
          if (!failed) await this.inputHandler({ kind: 'reset' }).catch(() => {});
        }
        this.appliedInputs.set(input.version, result);
      }
      failed ||= !result.ok;
      results.push(result);
    }
    if (results.length && this.client.acknowledgeFrameInputs) await this.client.acknowledgeFrameInputs(streamId, results);
    for (const input of inputs) this.appliedInputs.delete(input.version);
  }

  #stopForError(error) {
    this.#fail(error);
    this.terminal = true;
    this.status = 'error';
    this.#invalidatePublication();
    this.demandController?.abort();
  }

  async #backoff(failures, signal) {
    const timeout = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(failures - 1, 8)));
    try { await delay(timeout, undefined, { signal, ref: false }); } catch { /* Stop or stream reset. */ }
  }

  #startCapture() {
    if (this.stopping || this.terminal || this.child) return;
    const environment = this.displayMode.environment;
    if (!this.#captureEligible(this.streamId)) {
      if (!this.#displayAvailable()) {
        this.ready = false;
        this.status = 'unavailable';
      }
      return;
    }
    const streamId = this.streamId;
    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'x11grab',
      '-framerate', String(MAX_DISPLAY_FPS),
      '-video_size', `${this.width}x${this.height}`,
      '-i', `${environment.DISPLAY}.0`,
      '-an',
      '-c:v', 'mjpeg',
      '-q:v', '5',
      '-f', 'image2pipe',
      'pipe:1',
    ];
    let child;
    try {
      child = this.spawnProcess(this.ffmpegBin, args, {
        env: childProcessEnvironment(this.environment, environment),
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.#captureFailed(error, streamId);
      return;
    }
    this.child = child;
    this.captureBuffer = Buffer.alloc(0);
    this.status = 'capturing';
    let stderrTail = '';
    let settled = false;
    child.stdout?.on('data', (chunk) => {
      if (this.child === child) {
        this.captureFailures = 0;
        this.#consume(chunk);
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-STDERR_TAIL_BYTES);
    });
    const finish = (error, code, signal) => {
      if (settled) return;
      settled = true;
      if (this.child === child) this.child = null;
      if (this.expectedExits.has(child) || this.stopping) return;
      if (error) {
        this.#captureFailed(error, streamId);
      } else if (code !== 0 || signal) {
        const detail = stderrTail.trim();
        this.#captureFailed(new Error(
          `${this.ffmpegBin} exited ${signal ? `from ${signal}` : `with ${code}`}${detail ? `: ${detail}` : ''}`,
        ), streamId);
      } else if (!this.terminal) {
        this.status = 'waiting';
      }
    };
    child.once('error', (error) => finish(error, null, null));
    child.once('close', (code, signal) => finish(null, code, signal));
  }

  #captureFailed(error, streamId) {
    this.#fail(error);
    if (this.#captureEligible(streamId)) {
      this.#scheduleCaptureRetry(streamId);
    } else if (!this.stopping && !this.terminal) {
      if (!this.#displayAvailable()) {
        this.ready = false;
        this.#cancelCaptureRetry();
        this.status = 'unavailable';
      } else {
        this.status = 'error';
      }
    }
  }

  async #stopCapture() {
    this.#cancelCaptureRetry();
    const child = this.child;
    this.child = null;
    this.captureBuffer = Buffer.alloc(0);
    if (!child || child.exitCode != null || child.signalCode != null) {
      if (!this.stopping && !this.terminal && this.streamId) this.status = 'waiting';
      return;
    }
    this.expectedExits.add(child);
    const closed = new Promise((resolve) => child.once('close', resolve));
    try { child.kill('SIGTERM'); } catch { /* Process already exited. */ }
    await Promise.race([closed, delay(1_000, undefined, { ref: false })]);
    if (child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGKILL'); } catch { /* Process already exited. */ }
    }
    if (!this.stopping && !this.terminal && this.streamId) this.status = 'waiting';
  }

  #displayAvailable() {
    if (this.displayMode.kind !== 'headed') return false;
    const snapshot = this.sessionDisplay?.snapshot?.();
    const environment = this.sessionDisplay?.environment;
    const currentDisplay = snapshot?.display ?? this.sessionDisplay?.display ?? environment?.DISPLAY;
    return snapshot?.status === 'ready'
      && currentDisplay === this.displayMode.display
      && environment?.DISPLAY === this.displayMode.display;
  }

  #captureEligible(streamId) {
    return !this.stopping
      && !this.terminal
      && this.ready
      && this.interested
      && Boolean(streamId)
      && this.streamId === streamId
      && this.#displayAvailable();
  }

  #scheduleCaptureRetry(streamId) {
    if (!this.#captureEligible(streamId)) return;
    this.#cancelCaptureRetry({ resetFailures: false });
    const controller = new AbortController();
    const failures = ++this.captureFailures;
    const timeout = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(failures - 1, 8)));
    const retry = { controller, streamId, promise: null };
    this.status = 'retrying';
    retry.promise = delay(timeout, undefined, { signal: controller.signal, ref: false })
      .then(() => {
        if (this.captureRetry !== retry) return;
        this.captureRetry = null;
        if (!this.#captureEligible(streamId)) {
          if (!this.#displayAvailable()) {
            this.ready = false;
            this.status = 'unavailable';
          }
          return;
        }
        this.#startCapture();
      })
      .catch(() => {})
      .finally(() => {
        if (this.captureRetry === retry) this.captureRetry = null;
      });
    this.captureRetry = retry;
  }

  #cancelCaptureRetry({ resetFailures = true } = {}) {
    this.captureRetry?.controller.abort();
    this.captureRetry = null;
    if (resetFailures) this.captureFailures = 0;
  }

  #consume(chunk) {
    if (this.stopping || this.terminal) return;
    this.captureBuffer = Buffer.concat([this.captureBuffer, Buffer.from(chunk)]);
    while (this.captureBuffer.length) {
      const start = this.captureBuffer.indexOf(JPEG_START);
      if (start < 0) {
        this.captureBuffer = this.captureBuffer.at(-1) === 0xff ? Buffer.from([0xff]) : Buffer.alloc(0);
        return;
      }
      if (start > 0) this.captureBuffer = this.captureBuffer.subarray(start);
      const end = this.captureBuffer.indexOf(JPEG_END, 2);
      if (end < 0) {
        if (this.captureBuffer.length > this.maxFrameBytes) {
          this.captureBuffer = Buffer.alloc(0);
          this.lastError = 'Captured JPEG frame exceeded 512 KiB';
        }
        return;
      }
      const frame = this.captureBuffer.subarray(0, end + JPEG_END.length);
      this.captureBuffer = this.captureBuffer.subarray(end + JPEG_END.length);
      if (frame.length <= this.maxFrameBytes) this.#queueFrame(Buffer.from(frame));
      else this.lastError = 'Captured JPEG frame exceeded 512 KiB';
    }
  }

  #queueFrame(bytes) {
    const streamId = this.streamId;
    const generation = this.generation;
    if (!this.#publicationEligible(generation, streamId)) return;
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest === this.current?.digest || digest === this.pending?.digest
      || (!this.current && digest === this.lastPublishedDigest)) return;
    const frame = {
      bytes,
      digest,
      capturedAt: new Date(this.now()).toISOString(),
      sequence: null,
      generation,
      streamId,
    };
    if (this.current) this.pending = frame;
    else this.current = frame;
    this.#pump();
  }

  #pump() {
    if (this.uploading || !this.current) return;
    const frame = this.current;
    const { generation, streamId } = frame;
    if (!this.#publicationEligible(generation, streamId)) return;
    if (frame.sequence === null) frame.sequence = ++this.sequence;
    this.uploadController = new AbortController();
    const upload = this.#publish(frame, streamId, generation, this.uploadController.signal)
      .finally(() => {
        if (this.uploading !== upload) return;
        this.uploading = null;
        this.uploadController = null;
        this.#pump();
      });
    this.uploading = upload;
  }

  async #publish(frame, streamId, generation, signal) {
    let failures = 0;
    while (this.current === frame && this.#publicationEligible(generation, streamId) && !signal.aborted) {
      try {
        if (!this.#publicationEligible(generation, streamId) || signal.aborted) return;
        await this.client.publishFrame(streamId, {
          sequence: frame.sequence,
          capturedAt: frame.capturedAt,
          bytes: frame.bytes,
          signal,
        });
        if (this.current !== frame || !this.#publicationEligible(generation, streamId) || signal.aborted) return;
        this.lastPublishedDigest = frame.digest;
        this.current = this.pending;
        this.pending = null;
        return;
      } catch (error) {
        if (!this.#publicationEligible(generation, streamId) || signal.aborted || aborted(error)) return;
        if (streamMissing(error)) {
          await this.#loseStream(streamId);
          return;
        }
        if (authorizationFailure(error) || !transient(error)) {
          this.#stopForError(error);
          return;
        }
        this.#fail(error);
        if (this.pending) {
          this.current = this.pending;
          this.pending = null;
          return;
        }
        await this.#backoff(failures += 1, signal);
      }
    }
  }

  #publicationEligible(generation, streamId) {
    return generation === this.generation
      && this.#captureEligible(streamId);
  }

  #invalidatePublication() {
    this.generation += 1;
    this.uploadController?.abort();
    this.current = null;
    this.pending = null;
    this.captureBuffer = Buffer.alloc(0);
    this.lastPublishedDigest = null;
    this.#cancelCaptureRetry();
  }

  #fail(error) {
    this.lastError = String(error?.message ?? error).slice(0, 1_000);
    if (this.reportedError === this.lastError) return;
    this.reportedError = this.lastError;
    try { this.onEvent({ type: 'environment.display_frame_failed', message: this.lastError }); } catch { /* Lossy. */ }
  }
}

export function createSessionFramePublisher(options) {
  return new SessionFramePublisher(options);
}

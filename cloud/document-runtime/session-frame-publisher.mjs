import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const MAX_DISPLAY_FPS = 2;
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
    width = 1280,
    height = 800,
    ffmpegBin = 'ffmpeg',
    spawnProcess = spawn,
    now = Date.now,
    onEvent = () => {},
    maxFrameBytes = MAX_DISPLAY_FRAME_BYTES,
    retryBaseMs = 100,
    retryMaxMs = 2_000,
  } = {}) {
    if (!client) throw new Error('SessionFramePublisher requires a worker client');
    this.client = client;
    this.sessionDisplay = sessionDisplay;
    this.width = width;
    this.height = height;
    this.ffmpegBin = ffmpegBin;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.onEvent = onEvent;
    this.maxFrameBytes = Math.min(MAX_DISPLAY_FRAME_BYTES, maxFrameBytes);
    this.retryBaseMs = Math.max(1, retryBaseMs);
    this.retryMaxMs = Math.max(this.retryBaseMs, retryMaxMs);
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
  }

  snapshot() {
    return {
      status: this.status,
      streamId: this.streamId,
      sequence: this.sequence,
      capturing: Boolean(this.child),
      uploading: Boolean(this.uploading),
      pending: Boolean(this.pending),
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
    const environment = this.sessionDisplay?.environment;
    if (!environment?.DISPLAY) {
      this.status = 'unavailable';
      this.lastError = 'Session display is unavailable';
      return this.snapshot();
    }
    this.status = 'connecting';
    this.controller = new AbortController();
    this.loop = this.#run(environment).finally(() => { this.loop = null; });
    await Promise.resolve();
    return this.snapshot();
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.#stop();
    return this.stopPromise;
  }

  async #stop() {
    this.stopping = true;
    this.controller?.abort();
    this.demandController?.abort();
    this.uploadController?.abort();
    this.pending = null;
    await this.#stopCapture();
    await this.uploading?.catch(() => {});
    await this.loop?.catch(() => {});
    this.current = null;
    const streamId = this.streamId;
    this.streamId = null;
    if (streamId) await this.client.closeFrameStream(streamId).catch((error) => this.#fail(error));
    this.status = 'stopped';
    return this.snapshot();
  }

  async #run(environment) {
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
        this.demandVersion = demand.version;
        if (demand.interested) this.#startCapture(environment);
        else await this.#stopCapture();
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
    this.streamId = null;
    this.sequence = 0;
    this.demandVersion = 0;
    this.lastPublishedDigest = null;
    if (this.current) this.current.sequence = null;
    if (this.pending) this.pending.sequence = null;
    this.demandController?.abort();
    this.uploadController?.abort();
    this.status = 'connecting';
    await this.#stopCapture();
  }

  #stopForError(error) {
    this.#fail(error);
    this.terminal = true;
    this.status = 'error';
    this.demandController?.abort();
    this.uploadController?.abort();
  }

  async #backoff(failures, signal) {
    const timeout = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(failures - 1, 8)));
    try { await delay(timeout, undefined, { signal, ref: false }); } catch { /* Stop or stream reset. */ }
  }

  #startCapture(environment) {
    if (this.stopping || this.terminal || this.child) return;
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
        env: { ...process.env, ...environment },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.#captureFailed(error);
      return;
    }
    this.child = child;
    this.captureBuffer = Buffer.alloc(0);
    this.status = 'capturing';
    let stderrTail = '';
    let settled = false;
    child.stdout?.on('data', (chunk) => {
      if (this.child === child) this.#consume(chunk);
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
        this.#captureFailed(error);
      } else if (code !== 0 || signal) {
        const detail = stderrTail.trim();
        this.#captureFailed(new Error(
          `${this.ffmpegBin} exited ${signal ? `from ${signal}` : `with ${code}`}${detail ? `: ${detail}` : ''}`,
        ));
      } else if (!this.terminal) {
        this.status = 'waiting';
      }
    };
    child.once('error', (error) => finish(error, null, null));
    child.once('close', (code, signal) => finish(null, code, signal));
  }

  #captureFailed(error) {
    this.#fail(error);
    if (!this.stopping && !this.terminal) this.status = 'error';
  }

  async #stopCapture() {
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
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest === this.current?.digest || digest === this.pending?.digest
      || (!this.current && digest === this.lastPublishedDigest)) return;
    const frame = {
      bytes,
      digest,
      capturedAt: new Date(this.now()).toISOString(),
      sequence: null,
    };
    if (this.current) this.pending = frame;
    else this.current = frame;
    this.#pump();
  }

  #pump() {
    if (this.uploading || !this.current || !this.streamId || this.stopping || this.terminal) return;
    const frame = this.current;
    const streamId = this.streamId;
    if (frame.sequence === null) frame.sequence = ++this.sequence;
    this.uploadController = new AbortController();
    const upload = this.#publish(frame, streamId, this.uploadController.signal)
      .finally(() => {
        if (this.uploading !== upload) return;
        this.uploading = null;
        this.uploadController = null;
        this.#pump();
      });
    this.uploading = upload;
  }

  async #publish(frame, streamId, signal) {
    let failures = 0;
    while (!this.stopping && !this.terminal && this.current === frame && this.streamId === streamId) {
      try {
        await this.client.publishFrame(streamId, {
          sequence: frame.sequence,
          capturedAt: frame.capturedAt,
          bytes: frame.bytes,
          signal,
        });
        if (this.current !== frame || this.streamId !== streamId) return;
        this.lastPublishedDigest = frame.digest;
        this.current = this.pending;
        this.pending = null;
        return;
      } catch (error) {
        if (this.stopping || this.terminal) return;
        if (aborted(error) && this.streamId !== streamId) return;
        if (streamMissing(error)) {
          await this.#loseStream(streamId);
          return;
        }
        if (authorizationFailure(error) || !transient(error)) {
          this.#stopForError(error);
          return;
        }
        this.#fail(error);
        await this.#backoff(failures += 1, signal);
      }
    }
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

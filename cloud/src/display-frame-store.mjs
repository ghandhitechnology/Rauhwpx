import { createHash, randomUUID } from 'node:crypto';

import { CloudError } from './protocol.mjs';

export const DISPLAY_FRAME_PROTOCOL = 'rauhwpx-frame-v1';
export const MAX_DISPLAY_FRAME_BYTES = 512 * 1024;
export const MAX_DISPLAY_FPS = 2;
export const MAX_DISPLAY_DIMENSION = 4096;

const DEFAULT_INTEREST_TTL_MS = 20_000;
const DEFAULT_INTEREST_GRACE_MS = 3_000;
const DEFAULT_DEMAND_WAIT_MS = 20_000;

function displayError(code, message, status = 400) {
  return new CloudError(code, message, status);
}

function identifier(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw displayError('INVALID_REQUEST', `${label} is invalid`);
  }
  return value;
}

function dimension(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw displayError('DISPLAY_DIMENSIONS_INVALID', `${label} is outside the supported display bounds`);
  }
  return value;
}

function jpeg(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[bytes.length - 2] === 0xff
    && bytes[bytes.length - 1] === 0xd9;
}

export class DisplayFrameStore {
  constructor({
    now = Date.now,
    maxSessions = 16,
    maxViewersPerStream = 32,
    maxDimension = MAX_DISPLAY_DIMENSION,
    maxFrameBytes = MAX_DISPLAY_FRAME_BYTES,
    interestTtlMs = DEFAULT_INTEREST_TTL_MS,
    interestGraceMs = DEFAULT_INTEREST_GRACE_MS,
    demandWaitMs = DEFAULT_DEMAND_WAIT_MS,
  } = {}) {
    this.now = now;
    this.maxSessions = Math.max(1, Number(maxSessions) || 1);
    this.maxViewersPerStream = Math.max(1, Number(maxViewersPerStream) || 1);
    this.maxDimension = Math.min(MAX_DISPLAY_DIMENSION, Math.max(1, Number(maxDimension) || 1));
    this.maxFrameBytes = Math.min(MAX_DISPLAY_FRAME_BYTES, Math.max(1, Number(maxFrameBytes) || 1));
    this.interestTtlMs = Math.max(1, Number(interestTtlMs) || 1);
    this.interestGraceMs = Math.max(0, Number(interestGraceMs) || 0);
    this.demandWaitMs = Math.max(1, Math.min(30_000, Number(demandWaitMs) || DEFAULT_DEMAND_WAIT_MS));
    this.streams = new Map();
  }

  openStream({ sessionId, workerId, width, height }) {
    identifier(sessionId, 'sessionId');
    identifier(workerId, 'workerId');
    dimension(width, 'width', this.maxDimension);
    dimension(height, 'height', this.maxDimension);
    const existing = this.streams.get(sessionId);
    if (existing && existing.workerId === workerId) {
      if (existing.width !== width || existing.height !== height) {
        throw displayError('DISPLAY_STREAM_CONFLICT', 'Worker reopened its display stream with different dimensions', 409);
      }
      return this.#capability(existing);
    }
    if (existing) this.#close(existing);
    if (this.streams.size >= this.maxSessions) {
      throw displayError('DISPLAY_SESSION_LIMIT', 'Too many display streams are active', 429);
    }
    const stream = {
      sessionId,
      workerId,
      streamId: randomUUID(),
      width,
      height,
      frames: [],
      latestSequence: 0,
      viewers: new Map(),
      subscribers: new Set(),
      waiters: new Set(),
      demandVersion: 1,
      interested: false,
      graceUntil: 0,
      expiryTimer: null,
      closed: false,
    };
    this.streams.set(sessionId, stream);
    return this.#capability(stream);
  }

  capability(sessionId) {
    const stream = this.streams.get(sessionId);
    if (!stream) return null;
    this.#sweep(stream);
    return this.#capability(stream);
  }

  publishFrame({ sessionId, workerId, streamId, sequence, capturedAt, bytes }) {
    const stream = this.#ownedStream(sessionId, workerId, streamId);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw displayError('DISPLAY_SEQUENCE_INVALID', 'Frame sequence must be a positive integer');
    }
    const frameBytes = Buffer.from(bytes ?? []);
    if (frameBytes.length < 1 || frameBytes.length > this.maxFrameBytes) {
      throw displayError('DISPLAY_FRAME_TOO_LARGE', 'JPEG frame exceeds 512 KiB', 413);
    }
    if (!jpeg(frameBytes)) throw displayError('DISPLAY_FRAME_INVALID', 'Display frame must be a complete JPEG image');
    const captured = new Date(capturedAt);
    if (!capturedAt || Number.isNaN(captured.valueOf()) || captured.toISOString() !== capturedAt) {
      throw displayError('DISPLAY_CAPTURE_TIME_INVALID', 'Frame capture time must be an ISO timestamp');
    }
    const sha256 = createHash('sha256').update(frameBytes).digest('hex');
    const duplicate = stream.frames.find((frame) => frame.metadata.sequence === sequence);
    if (duplicate) {
      if (duplicate.metadata.sha256 !== sha256 || duplicate.metadata.capturedAt !== capturedAt) {
        throw displayError('DISPLAY_SEQUENCE_CONFLICT', 'Frame sequence was reused with different content', 409);
      }
      return duplicate.metadata;
    }
    if (sequence <= stream.latestSequence) {
      throw displayError('DISPLAY_SEQUENCE_STALE', 'Frame sequence is older than the active stream', 409);
    }
    const metadata = Object.freeze({
      streamId,
      sequence,
      capturedAt,
      width: stream.width,
      height: stream.height,
      mimeType: 'image/jpeg',
      byteLength: frameBytes.length,
      sha256,
      framePath: `/v1/sessions/${encodeURIComponent(sessionId)}/display/frames/${encodeURIComponent(streamId)}/${sequence}`,
    });
    stream.frames.push(Object.freeze({ metadata, bytes: frameBytes }));
    if (stream.frames.length > 2) stream.frames.shift();
    stream.latestSequence = sequence;
    for (const listener of stream.subscribers) {
      try { listener(metadata); } catch { /* Subscribers are lossy. */ }
    }
    return metadata;
  }

  getFrame(sessionId, streamId, sequence) {
    const stream = this.#stream(sessionId, streamId);
    const frame = stream.frames.find((candidate) => candidate.metadata.sequence === sequence);
    if (!frame) throw displayError('DISPLAY_FRAME_NOT_FOUND', 'Display frame was not found', 404);
    return { metadata: frame.metadata, bytes: Buffer.from(frame.bytes) };
  }

  subscribe(sessionId, streamId, listener) {
    if (typeof listener !== 'function') throw displayError('INVALID_REQUEST', 'Frame subscriber is invalid');
    const stream = this.#stream(sessionId, streamId);
    if (stream.subscribers.size >= this.maxViewersPerStream) {
      throw displayError('DISPLAY_VIEWER_LIMIT', 'Too many display viewers are connected', 429);
    }
    stream.subscribers.add(listener);
    const latest = stream.frames.at(-1)?.metadata;
    if (latest) listener(latest);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      stream.subscribers.delete(listener);
    };
  }

  setInterest(sessionId, streamId, viewerId, active) {
    identifier(viewerId, 'viewerId');
    const stream = this.#stream(sessionId, streamId);
    this.#sweep(stream);
    let expiresAt = null;
    if (active) {
      if (!stream.viewers.has(viewerId) && stream.viewers.size >= this.maxViewersPerStream) {
        throw displayError('DISPLAY_VIEWER_LIMIT', 'Too many display viewers are active', 429);
      }
      expiresAt = this.now() + this.interestTtlMs;
      stream.viewers.set(viewerId, expiresAt);
      stream.graceUntil = 0;
    } else {
      stream.viewers.delete(viewerId);
    }
    this.#recomputeDemand(stream);
    return {
      streamId,
      interested: Boolean(active),
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      maxFps: active ? MAX_DISPLAY_FPS : 0,
    };
  }

  waitForDemand(sessionId, workerId, streamId, after = 0, {
    timeoutMs = this.demandWaitMs,
    signal = null,
  } = {}) {
    const stream = this.#ownedStream(sessionId, workerId, streamId);
    this.#sweep(stream);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw displayError('INVALID_REQUEST', 'Demand cursor must be a non-negative integer');
    }
    if (stream.demandVersion > after) return Promise.resolve(this.#demand(stream));
    if (stream.waiters.size >= 4) {
      throw displayError('DISPLAY_DEMAND_LIMIT', 'Too many display demand requests are pending', 429);
    }
    return new Promise((resolve) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(waiter.timer);
          signal?.removeEventListener('abort', waiter.abort);
          stream.waiters.delete(waiter);
          resolve(value);
        },
        abort: () => waiter.resolve(null),
        timer: null,
      };
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      waiter.timer = setTimeout(() => waiter.resolve(this.#demand(stream)), Math.max(1, Math.min(30_000, timeoutMs)));
      waiter.timer.unref?.();
      stream.waiters.add(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
  }

  closeStream(sessionId, workerId, streamId) {
    const stream = this.streams.get(sessionId);
    if (!stream) return { streamId, closed: true };
    this.#ownedStream(sessionId, workerId, streamId);
    this.#close(stream);
    return { streamId, closed: true };
  }

  closeSession(sessionId) {
    const stream = this.streams.get(sessionId);
    if (!stream) return false;
    this.#close(stream);
    return true;
  }

  closeAll() {
    for (const stream of [...this.streams.values()]) this.#close(stream);
  }

  snapshot() {
    return {
      sessions: this.streams.size,
      streams: [...this.streams.values()].map((stream) => ({
        sessionId: stream.sessionId,
        streamId: stream.streamId,
        frames: stream.frames.length,
        viewers: stream.viewers.size,
        subscribers: stream.subscribers.size,
        waiters: stream.waiters.size,
      })),
    };
  }

  #capability(stream) {
    return Object.freeze({
      kind: 'available',
      protocol: DISPLAY_FRAME_PROTOCOL,
      sessionId: stream.sessionId,
      streamId: stream.streamId,
      width: stream.width,
      height: stream.height,
      maxFrameBytes: this.maxFrameBytes,
      maxFps: MAX_DISPLAY_FPS,
    });
  }

  #stream(sessionId, streamId) {
    const stream = this.streams.get(sessionId);
    if (!stream || stream.closed || stream.streamId !== streamId) {
      throw displayError('DISPLAY_STREAM_NOT_FOUND', 'Display stream was not found', 404);
    }
    return stream;
  }

  #ownedStream(sessionId, workerId, streamId) {
    const stream = this.#stream(sessionId, streamId);
    if (stream.workerId !== workerId) {
      throw displayError('DISPLAY_WORKER_REPLACED', 'Display stream belongs to a replaced worker', 409);
    }
    return stream;
  }

  #demand(stream, closed = false) {
    return Object.freeze({
      streamId: stream.streamId,
      version: stream.demandVersion,
      interested: closed ? false : stream.interested,
      maxFps: closed || !stream.interested ? 0 : MAX_DISPLAY_FPS,
      closed,
    });
  }

  #sweep(stream) {
    const now = this.now();
    for (const [viewerId, expiresAt] of stream.viewers) {
      if (expiresAt <= now) stream.viewers.delete(viewerId);
    }
    this.#recomputeDemand(stream);
  }

  #recomputeDemand(stream) {
    const now = this.now();
    if (stream.viewers.size > 0) {
      stream.graceUntil = 0;
      this.#setDemand(stream, true);
    } else if (stream.interested) {
      if (!stream.graceUntil) stream.graceUntil = now + this.interestGraceMs;
      if (stream.graceUntil <= now) {
        stream.graceUntil = 0;
        this.#setDemand(stream, false);
      }
    }
    this.#scheduleExpiry(stream);
  }

  #setDemand(stream, interested) {
    if (stream.interested === interested) return;
    stream.interested = interested;
    stream.demandVersion += 1;
    const demand = this.#demand(stream);
    for (const waiter of [...stream.waiters]) waiter.resolve(demand);
  }

  #scheduleExpiry(stream) {
    clearTimeout(stream.expiryTimer);
    stream.expiryTimer = null;
    const deadlines = [...stream.viewers.values()];
    if (stream.viewers.size === 0 && stream.interested && stream.graceUntil) deadlines.push(stream.graceUntil);
    if (!deadlines.length) return;
    const delay = Math.max(1, Math.min(...deadlines) - this.now());
    stream.expiryTimer = setTimeout(() => {
      stream.expiryTimer = null;
      if (this.streams.get(stream.sessionId) === stream && !stream.closed) this.#sweep(stream);
    }, delay);
    stream.expiryTimer.unref?.();
  }

  #close(stream) {
    if (stream.closed) return;
    stream.closed = true;
    if (this.streams.get(stream.sessionId) === stream) this.streams.delete(stream.sessionId);
    clearTimeout(stream.expiryTimer);
    stream.frames.length = 0;
    stream.viewers.clear();
    stream.demandVersion += 1;
    const closed = this.#demand(stream, true);
    for (const waiter of [...stream.waiters]) waiter.resolve(closed);
    for (const listener of stream.subscribers) {
      try { listener(null); } catch { /* Subscribers are lossy. */ }
    }
    stream.subscribers.clear();
  }
}

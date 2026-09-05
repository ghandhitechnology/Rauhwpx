import { createHash, randomUUID } from 'node:crypto';

import { CloudError } from './protocol.mjs';

export const DISPLAY_FRAME_PROTOCOL = 'rauhwpx-frame-v1';
export const DISPLAY_INPUT_PROTOCOL = 'rauhwpx-input-v1';
export const MAX_DISPLAY_FRAME_BYTES = 512 * 1024;
export const MAX_DISPLAY_FPS = 12;
export const MAX_DISPLAY_INPUT_EVENTS_PER_SECOND = 60;
export const MAX_DISPLAY_DIMENSION = 4096;

const DEFAULT_INTEREST_TTL_MS = 20_000;
const DEFAULT_INTEREST_GRACE_MS = 3_000;
const DEFAULT_DEMAND_WAIT_MS = 20_000;
const MAX_QUEUED_INPUT_EVENTS = 256;
const MAX_INPUT_TEXT_BYTES = 4 * 1024;

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

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function coordinate(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= maximum) {
    throw displayError('DISPLAY_INPUT_INVALID', `${label} is outside the active display`);
  }
  return value;
}

function displayInput(value, stream) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw displayError('DISPLAY_INPUT_INVALID', 'Display input event is invalid');
  }
  if (value.kind === 'pointer') {
    if (!['move', 'down', 'up'].includes(value.action)) {
      throw displayError('DISPLAY_INPUT_INVALID', 'Pointer action is invalid');
    }
    const x = coordinate(value.x, 'Pointer x', stream.width);
    const y = coordinate(value.y, 'Pointer y', stream.height);
    if (value.action === 'move') {
      if (!exactKeys(value, ['kind', 'action', 'x', 'y'])) {
        throw displayError('DISPLAY_INPUT_INVALID', 'Pointer move fields are invalid');
      }
      return Object.freeze({ kind: 'pointer', action: 'move', x, y });
    }
    const hasClickCount = Object.hasOwn(value, 'clickCount');
    if (!exactKeys(value, ['kind', 'action', 'x', 'y', 'button', ...(hasClickCount ? ['clickCount'] : [])])
      || hasClickCount && (!Number.isSafeInteger(value.clickCount) || value.clickCount < 1 || value.clickCount > 3)
      || !['left', 'middle', 'right', 'back', 'forward'].includes(value.button)) {
      throw displayError('DISPLAY_INPUT_INVALID', 'Pointer button fields are invalid');
    }
    return Object.freeze({ kind: 'pointer', action: value.action, x, y, button: value.button,
      ...(hasClickCount ? { clickCount: value.clickCount } : {}),
    });
  }
  if (value.kind === 'wheel') {
    if (!exactKeys(value, ['kind', 'x', 'y', 'deltaX', 'deltaY'])
      || !Number.isSafeInteger(value.deltaX) || Math.abs(value.deltaX) > 32_768
      || !Number.isSafeInteger(value.deltaY) || Math.abs(value.deltaY) > 32_768) {
      throw displayError('DISPLAY_INPUT_INVALID', 'Wheel fields are invalid');
    }
    return Object.freeze({
      kind: 'wheel',
      x: coordinate(value.x, 'Wheel x', stream.width),
      y: coordinate(value.y, 'Wheel y', stream.height),
      deltaX: value.deltaX,
      deltaY: value.deltaY,
    });
  }
  if (value.kind === 'key') {
    if (!exactKeys(value, ['kind', 'action', 'key']) || !['down', 'up'].includes(value.action)
      || typeof value.key !== 'string' || !/^[^\u0000-\u001f\u007f]{1,64}$/u.test(value.key)) {
      throw displayError('DISPLAY_INPUT_INVALID', 'Keyboard fields are invalid');
    }
    return Object.freeze({ kind: 'key', action: value.action, key: value.key });
  }
  if (value.kind === 'text') {
    if (!exactKeys(value, ['kind', 'text']) || typeof value.text !== 'string' || !value.text
      || Buffer.byteLength(value.text) > MAX_INPUT_TEXT_BYTES) {
      throw displayError('DISPLAY_INPUT_INVALID', 'Text input is invalid');
    }
    return Object.freeze({ kind: 'text', text: value.text });
  }
  throw displayError('DISPLAY_INPUT_INVALID', 'Display input kind is invalid');
}

function jpegDimensions(bytes, maximum) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw displayError('DISPLAY_FRAME_INVALID', 'Display frame must be a complete JPEG image');
  }
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) {
      throw displayError('DISPLAY_FRAME_INVALID', 'Display JPEG marker structure is invalid');
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) {
      throw displayError('DISPLAY_FRAME_INVALID', 'Display JPEG marker is truncated');
    }
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0xd8) {
      throw displayError('DISPLAY_FRAME_INVALID', 'Display JPEG marker structure is invalid');
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) {
      throw displayError('DISPLAY_FRAME_INVALID', 'Display JPEG segment length is truncated');
    }
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) {
      throw displayError('DISPLAY_FRAME_INVALID', 'Display JPEG segment is truncated');
    }
    const sof = marker >= 0xc0 && marker <= 0xcf
      && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      if (length < 8) throw displayError('DISPLAY_FRAME_INVALID', 'Display JPEG SOF segment is invalid');
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1 || width > maximum || height > maximum) {
        throw displayError('DISPLAY_DIMENSIONS_INVALID', 'JPEG dimensions are outside the supported display bounds');
      }
      return { width, height };
    }
    offset += length;
  }
  throw displayError('DISPLAY_FRAME_INVALID', 'Display JPEG does not contain image dimensions');
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
      controllerKey: null,
      inputEvents: [],
      inputSealed: false,
      inputWaiters: new Set(),
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
    const encoded = jpegDimensions(frameBytes, this.maxDimension);
    if (encoded.width !== stream.width || encoded.height !== stream.height) {
      throw displayError(
        'DISPLAY_FRAME_DIMENSIONS_MISMATCH',
        'JPEG dimensions do not match the authenticated display stream',
      );
    }
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

  setInterest(sessionId, streamId, deviceId, viewerId, active) {
    identifier(deviceId, 'deviceId');
    identifier(viewerId, 'viewerId');
    const stream = this.#stream(sessionId, streamId);
    this.#sweep(stream);
    const viewerKey = JSON.stringify([deviceId, viewerId]);
    let expiresAt = null;
    if (active) {
      if (!stream.viewers.has(viewerKey) && stream.viewers.size >= this.maxViewersPerStream) {
        throw displayError('DISPLAY_VIEWER_LIMIT', 'Too many display viewers are active', 429);
      }
      expiresAt = this.now() + this.interestTtlMs;
      const current = stream.viewers.get(viewerKey);
      stream.viewers.set(viewerKey, {
        expiresAt,
        lastInput: current?.lastInput ?? null,
        inputTimes: current?.inputTimes ?? [],
        receipts: current?.receipts ?? new Map(),
        lastBatch: current?.lastBatch ?? null,
      });
      stream.graceUntil = 0;
    } else {
      stream.viewers.delete(viewerKey);
      this.#releaseController(stream, viewerKey);
    }
    this.#recomputeDemand(stream);
    return {
      streamId,
      interested: Boolean(active),
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      maxFps: active ? MAX_DISPLAY_FPS : 0,
    };
  }

  sendInput(sessionId, streamId, deviceId, viewerId, sequence, value, notify = true) {
    identifier(deviceId, 'deviceId');
    identifier(viewerId, 'viewerId');
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw displayError('DISPLAY_INPUT_SEQUENCE_INVALID', 'Input sequence must be a positive integer');
    }
    const stream = this.#stream(sessionId, streamId);
    this.#sweep(stream);
    if (stream.inputSealed) throw displayError('DISPLAY_INPUT_SEALED', 'Cloud document is being saved for handoff', 409);
    const viewerKey = JSON.stringify([deviceId, viewerId]);
    const viewer = stream.viewers.get(viewerKey);
    if (!viewer || viewer.expiresAt <= this.now()) {
      throw displayError('DISPLAY_INTEREST_REQUIRED', 'Active display interest is required for input', 409);
    }
    if (stream.controllerKey && stream.controllerKey !== viewerKey) {
      throw displayError('DISPLAY_CONTROL_CONFLICT', 'Another viewer controls this display', 409);
    }
    const event = displayInput(value, stream);
    const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    if (viewer.lastInput?.sequence === sequence) {
      if (viewer.lastInput.digest !== digest) {
        throw displayError('DISPLAY_INPUT_SEQUENCE_CONFLICT', 'Input sequence was reused with different content', 409);
      }
      return viewer.lastInput.receipt;
    }
    if (viewer.lastInput && sequence < viewer.lastInput.sequence) {
      throw displayError('DISPLAY_INPUT_SEQUENCE_STALE', 'Input sequence is older than the viewer cursor', 409);
    }
    const now = this.now();
    viewer.inputTimes = viewer.inputTimes.filter((timestamp) => timestamp > now - 1_000);
    if (viewer.inputTimes.length >= MAX_DISPLAY_INPUT_EVENTS_PER_SECOND) {
      throw displayError('DISPLAY_INPUT_RATE_LIMIT', 'Display input rate is too high', 429);
    }
    if (stream.inputEvents.length >= MAX_QUEUED_INPUT_EVENTS) {
      const lossy = stream.inputEvents.findIndex((candidate) => (
        candidate.event.kind === 'pointer' && candidate.event.action === 'move'
      ));
      if (lossy < 0) throw displayError('DISPLAY_INPUT_QUEUE_FULL', 'Display input queue is full', 429);
      stream.inputEvents.splice(lossy, 1);
    }
    stream.controllerKey = viewerKey;
    viewer.inputTimes.push(now);
    stream.demandVersion += 1;
    const acceptedAt = new Date(now).toISOString();
    const queued = Object.freeze(Object.defineProperty({ version: stream.demandVersion, sequence, event }, 'viewerKey', { value: viewerKey }));
    stream.inputEvents.push(queued);
    const receipt = Object.freeze({ streamId, viewerId, sequence, accepted: true, acceptedAt });
    viewer.lastInput = { sequence, digest, receipt };
    if (notify) this.#notifyDemand(stream);
    return receipt;
  }

  sendInputs(sessionId, streamId, deviceId, viewerId, events) {
    if (!Array.isArray(events) || events.length < 1 || events.length > 32) {
      throw displayError('DISPLAY_INPUT_INVALID', 'Input batch must contain 1 to 32 events');
    }
    const stream = this.#stream(sessionId, streamId);
    this.#sweep(stream);
    const key = JSON.stringify([deviceId, viewerId]);
    const viewer = stream.viewers.get(key);
    if (!viewer) throw displayError('DISPLAY_INTEREST_REQUIRED', 'Active display interest is required for input', 409);
    const digest = createHash('sha256').update(JSON.stringify(events)).digest('hex');
    if (viewer.lastBatch?.digest === digest) return viewer.lastBatch.receipts;
    if (events.some((item, index) => !item || !Number.isSafeInteger(item.sequence)
      || index > 0 && item.sequence !== events[index - 1].sequence + 1)) {
      throw displayError('DISPLAY_INPUT_SEQUENCE_INVALID', 'Input batch sequences must be consecutive');
    }
    const previous = { inputEvents: [...stream.inputEvents], controllerKey: stream.controllerKey,
      demandVersion: stream.demandVersion, lastInput: viewer.lastInput, inputTimes: [...viewer.inputTimes] };
    try {
      const receipts = events.map(({ sequence, event }) => this.sendInput(sessionId, streamId, deviceId, viewerId, sequence, event, false));
      viewer.lastBatch = { digest, receipts };
      this.#notifyDemand(stream);
      return receipts;
    } catch (error) {
      Object.assign(stream, { inputEvents: previous.inputEvents, controllerKey: previous.controllerKey, demandVersion: previous.demandVersion });
      viewer.lastInput = previous.lastInput;
      viewer.inputTimes = previous.inputTimes;
      throw error;
    }
  }

  acknowledgeInputs(sessionId, workerId, streamId, results) {
    const stream = this.#ownedStream(sessionId, workerId, streamId);
    if (!Array.isArray(results) || results.length > MAX_QUEUED_INPUT_EVENTS) {
      throw displayError('DISPLAY_INPUT_INVALID', 'Input acknowledgements are invalid');
    }
    for (const result of results) {
      if (!Number.isSafeInteger(result?.version) || typeof result.ok !== 'boolean') {
        throw displayError('DISPLAY_INPUT_INVALID', 'Input acknowledgement is invalid');
      }
      const input = stream.inputEvents.find((candidate) => candidate.version === result.version);
      if (!input?.viewerKey) continue;
      const viewer = stream.viewers.get(input.viewerKey);
      if (!viewer) continue;
      viewer.receipts.set(input.sequence, { sequence: input.sequence, applied: result.ok,
        ...(result.ok ? {} : { error: String(result.error ?? 'Remote input failed').slice(0, 256) }) });
      while (viewer.receipts.size > MAX_QUEUED_INPUT_EVENTS) viewer.receipts.delete(viewer.receipts.keys().next().value);
    }
    for (const notify of [...stream.inputWaiters]) notify();
    return { acknowledged: true };
  }

  waitForInputs(sessionId, streamId, deviceId, viewerId, sequences, { signal, timeoutMs = 2500 } = {}) {
    const stream = this.#stream(sessionId, streamId);
    const key = JSON.stringify([deviceId, viewerId]);
    if (stream.inputWaiters.size >= 32) throw displayError('DISPLAY_INPUT_BACKLOG', 'Too many input confirmations are pending', 429);
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); stream.inputWaiters.delete(check); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(displayError('DISPLAY_INPUT_UNCONFIRMED', 'Cloud input delivery could not be confirmed', 408)); };
      const check = () => {
        if (stream.closed || !stream.viewers.has(key)) { abort(); return; }
        const results = sequences.map((sequence) => stream.viewers.get(key).receipts.get(sequence));
        if (results.every(Boolean)) { cleanup(); resolve(results); }
      };
      timer = setTimeout(abort, timeoutMs);
      stream.inputWaiters.add(check);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
  }

  sealInput(sessionId, workerId, streamId, after) {
    const stream = this.#ownedStream(sessionId, workerId, streamId);
    stream.inputSealed = true;
    return this.#demand(stream, false, after);
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
    stream.inputEvents = stream.inputEvents.filter((event) => event.version > after);
    if (stream.demandVersion > after) return Promise.resolve(this.#demand(stream, false, after));
    if (stream.waiters.size >= 4) {
      throw displayError('DISPLAY_DEMAND_LIMIT', 'Too many display demand requests are pending', 429);
    }
    return new Promise((resolve) => {
      const waiter = {
        after,
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
      waiter.timer = setTimeout(
        () => waiter.resolve(this.#demand(stream, false, after)),
        Math.max(1, Math.min(30_000, timeoutMs)),
      );
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
      inputProtocol: DISPLAY_INPUT_PROTOCOL,
      maxInputEventsPerSecond: MAX_DISPLAY_INPUT_EVENTS_PER_SECOND,
      inputBatchSize: 32,
      supportsClickCount: true,
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

  #demand(stream, closed = false, after = 0) {
    return Object.freeze({
      streamId: stream.streamId,
      version: stream.demandVersion,
      interested: closed ? false : stream.interested,
      maxFps: closed || !stream.interested ? 0 : MAX_DISPLAY_FPS,
      inputEvents: closed
        ? []
        : stream.inputEvents.filter((event) => event.version > after),
      closed,
    });
  }

  #sweep(stream) {
    const now = this.now();
    for (const [viewerId, viewer] of stream.viewers) {
      if (viewer.expiresAt <= now) {
        stream.viewers.delete(viewerId);
        this.#releaseController(stream, viewerId);
      }
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
    this.#notifyDemand(stream);
  }

  #notifyDemand(stream) {
    for (const waiter of [...stream.waiters]) {
      waiter.resolve(this.#demand(stream, false, waiter.after));
    }
  }

  #releaseController(stream, viewerKey) {
    if (stream.controllerKey !== viewerKey) return;
    stream.controllerKey = null;
    if (stream.inputEvents.length >= MAX_QUEUED_INPUT_EVENTS) {
      const lossy = stream.inputEvents.findIndex((candidate) => (
        candidate.event.kind === 'pointer' && candidate.event.action === 'move'
      ));
      stream.inputEvents.splice(lossy < 0 ? 0 : lossy, 1);
    }
    stream.demandVersion += 1;
    stream.inputEvents.push(Object.freeze({
      version: stream.demandVersion,
      sequence: 0,
      event: Object.freeze({ kind: 'reset' }),
    }));
    this.#notifyDemand(stream);
  }

  #scheduleExpiry(stream) {
    clearTimeout(stream.expiryTimer);
    stream.expiryTimer = null;
    const deadlines = [...stream.viewers.values()].map((viewer) => viewer.expiresAt);
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
    for (const notify of [...stream.inputWaiters]) notify();
    if (this.streams.get(stream.sessionId) === stream) this.streams.delete(stream.sessionId);
    clearTimeout(stream.expiryTimer);
    stream.frames.length = 0;
    stream.viewers.clear();
    stream.controllerKey = null;
    stream.inputEvents.length = 0;
    stream.demandVersion += 1;
    for (const waiter of [...stream.waiters]) waiter.resolve(this.#demand(stream, true, waiter.after));
    for (const listener of stream.subscribers) {
      try { listener(null); } catch { /* Subscribers are lossy. */ }
    }
    stream.subscribers.clear();
  }
}

import type {
  CloudDisplayAvailableCapability,
  CloudDisplayCapability,
  CloudDisplayConnectionState,
  CloudDisplayEvent,
  CloudDisplayFrame,
  CloudDisplayFrameMetadata,
  CloudDisplayUnavailableCapability,
  CloudDisplayUnavailableReason,
} from './types.ts';

export const CLOUD_DISPLAY_PROTOCOL = 'rauhwpx-frame-v1' as const;
export const CLOUD_DISPLAY_INPUT_PROTOCOL = 'rauhwpx-input-v1' as const;
export const CLOUD_DISPLAY_MAX_FRAME_BYTES = 524288 as const;
export const CLOUD_DISPLAY_MAX_FPS = 12 as const;
export const CLOUD_DISPLAY_MAX_INPUT_EVENTS_PER_SECOND = 60 as const;

const UNAVAILABLE_REASONS = new Set<CloudDisplayUnavailableReason>([
  'server-unsupported',
  'session-not-running',
  'stream-unavailable',
  'client-unsupported',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    ? value
    : null;
}

function dimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 4096
    ? value
    : null;
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum
    ? value
    : null;
}

function canonicalIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value ? null : value;
}

function expectedFramePath(sessionId: string, streamId: string, sequence: number): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/display/frames/${encodeURIComponent(streamId)}/${sequence}`;
}

export function clientUnsupportedDisplay(sessionId: string): CloudDisplayUnavailableCapability {
  return {
    kind: 'unavailable',
    sessionId,
    reason: 'client-unsupported',
    message: 'This app build does not support live display frames',
    retryable: false,
  };
}

export function parseCloudDisplayCapability(value: unknown): CloudDisplayCapability | null {
  const raw = record(value);
  const sessionId = identifier(raw?.sessionId);
  if (!raw || !sessionId) return null;
  if (raw.kind === 'available') {
    const streamId = identifier(raw.streamId);
    const width = dimension(raw.width);
    const height = dimension(raw.height);
    if (raw.protocol !== CLOUD_DISPLAY_PROTOCOL || !streamId || width === null || height === null
      || raw.reason !== undefined || raw.message !== undefined || raw.retryable !== undefined
      || raw.maxFrameBytes !== CLOUD_DISPLAY_MAX_FRAME_BYTES || raw.maxFps !== CLOUD_DISPLAY_MAX_FPS
      || raw.inputProtocol !== CLOUD_DISPLAY_INPUT_PROTOCOL
      || raw.maxInputEventsPerSecond !== CLOUD_DISPLAY_MAX_INPUT_EVENTS_PER_SECOND
      || raw.supportsClickCount !== undefined && typeof raw.supportsClickCount !== 'boolean'
      || raw.inputBatchSize !== undefined && raw.inputBatchSize !== 32) return null;
    return {
      kind: 'available',
      protocol: CLOUD_DISPLAY_PROTOCOL,
      sessionId,
      streamId,
      width,
      height,
      maxFrameBytes: CLOUD_DISPLAY_MAX_FRAME_BYTES,
      maxFps: CLOUD_DISPLAY_MAX_FPS,
      inputProtocol: CLOUD_DISPLAY_INPUT_PROTOCOL,
      maxInputEventsPerSecond: CLOUD_DISPLAY_MAX_INPUT_EVENTS_PER_SECOND,
      ...(raw.supportsClickCount === true ? { supportsClickCount: true } : {}),
      ...(raw.inputBatchSize === 32 ? { inputBatchSize: 32 as const } : {}),
    };
  }
  if (raw.kind !== 'unavailable' || raw.protocol !== undefined || raw.streamId !== undefined
    || raw.width !== undefined || raw.height !== undefined || raw.maxFrameBytes !== undefined || raw.maxFps !== undefined
    || raw.supportsClickCount !== undefined
    || raw.inputProtocol !== undefined || raw.maxInputEventsPerSecond !== undefined
    || !UNAVAILABLE_REASONS.has(raw.reason as CloudDisplayUnavailableReason)
    || typeof raw.message !== 'string' || !raw.message || typeof raw.retryable !== 'boolean') return null;
  return {
    kind: 'unavailable',
    sessionId,
    reason: raw.reason as CloudDisplayUnavailableReason,
    message: raw.message,
    retryable: raw.retryable,
  };
}

export function parseCloudDisplayFrameMetadata(
  value: unknown,
  expected?: { sessionId?: string; streamId?: string; capability?: CloudDisplayAvailableCapability },
): CloudDisplayFrameMetadata | null {
  const raw = record(value);
  const sessionId = identifier(raw?.sessionId)
    ?? expected?.sessionId
    ?? expected?.capability?.sessionId
    ?? null;
  const streamId = identifier(raw?.streamId);
  const sequence = positiveInteger(raw?.sequence);
  const capturedAt = canonicalIso(raw?.capturedAt);
  const width = dimension(raw?.width);
  const height = dimension(raw?.height);
  const byteLength = positiveInteger(raw?.byteLength, CLOUD_DISPLAY_MAX_FRAME_BYTES);
  const sha256 = typeof raw?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(raw.sha256) ? raw.sha256 : null;
  if (!raw || !sessionId || !streamId || sequence === null || !capturedAt || width === null || height === null
    || raw.mimeType !== 'image/jpeg' || byteLength === null || !sha256
    || raw.protocol !== undefined || raw.maxFrameBytes !== undefined || raw.maxFps !== undefined
    || raw.reason !== undefined || raw.retryable !== undefined
    || raw.framePath !== expectedFramePath(sessionId, streamId, sequence)
    || (expected?.sessionId !== undefined && sessionId !== expected.sessionId)
    || (expected?.streamId !== undefined && streamId !== expected.streamId)
    || (expected?.capability && (
      sessionId !== expected.capability.sessionId
      || streamId !== expected.capability.streamId
      || width !== expected.capability.width
      || height !== expected.capability.height
      || byteLength > expected.capability.maxFrameBytes
    ))) return null;
  return {
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
  };
}

export function parseCloudDisplayFrameEnvelope(
  value: unknown,
  capability: CloudDisplayAvailableCapability,
  verifiedSequence: number,
  eventName: string,
): CloudDisplayFrameMetadata | null {
  const raw = record(value);
  if (!raw || eventName !== 'display.frame' || raw.type !== 'display.frame'
    || raw.sessionId !== capability.sessionId || raw.seq !== verifiedSequence) return null;
  const metadata = parseCloudDisplayFrameMetadata(raw.payload, { capability });
  return metadata?.sequence === verifiedSequence ? metadata : null;
}

export function decodedCloudDisplayFrameMatches(
  frame: Pick<CloudDisplayFrameMetadata, 'width' | 'height'>,
  decoded: { width: number; height: number },
): boolean {
  return dimension(decoded.width) === frame.width && dimension(decoded.height) === frame.height;
}

function parseConnectionState(value: Record<string, unknown>): CloudDisplayConnectionState | null {
  const sessionId = identifier(value.sessionId);
  if (!sessionId || value.kind !== 'connection') return null;
  if (value.state === 'connecting') {
    return value.streamId === null && value.retryable === true
      && value.capability === undefined && value.attempt === undefined
      && value.code === undefined && value.message === undefined
      ? { kind: 'connection', state: 'connecting', sessionId, streamId: null, retryable: true }
      : null;
  }
  if (value.state === 'connected') {
    const capability = parseCloudDisplayCapability(value.capability);
    return capability?.kind === 'available' && capability.sessionId === sessionId
      && value.streamId === capability.streamId && value.retryable === true
      && value.attempt === undefined && value.code === undefined && value.message === undefined
      ? { kind: 'connection', state: 'connected', sessionId, streamId: capability.streamId, retryable: true, capability }
      : null;
  }
  const streamId = value.streamId === null ? null : identifier(value.streamId);
  if (streamId === null && value.streamId !== null) return null;
  if (value.state === 'reconnecting') {
    const attempt = positiveInteger(value.attempt);
    return value.retryable === true && attempt !== null && typeof value.message === 'string' && value.message
      && value.capability === undefined && value.code === undefined
      ? { kind: 'connection', state: 'reconnecting', sessionId, streamId, retryable: true, attempt, message: value.message }
      : null;
  }
  if (value.state === 'failed') {
    return value.retryable === false && typeof value.code === 'string' && value.code
      && typeof value.message === 'string' && value.message
      && value.capability === undefined && value.attempt === undefined
      ? { kind: 'connection', state: 'failed', sessionId, streamId, retryable: false, code: value.code, message: value.message }
      : null;
  }
  return null;
}

export function parseCloudDisplayEvent(
  value: unknown,
  expected?: { sessionId?: string; streamId?: string },
): CloudDisplayEvent | null {
  const raw = record(value);
  if (!raw) return null;
  const capability = raw.kind === 'unavailable' ? parseCloudDisplayCapability(raw) : null;
  if (capability?.kind === 'unavailable') {
    return expected?.sessionId && capability.sessionId !== expected.sessionId ? null : capability;
  }
  if (raw.kind === 'connection') {
    const state = parseConnectionState(raw);
    if (!state || expected?.sessionId && state.sessionId !== expected.sessionId) return null;
    if (state.state !== 'connected' && expected?.streamId && state.streamId && state.streamId !== expected.streamId) return null;
    return state;
  }
  if (raw.kind !== 'frame' || !(raw.bytes instanceof Uint8Array)) return null;
  const metadata = parseCloudDisplayFrameMetadata(raw, expected);
  if (!metadata || raw.bytes.byteLength !== metadata.byteLength) return null;
  return { kind: 'frame', ...metadata, bytes: raw.bytes } satisfies CloudDisplayFrame;
}

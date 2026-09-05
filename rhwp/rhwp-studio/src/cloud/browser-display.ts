import { openDisplayConnection, type CloudDisplayConnectionOptions } from './display-connection.ts';
import { readStreamChunk } from '../../../../desktop/cloud-stream-reader.mjs';
import {
  CLOUD_DISPLAY_MAX_FRAME_BYTES,
  CLOUD_DISPLAY_MAX_FPS,
  parseCloudDisplayCapability,
  parseCloudDisplayFrameEnvelope,
} from './display.ts';
import type {
  CloudDisplayAvailableCapability,
  CloudDisplayConnection,
  CloudDisplayEvent,
  CloudDisplayFrame,
  CloudDisplayFrameMetadata,
  CloudDisplayInputEvent,
} from './types.ts';
import { parseSse, type BrowserRequestContext, type BrowserSseFrame } from './browser-protocol.ts';

const DISPLAY_JSON_BYTES = 64 * 1024;

type BrowserProfileIdentity = { serverPublicKey: string };
type RequestResult = {
  response: Response;
  bytes: Uint8Array | null;
  parsed?: unknown;
  context: BrowserRequestContext;
};
type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
  stream?: boolean;
  maxBytes?: number;
  signal?: AbortSignal;
};
type DisplayError = Error & { code?: string; status?: number; retryable?: boolean };
type DisplayEntry = {
  connectionId: string;
  controller: AbortController;
  connection: CloudDisplayConnection | null;
  opening: Promise<CloudDisplayConnection> | null;
  priorClose: Promise<void>;
  closePromise: Promise<void> | null;
};

function cloudError(message: string, code: string, retryable = false, status = 0): DisplayError {
  return Object.assign(new Error(message), { code, retryable, status });
}

export function createBrowserDisplayManager({
  request,
  profile,
  verifySse,
  sha256,
  randomId,
  options = {},
}: {
  request(pathname: string, options?: RequestOptions): Promise<RequestResult>;
  profile(): BrowserProfileIdentity | null;
  verifySse(frame: BrowserSseFrame, context: BrowserRequestContext, profile: BrowserProfileIdentity): Promise<number>;
  sha256(bytes: Uint8Array): Promise<string>;
  randomId(prefix: string): string;
  options?: CloudDisplayConnectionOptions;
}) {
  let listener: ((event: unknown) => void) | null = null;
  let generation = 0;
  let active: DisplayEntry | null = null;

  const capability = async (sessionId: string, signal: AbortSignal) => {
    try {
      const result = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/display`, {
        signal,
        maxBytes: DISPLAY_JSON_BYTES,
      });
      const parsed = parseCloudDisplayCapability(result.parsed);
      if (!parsed || parsed.sessionId !== sessionId) {
        throw cloudError('Cloud 디스플레이 기능 정보가 잘못됐습니다.', 'DISPLAY_CAPABILITY_INVALID');
      }
      return parsed;
    } catch (rawError) {
      const error = rawError as DisplayError;
      if ((error.status === 404 && error.code === 'NOT_FOUND')
        || (error.status === 501 && error.code === 'DISPLAY_UNSUPPORTED')) {
        return {
          kind: 'unavailable' as const,
          sessionId,
          reason: 'server-unsupported' as const,
          message: 'This Cloud server does not support live display frames',
          retryable: false,
        };
      }
      throw error;
    }
  };

  const interest = async (
    sessionId: string,
    streamId: string,
    viewerId: string,
    activeInterest: boolean,
    signal?: AbortSignal,
  ): Promise<void> => {
    const result = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/display/interest`, {
      method: 'POST',
      body: { streamId, viewerId, active: activeInterest },
      signal,
      maxBytes: DISPLAY_JSON_BYTES,
    });
    const raw = result.parsed && typeof result.parsed === 'object' && !Array.isArray(result.parsed)
      ? result.parsed as Record<string, unknown>
      : null;
    if (!raw) throw cloudError('Cloud 디스플레이 관심 응답이 잘못됐습니다.', 'DISPLAY_INTEREST_INVALID');
    const expiresAt = raw.expiresAt === null
      ? null
      : typeof raw.expiresAt === 'string' ? new Date(raw.expiresAt) : null;
    if (raw.streamId !== streamId || raw.interested !== activeInterest
      || raw.maxFps !== (activeInterest ? CLOUD_DISPLAY_MAX_FPS : 0)
      || (activeInterest && (!expiresAt || Number.isNaN(expiresAt.valueOf()) || expiresAt.toISOString() !== raw.expiresAt))
      || (!activeInterest && raw.expiresAt !== null)) {
      throw cloudError('Cloud 디스플레이 관심 응답이 잘못됐습니다.', 'DISPLAY_INTEREST_INVALID');
    }
  };

  const input = async (
    sessionId: string,
    streamId: string,
    viewerId: string,
    sequence: number,
    event: CloudDisplayInputEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    const result = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/display/input`, {
      method: 'POST',
      body: { streamId, viewerId, sequence, event },
      signal,
      maxBytes: DISPLAY_JSON_BYTES,
    });
    const raw = result.parsed && typeof result.parsed === 'object' && !Array.isArray(result.parsed)
      ? result.parsed as Record<string, unknown>
      : null;
    const acceptedAt = typeof raw?.acceptedAt === 'string' ? new Date(raw.acceptedAt) : null;
    if (!raw || raw.streamId !== streamId || raw.viewerId !== viewerId || raw.sequence !== sequence
      || raw.accepted !== true || !acceptedAt || Number.isNaN(acceptedAt.valueOf())
      || acceptedAt.toISOString() !== raw.acceptedAt) {
      throw cloudError('Cloud 디스플레이 입력 응답이 잘못됐습니다.', 'DISPLAY_INPUT_INVALID');
    }
  };

  const frames = async (
    sessionId: string,
    displayCapability: CloudDisplayAvailableCapability,
    after: number,
    signal: AbortSignal,
    onMetadata: (metadata: CloudDisplayFrameMetadata) => void,
    onFrame?: (frame: CloudDisplayFrame) => void,
  ): Promise<number> => {
    const selectedProfile = profile();
    if (!selectedProfile) throw cloudError('Cloud 페어링이 필요합니다.', 'PAIRING_REQUIRED');
    const pathname = `/v1/sessions/${encodeURIComponent(sessionId)}/display/frames`
      + `?streamId=${encodeURIComponent(displayCapability.streamId)}&after=${encodeURIComponent(after)}`
      + (onFrame ? '&inline=1' : '');
    const stream = await request(pathname, {
      headers: { Accept: 'text/event-stream' },
      stream: true,
      signal,
      maxBytes: DISPLAY_JSON_BYTES,
    });
    if (!stream.response.body
      || !stream.response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')
      || stream.response.headers.get('x-rauhwpx-stream-protocol') !== 'rauhwpx-sse-v1') {
      throw cloudError('Cloud 디스플레이 스트림 증명이 잘못됐습니다.', 'SSE_PROOF_INVALID');
    }
    const reader = stream.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sequence = after;
    try {
      for (;;) {
        const { done, value } = await readStreamChunk(reader);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 2 * 1024 * 1024) {
          throw cloudError('Cloud 디스플레이 이벤트가 너무 큽니다.', 'SSE_PAYLOAD_INVALID');
        }
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          const verified = await verifySse(frame, stream.context, selectedProfile);
          let payload: unknown;
          try { payload = JSON.parse(frame.data); } catch {
            throw cloudError('Cloud 디스플레이 이벤트가 잘못됐습니다.', 'SSE_PAYLOAD_INVALID');
          }
          const envelope = payload as { payload?: Record<string, unknown> };
          const encoded = envelope?.payload?.bytesBase64;
          if (encoded !== undefined) {
            if (!onFrame || typeof encoded !== 'string' || encoded.length > Math.ceil(CLOUD_DISPLAY_MAX_FRAME_BYTES / 3) * 4) {
              throw cloudError('Cloud 화면 데이터가 잘못됐습니다.', 'DISPLAY_FRAME_INTEGRITY_FAILED');
            }
            delete envelope.payload!.bytesBase64;
          }
          const metadata = parseCloudDisplayFrameEnvelope(payload, displayCapability, verified, frame.event);
          if (!metadata) throw cloudError('Cloud 디스플레이 이벤트가 잘못됐습니다.', 'SSE_PAYLOAD_INVALID');
          if (verified <= sequence) continue;
          sequence = verified;
          if (typeof encoded === 'string' && onFrame) {
            let binary: string;
            try { binary = atob(encoded); } catch { throw cloudError('Cloud 화면 데이터가 잘못됐습니다.', 'DISPLAY_FRAME_INTEGRITY_FAILED'); }
            const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
            if (btoa(binary) !== encoded || bytes.byteLength !== metadata.byteLength || await sha256(bytes) !== metadata.sha256) {
              throw cloudError('Cloud 화면 검증에 실패했습니다.', 'DISPLAY_FRAME_INTEGRITY_FAILED');
            }
            onFrame({ kind: 'frame', ...metadata, bytes });
          } else onMetadata(metadata);
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return sequence;
  };

  const frame = async (metadata: CloudDisplayFrameMetadata, signal: AbortSignal) => {
    const expectedPath = `/v1/sessions/${encodeURIComponent(metadata.sessionId)}/display/frames/`
      + `${encodeURIComponent(metadata.streamId)}/${metadata.sequence}`;
    if (metadata.framePath !== expectedPath || metadata.mimeType !== 'image/jpeg'
      || metadata.byteLength < 1 || metadata.byteLength > CLOUD_DISPLAY_MAX_FRAME_BYTES) {
      throw cloudError('Cloud 디스플레이 프레임 정보가 잘못됐습니다.', 'DISPLAY_FRAME_METADATA_INVALID');
    }
    const result = await request(metadata.framePath, {
      signal,
      maxBytes: CLOUD_DISPLAY_MAX_FRAME_BYTES,
    });
    const mimeType = result.response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const declared = Number(result.response.headers.get('content-length'));
    const expectedDigest = result.response.headers.get('x-content-sha256') ?? '';
    const actualDigest = result.bytes ? await sha256(result.bytes) : '';
    if (!result.bytes || mimeType !== 'image/jpeg' || !Number.isSafeInteger(declared)
      || declared !== metadata.byteLength || result.bytes.byteLength !== metadata.byteLength
      || expectedDigest !== metadata.sha256 || actualDigest !== metadata.sha256) {
      throw cloudError('Cloud 디스플레이 프레임 무결성 검증에 실패했습니다.', 'DISPLAY_FRAME_INTEGRITY_FAILED');
    }
    return { kind: 'frame' as const, ...metadata, bytes: result.bytes };
  };

  const closeEntry = (entry: DisplayEntry): Promise<void> => {
    if (entry.closePromise) return entry.closePromise;
    entry.closePromise = (async () => {
      entry.controller.abort();
      await entry.priorClose.catch(() => {});
      const connection = entry.connection ?? await entry.opening?.catch(() => null);
      await connection?.close();
    })();
    return entry.closePromise;
  };

  const closeActive = async (): Promise<void> => {
    generation += 1;
    const entry = active;
    active = null;
    if (entry) await closeEntry(entry);
  };

  return {
    async open(payload: { sessionId: string }) {
      const sessionId = String(payload?.sessionId ?? '');
      const openGeneration = ++generation;
      const previous = active;
      const priorClose = previous ? closeEntry(previous).catch(() => {}) : Promise.resolve();
      const entry: DisplayEntry = {
        connectionId: randomId('display_'),
        controller: new AbortController(),
        connection: null,
        opening: null,
        priorClose,
        closePromise: null,
      };
      active = entry;
      await priorClose;
      if (openGeneration !== generation || active !== entry) {
        await closeEntry(entry);
        throw new DOMException('Cloud display connection was replaced', 'AbortError');
      }
      entry.opening = openDisplayConnection({
        capability: (id, input) => capability(id, input.signal),
        interest: (id, streamId, viewerId, activeInterest, input) => (
          interest(id, streamId, viewerId, activeInterest, input.signal)
        ),
        frames: (id, displayCapability, after, input) => frames(
          id, displayCapability, after, input.signal, input.onMetadata, input.onFrame,
        ),
        frame: (metadata, input) => frame(metadata, input.signal),
        input: (id, streamId, viewerId, sequence, event, inputOptions) => (
          input(id, streamId, viewerId, sequence, event, inputOptions.signal)
        ),
        inputs: async (id, streamId, viewerId, events, { signal }) => {
          const result = await request(`/v1/sessions/${encodeURIComponent(id)}/display/input`, {
            method: 'POST', body: { streamId, viewerId, events }, maxBytes: DISPLAY_JSON_BYTES,
            signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]),
          });
          const value = result.parsed as { streamId?: string; viewerId?: string; results?: Array<{ sequence: number; applied: boolean; error?: string }> };
          if (value?.streamId !== streamId || value?.viewerId !== viewerId || !Array.isArray(value.results)
            || value.results.length !== events.length || value.results.some((item, index) => item.sequence !== events[index].sequence || typeof item.applied !== 'boolean')) {
            throw cloudError('Cloud 입력 확인 응답이 잘못됐습니다.', 'DISPLAY_INPUT_INVALID');
          }
          const failed = value.results.find((item) => !item.applied);
          if (failed) throw cloudError(failed.error || 'Cloud 입력을 적용하지 못했습니다.', 'DISPLAY_INPUT_FAILED');
        },
      }, sessionId, (event: CloudDisplayEvent) => {
        if (active === entry && !entry.controller.signal.aborted) {
          listener?.({ connectionId: entry.connectionId, event });
        }
      }, { ...options, signal: entry.controller.signal });
      try {
        const connection = await entry.opening;
        entry.connection = connection;
        if (openGeneration !== generation || active !== entry || entry.controller.signal.aborted) {
          await closeEntry(entry);
          throw new DOMException('Cloud display connection was replaced', 'AbortError');
        }
        return { connectionId: entry.connectionId, capability: connection.capability };
      } catch (error) {
        if (active === entry) active = null;
        await closeEntry(entry);
        throw error;
      }
    },

    async close(payload: { connectionId: string }) {
      const entry = active;
      if (!entry || entry.connectionId !== payload?.connectionId) return false;
      active = null;
      generation += 1;
      await closeEntry(entry);
      return true;
    },

    async sendInput(payload: { connectionId: string; event: CloudDisplayInputEvent }) {
      const entry = active;
      if (!entry || entry.connectionId !== payload?.connectionId) {
        throw cloudError('Cloud 디스플레이 연결이 바뀌었습니다.', 'DISPLAY_STREAM_REPLACED');
      }
      const connection = entry.connection ?? await entry.opening;
      await connection?.sendInput(payload.event);
      return true;
    },

    closeActive,

    subscribe(callback: (event: unknown) => void) {
      listener = callback;
      return () => {
        if (listener === callback) listener = null;
      };
    },
  };
}

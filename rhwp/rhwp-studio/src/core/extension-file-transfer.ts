import { UNTRUSTED_DOCUMENT_MAX_BYTES } from './document-input-limits.ts';

export const EXTENSION_FETCH_CHUNK_MAX_BYTES = 256 * 1024;
export const REMOTE_PROXY_UNAVAILABLE = 'REMOTE_PROXY_UNAVAILABLE';
export const SERVER_FETCH_REQUIRED = 'SERVER_FETCH_REQUIRED';

export class ExtensionRemoteProxyUnavailableError extends Error {
  readonly code = REMOTE_PROXY_UNAVAILABLE;
  readonly requirement = SERVER_FETCH_REQUIRED;

  constructor() {
    super('확장 프로그램의 원격 프록시를 사용할 수 없습니다. DNS 고정이 가능한 서버/네이티브 가져오기가 필요합니다.');
    this.name = 'ExtensionRemoteProxyUnavailableError';
  }
}

export interface ExtensionMessageRuntime {
  sendMessage(message: Record<string, unknown>): Promise<unknown>;
  getURL?(path: string): string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} response is malformed.`);
  }
  return value as UnknownRecord;
}

function throwRemoteError(response: UnknownRecord): void {
  if ('error' in response) {
    const message = typeof response.error === 'string' && response.error.length > 0
      ? response.error
      : 'Extension document transfer failed.';
    const error = new Error(message) as Error & { code?: string; requirement?: string };
    if (typeof response.code === 'string') error.code = response.code;
    if (typeof response.requirement === 'string') error.requirement = response.requirement;
    throw error;
  }
}

function validTransferId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128;
}

function isSafariRuntime(runtime: ExtensionMessageRuntime): boolean {
  if (typeof runtime.getURL !== 'function') return false;
  try {
    return new URL(runtime.getURL('')).protocol === 'safari-web-extension:';
  } catch {
    return false;
  }
}

function isRemoteHttpUrl(rawUrl: string): boolean {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function readSafariArrayBufferFallback(
  runtime: ExtensionMessageRuntime,
  url: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const response = asRecord(
    await runtime.sendMessage({ type: 'fetch-file', url }),
    'Safari document fetch',
  );
  throwRemoteError(response);
  if (!(response.data instanceof ArrayBuffer)) {
    throw new Error('Safari document fetch returned malformed bytes.');
  }
  if (
    !Number.isSafeInteger(response.data.byteLength)
    || response.data.byteLength <= 0
    || response.data.byteLength > maxBytes
  ) {
    throw new Error(`Remote document exceeds ${maxBytes} bytes.`);
  }
  return new Uint8Array(response.data);
}

/**
 * Reads a privileged extension fetch without cloning the complete document as
 * a JSON number array. The service worker owns the source bytes; the viewer
 * validates its declared size before allocating and accepts only ordered,
 * bounded chunks. Safari retains its already-bounded ArrayBuffer transport.
 */
export async function readExtensionDocumentBytes(
  runtime: ExtensionMessageRuntime,
  url: string,
  maxBytes = UNTRUSTED_DOCUMENT_MAX_BYTES,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('Extension document limit must be a positive safe integer.');
  }
  if (isRemoteHttpUrl(url)) {
    throw new ExtensionRemoteProxyUnavailableError();
  }
  if (isSafariRuntime(runtime)) {
    return readSafariArrayBufferFallback(runtime, url, maxBytes);
  }

  const start = asRecord(
    await runtime.sendMessage({ type: 'fetch-file-start', url }),
    'Document transfer start',
  );

  // Capture a syntactically valid id first so malformed metadata can still be
  // closed in the finally block rather than retained until TTL expiry.
  const transferId = validTransferId(start.transferId) ? start.transferId : null;
  if (!transferId) {
    throwRemoteError(start);
    throw new Error('Document transfer id is malformed.');
  }

  try {
    throwRemoteError(start);
    const byteLength = start.byteLength;
    const chunkBytes = start.chunkBytes;
    const chunkCount = start.chunkCount;
    if (
      !Number.isSafeInteger(byteLength)
      || (byteLength as number) <= 0
      || (byteLength as number) > maxBytes
    ) {
      throw new Error(`Remote document exceeds ${maxBytes} bytes.`);
    }
    if (
      !Number.isSafeInteger(chunkBytes)
      || (chunkBytes as number) <= 0
      || (chunkBytes as number) > EXTENSION_FETCH_CHUNK_MAX_BYTES
    ) {
      throw new Error('Document transfer chunk size is malformed.');
    }
    const expectedChunkCount = Math.ceil((byteLength as number) / (chunkBytes as number));
    if (!Number.isSafeInteger(chunkCount) || chunkCount !== expectedChunkCount) {
      throw new Error('Document transfer chunk count is malformed.');
    }

    // Allocation happens only after every size field has passed the cap and
    // consistency checks above.
    const bytes = new Uint8Array(byteLength as number);
    let offset = 0;

    for (let index = 0; index < (chunkCount as number); index += 1) {
      const response = asRecord(
        await runtime.sendMessage({ type: 'fetch-file-chunk', transferId, index }),
        'Document transfer chunk',
      );
      throwRemoteError(response);

      const expectedLength = Math.min(
        chunkBytes as number,
        (byteLength as number) - offset,
      );
      const expectedDone = index === (chunkCount as number) - 1;
      if (
        response.transferId !== transferId
        || response.index !== index
        || response.offset !== offset
        || response.byteLength !== expectedLength
        || response.done !== expectedDone
      ) {
        throw new Error('Document transfer chunk metadata is malformed or out of order.');
      }

      if (response.data instanceof ArrayBuffer) {
        if (response.data.byteLength !== expectedLength) {
          throw new Error('Document transfer chunk payload size is malformed.');
        }
        bytes.set(new Uint8Array(response.data), offset);
      } else if (Array.isArray(response.data)) {
        if (response.data.length !== expectedLength) {
          throw new Error('Document transfer chunk payload size is malformed.');
        }
        for (let chunkOffset = 0; chunkOffset < response.data.length; chunkOffset += 1) {
          const value = response.data[chunkOffset];
          if (!Number.isInteger(value) || value < 0 || value > 255) {
            throw new Error('Document transfer chunk payload is malformed.');
          }
          bytes[offset + chunkOffset] = value;
        }
      } else {
        throw new Error('Document transfer chunk payload is malformed.');
      }
      offset += expectedLength;
    }

    if (offset !== byteLength) throw new Error('Document transfer ended at the wrong size.');
    return bytes;
  } finally {
    try {
      await runtime.sendMessage({ type: 'fetch-file-close', transferId });
    } catch {
      // The worker may have expired the transfer or restarted. Preserve the
      // original transfer result/error; no bytes remain reachable in that case.
    }
  }
}

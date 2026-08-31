export const MIB = 1024 * 1024;
export const UNTRUSTED_DOCUMENT_MAX_BYTES = 128 * MIB;
export const EXACT_LOCAL_DOCUMENT_MAX_BYTES = 512 * MIB;
// Portable histories are already resident as one archive while IndexedDB
// clones their blobs and WASM parses the current document. Keep that
// multi-consumer path on the renderer-safe envelope even for a local picker.
export const PORTABLE_HISTORY_MAX_BYTES = UNTRUSTED_DOCUMENT_MAX_BYTES;
export const TEMPLATE_DOCUMENT_MAX_BYTES = 20 * MIB;
export const INSERTED_IMAGE_MAX_BYTES = 64 * MIB;
export const STRUCTURED_RESPONSE_MAX_BYTES = 8 * MIB;
export const ERROR_RESPONSE_MAX_BYTES = 64 * 1024;

function byteLimitMessage(label: string, maxBytes: number): string {
  return `${label} 크기는 ${Math.floor(maxBytes / MIB)} MiB를 초과할 수 없습니다.`;
}

export async function cancelResponseBody(response: Response, reason?: unknown): Promise<void> {
  try {
    await response.body?.cancel(reason);
  } catch {
    // A locked body is cancelled through the reader that owns it.
  }
}

export async function readBlobBytesWithLimit(
  blob: Blob,
  maxBytes: number,
  label = '파일',
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > maxBytes) {
    throw new Error(byteLimitMessage(label, maxBytes));
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength !== blob.size || bytes.byteLength > maxBytes) {
    throw new Error(`${label}을 읽는 동안 크기가 변경되었습니다.`);
  }
  return bytes;
}

export async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
  label = '응답',
): Promise<Uint8Array> {
  const declaredText = response.headers.get('content-length');
  if (declaredText !== null) {
    const declared = Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      await cancelResponseBody(response, byteLimitMessage(label, maxBytes));
      throw new Error(byteLimitMessage(label, maxBytes));
    }
  }
  if (!response.body) throw new Error(`${label}을 제한된 스트림으로 읽을 수 없습니다.`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (!(value instanceof Uint8Array)) throw new Error(`${label} 스트림이 올바르지 않습니다.`);
      total += value.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel(byteLimitMessage(label, maxBytes)).catch(() => undefined);
        throw new Error(byteLimitMessage(label, maxBytes));
      }
      chunks.push(value);
    }
  } catch (error) {
    if (!complete) await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

export class ResponseBodyTooLargeError extends Error {
  constructor(label, maxBytes) {
    super(`${label} exceeded the ${maxBytes}-byte response limit`);
    this.name = 'ResponseBodyTooLargeError';
    this.code = 'RESPONSE_BODY_TOO_LARGE';
    this.maxBytes = maxBytes;
  }
}

function contentLength(response) {
  const raw = response?.headers?.get?.('content-length');
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function cancelResponseBody(response, reason) {
  try {
    if (typeof response?.body?.cancel === 'function') {
      await response.body.cancel(reason);
    } else {
      response?.body?.destroy?.();
    }
  } catch {
    // A locked stream is cancelled through its reader below.
  }
}

/**
 * Consume an HTTP response while enforcing an observed-byte limit. Native fetch
 * responses always take the streaming path. The text fallback exists for small
 * injected test doubles whose value is already resident in memory.
 */
export async function readResponseBytesBounded(response, {
  maxBytes = DEFAULT_MAX_BYTES,
  label = 'HTTP response',
  abortController = null,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer');
  }
  const tooLarge = () => new ResponseBodyTooLargeError(label, maxBytes);
  const declared = contentLength(response);
  if (declared !== null && declared > maxBytes) {
    const error = tooLarge();
    abortController?.abort?.(error);
    await cancelResponseBody(response, error);
    throw error;
  }

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          const error = tooLarge();
          abortController?.abort?.(error);
          await reader.cancel(error).catch(() => {});
          throw error;
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }

  if (response?.body?.[Symbol.asyncIterator]) {
    const chunks = [];
    let total = 0;
    try {
      for await (const rawChunk of response.body) {
        const chunk = Buffer.from(rawChunk);
        total += chunk.byteLength;
        if (total > maxBytes) {
          const error = tooLarge();
          abortController?.abort?.(error);
          await cancelResponseBody(response, error);
          throw error;
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) throw error;
      throw error;
    }
    return Buffer.concat(chunks, total);
  }

  if (response?.body == null && typeof response?.text !== 'function'
    && typeof response?.json !== 'function') {
    return Buffer.alloc(0);
  }

  let text;
  if (typeof response?.text === 'function') {
    text = String(await response.text());
  } else {
    text = JSON.stringify(await response.json());
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength > maxBytes) throw tooLarge();
  return bytes;
}

export async function readResponseTextBounded(response, options) {
  return (await readResponseBytesBounded(response, options)).toString('utf8');
}

export async function readResponseJsonBounded(response, options) {
  const text = await readResponseTextBounded(response, options);
  return text.trim() ? JSON.parse(text) : null;
}

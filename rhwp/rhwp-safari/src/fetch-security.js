// Bounded response-body reads for Safari's privileged background fetches.
// This is a classic script because Safari Web Extension background scripts are
// loaded through manifest `scripts`, rather than as ES modules.

'use strict';

(() => {
  const REMOTE_DOCUMENT_MAX_BYTES = 128 * 1024 * 1024;
  const REMOTE_THUMBNAIL_MAX_BYTES = 64 * 1024 * 1024;
  const DEFAULT_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

  class FetchSecurityError extends Error {
    constructor(reason, message) {
      super(message || reason);
      this.name = 'FetchSecurityError';
      this.reason = reason;
    }
  }

  function tooLargeError(maxBytes) {
    return new FetchSecurityError(
      'response-too-large',
      `Document response exceeds ${maxBytes} bytes.`,
    );
  }

  async function cancelResponseBody(response, reason) {
    try {
      await response?.body?.cancel(reason);
    } catch {
      // Preserve the policy error even if the transport cannot be cancelled.
    }
  }

  function resolveDocumentMaxBytes(configuredMaxMiB) {
    const configured = Number(configuredMaxMiB);
    if (!Number.isFinite(configured) || configured <= 0) {
      return DEFAULT_DOCUMENT_MAX_BYTES;
    }
    const requestedBytes = Math.max(1, Math.floor(configured * 1024 * 1024));
    return Math.min(requestedBytes, REMOTE_DOCUMENT_MAX_BYTES);
  }

  async function readResponseBytesWithLimit(response, maxBytes = REMOTE_DOCUMENT_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError('maxBytes must be a positive safe integer.');
    }

    const declaredText = response?.headers?.get?.('content-length');
    if (declaredText !== null && declaredText !== undefined) {
      const declared = Number(declaredText);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
        await cancelResponseBody(response, 'response-too-large');
        throw tooLargeError(maxBytes);
      }
    }

    if (!response?.body || typeof response.body.getReader !== 'function') {
      throw new FetchSecurityError(
        'response-not-streamable',
        'Document response cannot be read as a bounded stream.',
      );
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunkLength = value?.byteLength;
        if (!Number.isSafeInteger(chunkLength) || chunkLength < 0) {
          await reader.cancel('invalid-response-chunk').catch(() => undefined);
          throw new FetchSecurityError(
            'invalid-response-chunk',
            'Document response contained an invalid byte chunk.',
          );
        }

        total += chunkLength;
        if (!Number.isSafeInteger(total) || total > maxBytes) {
          await reader.cancel('response-too-large').catch(() => undefined);
          throw tooLargeError(maxBytes);
        }
        chunks.push(value);
      }
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

  globalThis.RHWPFetchSecurity = Object.freeze({
    cancelResponseBody,
    FetchSecurityError,
    REMOTE_DOCUMENT_MAX_BYTES,
    REMOTE_THUMBNAIL_MAX_BYTES,
    readResponseBytesWithLimit,
    resolveDocumentMaxBytes,
  });
})();

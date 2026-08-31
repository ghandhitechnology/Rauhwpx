// Extension-side document fetch security policy.
//
// Content scripts can observe untrusted web pages. Any URL they pass to the
// service worker must be revalidated here before the extension performs a
// privileged fetch.

import { isDocumentPath, resolveDocumentUrl } from './document-url-resolver.js';
import { DEFAULT_BLOCKED_HOST_SUFFIXES, isBlockedHost } from './private-network.js';

const MAX_REDIRECTS = 5;
export const REMOTE_DOCUMENT_MAX_BYTES = 128 * 1024 * 1024;
export const REMOTE_THUMBNAIL_MAX_BYTES = 64 * 1024 * 1024;

export class FetchSecurityError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = 'FetchSecurityError';
    this.reason = reason;
  }
}

export async function cancelResponseBody(response, reason = 'response-discarded') {
  try {
    await response?.body?.cancel(reason);
  } catch {
    // Preserve the policy error if the transport cannot be cancelled.
  }
}

export async function readResponseBytesWithLimit(response, maxBytes = REMOTE_DOCUMENT_MAX_BYTES) {
  const declaredText = response.headers.get('content-length');
  if (declaredText !== null) {
    const declared = Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      await cancelResponseBody(response, 'response-too-large');
      throw new FetchSecurityError('response-too-large', `Document response exceeds ${maxBytes} bytes.`);
    }
  }
  if (!response.body) {
    throw new FetchSecurityError('response-not-streamable', 'Document response cannot be read as a bounded stream.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel('response-too-large').catch(() => undefined);
        throw new FetchSecurityError('response-too-large', `Document response exceeds ${maxBytes} bytes.`);
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

export function isTrustedExtensionPageSender(sender, runtimeApi, allowedPages = ['viewer.html']) {
  const senderUrl = sender?.url || sender?.tab?.url;
  if (!senderUrl || !runtimeApi?.runtime?.getURL) return false;

  try {
    const parsed = new URL(senderUrl);
    const extensionRoot = new URL(runtimeApi.runtime.getURL(''));
    if (parsed.origin !== extensionRoot.origin) return false;

    return allowedPages.some((page) => {
      const normalized = page.startsWith('/') ? page : `/${page}`;
      return parsed.pathname === normalized || parsed.pathname.endsWith(normalized);
    });
  } catch {
    return false;
  }
}

export function isWebPageSender(sender) {
  const senderUrl = sender?.url || sender?.tab?.url;
  if (!senderUrl || !sender?.tab?.id) return false;

  try {
    const parsed = new URL(senderUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function validateDocumentFetchUrl(url, options = {}) {
  const {
    allowHttp = true,
    requireDocumentPath = false
  } = options;

  if (!url || typeof url !== 'string') {
    throw new FetchSecurityError('invalid-url', 'URL이 비어 있습니다.');
  }

  let parsed;
  try {
    parsed = new URL(resolveDocumentUrl(url));
  } catch {
    throw new FetchSecurityError('invalid-url', 'URL 형식이 올바르지 않습니다.');
  }

  if (parsed.username || parsed.password) {
    throw new FetchSecurityError('userinfo-blocked', '사용자 정보가 포함된 URL은 차단됩니다.');
  }

  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new FetchSecurityError('scheme-blocked', '허용되지 않은 URL scheme입니다.');
  }

  if (isBlockedHostname(parsed.hostname)) {
    throw new FetchSecurityError('private-host-blocked', '로컬 또는 내부 네트워크 URL은 차단됩니다.');
  }

  if (requireDocumentPath && !isDocumentPath(parsed.pathname)) {
    throw new FetchSecurityError('not-document-path', '문서 파일 경로가 아닙니다.');
  }

  return parsed;
}

export async function fetchDocumentWithPolicy(url, options = {}) {
  let current = validateDocumentFetchUrl(url, options);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await fetch(current.href, {
      ...options.fetchOptions,
      credentials: 'omit',
      redirect: 'manual'
    });

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    try {
      if (redirectCount === MAX_REDIRECTS) {
        throw new FetchSecurityError('too-many-redirects', 'redirect 횟수가 너무 많습니다.');
      }
      const location = response.headers.get('Location');
      if (!location) {
        throw new FetchSecurityError('redirect-location-hidden', 'redirect 대상을 검증할 수 없습니다.');
      }
      current = validateDocumentFetchUrl(new URL(location, current.href).href, options);
    } finally {
      await cancelResponseBody(response, 'redirect-response-discarded');
    }
  }

  throw new FetchSecurityError('too-many-redirects', 'redirect 횟수가 너무 많습니다.');
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isBlockedHostname(hostname) {
  return isBlockedHost(hostname, { blockedSuffixes: DEFAULT_BLOCKED_HOST_SUFFIXES });
}

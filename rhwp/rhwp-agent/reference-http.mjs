import crypto from 'node:crypto';

import { normalizeReferenceScope } from './reference-store.mjs';

export const PACKAGED_STUDIO_ORIGIN = 'rauhwpx://app';
const LOCAL_STUDIO_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const CONFIGURED_STUDIO_ORIGINS = configuredStudioOrigins(process.env.RHWP_STUDIO_ORIGINS);

/**
 * Parse an operator-owned, comma-separated allowlist of exact HTTPS origins.
 * This is intentionally stricter than a hostname suffix match: Tailscale and
 * other remote previews must opt in to the one Studio origin they expose.
 */
export function configuredStudioOrigins(value) {
  const origins = new Set();
  for (const candidate of String(value ?? '').split(',')) {
    const raw = candidate.trim();
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) continue;
      origins.add(url.origin);
    } catch {}
  }
  return origins;
}

export function isAllowedStudioOrigin(origin, configured = CONFIGURED_STUDIO_ORIGINS) {
  const normalized = String(origin ?? '');
  return normalized === PACKAGED_STUDIO_ORIGIN
    || LOCAL_STUDIO_ORIGIN.test(normalized)
    || configured.has(normalized);
}

function sendJson(res, status, body, origin = null) {
  const payload = Buffer.from(JSON.stringify(body));
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(payload);
}

function bearerMatchesAny(req, tokens) {
  const header = String(req.headers.authorization ?? '');
  if (!header.startsWith('Bearer ')) return false;
  const received = Buffer.from(header.slice(7), 'utf8');
  return (Array.isArray(tokens) ? tokens : [tokens]).some((token) => {
    if (!token) return false;
    const expected = Buffer.from(String(token), 'utf8');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  });
}

/**
 * 요청한 (scope, scopeId) 가 인증된 세션의 참조 범위 안에 있는지 확인한다.
 * 세션 스코프 토큰만으로는 다른 채팅/문서 스코프를 넘볼 수 없어야 한다.
 */
function assertScopeAllowed(scope, scopeId, allowedScopes) {
  const normalized = normalizeReferenceScope(scope, scopeId);
  const key = `${normalized.scope}:${normalized.scope === 'global' ? 'global' : normalized.scopeId}`;
  const allowed = new Set((allowedScopes ?? []).map((item) => (
    `${item.scope}:${item.scope === 'global' ? 'global' : item.scopeId}`
  )));
  if (!allowed.has(key)) {
    throw Object.assign(new Error('Requested reference scope is outside this session'), {
      code: 'REFERENCE_SCOPE_FORBIDDEN',
    });
  }
  return normalized;
}

function errorStatus(error) {
  switch (error?.code) {
    case 'REFERENCE_NOT_FOUND': return 404;
    case 'REFERENCE_STAGE_NOT_FOUND': return 404;
    case 'REFERENCE_STAGE_EXPIRED': return 410;
    case 'REFERENCE_TYPE_UNSUPPORTED':
    case 'REFERENCE_TYPE_MISMATCH': return 415;
    case 'REFERENCE_FILE_TOO_LARGE':
    case 'REFERENCE_SCOPE_SIZE_LIMIT':
    case 'REFERENCE_GLOBAL_SIZE_LIMIT':
    case 'REFERENCE_GLOBAL_EXTRACTED_LIMIT':
    case 'REFERENCE_INDEX_TOO_LARGE':
    case 'REFERENCE_METADATA_TOO_LARGE':
    case 'REFERENCE_QUERY_TOO_LARGE': return 413;
    case 'REFERENCE_SCOPE_FORBIDDEN': return 403;
    case 'REFERENCE_FILE_COUNT_LIMIT':
    case 'REFERENCE_GLOBAL_FILE_COUNT_LIMIT':
    case 'REFERENCE_METADATA_RECORD_LIMIT':
    case 'REFERENCE_SCOPE_BUSY': return 409;
    case 'REFERENCE_EXTRACTION_TIMEOUT': return 504;
    case 'REFERENCE_EXTRACTOR_UNAVAILABLE': return 503;
    case 'REFERENCE_STORE_CORRUPT': return 500;
    // Known validation faults are client errors; anything unexpected (missing
    // store artifacts, allocation conflicts, disk faults) is a server fault
    // and must not read as a 400.
    case 'REFERENCE_ID_INVALID':
    case 'REFERENCE_NAME_INVALID':
    case 'REFERENCE_SCOPE_ID_INVALID':
    case 'REFERENCE_SCOPE_ID_REQUIRED':
    case 'REFERENCE_SCOPE_INVALID':
    case 'REFERENCE_QUERY_REQUIRED':
    case 'REFERENCE_TYPE_REQUIRED':
    case 'REFERENCE_FILE_EMPTY':
    case 'REFERENCE_EMPTY_TEXT':
    case 'REFERENCE_SIZE_MISMATCH': return 400;
    case 'REFERENCE_NOT_TEXT':
    case 'REFERENCE_NOT_IMAGE': return 415;
    default: return 500;
  }
}

function decodeUploadName(header) {
  const raw = String(header ?? '');
  if (!raw) return '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function isReferencePath(pathname) {
  return pathname === '/reference-files'
    || pathname === '/reference-staging'
    || pathname === '/reference-search'
    || pathname.startsWith('/reference-files/')
    || pathname.startsWith('/reference-staging/');
}

/**
 * Build the loopback reference HTTP API. Returns true when a request was owned
 * by this router and false so the hub can continue to its other routes.
 *
 * `tokens` holds the credentials acceptable for the authenticated session
 * (its scoped token, plus the master token outside production). The request's
 * own bearer value is never trusted by itself.
 */
export function createReferenceHttpHandler({ store, tokens, allowedScopes }) {
  return async function handleReferenceHttp(req, res, url) {
    if (!isReferencePath(url.pathname)) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (origin && !isAllowedStudioOrigin(origin)) {
      req.resume?.();
      const message = 'Reference API accepts only local Studio origins';
      sendJson(res, 403, { status: 'error', message, error: { code: 'REFERENCE_ORIGIN_DENIED', message } });
      return true;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type, X-File-Name',
        'access-control-max-age': '600',
      });
      res.end();
      return true;
    }
    if (!bearerMatchesAny(req, tokens)) {
      req.resume?.();
      const message = 'A valid bearer token is required';
      sendJson(res, 401, { status: 'error', message, error: { code: 'REFERENCE_UNAUTHORIZED', message } }, origin);
      return true;
    }
    try {
      // /reference-staging 은 chat 전용이다. store 가 staging 항목을 chat 으로
      // 저장하므로 document/global 을 허용하면 성공 응답 뒤 승격할 수 없게 된다.
      const isStagingPath = url.pathname === '/reference-staging' || url.pathname.startsWith('/reference-staging/');
      const rawScope = isStagingPath
        ? (url.searchParams.get('scope') ?? 'chat')
        : url.searchParams.get('scope');
      if (isStagingPath && rawScope !== 'chat') {
        throw Object.assign(new Error('Reference staging accepts only chat scope'), {
          code: 'REFERENCE_SCOPE_FORBIDDEN',
        });
      }
      const scopeId = url.searchParams.get('scopeId');
      const resolvedScope = assertScopeAllowed(rawScope, rawScope === 'global' ? 'global' : scopeId, allowedScopes);
      if (req.method === 'POST' && url.pathname === '/reference-staging') {
        const result = await store.stageStream({
          stream: req,
          name: decodeUploadName(req.headers['x-file-name']),
          mimeType: req.headers['content-type'],
          contentLength: req.headers['content-length'],
          scopeId: resolvedScope.scope === 'global' ? 'global' : resolvedScope.scopeId,
        });
        sendJson(res, 201, { staged: result, error: null }, origin);
        return true;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/reference-staging/')) {
        const stageId = decodeURIComponent(url.pathname.slice('/reference-staging/'.length));
        const result = await store.discardStaged({ stageId, scopeId: resolvedScope.scopeId });
        sendJson(res, 200, { status: 'deleted', staged: result }, origin);
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/reference-files') {
        const result = await store.addStream({
          stream: req,
          name: decodeUploadName(req.headers['x-file-name']),
          mimeType: req.headers['content-type'],
          contentLength: req.headers['content-length'],
          scope: resolvedScope.scope,
          scopeId: resolvedScope.scopeId,
        });
        sendJson(res, 201, { ...result, error: null }, origin);
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/reference-files') {
        const files = store.list({ scope: resolvedScope.scope, scopeId: resolvedScope.scopeId });
        sendJson(res, 200, { status: 'ready', scope: resolvedScope.scope, scopeId: resolvedScope.scope === 'global' ? 'global' : resolvedScope.scopeId, files }, origin);
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/reference-search') {
        const query = url.searchParams.get('q') ?? '';
        if (!query.trim()) {
          const error = new Error('q is required');
          error.code = 'REFERENCE_QUERY_REQUIRED';
          throw error;
        }
        const rawLimit = Number(url.searchParams.get('maxResults') ?? url.searchParams.get('limit') ?? 8);
        const maxResults = Number.isSafeInteger(rawLimit) ? Math.min(20, Math.max(1, rawLimit)) : 8;
        const scopes = [resolvedScope];
        await store.activateScopes(scopes);
        const results = store.search({ query, scopes, maxResults });
        sendJson(res, 200, { status: 'ready', query, results }, origin);
        return true;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/reference-files/')) {
        const fileId = decodeURIComponent(url.pathname.slice('/reference-files/'.length));
        if (!fileId || fileId.length > 128 || /[\u0000-\u001f\u007f/]/.test(fileId)) {
          const error = new Error('Invalid reference file id');
          error.code = 'REFERENCE_ID_INVALID';
          throw error;
        }
        const file = await store.readFile({
          fileId,
          scope: resolvedScope.scope,
          scopeId: resolvedScope.scopeId,
        });
        const encodedName = encodeURIComponent(file.name);
        const asciiName = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        res.writeHead(200, {
          'content-type': file.mimeType,
          'content-length': String(file.bytes.length),
          'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
          'cache-control': 'no-store, private',
          'x-content-type-options': 'nosniff',
          'x-content-sha256': file.sha256,
          ...(origin ? {
            'access-control-allow-origin': origin,
            'access-control-expose-headers': 'Content-Disposition, Content-Length, X-Content-SHA256',
            vary: 'Origin',
          } : {}),
        });
        res.end(file.bytes);
        return true;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/reference-files/')) {
        const fileId = decodeURIComponent(url.pathname.slice('/reference-files/'.length));
        if (!fileId || fileId.length > 128 || /[\u0000-\u001f\u007f/]/.test(fileId)) {
          const error = new Error('Invalid reference file id');
          error.code = 'REFERENCE_ID_INVALID';
          throw error;
        }
        const result = await store.remove({ fileId, scope: resolvedScope.scope, scopeId: resolvedScope.scopeId });
        sendJson(res, 200, { status: 'deleted', file: result }, origin);
        return true;
      }
      const message = 'Method not allowed';
      sendJson(res, 405, { status: 'error', message, error: { code: 'REFERENCE_METHOD_NOT_ALLOWED', message } }, origin);
      return true;
    } catch (error) {
      // Drain an oversized/invalid raw request so keep-alive state cannot carry
      // unread bytes into the next request. The response remains deterministic.
      try { req.resume?.(); } catch {}
      const message = String(error?.message ?? error);
      sendJson(res, errorStatus(error), {
        status: 'error',
        message,
        error: { code: error?.code ?? 'REFERENCE_REQUEST_FAILED', message },
      }, origin);
      return true;
    }
  };
}

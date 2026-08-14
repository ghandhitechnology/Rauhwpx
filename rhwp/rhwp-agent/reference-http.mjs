import crypto from 'node:crypto';

const LOCAL_STUDIO_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

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

function bearerMatches(req, token) {
  const header = String(req.headers.authorization ?? '');
  if (!header.startsWith('Bearer ')) return false;
  const received = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(String(token), 'utf8');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function errorStatus(error) {
  switch (error?.code) {
    case 'REFERENCE_NOT_FOUND': return 404;
    case 'REFERENCE_STAGE_NOT_FOUND': return 404;
    case 'REFERENCE_STAGE_EXPIRED': return 410;
    case 'REFERENCE_TYPE_UNSUPPORTED':
    case 'REFERENCE_TYPE_MISMATCH': return 415;
    case 'REFERENCE_FILE_TOO_LARGE':
    case 'REFERENCE_SCOPE_SIZE_LIMIT': return 413;
    case 'REFERENCE_FILE_COUNT_LIMIT': return 409;
    case 'REFERENCE_EXTRACTION_TIMEOUT': return 504;
    case 'REFERENCE_EXTRACTOR_UNAVAILABLE': return 503;
    case 'REFERENCE_STORE_CORRUPT': return 500;
    default: return 400;
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
 */
export function createReferenceHttpHandler({ store, token }) {
  return async function handleReferenceHttp(req, res, url) {
    if (!isReferencePath(url.pathname)) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (origin && !LOCAL_STUDIO_ORIGIN.test(origin)) {
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
    if (!bearerMatches(req, token)) {
      req.resume?.();
      const message = 'A valid bearer token is required';
      sendJson(res, 401, { status: 'error', message, error: { code: 'REFERENCE_UNAUTHORIZED', message } }, origin);
      return true;
    }
    try {
      const scope = url.searchParams.get('scope');
      const scopeId = url.searchParams.get('scopeId');
      if (req.method === 'POST' && url.pathname === '/reference-staging') {
        const result = await store.stageStream({
          stream: req,
          name: decodeUploadName(req.headers['x-file-name']),
          mimeType: req.headers['content-type'],
          contentLength: req.headers['content-length'],
          scopeId,
        });
        sendJson(res, 201, { staged: result, error: null }, origin);
        return true;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/reference-staging/')) {
        const stageId = decodeURIComponent(url.pathname.slice('/reference-staging/'.length));
        const result = await store.discardStaged({ stageId, scopeId });
        sendJson(res, 200, { status: 'deleted', staged: result }, origin);
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/reference-files') {
        const result = await store.addStream({
          stream: req,
          name: decodeUploadName(req.headers['x-file-name']),
          mimeType: req.headers['content-type'],
          contentLength: req.headers['content-length'],
          scope,
          scopeId,
        });
        sendJson(res, 201, { ...result, error: null }, origin);
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/reference-files') {
        const files = store.list({ scope, scopeId });
        sendJson(res, 200, { status: 'ready', scope: scope === 'global' ? 'global' : scope, scopeId: scope === 'global' ? 'global' : scopeId, files }, origin);
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
        const scopes = [{ scope, scopeId }];
        const results = store.search({ query, scopes, maxResults });
        sendJson(res, 200, { status: 'ready', query, results }, origin);
        return true;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/reference-files/')) {
        const fileId = decodeURIComponent(url.pathname.slice('/reference-files/'.length));
        if (!fileId || fileId.length > 128 || /[\u0000-\u001f\u007f/]/.test(fileId)) {
          const error = new Error('Invalid reference file id');
          error.code = 'REFERENCE_ID_INVALID';
          throw error;
        }
        const result = await store.remove({ fileId, scope, scopeId });
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

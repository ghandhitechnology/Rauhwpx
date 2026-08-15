import crypto from 'node:crypto';
import { isAllowedStudioOrigin } from './reference-http.mjs';

function bearerMatches(req, token) {
  const header = String(req.headers.authorization ?? '');
  if (!header.startsWith('Bearer ')) return false;
  const received = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(String(token), 'utf8');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function cors(origin) {
  return origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
}

function sendJson(res, status, body, origin = null) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    ...cors(origin),
  });
  res.end(payload);
}

function errorStatus(code) {
  if (code === 'TEMPLATE_NOT_FOUND') return 404;
  if (code === 'TEMPLATE_FILE_TOO_LARGE') return 413;
  if (code === 'TEMPLATE_TYPE_UNSUPPORTED' || code === 'TEMPLATE_TYPE_MISMATCH') return 415;
  if (code === 'TEMPLATE_NAME_CONFLICT') return 409;
  if (code === 'TEMPLATE_STORE_CORRUPT' || code === 'TEMPLATE_BLOB_MISSING') return 500;
  return 400;
}

function decodeHeader(value) {
  try { return decodeURIComponent(String(value ?? '')); } catch { return String(value ?? ''); }
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body is too large.'), { code: 'TEMPLATE_REQUEST_INVALID' });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { code: 'TEMPLATE_REQUEST_INVALID' }); }
}

function uploadMetadata(req) {
  return {
    name: decodeHeader(req.headers['x-template-name']),
    originalName: decodeHeader(req.headers['x-file-name']),
    format: String(req.headers['x-template-format'] ?? ''),
    pageCount: Number(req.headers['x-template-page-count']),
    sectionCount: Number(req.headers['x-template-section-count']),
    contentLength: req.headers['content-length'],
  };
}

function isTemplatePath(pathname) {
  return pathname === '/templates' || pathname.startsWith('/templates/');
}

export function createTemplateHttpHandler({ store, token, onChanged = () => {} }) {
  return async function handleTemplateHttp(req, res, url) {
    if (!isTemplatePath(url.pathname)) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (origin && !isAllowedStudioOrigin(origin)) {
      req.resume?.();
      sendJson(res, 403, { error: { code: 'TEMPLATE_ORIGIN_DENIED', message: 'Template API accepts only local Studio origins.' } });
      return true;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors(origin),
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type, X-File-Name, X-Template-Name, X-Template-Format, X-Template-Page-Count, X-Template-Section-Count',
        'access-control-max-age': '600',
      });
      res.end();
      return true;
    }
    if (!bearerMatches(req, token)) {
      req.resume?.();
      sendJson(res, 401, { error: { code: 'TEMPLATE_UNAUTHORIZED', message: 'A valid bearer token is required.' } }, origin);
      return true;
    }
    try {
      if (req.method === 'GET' && url.pathname === '/templates') {
        sendJson(res, 200, store.list(), origin);
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/templates') {
        const template = await store.addStream({ stream: req, ...uploadMetadata(req) });
        onChanged({ type: 'added', template });
        sendJson(res, 201, { template, catalog: store.list() }, origin);
        return true;
      }
      const match = url.pathname.match(/^\/templates\/([^/]+)(?:\/(content))?$/);
      if (!match) throw Object.assign(new Error('Template route was not found.'), { code: 'TEMPLATE_NOT_FOUND' });
      const id = decodeURIComponent(match[1]);
      if (req.method === 'GET' && match[2] === 'content') {
        const { metadata, bytes } = await store.read(id);
        res.writeHead(200, {
          'content-type': metadata.format === 'hwp' ? 'application/x-hwp' : 'application/hwp+zip',
          'content-length': String(bytes.length),
          'cache-control': 'no-store',
          'x-template-revision': String(metadata.revision),
          // Studio must be able to read the revision before loading the binary.
          // Without this, Chromium hides the custom header and null becomes 0.
          'access-control-expose-headers': 'X-Template-Revision',
          ...cors(origin),
        });
        res.end(bytes);
        return true;
      }
      if (req.method === 'PATCH' && !match[2]) {
        const body = await readJsonBody(req);
        const template = await store.rename(id, body.name);
        onChanged({ type: 'renamed', template });
        sendJson(res, 200, { template, catalog: store.list() }, origin);
        return true;
      }
      if (req.method === 'PUT' && !match[2]) {
        const template = await store.replaceStream(id, { stream: req, ...uploadMetadata(req) });
        onChanged({ type: 'replaced', template });
        sendJson(res, 200, { template, catalog: store.list() }, origin);
        return true;
      }
      if (req.method === 'DELETE' && !match[2]) {
        const template = await store.delete(id);
        onChanged({ type: 'deleted', template });
        sendJson(res, 200, { template, catalog: store.list() }, origin);
        return true;
      }
      sendJson(res, 405, { error: { code: 'TEMPLATE_METHOD_NOT_ALLOWED', message: 'Method not allowed.' } }, origin);
      return true;
    } catch (error) {
      try { req.resume?.(); } catch {}
      const code = error?.code ?? 'TEMPLATE_REQUEST_FAILED';
      sendJson(res, errorStatus(code), { error: { code, message: String(error?.message ?? error) } }, origin);
      return true;
    }
  };
}

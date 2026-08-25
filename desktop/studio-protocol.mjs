import { existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STUDIO_SCHEME = 'rauhwpx';
export const STUDIO_HOST = 'app';
export const STUDIO_URL = `${STUDIO_SCHEME}://${STUDIO_HOST}/index.html`;

export function resolveDevelopmentUrl({ packaged, rawUrl }) {
  if (packaged || typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  const url = new URL(rawUrl.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('RHWP_DEV_URL must use http or https');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('RHWP_DEV_URL must use a loopback host');
  }
  return url.href;
}

export function resolveStudioAsset(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const candidate = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const base = resolve(root);
  return candidate === base || candidate.startsWith(`${base}${sep}`) ? candidate : null;
}

// 데스크톱 Studio 문서에 적용하는 CSP. 확장 빌드(viewer.html)는 manifest CSP 를
// 따라가므로 여기엔 영향이 없다. hub 는 ws://127.0.0.1:<port> 로 접속한다.
const STUDIO_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

export function registerStudioScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: STUDIO_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

export function installStudioProtocol({ protocol, net, root }) {
  const indexPath = resolve(root, 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error(`Studio build is missing (${root}). Run npm run build:studio first.`);
  }

  protocol.handle(STUDIO_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== STUDIO_HOST || request.method !== 'GET') {
      return new Response('Not found', { status: 404 });
    }
    const requested = resolveStudioAsset(root, url.pathname);
    if (!requested) return new Response('Forbidden', { status: 403 });
    const file = existsSync(requested) && statSync(requested).isFile()
      ? requested
      : (extname(requested) ? null : indexPath);
    if (!file) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set('content-security-policy', STUDIO_CSP);
    headers.set('x-content-type-options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  });
}

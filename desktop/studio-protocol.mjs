import { existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STUDIO_SCHEME = 'rauhwpx';
export const STUDIO_HOST = 'app';
export const STUDIO_URL = `${STUDIO_SCHEME}://${STUDIO_HOST}/index.html`;

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

  protocol.handle(STUDIO_SCHEME, (request) => {
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
    return net.fetch(pathToFileURL(file).toString());
  });
}

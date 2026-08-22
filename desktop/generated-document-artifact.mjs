import { basename, extname } from 'node:path';

export const MAX_GENERATED_DOCUMENT_BYTES = 64 * 1024 * 1024;

function httpHubOrigin(hubUrl) {
  const url = new URL(String(hubUrl ?? ''));
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Agent hub URL is unavailable');
  }
  return url.origin;
}

/** Bind a renderer request to its own hub, session, artifact id, and filename. */
export function resolveGeneratedDocumentArtifact(payload, { hubUrl, sessionId } = {}) {
  const fileName = String(payload?.fileName ?? '');
  const extension = extname(fileName).toLowerCase();
  if (!fileName || basename(fileName) !== fileName || !['.hwp', '.hwpx'].includes(extension)
    || fileName.includes('\0')) {
    throw new Error('Generated document must have a safe HWP or HWPX filename');
  }

  let url;
  try {
    url = new URL(String(payload?.downloadUrl ?? ''));
  } catch {
    throw new Error('Generated document URL is invalid');
  }
  if (url.origin !== httpHubOrigin(hubUrl) || url.username || url.password || url.hash) {
    throw new Error('Generated document URL does not belong to this app');
  }
  const match = url.pathname.match(/^\/artifacts\/([A-Za-z0-9_-]{16,128})\/([^/]+)$/u);
  if (!match || url.searchParams.get('sessionId') !== sessionId || !url.searchParams.get('token')) {
    throw new Error('Generated document URL does not belong to this window session');
  }
  let pathFileName;
  try {
    pathFileName = decodeURIComponent(match[2]);
  } catch {
    throw new Error('Generated document URL contains an invalid filename');
  }
  if (pathFileName !== fileName) {
    throw new Error('Generated document URL filename does not match the requested document');
  }
  return Object.freeze({ downloadUrl: url.href, fileName });
}

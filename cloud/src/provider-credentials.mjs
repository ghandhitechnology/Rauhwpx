import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CloudError, PROVIDERS } from './protocol.mjs';

export const PROVIDER_AUTH_FILES = Object.freeze({
  claude: Object.freeze(['.claude.json', '.claude/.credentials.json']),
  codex: Object.freeze(['.codex/auth.json']),
  pi: Object.freeze([]),
  grok: Object.freeze(['.grok/auth.json', 'auth.json']),
  cursor: Object.freeze(['.cursor/cli-config.json']),
});

export const PROVIDER_KEY_NAMES = Object.freeze({
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  pi: 'OPENROUTER_API_KEY',
  grok: 'XAI_API_KEY',
  cursor: 'CURSOR_API_KEY',
});

export const PROVIDER_KEY_ENV = Object.freeze({
  claude: 'RAUHWpx_PROVIDER_KEY_CLAUDE',
  codex: 'RAUHWpx_PROVIDER_KEY_CODEX',
  grok: 'RAUHWpx_PROVIDER_KEY_GROK',
  pi: 'RAUHWpx_PROVIDER_KEY_PI',
  cursor: 'RAUHWpx_PROVIDER_KEY_CURSOR',
});

export const PROVIDER_SESSION_ENV = 'RAUHWpx_PROVIDER_SESSION';
export const MAX_PROVIDER_SESSION_BYTES = 256 * 1024;
export const MAX_AUTH_FILE_BYTES = 64 * 1024;

export function assertProviderName(provider) {
  if (!PROVIDERS.includes(provider)) throw new CloudError('INVALID_PROVIDER', 'Provider is not supported');
  return provider;
}

export function normalizeAuthPath(provider, relativePath) {
  const allowed = PROVIDER_AUTH_FILES[assertProviderName(provider)];
  const normalized = String(relativePath ?? '').replaceAll('\\', '/');
  if (!allowed.includes(normalized)) {
    throw new CloudError('INVALID_CREDENTIAL', 'Provider auth path is not allowed', 400);
  }
  return normalized;
}

export function hasProviderAuth(auth) {
  return Boolean(auth?.apiKey || auth?.files?.length);
}

export function writeProviderAuthFiles(providerAuthDirectory, provider, files) {
  assertProviderName(provider);
  if (!Array.isArray(files) || files.length === 0) return [];
  const root = path.join(providerAuthDirectory, provider);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const written = [];
  for (const file of files) {
    const relative = normalizeAuthPath(provider, file.path ?? file.relativePath);
    const content = String(file.content ?? '');
    if (!content || Buffer.byteLength(content) > MAX_AUTH_FILE_BYTES) {
      throw new CloudError('INVALID_CREDENTIAL', 'Provider auth file is invalid', 400);
    }
    const destination = path.join(root, relative);
    const relativeToRoot = path.relative(root, destination);
    if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new CloudError('INVALID_CREDENTIAL', 'Provider auth path is not allowed', 400);
    }
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      if (lstatSync(destination).isSymbolicLink()) {
        throw new CloudError('PROVIDER_STATE_UNSAFE', 'Provider auth path is a symlink', 500);
      }
    } catch (error) {
      if (error.code === 'PROVIDER_STATE_UNSAFE') throw error;
      if (error.code !== 'ENOENT') throw error;
    }
    writeFileSync(destination, content, { encoding: 'utf8', mode: 0o600 });
    written.push(relative);
  }
  return written;
}

function normalizeFiles(provider, files) {
  if (!Array.isArray(files)) return [];
  return files.map((file) => ({
    path: normalizeAuthPath(provider, file.path ?? file.relativePath),
    content: String(file.content ?? ''),
  }));
}

export function normalizeProviderSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 1) {
    throw new CloudError('INVALID_CREDENTIAL', 'Provider session is invalid', 400);
  }
  const items = Array.isArray(value.providers)
    ? value.providers
    : [{ provider: value.provider, files: value.files }];
  return {
    v: 1,
    providers: items.map((item) => {
      const provider = assertProviderName(item?.provider);
      return { provider, files: normalizeFiles(provider, item.files) };
    }),
  };
}

export function parseProviderSession(encoded) {
  if (encoded == null || encoded === '') return null;
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_PROVIDER_SESSION_BYTES) {
    throw new CloudError('INVALID_CREDENTIAL', 'Provider session is too large', 400);
  }
  try {
    return normalizeProviderSession(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError('INVALID_CREDENTIAL', 'Provider session is invalid', 400);
  }
}

export function encodeProviderSession(auth) {
  const providers = (Array.isArray(auth) ? auth : [auth])
    .filter((item) => item?.files?.length)
    .map((item) => ({
      provider: assertProviderName(item.provider),
      files: normalizeFiles(item.provider, item.files),
    }));
  if (!providers.length) return null;
  const encoded = Buffer.from(JSON.stringify({ v: 1, providers })).toString('base64url');
  if (Buffer.byteLength(encoded) > MAX_PROVIDER_SESSION_BYTES) {
    throw new CloudError('INVALID_CREDENTIAL', 'Provider session is too large', 400);
  }
  return encoded;
}

export function parseProviderCredentialBody(provider, body) {
  const name = assertProviderName(provider);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CloudError('INVALID_REQUEST', 'body must be an object');
  }
  const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : null;
  const files = normalizeFiles(name, body.files);
  if (!apiKey && files.length === 0) {
    throw new CloudError('PROVIDER_KEY_REQUIRED', `${name} credentials are required`, 400);
  }
  return { provider: name, apiKey, files };
}

export function sandboxCredentialVariables(auth) {
  const items = (Array.isArray(auth) ? auth : [auth]).filter(Boolean);
  const variables = {};
  const withFiles = [];
  for (const item of items) {
    if (!item?.provider) continue;
    if (item.apiKey) {
      const envName = PROVIDER_KEY_ENV[item.provider];
      if (envName) variables[envName] = item.apiKey;
    }
    if (item.files?.length) withFiles.push(item);
  }
  const session = encodeProviderSession(withFiles);
  if (session) variables[PROVIDER_SESSION_ENV] = session;
  return variables;
}

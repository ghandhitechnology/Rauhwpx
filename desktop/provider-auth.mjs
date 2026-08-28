import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppServerError } from './cloud-app-server.mjs';

export const PROVIDER_AUTH_FILES = Object.freeze({
  claude: Object.freeze(['.claude.json', '.claude/.credentials.json']),
  codex: Object.freeze(['.codex/auth.json']),
  pi: Object.freeze([]),
  grok: Object.freeze(['.grok/auth.json', 'auth.json']),
  cursor: Object.freeze(['.cursor/cli-config.json']),
});

export const PROVIDER_KEY_ENV = Object.freeze({
  claude: 'RAUHWpx_PROVIDER_KEY_CLAUDE',
  codex: 'RAUHWpx_PROVIDER_KEY_CODEX',
  grok: 'RAUHWpx_PROVIDER_KEY_GROK',
  pi: 'RAUHWpx_PROVIDER_KEY_PI',
  cursor: 'RAUHWpx_PROVIDER_KEY_CURSOR',
});

export const PROVIDER_SESSION_ENV = 'RAUHWpx_PROVIDER_SESSION';
export const PROVIDER_SECRET_IDS = Object.freeze({
  claude: 'rhwp.claude.api-key',
  codex: 'rhwp.codex.api-key',
  grok: 'rhwp.grok.api-key',
  cursor: 'rhwp.cursor.api-key',
  pi: 'rhwp.pi.openrouter-api-key',
});

const PROVIDERS = Object.freeze(Object.keys(PROVIDER_AUTH_FILES));
const MAX_AUTH_FILE_BYTES = 64 * 1024;
const MAX_PROVIDER_SESSION_BYTES = 256 * 1024;

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new AppServerError(`Unknown provider: ${provider}`, {
      code: 'INVALID_PROVIDER',
      retryable: false,
    });
  }
  return provider;
}

export function hasProviderAuth(auth) {
  return Boolean(auth?.apiKey || auth?.files?.length);
}

export function encodeProviderSession(auth) {
  const providers = (Array.isArray(auth) ? auth : [auth])
    .filter((item) => item?.files?.length)
    .map((item) => ({
      provider: assertProvider(item.provider),
      files: item.files.map((file) => ({ path: file.path, content: file.content })),
    }));
  if (!providers.length) return null;
  const encoded = Buffer.from(JSON.stringify({ v: 1, providers })).toString('base64url');
  if (Buffer.byteLength(encoded) > MAX_PROVIDER_SESSION_BYTES) {
    throw new AppServerError('Provider session is too large', {
      code: 'INVALID_CREDENTIAL',
      retryable: false,
    });
  }
  return encoded;
}

export function sandboxCredentialVariables(auth) {
  const items = (Array.isArray(auth) ? auth : [auth]).filter(Boolean);
  const variables = {};
  const withFiles = [];
  for (const item of items) {
    if (!item?.provider) continue;
    if (item.apiKey && PROVIDER_KEY_ENV[item.provider]) {
      variables[PROVIDER_KEY_ENV[item.provider]] = item.apiKey;
    }
    if (item.files?.length) withFiles.push(item);
  }
  const session = encodeProviderSession(withFiles);
  if (session) variables[PROVIDER_SESSION_ENV] = session;
  return variables;
}

export function defaultCliRoot(homeDir = os.homedir(), env = process.env, platform = process.platform) {
  if (env.RHWP_CLI_DIR) return env.RHWP_CLI_DIR;
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', 'rhwp', 'cli');
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'rhwp', 'cli');
  }
  return path.join(env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share'), 'rhwp', 'cli');
}

function sourceCandidates(provider, { homeDir, cliRoot, env }) {
  if (provider === 'claude') {
    return [
      { path: path.join(homeDir, '.claude.json'), dest: '.claude.json' },
      { path: path.join(homeDir, '.claude', '.credentials.json'), dest: '.claude/.credentials.json' },
    ];
  }
  if (provider === 'codex') {
    return [
      env.CODEX_HOME ? { path: path.join(env.CODEX_HOME, 'auth.json'), dest: '.codex/auth.json' } : null,
      { path: path.join(homeDir, '.codex', 'auth.json'), dest: '.codex/auth.json' },
    ];
  }
  if (provider === 'grok') {
    return [
      env.GROK_HOME ? { path: path.join(env.GROK_HOME, 'auth.json'), dest: '.grok/auth.json' } : null,
      { path: path.join(homeDir, '.grok', 'auth.json'), dest: '.grok/auth.json' },
      { path: path.join(cliRoot, 'grok', 'auth.json'), dest: '.grok/auth.json' },
    ];
  }
  if (provider === 'cursor') {
    return [
      { path: path.join(homeDir, '.cursor', 'cli-config.json'), dest: '.cursor/cli-config.json' },
      { path: path.join(cliRoot, 'cursor-home', '.cursor', 'cli-config.json'), dest: '.cursor/cli-config.json' },
    ];
  }
  return [];
}

async function readAuthFile(candidate) {
  try {
    const stat = await fs.lstat(candidate.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_AUTH_FILE_BYTES) return null;
    const content = await fs.readFile(candidate.path, 'utf8');
    if (!content) return null;
    return { path: candidate.dest, content };
  } catch {
    return null;
  }
}

async function readSecret(vault, key) {
  if (!vault || typeof vault.get !== 'function') return null;
  try {
    const value = await vault.get(key);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export async function collectProviderAuth(provider, {
  vault = null,
  homeDir = os.homedir(),
  cliRoot = defaultCliRoot(homeDir),
  env = process.env,
} = {}) {
  const name = assertProvider(provider);
  const files = [];
  const seen = new Set();
  for (const candidate of sourceCandidates(name, { homeDir, cliRoot, env }).filter(Boolean)) {
    if (seen.has(candidate.dest)) continue;
    const file = await readAuthFile(candidate);
    if (!file) continue;
    seen.add(file.path);
    files.push(file);
  }
  return {
    provider: name,
    apiKey: await readSecret(vault, PROVIDER_SECRET_IDS[name]),
    files,
  };
}

export function requireProviderAuth(auth) {
  if (hasProviderAuth(auth)) return auth;
  const provider = auth?.provider || 'provider';
  throw new AppServerError(
    `${provider} must be authenticated on this computer before a cloud transfer`,
    { code: 'PROVIDER_KEY_REQUIRED', retryable: false },
  );
}

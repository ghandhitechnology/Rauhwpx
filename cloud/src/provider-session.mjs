import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const SESSION_PROVIDERS = Object.freeze(['claude', 'codex', 'grok', 'cursor']);
export const MAX_SESSION_FILE_BYTES = 16 * 1024;
export const MAX_ENCODED_SESSION_BYTES = 24 * 1024;

const DEST = Object.freeze({
  claude: Object.freeze(['.claude/.credentials.json', '.claude.json']),
  codex: Object.freeze(['.codex/auth.json']),
  grok: Object.freeze(['.grok/auth.json']),
  cursor: Object.freeze(['.cursor/cli-config.json']),
});

function joinHome(home, relative) {
  return path.resolve(home, relative);
}

function readRegularFile(filePath, { lstat = lstatSync, readFile = readFileSync } = {}) {
  try {
    const stat = lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SESSION_FILE_BYTES) return null;
    const text = readFile(filePath, 'utf8');
    return typeof text === 'string' && text.trim() ? text : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sourceFiles(provider, { home, env }) {
  if (provider === 'claude') {
    return [
      { dest: '.claude/.credentials.json', abs: joinHome(home, '.claude/.credentials.json') },
      { dest: '.claude.json', abs: joinHome(home, '.claude.json') },
    ];
  }
  if (provider === 'codex') {
    const custom = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
      ? path.join(env.CODEX_HOME.trim(), 'auth.json')
      : '';
    return [
      { dest: '.codex/auth.json', abs: custom || joinHome(home, '.codex/auth.json') },
    ];
  }
  if (provider === 'grok') {
    const custom = typeof env.GROK_HOME === 'string' && env.GROK_HOME.trim()
      ? path.join(env.GROK_HOME.trim(), 'auth.json')
      : '';
    return [
      { dest: '.grok/auth.json', abs: custom || joinHome(home, '.grok/auth.json') },
    ];
  }
  if (provider === 'cursor') {
    return [{ dest: '.cursor/cli-config.json', abs: joinHome(home, '.cursor/cli-config.json') }];
  }
  return [];
}

export function collectProviderSession(provider, {
  home = homedir(),
  env = process.env,
  lstat = lstatSync,
  readFile = readFileSync,
} = {}) {
  if (!SESSION_PROVIDERS.includes(provider)) return null;
  const files = [];
  for (const source of sourceFiles(provider, { home, env })) {
    const text = readRegularFile(source.abs, { lstat, readFile });
    if (text) files.push({ path: source.dest, text });
  }
  if (!files.length) return null;
  const session = { provider, files };
  try {
    if (encodeProviderSession(session).length > MAX_ENCODED_SESSION_BYTES) return null;
  } catch {
    return null;
  }
  return session;
}

export function listLocalSessionProviders(options = {}) {
  return SESSION_PROVIDERS.filter((provider) => collectProviderSession(provider, options));
}

export function encodeProviderSession(session) {
  if (!session || !SESSION_PROVIDERS.includes(session.provider) || !Array.isArray(session.files)) {
    throw new Error('Provider session is invalid');
  }
  const files = session.files.flatMap((file) => {
    const dest = String(file?.path ?? '');
    const text = String(file?.text ?? '');
    if (!DEST[session.provider].includes(dest) || !text) return [];
    return [{ path: dest, text }];
  });
  if (!files.length) throw new Error('Provider session has no usable files');
  const encoded = Buffer.from(JSON.stringify({ provider: session.provider, files }), 'utf8').toString('base64');
  if (encoded.length > MAX_ENCODED_SESSION_BYTES) throw new Error('Provider session is too large to send');
  return encoded;
}

export function decodeProviderSession(encoded) {
  const raw = String(encoded ?? '').trim();
  if (!raw || raw.length > MAX_ENCODED_SESSION_BYTES) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!SESSION_PROVIDERS.includes(parsed?.provider) || !Array.isArray(parsed.files)) return null;
    const files = parsed.files.flatMap((file) => {
      const dest = String(file?.path ?? '');
      const text = String(file?.text ?? '');
      if (!DEST[parsed.provider].includes(dest) || !text) return [];
      return [{ path: dest, text }];
    });
    return files.length ? { provider: parsed.provider, files } : null;
  } catch {
    return null;
  }
}

export function writeProviderSession(authHome, session, {
  mkdir = mkdirSync,
  writeFile = writeFileSync,
} = {}) {
  if (!session?.files?.length) return false;
  mkdir(authHome, { recursive: true, mode: 0o700 });
  for (const file of session.files) {
    const dest = path.resolve(authHome, file.path);
    if (!dest.startsWith(`${path.resolve(authHome)}${path.sep}`)) continue;
    mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    writeFile(dest, file.text, { encoding: 'utf8', mode: 0o600 });
  }
  return true;
}

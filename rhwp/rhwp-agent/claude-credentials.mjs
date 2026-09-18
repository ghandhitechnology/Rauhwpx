import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
export const CLAUDE_CREDENTIAL_FILENAME = '.credentials.json';
export const CLAUDE_CONFIG_FILENAME = '.claude.json';
/** macOS Keychain service that owns the default profile's Claude Code login. */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
export const CLAUDE_CREDENTIAL_MAX_BYTES = 64 * 1024;
const KEYCHAIN_TIMEOUT_MS = 3_000;

const runFile = promisify(execFile);

/** Claude Code's own config directory when no override is present. */
export function defaultClaudeConfigDir(homeDir, platform = process.platform) {
  return path.join(homeDir, '.claude');
}

/**
 * Claude Code namespaces its Keychain item by the effective config directory:
 * the default location owns the bare service name, and a CLAUDE_CONFIG_DIR
 * profile owns a digest-suffixed name. Mirroring the CLI's exact rule is what
 * lets an isolated login be read back — and published — without ever touching
 * the host profile's item.
 */
export function claudeKeychainService({ configDir, hasConfigDir = false } = {}) {
  if (!hasConfigDir) return CLAUDE_KEYCHAIN_SERVICE;
  const digest = createHash('sha256').update(path.resolve(configDir)).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${digest}`;
}

/**
 * A usable Claude OAuth credential is an object carrying a non-empty
 * `claudeAiOauth.accessToken`. Anything else — including the empty `{}` a
 * locked-down Keychain can return — is treated as "no login".
 */
export function parseClaudeOAuthCredential(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const oauth = parsed.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return null;
  if (typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
  return parsed;
}

/** Access-token expiry in epoch ms, or 0 when the credential does not report one. */
export function claudeCredentialExpiry(credential) {
  const value = Number(credential?.claudeAiOauth?.expiresAt);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Read the credential file as a plain, size-bounded, non-symlink file. */
export async function readClaudeCredentialFile(file, { maxBytes = CLAUDE_CREDENTIAL_MAX_BYTES } = {}) {
  let handle = null;
  try {
    const pathStat = await fs.lstat(file);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) return null;
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maxBytes) return null;
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return parseClaudeOAuthCredential(bytes.subarray(0, offset).toString('utf8'));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * macOS Keychain reads are the only Keychain access this code performs.
 * Writes are deliberately absent: `security add-generic-password` requires an
 * interactive authorization that a hub-spawned child cannot satisfy, so Claude
 * Code itself must stay the sole author of its Keychain item.
 */
export async function readClaudeKeychainCredential({
  configDir,
  hasConfigDir = false,
  platform = process.platform,
  exec = runFile,
  service = null,
} = {}) {
  if (platform !== 'darwin') return null;
  const name = service ?? claudeKeychainService({ configDir, hasConfigDir });
  try {
    const { stdout } = await exec(
      '/usr/bin/security',
      ['find-generic-password', '-s', name, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: CLAUDE_CREDENTIAL_MAX_BYTES, encoding: 'utf8', windowsHide: true },
    );
    return parseClaudeOAuthCredential(stdout);
  } catch {
    return null;
  }
}

/**
 * Resolve the profile's live Claude login from every location Claude Code
 * uses, preferring the plain file on disk over the Keychain item.
 *
 * @returns {Promise<{ source: 'file'|'keychain', configDir: string, file: string, text: string } | null>}
 */
export async function readClaudeOAuthCredential({
  homeDir,
  configDir = null,
  env = {},
  platform = process.platform,
  readFileImpl = readClaudeCredentialFile,
  readKeychainImpl = readClaudeKeychainCredential,
} = {}) {
  const hasConfigDir = typeof env?.[CLAUDE_CONFIG_DIR_ENV] === 'string' && env[CLAUDE_CONFIG_DIR_ENV].trim() !== '';
  const explicit = hasConfigDir
    ? path.resolve(env[CLAUDE_CONFIG_DIR_ENV])
    : (configDir ? path.resolve(configDir) : null);
  const resolvedConfigDir = explicit ?? defaultClaudeConfigDir(homeDir, platform);
  // Claude Code only digests the Keychain service name when the override comes
  // from the environment; a caller that merely names the default directory is
  // still addressing the bare default item.
  const usesProfileService = hasConfigDir
    || (explicit !== null && explicit !== defaultClaudeConfigDir(homeDir, platform));
  const file = path.join(resolvedConfigDir, CLAUDE_CREDENTIAL_FILENAME);
  const fromFile = await readFileImpl(file).catch(() => null);
  if (fromFile) {
    return {
      source: 'file',
      configDir: resolvedConfigDir,
      file,
      text: JSON.stringify(fromFile),
    };
  }
  const fromKeychain = await readKeychainImpl({
    configDir: resolvedConfigDir,
    hasConfigDir: usesProfileService,
    platform,
  }).catch(() => null);
  if (fromKeychain) {
    return {
      source: 'keychain',
      configDir: resolvedConfigDir,
      file,
      text: JSON.stringify(fromKeychain),
    };
  }
  return null;
}

/** Write a resolved credential to a private seed file for isolated consumers. */
export async function writeClaudeCredentialFile(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
  return file;
}

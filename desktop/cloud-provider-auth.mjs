import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readClaudeKeychainCredential,
} from '../rhwp/rhwp-agent/claude-credentials.mjs';

const CLAUDE_CREDENTIAL_DESTINATION = '.claude/.credentials.json';

/** Claude Code's live config directory, plus whether an override named it. */
function claudeProfile({ homeDir, env }) {
  const configured = typeof env?.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  return {
    configDir: configured ? path.resolve(configured) : path.join(homeDir, '.claude'),
    hasConfigDir: configured !== '',
  };
}

export const DESKTOP_PROVIDER_AUTH = Object.freeze({
  claude: Object.freeze({
    secretId: 'rhwp.claude.api-key',
    secretName: 'ANTHROPIC_API_KEY',
    envName: 'ANTHROPIC_API_KEY',
    files: Object.freeze([
      Object.freeze({
        destination: '.claude.json',
        resolve: ({ homeDir }) => path.join(homeDir, '.claude.json'),
      }),
      Object.freeze({
        destination: '.claude/.credentials.json',
        resolve: ({ homeDir, env }) => path.join(
          claudeProfile({ homeDir, env }).configDir,
          '.credentials.json',
        ),
      }),
    ]),
  }),
  codex: Object.freeze({
    secretId: 'rhwp.codex.api-key',
    secretName: 'OPENAI_API_KEY',
    envName: 'OPENAI_API_KEY',
    files: Object.freeze([
      Object.freeze({
        destination: '.codex/auth.json',
        resolve: ({ homeDir, env }) => path.join(env.CODEX_HOME || path.join(homeDir, '.codex'), 'auth.json'),
      }),
    ]),
  }),
  pi: Object.freeze({
    secretId: 'rhwp.pi.openrouter-api-key',
    secretName: 'OPENROUTER_API_KEY',
    envName: 'OPENROUTER_API_KEY',
    files: Object.freeze([]),
  }),
});

export async function collectProviderAuth(provider, {
  homeDir = os.homedir(),
  env = process.env,
  platform = process.platform,
  readSecret = async () => null,
  readFileImpl = readFile,
  readClaudeKeychain = readClaudeKeychainCredential,
} = {}) {
  const spec = DESKTOP_PROVIDER_AUTH[provider];
  if (!spec) return null;
  const secrets = {};
  const files = {};
  const stored = await Promise.resolve(readSecret(spec.secretId)).catch(() => null);
  const fromEnv = typeof env?.[spec.envName] === 'string' ? env[spec.envName].trim() : '';
  const key = (typeof stored === 'string' ? stored.trim() : '') || fromEnv;
  if (key) secrets[spec.secretName] = key;
  for (const source of spec.files) {
    const filename = source.resolve({ homeDir, env: env ?? {} });
    if (!filename) continue;
    const content = await readFileImpl(filename, 'utf8').catch(() => null);
    if (typeof content === 'string' && content.trim()) files[source.destination] = content;
  }
  // A macOS profile can hold its Claude login only in the Keychain, where the
  // file scan above cannot see it. The cloud accepts the same credential file,
  // so the item is materialized into that destination. The Keychain itself is
  // never written — only the CLI may author that item.
  if (provider === 'claude' && !files[CLAUDE_CREDENTIAL_DESTINATION]) {
    const profile = claudeProfile({ homeDir, env: env ?? {} });
    const fromKeychain = await readClaudeKeychain({
      configDir: profile.configDir,
      hasConfigDir: profile.hasConfigDir,
      platform,
    }).catch(() => null);
    if (fromKeychain) files[CLAUDE_CREDENTIAL_DESTINATION] = JSON.stringify(fromKeychain);
  }
  if (!Object.keys(secrets).length && !Object.keys(files).length) return null;
  return { secrets, files };
}

export const PERMANENT_TRANSFER_CODES = Object.freeze([
  'AUTH_REQUIRED',
  'PROVIDER_UNAVAILABLE',
  'INVALID_PROVIDER',
  'INVALID_CREDENTIAL',
  'TRANSFER_TOO_LARGE',
]);

export function isPermanentTransferError(error) {
  return PERMANENT_TRANSFER_CODES.includes(error?.code);
}

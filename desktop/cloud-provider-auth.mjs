import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
        resolve: ({ homeDir }) => path.join(homeDir, '.claude', '.credentials.json'),
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
  grok: Object.freeze({
    secretId: 'rhwp.grok.api-key',
    secretName: 'XAI_API_KEY',
    envName: 'XAI_API_KEY',
    files: Object.freeze([
      Object.freeze({
        destination: '.grok/auth.json',
        resolve: ({ homeDir, env }) => path.join(env.GROK_HOME || path.join(homeDir, '.grok'), 'auth.json'),
      }),
    ]),
  }),
  cursor: Object.freeze({
    secretId: 'rhwp.cursor.api-key',
    secretName: 'CURSOR_API_KEY',
    envName: 'CURSOR_API_KEY',
    files: Object.freeze([
      Object.freeze({
        destination: '.cursor/cli-config.json',
        resolve: ({ homeDir }) => path.join(homeDir, '.cursor', 'cli-config.json'),
      }),
    ]),
  }),
});

export async function collectProviderAuth(provider, {
  homeDir = os.homedir(),
  env = process.env,
  readSecret = async () => null,
  readFileImpl = readFile,
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

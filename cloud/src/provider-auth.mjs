import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CloudError, PROVIDERS } from './protocol.mjs';

export const PROVIDER_AUTH = Object.freeze({
  claude: Object.freeze({
    secretName: 'ANTHROPIC_API_KEY',
    files: Object.freeze(['.claude.json', '.claude/.credentials.json']),
  }),
  codex: Object.freeze({
    secretName: 'OPENAI_API_KEY',
    files: Object.freeze(['.codex/auth.json']),
  }),
  pi: Object.freeze({
    secretName: 'OPENROUTER_API_KEY',
    files: Object.freeze([]),
  }),
  grok: Object.freeze({
    secretName: 'XAI_API_KEY',
    files: Object.freeze(['.grok/auth.json', 'auth.json']),
  }),
  cursor: Object.freeze({
    secretName: 'CURSOR_API_KEY',
    files: Object.freeze(['.cursor/cli-config.json']),
  }),
});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CloudError('INVALID_REQUEST', `${label} must be an object`);
  }
  return value;
}

function text(value, label, { min = 1, max = 64 * 1024 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new CloudError('INVALID_CREDENTIAL', `${label} is invalid`);
  }
  return value;
}

export function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) throw new CloudError('INVALID_PROVIDER', 'Provider is not supported');
  return provider;
}

export function resolveAuthFile(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) {
    throw new CloudError('INVALID_CREDENTIAL', 'Auth file path is invalid');
  }
  const normalized = path.posix.normalize(relative.split(path.sep).join(path.posix.sep));
  if (normalized !== relative || normalized.startsWith('../') || normalized === '..') {
    throw new CloudError('INVALID_CREDENTIAL', 'Auth file path is invalid');
  }
  const resolved = path.resolve(root, ...normalized.split('/'));
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new CloudError('INVALID_CREDENTIAL', 'Auth file path is invalid');
  }
  return resolved;
}

export function parseProviderAuth(provider, value) {
  const name = assertProvider(provider);
  const spec = PROVIDER_AUTH[name];
  const input = object(value, 'body');
  const secrets = {};
  const files = {};
  if (input.secrets !== undefined) {
    for (const [secretName, secretValue] of Object.entries(object(input.secrets, 'secrets'))) {
      if (secretName !== spec.secretName) {
        throw new CloudError('INVALID_CREDENTIAL', `${name} does not accept secret ${secretName}`);
      }
      secrets[secretName] = text(secretValue, `secrets.${secretName}`);
    }
  }
  if (input.files !== undefined) {
    for (const [relative, content] of Object.entries(object(input.files, 'files'))) {
      if (!spec.files.includes(relative)) {
        throw new CloudError('INVALID_CREDENTIAL', `${name} does not accept auth file ${relative}`);
      }
      files[relative] = text(content, `files.${relative}`);
    }
  }
  if (!Object.keys(secrets).length && !Object.keys(files).length) {
    throw new CloudError('INVALID_REQUEST', 'Provider auth import is empty');
  }
  return { provider: name, secrets, files };
}

export async function applyProviderAuth(provider, bundle, { vault, authDirectory }) {
  const parsed = bundle.provider ? bundle : parseProviderAuth(provider, bundle);
  const name = assertProvider(parsed.provider);
  if (name !== provider) throw new CloudError('INVALID_PROVIDER', 'Provider path does not match the auth body');
  const root = path.join(authDirectory, name);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [secretName, secretValue] of Object.entries(parsed.secrets)) {
    vault.set(name, secretName, secretValue);
  }
  for (const [relative, content] of Object.entries(parsed.files)) {
    const target = resolveAuthFile(root, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
  }
  return {
    provider: name,
    importedSecrets: Object.keys(parsed.secrets),
    importedFiles: Object.keys(parsed.files),
  };
}

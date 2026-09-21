import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudError, PROVIDERS } from './protocol.mjs';
import {
  PROVIDER_KEY_NAMES,
  parseProviderSession,
  writeProviderAuthFiles,
} from './provider-credentials.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(readFileSync(path.resolve(directory, '../install/providers.lock.json'), 'utf8'));
const KEY_NAMES = PROVIDER_KEY_NAMES;

function run(command, args, { env, stdio = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new CloudError('PROVIDER_COMMAND_FAILED', `${command} exited ${code}`, 500));
    });
  });
}

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) throw new CloudError('INVALID_PROVIDER', 'Provider is not supported');
  return lock[provider];
}

function ensurePrivateDirectory(directoryPath) {
  mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CloudError('PROVIDER_STATE_UNSAFE', 'Provider state path is not a private directory', 500);
  }
  chmodSync(directoryPath, 0o700);
  return directoryPath;
}

export class ProviderCliManager {
  constructor(config, providerManager, vault) {
    this.config = config;
    this.providerManager = providerManager;
    this.vault = vault;
  }

  async #installNpmBundle(env) {
    const destination = this.config.providerCliDirectory;
    const source = path.resolve(directory, '../install/provider-runtime');
    const identifier = randomUUID();
    const stagingName = `bundle-${identifier}`;
    const staging = path.join(destination, stagingName);
    const nextLink = path.join(destination, `.current-${identifier}`);
    const currentLink = path.join(destination, 'current');
    let activated = false;
    let previousTarget = null;
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
      await copyFile(path.join(source, 'package.json'), path.join(staging, 'package.json'));
      await copyFile(path.join(source, 'package-lock.json'), path.join(staging, 'package-lock.json'));
      await run('npm', [
        'ci', '--prefix', staging, '--omit=dev', '--no-audit', '--no-fund',
      ], { env });
      for (const provider of PROVIDERS.filter((name) => lock[name].kind === 'npm')) {
        await run(path.join(staging, 'node_modules', '.bin', lock[provider].bin), ['--version'], { env, stdio: 'ignore' });
      }
      previousTarget = await readlink(currentLink).catch(() => null);
      await symlink(stagingName, nextLink);
      await rename(nextLink, currentLink);
      activated = true;
      if (previousTarget && /^bundle-[a-f0-9-]+$/.test(previousTarget) && previousTarget !== stagingName) {
        await rm(path.join(destination, previousTarget), { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      await rm(nextLink, { force: true });
      if (!activated) await rm(staging, { recursive: true, force: true });
    }
  }

  environment(provider) {
    assertProvider(provider);
    const home = ensurePrivateDirectory(path.join(this.config.providerAuthDirectory, provider));
    const local = ensurePrivateDirectory(path.join(home, '.local'));
    const piHome = ensurePrivateDirectory(path.join(home, '.pi'));
    const state = {
      XDG_CONFIG_HOME: ensurePrivateDirectory(path.join(home, '.config')),
      XDG_CACHE_HOME: ensurePrivateDirectory(path.join(home, '.cache')),
      XDG_DATA_HOME: ensurePrivateDirectory(path.join(local, 'share')),
      XDG_STATE_HOME: ensurePrivateDirectory(path.join(local, 'state')),
      // A transferred Claude login lands at `.claude/.credentials.json` under
      // this home. Naming the directory explicitly keeps the seeded subscription
      // OAuth credential authoritative instead of inheriting whichever
      // CLAUDE_CONFIG_DIR the Cloud host process happens to carry.
      CLAUDE_CONFIG_DIR: ensurePrivateDirectory(path.join(home, '.claude')),
      CODEX_HOME: ensurePrivateDirectory(path.join(home, '.codex')),
      PI_CODING_AGENT_DIR: ensurePrivateDirectory(path.join(piHome, 'agent')),
    };
    ensurePrivateDirectory(path.join(local, 'bin'));
    const binDirectory = path.join(this.config.providerCliDirectory, 'current', 'node_modules', '.bin');
    return {
      ...process.env,
      HOME: home,
      ...state,
      PATH: `${binDirectory}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    };
  }

  async install(provider) {
    const item = assertProvider(provider);
    mkdirSync(this.config.providerCliDirectory, { recursive: true, mode: 0o755 });
    const env = this.environment(provider);
    if (item.kind === 'npm') {
      await this.#installNpmBundle(env);
    } else {
      throw new CloudError('PROVIDER_INSTALL_INVALID', `${provider} has an unsupported install asset`);
    }
    return this.providerManager.probe(provider);
  }

  async seed(provider, { apiKey = null, files = [] } = {}) {
    assertProvider(provider);
    if (apiKey !== null && String(apiKey).trim()) {
      this.vault.set(provider, KEY_NAMES[provider], String(apiKey).trim());
    }
    writeProviderAuthFiles(this.config.providerAuthDirectory, provider, files);
    return this.providerManager.probe(provider);
  }

  async seedSession(encoded = process.env.RAUHWpx_PROVIDER_SESSION) {
    const session = parseProviderSession(encoded);
    if (!session) return [];
    const results = [];
    for (const item of session.providers) {
      results.push(await this.seed(item.provider, { files: item.files }));
    }
    return results;
  }

  async login(provider, { apiKey = null } = {}) {
    const item = assertProvider(provider);
    if (apiKey !== null) {
      return this.seed(provider, { apiKey });
    }
    if (provider === 'pi') {
      throw new CloudError('API_KEY_STDIN_REQUIRED', 'Pi login requires --api-key-stdin with an OpenRouter API key');
    }
    const argumentsByProvider = {
      claude: ['auth', 'login'],
      codex: ['login', '--device-auth'],
    };
    const env = this.environment(provider);
    const command = path.join(this.config.providerCliDirectory, 'current', 'node_modules', '.bin', item.bin);
    await run(command, argumentsByProvider[provider], { env: { ...env, NO_OPEN_BROWSER: '1' } });
    return this.providerManager.probe(provider);
  }

  status(provider) {
    assertProvider(provider);
    return this.providerManager.probe(provider);
  }

  async doctor(selectedProvider = null) {
    if (selectedProvider) assertProvider(selectedProvider);
    const providers = await Promise.all(PROVIDERS.map((provider) => this.providerManager.probe(provider)));
    const selected = selectedProvider ? providers.find((provider) => provider.provider === selectedProvider) : null;
    return {
      ok: providers.every((provider) => provider.available),
      selectedProvider,
      selectedProviderReady: selected ? selected.available && selected.authenticated : null,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      providers,
    };
  }
}

export async function readSecretFromStdin() {
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 64 * 1024) throw new CloudError('INVALID_CREDENTIAL', 'API key is too large');
  }
  value = value.replace(/\r?\n$/, '');
  if (!value) throw new CloudError('INVALID_CREDENTIAL', 'API key was empty');
  return value;
}

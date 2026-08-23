import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PROVIDERS } from './protocol.mjs';

const COMMANDS = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  pi: 'pi',
  grok: 'grok',
  cursor: 'cursor-agent',
});

function firstLine(value) {
  return String(value).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

export class ProviderManager {
  constructor(sessionStore, {
    spawnProcess = spawn,
    timeoutMs = 5_000,
    now = Date.now,
    providerAuthDirectory,
    providerCliDirectory = '/opt/rauhwpx-cloud/provider-cli',
    vault,
  } = {}) {
    this.sessionStore = sessionStore;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.providerAuthDirectory = providerAuthDirectory;
    this.providerCliDirectory = providerCliDirectory;
    this.vault = vault;
  }

  #authState(provider) {
    const secrets = this.vault?.list().filter((credential) => credential.provider === provider) ?? [];
    const root = this.providerAuthDirectory ? path.join(this.providerAuthDirectory, provider) : '';
    const authFiles = {
      claude: ['.claude.json', '.claude/.credentials.json'],
      codex: ['.codex/auth.json'],
      pi: [],
      grok: ['.grok/auth.json', 'auth.json'],
      cursor: ['.cursor/cli-config.json'],
    }[provider];
    const authenticated = secrets.length > 0 || authFiles.some((filename) => existsSync(path.join(root, filename)));
    return {
      authenticated,
      setupAction: authenticated ? null : `sudo rauhwpx-cloud provider login ${provider}`,
    };
  }

  probe(provider) {
    const command = COMMANDS[provider];
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let processHandle;
      let timer = null;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(this.sessionStore.setProviderStatus(provider, {
          ...status,
          ...(status.available ? this.#authState(provider) : { authenticated: false, setupAction: `sudo rauhwpx-cloud provider install ${provider}` }),
          checkedAt: this.now(),
        }));
      };
      try {
        processHandle = this.spawnProcess(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        finish({ available: false, errorCode: 'PROBE_FAILED', errorMessage: error.message });
        return;
      }
      timer = setTimeout(() => {
        processHandle.kill('SIGKILL');
        finish({ available: false, errorCode: 'PROBE_TIMEOUT', errorMessage: `${command} --version timed out` });
      }, this.timeoutMs);
      processHandle.stdout?.on('data', (chunk) => { stdout += chunk; });
      processHandle.stderr?.on('data', (chunk) => { stderr += chunk; });
      processHandle.on('error', (error) => finish({
        available: false,
        errorCode: error.code === 'ENOENT' ? 'NOT_INSTALLED' : 'PROBE_FAILED',
        errorMessage: error.message,
      }));
      processHandle.on('close', (code) => finish(code === 0
        ? { available: true, version: firstLine(stdout) }
        : { available: false, errorCode: 'PROBE_EXITED', errorMessage: firstLine(stderr) ?? `${command} exited ${code}` }));
    });
  }

  async probeAll() {
    return Promise.all(PROVIDERS.map((provider) => this.probe(provider)));
  }
}

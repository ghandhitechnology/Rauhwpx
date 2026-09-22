import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCliSetupManager,
  defaultCliSetupRoot,
} from '../cli-setup-manager.mjs';
import { AUTH_CODE_MAX_BYTES } from '../input-bounds.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  input = '';
  stdin = {
    write: (value = '') => { this.input += String(value); return true; },
    end: (value = '') => { this.input += String(value); },
  };
  exitCode = null;
  signalCode = null;

  kill(signal = 'SIGTERM') {
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit('exit', null, signal);
      this.emit('close', null, signal);
    });
    return true;
  }
}

function packageBinName(packageName) {
  if (packageName.startsWith('@openai/codex')) return 'codex';
  if (packageName.startsWith('@anthropic-ai/claude-code')) return 'claude';
  return null;
}

function fakeSpawner(prefixDir, platform = process.platform) {
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(async () => {
      const packageName = argv.at(-1);
      if (typeof packageName === 'string' && packageName.startsWith('@')) {
        const packageDir = path.join(prefixDir, 'node_modules', ...packageName.split('/'));
        await fs.mkdir(packageDir, { recursive: true });
        await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version: '1.2.3' }));
        const binName = packageBinName(packageName);
        if (binName) {
          const binPath = path.join(prefixDir, 'node_modules', '.bin', platform === 'win32' ? `${binName}.cmd` : binName);
          await fs.mkdir(path.dirname(binPath), { recursive: true });
          await fs.writeFile(binPath, '');
        }
        proc.stdout.emit('data', 'installed\n');
        proc.emit('close', 0, null);
        return;
      }
      if (argv.includes('login')) {
        proc.stdout.emit('data', 'Visit https://example.test/login\n');
        proc.emit('close', 0, null);
        return;
      }
      if (argv.includes('--version')) {
        proc.stdout.emit('data', `${path.basename(String(command), '.cmd')} 1.2.3\n`);
        proc.emit('close', 0, null);
        return;
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  return { calls, spawnProcess };
}

test('CLI setup root follows the app data directory on each platform', () => {
  assert.equal(defaultCliSetupRoot({ RHWP_CLI_DIR: '/tmp/rhwp-cli' }), path.resolve('/tmp/rhwp-cli'));
  assert.equal(
    defaultCliSetupRoot({}, 'darwin', '/Users/tester'),
    '/Users/tester/Library/Application Support/rhwp/cli',
  );
  assert.equal(
    defaultCliSetupRoot({ APPDATA: 'C:\\data' }, 'win32', 'C:\\Users\\tester'),
    path.win32.join('C:\\data', 'rhwp', 'cli'),
  );
  assert.equal(defaultCliSetupRoot({}, 'linux', '/home/tester'), '/home/tester/.local/share/rhwp/cli');
});

test('Codex installs into the app prefix and API login stores the key', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-codex-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const secretStore = createMemorySecretStore();
  const { calls, spawnProcess } = fakeSpawner(path.join(rootDir, 'prefix'));
  const manager = await createCliSetupManager({ rootDir, spawnProcess, secretStore }).init();

  const installed = await manager.install('codex');
  assert.equal(installed.installed, true);
  assert.match(calls[0].argv.join(' '), /@openai\/codex@latest/);

  const status = await manager.authenticate('codex', 'api-key', 'openai-secret-value');
  assert.equal(status.authenticated, true);
  assert.equal(status.authMethod, 'api-key');
  assert.equal(status.keyTail, 'alue');
  assert.equal(manager.envFor('codex').OPENAI_API_KEY, 'openai-secret-value');
  assert.equal(await secretStore.get('rhwp.codex.api-key'), 'openai-secret-value');
  assert.match(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'), /openai-secret-value/);
});

test('Claude API setup is restored through the provider environment', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-claude-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const secretStore = createMemorySecretStore();
  const { spawnProcess } = fakeSpawner(path.join(rootDir, 'prefix'));
  const manager = await createCliSetupManager({ rootDir, spawnProcess, secretStore }).init();

  await manager.install('claude');
  await manager.authenticate('claude', 'api-key', 'anthropic-secret');
  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'anthropic-secret');
  assert.equal(manager.envFor('codex').ANTHROPIC_API_KEY, undefined);
});

test('config.json restores API keys on init', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-claude-restore-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(path.join(rootDir, 'config.json'), JSON.stringify({
    claude: { key: 'legacy-plaintext-key' },
    codex: { key: null },
  }));
  const { spawnProcess } = fakeSpawner(path.join(rootDir, 'prefix'));
  const manager = await createCliSetupManager({ rootDir, spawnProcess }).init();
  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'legacy-plaintext-key');
});

test('Codex OAuth uses device auth on every platform, never a localhost callback', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-codex-oauth-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const { calls, spawnProcess } = fakeSpawner(path.join(rootDir, 'prefix'));
  const manager = await createCliSetupManager({ rootDir, spawnProcess }).init();
  await manager.install('codex');

  await manager.authenticate('codex', 'oauth');
  const login = calls.find((call) => call.argv.includes('login'));
  assert.ok(login);
  assert.deepEqual(login.argv, ['login']);
});

test('submitAuthCode rejects unsupported agents and oversized codes', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-auth-code-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const manager = await createCliSetupManager({ rootDir }).init();
  assert.throws(() => manager.submitAuthCode('pi', 'code'), /지원하지 않는 에이전트/);
  assert.throws(
    () => manager.submitAuthCode('claude', 'x'.repeat(AUTH_CODE_MAX_BYTES + 1)),
    /인증 코드가 올바르지 않아요/,
  );
});

test('cancel stops an in-flight OAuth login', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cancel-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  let releaseLogin;
  const loginStarted = new Promise((resolve) => { releaseLogin = resolve; });
  const spawnProcess = (command, argv) => {
    const proc = new FakeProcess();
    if (argv.includes('login')) {
      queueMicrotask(() => { releaseLogin(proc); });
      return proc;
    }
    queueMicrotask(() => proc.emit('close', 0, null));
    return proc;
  };
  const manager = await createCliSetupManager({ rootDir, spawnProcess }).init();
  await manager.install('codex');
  const pending = manager.authenticate('codex', 'oauth');
  const proc = await loginStarted;
  assert.equal(await manager.cancel('codex'), true);
  proc.emit('close', null, 'SIGTERM');
  await assert.rejects(pending, /로그인/);
});

test('a provider environment carries only its own managed API key', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-env-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const secretStore = createMemorySecretStore();
  const { spawnProcess } = fakeSpawner(path.join(rootDir, 'prefix'));
  const manager = await createCliSetupManager({ rootDir, spawnProcess, secretStore }).init();
  await manager.install('claude');
  await manager.install('codex');
  await manager.authenticate('claude', 'api-key', 'anthropic-only');
  await manager.authenticate('codex', 'api-key', 'openai-only');
  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'anthropic-only');
  assert.equal(manager.envFor('claude').OPENAI_API_KEY, undefined);
  assert.equal(manager.envFor('codex').OPENAI_API_KEY, 'openai-only');
  assert.equal(manager.envFor('codex').ANTHROPIC_API_KEY, undefined);
});

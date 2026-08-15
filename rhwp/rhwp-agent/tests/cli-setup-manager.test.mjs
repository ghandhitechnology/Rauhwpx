import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCliSetupManager, defaultCliSetupRoot } from '../cli-setup-manager.mjs';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  input = '';
  stdin = {
    end: (value = '') => { this.input += String(value); },
  };
  kill() { return true; }
}

function fakeSpawner(prefixDir) {
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(() => {
      const packageName = argv.at(-1);
      if (command === 'npm' && typeof packageName === 'string') {
        const packageDir = path.join(prefixDir, 'node_modules', ...packageName.split('/'));
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version: '1.2.3' }));
        proc.stdout.emit('data', 'installed\n');
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  return { calls, spawnProcess };
}

test('CLI setup root follows the app data directory on each platform', () => {
  assert.equal(defaultCliSetupRoot({ RHWP_CLI_DIR: '/tmp/rhwp-cli' }), '/tmp/rhwp-cli');
  assert.equal(
    defaultCliSetupRoot({}, 'darwin', '/Users/tester'),
    '/Users/tester/Library/Application Support/rhwp/cli',
  );
  assert.equal(defaultCliSetupRoot({}, 'linux', '/home/tester'), '/home/tester/.local/share/rhwp/cli');
});

test('Codex installs into the app prefix and API login never persists the full key', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-'));
  const prefixDir = path.join(rootDir, 'prefix');
  const { calls, spawnProcess } = fakeSpawner(prefixDir);
  const manager = await createCliSetupManager({ rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' } }).init();

  const progress = [];
  const installed = await manager.install('codex', (event) => progress.push(event));
  assert.equal(installed.codex, undefined);
  assert.equal(installed.installed, true);
  assert.equal(installed.version, '1.2.3');
  assert.deepEqual(calls[0].argv, [
    'install', '--prefix', prefixDir, '--no-fund', '--no-audit', '@openai/codex',
  ]);
  assert.deepEqual(progress.map((event) => event.phase), [
    'preparing', 'resolving', 'installing', 'installing', 'verifying', 'done',
  ]);
  assert.deepEqual(progress.map((event) => event.percent), [8, 20, 28, 29.5, 92, 100]);

  const status = await manager.authenticate('codex', 'api-key', 'sk-proj-secret-value');
  assert.equal(status.authenticated, true);
  assert.equal(status.authMethod, 'api-key');
  assert.equal(status.keyTail, 'alue');
  const login = calls.find((call) => call.argv.includes('--with-api-key'));
  assert.equal(login.proc.input, 'sk-proj-secret-value\n');
  const configText = await fs.readFile(path.join(rootDir, 'config.json'), 'utf8');
  assert.doesNotMatch(configText, /sk-proj-secret-value/);
  assert.match(configText, /"codexKeyTail": "alue"/);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Claude API setup is restored through the provider environment', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-'));
  const prefixDir = path.join(rootDir, 'prefix');
  const { spawnProcess } = fakeSpawner(prefixDir);
  const manager = await createCliSetupManager({ rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' } }).init();

  await manager.install('claude');
  const status = await manager.authenticate('claude', 'api-key', 'sk-ant-secret-value');
  assert.equal(status.setupComplete, true);
  assert.equal(status.authMethod, 'api-key');
  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'sk-ant-secret-value');
  assert.equal((await fs.stat(path.join(rootDir, 'config.json'))).mode & 0o777, 0o600);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('an existing global harness can be reauthenticated without an app-managed install', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-'));
  const prefixDir = path.join(rootDir, 'prefix');
  const { calls, spawnProcess } = fakeSpawner(prefixDir);
  const manager = await createCliSetupManager({ rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' } }).init();

  const status = await manager.authenticate('codex', 'api-key', 'sk-proj-global-harness');

  assert.equal(status.installed, false);
  assert.equal(status.authenticated, true);
  const login = calls.find((call) => call.command === 'codex' && call.argv.includes('--with-api-key'));
  assert.ok(login, 'PATH 의 codex 명령으로 재인증한다');
  assert.equal(login.proc.input, 'sk-proj-global-harness\n');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('automatic CLI update failure keeps the working version and marks it as required', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-update-'));
  const prefixDir = path.join(rootDir, 'prefix');
  const packageDir = path.join(prefixDir, 'node_modules', '@openai', 'codex');
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version: '1.0.0' }),
  );

  const spawnProcess = (command) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      if (command === 'npm') proc.stderr.emit('data', 'network failure\n');
      proc.emit('close', command === 'npm' ? 1 : 0, null);
    });
    return proc;
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ version: '1.1.0', dist: {} }),
  });
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, fetchImpl, baseEnv: { PATH: '/usr/bin' },
  }).init();

  const status = await manager.automaticUpdate('codex');
  assert.equal(status.version, '1.0.0');
  assert.equal(status.latestVersion, '1.1.0');
  assert.equal(status.updateRequired, true);
  assert.equal(status.error, null);
  assert.equal(JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')).version, '1.0.0');
  assert.deepEqual((await fs.readdir(rootDir)).filter((name) => name.includes('.update-')), []);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('automatic CLI update activates a verified prefix and retains one rollback copy', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-update-'));
  const prefixDir = path.join(rootDir, 'prefix');
  const packagePath = (base) => path.join(base, 'node_modules', '@openai', 'codex', 'package.json');
  await fs.mkdir(path.dirname(packagePath(prefixDir)), { recursive: true });
  await fs.writeFile(packagePath(prefixDir), JSON.stringify({ name: '@openai/codex', version: '1.0.0' }));

  const spawnProcess = (command, argv) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      void (async () => {
        if (command === 'npm') {
          const targetPrefix = argv[2];
          await fs.mkdir(path.dirname(packagePath(targetPrefix)), { recursive: true });
          await fs.writeFile(packagePath(targetPrefix), JSON.stringify({ name: '@openai/codex', version: '1.1.0' }));
        }
        proc.emit('close', 0, null);
      })();
    });
    return proc;
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ version: '1.1.0', dist: {} }),
  });
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, fetchImpl, baseEnv: { PATH: '/usr/bin' },
  }).init();

  const status = await manager.automaticUpdate('codex');
  assert.equal(status.version, '1.1.0');
  assert.equal(status.updateRequired, false);
  assert.equal(JSON.parse(await fs.readFile(packagePath(`${prefixDir}.previous`), 'utf8')).version, '1.0.0');

  await fs.rm(rootDir, { recursive: true, force: true });
});

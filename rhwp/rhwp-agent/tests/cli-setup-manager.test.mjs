import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCliSetupManager, defaultCliSetupRoot } from '../cli-setup-manager.mjs';
import { API_KEY_MAX_BYTES, AUTH_CODE_MAX_BYTES } from '../input-bounds.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  input = '';
  stdin = { write: (value) => { this.input += String(value); } };
  killed = false;

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit('close', null, 'SIGTERM'));
    return true;
  }
}

async function tmpRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('CLI setup root follows the app data directory on each platform', () => {
  assert.equal(defaultCliSetupRoot({ RHWP_CLI_DIR: '/tmp/rhwp-cli' }), path.resolve('/tmp/rhwp-cli'));
  assert.equal(defaultCliSetupRoot({}, 'darwin', '/Users/tester'), '/Users/tester/Library/Application Support/rhwp/cli');
  assert.equal(defaultCliSetupRoot({ APPDATA: 'C:\\data' }, 'win32', 'C:\\Users\\tester'), path.win32.join('C:\\data', 'rhwp', 'cli'));
  assert.equal(defaultCliSetupRoot({}, 'linux', '/home/tester'), '/home/tester/.local/share/rhwp/cli');
});

test('only supported CLI agents can reach setup operations', async (t) => {
  const manager = await createCliSetupManager({ rootDir: await tmpRoot(t) }).init();
  await assert.rejects(() => manager.status('cursor'), (error) => error.code === 'AGENT_SETUP_INVALID');
  await assert.rejects(() => manager.authenticate('grok', 'api-key', 'secret'), (error) => error.code === 'AGENT_SETUP_INVALID');
  assert.throws(() => manager.binPath('opencode'), (error) => error.code === 'AGENT_SETUP_INVALID');
});

test('API keys stay provider-scoped and persist outside the public setup config', async (t) => {
  const rootDir = await tmpRoot(t);
  const manager = await createCliSetupManager({ rootDir, baseEnv: { ANTHROPIC_API_KEY: 'inherited', OPENAI_API_KEY: 'inherited' } }).init();
  await manager.authenticate('claude', 'api-key', 'sk-ant-private-1234');

  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'sk-ant-private-1234');
  assert.equal(manager.envFor('claude').OPENAI_API_KEY, undefined);
  assert.equal(manager.envFor('codex').ANTHROPIC_API_KEY, undefined);
  assert.doesNotMatch(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'), /sk-ant-private-1234/);
  assert.match(await fs.readFile(path.join(rootDir, 'secrets.json'), 'utf8'), /sk-ant-private-1234/);

  const reloaded = await createCliSetupManager({ rootDir }).init();
  assert.equal((await reloaded.status('claude')).keyTail, '1234');
});

test('vault-backed API keys are bounded and never enter fallback files', async (t) => {
  const rootDir = await tmpRoot(t);
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({ rootDir, secretStore }).init();
  await assert.rejects(
    () => manager.authenticate('codex', 'api-key', 'x'.repeat(API_KEY_MAX_BYTES + 1)),
    (error) => error.code === 'AGENT_KEY_INVALID',
  );
  await manager.authenticate('codex', 'api-key', 'sk-codex-private-5678');
  assert.equal(await secretStore.get('rhwp.codex.api-key'), 'sk-codex-private-5678');
  await assert.rejects(fs.access(path.join(rootDir, 'secrets.json')), { code: 'ENOENT' });
  assert.doesNotMatch(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'), /sk-codex-private-5678/);
});

test('legacy config keys migrate before their public copy is removed', async (t) => {
  const rootDir = await tmpRoot(t);
  await fs.writeFile(path.join(rootDir, 'config.json'), JSON.stringify({
    claude: { key: 'sk-ant-legacy-1234' },
    codex: { key: 'sk-codex-legacy-5678' },
  }));
  const secretStore = createMemorySecretStore();
  await createCliSetupManager({ rootDir, secretStore }).init();

  assert.equal(await secretStore.get('rhwp.claude.api-key'), 'sk-ant-legacy-1234');
  assert.equal(await secretStore.get('rhwp.codex.api-key'), 'sk-codex-legacy-5678');
  const config = await fs.readFile(path.join(rootDir, 'config.json'), 'utf8');
  assert.doesNotMatch(config, /sk-ant-legacy|sk-codex-legacy/);
  assert.match(config, /"keyTail": "1234"/);
  assert.match(config, /"keyTail": "5678"/);
});

test('Codex OAuth always uses device auth and commits only after a successful exit', async (t) => {
  const rootDir = await tmpRoot(t);
  const calls = [];
  let process;
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess(command, argv, options) {
      process = new FakeProcess();
      calls.push({ command, argv, options });
      return process;
    },
  }).init();
  let committed = false;
  const running = manager.authenticate('codex', 'oauth', undefined, undefined, { onCommitted: () => { committed = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1).argv, ['login', '--device-auth']);
  assert.equal(committed, false);
  process.emit('close', 0, null);
  await running;
  assert.equal(committed, true);
});

test('manual auth codes are bounded before reaching the owned CLI', async (t) => {
  const rootDir = await tmpRoot(t);
  let process;
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess() { process = new FakeProcess(); return process; },
  }).init();
  const running = manager.authenticate('codex', 'oauth');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => manager.submitAuthCode('codex', 'x'.repeat(AUTH_CODE_MAX_BYTES + 1)),
    (error) => error.code === 'AGENT_AUTH_CODE_INVALID',
  );
  assert.equal(process.input, '');
  await manager.submitAuthCode('codex', 'device-code');
  assert.equal(process.input, 'device-code\n');
  process.emit('close', 0, null);
  await running;
});

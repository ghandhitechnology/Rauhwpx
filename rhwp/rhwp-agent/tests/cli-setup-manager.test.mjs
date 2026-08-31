import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCliSetupManager,
  defaultCliSetupRoot,
  defaultCursorConfigDir,
  defaultCursorHomeDir,
} from '../cli-setup-manager.mjs';
import { replaceFileAtomically } from '../harness-update.mjs';
import { API_KEY_MAX_BYTES, AUTH_CODE_MAX_BYTES } from '../input-bounds.mjs';
import { prepareStagedOAuthCredential } from '../oauth-credential-transaction.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  input = '';
  stdinEnded = false;
  stdin = {
    write: (value = '') => { this.input += String(value); return true; },
    end: (value = '') => { this.input += String(value); this.stdinEnded = true; },
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

/** API 키 검증용 기본 응답 — 테스트가 실제 네트워크를 타지 않도록 항상 주입한다. */
const acceptingFetch = async () => ({ status: 200, ok: true });
/** 키를 거절하는 응답. */
const rejectingFetch = async () => ({ status: 401, ok: false });

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

function oauthTransactionStub(homeDir, configDir = homeDir, lifecycle = []) {
  return {
    homeDir,
    configDir,
    async publish() { lifecycle.push('publish'); },
    async rollback() { lifecycle.push('rollback'); },
    async cleanup() { lifecycle.push('cleanup'); },
    markCommitted() { lifecycle.push('mark-committed'); },
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function oauthJournal(agent, credential, phase = 'ready') {
  return {
    version: 1,
    agent,
    phase,
    previousAuthMethod: 'api-key',
    previousKeyTail: '-key',
    credential,
  };
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
  assert.equal(
    defaultCliSetupRoot({ USERPROFILE: 'D:\\Profiles\\tester' }, 'win32', 'C:\\wrong-home'),
    path.win32.join('D:\\Profiles\\tester', 'AppData', 'Roaming', 'rhwp', 'cli'),
  );
  assert.equal(defaultCliSetupRoot({}, 'linux', '/home/tester'), '/home/tester/.local/share/rhwp/cli');
});

test('Windows startup recovers setup config, fallback secrets, and managed Grok auth', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-recovery-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const configPath = path.join(rootDir, 'config.json');
  const secretsPath = path.join(rootDir, 'secrets.json');
  const grokAuthPath = path.join(rootDir, 'grok', 'auth.json');
  await fs.mkdir(path.dirname(grokAuthPath), { recursive: true });
  await fs.writeFile(`${configPath}.previous-write`, JSON.stringify({
    codexAuthMethod: 'api-key', codexKeyTail: 'tail',
  }));
  await fs.writeFile(`${secretsPath}.previous-write`, JSON.stringify({
    'rhwp.codex.api-key': 'sk-recovered',
  }));
  await fs.writeFile(`${grokAuthPath}.previous-write`, '{"oauth":"recovered"}');

  const manager = await createCliSetupManager({
    rootDir,
    platform: 'win32',
    baseEnv: { PATH: '', USERPROFILE: 'C:\\Users\\tester' },
    homeDir: rootDir,
  }).init();

  assert.equal(manager.envFor('codex').OPENAI_API_KEY, 'sk-recovered');
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).codexKeyTail, 'tail');
  assert.equal(await fs.readFile(grokAuthPath, 'utf8'), '{"oauth":"recovered"}');
  assert.equal(await manager.grokAuthPath(), grokAuthPath);
});

test('restart rolls back a published OAuth credential when config never committed', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-oauth-crash-rollback-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const codexHome = path.join(rootDir, 'profile', '.codex');
  const sourceFile = path.join(codexHome, 'auth.json');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(sourceFile, '{"token":"old-oauth-secret"}');
  await fs.writeFile(path.join(rootDir, 'config.json'), JSON.stringify({
    codexAuthMethod: 'api-key',
    codexKeyTail: '-key',
  }));
  await fs.writeFile(path.join(rootDir, 'secrets.json'), JSON.stringify({
    'rhwp.codex.api-key': 'sk-api-plaintext',
  }));
  const transaction = await prepareStagedOAuthCredential({
    sourceFile,
    stagingParent: path.join(rootDir, 'codex-oauth-staging'),
    relativeCredentialPath: 'auth.json',
    platform: 'linux',
  });
  await fs.writeFile(transaction.credentialFile, '{"token":"new-oauth-secret"}');
  const credential = await transaction.prepareRecovery();
  const journalPath = path.join(rootDir, 'oauth-auth-codex.journal.json');
  await fs.writeFile(journalPath, JSON.stringify(oauthJournal('codex', credential)));
  assert.doesNotMatch(await fs.readFile(journalPath, 'utf8'), /old-oauth-secret|new-oauth-secret|sk-api-plaintext/u);
  await transaction.publish();

  const manager = await createCliSetupManager({
    rootDir,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin', CODEX_HOME: codexHome },
    homeDir: path.dirname(codexHome),
  }).init();

  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"token":"old-oauth-secret"}');
  assert.equal(manager.envFor('codex').OPENAI_API_KEY, 'sk-api-plaintext');
  assert.equal(JSON.parse(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8')).codexAuthMethod, 'api-key');
  await assert.rejects(fs.access(journalPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(credential.backupFile), { code: 'ENOENT' });
});

test('restart finishes OAuth after config commit and removes the stale API secret', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-oauth-crash-commit-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const codexHome = path.join(rootDir, 'profile', '.codex');
  const sourceFile = path.join(codexHome, 'auth.json');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(sourceFile, '{"token":"old-oauth-secret"}');
  await fs.writeFile(path.join(rootDir, 'secrets.json'), JSON.stringify({
    'rhwp.codex.api-key': 'sk-api-plaintext',
  }));
  const transaction = await prepareStagedOAuthCredential({
    sourceFile,
    stagingParent: path.join(rootDir, 'codex-oauth-staging'),
    relativeCredentialPath: 'auth.json',
    platform: 'linux',
  });
  await fs.writeFile(transaction.credentialFile, '{"token":"new-oauth-secret"}');
  const credential = await transaction.prepareRecovery();
  const journalPath = path.join(rootDir, 'oauth-auth-codex.journal.json');
  await fs.writeFile(journalPath, JSON.stringify(oauthJournal('codex', credential)));
  await transaction.publish();
  await fs.writeFile(path.join(rootDir, 'config.json'), JSON.stringify({
    codexAuthMethod: 'oauth',
    codexKeyTail: null,
  }));

  const manager = await createCliSetupManager({
    rootDir,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin', CODEX_HOME: codexHome },
    homeDir: path.dirname(codexHome),
  }).init();

  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"token":"new-oauth-secret"}');
  assert.equal(manager.envFor('codex').OPENAI_API_KEY, undefined);
  assert.equal(JSON.parse(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8')).codexAuthMethod, 'oauth');
  await assert.rejects(fs.access(path.join(rootDir, 'secrets.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(journalPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(credential.backupFile), { code: 'ENOENT' });
});

test('restart rolls back a direct managed OAuth file changed during login', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-oauth-login-crash-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const sourceFile = path.join(rootDir, 'grok', 'auth.json');
  const oldCredential = Buffer.from('{"token":"old-grok-secret"}');
  const newCredential = Buffer.from('{"token":"partial-grok-secret"}');
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, oldCredential);
  const backupFile = `${sourceFile}.oauth-${process.pid}-${randomUUID()}.held`;
  await fs.writeFile(backupFile, oldCredential, { mode: 0o600 });
  await fs.writeFile(sourceFile, newCredential);
  await fs.writeFile(path.join(rootDir, 'config.json'), JSON.stringify({
    grokAuthMethod: 'api-key',
    grokKeyTail: '-key',
  }));
  await fs.writeFile(path.join(rootDir, 'secrets.json'), JSON.stringify({
    'rhwp.grok.api-key': 'xai-api-plaintext',
  }));
  const credential = {
    version: 1,
    sourceFile,
    initialState: 'file',
    initialDigest: sha256(oldCredential),
    publishedDigest: null,
    backupFile,
  };
  const journalPath = path.join(rootDir, 'oauth-auth-grok.journal.json');
  await fs.writeFile(journalPath, JSON.stringify(oauthJournal('grok', credential, 'login')));

  const manager = await createCliSetupManager({
    rootDir,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'profile'),
  }).init();

  assert.deepEqual(await fs.readFile(sourceFile), oldCredential);
  assert.equal(manager.envFor('grok').XAI_API_KEY, 'xai-api-plaintext');
  await assert.rejects(fs.access(journalPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(backupFile), { code: 'ENOENT' });
});

test('startup preserves and rejects an oversized OAuth recovery journal', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-oauth-journal-bound-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const journalPath = path.join(rootDir, 'oauth-auth-codex.journal.json');
  const original = Buffer.alloc((16 * 1024) + 1, 0x61);
  await fs.writeFile(journalPath, original);

  await assert.rejects(
    createCliSetupManager({
      rootDir,
      platform: 'linux',
      baseEnv: { PATH: '/usr/bin' },
      homeDir: path.join(rootDir, 'profile'),
    }).init(),
    { code: 'AGENT_AUTH_RECOVERY_REQUIRED' },
  );
  assert.deepEqual(await fs.readFile(journalPath), original);
});

test('Cursor uses USERPROFILE for native Windows config discovery', async () => {
  const profile = 'D:\\Profiles\\cursor-user';
  assert.equal(defaultCursorHomeDir({ USERPROFILE: profile }, 'win32', 'C:\\wrong-home'), profile);
  assert.equal(
    defaultCursorConfigDir({ USERPROFILE: profile }, 'win32', 'C:\\wrong-home'),
    path.win32.join(profile, '.cursor'),
  );

  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-profile-'));
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options });
    queueMicrotask(() => {
      if (argv[0] === '--version') proc.stdout.emit('data', '2026.08.11-e8db854\n');
      if (argv[0] === 'status') proc.stdout.emit('data', '{"isAuthenticated":true}\n');
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'win32',
    baseEnv: { PATH: 'C:\\bin', USERPROFILE: profile },
    homeDir: 'C:\\wrong-home',
  }).init();

  const status = await manager.status('cursor');
  assert.equal(status.installed, true, 'a PATH-installed Cursor must be discovered');
  assert.equal(status.authenticated, true);
  assert.equal(manager.cursorHomeDir, profile);
  assert.equal(manager.cursorSourceDir, path.win32.join(profile, '.cursor'));
  for (const call of calls) {
    assert.equal(call.options.env.HOME, profile);
    assert.equal(call.options.env.USERPROFILE, profile);
  }

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Codex installs into the app prefix and API login never persists the full key', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-'));
  const prefixDir = path.join(rootDir, 'prefix');
  const { calls, spawnProcess } = fakeSpawner(prefixDir);
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, npmCommand: 'npm', secretStore,
    baseEnv: { PATH: '/usr/bin' }, fetchImpl: acceptingFetch,
  }).init();

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
  assert.equal(manager.envFor('codex').OPENAI_API_KEY, 'sk-proj-secret-value');
  assert.equal(await secretStore.get('rhwp.codex.api-key'), 'sk-proj-secret-value');
  assert.equal(calls.some((call) => call.argv.includes('--with-api-key')), false);
  const configText = await fs.readFile(path.join(rootDir, 'config.json'), 'utf8');
  assert.doesNotMatch(configText, /sk-proj-secret-value/);
  assert.match(configText, /"codexKeyTail": "alue"/);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('concurrent provider API logins serialize shared fallback secrets and config', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-concurrent-auth-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const spawnProcess = () => {
    const proc = new FakeProcess();
    queueMicrotask(() => proc.emit('close', 1, null));
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    platform: 'win32',
    spawnProcess,
    fetchImpl: acceptingFetch,
    baseEnv: { PATH: '', USERPROFILE: 'C:\\Users\\tester' },
  }).init();

  await Promise.all([
    manager.authenticate('codex', 'api-key', 'sk-codex-concurrent'),
    manager.authenticate('grok', 'api-key', 'xai-grok-concurrent'),
  ]);

  const secrets = JSON.parse(await fs.readFile(path.join(rootDir, 'secrets.json'), 'utf8'));
  assert.equal(secrets['rhwp.codex.api-key'], 'sk-codex-concurrent');
  assert.equal(secrets['rhwp.grok.api-key'], 'xai-grok-concurrent');
  const config = JSON.parse(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'));
  assert.equal(config.codexAuthMethod, 'api-key');
  assert.equal(config.grokAuthMethod, 'api-key');
  assert.equal(manager.envFor('codex').OPENAI_API_KEY, 'sk-codex-concurrent');
  assert.equal(manager.envFor('grok').XAI_API_KEY, 'xai-grok-concurrent');
});

test('a failed shared auth write does not poison later providers or resurrect a deleted secret', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-auth-write-recovery-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const configPath = path.join(rootDir, 'config.json');
  const secretsPath = path.join(rootDir, 'secrets.json');
  const failure = new Error('injected shared config failure');
  let failNext = true;
  const spawnProcess = () => {
    const proc = new FakeProcess();
    queueMicrotask(() => proc.emit('close', 1, null));
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    platform: 'win32',
    spawnProcess,
    fetchImpl: acceptingFetch,
    baseEnv: { PATH: '', USERPROFILE: 'C:\\Users\\tester' },
    async replaceConfigFile(tempPath, targetPath, options) {
      if (targetPath === configPath && failNext) {
        failNext = false;
        await fs.copyFile(secretsPath, `${secretsPath}.previous-write`);
        throw failure;
      }
      return replaceFileAtomically(tempPath, targetPath, options);
    },
  }).init();

  await assert.rejects(manager.authenticate('codex', 'api-key', 'sk-rolled-back'), failure);
  await assert.rejects(fs.access(secretsPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${secretsPath}.previous-write`), { code: 'ENOENT' });

  await manager.authenticate('grok', 'api-key', 'xai-after-failure');
  assert.equal(
    JSON.parse(await fs.readFile(secretsPath, 'utf8'))['rhwp.grok.api-key'],
    'xai-after-failure',
  );
  const restarted = await createCliSetupManager({
    rootDir,
    platform: 'win32',
    spawnProcess,
    baseEnv: { PATH: '', USERPROFILE: 'C:\\Users\\tester' },
  }).init();
  assert.equal(restarted.envFor('codex').OPENAI_API_KEY, undefined);
  assert.equal(restarted.envFor('grok').XAI_API_KEY, 'xai-after-failure');
});

test('Claude API setup is restored through the provider environment', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-'));
  const prefixDir = path.join(rootDir, 'prefix');
  const { spawnProcess } = fakeSpawner(prefixDir);
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, npmCommand: 'npm', secretStore,
    baseEnv: { PATH: '/usr/bin' }, fetchImpl: acceptingFetch,
  }).init();

  await manager.install('claude');
  const status = await manager.authenticate('claude', 'api-key', 'sk-ant-secret-value');
  assert.equal(status.setupComplete, true);
  assert.equal(status.authMethod, 'api-key');
  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'sk-ant-secret-value');
  assert.doesNotMatch(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'), /sk-ant-secret-value/);
  assert.equal(
    (await fs.stat(path.join(rootDir, 'config.json'))).mode & 0o777,
    process.platform === 'win32' ? 0o666 : 0o600,
  );

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a legacy plaintext Claude key migrates to the secure vault before being removed', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-migrate-'));
  await fs.writeFile(path.join(rootDir, 'config.json'), JSON.stringify({
    claudeApiKey: 'sk-ant-legacy-secret',
    claudeAuthMethod: 'api-key',
  }));
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({ rootDir, secretStore }).init();

  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'sk-ant-legacy-secret');
  assert.equal(await secretStore.get('rhwp.claude.api-key'), 'sk-ant-legacy-secret');
  assert.doesNotMatch(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'), /legacy-secret/);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('an existing global harness can be reauthenticated without an app-managed install', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-'));
  const prefixDir = path.join(rootDir, 'prefix');
  const { calls, spawnProcess } = fakeSpawner(prefixDir);
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, secretStore, baseEnv: { PATH: '/usr/bin' }, fetchImpl: acceptingFetch,
  }).init();

  const status = await manager.authenticate('codex', 'api-key', 'sk-proj-global-harness');

  assert.equal(status.installed, false);
  assert.equal(status.authenticated, true);
  assert.equal(manager.envFor('codex').OPENAI_API_KEY, 'sk-proj-global-harness');
  assert.equal(calls.some((call) => call.argv.includes('--with-api-key')), false);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Codex OAuth uses device auth on every platform, never a localhost callback', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-auth-'));
    const { calls, spawnProcess } = fakeSpawner(path.join(rootDir, 'prefix'));
    const stagedHome = platform === 'win32'
      ? 'D:\\Managed\\codex-oauth-staging\\run-test'
      : path.join(rootDir, 'codex-oauth-staging', 'run-test');
    const manager = await createCliSetupManager({
      rootDir,
      spawnProcess,
      platform,
      prepareOAuthCredential: async () => oauthTransactionStub(stagedHome),
    }).init();

    await manager.authenticate('codex', 'oauth');
    const login = calls.find((call) => call.argv[0] === 'login');
    assert.equal(login.command, 'codex', platform);
    assert.deepEqual(login.argv, ['login', '--device-auth'], platform);
    assert.equal(login.options.env.CODEX_HOME, stagedHome, platform);

    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('Codex OAuth stages CODEX_HOME and publishes the configured host credential on success', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-codex-stage-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const profile = path.join(rootDir, 'profile');
  const configuredHome = path.join(profile, 'custom-codex');
  const configuredAuth = path.join(configuredHome, 'auth.json');
  const fallbackAuth = path.join(profile, '.codex', 'auth.json');
  await fs.mkdir(path.dirname(configuredAuth), { recursive: true });
  await fs.mkdir(path.dirname(fallbackAuth), { recursive: true });
  await fs.writeFile(configuredAuth, '{"token":"old-configured"}');
  await fs.writeFile(fallbackAuth, '{"token":"old-fallback"}');
  let loginEnv = null;
  const spawnProcess = (_command, argv, options) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      void (async () => {
        if (argv[0] === 'login' && argv[1] === '--device-auth') {
          loginEnv = options.env;
          await fs.writeFile(path.join(options.env.CODEX_HOME, 'auth.json'), '{"token":"new-codex"}');
        }
      })().then(
        () => proc.emit('close', 0, null),
        (error) => proc.emit('error', error),
      );
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin', CODEX_HOME: configuredHome },
    homeDir: profile,
  }).init();

  await manager.authenticate('codex', 'oauth');

  assert.notEqual(loginEnv.CODEX_HOME, configuredHome);
  assert.match(loginEnv.CODEX_HOME, /codex-oauth-staging/);
  assert.equal(await fs.readFile(configuredAuth, 'utf8'), '{"token":"new-codex"}');
  assert.equal(await fs.readFile(fallbackAuth, 'utf8'), '{"token":"old-fallback"}');
  assert.equal(existsSync(loginEnv.CODEX_HOME), false, 'the private profile is removed after commit');
});

test('Codex OAuth falls back to the host .codex auth when configured CODEX_HOME has none', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-codex-precedence-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const profile = path.join(rootDir, 'profile');
  const fallbackAuth = path.join(profile, '.codex', 'auth.json');
  await fs.mkdir(path.dirname(fallbackAuth), { recursive: true });
  await fs.writeFile(fallbackAuth, '{"token":"fallback"}');
  let preparedWith = null;
  const spawnProcess = () => {
    const proc = new FakeProcess();
    queueMicrotask(() => proc.emit('close', 0, null));
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin', CODEX_HOME: path.join(profile, 'empty-codex-home') },
    homeDir: profile,
    prepareOAuthCredential: async (options) => {
      preparedWith = options;
      return oauthTransactionStub(path.join(rootDir, 'codex-stage'));
    },
  }).init();

  await manager.authenticate('codex', 'oauth');

  assert.deepEqual(preparedWith, {
    sourceFile: fallbackAuth,
    stagingParent: path.join(rootDir, 'codex-oauth-staging'),
    relativeCredentialPath: 'auth.json',
    platform: 'linux',
  });
});

test('failed Codex OAuth discards its staged credential and preserves the host credential', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-codex-fail-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const profile = path.join(rootDir, 'profile');
  const sourceFile = path.join(profile, '.codex', 'auth.json');
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, '{"token":"host-old"}');
  let stagedHome = null;
  const spawnProcess = (_command, argv, options) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      void (async () => {
        if (argv[0] === 'login' && argv[1] === '--device-auth') {
          stagedHome = options.env.CODEX_HOME;
          await fs.writeFile(path.join(stagedHome, 'auth.json'), '{"token":"staged-secret"}');
          proc.stderr.emit(
            'data',
            'login failed at C:\\Users\\tester\\.codex\\auth.json '
              + 'sk-proj-0123456789abcdef sk-ant-api03-abcdefghijklmnop '
              + 'Authorization: Bearer bearer-token-12345 '
              + 'https://auth.example/callback?code=oauth-code-123&state=oauth-state-456\n',
          );
          proc.emit('close', 1, null);
          return;
        }
        proc.emit('close', 0, null);
      })().catch((error) => proc.emit('error', error));
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin' },
    homeDir: profile,
  }).init();

  await assert.rejects(manager.authenticate('codex', 'oauth'), (error) => {
    assert.equal(error.code, 'AGENT_AUTH_FAILED');
    assert.match(error.message, /login failed/);
    assert.ok(error.message.includes('C:\\Users\\tester\\.codex\\auth.json'));
    assert.doesNotMatch(
      error.message,
      /0123456789abcdef|abcdefghijklmnop|bearer-token-12345|oauth-code-123|oauth-state-456/,
    );
    return true;
  });
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"token":"host-old"}');
  assert.equal(existsSync(stagedHome), false);
});

test('a concurrent Codex host login wins over the staged setup credential', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-codex-conflict-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const profile = path.join(rootDir, 'profile');
  const sourceFile = path.join(profile, '.codex', 'auth.json');
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, '{"token":"host-old"}');
  const spawnProcess = (_command, argv, options) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      void (async () => {
        if (argv[0] === 'login' && argv[1] === '--device-auth') {
          await fs.writeFile(path.join(options.env.CODEX_HOME, 'auth.json'), '{"token":"staged-secret"}');
          await fs.writeFile(sourceFile, '{"token":"concurrent-login"}');
        }
      })().then(
        () => proc.emit('close', 0, null),
        (error) => proc.emit('error', error),
      );
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin' },
    homeDir: profile,
  }).init();

  await assert.rejects(manager.authenticate('codex', 'oauth'), (error) => {
    assert.equal(error.code, 'AGENT_AUTH_CREDENTIAL_CONFLICT');
    assert.doesNotMatch(String(error.message), /staged-secret|concurrent-login|host-old/);
    return true;
  });
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"token":"concurrent-login"}');
});

test('device auth surfaces the one-time code alongside the login URL', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-devicecode-'));
  const spawnProcess = (command, argv) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      if (argv[0] === 'login') {
        proc.stdout.emit('data', 'Starting device authorization…\n');
        proc.stdout.emit('data', '  \x1B[1mhttps://auth.openai.com/codex/device\x1B[0m\n');
        proc.stdout.emit('data', 'Enter this one-time code:\n\n  ZRRX-M38IS  \n\n');
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, platform: 'darwin', baseEnv: { PATH: '/usr/bin' },
    prepareOAuthCredential: async () => oauthTransactionStub(path.join(rootDir, 'codex-stage')),
  }).init();

  const progress = [];
  await manager.authenticate('codex', 'oauth', undefined, (event) => progress.push(event));
  const last = progress.findLast((event) => event.userCode);
  assert.equal(last.userCode, 'ZRRX-M38IS');
  assert.equal(last.authUrl, 'https://auth.openai.com/codex/device');
  assert.equal(last.state, 'authorizing');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a device code split across output chunks is never surfaced truncated', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-devicecode-split-'));
  const spawnProcess = (command, argv) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      if (argv[0] === 'login') {
        // 청크 경계가 코드 한가운데에 떨어지는 경우 — 잘린 `ZRRX-M38` 이 내보내지면 안 된다.
        proc.stdout.emit('data', 'Enter this one-time code:\n\n  ZRRX-M38');
        proc.stdout.emit('data', 'IS\n');
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, platform: 'darwin', baseEnv: { PATH: '/usr/bin' },
    prepareOAuthCredential: async () => oauthTransactionStub(path.join(rootDir, 'codex-stage')),
  }).init();

  const progress = [];
  await manager.authenticate('codex', 'oauth', undefined, (event) => progress.push(event));
  const codes = progress.filter((event) => event.userCode).map((event) => event.userCode);
  assert.equal(codes.includes('ZRRX-M38'), false);
  assert.equal(codes.at(-1), 'ZRRX-M38IS');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Grok device login reports the code printed on stderr and never mistakes a URL for one', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-grok-code-'));
  const spawnProcess = (command, argv) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      if (argv[0] === 'login') {
        proc.stderr.emit('data', 'To sign in, open this URL in your browser:\n');
        proc.stderr.emit('data', 'https://accounts.x.ai/oauth2/device?user_code=C879-V6G4\n');
        proc.stderr.emit('data', 'Confirm this code in your browser:\n');
        proc.stderr.emit('data', 'C879-V6G4\n');
        proc.stderr.emit('data', 'Waiting for authorization...\n');
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
  }).init();

  const progress = [];
  await manager.authenticate('grok', 'oauth', undefined, (event) => progress.push(event));
  assert.equal(progress.findLast((event) => event.userCode)?.userCode, 'C879-V6G4');
  assert.equal(
    progress.findLast((event) => event.authUrl)?.authUrl,
    'https://accounts.x.ai/oauth2/device?user_code=C879-V6G4',
  );
  // URL 만 나온 첫 프레임에는 코드가 붙지 않는다.
  assert.equal(progress.find((event) => event.authUrl)?.userCode, undefined);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a cursor login URL never registers as a device code', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-code-'));
  const spawnProcess = (command, argv) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      if (argv[0] === 'login') {
        proc.stdout.emit('data', 'https://cursor.com/loginDeepControl?challenge=AB-CD&uuid=EF-GH\n');
      }
      if (argv[0] === 'status') proc.stdout.emit('data', '{"isAuthenticated":true}\n');
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
  }).init();

  const progress = [];
  await manager.authenticate('cursor', 'oauth', undefined, (event) => progress.push(event));
  assert.equal(progress.some((event) => event.userCode), false);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Claude OAuth surfaces a clean login URL and finishes with a pasted code', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-auth-'));
  const cleanUrl = 'https://claude.com/oauth/authorize?code=true&state=abc123';
  let authProc = null;
  const spawnProcess = (command, argv) => {
    const proc = new FakeProcess();
    if (argv[0] === 'auth' && argv[1] === 'login') {
      authProc = proc;
      queueMicrotask(() => {
        proc.stdout.emit(
          'data',
          'Opening browser to sign in…\n'
            + `If the browser didn't open, visit: \x1B]8;;${cleanUrl}\x1B\\${cleanUrl}\x1B]8;;\x1B\\\n`
            + 'Paste code here if prompted >',
        );
      });
    } else {
      queueMicrotask(() => proc.emit('close', 0, null));
    }
    return proc;
  };
  const stagedHome = path.join(rootDir, 'claude-oauth-staging', 'run-test');
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    prepareOAuthCredential: async () => oauthTransactionStub(stagedHome),
  }).init();

  await assert.rejects(manager.submitAuthCode('claude', 'orphan-code'), /진행 중인 로그인이 없어요/);

  const progress = [];
  const running = manager.authenticate('claude', 'oauth', undefined, (event) => progress.push(event));
  const deadline = Date.now() + 2000;
  while (!progress.some((event) => event.authUrl) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(progress.findLast((event) => event.authUrl)?.authUrl, cleanUrl);
  assert.equal(authProc.stdinEnded, false);

  await manager.submitAuthCode('claude', ' my-oauth-code ');
  assert.equal(authProc.input, 'my-oauth-code\n');
  authProc.emit('close', 0, null);
  const status = await running;
  assert.equal(status.authenticated, true);
  assert.equal(status.authMethod, 'oauth');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('oversized OAuth codes are rejected before child stdin is touched', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-auth-code-bound-'));
  let authProc = null;
  const spawnProcess = (_command, argv) => {
    const proc = new FakeProcess();
    if (argv[0] === 'auth' && argv[1] === 'login') authProc = proc;
    else queueMicrotask(() => proc.emit('close', 0, null));
    return proc;
  };
  const stagedHome = path.join(rootDir, 'claude-oauth-staging', 'run-test');
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    prepareOAuthCredential: async () => oauthTransactionStub(stagedHome),
  }).init();

  const running = manager.authenticate('claude', 'oauth');
  await waitFor(() => authProc !== null);
  await assert.rejects(
    manager.submitAuthCode('claude', { toString: () => { throw new Error('must not coerce'); } }),
    { code: 'AGENT_AUTH_CODE_INVALID' },
  );
  await assert.rejects(
    manager.submitAuthCode('claude', 'c'.repeat(AUTH_CODE_MAX_BYTES + 1)),
    { code: 'AGENT_AUTH_CODE_TOO_LARGE' },
  );
  assert.equal(authProc.input, '', 'rejected code must not enqueue any child stdin bytes');

  await manager.submitAuthCode('claude', 'safe-code');
  assert.equal(authProc.input, 'safe-code\n');
  authProc.emit('close', 0, null);
  await running;
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Claude OAuth isolates config and home files, then publishes only its credential', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-claude-stage-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const profile = path.join(rootDir, 'profile');
  const liveConfigDir = path.join(profile, 'custom-claude-config');
  const sourceFile = path.join(liveConfigDir, '.credentials.json');
  const hostConfig = path.join(profile, '.claude.json');
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, '{"oauth":"host-old"}');
  await fs.writeFile(hostConfig, '{"account":"host-config"}');
  let loginEnv = null;
  const spawnProcess = (_command, argv, options) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      void (async () => {
        if (argv[0] === 'auth' && argv[1] === 'login') {
          loginEnv = options.env;
          await fs.writeFile(
            path.join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'),
            '{"oauth":"new-claude"}',
          );
          await fs.writeFile(path.join(options.env.HOME, '.claude.json'), '{"account":"isolated"}');
        }
      })().then(
        () => proc.emit('close', 0, null),
        (error) => proc.emit('error', error),
      );
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: liveConfigDir },
    homeDir: profile,
  }).init();

  await manager.authenticate('claude', 'oauth');

  assert.match(loginEnv.CLAUDE_CONFIG_DIR, /claude-oauth-staging/);
  assert.equal(loginEnv.HOME, loginEnv.CLAUDE_CONFIG_DIR);
  assert.equal(loginEnv.USERPROFILE, loginEnv.CLAUDE_CONFIG_DIR);
  assert.notEqual(loginEnv.HOME, profile);
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"oauth":"new-claude"}');
  assert.equal(await fs.readFile(hostConfig, 'utf8'), '{"account":"host-config"}');
  assert.equal(existsSync(loginEnv.HOME), false, 'the isolated .claude.json is discarded');
});

test('cancelled Claude OAuth preserves the host credential and removes the isolated profile', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-claude-cancel-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const profile = path.join(rootDir, 'profile');
  const liveConfigDir = path.join(profile, 'custom-claude-config');
  const sourceFile = path.join(liveConfigDir, '.credentials.json');
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, '{"oauth":"host-old"}');
  let login = null;
  let stagedHome = null;
  const spawnProcess = (_command, argv, options) => {
    const proc = new FakeProcess();
    if (argv[0] === 'auth' && argv[1] === 'login') {
      login = proc;
      stagedHome = options.env.CLAUDE_CONFIG_DIR;
    } else {
      queueMicrotask(() => proc.emit('close', 0, null));
    }
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: liveConfigDir },
    homeDir: profile,
  }).init();
  const abort = new AbortController();
  const running = manager.authenticate('claude', 'oauth', undefined, undefined, {
    signal: abort.signal,
  });
  await waitFor(() => login);
  await fs.writeFile(path.join(stagedHome, '.credentials.json'), '{"oauth":"cancelled-secret"}');

  abort.abort('cancelled');
  login.emit('close', 0, null);

  await assert.rejects(running, { code: 'AGENT_AUTH_CANCELLED' });
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"oauth":"host-old"}');
  assert.equal(existsSync(stagedHome), false);
});

test('a concurrent Claude credential change wins before app auth state changes', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-claude-conflict-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const profile = path.join(rootDir, 'profile');
  const liveConfigDir = path.join(profile, 'custom-claude-config');
  const sourceFile = path.join(liveConfigDir, '.credentials.json');
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, '{"oauth":"host-old"}');
  const spawnProcess = (_command, argv, options) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      void (async () => {
        if (argv[0] === 'auth' && argv[1] === 'login') {
          await fs.writeFile(
            path.join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'),
            '{"oauth":"staged-secret"}',
          );
          await fs.writeFile(sourceFile, '{"oauth":"concurrent-login"}');
        }
      })().then(
        () => proc.emit('close', 0, null),
        (error) => proc.emit('error', error),
      );
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: liveConfigDir },
    homeDir: profile,
  }).init();

  await assert.rejects(manager.authenticate('claude', 'oauth'), {
    code: 'AGENT_AUTH_CREDENTIAL_CONFLICT',
  });
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"oauth":"concurrent-login"}');
  assert.equal(existsSync(path.join(rootDir, 'config.json')), false);
  assert.equal(existsSync(path.join(rootDir, 'secrets.json')), false);
  assert.equal((await manager.status('claude')).authMethod, 'oauth', 'the external login remains visible');
});

test('Windows Claude OAuth redirects both profile variables and CLAUDE_CONFIG_DIR', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-claude-win-env-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const stagedHome = 'D:\\Managed\\claude-oauth-staging\\run-test';
  let preparedWith = null;
  let loginEnv = null;
  const spawnProcess = (_command, argv, options) => {
    const proc = new FakeProcess();
    if (argv[0] === 'auth' && argv[1] === 'login') loginEnv = options.env;
    queueMicrotask(() => proc.emit('close', 0, null));
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'win32',
    baseEnv: {
      PATH: 'C:\\bin',
      USERPROFILE: 'D:\\Profiles\\claude-user',
      CLAUDE_CONFIG_DIR: 'E:\\Claude\\live-config',
    },
    homeDir: 'C:\\wrong-home',
    prepareOAuthCredential: async (options) => {
      preparedWith = options;
      return oauthTransactionStub(stagedHome);
    },
  }).init();

  await manager.authenticate('claude', 'oauth');

  assert.deepEqual(preparedWith, {
    sourceFile: 'E:\\Claude\\live-config\\.credentials.json',
    stagingParent: path.join(rootDir, 'claude-oauth-staging'),
    relativeCredentialPath: '.credentials.json',
    platform: 'win32',
  });
  assert.equal(loginEnv.CLAUDE_CONFIG_DIR, stagedHome);
  assert.equal(loginEnv.HOME, stagedHome);
  assert.equal(loginEnv.USERPROFILE, stagedHome);
});

test('cancelled Windows Claude OAuth leaves the custom host credential unpublished', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-claude-win-cancel-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const lifecycle = [];
  const stagedHome = 'D:\\Managed\\claude-oauth-staging\\run-cancel';
  const transaction = oauthTransactionStub(stagedHome, stagedHome, lifecycle);
  let preparedWith = null;
  let login = null;
  const spawnProcess = (_command, argv) => {
    const proc = new FakeProcess();
    if (argv[0] === 'auth' && argv[1] === 'login') login = proc;
    else queueMicrotask(() => proc.emit('close', 0, null));
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'win32',
    baseEnv: {
      PATH: 'C:\\bin',
      USERPROFILE: 'D:\\Profiles\\claude-user',
      CLAUDE_CONFIG_DIR: 'E:\\Claude\\live-config',
    },
    prepareOAuthCredential: async (options) => {
      preparedWith = options;
      return transaction;
    },
  }).init();
  const abort = new AbortController();
  const running = manager.authenticate('claude', 'oauth', undefined, undefined, {
    signal: abort.signal,
  });
  await waitFor(() => login);

  abort.abort('cancelled');
  login.emit('close', 0, null);

  await assert.rejects(running, { code: 'AGENT_AUTH_CANCELLED' });
  assert.equal(preparedWith.sourceFile, 'E:\\Claude\\live-config\\.credentials.json');
  assert.deepEqual(lifecycle, ['rollback', 'cleanup']);
  assert.equal(existsSync(path.join(rootDir, 'config.json')), false);
});

test('a Windows Claude custom-dir conflict wins before app auth commit', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-claude-win-conflict-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const lifecycle = [];
  let secretDeletes = 0;
  const stagedHome = 'D:\\Managed\\claude-oauth-staging\\run-conflict';
  const transaction = oauthTransactionStub(stagedHome, stagedHome, lifecycle);
  transaction.publish = async () => {
    lifecycle.push('publish');
    throw Object.assign(new Error('concurrent host credential'), {
      code: 'AGENT_AUTH_CREDENTIAL_CONFLICT',
    });
  };
  let preparedWith = null;
  const spawnProcess = () => {
    const proc = new FakeProcess();
    queueMicrotask(() => proc.emit('close', 0, null));
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'win32',
    baseEnv: {
      PATH: 'C:\\bin',
      USERPROFILE: 'D:\\Profiles\\claude-user',
      CLAUDE_CONFIG_DIR: 'E:\\Claude\\live-config',
    },
    secretStore: {
      available: true,
      async get() { return null; },
      async set() {},
      async delete() { secretDeletes += 1; },
    },
    prepareOAuthCredential: async (options) => {
      preparedWith = options;
      return transaction;
    },
  }).init();

  await assert.rejects(manager.authenticate('claude', 'oauth'), {
    code: 'AGENT_AUTH_CREDENTIAL_CONFLICT',
  });
  assert.equal(preparedWith.sourceFile, 'E:\\Claude\\live-config\\.credentials.json');
  assert.deepEqual(lifecycle, ['publish', 'rollback', 'cleanup']);
  assert.equal(secretDeletes, 0);
  assert.equal(existsSync(path.join(rootDir, 'config.json')), false);
});

test('macOS Claude OAuth fails before spawning and leaves API-key setup available', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-claude-darwin-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  let spawnCount = 0;
  const manager = await createCliSetupManager({
    rootDir,
    platform: 'darwin',
    baseEnv: { PATH: '/usr/bin' },
    fetchImpl: acceptingFetch,
    spawnProcess: () => {
      spawnCount += 1;
      const proc = new FakeProcess();
      queueMicrotask(() => proc.emit('close', 0, null));
      return proc;
    },
  }).init();

  await assert.rejects(manager.authenticate('claude', 'oauth'), (error) => {
    assert.equal(error.code, 'AGENT_AUTH_OAUTH_UNSUPPORTED');
    assert.match(error.message, /API 키/);
    return true;
  });
  assert.equal(spawnCount, 0);
  const apiStatus = await manager.authenticate('claude', 'api-key', 'sk-ant-safe-alternative');
  assert.equal(apiStatus.authMethod, 'api-key');
  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'sk-ant-safe-alternative');
});

test('Grok installs through the shared npm prefix and stores the API key securely', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-grok-'));
  const prefixDir = path.join(rootDir, 'prefix');
  const { calls, spawnProcess } = fakeSpawner(prefixDir);
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, npmCommand: 'npm', secretStore, fetchImpl: acceptingFetch,
    baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
  }).init();

  const installed = await manager.install('grok');
  assert.equal(installed.installed, true);
  assert.equal(installed.version, '1.2.3');
  assert.deepEqual(calls[0].argv, [
    'install', '--prefix', prefixDir, '--no-fund', '--no-audit', '@xai-official/grok',
  ]);

  const status = await manager.authenticate('grok', 'api-key', 'xai-secret-value');
  assert.equal(status.authenticated, true);
  assert.equal(status.authMethod, 'api-key');
  assert.equal(status.keyTail, 'alue');
  assert.equal(manager.envFor('grok').XAI_API_KEY, 'xai-secret-value');
  assert.equal(await secretStore.get('rhwp.grok.api-key'), 'xai-secret-value');
  const configText = await fs.readFile(path.join(rootDir, 'config.json'), 'utf8');
  assert.doesNotMatch(configText, /xai-secret-value/);
  assert.match(configText, /"grokAuthMethod": "api-key"/);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Grok auth state is read from the auth.json file without spawning the CLI', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-grok-auth-'));
  const homeDir = path.join(rootDir, 'fake-home');
  const calls = [];
  const spawnProcess = () => { throw new Error('grok 상태 확인은 CLI 를 스폰하면 안 된다'); };
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' }, homeDir,
  }).init();

  const before = await manager.status('grok');
  assert.equal(before.authenticated, false);
  assert.equal(await manager.grokAuthPath(), null);

  await fs.mkdir(path.join(rootDir, 'grok'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'grok', 'auth.json'), '{"token":"managed"}');
  const managed = await manager.status('grok');
  assert.equal(managed.authenticated, true);
  assert.equal(managed.authMethod, 'oauth');
  assert.equal(await manager.grokAuthPath(), path.join(rootDir, 'grok', 'auth.json'));

  // 홈 디렉터리의 auth.json 이 관리형 홈보다 우선한다.
  await fs.mkdir(path.join(homeDir, '.grok'), { recursive: true });
  await fs.writeFile(path.join(homeDir, '.grok', 'auth.json'), '{"token":"home"}');
  assert.equal(await manager.grokAuthPath(), path.join(homeDir, '.grok', 'auth.json'));
  assert.equal(calls.length, 0);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Grok OAuth logs in against the managed GROK_HOME', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-grok-oauth-'));
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(() => {
      if (argv[0] === 'login') proc.stdout.emit('data', 'Visit https://accounts.x.ai/device?code=abc\n');
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
  }).init();

  const progress = [];
  await manager.authenticate('grok', 'oauth', undefined, (event) => progress.push(event));
  const login = calls.find((call) => call.argv[0] === 'login');
  assert.equal(login.command, 'grok');
  assert.equal(login.options.env.GROK_HOME, path.join(rootDir, 'grok'));
  assert.equal(progress.findLast((event) => event.authUrl)?.authUrl, 'https://accounts.x.ai/device?code=abc');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('cancelled Grok OAuth preserves its API key and discards late credentials and output', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-grok-oauth-cancel-'));
  const secretStore = createMemorySecretStore();
  let authProc = null;
  let loginOptions = null;
  const spawnProcess = (_command, argv, options) => {
    const proc = new FakeProcess();
    if (argv[0] === 'login') {
      authProc = proc;
      loginOptions = options;
    } else {
      queueMicrotask(() => proc.emit('close', 0, null));
    }
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    secretStore,
    spawnProcess,
    fetchImpl: acceptingFetch,
    baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
  }).init();
  await manager.authenticate('grok', 'api-key', 'xai-working-key');
  const beforeConfig = await fs.readFile(path.join(rootDir, 'config.json'), 'utf8');
  const abort = new AbortController();
  let staleOutput = false;
  const running = manager.authenticate('grok', 'oauth', undefined, () => {
    if (staleOutput) throw new Error('stale progress must be isolated');
  }, { signal: abort.signal });
  const rejected = assert.rejects(running, { code: 'AGENT_AUTH_CANCELLED' });
  while (!authProc) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loginOptions.env.XAI_API_KEY, undefined, 'OAuth child must not inherit the preserved API key');

  abort.abort('user-cancelled');
  staleOutput = true;
  const cancelling = manager.cancel('grok');
  await fs.writeFile(path.join(manager.grokHomeDir, 'auth.json'), '{"oauth":"too-late"}');
  assert.doesNotThrow(() => authProc.stdout.emit('data', 'late buffered output\n'));
  authProc.emit('close', 0, null);

  await cancelling;
  await rejected;
  assert.equal(await secretStore.get('rhwp.grok.api-key'), 'xai-working-key');
  assert.equal(manager.envFor('grok').XAI_API_KEY, 'xai-working-key');
  assert.equal(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'), beforeConfig);
  assert.equal(existsSync(path.join(manager.grokHomeDir, 'auth.json')), false);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Grok OAuth persistence failure restores prior auth and its app-owned credential file', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-grok-oauth-rollback-'));
  const configPath = path.join(rootDir, 'config.json');
  const grokAuthPath = path.join(rootDir, 'grok', 'auth.json');
  await fs.mkdir(path.dirname(grokAuthPath), { recursive: true });
  await fs.writeFile(grokAuthPath, '{"oauth":"previous"}');
  await fs.writeFile(configPath, `${JSON.stringify({
    grokAuthMethod: 'api-key',
    grokKeyTail: '-key',
  })}\n`);
  let stored = 'xai-working-key';
  let failConfigCommit = true;
  const persistenceError = new Error('config persistence failed after replacement');
  const secretStore = {
    available: true,
    async get(id) { return id === 'rhwp.grok.api-key' ? stored : null; },
    async set(_id, value) {
      stored = value;
    },
    async delete() {
      stored = null;
    },
  };
  const spawnProcess = (_command, argv) => {
    const proc = new FakeProcess();
    queueMicrotask(async () => {
      if (argv[0] === 'login') {
        await fs.mkdir(path.dirname(grokAuthPath), { recursive: true });
        await fs.writeFile(grokAuthPath, '{"oauth":"partial"}');
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    secretStore,
    spawnProcess,
    async replaceConfigFile(tempPath, targetPath, options) {
      await replaceFileAtomically(tempPath, targetPath, options);
      if (targetPath === configPath && failConfigCommit) {
        failConfigCommit = false;
        throw persistenceError;
      }
    },
    baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
  }).init();

  await assert.rejects(manager.authenticate('grok', 'oauth'), persistenceError);
  assert.equal(stored, 'xai-working-key');
  assert.equal(manager.envFor('grok').XAI_API_KEY, 'xai-working-key');
  const restored = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(restored.grokAuthMethod, 'api-key');
  assert.equal(restored.grokKeyTail, '-key');
  assert.equal(await fs.readFile(grokAuthPath, 'utf8'), '{"oauth":"previous"}');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('OAuth fails closed when an app-owned credential cannot be safely snapshotted', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-oauth-snapshot-'));
  const grokAuthPath = path.join(rootDir, 'grok', 'auth.json');
  await fs.mkdir(path.dirname(grokAuthPath), { recursive: true });
  await fs.writeFile(grokAuthPath, Buffer.alloc(1024 * 1024 + 1));
  let spawns = 0;
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess: () => { spawns += 1; throw new Error('must not spawn'); },
    baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
  }).init();

  await assert.rejects(manager.authenticate('grok', 'oauth'), {
    code: 'AGENT_AUTH_SNAPSHOT_FAILED',
  });
  assert.equal(spawns, 0);
  assert.equal((await fs.stat(grokAuthPath)).size, 1024 * 1024 + 1);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Cursor installs through the official script into its own home', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-'));
  const cursorBin = path.join(rootDir, 'cursor-home', '.local', 'bin', 'cursor-agent');
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(() => {
      if (command === '/bin/bash') {
        mkdirSync(path.dirname(cursorBin), { recursive: true });
        writeFileSync(cursorBin, '#!/bin/bash\n');
        proc.stdout.emit('data', 'Cursor Agent installed\n');
        proc.emit('close', 0, null);
        return;
      }
      if (argv[0] === '--version') {
        proc.stdout.emit('data', '2026.08.11-e8db854\n');
        proc.emit('close', 0, null);
        return;
      }
      if (argv[0] === 'status') {
        proc.stdout.emit('data', '{"status":"unauthenticated","isAuthenticated":false}\n');
        proc.emit('close', 0, null);
        return;
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, platform: 'darwin', baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
  }).init();

  const progress = [];
  const status = await manager.install('cursor', (event) => progress.push(event));
  const installCall = calls[0];
  assert.equal(installCall.command, '/bin/bash');
  assert.deepEqual(installCall.argv, ['-c', 'curl -fsS https://cursor.com/install | bash']);
  assert.equal(installCall.options.env.HOME, path.join(rootDir, 'cursor-home'));
  assert.equal(status.installed, true);
  assert.equal(status.version, '2026.08.11-e8db854');
  assert.equal(status.authenticated, false);
  assert.equal(manager.binPath('cursor'), cursorBin);
  assert.deepEqual(progress.map((event) => event.phase), [
    'preparing', 'resolving', 'installing', 'installing', 'verifying', 'done',
  ]);
  // 버전 프로브는 실제 ~/.cursor 를 오염시키지 않도록 전용 경로를 쓴다.
  const versionCall = calls.find((call) => call.argv[0] === '--version');
  assert.equal(versionCall.options.env.HOME, path.join(rootDir, 'cursor-home'));
  assert.equal(versionCall.options.env.CURSOR_CONFIG_DIR, path.join(rootDir, 'cursor-home', '.cursor-probe'));

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Cursor install on Windows fails with a clear pointer to the official installer', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-win-'));
  const manager = await createCliSetupManager({
    rootDir, spawnProcess: () => { throw new Error('should not spawn'); },
    platform: 'win32', baseEnv: { PATH: 'C:\\bin' }, homeDir: path.join(rootDir, 'no-home'),
  }).init();

  await assert.rejects(manager.install('cursor'), (error) => {
    assert.equal(error.code, 'AGENT_INSTALL_FAILED');
    assert.match(error.message, /Windows/);
    assert.match(error.message, /cursor\.com\/install/);
    return true;
  });

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Cursor auth state trusts the status JSON body, never the exit code', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-auth-'));
  let authenticated = false;
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(() => {
      if (argv[0] === 'status') {
        // 실제 CLI 는 한 줄 JSON 이 아니라 여러 줄로 들여쓴 JSON 을 낸다.
        proc.stdout.emit('data', `${JSON.stringify({
          status: authenticated ? 'authenticated' : 'unauthenticated',
          isAuthenticated: authenticated,
          message: 'x',
        }, null, 2)}\n`);
      }
      // 로그아웃 상태에서도 종료 코드는 0 이다.
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
  }).init();

  assert.equal((await manager.status('cursor')).authenticated, false);
  authenticated = true;
  const status = await manager.status('cursor');
  assert.equal(status.authenticated, true);
  assert.equal(status.authMethod, 'oauth');
  const statusCall = calls.find((call) => call.argv[0] === 'status');
  assert.deepEqual(statusCall.argv, ['status', '--format', 'json']);
  assert.equal(statusCall.options.env.HOME, path.join(rootDir, 'cursor-home'));

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Cursor OAuth login runs with NO_OPEN_BROWSER against the persistent home', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-oauth-'));
  const loginUrl = 'https://cursor.com/loginDeepControl?challenge=abc&uuid=def&mode=login&redirectTarget=cli';
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(() => {
      if (argv[0] === 'login') {
        proc.stdout.emit('data', `Open a browser and navigate to this link: ${loginUrl}\n`);
      }
      if (argv[0] === 'status') {
        proc.stdout.emit('data', '{"isAuthenticated":true}\n');
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
  }).init();

  const progress = [];
  const status = await manager.authenticate('cursor', 'oauth', undefined, (event) => progress.push(event));
  const login = calls.find((call) => call.argv[0] === 'login');
  assert.equal(login.command, 'cursor-agent');
  assert.equal(login.options.env.HOME, path.join(rootDir, 'cursor-home'));
  assert.equal(login.options.env.NO_OPEN_BROWSER, '1');
  assert.equal(progress.findLast((event) => event.authUrl)?.authUrl, loginUrl);
  assert.equal(status.authenticated, true);
  assert.equal(status.authMethod, 'oauth');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Windows Cursor OAuth uses an isolated profile and publishes only at the commit boundary', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-win-oauth-'));
  const profile = 'D:\\Profiles\\cursor-user';
  const stagedHome = 'D:\\Managed\\cursor-oauth-staging\\run-1';
  const stagedConfig = `${stagedHome}\\.cursor`;
  const calls = [];
  const lifecycle = [];
  let preparedWith = null;
  const transaction = {
    homeDir: stagedHome,
    configDir: stagedConfig,
    async publish() { lifecycle.push('publish'); },
    async rollback() { lifecycle.push('rollback'); },
    async cleanup() { lifecycle.push('cleanup'); },
    markCommitted() { lifecycle.push('mark-committed'); },
  };
  const prepareOAuthCredential = async (options) => {
    preparedWith = options;
    return transaction;
  };
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(() => {
      if (argv[0] === 'status') proc.stdout.emit('data', '{"isAuthenticated":true}\n');
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    prepareOAuthCredential,
    platform: 'win32',
    baseEnv: {
      PATH: 'C:\\bin',
      USERPROFILE: profile,
      HOME: profile,
      CURSOR_CONFIG_DIR: `${profile}\\untrusted-override`,
    },
    homeDir: profile,
  }).init();

  const status = await manager.authenticate(
    'cursor',
    'oauth',
    undefined,
    undefined,
    { onCommitted: () => lifecycle.push('registry-commit') },
  );

  assert.deepEqual(preparedWith, {
    sourceFile: path.win32.join(profile, '.cursor', 'cli-config.json'),
    stagingParent: path.join(rootDir, 'cursor-oauth-staging'),
    platform: 'win32',
  });
  const login = calls.find((call) => call.argv[0] === 'login');
  assert.equal(login.options.env.HOME, stagedHome);
  assert.equal(login.options.env.USERPROFILE, stagedHome);
  assert.equal(login.options.env.CURSOR_CONFIG_DIR, stagedConfig);
  assert.equal(login.options.env.NO_OPEN_BROWSER, '1');
  assert.deepEqual(lifecycle, ['publish', 'cleanup', 'registry-commit', 'mark-committed']);
  assert.equal(status.authMethod, 'oauth');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('cancelled Windows Cursor OAuth discards its isolated credential without publishing it', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-win-oauth-cancel-'));
  const lifecycle = [];
  let login = null;
  const transaction = {
    homeDir: 'D:\\Managed\\cursor-oauth-staging\\run-cancelled',
    configDir: 'D:\\Managed\\cursor-oauth-staging\\run-cancelled\\.cursor',
    async publish() { lifecycle.push('publish'); },
    async rollback() { lifecycle.push('rollback'); },
    async cleanup() { lifecycle.push('cleanup'); },
    markCommitted() { lifecycle.push('mark-committed'); },
  };
  const spawnProcess = (_command, argv) => {
    const proc = new FakeProcess();
    if (argv[0] === 'login') login = proc;
    else queueMicrotask(() => proc.emit('close', 0, null));
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    prepareOAuthCredential: async () => transaction,
    platform: 'win32',
    baseEnv: { PATH: 'C:\\bin', USERPROFILE: 'D:\\Profiles\\cursor-user' },
  }).init();
  const abort = new AbortController();
  const running = manager.authenticate(
    'cursor', 'oauth', undefined, undefined, { signal: abort.signal },
  );
  await waitFor(() => login);

  abort.abort('user-cancelled');
  login.emit('close', 0, null);
  await assert.rejects(running, { code: 'AGENT_AUTH_CANCELLED' });
  assert.deepEqual(lifecycle, ['rollback', 'cleanup']);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a Windows Cursor credential conflict wins before app auth state is mutated', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-win-oauth-conflict-'));
  const lifecycle = [];
  let secretDeletes = 0;
  const secretStore = {
    available: true,
    async get() { return null; },
    async set() {},
    async delete() { secretDeletes += 1; },
  };
  const transaction = {
    homeDir: 'D:\\Managed\\cursor-oauth-staging\\run-conflict',
    configDir: 'D:\\Managed\\cursor-oauth-staging\\run-conflict\\.cursor',
    async publish() {
      lifecycle.push('publish');
      throw Object.assign(new Error('concurrent credential'), {
        code: 'AGENT_AUTH_CREDENTIAL_CONFLICT',
      });
    },
    async rollback() { lifecycle.push('rollback'); },
    async cleanup() { lifecycle.push('cleanup'); },
    markCommitted() { lifecycle.push('mark-committed'); },
  };
  const spawnProcess = (_command, argv) => {
    const proc = new FakeProcess();
    queueMicrotask(() => proc.emit('close', 0, null));
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    secretStore,
    prepareOAuthCredential: async () => transaction,
    platform: 'win32',
    baseEnv: { PATH: 'C:\\bin', USERPROFILE: 'D:\\Profiles\\cursor-user' },
  }).init();

  await assert.rejects(manager.authenticate('cursor', 'oauth'), {
    code: 'AGENT_AUTH_CREDENTIAL_CONFLICT',
  });
  assert.deepEqual(lifecycle, ['publish', 'rollback', 'cleanup']);
  assert.equal(secretDeletes, 0);
  assert.equal((await manager.status('cursor')).authMethod, null);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Cursor model list parsing drops prose lines and caches with a TTL', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-models-'));
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(() => {
      if (argv[0] === '--list-models') {
        proc.stdout.emit('data', 'Available models:\n\ngpt-5.2\nsonnet-4.6-thinking\nopus-4.5\n한글 안내문은 무시\n');
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
  }).init();

  const models = await manager.cursorModels();
  assert.deepEqual(models, ['gpt-5.2', 'sonnet-4.6-thinking', 'opus-4.5']);
  const listCall = calls.find((call) => call.argv[0] === '--list-models');
  assert.equal(listCall.options.env.HOME, path.join(rootDir, 'cursor-home'));

  // TTL 안의 재호출은 캐시를 돌려주고 CLI 를 다시 스폰하지 않는다.
  const spawnCount = calls.length;
  assert.deepEqual(await manager.cursorModels(), models);
  assert.equal(calls.length, spawnCount);
  await manager.cursorModels({ refresh: true });
  assert.equal(calls.length, spawnCount + 1);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a failing cursor model list is cached too, so the CLI is not respawned every call', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-models-fail-'));
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(() => {
      if (argv[0] === '--list-models') proc.stderr.emit('data', 'not logged in\n');
      proc.emit('close', argv[0] === '--list-models' ? 1 : 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
  }).init();

  assert.deepEqual(await manager.cursorModels(), []);
  const spawnCount = calls.length;
  assert.deepEqual(await manager.cursorModels(), []);
  assert.deepEqual(await manager.cursorModels(), []);
  assert.equal(calls.length, spawnCount, '실패도 TTL 에 기록해 재스폰을 막는다');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('without an OS vault the API key falls back to a 0600 secrets file and survives a restart', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-filekey-'));
  const secretsPath = path.join(rootDir, 'secrets.json');
  const options = {
    rootDir, fetchImpl: acceptingFetch, baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
    spawnProcess: () => { throw new Error('키 저장은 CLI 를 스폰하지 않는다'); },
  };
  const manager = await createCliSetupManager(options).init();

  const status = await manager.authenticate('grok', 'api-key', 'xai-file-secret-value');
  assert.equal(status.authenticated, true);
  assert.equal(status.authMethod, 'api-key');
  assert.equal(status.keyTail, 'alue');
  assert.equal(status.error, null);
  assert.deepEqual(JSON.parse(await fs.readFile(secretsPath, 'utf8')), {
    'rhwp.grok.api-key': 'xai-file-secret-value',
  });
  assert.equal(
    (await fs.stat(secretsPath)).mode & 0o777,
    process.platform === 'win32' ? 0o666 : 0o600,
  );
  assert.doesNotMatch(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'), /file-secret-value/);

  const restarted = await createCliSetupManager(options).init();
  assert.equal(restarted.envFor('grok').XAI_API_KEY, 'xai-file-secret-value');
  assert.equal((await restarted.status('grok')).authMethod, 'api-key');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('corrupt fallback secret files are preserved and block every secret mutation', async (t) => {
  const cases = [
    ['truncated JSON', Buffer.from('{"rhwp.codex.api-key":"keep"')],
    ['oversized file', Buffer.alloc((64 * 1024) + 1, 0x61)],
    ['array shape', Buffer.from('["secret"]')],
    ['unknown key', Buffer.from('{"unknown.provider":"secret"}')],
    ['non-string value', Buffer.from('{"rhwp.codex.api-key":42}')],
  ];
  for (const [label, original] of cases) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-secrets-corrupt-'));
    t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    const secretsPath = path.join(rootDir, 'secrets.json');
    await fs.writeFile(secretsPath, original);
    const manager = await createCliSetupManager({
      rootDir,
      baseEnv: { PATH: '/usr/bin' },
      fetchImpl: acceptingFetch,
      spawnProcess: () => { throw new Error('corrupt storage must fail before status spawn'); },
    }).init();

    await assert.rejects(
      manager.authenticate('codex', 'api-key', 'sk-proj-new-secret'),
      (error) => {
        assert.equal(error.code, 'SECRET_FILE_CORRUPT', label);
        assert.doesNotMatch(error.message, /keep|new-secret|unknown\.provider/, label);
        return true;
      },
    );
    assert.deepEqual(await fs.readFile(secretsPath), original, label);
    assert.match((await manager.status('grok')).error, /API 키 파일/, label);
  }
});

test('a corrupt secret-file decision stays sticky until restart and never rewrites repaired bytes', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-secrets-sticky-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const secretsPath = path.join(rootDir, 'secrets.json');
  await fs.writeFile(secretsPath, '{broken');
  const manager = await createCliSetupManager({
    rootDir,
    baseEnv: { PATH: '/usr/bin' },
    fetchImpl: acceptingFetch,
    spawnProcess: () => { throw new Error('sticky corruption must fail before status spawn'); },
  }).init();
  const repaired = '{"rhwp.grok.api-key":"preserve-after-external-repair"}';
  await fs.writeFile(secretsPath, repaired);

  await assert.rejects(
    manager.authenticate('codex', 'api-key', 'sk-proj-must-not-write'),
    { code: 'SECRET_FILE_CORRUPT' },
  );
  assert.equal(await fs.readFile(secretsPath, 'utf8'), repaired);
});

test('a corrupt fallback file blocks vault writes before they start', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-secrets-vault-fence-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const secretsPath = path.join(rootDir, 'secrets.json');
  const original = '{"rhwp.codex.api-key":';
  await fs.writeFile(secretsPath, original);
  let writes = 0;
  const secretStore = {
    available: true,
    async get() { return null; },
    async set() { writes += 1; },
    async delete() { writes += 1; },
  };
  const manager = await createCliSetupManager({
    rootDir,
    secretStore,
    baseEnv: { PATH: '/usr/bin' },
    fetchImpl: acceptingFetch,
  }).init();

  await assert.rejects(
    manager.authenticate('codex', 'api-key', 'sk-proj-must-not-reach-vault'),
    { code: 'SECRET_FILE_CORRUPT' },
  );
  assert.equal(writes, 0);
  assert.equal(await fs.readFile(secretsPath, 'utf8'), original);
});

test('an OAuth login clears the file-stored key for that agent', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-filekey-clear-'));
  const secretsPath = path.join(rootDir, 'secrets.json');
  await fs.writeFile(secretsPath, JSON.stringify({
    'rhwp.grok.api-key': 'xai-old',
    'rhwp.codex.api-key': 'sk-proj-keep',
  }));
  const spawnProcess = (command, argv) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      if (argv[0] === 'login') proc.stdout.emit('data', 'Visit https://accounts.x.ai/device\n');
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
  }).init();
  assert.equal(manager.envFor('grok').XAI_API_KEY, 'xai-old');

  await manager.authenticate('grok', 'oauth');
  assert.deepEqual(JSON.parse(await fs.readFile(secretsPath, 'utf8')), {
    'rhwp.codex.api-key': 'sk-proj-keep',
  });
  assert.equal(manager.envFor('grok').XAI_API_KEY, undefined);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('file-stored keys migrate into the OS vault and leave nothing behind', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-filekey-migrate-'));
  const secretsPath = path.join(rootDir, 'secrets.json');
  await fs.writeFile(secretsPath, JSON.stringify({
    'rhwp.grok.api-key': 'xai-migrated',
    'rhwp.cursor.api-key': 'cur-migrated',
  }));
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({
    rootDir, secretStore, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
    spawnProcess: () => { throw new Error('이관은 CLI 를 스폰하지 않는다'); },
  }).init();

  assert.equal(manager.envFor('grok').XAI_API_KEY, 'xai-migrated');
  assert.equal(manager.envFor('cursor').CURSOR_API_KEY, 'cur-migrated');
  assert.equal(await secretStore.get('rhwp.grok.api-key'), 'xai-migrated');
  assert.equal(await secretStore.get('rhwp.cursor.api-key'), 'cur-migrated');
  assert.equal(existsSync(secretsPath), false, '이관이 끝나면 파일 보관소는 남지 않는다');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a vault failure is surfaced instead of silently falling back to the file store', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-vault-fail-'));
  const secretStore = {
    available: true,
    async get() { return null; },
    async set() { throw Object.assign(new Error('vault locked'), { code: 'SECRET_STORE_FAILED' }); },
    async delete() { return true; },
  };
  const manager = await createCliSetupManager({
    rootDir, secretStore, fetchImpl: acceptingFetch, baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
  }).init();

  await assert.rejects(manager.authenticate('grok', 'api-key', 'xai-value'), /vault locked/);
  assert.equal(existsSync(path.join(rootDir, 'secrets.json')), false);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('CLI API key commit rolls back a vault write that fails after mutation', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-key-rollback-'));
  let stored = null;
  const secretStore = {
    available: true,
    async get() { return stored; },
    async set(_id, value) {
      stored = value;
      throw new Error('vault write failed after mutation');
    },
    async delete() { stored = null; },
  };
  const manager = await createCliSetupManager({
    rootDir,
    secretStore,
    fetchImpl: acceptingFetch,
    baseEnv: { PATH: '/usr/bin' },
    spawnProcess: () => { throw new Error('API key auth must not spawn'); },
  }).init();

  await assert.rejects(manager.authenticate('codex', 'api-key', 'sk-proj-partial'));
  assert.equal(stored, null);
  assert.equal(manager.envFor('codex').OPENAI_API_KEY, undefined);
  assert.equal((await manager.status('codex')).authenticated, false);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('API keys are checked against the provider before they are stored', async () => {
  const cases = [
    { agent: 'claude', key: 'sk-ant-check', url: 'https://api.anthropic.com/v1/models?limit=1' },
    { agent: 'codex', key: 'sk-proj-check', url: 'https://api.openai.com/v1/models' },
    { agent: 'grok', key: 'xai-check', url: 'https://api.x.ai/v1/models' },
  ];
  for (const item of cases) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-keycheck-'));
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      return { status: 200, ok: true };
    };
    const manager = await createCliSetupManager({
      rootDir, fetchImpl, secretStore: createMemorySecretStore(),
      baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
      spawnProcess: () => { throw new Error('키 검증은 CLI 를 스폰하지 않는다'); },
    }).init();

    const status = await manager.authenticate(item.agent, 'api-key', item.key);
    assert.equal(status.authenticated, true, item.agent);
    assert.equal(requests.length, 1, item.agent);
    assert.equal(requests[0].url, item.url);
    assert.equal(requests[0].init.method, 'GET');
    if (item.agent === 'claude') {
      assert.equal(requests[0].init.headers['x-api-key'], item.key);
      assert.equal(requests[0].init.headers['anthropic-version'], '2023-06-01');
    } else {
      assert.equal(requests[0].init.headers.Authorization, `Bearer ${item.key}`);
    }

    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('oversized CLI API keys are rejected before load, fetch, vault, or file side effects', async () => {
  const rootDir = path.join(os.tmpdir(), `rhwp-cli-key-input-bound-${randomUUID()}`);
  let fetchCalls = 0;
  let vaultCalls = 0;
  const secretStore = {
    available: true,
    async get() { vaultCalls += 1; return null; },
    async set() { vaultCalls += 1; },
    async delete() { vaultCalls += 1; },
  };
  const manager = createCliSetupManager({
    rootDir,
    secretStore,
    fetchImpl: async () => { fetchCalls += 1; return { status: 200, ok: true }; },
    baseEnv: { PATH: '/usr/bin' },
    spawnProcess: () => { throw new Error('oversized key must not spawn'); },
  });

  await assert.rejects(
    manager.authenticate('codex', 'api-key', { toString: () => { throw new Error('must not coerce'); } }),
    { code: 'AGENT_KEY_INVALID' },
  );
  for (const oversized of [
    'k'.repeat(API_KEY_MAX_BYTES + 1),
    '한'.repeat(Math.floor(API_KEY_MAX_BYTES / 3) + 1),
  ]) {
    await assert.rejects(
      manager.authenticate('codex', 'api-key', oversized),
      { code: 'AGENT_KEY_TOO_LARGE' },
    );
  }
  assert.equal(fetchCalls, 0);
  assert.equal(vaultCalls, 0);
  await assert.rejects(fs.stat(rootDir), { code: 'ENOENT' });
});

test('oversized persisted CLI keys are never loaded into provider environments', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-key-load-bound-'));
  const oversized = 'k'.repeat(API_KEY_MAX_BYTES + 1);
  const secretsPath = path.join(rootDir, 'secrets.json');
  await fs.writeFile(secretsPath, JSON.stringify({ 'rhwp.codex.api-key': oversized }));

  const fromFile = await createCliSetupManager({
    rootDir,
    baseEnv: { PATH: '/usr/bin' },
    spawnProcess: () => { throw new Error('oversized stored key must not spawn'); },
  }).init();
  assert.equal(fromFile.envFor('codex').OPENAI_API_KEY, undefined);
  assert.equal(await fs.readFile(secretsPath, 'utf8'), JSON.stringify({ 'rhwp.codex.api-key': oversized }));

  const fromVault = await createCliSetupManager({
    rootDir: path.join(rootDir, 'vault-case'),
    secretStore: {
      available: true,
      async get(id) { return id === 'rhwp.codex.api-key' ? oversized : null; },
      async set() { throw new Error('oversized stored key must not migrate'); },
      async delete() { throw new Error('oversized stored key must not mutate'); },
    },
    baseEnv: { PATH: '/usr/bin' },
    spawnProcess: () => { throw new Error('oversized stored key must not spawn'); },
  }).init();
  assert.equal(fromVault.envFor('codex').OPENAI_API_KEY, undefined);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a rejected API key is reported and never persisted', async () => {
  for (const agent of ['claude', 'codex', 'grok']) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-keybad-'));
    const secretStore = createMemorySecretStore();
    const manager = await createCliSetupManager({
      rootDir, secretStore, fetchImpl: rejectingFetch,
      baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
      spawnProcess: () => { throw new Error('키 검증은 CLI 를 스폰하지 않는다'); },
    }).init();

    await assert.rejects(manager.authenticate(agent, 'api-key', 'wrong-key'), (error) => {
      assert.equal(error.code, 'AGENT_KEY_INVALID', agent);
      assert.equal(error.message, 'API 키가 유효하지 않아요. 키를 확인해 주세요.');
      return true;
    });
    assert.equal(await secretStore.get(`rhwp.${agent}.api-key`), null);
    assert.equal(existsSync(path.join(rootDir, 'secrets.json')), false);
    assert.equal(existsSync(path.join(rootDir, 'config.json')), false);

    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('an x.ai-style 400 with a key error body rejects, a scoped 403 without one passes', async () => {
  const cases = [
    {
      fetchImpl: async () => ({
        status: 400, ok: false,
        text: async () => '{"code":"invalid-argument","error":"Incorrect API key provided."}',
      }),
      rejects: true,
    },
    {
      fetchImpl: async () => ({
        status: 403, ok: false,
        text: async () => '{"error":{"message":"You have insufficient permissions for this operation."}}',
      }),
      rejects: false,
    },
  ];
  for (const item of cases) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-keybody-'));
    const secretStore = createMemorySecretStore();
    const manager = await createCliSetupManager({
      rootDir, secretStore, fetchImpl: item.fetchImpl,
      baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
      spawnProcess: () => { throw new Error('키 검증은 CLI 를 스폰하지 않는다'); },
    }).init();

    if (item.rejects) {
      await assert.rejects(manager.authenticate('grok', 'api-key', 'xai-wrong'), (error) => {
        assert.equal(error.code, 'AGENT_KEY_INVALID');
        return true;
      });
      assert.equal(await secretStore.get('rhwp.grok.api-key'), null);
    } else {
      const status = await manager.authenticate('grok', 'api-key', 'xai-scoped');
      assert.equal(status.authenticated, true);
      assert.equal(await secretStore.get('rhwp.grok.api-key'), 'xai-scoped');
    }

    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('API key error bodies above 64 KiB are cancelled and treated as inconclusive', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-keybound-'));
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({
    rootDir,
    secretStore,
    fetchImpl: async () => new Response('api key '.repeat(9_000), { status: 400 }),
    baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
    spawnProcess: () => { throw new Error('key validation must not spawn a CLI'); },
  }).init();

  const status = await manager.authenticate('grok', 'api-key', 'xai-scoped');
  assert.equal(status.authenticated, true);
  assert.equal(await secretStore.get('rhwp.grok.api-key'), 'xai-scoped');
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('an offline or unusual key check never blocks setup', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('network unreachable'); },
    async () => ({ status: 500, ok: false }),
  ]) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-keyoffline-'));
    const secretStore = createMemorySecretStore();
    const manager = await createCliSetupManager({
      rootDir, secretStore, fetchImpl,
      baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
      spawnProcess: () => { throw new Error('키 검증은 CLI 를 스폰하지 않는다'); },
    }).init();

    const status = await manager.authenticate('codex', 'api-key', 'sk-proj-offline');
    assert.equal(status.authenticated, true);
    assert.equal(await secretStore.get('rhwp.codex.api-key'), 'sk-proj-offline');

    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('closing the owner session during delayed CLI key validation cannot persist the key', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-key-close-'));
  const secretStore = createMemorySecretStore();
  let markValidationStarted = () => {};
  let releaseValidation = () => {};
  let requestSignal = null;
  const validationStarted = new Promise((resolve) => { markValidationStarted = resolve; });
  const validationGate = new Promise((resolve) => { releaseValidation = resolve; });
  const manager = await createCliSetupManager({
    rootDir,
    secretStore,
    fetchImpl: async (_url, init = {}) => {
      requestSignal = init.signal;
      markValidationStarted();
      await validationGate;
      return { status: 200, ok: true };
    },
    baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
    spawnProcess: () => { throw new Error('key validation must not spawn a CLI'); },
  }).init();
  const abort = new AbortController();

  const pending = manager.authenticate(
    'codex',
    'api-key',
    'sk-proj-session-closed',
    undefined,
    { signal: abort.signal },
  );
  await validationStarted;
  abort.abort('owner-session-closed');
  releaseValidation();

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'AGENT_AUTH_CANCELLED');
    return true;
  });
  assert.equal(requestSignal?.aborted, true, 'session cancellation reaches the validation request');
  assert.equal(await secretStore.get('rhwp.codex.api-key'), null);
  assert.equal(manager.envFor('codex').OPENAI_API_KEY, undefined);
  await assert.rejects(fs.stat(path.join(rootDir, 'config.json')));

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a Cursor API key is checked through the CLI status command', async () => {
  for (const authenticated of [true, false]) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursorkey-'));
    const calls = [];
    const spawnProcess = (command, argv, options) => {
      const proc = new FakeProcess();
      calls.push({ command, argv, options, proc });
      queueMicrotask(() => {
        if (argv[0] === 'status') {
          proc.stdout.emit('data', `${JSON.stringify({ isAuthenticated: authenticated }, null, 2)}\n`);
        }
        proc.emit('close', 0, null);
      });
      return proc;
    };
    const secretStore = createMemorySecretStore();
    const manager = await createCliSetupManager({
      rootDir,
      spawnProcess,
      secretStore,
      platform: 'linux',
      baseEnv: { PATH: '/usr/bin' },
      homeDir: path.join(rootDir, 'no-home'),
    }).init();

    if (authenticated) {
      const status = await manager.authenticate('cursor', 'api-key', 'cur-good-key');
      assert.equal(status.authenticated, true);
      assert.equal(await secretStore.get('rhwp.cursor.api-key'), 'cur-good-key');
    } else {
      await assert.rejects(manager.authenticate('cursor', 'api-key', 'cur-bad-key'), (error) => {
        assert.equal(error.code, 'AGENT_KEY_INVALID');
        return true;
      });
      assert.equal(await secretStore.get('rhwp.cursor.api-key'), null);
    }
    const check = calls.find((call) => call.argv[0] === 'status');
    assert.deepEqual(check.argv, ['status', '--format', 'json']);
    assert.equal(check.options.env.CURSOR_API_KEY, authenticated ? 'cur-good-key' : 'cur-bad-key');
    // 로그인 세션이 남은 cursor-home 이 아니라 검증 전용 빈 HOME 에서 키만으로 판정한다.
    assert.ok(check.options.env.HOME.startsWith(path.join(rootDir, 'cursor-key-check-')));
    assert.equal(check.options.env.USERPROFILE, check.options.env.HOME);
    assert.equal(check.options.env.CURSOR_CONFIG_DIR, check.options.env.HOME);
    assert.equal(existsSync(check.options.env.HOME), false, 'the one-shot check home is removed');

    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('a Cursor key check that cannot run is not treated as a rejection', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursorkey-offline-'));
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({
    rootDir, secretStore, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
    spawnProcess: () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); },
  }).init();

  const status = await manager.authenticate('cursor', 'api-key', 'cur-unverified');
  assert.equal(status.authenticated, true);
  assert.equal(await secretStore.get('rhwp.cursor.api-key'), 'cur-unverified');

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
    rootDir, spawnProcess, npmCommand: 'npm', fetchImpl, baseEnv: { PATH: '/usr/bin' },
  }).init();

  const status = await manager.automaticUpdate('codex');
  assert.equal(status.version, '1.0.0');
  assert.equal(status.latestVersion, '1.1.0');
  assert.equal(status.updateRequired, true);
  assert.match(status.error, /자동 업데이트/);
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
    rootDir, spawnProcess, npmCommand: 'npm', fetchImpl, baseEnv: { PATH: '/usr/bin' },
  }).init();

  const status = await manager.automaticUpdate('codex');
  assert.equal(status.version, '1.1.0');
  assert.equal(status.updateRequired, false);
  assert.equal(JSON.parse(await fs.readFile(packagePath(`${prefixDir}.previous`), 'utf8')).version, '1.0.0');

  await fs.rm(rootDir, { recursive: true, force: true });
});

/** 조건이 참이 될 때까지 이벤트 루프를 돌린다. 시간이 다 되면 그대로 진행한다. */
async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('a provider environment carries only its own managed API key', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-envscope-'));
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess: () => { throw new Error('환경 구성은 CLI 를 스폰하지 않는다'); },
    homeDir: path.join(rootDir, 'no-home'),
    baseEnv: {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-hub',
      OPENAI_API_KEY: 'sk-proj-hub',
      XAI_API_KEY: 'xai-hub',
      CURSOR_API_KEY: 'cur-hub',
    },
  }).init();

  // 허브 프로세스 환경에 올라온 다른 프로바이더의 키는 자식으로 넘어가지 않는다.
  const grokEnv = manager.envFor('grok');
  assert.equal(grokEnv.XAI_API_KEY, 'xai-hub');
  assert.equal(grokEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(grokEnv.OPENAI_API_KEY, undefined);
  assert.equal(grokEnv.CURSOR_API_KEY, undefined);

  const cursorEnv = manager.envFor('cursor');
  assert.equal(cursorEnv.CURSOR_API_KEY, 'cur-hub');
  assert.equal(cursorEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(cursorEnv.XAI_API_KEY, undefined);

  const claudeEnv = manager.envFor('claude');
  assert.equal(claudeEnv.ANTHROPIC_API_KEY, 'sk-ant-hub');
  assert.equal(claudeEnv.OPENAI_API_KEY, undefined);
  assert.equal(claudeEnv.XAI_API_KEY, undefined);
  assert.equal(claudeEnv.CURSOR_API_KEY, undefined);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('cursor key checks replace every inherited profile path with the isolated home', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-configdir-'));
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(() => {
      if (argv[0] === 'status') proc.stdout.emit('data', '{"isAuthenticated":true}\n');
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    secretStore,
    platform: 'linux',
    homeDir: path.join(rootDir, 'no-home'),
    baseEnv: { PATH: '/usr/bin', CURSOR_CONFIG_DIR: path.join(rootDir, 'operator-config') },
  }).init();

  await manager.authenticate('cursor', 'api-key', 'cur-good-key');

  const check = calls.find((call) => call.argv[0] === 'status');
  assert.ok(check.options.env.HOME.startsWith(path.join(rootDir, 'cursor-key-check-')));
  assert.equal(check.options.env.USERPROFILE, check.options.env.HOME);
  assert.equal(check.options.env.CURSOR_CONFIG_DIR, check.options.env.HOME);
  assert.equal(existsSync(check.options.env.HOME), false, 'the one-shot check home is removed');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Windows Cursor key checks cannot reuse an OAuth session from the real profile', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-win-key-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const realProfile = path.join(rootDir, 'real-profile');
  let check;
  const manager = await createCliSetupManager({
    rootDir,
    platform: 'win32',
    homeDir: realProfile,
    baseEnv: {
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: realProfile,
      CURSOR_CONFIG_DIR: path.join(realProfile, '.cursor'),
    },
    secretStore: createMemorySecretStore(),
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      if (argv[0] === 'status') check = { command, argv, options };
      queueMicrotask(() => {
        proc.stdout.emit('data', '{"isAuthenticated":false}\n');
        proc.emit('close', 0, null);
      });
      return proc;
    },
  }).init();

  await assert.rejects(
    manager.authenticate('cursor', 'api-key', 'cur-invalid-key'),
    { code: 'AGENT_KEY_INVALID' },
  );
  const isolated = check.options.env.HOME;
  assert.ok(isolated.startsWith(path.join(rootDir, 'cursor-key-check-')));
  assert.equal(check.options.env.HOME, isolated);
  assert.equal(check.options.env.USERPROFILE, isolated);
  assert.equal(check.options.env.CURSOR_CONFIG_DIR, isolated);
  assert.equal(existsSync(isolated), false, 'the one-shot check home is removed');
});

test('Cursor key checks never reuse state written by an earlier validation', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-key-fresh-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const checkHomes = [];
  const spawnProcess = (_command, argv, options) => {
    const proc = new FakeProcess();
    queueMicrotask(() => {
      void (async () => {
        if (argv[0] === 'status') {
          const marker = path.join(options.env.HOME, 'stale-oauth-state');
          const inheritedState = existsSync(marker);
          checkHomes.push(options.env.HOME);
          await fs.writeFile(marker, 'state written by the CLI');
          proc.stdout.emit('data', `${JSON.stringify({
            isAuthenticated: options.env.CURSOR_API_KEY === 'cur-good-key' || inheritedState,
          })}\n`);
        }
        proc.emit('close', 0, null);
      })().catch((error) => proc.emit('error', error));
    });
    return proc;
  };
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    secretStore,
    platform: 'win32',
    baseEnv: { PATH: 'C:\\Windows\\System32', USERPROFILE: path.join(rootDir, 'real-profile') },
    homeDir: path.join(rootDir, 'real-profile'),
  }).init();

  await manager.authenticate('cursor', 'api-key', 'cur-good-key');
  await assert.rejects(
    manager.authenticate('cursor', 'api-key', 'cur-bad-key'),
    { code: 'AGENT_KEY_INVALID' },
  );

  assert.equal(checkHomes.length, 2);
  assert.notEqual(checkHomes[0], checkHomes[1]);
  assert.ok(checkHomes.every((home) => home.startsWith(path.join(rootDir, 'cursor-key-check-'))));
  assert.ok(checkHomes.every((home) => !existsSync(home)), 'every one-shot check home is removed');
  assert.equal(await secretStore.get('rhwp.cursor.api-key'), 'cur-good-key');
});

test('an uncertain Cursor key-check cleanup retains its home and blocks key persistence', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-key-uncertain-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const checkHomes = [];
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({
    rootDir,
    secretStore,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'real-profile'),
    terminateProcessTreeImpl: async (proc) => {
      proc.exitCode = 1;
      proc.emit('exit', 1, null);
      proc.emit('close', 1, null);
      return false;
    },
    spawnProcess(_command, argv, options) {
      const proc = new FakeProcess();
      if (argv[0] === 'status') checkHomes.push(options.env.HOME);
      queueMicrotask(() => proc.stdout.emit('data', Buffer.alloc(256 * 1024, 0x78)));
      return proc;
    },
  }).init();

  await assert.rejects(
    manager.authenticate('cursor', 'api-key', 'cur-must-not-persist'),
    (error) => {
      assert.equal(error.code, 'AGENT_SETUP_OUTPUT_TOO_LARGE');
      assert.equal(error.processCleanupUncertain, true);
      return true;
    },
  );
  assert.equal(checkHomes.length, 1);
  assert.equal(existsSync(checkHomes[0]), true, 'a possibly live child may still use this home');
  assert.equal(await secretStore.get('rhwp.cursor.api-key'), null);

  await assert.rejects(
    manager.authenticate('cursor', 'api-key', 'cur-retry-must-not-persist'),
    { code: 'AGENT_SETUP_CLEANUP_PENDING' },
  );
  assert.equal(checkHomes.length, 1, 'a retry must not spawn while cleanup is uncertain');
  assert.equal(await secretStore.get('rhwp.cursor.api-key'), null);
});

test('Cursor key checks fail closed when their isolated home cannot be created', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-key-create-fail-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const secretStore = createMemorySecretStore();
  let keyCheckSpawned = false;
  const manager = await createCliSetupManager({
    rootDir,
    secretStore,
    platform: 'linux',
    createCursorKeyCheckHome: async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    },
    spawnProcess(_command, argv) {
      if (argv[0] === 'status') keyCheckSpawned = true;
      const proc = new FakeProcess();
      queueMicrotask(() => proc.emit('close', 0, null));
      return proc;
    },
  }).init();

  await assert.rejects(
    manager.authenticate('cursor', 'api-key', 'cur-must-not-persist'),
    { code: 'AGENT_KEY_CHECK_ISOLATION_FAILED' },
  );
  assert.equal(keyCheckSpawned, false);
  assert.equal(await secretStore.get('rhwp.cursor.api-key'), null);
});

test('Cursor key checks fail closed when their isolated home cannot be removed', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-key-remove-fail-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const secretStore = createMemorySecretStore();
  let removeOptions = null;
  const manager = await createCliSetupManager({
    rootDir,
    secretStore,
    platform: 'win32',
    baseEnv: { PATH: 'C:\\Windows\\System32', USERPROFILE: path.join(rootDir, 'real-profile') },
    removeCursorKeyCheckHome: async (_home, options) => {
      removeOptions = options;
      throw Object.assign(new Error('profile is locked'), { code: 'EBUSY' });
    },
    spawnProcess(_command, _argv, options) {
      const proc = new FakeProcess();
      queueMicrotask(() => {
        proc.stdout.emit('data', '{"isAuthenticated":true}\n');
        proc.emit('close', 0, null);
      });
      return proc;
    },
  }).init();

  await assert.rejects(
    manager.authenticate('cursor', 'api-key', 'cur-must-not-persist'),
    { code: 'AGENT_KEY_CHECK_CLEANUP_FAILED' },
  );
  assert.deepEqual(removeOptions, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  assert.equal(await secretStore.get('rhwp.cursor.api-key'), null);
});

test('cancelling a Cursor API-key check cannot persist the pending key', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-key-cancel-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const secretStore = createMemorySecretStore();
  let checkProcess = null;
  let checkHome = null;
  const manager = await createCliSetupManager({
    rootDir,
    secretStore,
    platform: 'linux',
    spawnProcess(_command, argv, options) {
      const proc = new FakeProcess();
      if (argv[0] === 'status') {
        checkProcess = proc;
        checkHome = options.env.HOME;
      } else {
        queueMicrotask(() => proc.emit('close', 0, null));
      }
      return proc;
    },
  }).init();

  const authentication = manager.authenticate('cursor', 'api-key', 'cur-cancelled');
  await waitFor(() => checkProcess !== null);
  assert.equal(await manager.cancel('cursor'), true);
  await assert.rejects(authentication, { code: 'AGENT_AUTH_CANCELLED' });
  assert.equal(await secretStore.get('rhwp.cursor.api-key'), null);
  assert.equal(existsSync(checkHome), false, 'the confirmed-stopped process no longer needs its home');
});

test('a successful Cursor login refetches the model list instead of serving the pre-login cache', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-models-login-'));
  const calls = [];
  let loggedIn = false;
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(() => {
      if (argv[0] === 'status') proc.stdout.emit('data', '{"isAuthenticated":true}\n');
      if (argv[0] === '--list-models') {
        if (!loggedIn) {
          proc.stderr.emit('data', "Error: Authentication required. Run 'agent login'\n");
          proc.emit('close', 1, null);
          return;
        }
        proc.stdout.emit('data', 'gpt-5.2\nsonnet-4.6-thinking\n');
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, secretStore,
    baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
  }).init();

  // 로그인 전 조회는 빈 목록을 TTL 에 남긴다.
  assert.deepEqual(await manager.cursorModels(), []);
  loggedIn = true;
  assert.deepEqual(await manager.cursorModels(), [], 'TTL 안에서는 캐시가 그대로 쓰인다');

  await manager.authenticate('cursor', 'api-key', 'cur-good-key');
  assert.deepEqual(await manager.cursorModels(), ['gpt-5.2', 'sonnet-4.6-thinking']);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('cursor self-update is skipped while a session may start', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-cursor-update-'));
  const cursorBin = path.join(rootDir, 'cursor-home', '.local', 'bin', 'cursor-agent');
  await fs.mkdir(path.dirname(cursorBin), { recursive: true });
  await fs.writeFile(cursorBin, '#!/bin/bash\n');
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(() => {
      if (argv[0] === '--version') proc.stdout.emit('data', '2026.08.11-e8db854\n');
      if (argv[0] === 'status') proc.stdout.emit('data', '{"isAuthenticated":false}\n');
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin' },
    homeDir: path.join(rootDir, 'no-home'),
  }).init();

  const busy = await manager.automaticUpdate('cursor', { canActivate: () => false });
  assert.equal(busy.version, '2026.08.11-e8db854');
  assert.equal(calls.some((call) => call.argv[0] === 'update'), false, '세션이 있으면 바이너리를 바꾸지 않는다');
  assert.equal(busy.error, null);

  await manager.automaticUpdate('cursor', { canActivate: () => true });
  const updateCall = calls.find((call) => call.argv[0] === 'update');
  assert.ok(updateCall, '한가할 때는 자기 갱신이 돈다');
  assert.equal(updateCall.options.env.HOME, path.join(rootDir, 'cursor-home'));

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a user install queues behind an in-flight automatic update of the same prefix', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-prefix-queue-'));
  const prefixDir = path.join(rootDir, 'prefix');
  const packagePath = (base, name) => path.join(base, 'node_modules', ...name.split('/'), 'package.json');
  await fs.mkdir(path.dirname(packagePath(prefixDir, '@openai/codex')), { recursive: true });
  await fs.writeFile(packagePath(prefixDir, '@openai/codex'), JSON.stringify({ version: '1.0.0' }));

  const spawnOrder = [];
  let releaseUpdate;
  const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });
  const spawnProcess = (command, argv) => {
    const proc = new FakeProcess();
    if (argv[0] !== 'install') {
      // 상태 조회(codex login status 등)는 그대로 통과시킨다.
      queueMicrotask(() => proc.emit('close', 0, null));
      return proc;
    }
    const targetPrefix = argv[2];
    const request = String(argv.at(-1));
    spawnOrder.push(request);
    void (async () => {
      if (request.startsWith('@openai/codex')) await updateGate;
      const [name, version] = request.startsWith('@')
        ? [request.split('@').slice(0, 2).join('@'), request.split('@')[2] ?? '1.2.3']
        : [request, '1.2.3'];
      await fs.mkdir(path.dirname(packagePath(targetPrefix, name)), { recursive: true });
      await fs.writeFile(packagePath(targetPrefix, name), JSON.stringify({ name, version }));
      proc.emit('close', 0, null);
    })();
    return proc;
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: '1.1.0', dist: {} }) });
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, npmCommand: 'npm', fetchImpl,
    baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
  }).init();

  const progress = [];
  const updating = manager.automaticUpdate('codex');
  const installing = manager.install('grok', (event) => progress.push(event));

  await waitFor(() => spawnOrder.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(spawnOrder, ['@openai/codex@1.1.0'], '설치는 갱신이 끝날 때까지 prefix 를 건드리지 않는다');
  // 큐에서 기다리는 동안에도 카드는 준비 단계를 먼저 받는다.
  assert.deepEqual(progress.map((event) => event.phase), ['preparing']);

  releaseUpdate();
  const [updated, installed] = await Promise.all([updating, installing]);

  assert.deepEqual(spawnOrder, ['@openai/codex@1.1.0', '@xai-official/grok']);
  assert.equal(updated.version, '1.1.0');
  assert.equal(installed.installed, true);
  assert.deepEqual(progress.map((event) => event.phase), [
    'preparing', 'resolving', 'installing', 'verifying', 'done',
  ]);
  // 갱신본 교체가 방금 끝난 설치를 지워 버리지 않는다.
  assert.equal(JSON.parse(await fs.readFile(packagePath(prefixDir, '@openai/codex'), 'utf8')).version, '1.1.0');
  assert.equal(JSON.parse(await fs.readFile(packagePath(prefixDir, '@xai-official/grok'), 'utf8')).version, '1.2.3');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a cancel flag left by a successful login does not swallow the next real failure', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-auth-cancel-'));
  const logins = [];
  const spawnProcess = (command, argv) => {
    const proc = new FakeProcess();
    // 로그인 프로세스는 테스트가 직접 끝낸다 — 취소 창을 재현하기 위해서다.
    if (argv[0] === 'login') logins.push(proc);
    else queueMicrotask(() => proc.emit('close', 0, null));
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
  }).init();

  // 브라우저 왕복이 끝나 CLI 는 0 으로 죽는데, 카드가 아직 도는 사이에 취소를 누른다.
  const first = manager.authenticate('grok', 'oauth');
  await waitFor(() => logins.length === 1);
  const cancelling = manager.cancel('grok');
  logins[0].emit('close', 0, null);
  await cancelling;
  const success = await first;
  assert.equal(success.authMethod, null);

  // 다음 로그인이 진짜로 실패하면 취소가 아니라 실패로 보고한다.
  const second = manager.authenticate('grok', 'oauth');
  await waitFor(() => logins.length === 2);
  logins[1].stderr.emit('data', 'device authorization expired\n');
  logins[1].emit('close', 1, null);
  await assert.rejects(second, (error) => {
    assert.equal(error.code, 'AGENT_AUTH_FAILED');
    assert.match(error.message, /device authorization expired/);
    return true;
  });

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('authentication kills a CLI that exceeds the bounded stderr tail', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-output-cap-'));
  const spawned = [];
  const spawnProcess = (command, argv) => {
    const proc = new FakeProcess();
    spawned.push({ argv, proc });
    queueMicrotask(() => {
      if (argv[0] === 'login') {
        proc.stderr.emit('data', Buffer.alloc(16 * 1024 + 1, 0x78));
        proc.stderr.emit('data', Buffer.alloc(16 * 1024, 0x79));
        return;
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
  }).init();

  await assert.rejects(manager.authenticate('grok', 'oauth'), (error) => {
    assert.equal(error.code, 'AGENT_SETUP_OUTPUT_TOO_LARGE');
    return true;
  });
  assert.ok(spawned.find((call) => call.argv[0] === 'login'));

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Windows OAuth output failure waits for taskkill and leader exit before rollback', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-output-tree-'));
  let login;
  let taskkill;
  const spawnProcess = (command, argv) => {
    if (command === 'C:\\Windows\\System32\\taskkill.exe') {
      taskkill = new EventEmitter();
      return taskkill;
    }
    const proc = new FakeProcess();
    if (argv[0] === 'login') {
      proc.pid = 4242;
      login = proc;
    } else {
      queueMicrotask(() => proc.emit('close', 0, null));
    }
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess,
    platform: 'win32',
    baseEnv: { PATH: 'C:\\bin', USERPROFILE: rootDir, SystemRoot: 'C:\\Windows' },
    homeDir: rootDir,
  }).init();

  const auth = manager.authenticate('grok', 'oauth');
  while (!login) await new Promise((resolve) => setImmediate(resolve));
  login.stderr.emit('data', Buffer.alloc(16 * 1024 + 1, 0x78));
  let settled = false;
  void auth.catch(() => {}).finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.ok(taskkill, 'Windows cleanup must invoke taskkill');

  login.exitCode = 1;
  login.emit('exit', 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'leader exit alone is not tree cleanup proof');
  taskkill.emit('exit', 0, null);
  await assert.rejects(auth, { code: 'AGENT_SETUP_OUTPUT_TOO_LARGE' });

  await fs.rm(rootDir, { recursive: true, force: true });
});

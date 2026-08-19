import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCliSetupManager, defaultCliSetupRoot } from '../cli-setup-manager.mjs';
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
  kill() { return true; }
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
    const manager = await createCliSetupManager({ rootDir, spawnProcess, platform }).init();

    await manager.authenticate('codex', 'oauth');
    const login = calls.find((call) => call.argv[0] === 'login');
    assert.equal(login.command, 'codex', platform);
    assert.deepEqual(login.argv, ['login', '--device-auth'], platform);

    await fs.rm(rootDir, { recursive: true, force: true });
  }
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
    rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
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
  const manager = await createCliSetupManager({ rootDir, spawnProcess }).init();

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
    rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
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
    rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
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
    rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
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
      rootDir, spawnProcess, secretStore,
      baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
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
    assert.equal(check.options.env.HOME, path.join(rootDir, 'cursor-home', 'key-check'));

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

test('cursor probes drop an inherited CURSOR_CONFIG_DIR so the isolated HOME decides', async () => {
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
    rootDir, spawnProcess, secretStore, homeDir: path.join(rootDir, 'no-home'),
    baseEnv: { PATH: '/usr/bin', CURSOR_CONFIG_DIR: path.join(rootDir, 'operator-config') },
  }).init();

  await manager.authenticate('cursor', 'api-key', 'cur-good-key');

  const check = calls.find((call) => call.argv[0] === 'status');
  assert.equal(check.options.env.HOME, path.join(rootDir, 'cursor-home', 'key-check'));
  assert.equal(check.options.env.CURSOR_CONFIG_DIR, undefined, '상속된 설정 디렉터리는 HOME 격리를 무너뜨린다');

  await fs.rm(rootDir, { recursive: true, force: true });
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
    rootDir, spawnProcess, baseEnv: { PATH: '/usr/bin' }, homeDir: path.join(rootDir, 'no-home'),
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

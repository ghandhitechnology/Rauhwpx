import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RAU_DEFAULT_MODEL_ID, RAU_LOCKED_MODELS } from '../../rau-credits/catalog.mjs';
import { replaceFileAtomically } from '../harness-update.mjs';
import {
  createPiManager,
  defaultPiRoot,
  PI_API_KEY_MAX_CHARS,
  PI_MODEL_ID_MAX_CHARS,
  PI_MODEL_NAME_MAX_CHARS,
  PI_SECRET_ID,
  PI_SETTINGS_MAX_BYTES,
  RAU_SECRET_ID,
} from '../pi-manager.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

class FakeStream extends EventEmitter {}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = null;

  kill(signal) {
    this.killed = signal;
    return true;
  }
}

/** npm 을 대신하는 스폰 스텁 — 호출 인자를 기록하고 종료 코드를 흉내 낸다. */
function fakeSpawner(onSpawn) {
  const spawns = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    spawns.push({ command, argv, options, proc });
    queueMicrotask(() => { void onSpawn?.(proc, argv); });
    return proc;
  };
  return { spawns, spawnProcess };
}

/** 설치 성공을 흉내 낸다: 패키지 package.json 을 심고 0으로 끝낸다. */
function installer(prefixDir, version = '0.84.3') {
  return async (proc) => {
    const dir = path.join(prefixDir, 'node_modules', ...PI_PACKAGE.split('/'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: PI_PACKAGE, version }));
    proc.stdout.emit('data', 'added 42 packages\n');
    proc.emit('close', 0, null);
  };
}

const CATALOG = [
  {
    id: 'deepseek/deepseek-chat-v3.1',
    name: 'DeepSeek: Chat v3.1',
    provider: 'deepseek',
    contextLength: 163840,
    pricing: { prompt: 0.0000002, completion: 0.0000008 },
    reasoning: true,
    supportsImages: false,
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    name: 'Anthropic: Claude Haiku 4.5',
    provider: 'anthropic',
    contextLength: 200000,
    pricing: { prompt: 0.000001, completion: 0.000005 },
    reasoning: false,
    supportsImages: true,
  },
  {
    id: 'openai/gpt-5-mini',
    name: 'OpenAI: GPT-5 mini',
    provider: 'openai',
    contextLength: 400000,
    pricing: { prompt: 0.00000025, completion: 0.000002 },
    reasoning: true,
    supportsImages: true,
  },
];

function fakeOpenRouter({ valid = true } = {}) {
  const calls = { validate: [], catalog: 0, cleared: 0 };
  return {
    calls,
    async validateKey(key) {
      calls.validate.push(key);
      return valid
        ? { valid: true, label: 'rhwp', limit: 10, usage: 1, isFreeTier: false }
        : { valid: false, label: null, limit: null, usage: null, isFreeTier: false };
    },
    async catalog() {
      calls.catalog += 1;
      return CATALOG;
    },
    async credits() {
      return { balanceUsd: 9, totalCreditsUsd: 10, totalUsageUsd: 1, checkedAt: 1 };
    },
    clearCache() { calls.cleared += 1; },
  };
}

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-pi-'));
}

/** 레지스트리가 없는 환경 — 결정적 내려받기를 건너뛰고 npm 폴백을 태운다. */
async function offlineFetch() {
  throw new Error('offline');
}

/** 레지스트리 메타 + 타르볼 스트림을 흉내 내는 fetch. */
function fakeRegistryFetch({ chunks, integrity = null, contentLength = null, version = '0.84.3' }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/latest')) {
      return {
        ok: true,
        json: async () => ({
          version,
          dist: { tarball: `https://registry.npmjs.org/pi/-/pi-${version}.tgz`, integrity },
        }),
      };
    }
    return {
      ok: true,
      headers: {
        get: (name) => (name === 'content-length' && contentLength !== null ? String(contentLength) : null),
      },
      body: (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    };
  };
  return { calls, fetchImpl };
}

function sha512Integrity(chunks) {
  const hash = createHash('sha512');
  for (const chunk of chunks) hash.update(chunk);
  return `sha512-${hash.digest('base64')}`;
}

/** 청크마다 시간이 성큼 가는 시계 — 진행 이벤트 스로틀을 항상 통과시킨다. */
function fastClock() {
  let tick = 0;
  return () => (tick += 1_000);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('RHWP_PI_DIR overrides the per-platform app data root', () => {
  assert.equal(defaultPiRoot({ RHWP_PI_DIR: '/tmp/pi-here' }), path.resolve('/tmp/pi-here'));
  assert.equal(
    defaultPiRoot({}, 'darwin', '/Users/tester'),
    '/Users/tester/Library/Application Support/rhwp/pi',
  );
  assert.equal(
    defaultPiRoot({ APPDATA: 'C:\\data' }, 'win32', 'C:\\Users\\t'),
    path.win32.join('C:\\data', 'rhwp', 'pi'),
  );
  assert.equal(defaultPiRoot({}, 'linux', '/home/t'), '/home/t/.local/share/rhwp/pi');
});

test('status on a missing root reports not installed and never spawns', async () => {
  const { spawns, spawnProcess } = fakeSpawner();
  const rootDir = path.join(os.tmpdir(), `rhwp-pi-missing-${process.pid}`);
  const manager = createPiManager({ rootDir, spawnProcess, openRouter: fakeOpenRouter() });

  const status = await manager.status();
  assert.deepEqual(status, {
    installed: false,
    installing: false,
    version: null,
    keyConfigured: false,
    keyTail: null,
    account: null,
    models: [],
    defaultModelId: null,
    setupComplete: false,
    latestVersion: null,
    updateRequired: false,
    error: null,
  });
  assert.equal(spawns.length, 0);
  assert.equal(manager.cheapestModel(), null);
  assert.equal(await manager.credits(), null);
});

test('OpenRouter OAuth uses PKCE and stores only the exchanged API key', async () => {
  const rootDir = await tmpRoot();
  const exchanged = [];
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/auth/keys');
    const body = JSON.parse(init.body);
    exchanged.push(body);
    return { ok: true, json: async () => ({ key: 'sk-or-v1-oauth-result' }) };
  };
  const openRouter = fakeOpenRouter();
  const manager = await createPiManager({
    rootDir, fetchImpl, openRouter, secretStore: createMemorySecretStore(),
  }).init();
  const started = manager.beginOAuth('http://127.0.0.1:5175/oauth/openrouter/callback');
  const authUrl = new URL(started.authUrl);

  assert.equal(authUrl.origin, 'https://openrouter.ai');
  assert.equal(authUrl.pathname, '/auth');
  assert.equal(new URL(authUrl.searchParams.get('callback_url')).searchParams.get('state'), started.state);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authUrl.searchParams.get('code_challenge'));
  assert.equal(authUrl.searchParams.get('state'), started.state);

  const status = await manager.completeOAuth('one-time-code', started.state);
  assert.equal(status.keyConfigured, true);
  assert.equal(status.keyTail, 'sult');
  assert.equal(exchanged[0].code, 'one-time-code');
  assert.equal(exchanged[0].code_challenge_method, 'S256');
  assert.ok(exchanged[0].code_verifier);
  assert.deepEqual(openRouter.calls.validate, ['sk-or-v1-oauth-result']);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('OpenRouter OAuth rejects streamed key responses above 64 KiB', async () => {
  const rootDir = await tmpRoot();
  const secretStore = createMemorySecretStore();
  const manager = await createPiManager({
    rootDir,
    secretStore,
    openRouter: fakeOpenRouter(),
    fetchImpl: async () => new Response(Buffer.alloc(64 * 1024 + 1), { status: 200 }),
  }).init();
  const started = manager.beginOAuth('http://127.0.0.1:5175/oauth/openrouter/callback');
  await assert.rejects(
    manager.completeOAuth('code', started.state),
    (error) => error.code === 'OPENROUTER_OAUTH_RESPONSE_TOO_LARGE',
  );
  assert.equal(await secretStore.get('rhwp.pi.openrouter-api-key'), null);
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('OpenRouter OAuth cannot commit after cancel or owner-session close during exchange', async (t) => {
  for (const reason of ['user-cancelled', 'owner-session-closed']) {
    await t.test(reason, async () => {
      const rootDir = await tmpRoot();
      const secretStore = createMemorySecretStore();
      let markExchangeStarted = () => {};
      let releaseExchange = () => {};
      let requestSignal = null;
      const exchangeStarted = new Promise((resolve) => { markExchangeStarted = resolve; });
      const exchangeGate = new Promise((resolve) => { releaseExchange = resolve; });
      const manager = await createPiManager({
        rootDir,
        secretStore,
        openRouter: fakeOpenRouter(),
        fetchImpl: async (_url, init = {}) => {
          requestSignal = init.signal;
          markExchangeStarted();
          await exchangeGate;
          return { ok: true, json: async () => ({ key: 'sk-or-v1-too-late' }) };
        },
      }).init();
      const started = manager.beginOAuth('http://127.0.0.1:5175/oauth/openrouter/callback');
      const abort = new AbortController();
      let committed = false;

      const pending = manager.completeOAuth('late-code', started.state, {
        signal: abort.signal,
        onCommitted: () => { committed = true; },
      });
      await exchangeStarted;
      abort.abort(reason);
      await assert.rejects(pending, { code: 'AGENT_AUTH_CANCELLED' });
      assert.equal(requestSignal?.aborted, true);
      assert.equal(committed, false);

      // Even a transport that ignores abort and returns later remains fenced.
      releaseExchange();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await secretStore.get('rhwp.pi.openrouter-api-key'), null);
      assert.equal(manager.apiKey(), null);
      await fs.rm(rootDir, { recursive: true, force: true });
    });
  }
});

test('OpenRouter OAuth cannot commit after its exchange timeout', async () => {
  const rootDir = await tmpRoot();
  const secretStore = createMemorySecretStore();
  const openRouter = fakeOpenRouter();
  let markExchangeStarted = () => {};
  let releaseExchange = () => {};
  let requestSignal = null;
  const exchangeStarted = new Promise((resolve) => { markExchangeStarted = resolve; });
  const exchangeGate = new Promise((resolve) => { releaseExchange = resolve; });
  const manager = await createPiManager({
    rootDir,
    secretStore,
    openRouter,
    oauthExchangeTimeoutMs: 5,
    fetchImpl: async (_url, init = {}) => {
      requestSignal = init.signal;
      markExchangeStarted();
      await exchangeGate;
      return { ok: true, json: async () => ({ key: 'sk-or-v1-timeout-late' }) };
    },
  }).init();
  const started = manager.beginOAuth('http://127.0.0.1:5175/oauth/openrouter/callback');
  let committed = false;

  const pending = manager.completeOAuth('late-code', started.state, {
    onCommitted: () => { committed = true; },
  });
  await exchangeStarted;
  await assert.rejects(pending, { code: 'OPENROUTER_OAUTH_TIMEOUT' });
  assert.equal(requestSignal?.aborted, true);
  assert.equal(committed, false);

  // A transport that ignores the timeout abort cannot enter key validation or persistence.
  releaseExchange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(openRouter.calls.validate, []);
  assert.equal(await secretStore.get('rhwp.pi.openrouter-api-key'), null);
  assert.equal(manager.apiKey(), null);
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('install runs npm with a prefix, reports progress and syncs assets', async () => {
  const rootDir = await tmpRoot();
  const prefixDir = path.join(rootDir, 'prefix');
  const { spawns, spawnProcess } = fakeSpawner(installer(prefixDir));
  const manager = createPiManager({
    rootDir, spawnProcess, openRouter: fakeOpenRouter(), fetchImpl: offlineFetch,
  });

  const progress = [];
  const status = await manager.install((event) => progress.push(event));

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.execPath);
  // 레지스트리에 못 닿으면 npm 이 직접 받고, http 로그가 활동 신호가 된다.
  assert.match(spawns[0].argv[0], /npm[/\\]bin[/\\]npm-cli\.js$/);
  assert.deepEqual(spawns[0].argv.slice(1), [
    'install', '--prefix', prefixDir, '--no-fund', '--no-audit', '--loglevel=http', PI_PACKAGE,
  ]);
  assert.deepEqual(progress.map((event) => event.state), [
    'preparing', 'downloading', 'installing', 'installing', 'configuring', 'verifying', 'done',
  ]);
  assert.equal(progress[3].activity, true, 'npm 출력이 활동 신호로 흘러나온다');
  assert.deepEqual(progress.map((event) => event.percent), [8, 12, 64, 65.5, 92, 97, 100]);
  assert.equal(progress.at(-1).detail, '0.84.3');

  assert.equal(status.installed, true);
  assert.equal(status.version, '0.84.3');
  assert.equal(status.installing, false);
  assert.equal(status.setupComplete, false, '키와 모델이 아직 없다');
  assert.equal(
    manager.piBin,
    path.join(prefixDir, 'node_modules', '.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi'),
  );

  const settings = await readJson(path.join(rootDir, 'agent', 'settings.json'));
  assert.equal(settings.defaultProjectTrust, 'never');
  assert.equal(settings.enableSkillCommands, false);
  assert.equal(settings.enableInstallTelemetry, false);
  assert.equal(settings.extensions.length, 1);
  assert.equal(path.isAbsolute(settings.extensions[0]), true);
  assert.match(settings.extensions[0], /rhwp-agent[/\\]pi[/\\]extension[/\\]rhwp\.ts$/);
  assert.equal(settings.extensions[0], manager.extensionPath);

  await fs.stat(path.join(rootDir, 'sessions'));
  const config = await readJson(path.join(rootDir, 'config.json'));
  assert.equal(config.version, 1);
  assert.equal(config.installedVersion, '0.84.3');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('concurrent installs share a single npm run', async () => {
  const rootDir = await tmpRoot();
  const prefixDir = path.join(rootDir, 'prefix');
  const { spawns, spawnProcess } = fakeSpawner(installer(prefixDir));
  const manager = createPiManager({
    rootDir, spawnProcess, openRouter: fakeOpenRouter(), fetchImpl: offlineFetch,
  });

  const first = [];
  const second = [];
  const [a, b] = await Promise.all([
    manager.install((event) => first.push(event.state)),
    manager.install((event) => second.push(event.state)),
  ]);

  assert.equal(spawns.length, 1);
  assert.deepEqual(a, b);
  assert.equal(a.version, '0.84.3');
  assert.ok(second.includes('done'), '뒤늦게 붙은 호출도 진행 상황을 받는다');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Windows Pi cancellation waits for taskkill proof after leader exit', async () => {
  const rootDir = await tmpRoot();
  let npmProcess;
  let taskkill;
  const spawnProcess = (command) => {
    if (command === 'C:\\Windows\\System32\\taskkill.exe') {
      taskkill = new EventEmitter();
      return taskkill;
    }
    npmProcess = new FakeProcess();
    npmProcess.pid = 8080;
    npmProcess.exitCode = null;
    npmProcess.signalCode = null;
    return npmProcess;
  };
  const manager = createPiManager({
    rootDir,
    spawnProcess,
    platform: 'win32',
    openRouter: fakeOpenRouter(),
    fetchImpl: offlineFetch,
    baseEnv: { PATH: 'C:\\bin', SystemRoot: 'C:\\Windows' },
  });
  const installing = manager.install();
  const installFailure = assert.rejects(installing, { code: 'PI_INSTALL_FAILED' });
  while (!npmProcess) await new Promise((resolve) => setImmediate(resolve));

  const cancelling = manager.cancelSetup();
  let settled = false;
  void cancelling.finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(taskkill);
  assert.equal(settled, false);

  npmProcess.signalCode = 'SIGTERM';
  npmProcess.emit('exit', null, 'SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'leader exit is not enough on Windows');
  taskkill.emit('exit', 0, null);
  assert.equal(await cancelling, true);
  await installFailure;

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a failing npm install raises PI_INSTALL_FAILED with the stderr tail', async () => {
  const rootDir = await tmpRoot();
  const { spawnProcess } = fakeSpawner(async (proc) => {
    proc.stderr.emit('data', 'npm ERR! code E404\nnpm ERR! 404 Not Found\n');
    proc.emit('close', 1, null);
  });
  const manager = createPiManager({
    rootDir, spawnProcess, openRouter: fakeOpenRouter(), fetchImpl: offlineFetch,
  });

  await assert.rejects(() => manager.install(), (error) => {
    assert.equal(error.code, 'PI_INSTALL_FAILED');
    assert.match(error.message, /code 1/);
    assert.match(error.message, /404 Not Found/);
    return true;
  });

  const status = await manager.status();
  assert.equal(status.installed, false);
  assert.equal(status.installing, false);
  assert.match(status.error, /404 Not Found/);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('automatic Pi update failure is silent and leaves the working harness active', async () => {
  const rootDir = await tmpRoot();
  const prefixDir = path.join(rootDir, 'prefix');
  const packageDir = path.join(prefixDir, 'node_modules', ...PI_PACKAGE.split('/'));
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: PI_PACKAGE, version: '0.84.3' }),
  );
  const chunks = [Buffer.alloc(12, 4)];
  const { fetchImpl } = fakeRegistryFetch({
    chunks,
    integrity: sha512Integrity(chunks),
    contentLength: 12,
    version: '0.84.4',
  });
  const { spawnProcess } = fakeSpawner(async (proc) => {
    proc.stderr.emit('data', 'npm install failed\n');
    proc.emit('close', 1, null);
  });
  const manager = await createPiManager({
    rootDir, spawnProcess, openRouter: fakeOpenRouter(), fetchImpl,
  }).init();

  const status = await manager.automaticUpdate();
  assert.equal(status.version, '0.84.3');
  assert.equal(status.latestVersion, '0.84.4');
  assert.equal(status.updateRequired, true);
  assert.equal(status.error, null);
  assert.equal(JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')).version, '0.84.3');
  assert.deepEqual((await fs.readdir(rootDir)).filter((name) => name.includes('.update-')), []);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('deterministic install downloads the tarball itself and reports byte progress', async () => {
  const rootDir = await tmpRoot();
  const prefixDir = path.join(rootDir, 'prefix');
  const chunks = [Buffer.alloc(10, 1), Buffer.alloc(10, 2), Buffer.alloc(10, 3)];
  const { fetchImpl } = fakeRegistryFetch({
    chunks, integrity: sha512Integrity(chunks), contentLength: 30,
  });
  const { spawns, spawnProcess } = fakeSpawner(installer(prefixDir));
  const manager = createPiManager({
    rootDir, spawnProcess, openRouter: fakeOpenRouter(), fetchImpl, now: fastClock(),
  });

  const progress = [];
  const status = await manager.install((event) => progress.push(event));

  const tarballPath = path.join(rootDir, 'cache', 'pi-package.tgz');
  assert.equal(spawns.length, 1);
  // 로컬 타르볼 설치라 npm 은 조용해도 된다.
  assert.match(spawns[0].argv[0], /npm[/\\]bin[/\\]npm-cli\.js$/);
  assert.deepEqual(spawns[0].argv.slice(1), [
    'install', '--prefix', prefixDir, '--no-fund', '--no-audit', '--loglevel=error', tarballPath,
  ]);

  const bytes = progress.filter((event) => typeof event.receivedBytes === 'number');
  assert.deepEqual(bytes.map((event) => event.receivedBytes), [10, 20, 30, 30]);
  assert.ok(bytes.every((event) => event.totalBytes === 30));
  assert.equal(status.installed, true);
  await assert.rejects(() => fs.stat(tarballPath), '설치 후 캐시 타르볼은 지워진다');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a tarball without content-length reports unknown total until the end', async () => {
  const rootDir = await tmpRoot();
  const prefixDir = path.join(rootDir, 'prefix');
  const chunks = [Buffer.alloc(8, 7), Buffer.alloc(8, 8)];
  const { fetchImpl } = fakeRegistryFetch({ chunks, integrity: sha512Integrity(chunks) });
  const { spawnProcess } = fakeSpawner(installer(prefixDir));
  const manager = createPiManager({
    rootDir, spawnProcess, openRouter: fakeOpenRouter(), fetchImpl, now: fastClock(),
  });

  const progress = [];
  await manager.install((event) => progress.push(event));

  const bytes = progress.filter((event) => typeof event.receivedBytes === 'number');
  assert.deepEqual(bytes.map((event) => [event.receivedBytes, event.totalBytes]), [
    [8, null], [16, null], [16, 16],
  ]);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a rejected deterministic tarball cancels its unread body before npm fallback', async () => {
  const rootDir = await tmpRoot();
  const prefixDir = path.join(rootDir, 'prefix');
  let cancelled = false;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/latest')) {
      return {
        ok: true,
        json: async () => ({
          version: '0.84.3',
          dist: {
            tarball: 'https://registry.npmjs.org/pi/-/pi-0.84.3.tgz',
            integrity: sha512Integrity([Buffer.from('unused')]),
          },
        }),
      };
    }
    return new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status: 503 });
  };
  const { spawns, spawnProcess } = fakeSpawner(installer(prefixDir));
  const manager = createPiManager({
    rootDir, spawnProcess, openRouter: fakeOpenRouter(), fetchImpl,
  });

  await manager.install();
  assert.equal(cancelled, true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].argv.at(-1), PI_PACKAGE);
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('tarball downloads enforce declared and observed byte limits and remove partial files', async () => {
  for (const fixture of [
    { chunks: [], contentLength: 65 },
    { chunks: [Buffer.alloc(40), Buffer.alloc(40)], contentLength: null },
  ]) {
    const rootDir = await tmpRoot();
    const integrity = sha512Integrity(fixture.chunks);
    const { fetchImpl } = fakeRegistryFetch({ ...fixture, integrity });
    const { spawns, spawnProcess } = fakeSpawner();
    const manager = createPiManager({
      rootDir,
      spawnProcess,
      openRouter: fakeOpenRouter(),
      fetchImpl,
      tarballMaxBytes: 64,
    });

    await assert.rejects(
      manager.install(),
      (error) => error.code === 'PI_INSTALL_FAILED' && /256 MiB/.test(error.message),
    );
    assert.equal(spawns.length, 0);
    await assert.rejects(fs.stat(path.join(rootDir, 'cache', 'pi-package.tgz')));
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('an integrity mismatch fails the install instead of falling back to npm', async () => {
  const rootDir = await tmpRoot();
  const chunks = [Buffer.alloc(16, 5)];
  const { fetchImpl } = fakeRegistryFetch({
    chunks, integrity: sha512Integrity([Buffer.alloc(16, 6)]), contentLength: 16,
  });
  const { spawns, spawnProcess } = fakeSpawner();
  const manager = createPiManager({
    rootDir, spawnProcess, openRouter: fakeOpenRouter(), fetchImpl, now: fastClock(),
  });

  await assert.rejects(() => manager.install(), (error) => {
    assert.equal(error.code, 'PI_INSTALL_FAILED');
    assert.match(error.message, /무결성/);
    return true;
  });
  assert.equal(spawns.length, 0, 'npm 은 아예 돌지 않는다');
  await assert.rejects(() => fs.stat(path.join(rootDir, 'cache', 'pi-package.tgz')));

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('setApiKey validates first, stores the key only in the secure vault and keeps the tail', async () => {
  const rootDir = await tmpRoot();
  const { spawnProcess } = fakeSpawner();
  const openRouter = fakeOpenRouter();
  const secretStore = createMemorySecretStore();
  const manager = createPiManager({ rootDir, spawnProcess, openRouter, secretStore });

  const status = await manager.setApiKey('  sk-or-v1-secret-abcd  ');
  assert.deepEqual(openRouter.calls.validate, ['sk-or-v1-secret-abcd']);
  assert.equal(status.keyConfigured, true);
  assert.equal(status.keyTail, 'abcd');
  assert.equal(status.setupComplete, false, '모델을 아직 안 골랐다');
  assert.equal(manager.apiKey(), 'sk-or-v1-secret-abcd');

  const models = await readJson(path.join(rootDir, 'agent', 'models.json'));
  assert.equal(models.providers.openrouter.apiKey, undefined);
  assert.equal(await secretStore.get('rhwp.pi.openrouter-api-key'), 'sk-or-v1-secret-abcd');
  assert.equal(models.providers.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(models.providers.openrouter.api, 'openai-completions');
  const modelsStat = await fs.stat(path.join(rootDir, 'agent', 'models.json'));
  assert.equal(modelsStat.mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);

  const config = await readJson(path.join(rootDir, 'config.json'));
  assert.equal(config.keyTail, 'abcd');
  assert.equal(JSON.stringify(config).includes('sk-or-v1-secret'), false, '키는 config 에 남지 않는다');
  const configStat = await fs.stat(path.join(rootDir, 'config.json'));
  assert.equal(configStat.mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a clear queued behind a deferred vault write wins without racing the credential store', async () => {
  const rootDir = await tmpRoot();
  const vaultWriteStarted = deferred();
  const releaseVaultWrite = deferred();
  let shouldBlockWrite = true;
  let stored = null;
  let deleteCalls = 0;
  const secretStore = {
    available: true,
    async get() { return stored; },
    async set(_id, value) {
      if (shouldBlockWrite) {
        shouldBlockWrite = false;
        vaultWriteStarted.resolve();
        await releaseVaultWrite.promise;
      }
      stored = value;
    },
    async delete() {
      deleteCalls += 1;
      stored = null;
    },
  };
  const manager = createPiManager({ rootDir, openRouter: fakeOpenRouter(), secretStore });

  const setting = manager.setApiKey('sk-or-v1-serialized-key');
  await vaultWriteStarted.promise;
  const clearing = manager.clearApiKey();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deleteCalls, 0, 'clear must not touch the vault while setApiKey owns the transaction');

  releaseVaultWrite.resolve();
  await setting;
  const cleared = await clearing;
  assert.equal(deleteCalls, 1);
  assert.equal(stored, null);
  assert.equal(manager.apiKey(), null);
  assert.equal(cleared.keyConfigured, false);
  assert.equal((await readJson(path.join(rootDir, 'config.json'))).keyTail, null);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a model edit stays isolated while a deferred vault write owns the settings transaction', async () => {
  const rootDir = await tmpRoot();
  const vaultWriteStarted = deferred();
  const releaseVaultWrite = deferred();
  let shouldBlockWrite = true;
  let stored = null;
  const secretStore = {
    available: true,
    async get() { return stored; },
    async set(_id, value) {
      if (shouldBlockWrite) {
        shouldBlockWrite = false;
        vaultWriteStarted.resolve();
        await releaseVaultWrite.promise;
      }
      stored = value;
    },
    async delete() { stored = null; },
  };
  const openRouter = fakeOpenRouter();
  const manager = createPiManager({ rootDir, openRouter, secretStore });

  const setting = manager.setApiKey('sk-or-v1-model-queue');
  await vaultWriteStarted.promise;
  const selecting = manager.setModels([{ id: 'anthropic/claude-haiku-4.5' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(openRouter.calls.catalog, 1);
  assert.deepEqual(
    (await manager.status()).models,
    [],
    'setModels must not expose shared state before its queued transaction starts',
  );

  releaseVaultWrite.resolve();
  await setting;
  const selected = await selecting;
  assert.equal(selected.keyTail, 'ueue');
  assert.equal(selected.setupComplete, true);
  assert.deepEqual(selected.models.map(({ id }) => id), ['anthropic/claude-haiku-4.5']);
  assert.deepEqual(
    (await readJson(path.join(rootDir, 'config.json'))).models.map(({ id }) => id),
    ['anthropic/claude-haiku-4.5'],
  );

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a rejected key throws OPENROUTER_KEY_INVALID and writes nothing', async () => {
  const rootDir = await tmpRoot();
  const manager = createPiManager({
    rootDir,
    spawnProcess: fakeSpawner().spawnProcess,
    openRouter: fakeOpenRouter({ valid: false }),
  });

  await assert.rejects(() => manager.setApiKey('sk-bad'), (error) => {
    assert.equal(error.code, 'OPENROUTER_KEY_INVALID');
    return true;
  });
  await assert.rejects(() => fs.stat(path.join(rootDir, 'agent', 'models.json')));
  assert.equal((await manager.status()).keyConfigured, false);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('cancelling during delayed Pi key validation cannot commit the cancelled key', async () => {
  const rootDir = await tmpRoot();
  const secretStore = createMemorySecretStore();
  const openRouter = fakeOpenRouter();
  let markValidationStarted = () => {};
  let releaseValidation = () => {};
  const validationStarted = new Promise((resolve) => { markValidationStarted = resolve; });
  const validationGate = new Promise((resolve) => { releaseValidation = resolve; });
  openRouter.validateKey = async (key) => {
    openRouter.calls.validate.push(key);
    markValidationStarted();
    await validationGate;
    return { valid: true, label: 'rhwp', limit: 10, usage: 1, isFreeTier: false };
  };
  const manager = createPiManager({
    rootDir,
    spawnProcess: fakeSpawner().spawnProcess,
    openRouter,
    secretStore,
  });
  const abort = new AbortController();

  const pending = manager.setApiKey('sk-or-v1-cancelled-key', { signal: abort.signal });
  await validationStarted;
  abort.abort('user-cancelled');
  releaseValidation();

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'AGENT_AUTH_CANCELLED');
    return true;
  });
  assert.equal(manager.apiKey(), null);
  assert.equal(await secretStore.get('rhwp.pi.openrouter-api-key'), null);
  await assert.rejects(fs.stat(path.join(rootDir, 'agent', 'models.json')));
  await assert.rejects(fs.stat(path.join(rootDir, 'config.json')));

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Pi key persistence failures roll back the vault, memory, and written config', async () => {
  const rootDir = await tmpRoot();
  const configPath = path.join(rootDir, 'config.json');
  let stored = null;
  let failConfigCommit = true;
  const persistenceError = new Error('config persistence failed after replacement');
  const secretStore = {
    available: true,
    async get() { return stored; },
    async set(_id, value) {
      stored = value;
    },
    async delete() {
      stored = null;
    },
  };
  const manager = createPiManager({
    rootDir,
    openRouter: fakeOpenRouter(),
    secretStore,
    async replaceFile(tempPath, targetPath, options) {
      await replaceFileAtomically(tempPath, targetPath, options);
      if (targetPath === configPath && failConfigCommit) {
        failConfigCommit = false;
        throw persistenceError;
      }
    },
  });

  await assert.rejects(manager.setApiKey('sk-or-v1-partial-write'), persistenceError);
  assert.equal(stored, null);
  assert.equal(manager.apiKey(), null);
  assert.equal((await manager.status()).keyConfigured, false);
  assert.equal((await readJson(configPath)).keyTail, null);
  assert.equal((await readJson(path.join(rootDir, 'agent', 'models.json'))).providers.openrouter.apiKey, undefined);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('setApiKey restores the exact fresh vault snapshot after an earlier vault read failure', async () => {
  const rootDir = await tmpRoot();
  const configPath = path.join(rootDir, 'config.json');
  const initialReadError = new Error('vault was locked during initialization');
  const persistenceError = new Error('config persistence failed after vault replacement');
  let stored = 'sk-or-v1-existing-vault-value';
  let getCalls = 0;
  let failNextConfigCommit = true;
  const writes = [];
  const secretStore = {
    available: true,
    async get() {
      getCalls += 1;
      if (getCalls === 1) throw initialReadError;
      return stored;
    },
    async set(_id, value) {
      writes.push(value);
      stored = value;
    },
    async delete() { stored = null; },
  };
  const manager = await createPiManager({
    rootDir,
    openRouter: fakeOpenRouter(),
    secretStore,
    async replaceFile(tempPath, targetPath, options) {
      await replaceFileAtomically(tempPath, targetPath, options);
      if (targetPath === configPath && failNextConfigCommit) {
        failNextConfigCommit = false;
        throw persistenceError;
      }
    },
  }).init();
  assert.equal(manager.apiKey(), null, 'the failed initial read must not invent a vault value');

  await assert.rejects(manager.setApiKey('sk-or-v1-replacement'), persistenceError);
  assert.equal(getCalls, 2, 'the transaction obtains a fresh vault snapshot');
  assert.deepEqual(writes, [
    'sk-or-v1-replacement',
    'sk-or-v1-existing-vault-value',
  ]);
  assert.equal(stored, 'sk-or-v1-existing-vault-value');
  assert.equal(manager.apiKey(), null);
  assert.equal((await readJson(configPath)).keyTail, null);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('setApiKey aborts before vault mutation when its fresh snapshot cannot be read', async () => {
  const rootDir = await tmpRoot();
  const readError = new Error('vault remains locked');
  let setCalls = 0;
  let deleteCalls = 0;
  const manager = await createPiManager({
    rootDir,
    openRouter: fakeOpenRouter(),
    secretStore: {
      available: true,
      async get() { throw readError; },
      async set() { setCalls += 1; },
      async delete() { deleteCalls += 1; },
    },
  }).init();

  await assert.rejects(manager.setApiKey('sk-or-v1-must-not-write'), readError);
  assert.equal(setCalls, 0);
  assert.equal(deleteCalls, 0);
  assert.equal(manager.apiKey(), null);
  await assert.rejects(fs.stat(path.join(rootDir, 'config.json')));
  await assert.rejects(fs.stat(path.join(rootDir, 'agent', 'models.json')));

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Pi reports both the auth failure and a failed rollback', async () => {
  const rootDir = await tmpRoot();
  const original = new Error('vault write failed after mutation');
  const rollback = new Error('vault rollback failed');
  const manager = createPiManager({
    rootDir,
    openRouter: fakeOpenRouter(),
    secretStore: {
      available: true,
      async get() { return null; },
      async set() { throw original; },
      async delete() { throw rollback; },
    },
  });

  await assert.rejects(manager.setApiKey('sk-or-v1-rollback-failure'), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.code, 'AGENT_AUTH_ROLLBACK_FAILED');
    assert.equal(error.cause, original);
    assert.equal(error.errors[0], original);
    assert.equal(error.errors[1] instanceof AggregateError, true);
    return true;
  });
  assert.equal(manager.apiKey(), null);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a failed clear persistence restores the vault, memory and both settings files', async () => {
  const rootDir = await tmpRoot();
  const configPath = path.join(rootDir, 'config.json');
  const persistenceError = new Error('clear config persistence failed after replacement');
  let failNextConfigCommit = false;
  const secretStore = createMemorySecretStore();
  const manager = createPiManager({
    rootDir,
    openRouter: fakeOpenRouter(),
    secretStore,
    async replaceFile(tempPath, targetPath, options) {
      await replaceFileAtomically(tempPath, targetPath, options);
      if (targetPath === configPath && failNextConfigCommit) {
        failNextConfigCommit = false;
        throw persistenceError;
      }
    },
  });
  await manager.setApiKey('sk-or-v1-restore-clear', { account: 'andy@example.com' });
  await manager.setModels([{ id: 'deepseek/deepseek-chat-v3.1' }]);
  failNextConfigCommit = true;

  await assert.rejects(manager.clearApiKey(), persistenceError);
  const status = await manager.status();
  assert.equal(await secretStore.get(PI_SECRET_ID), 'sk-or-v1-restore-clear');
  assert.equal(manager.apiKey(), 'sk-or-v1-restore-clear');
  assert.equal(status.keyTail, 'lear');
  assert.equal(status.account, 'andy@example.com');
  assert.equal(status.setupComplete, true);
  assert.deepEqual(status.models.map(({ id }) => id), ['deepseek/deepseek-chat-v3.1']);
  const persisted = await readJson(configPath);
  assert.equal(persisted.keyTail, 'lear');
  assert.equal(persisted.account, 'andy@example.com');
  assert.equal(persisted.setupComplete, true);
  assert.deepEqual(
    (await readJson(path.join(rootDir, 'agent', 'models.json'))).providers.openrouter.models.map(({ id }) => id),
    ['deepseek/deepseek-chat-v3.1'],
  );

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('setModels writes the pi provider block and survives a reopen', async () => {
  const rootDir = await tmpRoot();
  const secretStore = createMemorySecretStore();
  const manager = createPiManager({
    rootDir,
    spawnProcess: fakeSpawner().spawnProcess,
    openRouter: fakeOpenRouter(),
    secretStore,
  });

  await manager.setApiKey('sk-or-v1-secret-abcd');
  const status = await manager.setModels([
    { id: 'deepseek/deepseek-chat-v3.1', name: '빠른 딥식', effortDefault: 'high' },
    { id: 'anthropic/claude-haiku-4.5' },
  ]);

  assert.equal(status.setupComplete, true);
  assert.equal(status.defaultModelId, 'deepseek/deepseek-chat-v3.1');
  assert.deepEqual(status.models[0], {
    id: 'deepseek/deepseek-chat-v3.1',
    name: '빠른 딥식',
    reasoning: true,
    supportsImages: false,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    contextLength: 163840,
    pricing: { prompt: 0.0000002, completion: 0.0000008 },
  });
  assert.deepEqual(status.models[1].efforts, [], '비추론 모델은 effort 를 노출하지 않는다');
  assert.equal(status.models[1].defaultEffort, null);
  assert.equal(status.models[1].name, 'Anthropic: Claude Haiku 4.5', '이름을 안 주면 카탈로그 이름을 쓴다');

  const written = await readJson(path.join(rootDir, 'agent', 'models.json'));
  const [deepseek, haiku] = written.providers.openrouter.models;
  assert.equal(deepseek.name, '빠른 딥식');
  assert.equal(deepseek.reasoning, true);
  assert.deepEqual(deepseek.input, ['text']);
  assert.equal(deepseek.contextWindow, 163840);
  assert.equal(deepseek.maxTokens, 8192);
  assert.deepEqual(deepseek.thinkingLevelMap, {
    off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null,
  });
  // 100만 토큰당 USD 로 환산해서 넣는다.
  assert.deepEqual(deepseek.cost, { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 });
  assert.equal(haiku.thinkingLevelMap, undefined, '비추론 모델에는 thinkingLevelMap 이 없다');
  assert.deepEqual(haiku.input, ['text', 'image']);
  assert.deepEqual(haiku.cost, { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 });

  // 싼 쪽은 출력 단가가 낮은 딥식이다.
  assert.equal(manager.cheapestModel().id, 'deepseek/deepseek-chat-v3.1');
  assert.equal(manager.defaultModel().name, '빠른 딥식');

  const reopened = await createPiManager({
    rootDir,
    spawnProcess: fakeSpawner().spawnProcess,
    openRouter: fakeOpenRouter(),
    secretStore,
  }).init();
  const reloaded = await reopened.status();
  assert.equal(reloaded.setupComplete, true);
  assert.equal(reloaded.keyTail, 'abcd');
  assert.equal(reloaded.models.length, 2);
  assert.equal(reloaded.models[0].name, '빠른 딥식');
  assert.equal(reopened.apiKey(), 'sk-or-v1-secret-abcd');

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a failed model persistence restores the previous in-memory and on-disk selection', async () => {
  const rootDir = await tmpRoot();
  const configPath = path.join(rootDir, 'config.json');
  const persistenceError = new Error('model config persistence failed after replacement');
  let failNextConfigCommit = false;
  const manager = createPiManager({
    rootDir,
    openRouter: fakeOpenRouter(),
    secretStore: createMemorySecretStore(),
    async replaceFile(tempPath, targetPath, options) {
      await replaceFileAtomically(tempPath, targetPath, options);
      if (targetPath === configPath && failNextConfigCommit) {
        failNextConfigCommit = false;
        throw persistenceError;
      }
    },
  });
  await manager.setApiKey('sk-or-v1-model-rollback');
  await manager.setModels([{ id: 'deepseek/deepseek-chat-v3.1' }]);
  failNextConfigCommit = true;

  await assert.rejects(
    manager.setModels([{ id: 'anthropic/claude-haiku-4.5' }]),
    persistenceError,
  );
  assert.deepEqual(
    (await manager.status()).models.map(({ id }) => id),
    ['deepseek/deepseek-chat-v3.1'],
  );
  assert.deepEqual(
    (await readJson(configPath)).models.map(({ id }) => id),
    ['deepseek/deepseek-chat-v3.1'],
  );
  assert.deepEqual(
    (await readJson(path.join(rootDir, 'agent', 'models.json'))).providers.openrouter.models.map(({ id }) => id),
    ['deepseek/deepseek-chat-v3.1'],
  );

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a legacy models.json key migrates to the secure vault and is scrubbed', async () => {
  const rootDir = await tmpRoot();
  const modelsPath = path.join(rootDir, 'agent', 'models.json');
  await fs.mkdir(path.dirname(modelsPath), { recursive: true });
  await fs.writeFile(modelsPath, JSON.stringify({
    providers: { openrouter: { apiKey: 'sk-or-v1-legacy', models: [] } },
  }));
  const secretStore = createMemorySecretStore();
  const manager = await createPiManager({
    rootDir, openRouter: fakeOpenRouter(), secretStore,
  }).init();

  assert.equal(manager.apiKey(), 'sk-or-v1-legacy');
  assert.equal(await secretStore.get('rhwp.pi.openrouter-api-key'), 'sk-or-v1-legacy');
  assert.equal((await readJson(modelsPath)).providers.openrouter.apiKey, undefined);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a model edit preserves the legacy key while an advertised vault is unavailable', async () => {
  const rootDir = await tmpRoot();
  const modelsPath = path.join(rootDir, 'agent', 'models.json');
  await fs.mkdir(path.dirname(modelsPath), { recursive: true });
  await fs.writeFile(modelsPath, JSON.stringify({
    providers: { openrouter: { apiKey: 'sk-or-v1-only-copy', models: [] } },
  }));
  const unavailableVault = {
    available: true,
    async get() { throw new Error('vault locked'); },
    async set() { throw new Error('vault locked'); },
    async delete() { throw new Error('vault locked'); },
  };
  const manager = await createPiManager({
    rootDir,
    openRouter: fakeOpenRouter(),
    secretStore: unavailableVault,
  }).init();

  assert.equal(manager.apiKey(), 'sk-or-v1-only-copy');
  await manager.setModels([{ id: 'deepseek/deepseek-chat-v3.1' }]);
  assert.equal(
    (await readJson(modelsPath)).providers.openrouter.apiKey,
    'sk-or-v1-only-copy',
  );

  const reopened = await createPiManager({
    rootDir,
    openRouter: fakeOpenRouter(),
  }).init();
  assert.equal(reopened.apiKey(), 'sk-or-v1-only-copy');
  assert.equal((await reopened.status()).setupComplete, true);
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('setModels rejects unknown ids, empty lists and more than three picks', async () => {
  const rootDir = await tmpRoot();
  const manager = createPiManager({
    rootDir,
    spawnProcess: fakeSpawner().spawnProcess,
    openRouter: fakeOpenRouter(),
  });

  await assert.rejects(() => manager.setModels([]), (error) => {
    assert.equal(error.code, 'PI_MODELS_EMPTY');
    return true;
  });
  await assert.rejects(
    () => manager.setModels([
      { id: 'deepseek/deepseek-chat-v3.1' },
      { id: 'anthropic/claude-haiku-4.5' },
      { id: 'openai/gpt-5-mini' },
      { id: 'deepseek/deepseek-chat-v3.1' },
    ]),
    (error) => {
      assert.equal(error.code, 'PI_TOO_MANY_MODELS');
      return true;
    },
  );
  await assert.rejects(() => manager.setModels([{ id: 'nope/not-a-model' }]), (error) => {
    assert.equal(error.code, 'PI_MODEL_UNKNOWN');
    assert.match(error.message, /nope\/not-a-model/);
    return true;
  });
  await assert.rejects(
    () => manager.setModels([{ id: `a${'b'.repeat(PI_MODEL_ID_MAX_CHARS)}` }]),
    { code: 'PI_MODEL_INVALID' },
  );
  await assert.rejects(
    () => manager.setModels([{
      id: 'deepseek/deepseek-chat-v3.1',
      name: 'n'.repeat(PI_MODEL_NAME_MAX_CHARS + 1),
    }]),
    { code: 'PI_MODEL_NAME_INVALID' },
  );
  await assert.rejects(
    () => manager.setModels([{ id: 'deepseek/deepseek-chat-v3.1', name: 'line\nbreak' }]),
    { code: 'PI_MODEL_NAME_INVALID' },
  );
  assert.deepEqual((await manager.status()).models, []);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Pi rejects oversized API keys before validation or persistence', async () => {
  const rootDir = await tmpRoot();
  const openRouter = fakeOpenRouter();
  const manager = createPiManager({ rootDir, openRouter });

  await assert.rejects(
    manager.setApiKey({ toString: () => { throw new Error('must not coerce'); } }),
    { code: 'OPENROUTER_KEY_INVALID' },
  );
  await assert.rejects(
    manager.setApiKey('k'.repeat(PI_API_KEY_MAX_CHARS + 1)),
    { code: 'OPENROUTER_KEY_TOO_LARGE' },
  );
  assert.deepEqual(openRouter.calls.validate, []);
  await assert.rejects(fs.stat(path.join(rootDir, 'config.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(rootDir, 'agent', 'models.json')), { code: 'ENOENT' });

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Pi ignores oversized persisted config and legacy model files', async () => {
  const rootDir = await tmpRoot();
  const configPath = path.join(rootDir, 'config.json');
  const modelsPath = path.join(rootDir, 'agent', 'models.json');
  await fs.mkdir(path.dirname(modelsPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    models: [{ id: 'deepseek/deepseek-chat-v3.1', name: 'unsafe persisted model' }],
    padding: 'c'.repeat(PI_SETTINGS_MAX_BYTES),
  }));
  await fs.writeFile(modelsPath, JSON.stringify({
    providers: { openrouter: { apiKey: 'sk-or-v1-should-not-load' } },
    padding: 'm'.repeat(PI_SETTINGS_MAX_BYTES),
  }));

  const manager = await createPiManager({ rootDir, openRouter: fakeOpenRouter() }).init();
  const status = await manager.status();
  assert.deepEqual(status.models, []);
  assert.equal(status.keyConfigured, false);
  assert.ok((await fs.stat(configPath)).size > PI_SETTINGS_MAX_BYTES);
  assert.ok((await fs.stat(modelsPath)).size > PI_SETTINGS_MAX_BYTES);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Pi never coerces non-string keys loaded from legacy files or the vault', async () => {
  const legacyRoot = await tmpRoot();
  const legacyModels = path.join(legacyRoot, 'agent', 'models.json');
  await fs.mkdir(path.dirname(legacyModels), { recursive: true });
  await fs.writeFile(legacyModels, JSON.stringify({
    providers: { openrouter: { apiKey: { nested: 'not-a-key' } } },
  }));
  const legacy = await createPiManager({
    rootDir: legacyRoot,
    openRouter: fakeOpenRouter(),
  }).init();
  assert.equal((await legacy.status()).keyConfigured, false);

  const vaultRoot = await tmpRoot();
  let writes = 0;
  const vault = await createPiManager({
    rootDir: vaultRoot,
    openRouter: fakeOpenRouter(),
    secretStore: {
      available: true,
      async get() { return { toString: () => { throw new Error('must not coerce'); } }; },
      async set() { writes += 1; },
      async delete() { writes += 1; },
    },
  }).init();
  assert.equal((await vault.status()).keyConfigured, false);
  assert.equal(writes, 0);

  await fs.rm(legacyRoot, { recursive: true, force: true });
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

test('Pi atomic settings writes remove staged files after replacement failure', async () => {
  const rootDir = await tmpRoot();
  const replacementError = new Error('replacement failed before consuming the temp file');
  let stagedPath = null;
  const manager = createPiManager({
    rootDir,
    openRouter: fakeOpenRouter(),
    async replaceFile(tempPath) {
      stagedPath = tempPath;
      throw replacementError;
    },
  });

  await assert.rejects(manager.syncAssets(), replacementError);
  assert.ok(stagedPath);
  await assert.rejects(fs.stat(stagedPath), { code: 'ENOENT' });

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('syncAssets rewrites settings.json without an install', async () => {
  const rootDir = await tmpRoot();
  const { spawns, spawnProcess } = fakeSpawner();
  const manager = createPiManager({ rootDir, spawnProcess, openRouter: fakeOpenRouter() });

  await manager.syncAssets();
  const settings = await readJson(path.join(rootDir, 'agent', 'settings.json'));
  assert.deepEqual(settings.extensions, [manager.extensionPath]);
  assert.equal(spawns.length, 0);

  // 두 번 불러도 그대로 덮어쓴다.
  await manager.syncAssets();
  assert.deepEqual(
    (await readJson(path.join(rootDir, 'agent', 'settings.json'))).extensions,
    [manager.extensionPath],
  );

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Rau profile shares the Pi prefix but keeps a separate secret and locked catalog', async () => {
  const prefixDir = await tmpRoot();
  const piRoot = await tmpRoot();
  const rauRoot = await tmpRoot();
  const secretStore = createMemorySecretStore();
  const pi = createPiManager({
    rootDir: piRoot,
    prefixDir,
    openRouter: fakeOpenRouter(),
    secretStore,
    secretId: PI_SECRET_ID,
  });
  const rau = createPiManager({
    rootDir: rauRoot,
    prefixDir,
    openRouter: fakeOpenRouter(),
    secretStore,
    secretId: RAU_SECRET_ID,
    lockedModels: RAU_LOCKED_MODELS,
    skipLegacyKey: true,
  });

  await pi.setApiKey('sk-or-v1-pi-key-aaaa');
  const rauStatus = await rau.setApiKey('sk-or-v1-rau-key-bbbb', { account: 'andy@example.com' });
  assert.equal(await secretStore.get(PI_SECRET_ID), 'sk-or-v1-pi-key-aaaa');
  assert.equal(await secretStore.get(RAU_SECRET_ID), 'sk-or-v1-rau-key-bbbb');
  assert.equal(pi.apiKey(), 'sk-or-v1-pi-key-aaaa');
  assert.equal(rau.apiKey(), 'sk-or-v1-rau-key-bbbb');
  assert.equal(rauStatus.setupComplete, true);
  assert.equal(rauStatus.defaultModelId, RAU_DEFAULT_MODEL_ID);
  assert.equal(rauStatus.models.length, 4);
  assert.equal((await pi.status()).setupComplete, false);
  await assert.rejects(() => rau.setModels([{ id: RAU_DEFAULT_MODEL_ID }]), (error) => {
    assert.equal(error.code, 'PI_MODELS_LOCKED');
    return true;
  });
  await rau.clearApiKey();
  assert.equal(await secretStore.get(RAU_SECRET_ID), null);
  assert.equal(await secretStore.get(PI_SECRET_ID), 'sk-or-v1-pi-key-aaaa');
  assert.equal((await rau.status()).setupComplete, false);
  assert.equal((await rau.status()).account, null);
  assert.equal(pi.apiKey(), 'sk-or-v1-pi-key-aaaa');

  await fs.rm(prefixDir, { recursive: true, force: true });
  await fs.rm(piRoot, { recursive: true, force: true });
  await fs.rm(rauRoot, { recursive: true, force: true });
});

test('clearing an API key fails closed when vault deletion fails', async () => {
  const rootDir = await tmpRoot();
  let stored = null;
  let deleteFails = true;
  const manager = createPiManager({
    rootDir,
    openRouter: fakeOpenRouter(),
    secretStore: {
      available: true,
      get: async () => stored,
      set: async (_id, value) => { stored = value; },
      delete: async () => {
        if (deleteFails) throw new Error('vault delete failed');
        stored = null;
      },
    },
  });
  await manager.setApiKey('sk-or-v1-delete-me');

  await assert.rejects(() => manager.clearApiKey(), (error) => {
    assert.equal(error.code, 'SECRET_DELETE_FAILED');
    assert.match(error.message, /vault delete failed/);
    return true;
  });
  assert.equal(manager.apiKey(), 'sk-or-v1-delete-me');
  assert.equal((await manager.status()).keyConfigured, true);

  deleteFails = false;
  const cleared = await manager.clearApiKey();
  assert.equal(cleared.error, null);

  await fs.rm(rootDir, { recursive: true, force: true });
});

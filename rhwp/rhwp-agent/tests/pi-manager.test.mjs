import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPiManager, defaultPiRoot } from '../pi-manager.mjs';

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

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('RHWP_PI_DIR overrides the per-platform app data root', () => {
  assert.equal(defaultPiRoot({ RHWP_PI_DIR: '/tmp/pi-here' }), '/tmp/pi-here');
  assert.equal(
    defaultPiRoot({}, 'darwin', '/Users/tester'),
    '/Users/tester/Library/Application Support/rhwp/pi',
  );
  assert.equal(
    defaultPiRoot({ APPDATA: 'C:\\data' }, 'win32', 'C:\\Users\\t'),
    path.join('C:\\data', 'rhwp', 'pi'),
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
  const manager = await createPiManager({ rootDir, fetchImpl, openRouter }).init();
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
  assert.equal(spawns[0].command, 'npm');
  // 레지스트리에 못 닿으면 npm 이 직접 받고, http 로그가 활동 신호가 된다.
  assert.deepEqual(spawns[0].argv, [
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
  assert.equal(manager.piBin, path.join(prefixDir, 'node_modules', '.bin', 'pi'));

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
  assert.deepEqual(spawns[0].argv, [
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

test('setApiKey validates first, stores the key only in models.json and keeps the tail', async () => {
  const rootDir = await tmpRoot();
  const { spawnProcess } = fakeSpawner();
  const openRouter = fakeOpenRouter();
  const manager = createPiManager({ rootDir, spawnProcess, openRouter });

  const status = await manager.setApiKey('  sk-or-v1-secret-abcd  ');
  assert.deepEqual(openRouter.calls.validate, ['sk-or-v1-secret-abcd']);
  assert.equal(status.keyConfigured, true);
  assert.equal(status.keyTail, 'abcd');
  assert.equal(status.setupComplete, false, '모델을 아직 안 골랐다');
  assert.equal(manager.apiKey(), 'sk-or-v1-secret-abcd');

  const models = await readJson(path.join(rootDir, 'agent', 'models.json'));
  assert.equal(models.providers.openrouter.apiKey, 'sk-or-v1-secret-abcd');
  assert.equal(models.providers.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(models.providers.openrouter.api, 'openai-completions');
  const modelsStat = await fs.stat(path.join(rootDir, 'agent', 'models.json'));
  assert.equal(modelsStat.mode & 0o777, 0o600);

  const config = await readJson(path.join(rootDir, 'config.json'));
  assert.equal(config.keyTail, 'abcd');
  assert.equal(JSON.stringify(config).includes('sk-or-v1-secret'), false, '키는 config 에 남지 않는다');
  const configStat = await fs.stat(path.join(rootDir, 'config.json'));
  assert.equal(configStat.mode & 0o777, 0o600);

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

test('setModels writes the pi provider block and survives a reopen', async () => {
  const rootDir = await tmpRoot();
  const manager = createPiManager({
    rootDir,
    spawnProcess: fakeSpawner().spawnProcess,
    openRouter: fakeOpenRouter(),
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
  }).init();
  const reloaded = await reopened.status();
  assert.equal(reloaded.setupComplete, true);
  assert.equal(reloaded.keyTail, 'abcd');
  assert.equal(reloaded.models.length, 2);
  assert.equal(reloaded.models[0].name, '빠른 딥식');
  assert.equal(reopened.apiKey(), 'sk-or-v1-secret-abcd');

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
  assert.deepEqual((await manager.status()).models, []);

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

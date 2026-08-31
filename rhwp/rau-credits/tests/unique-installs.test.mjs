import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_PORT,
  resolveCreditsDbPath,
  resolveUniqueInstallsDbPath,
} from '../config.mjs';
import { creditsRequestListener, createCreditsService } from '../service.mjs';
import { createFileStore, createMemoryStore } from '../store.mjs';
import {
  countOfficialUniqueInstalls,
  createUniqueInstallsService,
  emptyUniqueInstallsState,
  isOfficialDesktopPlatform,
  uniqueInstallDigest,
} from '../unique-installs.mjs';

const MAC_ID = '11111111-1111-4111-8111-111111111111';
const WIN_ID = '22222222-2222-4222-8222-222222222222';
const LINUX_ID = '33333333-3333-4333-8333-333333333333';
const UPDATE_ID = '44444444-4444-4444-8444-444444444444';

function credits() {
  return createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    workosClientId: 'client_test',
    store: createMemoryStore(),
  });
}

function uniqueInstalls(initial = emptyUniqueInstallsState()) {
  return createUniqueInstallsService({
    store: createMemoryStore(initial),
    now: () => Date.parse('2026-08-31T00:00:00.000Z'),
  });
}

async function listen(listener) {
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('official unique installs count only macOS arm64 and Windows x64', () => {
  assert.equal(isOfficialDesktopPlatform('darwin', 'arm64'), true);
  assert.equal(isOfficialDesktopPlatform('win32', 'x64'), true);
  assert.equal(isOfficialDesktopPlatform('linux', 'x64'), false);
  assert.equal(isOfficialDesktopPlatform('darwin', 'x64'), false);
  assert.equal(countOfficialUniqueInstalls({
    installs: {
      a: { official: true },
      b: { official: false },
      c: { official: true },
    },
  }), 2);
});

test('the first official ping counts once and a second launch does not increment', async () => {
  const installs = uniqueInstalls();
  const first = await installs.record({
    installId: MAC_ID,
    appVersion: '1.1.0',
    os: 'darwin',
    arch: 'arm64',
  });
  const second = await installs.record({
    installId: MAC_ID,
    appVersion: '1.1.1',
    os: 'darwin',
    arch: 'arm64',
  });
  assert.deepEqual(first, { uniqueInstalls: 1, created: true, official: true });
  assert.deepEqual(second, { uniqueInstalls: 1, created: false, official: true });
});

test('an auto-update restart with the same install id does not increment', async () => {
  const installs = uniqueInstalls();
  await installs.record({
    installId: UPDATE_ID,
    appVersion: '1.1.0',
    os: 'win32',
    arch: 'x64',
  });
  const afterUpdate = await installs.record({
    installId: UPDATE_ID,
    appVersion: '1.2.0',
    os: 'win32',
    arch: 'x64',
  });
  assert.equal(afterUpdate.created, false);
  assert.equal(afterUpdate.uniqueInstalls, 1);
});

test('Linux may ping but is excluded from the citable unique-install total', async () => {
  const installs = uniqueInstalls();
  const linux = await installs.record({
    installId: LINUX_ID,
    appVersion: '1.1.0',
    os: 'linux',
    arch: 'x64',
  });
  const windows = await installs.record({
    installId: WIN_ID,
    appVersion: '1.1.0',
    os: 'win32',
    arch: 'x64',
  });
  assert.equal(linux.official, false);
  assert.equal(linux.uniqueInstalls, 0);
  assert.equal(windows.uniqueInstalls, 1);
});

test('stored records hash the install id and never keep IP or hostname', async () => {
  const store = createMemoryStore(emptyUniqueInstallsState());
  const installs = createUniqueInstallsService({ store });
  await installs.record({
    installId: MAC_ID,
    appVersion: '1.1.0',
    os: 'darwin',
    arch: 'arm64',
  });
  const state = await store.load();
  const digest = uniqueInstallDigest(MAC_ID);
  assert.deepEqual(Object.keys(state.installs), [digest]);
  assert.equal(createHash('sha256').update(MAC_ID, 'utf8').digest('hex'), digest);
  assert.equal(JSON.stringify(state).includes(MAC_ID), false);
  assert.equal(JSON.stringify(state).includes('hostname'), false);
  assert.equal(JSON.stringify(state).includes('127.0.0.1'), false);
  assert.deepEqual(state.installs[digest], {
    official: true,
    firstSeenAt: state.installs[digest].firstSeenAt,
    appVersion: '1.1.0',
    os: 'darwin',
    arch: 'arm64',
  });
});

test('HTTP GET is the running total and POST is idempotent per machine', async () => {
  const installs = uniqueInstalls();
  const server = await listen(creditsRequestListener(credits(), { uniqueInstalls: installs }));
  try {
    const empty = await fetch(`${server.origin}/v1/unique-installs`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { uniqueInstalls: 0 });
    assert.equal(empty.headers.get('access-control-allow-origin'), '*');

    const first = await fetch(`${server.origin}/v1/unique-installs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installId: MAC_ID,
        appVersion: '1.1.0',
        os: 'darwin',
        arch: 'arm64',
      }),
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { uniqueInstalls: 1, created: true, official: true });

    const second = await fetch(`${server.origin}/v1/unique-installs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installId: MAC_ID,
        appVersion: '1.1.0',
        os: 'darwin',
        arch: 'arm64',
      }),
    });
    assert.equal((await second.json()).uniqueInstalls, 1);

    const page = await fetch(`${server.origin}/unique-installs`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /고유 데스크톱 설치/);
    assert.match(html, />1</);
    assert.match(html, /자동 업데이트와 GitHub 다운로드 수는 넣지 않습니다/);
  } finally {
    await server.close();
  }
});

test('unique-install routes stay available when v1 login is retired', async () => {
  const retired = createCreditsService({
    origin: 'https://credits.rau.test',
    sessionSecret: 'test-secret-for-rau-credits',
    workosClientId: 'client_test',
    store: createMemoryStore(),
    minDeviceProtocol: 2,
  });
  const server = await listen(creditsRequestListener(retired, { uniqueInstalls: uniqueInstalls() }));
  try {
    const login = await fetch(`${server.origin}/v1/device-sessions`, { method: 'POST' });
    assert.equal(login.status, 426);
    const counted = await fetch(`${server.origin}/v1/unique-installs`);
    assert.equal(counted.status, 200);
    assert.deepEqual(await counted.json(), { uniqueInstalls: 0 });
  } finally {
    await server.close();
  }
});

test('invalid pings fail closed without incrementing the total', async () => {
  const server = await listen(creditsRequestListener(credits(), { uniqueInstalls: uniqueInstalls() }));
  try {
    const missing = await fetch(`${server.origin}/v1/unique-installs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId: 'not-a-uuid', appVersion: '1.1.0', os: 'darwin', arch: 'arm64' }),
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'UNIQUE_INSTALL_ID_INVALID');
    const total = await fetch(`${server.origin}/v1/unique-installs`).then((res) => res.json());
    assert.equal(total.uniqueInstalls, 0);
  } finally {
    await server.close();
  }
});

test('unique-installs persist on a separate Railway volume file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unique-installs-'));
  try {
    const filePath = path.join(directory, 'unique-installs.json');
    const store = createFileStore(filePath, { emptyState: emptyUniqueInstallsState });
    const installs = createUniqueInstallsService({ store });
    await installs.record({
      installId: MAC_ID,
      appVersion: '1.1.0',
      os: 'darwin',
      arch: 'arm64',
    });
    const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(countOfficialUniqueInstalls(saved), 1);
    assert.equal(saved.users, undefined);
    assert.equal(resolveUniqueInstallsDbPath({}), path.join('.', 'unique-installs.json'));
    assert.equal(
      resolveUniqueInstallsDbPath({ RAILWAY_ENVIRONMENT: 'production' }),
      path.join('/data', 'unique-installs.json'),
    );
    assert.equal(resolveCreditsDbPath({}), path.join('.', 'rau-credits.json'));
    assert.equal(DEFAULT_PORT, 5180);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('install digests are stable UUIDs hashed with SHA-256', () => {
  assert.equal(
    uniqueInstallDigest(randomUUID().toLowerCase()).length,
    64,
  );
});

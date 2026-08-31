import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import {
  UNIQUE_INSTALL_FILE,
  reportUniqueInstall,
  shouldPingUniqueInstall,
  uniqueInstallsJsonUrl,
  uniqueInstallsPublicUrl,
} from '../../../desktop/unique-install.mjs';
import {
  formatUniqueInstallCount,
  loadUniqueInstallSnapshot,
  UNIQUE_INSTALLS_PUBLIC_URL,
} from '../src/unique-installs.ts';

const INSTALL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function withUserData<T>(run: (userDataDir: string) => Promise<T>): Promise<T> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'unique-install-'));
  try {
    return await run(userDataDir);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
}

function fetchLog() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : null,
    });
    if ((init.method ?? 'GET') === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ uniqueInstalls: calls.filter((call) => call.method === 'POST').length, created: true }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ uniqueInstalls: Math.max(0, calls.filter((call) => call.method === 'POST').length) }),
    };
  };
  return { calls, fetchImpl };
}

test('only packaged production launches ping, and they ping once per machine', async () => {
  assert.equal(shouldPingUniqueInstall({ packaged: true, devUrl: null }), true);
  assert.equal(shouldPingUniqueInstall({ packaged: false, devUrl: null }), false);
  assert.equal(shouldPingUniqueInstall({ packaged: true, devUrl: 'http://127.0.0.1:7700' }), false);

  await withUserData(async (userDataDir) => {
    const { calls, fetchImpl } = fetchLog();
    const first = await reportUniqueInstall({
      userDataDir,
      packaged: true,
      appVersion: '1.1.0',
      os: 'darwin',
      arch: 'arm64',
      baseUrl: 'https://credits.rau.test',
      fetchImpl,
      randomUUIDImpl: () => INSTALL_ID,
    });
    const second = await reportUniqueInstall({
      userDataDir,
      packaged: true,
      appVersion: '1.1.0',
      os: 'darwin',
      arch: 'arm64',
      baseUrl: 'https://credits.rau.test',
      fetchImpl,
    });
    const afterUpdate = await reportUniqueInstall({
      userDataDir,
      packaged: true,
      appVersion: '1.2.0',
      os: 'darwin',
      arch: 'arm64',
      baseUrl: 'https://credits.rau.test',
      fetchImpl,
    });

    assert.equal(first.recorded, true);
    assert.equal(second.recorded, true);
    assert.equal(afterUpdate.recorded, true);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    assert.deepEqual(calls.find((call) => call.method === 'POST')?.body, {
      installId: INSTALL_ID,
      appVersion: '1.1.0',
      os: 'darwin',
      arch: 'arm64',
    });
    const saved = JSON.parse(await readFile(path.join(userDataDir, UNIQUE_INSTALL_FILE), 'utf8'));
    assert.equal(saved.installId, INSTALL_ID);
    assert.equal(saved.recorded, true);
    assert.equal(JSON.stringify(saved).includes('hostname'), false);
  });
});

test('unpackaged and failed pings never increment locally, and a later retry can still record', async () => {
  await withUserData(async (userDataDir) => {
    const { calls, fetchImpl } = fetchLog();
    const unpackaged = await reportUniqueInstall({
      userDataDir,
      packaged: false,
      appVersion: '1.1.0',
      os: 'win32',
      arch: 'x64',
      baseUrl: 'https://credits.rau.test',
      fetchImpl,
      randomUUIDImpl: () => INSTALL_ID,
    });
    assert.equal(unpackaged.recorded, false);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);

    const failingFetch = async (url, init = {}) => {
      if ((init.method ?? 'GET') === 'POST') throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({ uniqueInstalls: 4 }) };
    };
    const failed = await reportUniqueInstall({
      userDataDir,
      packaged: true,
      appVersion: '1.1.0',
      os: 'win32',
      arch: 'x64',
      baseUrl: 'https://credits.rau.test',
      fetchImpl: failingFetch,
    });
    assert.equal(failed.uniqueInstalls, 4);
    assert.equal(failed.recorded, false);

    const recovered = await reportUniqueInstall({
      userDataDir,
      packaged: true,
      appVersion: '1.1.0',
      os: 'win32',
      arch: 'x64',
      baseUrl: 'https://credits.rau.test',
      fetchImpl,
    });
    assert.equal(recovered.recorded, true);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  });
});

test('the desktop ping talks only to rau-credits unique-installs, never GitHub download_count', async () => {
  await withUserData(async (userDataDir) => {
    const { calls, fetchImpl } = fetchLog();
    await reportUniqueInstall({
      userDataDir,
      packaged: true,
      appVersion: '1.1.0',
      os: 'darwin',
      arch: 'arm64',
      baseUrl: 'https://credits.rau.test',
      fetchImpl,
      randomUUIDImpl: () => INSTALL_ID,
    });
    assert.ok(calls.every((call) => call.url.startsWith('https://credits.rau.test/v1/unique-installs')));
    assert.equal(calls.some((call) => /github|download_count|latest-mac|blockmap/i.test(call.url)), false);
  });
});

test('public CEO readout URLs stay on the hosted rau-credits origin', () => {
  assert.equal(
    uniqueInstallsPublicUrl('https://rau-credits-production.up.railway.app'),
    UNIQUE_INSTALLS_PUBLIC_URL,
  );
  assert.equal(
    uniqueInstallsJsonUrl('https://credits.rau.test/'),
    'https://credits.rau.test/v1/unique-installs',
  );
  assert.equal(UNIQUE_INSTALLS_PUBLIC_URL, 'https://rau-credits-production.up.railway.app/unique-installs');
  assert.equal(formatUniqueInstallCount(1234), new Intl.NumberFormat('ko-KR').format(1234));
});

test('settings and about read the snapshot through desktop IPC without inventing a count', async () => {
  const missing = await loadUniqueInstallSnapshot({});
  assert.equal(missing.uniqueInstalls, null);
  const live = await loadUniqueInstallSnapshot({
    rhwpDesktop: {
      getUniqueInstalls: async () => ({ uniqueInstalls: 12, publicUrl: 'https://credits.rau.test/unique-installs' }),
    },
  });
  assert.equal(live.uniqueInstalls, 12);
  assert.equal(live.publicUrl, 'https://credits.rau.test/unique-installs');
});

test('the desktop shell pings only after a successful launch and never blocks startup', () => {
  const desktopMain = readFileSync(new URL('../../../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(desktopMain, /failedLaunches > 0 && sessions\.windows\(\)\.length === 0/);
  assert.match(
    desktopMain,
    /app\.quit\(\);\s*return;\s*\}\s*void syncUniqueInstallMetric\(\)/,
  );
  assert.match(desktopMain, /unique install ping failed/);
  assert.doesNotMatch(desktopMain, /download_count/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as realFs } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import {
  UNIQUE_INSTALL_FILE,
  createUniqueInstallProof,
  reportUniqueInstall,
  shouldPingUniqueInstall,
  uniqueInstallsJsonUrl,
  uniqueInstallsPublicUrl,
  writeUniqueInstallState,
} from '../../../desktop/unique-install.mjs';
import {
  formatUniqueInstallCount,
  loadUniqueInstallSnapshot,
  UNIQUE_INSTALLS_PUBLIC_URL,
} from '../src/unique-installs.ts';

const INSTALL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECORDED_STATE = {
  installId: INSTALL_ID,
  recorded: true,
  recordedAt: '2026-08-31T00:00:00.000Z',
};

function errorWithCode(code: string) {
  return Object.assign(new Error(code), { code });
}

function rmFileOnly(filePath: string, options?: { force?: boolean; recursive?: boolean }) {
  if (options?.recursive) throw new Error(`recursive rm is forbidden for ${filePath}`);
  return realFs.rm(filePath, options);
}

async function pendingUniqueInstallTemps(directory: string) {
  return (await realFs.readdir(directory)).filter((name) => name.startsWith(`${UNIQUE_INSTALL_FILE}.tmp-`));
}

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
      proof: createUniqueInstallProof({
        installId: INSTALL_ID,
        appVersion: '1.1.0',
        os: 'darwin',
        arch: 'arm64',
      }),
    });
    const saved = JSON.parse(await readFile(path.join(userDataDir, UNIQUE_INSTALL_FILE), 'utf8'));
    assert.equal(saved.installId, INSTALL_ID);
    assert.equal(saved.recorded, true);
    assert.equal(JSON.stringify(saved).includes('hostname'), false);
  });
});

test('Windows unique-install writes move the previous file aside instead of renaming over it', async () => {
  await withUserData(async (userDataDir) => {
    const filePath = path.join(userDataDir, UNIQUE_INSTALL_FILE);
    const ops = [];
    const existing = { isFile: () => true };
    await writeUniqueInstallState(filePath, {
      installId: INSTALL_ID,
      recorded: true,
      recordedAt: '2026-08-31T00:00:00.000Z',
    }, {
      platform: 'win32',
      mkdirImpl: async () => {},
      writeFileImpl: async () => {},
      statImpl: async () => existing,
      renameImpl: async (from, to) => {
        ops.push(['rename', path.basename(from), path.basename(to)]);
      },
      rmImpl: async (target) => {
        ops.push(['rm', path.basename(target)]);
      },
    });
    assert.equal(ops.some((op) => op[0] === 'rename' && op[2] === UNIQUE_INSTALL_FILE
      && op[1] !== UNIQUE_INSTALL_FILE), true);
    assert.equal(ops.some((op) => op[0] === 'rename' && op[1] === UNIQUE_INSTALL_FILE
      && op[2] === `${UNIQUE_INSTALL_FILE}.previous-write`), true);
    assert.equal(ops.some((op) => op[0] === 'rename' && op[1] === UNIQUE_INSTALL_FILE
      && op[2] === UNIQUE_INSTALL_FILE), false);
  });
});

test('Windows unique-install writes refuse a directory target', async () => {
  await withUserData(async (userDataDir) => {
    const filePath = path.join(userDataDir, UNIQUE_INSTALL_FILE);
    const previous = `${filePath}.previous-write`;
    await mkdir(filePath);
    await writeFile(path.join(filePath, 'inside.txt'), 'keep');

    await assert.rejects(
      writeUniqueInstallState(filePath, RECORDED_STATE, {
        platform: 'win32',
        rmImpl: rmFileOnly,
      }),
      { code: 'EISDIR' },
    );
    assert.equal(await readFile(path.join(filePath, 'inside.txt'), 'utf8'), 'keep');
    await assert.rejects(access(previous), { code: 'ENOENT' });
    assert.equal((await pendingUniqueInstallTemps(userDataDir)).length, 1);
  });
});

test('Windows unique-install writes restore a directory that appears between lstat and rename', async () => {
  await withUserData(async (userDataDir) => {
    const filePath = path.join(userDataDir, UNIQUE_INSTALL_FILE);
    const previous = `${filePath}.previous-write`;
    await mkdir(filePath);
    await writeFile(path.join(filePath, 'inside.txt'), 'keep');
    const lieFile = async (target) => {
      if (target === filePath) return { isDirectory: () => false, isFile: () => true };
      return realFs.lstat(target);
    };

    await assert.rejects(
      writeUniqueInstallState(filePath, RECORDED_STATE, {
        platform: 'win32',
        lstatImpl: lieFile,
        statImpl: lieFile,
        rmImpl: rmFileOnly,
      }),
      { code: 'EISDIR' },
    );
    assert.equal(await readFile(path.join(filePath, 'inside.txt'), 'utf8'), 'keep');
    await assert.rejects(access(previous), { code: 'ENOENT' });
    assert.equal((await pendingUniqueInstallTemps(userDataDir)).length, 1);
  });
});

test('Windows unique-install writes leave a raced directory stranded when restore fails', async () => {
  await withUserData(async (userDataDir) => {
    const filePath = path.join(userDataDir, UNIQUE_INSTALL_FILE);
    const previous = `${filePath}.previous-write`;
    await mkdir(filePath);
    await writeFile(path.join(filePath, 'inside.txt'), 'keep');
    const lieFile = async (target) => {
      if (target === filePath) return { isDirectory: () => false, isFile: () => true };
      return realFs.lstat(target);
    };

    await assert.rejects(
      writeUniqueInstallState(filePath, RECORDED_STATE, {
        platform: 'win32',
        lstatImpl: lieFile,
        statImpl: lieFile,
        renameImpl: async (from, to) => {
          if (from === previous && to === filePath) throw errorWithCode('EIO');
          return realFs.rename(from, to);
        },
        rmImpl: rmFileOnly,
      }),
      (error) => error.code === 'FILE_REPLACE_ROLLBACK_FAILED'
        && error.backupPath === previous
        && typeof error.tempPath === 'string'
        && path.basename(error.tempPath).startsWith(`${UNIQUE_INSTALL_FILE}.tmp-`),
    );
    assert.equal(await readFile(path.join(previous, 'inside.txt'), 'utf8'), 'keep');
    await assert.rejects(access(filePath), { code: 'ENOENT' });
    assert.equal((await pendingUniqueInstallTemps(userDataDir)).length, 1);
  });
});

test('Windows unique-install writes do not recursively delete a leftover directory backup', async () => {
  await withUserData(async (userDataDir) => {
    const filePath = path.join(userDataDir, UNIQUE_INSTALL_FILE);
    const previous = `${filePath}.previous-write`;
    await writeFile(filePath, `${JSON.stringify(RECORDED_STATE, null, 2)}\n`);
    await mkdir(previous);
    await writeFile(path.join(previous, 'inside.txt'), 'keep');

    await assert.rejects(
      writeUniqueInstallState(filePath, RECORDED_STATE, {
        platform: 'win32',
        rmImpl: rmFileOnly,
      }),
      { code: 'EISDIR' },
    );
    assert.equal(await readFile(filePath, 'utf8'), `${JSON.stringify(RECORDED_STATE, null, 2)}\n`);
    assert.equal(await readFile(path.join(previous, 'inside.txt'), 'utf8'), 'keep');
  });
});

test('a directory occupying unique-install.json fails closed without minting a ping', async () => {
  await withUserData(async (userDataDir) => {
    const { calls, fetchImpl } = fetchLog();
    await mkdir(path.join(userDataDir, UNIQUE_INSTALL_FILE));
    const blocked = await reportUniqueInstall({
      userDataDir,
      packaged: true,
      appVersion: '1.1.0',
      os: 'win32',
      arch: 'x64',
      baseUrl: 'https://credits.rau.test',
      fetchImpl,
      randomUUIDImpl: () => INSTALL_ID,
    });
    assert.equal(blocked.recorded, false);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
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
    assert.equal(calls.length, 0);
    await assert.rejects(
      readFile(path.join(userDataDir, UNIQUE_INSTALL_FILE), 'utf8'),
      { code: 'ENOENT' },
    );

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
  assert.equal(missing.unavailable, undefined);
  const emptyIpc = await loadUniqueInstallSnapshot({
    rhwpDesktop: {
      getUniqueInstalls: async () => ({ uniqueInstalls: null, publicUrl: 'https://credits.rau.test/unique-installs' }),
    },
  });
  assert.equal(emptyIpc.uniqueInstalls, null);
  assert.equal(emptyIpc.unavailable, undefined);
  assert.equal(emptyIpc.publicUrl, 'https://credits.rau.test/unique-installs');
  const live = await loadUniqueInstallSnapshot({
    rhwpDesktop: {
      getUniqueInstalls: async () => ({ uniqueInstalls: 12, publicUrl: 'https://credits.rau.test/unique-installs' }),
    },
  });
  assert.equal(live.uniqueInstalls, 12);
  assert.equal(live.publicUrl, 'https://credits.rau.test/unique-installs');
  const failed = await loadUniqueInstallSnapshot({
    rhwpDesktop: {
      getUniqueInstalls: async () => {
        throw new Error('ipc failed');
      },
    },
  });
  assert.equal(failed.unavailable, true);
  assert.equal(failed.uniqueInstalls, null);
});

test('the desktop shell pings only after a successful launch and never blocks startup', () => {
  const desktopMain = readFileSync(new URL('../../../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(desktopMain, /failedLaunches > 0 && sessions\.windows\(\)\.length === 0/);
  assert.match(
    desktopMain,
    /resolveUniqueInstallSync\(\);\s*app\.quit\(\);\s*return;\s*\}\s*void finishUniqueInstallMetric\(\)/,
  );
  assert.match(desktopMain, /await uniqueInstallSync/);
  assert.match(desktopMain, /unique install ping failed/);
  assert.doesNotMatch(desktopMain, /download_count/);
});

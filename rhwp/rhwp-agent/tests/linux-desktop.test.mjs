import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSecretVault } from '../../../desktop/secret-vault.mjs';
import { isNewerStableVersion, selectDebAsset } from '../../../desktop/update-policy.mjs';

const rootPackage = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
);
const desktopChecks = readFileSync(
  new URL('../../../.github/workflows/desktop-sessions.yml', import.meta.url),
  'utf8',
);
const releaseWorkflow = readFileSync(
  new URL('../../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const desktopMain = readFileSync(
  new URL('../../../desktop/main.mjs', import.meta.url),
  'utf8',
);

function fakeSafeStorage(backend) {
  return {
    async isAsyncEncryptionAvailable() { return true; },
    getSelectedStorageBackend() { return backend; },
    async encryptStringAsync(value) { return Buffer.from(`protected:${value}`); },
    async decryptStringAsync(value) {
      return { shouldReEncrypt: false, result: value.toString().replace(/^protected:/, '') };
    },
  };
}

test('Linux packages cover AppImage and deb on x64 and arm64', () => {
  const targets = rootPackage.build?.linux?.target ?? [];
  assert.deepEqual(
    targets.map(({ target, arch }) => ({ target, arch })),
    [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
      { target: 'deb', arch: ['x64', 'arm64'] },
    ],
  );
  assert.equal(rootPackage.build?.deb?.depends?.includes('libsecret-1-0'), true);
  assert.equal(rootPackage.license, 'MIT');
  assert.match(rootPackage.homepage ?? '', /^https:\/\//);
  assert.match(rootPackage.build?.linux?.maintainer ?? '', /<[^>]+@[^>]+>/);
  assert.equal(rootPackage.desktopName, 'rauhwpx.desktop');
  assert.match(rootPackage.scripts?.['dist:linux:x64'] ?? '', /--x64/);
  assert.match(rootPackage.scripts?.['dist:linux:arm64'] ?? '', /--arm64/);
  assert.match(rootPackage.scripts?.['dist:linux:x64'] ?? '', /build:native/);
  assert.match(rootPackage.scripts?.['dist:linux:arm64'] ?? '', /build:native/);
});

test('desktop packages and launches the native document reference extractor', () => {
  assert.match(rootPackage.scripts?.['build:native'] ?? '', /cargo build[\s\S]*--bin rhwp/);
  assert.equal(rootPackage.build?.files?.includes('desktop/**/*'), true);
  assert.equal(rootPackage.build?.asarUnpack?.includes('desktop/bin/**'), true);
  assert.match(desktopMain, /function nativeRhwpExecutable\(\)/);
  assert.match(desktopMain, /RHWP_BIN: rhwpExecutable/);
  assert.match(desktopMain, /Packaged native document extractor is missing/);
});

test('Linux packages register every supported document MIME type', () => {
  const associations = new Map(
    (rootPackage.build?.fileAssociations ?? []).map(({ ext, mimeType }) => [ext, mimeType]),
  );
  assert.equal(associations.get('hwp'), 'application/x-hwp');
  assert.equal(associations.get('hwpx'), 'application/vnd.hancom.hwpx');
  assert.equal(associations.get('hml'), 'application/x-hml');
});

test('Linux checks and releases run on native Ubuntu x64 and arm64 runners', () => {
  for (const workflow of [desktopChecks, releaseWorkflow]) {
    assert.match(workflow, /ubuntu-24\.04\b/);
    assert.match(workflow, /ubuntu-24\.04-arm\b/);
  }
  assert.match(releaseWorkflow, /release\/\*\.AppImage/);
  assert.match(releaseWorkflow, /release\/\*\.deb/);
  assert.match(releaseWorkflow, /latest-linux\*\.yml/);
});

test('Linux update policy stages AppImages and leaves deb installation to the user', () => {
  assert.match(desktopMain, /process\.platform === 'linux' && Boolean\(process\.env\.APPIMAGE\)/);
  assert.match(desktopMain, /autoUpdater\.autoDownload = process\.platform === 'darwin' \|\| linuxAppImage/);
  assert.match(desktopMain, /linuxDeb[\s\S]*?shell\.openExternal\(RELEASES_URL\)/);
  assert.match(desktopMain, /RELEASES_API_URL/);
  assert.match(desktopMain, /checkForDebUpdates/);
  assert.match(desktopMain, /isLinuxAppImage \? \['Restart to install', 'Later'\]/);
  assert.match(desktopMain, /\['darwin', 'linux'\]\.includes\(process\.platform\)/);
});

test('Deb update discovery compares stable versions and selects the native architecture', () => {
  assert.equal(isNewerStableVersion('v0.2.0', '0.1.11'), true);
  assert.equal(isNewerStableVersion('v0.1.11', '0.1.11'), false);
  assert.equal(isNewerStableVersion('v0.2.0-beta.1', '0.1.11'), false);
  const assets = [
    { name: 'Rauhwpx-0.2.0-amd64.deb', browser_download_url: 'https://github.com/example/amd64' },
    { name: 'Rauhwpx-0.2.0-arm64.deb', browser_download_url: 'https://github.com/example/arm64' },
  ];
  assert.equal(selectDebAsset(assets, 'x64')?.name, assets[0].name);
  assert.equal(selectDebAsset(assets, 'arm64')?.name, assets[1].name);
});

test('Linux secret vault rejects plaintext and unknown storage backends', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-linux-vault-reject-'));
  try {
    for (const backend of ['basic_text', 'unknown', undefined]) {
      const vault = createSecretVault({
        filePath: path.join(root, `${backend ?? 'missing'}.json`),
        safeStorage: fakeSafeStorage(backend),
        platform: 'linux',
      });
      await assert.rejects(
        () => vault.set('rhwp.test', 'secret'),
        /Secret Service or KWallet system keyring/,
      );
    }
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Linux secret vault accepts secure keyrings and locks down persisted ciphertext', async () => {
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-linux-vault-secure-'));
    const directory = path.join(root, 'private');
    const filePath = path.join(directory, 'secrets.json');
    try {
      const vault = createSecretVault({
        filePath,
        safeStorage: fakeSafeStorage(backend),
        platform: 'linux',
      });
      await vault.set('rhwp.test', `secret-${backend}`);
      assert.equal(await vault.get('rhwp.test'), `secret-${backend}`);
      assert.doesNotMatch(await fs.readFile(filePath, 'utf8'), new RegExp(`secret-${backend}$`));
      if (process.platform !== 'win32') {
        assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
        assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

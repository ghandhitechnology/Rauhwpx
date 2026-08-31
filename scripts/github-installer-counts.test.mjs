import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isOfficialInstallerAsset,
  secondaryInstallerDownloadCount,
} from './github-installer-counts.mjs';

const latestReleaseAssets = [
  { name: 'Rauhwpx-1.1.0-arm64.dmg', download_count: 10 },
  { name: 'Rauhwpx-1.1.0-arm64.zip', download_count: 8 },
  { name: 'Rauhwpx-1.1.0-arm64.zip.blockmap', download_count: 40 },
  { name: 'latest-mac.yml', download_count: 900 },
  { name: 'Rauhwpx-1.1.0-x64.exe', download_count: 6 },
  { name: 'Rauhwpx-1.1.0-x64.exe.blockmap', download_count: 25 },
  { name: 'latest.yml', download_count: 700 },
  { name: 'SHA256SUMS.txt', download_count: 15 },
];

test('yml, blockmap, checksums, and mac zip are not official installer assets', () => {
  assert.equal(isOfficialInstallerAsset('latest-mac.yml'), false);
  assert.equal(isOfficialInstallerAsset('latest.yml'), false);
  assert.equal(isOfficialInstallerAsset('Rauhwpx-1.1.0-arm64.zip.blockmap'), false);
  assert.equal(isOfficialInstallerAsset('Rauhwpx-1.1.0-x64.exe.blockmap'), false);
  assert.equal(isOfficialInstallerAsset('SHA256SUMS.txt'), false);
  assert.equal(isOfficialInstallerAsset('Rauhwpx-1.1.0-arm64.zip'), false);
  assert.equal(isOfficialInstallerAsset('Rauhwpx-1.1.0-arm64.dmg'), true);
  assert.equal(isOfficialInstallerAsset('Rauhwpx-1.1.0-x64.exe'), true);
});

test('the secondary GitHub check counts dmg+exe once and ignores updater noise', () => {
  assert.deepEqual(secondaryInstallerDownloadCount(latestReleaseAssets), {
    macDmg: 10,
    winExe: 6,
    total: 16,
  });
});

test('mac zip+dmg is not two installs on the secondary GitHub metric', () => {
  const counted = secondaryInstallerDownloadCount([
    { name: 'Rauhwpx-1.1.0-arm64.dmg', download_count: 3 },
    { name: 'Rauhwpx-1.1.0-arm64.zip', download_count: 3 },
  ]);
  assert.equal(counted.macDmg, 3);
  assert.equal(counted.total, 3);
});

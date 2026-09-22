import assert from 'node:assert/strict';
import test from 'node:test';

import { isNewerStableVersion, selectDebAsset } from '../desktop/update-policy.mjs';

test('Debian update comparison accepts only a newer stable semantic version', () => {
  assert.equal(isNewerStableVersion('v0.1.12', '0.1.11'), true);
  assert.equal(isNewerStableVersion('0.2.0', '0.1.99'), true);
  assert.equal(isNewerStableVersion('0.1.11', '0.1.11'), false);
  assert.equal(isNewerStableVersion('0.1.10', '0.1.11'), false);
  assert.equal(isNewerStableVersion('0.2.0-beta.1', '0.1.11'), false);
  assert.equal(isNewerStableVersion('not-a-version', '0.1.11'), false);
  assert.equal(isNewerStableVersion('0.1.11', '0.1.11-beta.1'), true);
});

test('Debian update selects the matching GitHub architecture asset only', () => {
  const assets = [
    { name: 'Rauhwpx-0.1.12-arm64.deb', browser_download_url: 'https://github.com/org/repo/arm64' },
    { name: 'Rauhwpx-0.1.12-amd64.deb', browser_download_url: 'https://github.com/org/repo/amd64' },
    { name: 'Rauhwpx-0.1.12-x86_64.AppImage', browser_download_url: 'https://github.com/org/repo/appimage' },
    { name: 'Rauhwpx-0.1.12-amd64.deb', browser_download_url: 'https://attacker.example/package' },
  ];
  assert.equal(selectDebAsset(assets, 'arm64')?.name, 'Rauhwpx-0.1.12-arm64.deb');
  assert.equal(selectDebAsset(assets, 'x64')?.name, 'Rauhwpx-0.1.12-amd64.deb');
  assert.equal(selectDebAsset(assets.slice(2), 'x64'), null);
});

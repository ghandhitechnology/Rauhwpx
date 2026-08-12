import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const IDENTITY = 'Developer ID Application: TAEWOOK HA (C8M34MMT8W)';
const TEAM_ID = 'C8M34MMT8W';

const rootPackage = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as {
  version?: string;
  build?: {
    mac?: {
      identity?: string;
      notarize?: { teamId?: string } | boolean;
    };
  };
};

const releaseWorkflow = readFileSync(
  new URL('../../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);

const desktopMain = readFileSync(
  new URL('../../../desktop/main.mjs', import.meta.url),
  'utf8',
);

test('macOS releases pin and notarize with the Xcode Developer ID identity', () => {
  assert.equal(rootPackage.build?.mac?.identity, IDENTITY);
  assert.equal(
    typeof rootPackage.build?.mac?.notarize === 'object'
      ? rootPackage.build.mac.notarize.teamId
      : undefined,
    TEAM_ID,
  );
  assert.match(releaseWorkflow, new RegExp(`CSC_NAME:\\s*"?${IDENTITY.replace(/[()]/g, '\\$&')}"?`));
  assert.match(releaseWorkflow, /APPLE_APP_SPECIFIC_PASSWORD/);
  assert.match(releaseWorkflow, /xcrun stapler validate/);
  assert.match(releaseWorkflow, /Authority=Apple Development/);
});

test('desktop window shows even if ready-to-show already fired during load', () => {
  const readyIdx = desktopMain.indexOf("once('ready-to-show'");
  const loadIdx = desktopMain.indexOf('loadURL(url)');
  const fallbackIdx = desktopMain.indexOf('!window.isVisible()) window.show()');
  assert.ok(readyIdx >= 0 && loadIdx >= 0 && readyIdx < loadIdx);
  assert.ok(fallbackIdx > loadIdx);
  assert.match(desktopMain, /await createWindow\(\);\s*startAgent\(\);/s);
});

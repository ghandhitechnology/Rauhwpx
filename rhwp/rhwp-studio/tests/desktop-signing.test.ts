import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CERTIFICATE_SELECTOR = 'TAEWOOK HA (C8M34MMT8W)';
const EXPECTED_AUTHORITY = `Developer ID Application: ${CERTIFICATE_SELECTOR}`;
const rootPackage = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as {
  version?: string;
  build?: {
    mac?: {
      identity?: string;
      notarize?: boolean;
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

test('macOS releases select and verify the Xcode Developer ID identity', () => {
  assert.equal(rootPackage.build?.mac?.identity, CERTIFICATE_SELECTOR);
  assert.equal(rootPackage.build?.mac?.notarize, true);
  assert.match(
    releaseWorkflow,
    new RegExp(`CSC_NAME:\\s*"?${CERTIFICATE_SELECTOR.replace(/[()]/g, '\\$&')}"?`),
  );
  assert.match(releaseWorkflow, new RegExp(EXPECTED_AUTHORITY.replace(/[()]/g, '\\$&')));
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
  assert.match(desktopMain, /await ensureAgent\(\);\s*await createWindow\(\);/s);
  assert.match(desktopMain, /preload: PRELOAD_PATH/);
  assert.match(desktopMain, /ipcMain.handle\('agent-hub:ensure'/);
});

test('desktop quit hides windows and waits for the hub before exiting', () => {
  const beforeQuit = desktopMain.slice(desktopMain.indexOf("app.on('before-quit'"));
  assert.match(beforeQuit, /event\.preventDefault\(\)/);
  assert.match(beforeQuit, /win\.hide\(\)/);
  assert.match(beforeQuit, /shutdownChildren\(\)/);
  assert.match(beforeQuit, /app\.quit\(\)/);
  assert.match(desktopMain, /await stopHubChild\(child\)/);
});

test('packaged app checks for updates on launch and prompts to restart when downloaded', () => {
  assert.match(desktopMain, /if \(app\.isPackaged\) setupAutoUpdater\(\)/);
  assert.match(desktopMain, /autoUpdater\.on\('update-downloaded'/);
  assert.match(desktopMain, /autoUpdater\.quitAndInstall\(\)/);
  assert.match(desktopMain, /setInterval\(check, UPDATE_CHECK_INTERVAL_MS\)/);
});

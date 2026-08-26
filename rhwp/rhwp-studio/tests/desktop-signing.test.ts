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

const menuBarCss = readFileSync(
  new URL('../src/styles/menu-bar.css', import.meta.url),
  'utf8',
);

const agentSidebarCss = readFileSync(
  new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url),
  'utf8',
);

const mergeResolverCss = readFileSync(
  new URL('../src/merge/merge-resolver.css', import.meta.url),
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
  const loadIdx = desktopMain.indexOf('loadURL(devUrl || STUDIO_URL)');
  const fallbackIdx = desktopMain.indexOf('!window.isVisible()) window.show()');
  assert.ok(readyIdx >= 0 && loadIdx >= 0 && readyIdx < loadIdx);
  assert.ok(fallbackIdx > loadIdx);
  assert.match(desktopMain, /await hubOwner\.ensure\(\);[\s\S]*await createWindow\(request\)/);
  assert.match(desktopMain, /preload: PRELOAD_PATH/);
  assert.match(desktopMain, /ipcMain\.handle\('agent-hub:ensure'/);
});

test('macOS title-bar drag regions never cover interactive controls', () => {
  assert.match(desktopMain, /trafficLightPosition:\s*\{ x: 14, y: 12 \}/);
  assert.match(menuBarCss, /--desktop-titlebar-height:\s*38px/);
  assert.match(menuBarCss, /--desktop-traffic-light-inset:\s*78px/);
  assert.match(
    menuBarCss,
    /html\.desktop-mac #menu-bar\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
  );
  assert.match(
    menuBarCss,
    /html\.desktop-mac #menu-bar::after\s*\{[^}]*-webkit-app-region:\s*drag/s,
  );
  assert.match(
    menuBarCss,
    /html\.desktop-mac body\.ag-fullscreen-open #menu-bar::after\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
  );
  assert.match(
    menuBarCss,
    /html\.desktop-mac #menu-bar \.menu-item\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
  );
  assert.match(
    agentSidebarCss,
    /html\.desktop-mac \.ag-fullscreen \.ag-workspace-bar\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
  );
  assert.match(
    agentSidebarCss,
    /html\.desktop-mac \.ag-fullscreen \.ag-workspace-leading\s*\{[^}]*padding-left:\s*calc\(10px \+ var\(--desktop-traffic-light-inset/s,
  );
  assert.match(
    agentSidebarCss,
    /html\.desktop-mac \.ag-fullscreen \.ag-workspace-bar button,[\s\S]*?-webkit-app-region:\s*no-drag/,
  );
  assert.match(
    mergeResolverCss,
    /html\.desktop-mac body\.merge-resolver-open #menu-bar::after\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
  );
  assert.match(
    mergeResolverCss,
    /html\.desktop-mac \.merge-resolver-header\s*\{[^}]*padding-left:\s*calc\(16px \+ var\(--desktop-traffic-light-inset/s,
  );
  assert.match(
    mergeResolverCss,
    /html\.desktop-mac \.merge-resolver-header-actions,[\s\S]*?-webkit-app-region:\s*no-drag/,
  );
});

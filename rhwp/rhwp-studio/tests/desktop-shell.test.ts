import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { documentPathsFromArgv, launchRequest } from '../../../desktop/launch-routing.mjs';
import { SessionManager } from '../../../desktop/session-manager.mjs';
import { resolveStudioAsset, STUDIO_URL } from '../../../desktop/studio-protocol.mjs';

const desktopMain = readFileSync(new URL('../../../desktop/main.mjs', import.meta.url), 'utf8');
const rootPackage = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

function fakeWindow(id: number) {
  return {
    webContents: { id },
    isDestroyed: () => false,
  };
}

test('SessionManager gives each owned BrowserWindow an isolated UUID context', async () => {
  const ids = ['session-a', 'session-b'];
  const manager = new SessionManager({
    launchId: 'launch-1',
    createId: () => ids.shift(),
    getHubContext: async () => ({ hubUrl: 'ws://127.0.0.1:34567', hubToken: 'secret' }),
    getSessionToken: (sessionId, masterToken) => `${sessionId}:${masterToken}`,
  });
  const first = fakeWindow(10);
  const second = fakeWindow(11);
  manager.addWindow(first, { openFiles: ['/tmp/a.hwpx'], source: 'initial' });
  manager.addWindow(second, { source: 'second-instance' });

  assert.deepEqual(await manager.contextForSender(first.webContents), {
    launchId: 'launch-1',
    sessionId: 'session-a',
    hubUrl: 'ws://127.0.0.1:34567',
    hubToken: 'session-a:secret',
  });
  assert.equal((await manager.contextForSender(second.webContents)).sessionId, 'session-b');
  assert.throws(() => manager.sessionForSender({ id: 10 }), /does not own/);
  assert.throws(() => manager.sessionForSender({ id: 99 }), /does not own/);
});

test('SessionManager removal remains safe after webContents destruction', () => {
  const manager = new SessionManager({
    launchId: 'launch-1',
    createId: () => 'session-a',
    getHubContext: async () => ({ hubUrl: 'ws://127.0.0.1:1', hubToken: 'secret' }),
    getSessionToken: (sessionId, masterToken) => `${sessionId}:${masterToken}`,
  });
  let destroyed = false;
  const sender = { id: 12, isDestroyed: () => destroyed };
  const window = {
    get webContents() {
      if (destroyed) throw new Error('webContents destroyed');
      return sender;
    },
    isDestroyed: () => destroyed,
  };
  manager.addWindow(window);
  destroyed = true;

  assert.equal(manager.removeWindow(window), true);
  assert.equal(manager.size, 0);
  assert.equal(manager.removeWindow(window), false);
});

test('launch routing accepts only supported document paths', () => {
  assert.deepEqual(documentPathsFromArgv([
    '/Applications/Rauhwpx',
    '--flag',
    'draft.HWPX',
    'notes.txt',
    'legacy.hml',
  ], { cwd: '/work' }), ['/work/draft.HWPX', '/work/legacy.hml']);
  assert.deepEqual(launchRequest({ openFiles: ['/tmp/a.hwp'], source: 'open-file' }), {
    source: 'open-file',
    openFiles: ['/tmp/a.hwp'],
  });
  assert.match(desktopMain, /app\.on\('open-file'/);
  assert.match(desktopMain, /source: 'second-instance'/);
  assert.match(desktopMain, /label: 'New Window'/);
  assert.match(desktopMain, /CmdOrCtrl\+Shift\+N/);
  assert.match(desktopMain, /x: bounds\.x \+ 28, y: bounds\.y \+ 28/);
});

test('packaged Studio uses a secure path-safe standard scheme', () => {
  assert.equal(STUDIO_URL, 'rauhwpx://app/index.html');
  assert.equal(resolveStudioAsset('/app/dist', '/assets/app.js'), '/app/dist/assets/app.js');
  assert.equal(resolveStudioAsset('/app/dist', '/../secrets.txt'), null);
  assert.equal(resolveStudioAsset('/app/dist', '/%E0%A4%A'), null);
  assert.match(desktopMain, /if \(!devUrl\) installStudioProtocol/);
  assert.match(desktopMain, /window\.loadURL\(devUrl \|\| STUDIO_URL\)/);
  assert.match(desktopMain, /\['will-navigate', 'will-redirect'\]/);
  assert.match(desktopMain, /function sessionForEvent\(event\)[\s\S]*Untrusted renderer IPC sender/);
  assert.doesNotMatch(desktopMain, /createServer/);
});

test('desktop close and native-file IPC contracts stay sender-owned', () => {
  const preload = readFileSync(new URL('../../../desktop/preload.cjs', import.meta.url), 'utf8');
  assert.match(desktopMain, /closeHubSession\(\{[\s\S]*?port: hub\.port,[\s\S]*?token: hubToken,[\s\S]*?launchId,[\s\S]*?sessionId: session\.sessionId/);
  for (const channel of [
    'desktop:pick-native-open-file',
    'desktop:claim-native-dropped-file',
    'desktop:pick-native-save-file',
    'desktop:release-native-file',
    'desktop:native-file-read',
    'desktop:native-file-validate-save',
    'desktop:native-file-write',
    'desktop:native-file-is-same',
    'desktop:document-reserve',
    'desktop:document-commit',
    'desktop:document-cancel',
    'desktop:document-release',
    'desktop:close-response',
  ]) {
    assert.match(desktopMain, new RegExp(`ipcMain\\.handle\\('${channel}'`));
    assert.match(preload, new RegExp(channel));
  }
  assert.match(desktopMain, /window\.on\('close',[\s\S]*desktop:close-requested/);
  assert.match(desktopMain, /nativeFiles\.createSaveTarget\(session\.sessionId, filePath\)/);
  assert.doesNotMatch(preload, /\b(?:file)?path\s*:/i);
});

test('desktop package registers supported document associations without bundling runtime data', () => {
  assert.deepEqual(rootPackage.build.fileAssociations[0].ext, ['hwp', 'hwpx', 'hml']);
  assert.ok(rootPackage.build.asarUnpack.includes('rhwp/rhwp-agent/**'));
  assert.ok(rootPackage.build.files.every((entry: string) => !/runtime|launch-work/.test(entry)));
});

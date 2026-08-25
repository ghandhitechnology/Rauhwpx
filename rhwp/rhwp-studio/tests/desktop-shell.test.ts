import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { documentPathsFromArgv, launchRequest } from '../../../desktop/launch-routing.mjs';
import { resolveGeneratedDocumentArtifact } from '../../../desktop/generated-document-artifact.mjs';
import { deliverPlainTextPaste } from '../../../desktop/plain-text-paste.mjs';
import { SessionManager } from '../../../desktop/session-manager.mjs';
import { SerializedStateWriter } from '../../../desktop/serialized-state-writer.mjs';
import { resolveStudioAsset, STUDIO_URL } from '../../../desktop/studio-protocol.mjs';

const desktopMain = readFileSync(new URL('../../../desktop/main.mjs', import.meta.url), 'utf8');
const rootPackage = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

function fakeWindow(id: number) {
  return {
    webContents: { id },
    isDestroyed: () => false,
  };
}

function associationExts(association: { ext?: string | string[] }): string[] {
  if (!association.ext) return [];
  return Array.isArray(association.ext) ? association.ext : [association.ext];
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
  const workDir = path.resolve('/work');
  assert.deepEqual(documentPathsFromArgv([
    '/Applications/Rauhwpx',
    '--flag',
    'draft.HWPX',
    'shared.rhwpx',
    'notes.txt',
    'legacy.hml',
  ], { cwd: workDir }), [
    path.join(workDir, 'draft.HWPX'),
    path.join(workDir, 'shared.rhwpx'),
    path.join(workDir, 'legacy.hml'),
  ]);
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

test('desktop owns Cmd/Ctrl+Shift+V in its native Edit menu', () => {
  const sent: unknown[][] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (...args: unknown[]) => sent.push(args),
    },
  };
  assert.equal(deliverPlainTextPaste(window, () => 'plain text'), true);
  assert.deepEqual(sent, [['desktop:paste-plain-text', 'plain text']]);
  assert.equal(deliverPlainTextPaste(window, () => ''), false);
  assert.equal(deliverPlainTextPaste(null, () => 'ignored'), false);

  assert.match(desktopMain, /id: 'edit-paste-without-formatting'/);
  assert.match(desktopMain, /accelerator: 'CmdOrCtrl\+Shift\+V'/);
  assert.match(desktopMain, /deliverPlainTextPaste\(/);
  assert.match(desktopMain, /clipboard\.readText\(\)/);
});

test('desktop packages register as an HWPX editor with the operating system', () => {
  const associations = rootPackage.build.fileAssociations;
  assert.ok(associations.some((association: { ext: string | string[] }) =>
    associationExts(association).includes('hwpx')));
  const hangulAssociation = associations.find((association: { name?: string }) =>
    association.name === 'Hangul document');
  assert.equal(associationExts(hangulAssociation ?? {}).includes('rhwpx'), false);

  const macInfo = rootPackage.build.mac.extendInfo;
  const hwpxType = macInfo.CFBundleDocumentTypes.find((type: {
    LSItemContentTypes?: string[];
  }) => type.LSItemContentTypes?.includes('com.hataewook.rauhwpx.hwpx-document'));
  assert.equal(hwpxType?.CFBundleTypeRole, 'Editor');
  assert.equal(hwpxType?.LSHandlerRank, 'Default');

  const exportedHwpxType = macInfo.UTExportedTypeDeclarations.find((type: {
    UTTypeIdentifier?: string;
  }) => type.UTTypeIdentifier === 'com.hataewook.rauhwpx.hwpx-document');
  assert.deepEqual(exportedHwpxType?.UTTypeTagSpecification['public.filename-extension'], ['hwpx']);
  const exportedHistoryType = macInfo.UTExportedTypeDeclarations.find((type: {
    UTTypeIdentifier?: string;
  }) => type.UTTypeIdentifier === 'com.hataewook.rauhwpx.history-bundle');
  assert.deepEqual(exportedHistoryType?.UTTypeTagSpecification['public.filename-extension'], ['rhwpx']);
  assert.ok(exportedHistoryType?.UTTypeConformsTo?.includes('com.apple.package'));
  const historyDocumentType = macInfo.CFBundleDocumentTypes.find((type: {
    LSItemContentTypes?: string[];
  }) => type.LSItemContentTypes?.includes('com.hataewook.rauhwpx.history-bundle'));
  assert.equal(historyDocumentType?.LSTypeIsPackage, true);

  // electron-builder only installs NSIS file associations for per-machine installs.
  assert.equal(rootPackage.build.nsis.perMachine, true);
});

test('packaged Studio uses a secure path-safe standard scheme', () => {
  assert.equal(STUDIO_URL, 'rauhwpx://app/index.html');
  assert.equal(
    resolveStudioAsset('/app/dist', '/assets/app.js'),
    path.resolve('/app/dist/assets/app.js'),
  );
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
    'desktop:open-generated-document-window',
    'desktop:get-launch-generated-document',
    'desktop:claim-native-dropped-file',
    'desktop:pick-native-save-file',
    'desktop:release-native-file',
    'desktop:native-file-read',
    'desktop:native-file-source-path',
    'desktop:native-file-validate-save',
    'desktop:native-file-write',
    'desktop:native-file-is-same',
    'desktop:remember-native-document',
    'desktop:reopen-native-document',
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

test('bookmark persistence serializes writes and close queues a latest-state flush', async () => {
  const started: string[] = [];
  const errors: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const writer = new SerializedStateWriter({
    write: async (snapshot: string) => {
      started.push(snapshot);
      if (snapshot === 'first') {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      if (snapshot === 'failed') throw new Error('disk unavailable');
    },
    onError: (error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });

  const first = writer.enqueue('first');
  const second = writer.enqueue('second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first']);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(started, ['first', 'second']);
  await writer.enqueue('failed');
  await writer.enqueue('latest');
  assert.deepEqual(errors, ['disk unavailable']);
  assert.deepEqual(started, ['first', 'second', 'failed', 'latest']);

  assert.match(
    desktopMain,
    /desktop:remember-native-document'[\s\S]*?await persistNativeBookmarks\(\)/,
  );
  assert.match(
    desktopMain,
    /desktop:close-response'[\s\S]*?if \(!allowClose\)[\s\S]*?await persistNativeBookmarks\(\)[\s\S]*?session\.window\.close\(\)/,
  );
});

test('generated artifact opening is bound to the sender hub and session', () => {
  const request = {
    fileName: '보고서(팀).hwpx',
    downloadUrl: 'http://127.0.0.1:34567/artifacts/artifact_token_1234567890/'
      + '%EB%B3%B4%EA%B3%A0%EC%84%9C%28%ED%8C%80%29.hwpx?sessionId=session-a&token=rhwp1.token',
  };
  assert.deepEqual(resolveGeneratedDocumentArtifact(request, {
    hubUrl: 'ws://127.0.0.1:34567',
    sessionId: 'session-a',
  }), { ...request, readOnly: false });
  assert.deepEqual(resolveGeneratedDocumentArtifact({ ...request, readOnly: true }, {
    hubUrl: 'ws://127.0.0.1:34567',
    sessionId: 'session-a',
  }), { ...request, readOnly: true });
  assert.throws(() => resolveGeneratedDocumentArtifact(request, {
    hubUrl: 'ws://127.0.0.1:34567',
    sessionId: 'session-b',
  }), /window session/);
  assert.throws(() => resolveGeneratedDocumentArtifact({
    ...request,
    downloadUrl: request.downloadUrl.replace('127.0.0.1:34567', 'example.com'),
  }, {
    hubUrl: 'ws://127.0.0.1:34567',
    sessionId: 'session-a',
  }), /does not belong to this app/);
});

test('window close never deadlocks on a dead renderer', () => {
  // The close prompt is skipped (not blocked on) when the renderer cannot answer.
  assert.match(
    desktopMain,
    /window\.on\('close',[\s\S]*?isDestroyed\(\) \|\| window\.webContents\.isCrashed\(\)\) return;[\s\S]*?event\.preventDefault\(\)/,
  );
  assert.match(desktopMain, /render-process-gone[\s\S]*?pendingCloseRequestId = null/);
});

test('one failed startup launch does not abort the remaining launches', () => {
  assert.match(desktopMain, /await openLaunch\(request\)\.catch\(/);
  assert.match(desktopMain, /failedLaunches > 0 && sessions\.windows\(\)\.length === 0/);
});

test('desktop package registers supported document associations without bundling runtime data', () => {
  const hangulAssociation = rootPackage.build.fileAssociations.find(
    (association: { name?: string }) => association.name === 'Hangul document',
  );
  const historyAssociation = rootPackage.build.fileAssociations.find(
    (association: { ext?: string | string[] }) => associationExts(association).includes('rhwpx'),
  );
  assert.deepEqual(hangulAssociation?.ext, ['hwp', 'hwpx', 'hml']);
  assert.deepEqual(historyAssociation?.ext, ['rhwpx']);
  assert.equal(historyAssociation?.name, 'Rauhwpx history bundle');
  assert.notEqual(historyAssociation?.name, 'Hangul document');
  assert.equal(historyAssociation?.isPackage, true);
  assert.match(desktopMain, /desktop:save-portable-history-file/);
  assert.match(desktopMain, /writePortableHistoryFolder\(/);
  assert.match(desktopMain, /RauHWPX history bundle/);
  assert.ok(rootPackage.build.asarUnpack.includes('rhwp/rhwp-agent/**'));
  assert.ok(rootPackage.build.files.every((entry: string) => !/runtime|launch-work/.test(entry)));
});

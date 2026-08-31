import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { documentPathsFromArgv, launchRequest } from '../../../desktop/launch-routing.mjs';
import {
  readGeneratedDocumentResponse,
  resolveGeneratedDocumentArtifact,
} from '../../../desktop/generated-document-artifact.mjs';
import { deliverPlainTextPaste } from '../../../desktop/plain-text-paste.mjs';
import { SessionManager } from '../../../desktop/session-manager.mjs';
import { safeSuggestedFilename } from '../../../desktop/safe-filename.mjs';
import { SerializedStateWriter } from '../../../desktop/serialized-state-writer.mjs';
import {
  CREDENTIAL_RETENTION_DIR,
  LEGACY_CLEANUP_MARKER_FILE,
  LAUNCH_OWNER_FILE,
  MAX_LAUNCH_DIRECTORY_ENTRIES,
  launchStoragePaths,
  prepareDevelopmentCaches,
  removeLegacyLaunchDirectories,
  removeStaleLaunchDirectories,
  writeLaunchOwnerMetadata,
} from '../../../desktop/runtime-cleanup.mjs';
import { resolveStudioAsset, STUDIO_URL } from '../../../desktop/studio-protocol.mjs';
import { LAUNCH_CLEANUP_RETENTION_FILE } from '../../rhwp-agent/credential-mirror.mjs';

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

test('dialog suggestions are portable across Windows and strip renderer paths', () => {
  assert.equal(safeSuggestedFilename('C:\\temp\\CON.txt', 'document.txt'), '_CON.txt');
  assert.equal(safeSuggestedFilename('../report?.hwpx', 'document.hwpx'), 'report_.hwpx');
  assert.equal(safeSuggestedFilename('AUX. ', 'document.hwp'), '_AUX');
  assert.equal(safeSuggestedFilename('', 'document.rhwpx'), 'document.rhwpx');
});

test('SessionManager gives each owned BrowserWindow an isolated UUID context', async () => {
  const ids = ['session-a', 'session-b', 'session-c'];
  const manager = new SessionManager({
    launchId: 'launch-1',
    createId: () => ids.shift(),
    getHubContext: async () => ({ hubUrl: 'ws://127.0.0.1:34567', hubToken: 'secret' }),
    getSessionCapabilities: (sessionId) => ({
      studio: `${sessionId}:studio`,
      reference: `${sessionId}:reference`,
      template: `${sessionId}:template`,
    }),
  });
  const first = fakeWindow(10);
  const second = fakeWindow(11);
  const firstSession = manager.addWindow(first);
  manager.addWindow(second);

  assert.equal(manager.sessionById('session-a'), firstSession);
  assert.deepEqual(await manager.contextForSender(first.webContents), {
    launchId: 'launch-1',
    sessionId: 'session-a',
    hubUrl: 'ws://127.0.0.1:34567',
    hubToken: 'session-a:studio',
    referenceToken: 'session-a:reference',
    templateToken: 'session-a:template',
  });
  assert.equal((await manager.contextForSender(second.webContents)).sessionId, 'session-b');
  assert.throws(() => manager.sessionForSender({ id: 10 }), /does not own/);
  assert.throws(() => manager.sessionForSender({ id: 99 }), /does not own/);
  assert.throws(() => manager.addWindow(fakeWindow(10)), /already owns a session/);
});

test('SessionManager removal remains safe after webContents destruction', () => {
  const manager = new SessionManager({
    launchId: 'launch-1',
    createId: () => 'session-a',
    getHubContext: async () => ({ hubUrl: 'ws://127.0.0.1:1', hubToken: 'secret' }),
    getSessionCapabilities: (sessionId) => ({
      studio: `${sessionId}:studio`,
      reference: `${sessionId}:reference`,
      template: `${sessionId}:template`,
    }),
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
  assert.deepEqual(exportedHistoryType?.UTTypeConformsTo, ['public.content', 'public.data']);
  const historyDocumentType = macInfo.CFBundleDocumentTypes.find((type: {
    LSItemContentTypes?: string[];
  }) => type.LSItemContentTypes?.includes('com.hataewook.rauhwpx.history-bundle'));
  assert.equal(historyDocumentType?.LSTypeIsPackage, undefined);
  assert.doesNotMatch(JSON.stringify(macInfo), /com\.apple\.package/);

  assert.equal(rootPackage.build.nsis.oneClick, false);
  assert.equal(rootPackage.build.nsis.perMachine, false);
  assert.equal(rootPackage.build.nsis.selectPerMachineByDefault, false);
  assert.equal(rootPackage.build.nsis.allowElevation, true);
  assert.equal(rootPackage.build.nsis.packElevateHelper, true);
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
    'desktop:pick-legacy-history-folder',
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
  assert.match(
    desktopMain,
    /if \(!response\.ok\)[\s\S]*?response\.body\?\.cancel\?\./,
  );
});

test('generated artifact responses enforce declared and observed limits before allocation', async () => {
  let cancelled = false;
  const oversized = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Length': '5' } });
  await assert.rejects(
    readGeneratedDocumentResponse(oversized, 4),
    /64 MiB limit/,
  );
  assert.equal(cancelled, true);

  let overflowCancelled = false;
  const chunked = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
    },
    cancel() { overflowCancelled = true; },
  }));
  await assert.rejects(
    readGeneratedDocumentResponse(chunked, 4),
    /64 MiB limit/,
  );
  assert.equal(overflowCancelled, true);

  const exact = await readGeneratedDocumentResponse(
    new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Length': '4' } }),
    4,
  );
  assert.deepEqual(exact, new Uint8Array([1, 2, 3, 4]));
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

test('desktop dev cache is disabled and cleared before loading the Studio', async () => {
  const calls: string[] = [];
  await prepareDevelopmentCaches({
    clearCache: async () => { calls.push('http'); },
    clearCodeCaches: async (options: unknown) => {
      assert.deepEqual(options, {});
      calls.push('code');
    },
    setCodeCachePath: (path: string) => { calls.push(`path:${path}`); },
  }, '/runtime/active/code-cache');
  assert.deepEqual(calls, ['http', 'code', 'path:/runtime/active/code-cache']);
  assert.match(desktopMain, /if \(devUrl\) app\.commandLine\.appendSwitch\('disable-http-cache'\)/);
  assert.match(desktopMain, /'development browser cache',[\s\S]*prepareDevelopmentCaches\([\s\S]*electronSession\.defaultSession,[\s\S]*join\(runtimeDir, 'code-cache'\)/);
});

test('launch roots are isolated by the canonical userData profile', () => {
  const launchId = '2257ce8b-6e52-4fec-889e-c6ba489226f8';
  const first = launchStoragePaths({
    tempDir: 'C:\\Temp',
    userDataDir: 'C:\\Users\\Rau\\AppData\\Roaming\\Rauhwpx',
    launchId,
    platform: 'win32',
    realpathImpl: () => 'C:\\Users\\Rau\\AppData\\Roaming\\Rauhwpx',
  });
  const sameProfile = launchStoragePaths({
    tempDir: 'C:\\Temp',
    userDataDir: 'c:\\users\\rau\\appdata\\roaming\\rauhwpx',
    launchId,
    platform: 'win32',
    realpathImpl: () => 'c:\\users\\rau\\appdata\\roaming\\rauhwpx',
  });
  const otherProfile = launchStoragePaths({
    tempDir: 'C:\\Temp',
    userDataDir: 'C:\\worktree-b\\.run\\desktop-user-data',
    launchId,
    platform: 'win32',
    realpathImpl: () => 'C:\\worktree-b\\.run\\desktop-user-data',
  });

  assert.equal(first.profileId, sameProfile.profileId);
  assert.notEqual(first.profileId, otherProfile.profileId);
  assert.match(first.runtimeRoot, new RegExp(`profiles\\\\${first.profileId}\\\\runtime$`));
  assert.match(first.workRoot, new RegExp(`launch-work\\\\${first.profileId}$`));
});

test('startup cleanup requires an old owner record and a confirmed dead PID', async () => {
  const active = '2257ce8b-6e52-4fec-889e-c6ba489226f8';
  const stale = '2848f76b-9d57-4d81-8410-4023c59cb403';
  const live = 'f98c7e94-d89a-4d9c-b549-41bf4b230468';
  const young = '7fb8481d-9388-4e0e-b370-a6fd71b15e27';
  const unowned = '4ac3e204-b7d9-4c99-b302-baa88b76c2f8';
  const foreign = '5327bd99-1d76-4ed5-81cf-f3182f6d127f';
  const profileId = '1234567890abcdef1234';
  const now = 10_000;
  const removed: string[] = [];
  const result = await removeStaleLaunchDirectories('/launch-work', active, {
    expectedProfileId: profileId,
    minimumAgeMs: 1_000,
    now: () => now,
    isAlive: (pid: number) => pid === 22,
    readdirImpl: async () => [
      { name: active, isDirectory: () => true },
      { name: stale, isDirectory: () => true },
      { name: live, isDirectory: () => true },
      { name: young, isDirectory: () => true },
      { name: unowned, isDirectory: () => true },
      { name: foreign, isDirectory: () => true },
      { name: 'keep-me', isDirectory: () => true },
    ],
    readFileImpl: async (ownerPath: string) => {
      if (path.basename(ownerPath) === LEGACY_CLEANUP_MARKER_FILE) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      const directory = path.basename(path.dirname(ownerPath));
      assert.equal(path.basename(ownerPath), LAUNCH_OWNER_FILE);
      if (directory === unowned) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return JSON.stringify({
        version: 1,
        launchId: directory,
        profileId: directory === foreign ? 'abcdef1234567890abcd' : profileId,
        pid: directory === live ? 22 : 11,
        createdAtMs: directory === young ? 9_500 : 1_000,
      });
    },
    rmImpl: async (path: string, options: unknown) => {
      assert.deepEqual(options, { recursive: true, force: true });
      removed.push(path);
    },
  });
  assert.deepEqual(result, [stale]);
  assert.deepEqual(removed, [path.join('/launch-work', stale)]);
  assert.match(desktopMain, /removeStaleLaunchDirectories\(runtimeRoot, launchId,/);
  assert.match(desktopMain, /removeStaleLaunchDirectories\(workRoot, launchId,/);
  assert.match(desktopMain, /launchStoragePaths\(/);
  assert.match(desktopMain, /writeLaunchOwnerMetadata\(runtimeDir, owner\)/);
  assert.match(desktopMain, /expectedProfileId: userDataProfileId/);
});

test('startup cleanup bounds launch enumeration and retains oversized metadata', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rauhwpx-bounded-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oversizedOwner = '2848f76b-9d57-4d81-8410-4023c59cb403';
  const oversizedMarker = 'f98c7e94-d89a-4d9c-b549-41bf4b230468';
  await Promise.all([
    mkdir(path.join(root, oversizedOwner)),
    mkdir(path.join(root, oversizedMarker)),
  ]);
  await writeFile(path.join(root, oversizedOwner, LAUNCH_OWNER_FILE), 'x'.repeat(4097));
  await writeFile(
    path.join(root, oversizedMarker, LEGACY_CLEANUP_MARKER_FILE),
    'x'.repeat(4097),
  );

  assert.deepEqual(await removeStaleLaunchDirectories(root, '', {
    expectedProfileId: '1234567890abcdef1234',
    minimumAgeMs: 0,
    now: () => Date.now(),
    isAlive: () => false,
  }), []);
  assert.deepEqual(await removeLegacyLaunchDirectories(root, '', {
    minimumAgeMs: 0,
    now: () => Date.now(),
    uptimeSeconds: () => 10,
  }), []);
  assert.equal((await stat(path.join(root, oversizedOwner))).isDirectory(), true);
  assert.equal((await stat(path.join(root, oversizedMarker))).isDirectory(), true);
  await assert.rejects(
    stat(path.join(root, oversizedOwner, LEGACY_CLEANUP_MARKER_FILE)),
    { code: 'ENOENT' },
  );
  assert.equal(
    (await readFile(path.join(root, oversizedMarker, LEGACY_CLEANUP_MARKER_FILE))).byteLength,
    4097,
  );

  let yielded = 0;
  let closed = 0;
  const virtualDirectory = {
    async *[Symbol.asyncIterator]() {
      while (yielded < MAX_LAUNCH_DIRECTORY_ENTRIES + 100) {
        yielded += 1;
        yield { name: `untrusted-${yielded}`, isDirectory: () => true };
      }
    },
    close: async () => { closed += 1; },
  };
  assert.deepEqual(await removeStaleLaunchDirectories('/virtual-launches', '', {
    opendirImpl: async () => virtualDirectory,
  }), []);
  assert.equal(yielded, MAX_LAUNCH_DIRECTORY_ENTRIES + 1);
  assert.equal(closed, 1);
});

test('legacy cleanup marks an old unowned launch and removes it only after an uptime reset', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rauhwpx-legacy-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stale = '2848f76b-9d57-4d81-8410-4023c59cb403';
  const directory = path.join(root, stale);
  await mkdir(directory);
  const now = Date.now();
  const old = new Date(now - 8 * 24 * 60 * 60 * 1000);
  await utimes(directory, old, old);

  assert.deepEqual(await removeLegacyLaunchDirectories(root, '', {
    now: () => now,
    uptimeSeconds: () => 10_000,
  }), []);
  const markerPath = path.join(directory, LEGACY_CLEANUP_MARKER_FILE);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.equal(marker.launchId, stale);
  assert.equal(marker.observedUptimeSeconds, 10_000);
  // Windows mode bits do not expose the file's DACL. Node reports regular
  // writable files as 0666 there even when they were opened with mode 0600.
  assert.equal((await stat(markerPath)).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);

  assert.deepEqual(await removeLegacyLaunchDirectories(root, '', {
    now: () => now + 1_000,
    uptimeSeconds: () => 10_030,
  }), []);
  assert.equal((await stat(directory)).isDirectory(), true);

  assert.deepEqual(await removeLegacyLaunchDirectories(root, '', {
    now: () => now + 2_000,
    uptimeSeconds: () => 10,
  }), [stale]);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('legacy cleanup keeps a metadata-less launch across the same boot', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rauhwpx-legacy-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stale = '2848f76b-9d57-4d81-8410-4023c59cb403';
  const directory = path.join(root, stale);
  await mkdir(directory);
  const now = Date.now();
  const old = new Date(now - 8 * 24 * 60 * 60 * 1000);
  await utimes(directory, old, old);

  await removeLegacyLaunchDirectories(root, '', {
    now: () => now,
    uptimeSeconds: () => 1_000,
  });
  const result = await removeLegacyLaunchDirectories(root, '', {
    now: () => now + 30 * 24 * 60 * 60 * 1000,
    uptimeSeconds: () => 1_000 + 30 * 24 * 60 * 60,
  });
  assert.deepEqual(result, []);
  assert.equal((await stat(directory)).isDirectory(), true);
});

test('cleanup retains a dead launch until credential copyback settles', async () => {
  const stale = '2848f76b-9d57-4d81-8410-4023c59cb403';
  let removed = false;
  const result = await removeStaleLaunchDirectories('/launch-work', '', {
    expectedProfileId: '1234567890abcdef1234',
    minimumAgeMs: 0,
    now: () => 10_000,
    isAlive: () => false,
    readdirImpl: async (directory: string) => directory.endsWith(CREDENTIAL_RETENTION_DIR)
      // Even a corrupted marker type must fail closed instead of authorizing deletion.
      ? [{ name: '1234567890abcdef.pending', isFile: () => false }]
      : [{ name: stale, isDirectory: () => true }],
    readFileImpl: async () => JSON.stringify({
      version: 1,
      launchId: stale,
      profileId: '1234567890abcdef1234',
      pid: 11,
      createdAtMs: 1_000,
    }),
    rmImpl: async () => { removed = true; },
  });
  assert.deepEqual(result, []);
  assert.equal(removed, false);
});

test('uncertain process cleanup is retained until a reboot proves descendants dead', async (t) => {
  assert.equal(LAUNCH_CLEANUP_RETENTION_FILE, LEGACY_CLEANUP_MARKER_FILE);
  const root = await mkdtemp(path.join(tmpdir(), 'rauhwpx-process-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stale = '2848f76b-9d57-4d81-8410-4023c59cb403';
  const profileId = '1234567890abcdef1234';
  const directory = path.join(root, stale);
  await writeLaunchOwnerMetadata(directory, {
    launchId: stale,
    profileId,
    pid: 11,
    createdAtMs: 1_000,
  });
  await writeFile(path.join(directory, LEGACY_CLEANUP_MARKER_FILE), JSON.stringify({
    version: 1,
    launchId: stale,
    observedUptimeSeconds: 10_000,
    observedAtMs: 9_000,
    directoryMtimeMs: (await stat(directory)).mtimeMs,
  }));

  assert.deepEqual(await removeStaleLaunchDirectories(root, '', {
    expectedProfileId: profileId,
    minimumAgeMs: 0,
    now: () => 20_000,
    uptimeSeconds: () => 10_030,
    isAlive: () => false,
  }), []);
  assert.equal((await stat(directory)).isDirectory(), true);

  assert.deepEqual(await removeStaleLaunchDirectories(root, '', {
    expectedProfileId: profileId,
    minimumAgeMs: 0,
    now: () => 21_000,
    uptimeSeconds: () => 10,
    isAlive: () => false,
  }), [stale]);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('owner metadata is written before cleanup begins', async () => {
  const writes: Array<{ path: string; body: string; options: unknown }> = [];
  const renames: string[][] = [];
  await writeLaunchOwnerMetadata('/runtime/launch', {
    launchId: '2257ce8b-6e52-4fec-889e-c6ba489226f8',
    profileId: '1234567890abcdef1234',
    pid: 42,
    createdAtMs: 1_234,
  }, {
    mkdirImpl: async () => undefined,
    writeFileImpl: async (filePath: string, body: string, options: unknown) => {
      writes.push({ path: filePath, body, options });
    },
    renameImpl: async (source: string, target: string) => { renames.push([source, target]); },
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].body), {
    version: 1,
    launchId: '2257ce8b-6e52-4fec-889e-c6ba489226f8',
    profileId: '1234567890abcdef1234',
    pid: 42,
    createdAtMs: 1_234,
  });
  assert.deepEqual(writes[0].options, { encoding: 'utf8', mode: 0o600 });
  assert.equal(renames[0][1], path.join('/runtime/launch', LAUNCH_OWNER_FILE));
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
  assert.equal(historyAssociation?.name, 'Rauhwpx history archive');
  assert.notEqual(historyAssociation?.name, 'Hangul document');
  assert.equal(historyAssociation?.isPackage, undefined);
  assert.match(desktopMain, /desktop:pick-legacy-history-folder/);
  assert.match(desktopMain, /properties: \['openFile'\]/);
  assert.match(desktopMain, /properties: \['openDirectory'\]/);
  assert.doesNotMatch(desktopMain, /\['openFile', 'openDirectory'\]/);
  assert.doesNotMatch(desktopMain, /writePortableHistoryFolder\(/);
  assert.doesNotMatch(desktopMain, /desktop:(?:save-portable-history-file|native-file-write-portable-history)/);
  assert.match(desktopMain, /RauHWPX history archive/);
  assert.ok(rootPackage.build.asarUnpack.includes('rhwp/rhwp-agent/**'));
  assert.ok(rootPackage.build.files.every((entry: string) => !/runtime|launch-work/.test(entry)));
});

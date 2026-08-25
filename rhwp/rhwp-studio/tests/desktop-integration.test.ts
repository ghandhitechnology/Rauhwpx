import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  bindNativeFileHandleIdentity,
  captureDesktopNativeDroppedFile,
  createNativeFileHandle,
  ensureDesktopAgentHub,
  getNativeFileHandleVerifiedDocumentId,
  getNativeFileSourcePath,
  installDesktopGeneratedDocumentHandling,
  installDesktopPlainTextPasteHandling,
  installWebAppShell,
  isDesktopApp,
  openPublishedDocumentInNewWindow,
  parsePublishedDocumentLink,
  pickDesktopNativeOpenFile,
  pickDesktopNativeSaveFile,
  rememberNativeDocument,
  requestDevAgentHub,
  restoreNativeDocument,
  releaseReplacedNativeFileHandle,
  searchNearbyNativeDocuments,
  saveDesktopPortableHistoryFile,
  suppressDesktopServiceWorker,
  type NativeFileHandleDescriptor,
} from '../src/desktop-integration.ts';

const source = readFileSync(new URL('../src/desktop-integration.ts', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../src/ui/agent-sidebar/settings.ts', import.meta.url), 'utf8');

test('desktop integration asks the shell to launch a missing hub', async () => {
  assert.equal(isDesktopApp({}), false);
  assert.equal(await ensureDesktopAgentHub({}), false);

  let calls = 0;
  const win = {
    rhwpDesktop: {
      ensureAgentHub: async () => {
        calls += 1;
        return { started: true, ready: true };
      },
    },
  };
  assert.equal(isDesktopApp(win), true);
  assert.equal(await ensureDesktopAgentHub(win), true);
  assert.equal(calls, 1);

  let overlap = 0;
  let release: ((value: { ready: boolean }) => void) | undefined;
  const pending = {
    rhwpDesktop: {
      ensureAgentHub: () => new Promise<{ ready: boolean }>((resolve) => {
        overlap += 1;
        release = resolve;
      }),
    },
  };
  const first = ensureDesktopAgentHub(pending);
  const second = ensureDesktopAgentHub(pending);
  assert.equal(overlap, 1);
  release?.({ ready: true });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('dev ensure path asks Vite to start a missing hub', async () => {
  assert.match(source, /\/__rhwp\/ensure-agent-hub/);
  let calls = 0;
  const ready = await requestDevAgentHub(async (url, init) => {
    calls += 1;
    assert.match(String(url), /^\/__rhwp\/ensure-agent-hub\?sessionId=/);
    assert.equal((init as { method?: string })?.method, 'POST');
    return {
      ok: true,
      json: async () => ({ started: true, ready: true }),
    } as Response;
  });
  assert.equal(ready, true);
  assert.equal(calls, 1);
});

test('published artifact links open through a fresh editor window on desktop', async () => {
  const href = 'http://127.0.0.1:5175/artifacts/artifact_token_1234567890/%EB%B3%B4%EA%B3%A0%EC%84%9C%28%ED%8C%80%29.hwp?sessionId=a&token=b';
  const artifact = parsePublishedDocumentLink(href);
  assert.deepEqual(artifact, { downloadUrl: href, fileName: '보고서(팀).hwp' });
  const templateHref = `${href}&templatePreview=1`;
  assert.deepEqual(parsePublishedDocumentLink(templateHref), {
    downloadUrl: templateHref,
    fileName: '보고서(팀).hwp',
    readOnly: true,
  });
  assert.equal(parsePublishedDocumentLink('https://example.com/artifacts/artifact_token_1234567890/a.hwp'), null);
  assert.equal(parsePublishedDocumentLink('javascript:alert(1)'), null);

  const opened: Array<{ fileName: string; downloadUrl: string; readOnly?: boolean }> = [];
  await openPublishedDocumentInNewWindow(artifact!, {
    rhwpDesktop: {
      openGeneratedDocumentWindow: async (payload) => {
        opened.push(payload);
        return true;
      },
    },
  });
  assert.equal(opened[0]?.fileName, '보고서(팀).hwp');
  assert.equal(opened[0]?.downloadUrl, href);

  await openPublishedDocumentInNewWindow(artifact!, {
    rhwpDesktop: {
      openGeneratedDocumentWindow: async (payload) => {
        opened.push(payload);
        return true;
      },
    },
  }, { readOnly: true });
  assert.equal(opened[1]?.readOnly, true);
});

test('browser artifact links open another Studio page with an authenticated source URL', async () => {
  const artifact = parsePublishedDocumentLink(
    'http://localhost:5175/artifacts/artifact_token_1234567890/report.hwpx?sessionId=a&token=b',
  );
  const opened: string[] = [];
  await openPublishedDocumentInNewWindow(artifact!, {
    location: { href: 'http://localhost:7700/editor?old=1#page' },
    open: (url: string) => { opened.push(String(url)); },
  } as any);
  const target = new URL(opened[0]!);
  assert.equal(target.origin + target.pathname, 'http://localhost:7700/editor');
  assert.equal(target.searchParams.get('url'), artifact?.downloadUrl);
  assert.equal(target.searchParams.get('filename'), 'report.hwpx');

  await openPublishedDocumentInNewWindow(artifact!, {
    location: { href: 'http://localhost:7700/editor' },
    open: (url: string) => { opened.push(String(url)); },
  } as any, { readOnly: true });
  assert.equal(new URL(opened[1]!).searchParams.get('templatePreview'), '1');
});

test('generated-document startup fallback and event delivery open only once', async () => {
  const payload = {
    launchDocumentId: 'launch-document-1',
    fileName: 'report.hwpx',
    bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    readOnly: true,
  };
  let listener: ((value: typeof payload) => void) | undefined;
  const opened: Array<{ fileName: string; readOnly: boolean }> = [];
  const installed = installDesktopGeneratedDocumentHandling(
    ({ fileName, readOnly }) => opened.push({ fileName, readOnly }),
    {
      rhwpDesktop: {
        onOpenGeneratedDocument: (callback) => { listener = callback; },
        getLaunchGeneratedDocument: async () => payload,
      },
    },
  );
  assert.equal(installed, true);
  listener?.(payload);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(opened, [{ fileName: 'report.hwpx', readOnly: true }]);
});

test('desktop plain-paste events deliver only non-empty clipboard text', () => {
  let listener: ((text: string) => void) | undefined;
  const pasted: string[] = [];
  const installed = installDesktopPlainTextPasteHandling(
    (text) => pasted.push(text),
    {
      rhwpDesktop: {
        onPastePlainText: (callback) => { listener = callback; },
      },
    },
  );

  assert.equal(installed, true);
  listener?.('plain text');
  listener?.('');
  assert.deepEqual(pasted, ['plain text']);
  assert.equal(installDesktopPlainTextPasteHandling(() => {}, {}), false);
});

test('Electron Save As returns a temporary opaque handle and releases failed targets', async () => {
  const released: string[] = [];
  const win = {
    rhwpDesktop: {
      pickNativeOpenFile: async () => ({ kind: 'file' as const, handleId: 'open-target', name: 'opened.hwp' }),
      claimNativeDroppedFile: async () => ({
        kind: 'file' as const,
        handleId: 'drop-target',
        name: 'dropped.hwp',
        saveTargetCreated: true,
      }),
      pickNativeSaveFile: async () => ({ kind: 'file' as const, handleId: 'save-target', name: 'report.hwp' }),
      releaseNativeFile: async (handleId: string) => { released.push(handleId); },
      readNativeFile: async () => ({ name: 'report.hwp', bytes: new Uint8Array() }),
      validateNativeSave: async () => {},
      writeNativeFile: async () => ({ name: 'report.hwp', byteLength: 0 }),
    },
  };
  const dropped = await captureDesktopNativeDroppedFile(new File([], 'dropped.hwp'), win);
  assert.equal(dropped?.identityKind, 'native-path');
  await dropped?.releaseUnusedSaveTarget?.();
  const opened = await pickDesktopNativeOpenFile(win);
  assert.equal(opened?.identityKind, 'native-path');
  const handle = await pickDesktopNativeSaveFile({ suggestedName: 'report.hwp' }, win);
  assert.equal(handle?.identityKind, 'native-path');
  await handle?.releaseUnusedSaveTarget?.();
  await handle?.releaseUnusedSaveTarget?.();
  assert.deepEqual(released, ['drop-target', 'save-target']);
});

test('portable history export uses the dedicated desktop save boundary', async () => {
  const writes: Array<{
    suggestedName: string;
    files: Array<{ name: string; bytes: number[] }>;
  }> = [];
  const folder = {
    folderName: 'report.rhwpx',
    files: [
      { name: 'history', bytes: new Uint8Array([1, 2, 3]) },
      { name: 'report.hwpx', bytes: new Uint8Array([4, 5]) },
    ],
  };
  const result = await saveDesktopPortableHistoryFile(
    folder,
    {
      rhwpDesktop: {
        savePortableHistoryFile: async ({ suggestedName, files }) => {
          writes.push({
            suggestedName,
            files: files.map((file) => ({ name: file.name, bytes: [...file.bytes] })),
          });
          return { fileName: suggestedName, byteLength: 5 };
        },
      },
    },
  );
  assert.equal(result, 'saved');
  assert.deepEqual(writes, [{
    suggestedName: 'report.rhwpx',
    files: [
      { name: 'history', bytes: [1, 2, 3] },
      { name: 'report.hwpx', bytes: [4, 5] },
    ],
  }]);
  assert.equal(await saveDesktopPortableHistoryFile(folder, {}), 'unavailable');
});

test('native document bookmarks restore opaque handles without exposing a path', async () => {
  const remembered: Array<[string, string]> = [];
  const win = {
    rhwpDesktop: {
      rememberNativeDocument: async (documentId: string, handleId: string) => {
        remembered.push([documentId, handleId]);
      },
      reopenNativeDocument: async (documentId: string) => {
        assert.equal(documentId, 'document-a');
        return { kind: 'file' as const, handleId: 'restored', name: 'report.hwp' };
      },
      readNativeFile: async () => ({ name: 'report.hwp', bytes: new Uint8Array() }),
      writeNativeFile: async () => ({ name: 'report.hwp', byteLength: 0 }),
      releaseNativeFile: async () => {},
    },
  };
  const opened = await pickDesktopNativeOpenFile({
    rhwpDesktop: {
      ...win.rhwpDesktop,
      pickNativeOpenFile: async () => ({ kind: 'file' as const, handleId: 'live', name: 'report.hwp' }),
    },
  });
  assert.ok(opened);
  await rememberNativeDocument('document-a', opened);
  assert.deepEqual(remembered, [['document-a', 'live']]);

  const restored = await restoreNativeDocument('document-a', win);
  assert.equal(restored === 'owned' ? null : restored?.identityKind, 'native-path');
  assert.equal(restored === 'owned' ? null : restored?.name, 'report.hwp');
});

test('native descriptor identity is validated and remains private immutable metadata', () => {
  const descriptor: NativeFileHandleDescriptor = {
    kind: 'file',
    handleId: 'restored',
    name: 'report.hwp',
    verifiedDocumentId: 'document-a',
  };
  const api = {
    readNativeFile: async () => ({ name: 'report.hwp', bytes: new Uint8Array() }),
    writeNativeFile: async () => ({ name: 'report.hwp', byteLength: 0 }),
  };
  const handle = createNativeFileHandle(descriptor, api);
  assert.equal(getNativeFileHandleVerifiedDocumentId(handle), 'document-a');
  assert.equal('verifiedDocumentId' in handle, false);
  descriptor.verifiedDocumentId = 'renderer-hint';
  assert.equal(getNativeFileHandleVerifiedDocumentId(handle), 'document-a');

  for (const verifiedDocumentId of ['', ' document-a', 'document-a ', 'document\0a', null]) {
    assert.throws(
      () => createNativeFileHandle({
        kind: 'file',
        handleId: 'invalid',
        name: 'report.hwp',
        verifiedDocumentId,
      } as unknown as NativeFileHandleDescriptor, api),
      /Invalid native file handle descriptor/,
    );
  }
});

test('agents can resolve only the exact path behind the active opaque desktop handle', async () => {
  const requested: string[] = [];
  const handleIds = ['same-name-a', 'same-name-b'];
  const paths: Record<string, string> = {
    'same-name-a': '/Users/test/A/보고서.hwp',
    'same-name-b': '/Users/test/B/보고서.hwp',
  };
  const win = {
    rhwpDesktop: {
      pickNativeOpenFile: async () => ({ kind: 'file' as const, handleId: handleIds.shift()!, name: '보고서.hwp' }),
      readNativeFile: async () => ({ name: '보고서.hwp', bytes: new Uint8Array() }),
      writeNativeFile: async () => ({ name: '보고서.hwp', byteLength: 0 }),
      getNativeFileSourcePath: async (handleId: string) => {
        requested.push(handleId);
        return paths[handleId] ?? null;
      },
    },
  };
  const first = await pickDesktopNativeOpenFile(win);
  const sameNamedSecond = await pickDesktopNativeOpenFile(win);
  assert.equal(await getNativeFileSourcePath(first), '/Users/test/A/보고서.hwp');
  assert.equal(await getNativeFileSourcePath(sameNamedSecond), '/Users/test/B/보고서.hwp');
  assert.deepEqual(requested, ['same-name-a', 'same-name-b']);
  assert.equal(await getNativeFileSourcePath(null), null);
});

test('nearby probes keep only opaque ids and names', async () => {
  const win = {
    rhwpDesktop: {
      searchNearbyNativeDocument: async () => [{
        probeId: 'probe-1',
        fileName: 'report.hwp',
        path: '/secret/docs/report.hwp',
      }],
    },
  };
  const probes = await searchNearbyNativeDocuments('document-a', { basenameHint: 'report.hwp' }, win);
  assert.deepEqual(probes, [{ probeId: 'probe-1', fileName: 'report.hwp' }]);
  assert.equal(JSON.stringify(probes).includes('/secret'), false);
});

test('releasing a replaced native handle bookmarks it first', async () => {
  const remembered: Array<[string, string]> = [];
  const released: string[] = [];
  const win = {
    rhwpDesktop: {
      pickNativeOpenFile: async () => ({ kind: 'file' as const, handleId: 'old', name: 'old.hwp' }),
      rememberNativeDocument: async (documentId: string, handleId: string) => {
        remembered.push([documentId, handleId]);
      },
      releaseNativeFile: async (handleId: string) => { released.push(handleId); },
      readNativeFile: async () => ({ name: 'old.hwp', bytes: new Uint8Array() }),
      writeNativeFile: async () => ({ name: 'old.hwp', byteLength: 0 }),
    },
  };
  const previous = await pickDesktopNativeOpenFile(win);
  assert.ok(previous);
  bindNativeFileHandleIdentity(previous, { documentId: 'document-a', sourceDigest: 'blake3:a' });
  await releaseReplacedNativeFileHandle(previous, null);
  assert.deepEqual(remembered, [['document-a', 'old']]);
  assert.deepEqual(released, ['old']);
});

test('브리지와 설정 재연결이 데스크톱 허브 기동을 탄다', () => {
  assert.match(bridge, /await this\.requestHubLaunch\(\)/);
  assert.match(bridge, /async reconnectNow\(\): Promise<void>/);
  assert.match(settings, /void bridge\.reconnectNow\(\)/);
  assert.doesNotMatch(settings, /ensureDesktopAgentHub/);
  assert.match(settings, /hubReconnect\.disabled = connectionState === 'connected'/);
  assert.doesNotMatch(
    settings,
    /hubReconnect\.disabled = connectionState === 'connected' \|\| connectionState === 'connecting'/,
  );
  assert.match(source, /rhwpDesktop\?\.ensureAgentHub/);
  assert.match(source, /\/Electron\/i\.test\(ua\)/);
});

test('데스크톱 셸은 서비스 워커를 끄고 PWA 등록을 건너뛴다', async () => {
  const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(vite, /injectRegister:\s*false/);
  assert.match(main, /installWebAppShell\(\)/);

  const unregisters: string[] = [];
  await suppressDesktopServiceWorker({
    rhwpDesktop: { ensureAgentHub: async () => true },
    navigator: {
      serviceWorker: {
        getRegistrations: async () => [{
          unregister: async () => {
            unregisters.push('sw');
            return true;
          },
        }],
        addEventListener: () => {},
      },
    },
  });
  assert.deepEqual(unregisters, ['sw']);

  installWebAppShell({});
});

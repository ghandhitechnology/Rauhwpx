import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  captureDesktopNativeDroppedFile,
  ensureDesktopAgentHub,
  installWebAppShell,
  isDesktopApp,
  pickDesktopNativeOpenFile,
  pickDesktopNativeSaveFile,
  requestDevAgentHub,
  suppressDesktopServiceWorker,
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ensureDesktopAgentHub, isDesktopApp } from '../src/desktop-integration.ts';

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

test('브리지와 설정 재연결이 데스크톱 허브 기동을 탄다', () => {
  assert.match(bridge, /void ensureDesktopAgentHub\(\)/);
  assert.match(settings, /void ensureDesktopAgentHub\(\)/);
  assert.match(settings, /hubReconnect\.disabled = connectionState === 'connected'/);
  assert.doesNotMatch(
    settings,
    /hubReconnect\.disabled = connectionState === 'connected' \|\| connectionState === 'connecting'/,
  );
  assert.match(source, /rhwpDesktop\?\.ensureAgentHub/);
  assert.match(source, /\/Electron\/i\.test\(ua\)/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  clearChatStatus,
  getChatStatus,
  markChatFinished,
  markChatWorking,
  subscribeChatStatus,
} from '../src/agent/chat-status.ts';

const STORAGE_KEY = 'rhwp-agent-chat-status';
const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, v);
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
};

Object.defineProperty(globalThis, 'localStorage', {
  value: storage,
  configurable: true,
});

test('working and finished signals round-trip through shared storage', () => {
  mem.clear();
  markChatWorking('t-1');
  assert.equal(getChatStatus('t-1'), 'working');
  markChatFinished('t-1');
  assert.equal(getChatStatus('t-1'), 'finished');
  clearChatStatus('t-1');
  assert.equal(getChatStatus('t-1'), null);
});

test('subscribers hear material changes only, not heartbeat rewrites', () => {
  mem.clear();
  let changes = 0;
  const unsubscribe = subscribeChatStatus(() => {
    changes += 1;
  });
  markChatWorking('t-2');
  assert.equal(changes, 1);
  // 같은 상태를 다시 쓰는 건 심장박동과 같다 — 알림이 없어야 한다.
  markChatWorking('t-2');
  assert.equal(changes, 1);
  markChatFinished('t-2');
  assert.equal(changes, 2);
  unsubscribe();
  clearChatStatus('t-2');
  assert.equal(changes, 2);
});

test('a working signal without heartbeats goes dark instead of sticking', () => {
  mem.clear();
  mem.set(STORAGE_KEY, JSON.stringify({
    stale: { status: 'working', updatedAt: Date.now() - 60_000 },
    alive: { status: 'working', updatedAt: Date.now() },
  }));
  assert.equal(getChatStatus('stale'), null);
  assert.equal(getChatStatus('alive'), 'working');
});

test('finished dots are tidied away after their TTL', () => {
  mem.clear();
  mem.set(STORAGE_KEY, JSON.stringify({
    old: { status: 'finished', updatedAt: Date.now() - 7 * 60 * 60 * 1000 },
    recent: { status: 'finished', updatedAt: Date.now() },
  }));
  assert.equal(getChatStatus('old'), null);
  assert.equal(getChatStatus('recent'), 'finished');
});

test('the sidebar lights threads while turns run and settles them on completion', () => {
  const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
  // turn-start 가 현재 스레드에 불을 붙이고, turn-end 가 중단/완료를 가른다.
  assert.match(source, /runStatusThreadId = currentThread\.id;\s*\n\s*markChatWorking\(runStatusThreadId\)/);
  assert.match(source, /stopReason === 'interrupted'\) clearChatStatus\(runStatusThreadId\)/);
  assert.match(source, /else markChatFinished\(runStatusThreadId\)/);
  // 열람은 완료 점만 걷고, 다른 탭의 노란 불은 건드리지 않는다.
  assert.match(source, /getChatStatus\(id\) === 'finished'\) clearChatStatus\(id\)/);
  // 목록 행과 접힌 그룹 줄 양쪽에 점이 붙고, 상태 변화가 목록을 다시 그린다.
  assert.match(source, /buildStatusDot\(status, 'ag-row-status'\)/);
  assert.match(source, /buildStatusDot\(rollup, 'ag-group-status'\)/);
  assert.match(source, /subscribeChatStatus\(\(\) => \{\s*\n\s*if \(threadsListVisible\(\)\) rebuildThreadsList\(\)/);
  assert.match(css, /\.ag-thread-status-working\s*\{[^}]*animation: ag-status-glow/s);
  assert.match(css, /\.ag-thread-status-finished\s*\{[^}]*var\(--ag-ok\)/s);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  clearChatStatus,
  getChatStatus,
  markChatFinished,
  markChatNeedsInput,
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
  markChatNeedsInput('t-1');
  assert.equal(getChatStatus('t-1'), 'needs-input');
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

test('finished and needs-input dots are tidied away after their TTL', () => {
  mem.clear();
  mem.set(STORAGE_KEY, JSON.stringify({
    old: { status: 'finished', updatedAt: Date.now() - 7 * 60 * 60 * 1000 },
    recent: { status: 'finished', updatedAt: Date.now() },
    'old-plan': { status: 'needs-input', updatedAt: Date.now() - 7 * 60 * 60 * 1000 },
    'recent-plan': { status: 'needs-input', updatedAt: Date.now() },
  }));
  assert.equal(getChatStatus('old'), null);
  assert.equal(getChatStatus('recent'), 'finished');
  assert.equal(getChatStatus('old-plan'), null);
  assert.equal(getChatStatus('recent-plan'), 'needs-input');
});

test('the sidebar lights threads while turns run and settles them on completion', () => {
  const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
  // turn-start 가 현재 스레드에 불을 붙이고, turn-end 가 중단/완료를 가른다.
  assert.match(source, /runStatusThreadId = currentThread\.id;\s*\n\s*markChatWorking\(runStatusThreadId\)/);
  assert.match(source, /stopReason === 'interrupted'\) clearChatStatus\(runStatusThreadId\)/);
  assert.match(source, /else markChatFinished\(runStatusThreadId\)/);
  // 승인 대기로 끝난 계획 턴은 빨간 점을 남기고, 승인·수정 요청·무효화가 걷는다.
  assert.match(source, /planningPhase === 'awaiting-approval' && planApprovable\) \{\s*\n\s*markChatNeedsInput\(runStatusThreadId\)/);
  assert.match(source, /case 'plan-approved':[\s\S]{0,220}settlePlanAttention\(\)/);
  assert.match(source, /case 'implementation-started':[\s\S]{0,120}settlePlanAttention\(\)/);
  assert.match(source, /case 'plan-invalidated':[\s\S]{0,120}settlePlanAttention\(\)/);
  // 열람은 완료 점만 걷고, 다른 탭의 노란 불은 건드리지 않는다.
  assert.match(source, /getChatStatus\(id\) === 'finished'\) clearChatStatus\(id\)/);
  // 목록 행과 접힌 그룹 줄 양쪽에 점이 붙고, 상태 변화가 목록을 다시 그린다.
  assert.match(source, /buildStatusDot\(status, 'ag-row-status'\)/);
  assert.match(source, /buildStatusDot\(rollup, 'ag-group-status'\)/);
  assert.match(source, /subscribeChatStatus\(\(\) => \{\s*\n\s*if \(threadsListVisible\(\)\) rebuildThreadsList\(\)/);
  assert.match(css, /\.ag-thread-status-working\s*\{[^}]*animation: ag-status-glow/s);
  assert.match(css, /\.ag-thread-status-finished\s*\{[^}]*var\(--ag-ok\)/s);
  assert.match(css, /\.ag-thread-status-needs-input\s*\{[^}]*var\(--ag-err\)/s);
  // 접힌 그룹 롤업은 사용자를 기다리는 빨강이 다른 상태를 이긴다.
  assert.match(source, /statuses\.includes\('needs-input'\)\s*\n\s*\? 'needs-input'/);
});

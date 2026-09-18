import assert from 'node:assert/strict';
import test from 'node:test';

import { clearChatStatus, getChatStatus, markChatFinished, markChatNeedsInput, markChatWorking, subscribeChatStatus } from '../src/agent/chat-status.ts';

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

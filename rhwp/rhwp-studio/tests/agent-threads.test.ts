import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyThread,
  fallbackTitle,
  getThread,
  listThreads,
  setThreadTitle,
  upsertThread,
} from '../src/agent/threads.ts';

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

test('empty threads are not listed until they have messages', () => {
  mem.clear();
  const t = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  upsertThread(t);
  assert.equal(listThreads().length, 0);
  t.messages.push({ role: 'user', text: '표 제목을 고쳐줘' });
  upsertThread(t);
  assert.equal(listThreads().length, 1);
  assert.equal(listThreads()[0]!.id, t.id);
});

test('fallbackTitle uses the first user message', () => {
  assert.equal(
    fallbackTitle([{ role: 'user', text: '  안녕하세요 문서 요약  ' }]),
    '안녕하세요 문서 요약',
  );
});

test('setThreadTitle updates a persisted thread', () => {
  mem.clear();
  const t = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  t.messages.push({ role: 'user', text: 'hello' });
  upsertThread(t);
  setThreadTitle(t.id, '"문서 요약 요청"');
  assert.equal(getThread(t.id)?.title, '문서 요약 요청');
});

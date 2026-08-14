import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyThread,
  fallbackTitle,
  getThread,
  listThreads,
  listThreadsByDocument,
  setThreadTitle,
  upsertThread,
} from '../src/agent/threads.ts';
import type { StructuredPlan } from '../src/agent/types.ts';

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

test('legacy threads migrate to direct workflow', () => {
  mem.clear();
  storage.setItem('rhwp-agent-threads', JSON.stringify([{
    id: 'legacy',
    title: '이전 대화',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 2,
    agent: 'claude',
    model: 'sonnet',
    effort: 'high',
    messages: [{ role: 'user', text: '기존 메시지' }],
  }]));
  assert.equal(getThread('legacy')?.workflow, 'direct');
});

test('threads keep their document key and legacy threads fall back to null', () => {
  mem.clear();
  const t = createEmptyThread({
    agent: 'claude', model: 'sonnet', effort: 'high', docKey: '보고서.hwpx',
  });
  t.messages.push({ role: 'user', text: '표 정리해줘' });
  upsertThread(t);
  assert.equal(getThread(t.id)?.docKey, '보고서.hwpx');

  storage.setItem('rhwp-agent-threads', JSON.stringify([{
    id: 'legacy',
    title: '이전 대화',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 2,
    agent: 'claude',
    model: 'sonnet',
    effort: 'high',
    messages: [{ role: 'user', text: '기존 메시지' }],
  }]));
  assert.equal(getThread('legacy')?.docKey, null);
});

test('threads persist only stable document reference identity, never reference blobs', () => {
  mem.clear();
  const t = createEmptyThread({
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    docKey: '보고서.hwpx',
    documentId: 'doc-stable-1',
  });
  t.messages.push({ role: 'user', text: '첨부한 자료로 고쳐줘' });
  upsertThread(t);
  assert.equal(getThread(t.id)?.documentId, 'doc-stable-1');
  const raw = mem.get('rhwp-agent-threads') ?? '';
  assert.doesNotMatch(raw, /base64|arrayBuffer|blob:/i);

  const stored = JSON.parse(raw) as Array<Record<string, unknown>>;
  delete stored[0]!.documentId;
  mem.set('rhwp-agent-threads', JSON.stringify(stored));
  assert.equal(getThread(t.id)?.documentId, null);
});

test('user message attachment metadata persists without file bytes', () => {
  mem.clear();
  const t = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  t.messages.push({
    role: 'user',
    text: '이 파일을 참고해줘',
    messageId: 'message-1',
    attachments: [{
      stageId: 'stage-1',
      fileId: 'file-1',
      name: '보고서.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      status: 'ready',
    }],
  });
  upsertThread(t);
  const message = getThread(t.id)?.messages[0];
  assert.equal(message?.messageId, 'message-1');
  assert.deepEqual(message?.attachments?.[0], {
    stageId: 'stage-1',
    fileId: 'file-1',
    name: '보고서.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    status: 'ready',
  });
  assert.doesNotMatch(mem.get('rhwp-agent-threads') ?? '', /data:application\/pdf|base64/i);
});

test('listThreadsByDocument groups by document, groups ordered by recent activity', () => {
  mem.clear();
  const mk = (docKey: string | null, text: string, updatedAt: number) => {
    const t = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high', docKey });
    t.messages.push({ role: 'user', text });
    upsertThread(t);
    // upsertThread 가 updatedAt 을 지금으로 찍으므로 저장본을 직접 되감는다.
    const stored = JSON.parse(mem.get('rhwp-agent-threads') ?? '[]') as Array<Record<string, unknown>>;
    stored.find((s) => s.id === t.id)!.updatedAt = updatedAt;
    mem.set('rhwp-agent-threads', JSON.stringify(stored));
    return t;
  };
  mk('a.hwpx', 'a 첫 채팅', 10);
  mk('b.hwpx', 'b 채팅', 30);
  mk('a.hwpx', 'a 최근 채팅', 20);
  mk(null, '문서 없는 채팅', 5);

  const groups = listThreadsByDocument();
  assert.deepEqual(groups.map((g) => g.docKey), ['b.hwpx', 'a.hwpx', null]);
  assert.deepEqual(
    groups[1]!.threads.map((t) => t.messages[0]!.text),
    ['a 최근 채팅', 'a 첫 채팅'],
  );
});

test('workflow and latest plan persist as history without approval authority', () => {
  mem.clear();
  const plan: StructuredPlan = {
    planId: 'plan-1',
    title: '문서 정리',
    goal: '문서 구조 개선',
    summary: '제목과 본문을 정리한다.',
    assumptions: ['원문 의미 유지'],
    decisions: ['제목 체계 통일'],
    steps: [{ title: '제목 수정', details: '제목 스타일을 통일한다.', files: ['report.hwpx'] }],
    files: ['report.hwpx'],
    validation: ['렌더 확인'],
    risks: ['페이지 재배치'],
    exclusions: ['내용 재작성'],
    createdAt: '2026-08-07T00:00:00.000Z',
    epoch: 7,
  };
  const t = createEmptyThread({
    agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', workflow: 'plan',
  });
  t.latestPlan = plan;
  t.messages.push({ role: 'user', text: '계획을 세워줘' });
  upsertThread(t);

  const restored = getThread(t.id);
  assert.equal(restored?.workflow, 'plan');
  assert.deepEqual(restored?.latestPlan, plan);
  const stored = JSON.parse(mem.get('rhwp-agent-threads') ?? '[]') as Array<Record<string, unknown>>;
  assert.equal('phase' in stored[0]!, false);
  assert.equal('capabilityEpoch' in stored[0]!, false);
  assert.equal('approved' in stored[0]!, false);
});

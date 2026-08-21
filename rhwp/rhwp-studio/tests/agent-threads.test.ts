import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createEmptyThread,
  fallbackTitle,
  forgetDocumentThreads,
  getThread,
  explorerGroupIsCurrent,
  listThreads,
  listThreadsByDocument,
  recordDocumentOpened,
  setThreadTitle,
  subscribeThreadChanges,
  threadMatchesDocument,
  upsertThread,
} from '../src/agent/threads.ts';
import type { StructuredPlan } from '../src/agent/types.ts';

const source = readFileSync(new URL('../src/agent/threads.ts', import.meta.url), 'utf8');
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

test('thread persistence notifies the current window without changing the synchronous API', () => {
  mem.clear();
  let changes = 0;
  const unsubscribe = subscribeThreadChanges(() => {
    changes += 1;
  });
  const thread = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  thread.messages.push({ role: 'user', text: 'notify' });
  upsertThread(thread);
  unsubscribe();

  assert.equal(changes, 1);
  assert.equal(listThreads()[0]?.id, thread.id);
});

test('browser persistence uses per-thread IndexedDB records and one-time legacy migration', () => {
  assert.match(source, /createObjectStore\(THREADS_STORE, \{ keyPath: 'id' \}\)/);
  assert.match(source, /store\.put\(cloneThread\(thread\)\)/);
  assert.match(source, /localStorage\.removeItem\(STORAGE_KEY\)/);
  assert.match(source, /new BroadcastChannel\(CHANNEL_NAME\)/);
  assert.match(source, /db\.transaction\(THREADS_STORE, 'readwrite'\)/);
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

test('progress milestones survive thread persistence', () => {
  mem.clear();
  const t = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  t.messages.push(
    { role: 'user', text: '문서를 정리해줘' },
    { role: 'assistant', text: '문서 구조를 확인했습니다. 이제 표를 정리합니다.', agent: 'claude', kind: 'progress' },
  );
  upsertThread(t);
  assert.equal(getThread(t.id)?.messages[1]?.kind, 'progress');
});

test('clickable plan presentations keep their plan identity in thread history', () => {
  mem.clear();
  const t = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', workflow: 'plan' });
  t.messages.push(
    { role: 'user', text: '계획을 세워줘' },
    { role: 'assistant', text: '문서 정리 계획', agent: 'codex', kind: 'plan', planId: 'plan-1' },
  );
  upsertThread(t);
  assert.equal(getThread(t.id)?.messages[1]?.kind, 'plan');
  assert.equal(getThread(t.id)?.messages[1]?.planId, 'plan-1');
  assert.match(source, /if \(message\.kind === 'plan'\)/);
  assert.match(source, /typeof message\.planId !== 'string'/);
});

test('persisted Pi chats remain available after reload', () => {
  mem.clear();
  storage.setItem('rhwp-agent-threads', JSON.stringify([{
    id: 'pi-thread',
    title: 'Pi 대화',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 2,
    agent: 'pi',
    model: 'openrouter/test-model',
    effort: 'medium',
    messages: [{ role: 'user', text: '기존 Pi 메시지' }],
  }]));
  assert.equal(getThread('pi-thread')?.agent, 'pi');
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

test('past chats match their active document by stable ID with a legacy filename fallback', () => {
  assert.equal(threadMatchesDocument(
    { documentId: 'doc-a', docKey: 'old-name.hwpx' },
    'doc-a',
    'new-name.hwpx',
  ), true);
  assert.equal(threadMatchesDocument(
    { documentId: 'doc-a', docKey: 'report.hwpx' },
    'doc-b',
    'report.hwpx',
  ), false);
  assert.equal(threadMatchesDocument(
    { documentId: null, docKey: '보고서.HWPX' },
    'doc-a',
    '보고서.hwpx',
  ), true);
  assert.equal(threadMatchesDocument(
    { documentId: 'doc-a', docKey: 'report.hwpx' },
    null,
    'report.hwpx',
  ), false);
});

test('explorer current badge does not follow a unique filename when the group is identified', () => {
  const groups = [
    { documentId: 'doc-a', docKey: 'report.hwpx' },
    { documentId: 'doc-b', docKey: 'other.hwpx' },
  ];
  assert.equal(
    explorerGroupIsCurrent(groups[0]!, 'fresh-id', 'report.hwpx', groups),
    false,
  );
  assert.equal(
    explorerGroupIsCurrent(groups[1]!, 'fresh-id', 'report.hwpx', groups),
    false,
  );
  assert.equal(
    explorerGroupIsCurrent(groups[0]!, 'doc-a', 'renamed.hwpx', groups),
    true,
  );
});

test('legacy explorer groups still use the unique filename bridge', () => {
  const legacy = [{ documentId: null, docKey: 'report.hwpx' }];
  assert.equal(
    explorerGroupIsCurrent(legacy[0]!, 'fresh-id', 'report.hwpx', legacy),
    true,
  );
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

test('threads persist only the active template stable id', () => {
  mem.clear();
  const t = createEmptyThread({
    agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', activeTemplateId: 'template-stable-id',
  });
  t.messages.push({ role: 'user', text: '이 템플릿으로 정리해줘' });
  upsertThread(t);
  assert.equal(getThread(t.id)?.activeTemplateId, 'template-stable-id');
  const raw = mem.get('rhwp-agent-threads') ?? '';
  assert.doesNotMatch(raw, /contentHash|arrayBuffer|base64|blob:/i);
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

test('document groups hold last-opened order; only reopening a document moves it up', () => {
  mem.clear();
  const mk = (docKey: string, documentId: string, text: string) => {
    const t = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high', docKey, documentId });
    t.messages.push({ role: 'user', text });
    upsertThread(t);
    return t;
  };
  // a → b 순서로 문서를 열었다: b 가 위.
  recordDocumentOpened('doc-a', 'a.hwpx');
  recordDocumentOpened('doc-b', 'b.hwpx');
  const staleA = mk('a.hwpx', 'doc-a', 'a 채팅');
  mk('b.hwpx', 'doc-b', 'b 채팅');
  assert.deepEqual(listThreadsByDocument().map((g) => g.docKey), ['b.hwpx', 'a.hwpx']);

  // a 의 옛 채팅이 다시 움직여도(updatedAt 갱신) 그룹 순서는 그대로다.
  upsertThread(staleA);
  assert.deepEqual(listThreadsByDocument().map((g) => g.docKey), ['b.hwpx', 'a.hwpx']);

  // a 문서를 다시 열어야만 맨 위로 올라온다.
  recordDocumentOpened('doc-a', 'a.hwpx');
  assert.deepEqual(listThreadsByDocument().map((g) => g.docKey), ['a.hwpx', 'b.hwpx']);

  // 기록이 없는 문서(레거시)는 기록된 그룹 뒤에 최근 활동 순서로 남는다.
  mk('c.hwpx', 'doc-c', 'c 채팅');
  assert.deepEqual(listThreadsByDocument().map((g) => g.docKey), ['a.hwpx', 'b.hwpx', 'c.hwpx']);
});

test('listThreadsByDocument splits same filenames when documentId differs', () => {
  mem.clear();
  const left = createEmptyThread({
    agent: 'claude', model: 'sonnet', effort: 'high', docKey: '보고서.hwp', documentId: 'doc-a',
  });
  left.messages.push({ role: 'user', text: '왼쪽' });
  upsertThread(left);
  const right = createEmptyThread({
    agent: 'claude', model: 'sonnet', effort: 'high', docKey: '보고서.hwp', documentId: 'doc-b',
  });
  right.messages.push({ role: 'user', text: '오른쪽' });
  upsertThread(right);

  const groups = listThreadsByDocument();
  assert.equal(groups.length, 2);
  assert.deepEqual(new Set(groups.map((g) => g.documentId)), new Set(['doc-a', 'doc-b']));
  assert.ok(groups.every((g) => g.docKey === '보고서.hwp'));
});

test('forgetDocumentThreads removes only that document group and its open-order record', () => {
  mem.clear();
  const mk = (docKey: string | null, documentId: string | null, text: string) => {
    const t = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high', docKey, documentId });
    t.messages.push({ role: 'user', text });
    upsertThread(t);
    return t;
  };
  recordDocumentOpened('doc-a', 'a.hwpx');
  recordDocumentOpened('doc-b', 'b.hwpx');
  const gone = mk('a.hwpx', 'doc-a', 'a 채팅 1');
  mk('a.hwpx', 'doc-a', 'a 채팅 2');
  const legacy = mk('a.hwpx', null, '레거시 a 채팅');
  const kept = mk('b.hwpx', 'doc-b', 'b 채팅');

  // ID 그룹만 지운다 — 같은 파일명의 레거시 그룹과 다른 문서는 남는다.
  const removed = forgetDocumentThreads('doc-a', 'a.hwpx');
  assert.equal(removed.length, 2);
  assert.ok(removed.includes(gone.id));
  assert.equal(getThread(gone.id), null);
  assert.deepEqual(new Set(listThreads().map((t) => t.id)), new Set([legacy.id, kept.id]));
  const orderAfterId = JSON.parse(mem.get('rhwp-agent-doc-order') ?? '[]') as string[];
  assert.ok(!orderAfterId.includes('id:doc-a'));
  assert.ok(orderAfterId.includes('name:a.hwpx'));

  // 레거시(파일명뿐인) 그룹을 지우면 이름 기록도 함께 사라진다.
  forgetDocumentThreads(null, 'a.hwpx');
  assert.equal(getThread(legacy.id), null);
  assert.deepEqual(listThreads().map((t) => t.id), [kept.id]);
  const orderAfterName = JSON.parse(mem.get('rhwp-agent-doc-order') ?? '[]') as string[];
  assert.ok(!orderAfterName.includes('name:a.hwpx'));
  assert.ok(orderAfterName.includes('id:doc-b'));
});

test('workflow and every presented plan persist as history without approval authority', () => {
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
  const previousPlan: StructuredPlan = { ...plan, planId: 'plan-0', title: '이전 문서 정리' };
  const t = createEmptyThread({
    agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', workflow: 'plan',
  });
  t.latestPlan = plan;
  t.plans = [previousPlan, plan];
  t.messages.push(
    { role: 'user', text: '계획을 세워줘' },
    { role: 'assistant', text: previousPlan.title, kind: 'plan', planId: previousPlan.planId },
    { role: 'assistant', text: plan.title, kind: 'plan', planId: plan.planId, planState: 'executed' },
  );
  upsertThread(t);

  const restored = getThread(t.id);
  assert.equal(restored?.workflow, 'plan');
  assert.deepEqual(restored?.latestPlan, plan);
  assert.deepEqual(restored?.plans, [previousPlan, plan]);
  assert.equal(restored?.messages[2]?.kind, 'plan');
  assert.equal(restored?.messages[2]?.kind === 'plan' ? restored.messages[2].planState : undefined, 'executed');
  const stored = JSON.parse(mem.get('rhwp-agent-threads') ?? '[]') as Array<Record<string, unknown>>;
  assert.equal('phase' in stored[0]!, false);
  assert.equal('capabilityEpoch' in stored[0]!, false);
  assert.equal('approved' in stored[0]!, false);
});

/**
 * 병렬 서브에이전트 편집 리베이스 — 편집 저널(EditJournal) 계약 검증.
 *
 * 서로 다른 문단 범위를 편집하는 형제 에이전트의 stale expectedRevision 쓰기는
 * 좌표만 이동해 통과하고, 같은 문단을 건드리면(overlap) 또는 저널에 없는
 * revision bump 가 끼면(gap: 사용자 편집 등) REVISION_MISMATCH 로 떨어져야 한다.
 * PendingEditManager / AgentToolExecutor / RevisionTracker 는 실제 구현을 쓴다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';
import { RevisionTracker } from '../src/agent/revision.ts';
import { AgentToolError } from '../src/agent/types.ts';
import { EditJournal } from '../src/agent/edit-journal.ts';

interface FakePara { chars: string[] }
const paraOf = (t: string): FakePara => ({ chars: [...t] });

function makeHarness(initial: string[]) {
  let body: FakePara[] = initial.map(paraOf);
  let snapshotId = 0;
  const snapshots = new Map<number, FakePara[]>();
  const clone = (b: FakePara[]): FakePara[] => b.map((p) => ({ chars: [...p.chars] }));
  const okJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ ok: true, ...extra });

  const wasm = {
    getSectionCount: () => 1,
    getParagraphCount: (_s: number) => body.length,
    getParagraphLength: (_s: number, p: number) => body[p].chars.length,
    getTextRange: (_s: number, p: number, off: number, cnt: number) => body[p].chars.slice(off, off + cnt).join(''),
    insertText: (_s: number, p: number, off: number, t: string) => {
      body[p].chars.splice(off, 0, ...t);
      return okJson({ charOffset: off + [...t].length });
    },
    splitParagraph: (_s: number, p: number, off: number) => {
      const cur = body[p];
      body.splice(p, 1, { chars: cur.chars.slice(0, off) }, { chars: cur.chars.slice(off) });
      return okJson();
    },
    splitParagraphLogical(this: { splitParagraph(s: number, p: number, off: number): string }, s: number, p: number, off: number) {
      return this.splitParagraph(s, p, off);
    },
    deleteRange: (_s: number, sp: number, so: number, ep: number, eo: number) => {
      const merged = { chars: [...body[sp].chars.slice(0, so), ...body[ep].chars.slice(eo)] };
      body.splice(sp, ep - sp + 1, merged);
      return { ok: true };
    },
    getCharPropertiesAt: () => ({ charShapeId: 0 }),
    setCharShapeId: () => okJson(),
    applyCharFormat: () => okJson(),
    getParaPropertiesAt: () => ({ paraShapeId: 1 }),
    setParaShapeId: () => okJson(),
    saveSnapshot: () => { const id = ++snapshotId; snapshots.set(id, clone(body)); return id; },
    restoreSnapshot: (id: number) => { body = clone(snapshots.get(id)!); },
    discardSnapshot: (id: number) => { snapshots.delete(id); },
    getSourceFormat: () => 'hwpx',
  };

  const eventBus = new EventBus();
  const inputHandler = {
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    getSelection: () => null,
    executeOperation: () => {},
    prepareSnapshotCapacity: () => {},
  };
  const overlay = { setOps: () => {}, clear: () => {} };
  const pending = new PendingEditManager({
    wasm: wasm as never, eventBus, inputHandler: inputHandler as never,
    canvasView: {} as never, overlay: overlay as never,
  });
  const revision = new RevisionTracker(eventBus);
  const executor = new AgentToolExecutor({
    wasm: wasm as never, inputHandler: inputHandler as never,
    documentState: { isDirty: () => false } as never,
    revision, pending,
  });
  return {
    executor, pending, eventBus,
    revision: () => revision.revision,
    text: (p: number) => body[p].chars.join(''),
    paraCount: () => body.length,
  };
}

async function exec(h: ReturnType<typeof makeHarness>, tool: string, args: Record<string, unknown>) {
  return await h.executor.execute(tool, args, 'claude') as Record<string, unknown>;
}

// ─── EditJournal 단위 계약 ─────────────────────────────────

test('journal: 서로소 범위는 이동량을 누적하고, 겹침/공백은 실패 사유를 구분한다', () => {
  const journal = new EditJournal();
  journal.record(10, 11, { sectionIdx: 0, paraStart: 1, paraEnd: 1, paraDelta: 2 });
  journal.record(11, 12, { sectionIdx: 0, paraStart: 9, paraEnd: 9, paraDelta: 0 });

  // 대상(5..6)보다 앞의 +2 만 반영, 뒤(9)는 무시
  assert.deepEqual(journal.rebase(10, 12, 0, 5, 6), { ok: true, shift: 2 });
  // 다른 섹션 편집은 영향 없음
  journal.record(12, 13, { sectionIdx: 1, paraStart: 0, paraEnd: 0, paraDelta: 5 });
  assert.deepEqual(journal.rebase(10, 13, 0, 5, 6), { ok: true, shift: 2 });
  // 겹침
  assert.deepEqual(journal.rebase(10, 12, 0, 1, 3), { ok: false, shift: 0, reason: 'overlap' });
  // 기록 없는 revision 이 끼면 gap
  assert.deepEqual(journal.rebase(9, 12, 0, 5, 6), { ok: false, shift: 0, reason: 'gap' });
});

test('journal: 대상 범위는 엔트리를 rev 순서로 통과하며 점진 이동한다', () => {
  const journal = new EditJournal();
  // rev 11: 문단 0 에 +1 → 이후 좌표계에서 원래 문단 3 은 4
  journal.record(10, 11, { sectionIdx: 0, paraStart: 0, paraEnd: 0, paraDelta: 1 });
  // rev 12: (이동 후 좌표) 문단 4 를 편집 — 원래 3 을 노리던 쓰기와 겹쳐야 한다
  journal.record(11, 12, { sectionIdx: 0, paraStart: 4, paraEnd: 4, paraDelta: 0 });
  assert.deepEqual(journal.rebase(10, 12, 0, 3, 3), { ok: false, shift: 0, reason: 'overlap' });
});

// ─── 실행기 통합: 병렬 형제 에이전트 시나리오 ─────────────────────

test('rebase: 앞 문단의 삽입(+1)이 뒤 문단을 노린 stale 쓰기를 이동시킨다', async () => {
  const h = makeHarness(['제목', '본문 하나', '본문 둘', '결론']);
  const shared = h.revision(); // 두 에이전트가 같은 revision 을 읽었다

  // 에이전트 A: 문단 0 에 개행 포함 삽입 → 문단 수 +1
  const a = await exec(h, 'insert_text', {
    expectedRevision: shared, sectionIdx: 0, paraIdx: 0, charOffset: 2, text: '!\n부제',
  });
  assert.equal(h.paraCount(), 5);

  // 에이전트 B: 원래 좌표(문단 2 = '본문 둘')로 stale 쓰기 — 자동 리베이스되어야 한다
  const b = await exec(h, 'replace_range', {
    expectedRevision: shared, sectionIdx: 0,
    startParaIdx: 2, startCharOffset: 0, endParaIdx: 2, endCharOffset: 4,
    text: '고친 둘',
  });
  assert.equal(b['rebasedParaShift'], 1);
  assert.equal(h.text(3), '고친 둘'); // '본문 둘'(원래 2번)은 이제 3번
  assert.equal(h.text(1), '부제');
  assert.ok((b['revision'] as number) > (a['revision'] as number) - 1);
});

test('rebase: 앞 범위 삭제(-1)는 뒤 문단 좌표를 당긴다', async () => {
  const h = makeHarness(['가', '나', '다', '라']);
  const shared = h.revision();

  await exec(h, 'delete_range', {
    expectedRevision: shared, sectionIdx: 0,
    startParaIdx: 0, startCharOffset: 0, endParaIdx: 1, endCharOffset: 1,
  });
  assert.equal(h.paraCount(), 3);

  const b = await exec(h, 'insert_text', {
    expectedRevision: shared, sectionIdx: 0, paraIdx: 3, charOffset: 1, text: '!',
  });
  assert.equal(b['rebasedParaShift'], -1);
  assert.equal(h.text(2), '라!');
});

test('rebase: 같은 문단을 노리면 REVISION_MISMATCH (동시 편집 충돌 메시지)', async () => {
  const h = makeHarness(['하나', '둘']);
  const shared = h.revision();

  await exec(h, 'insert_text', {
    expectedRevision: shared, sectionIdx: 0, paraIdx: 1, charOffset: 0, text: 'A',
  });
  await assert.rejects(
    () => exec(h, 'replace_range', {
      expectedRevision: shared, sectionIdx: 0,
      startParaIdx: 1, startCharOffset: 0, endParaIdx: 1, endCharOffset: 1, text: 'B',
    }),
    (e: unknown) => e instanceof AgentToolError
      && e.code === 'REVISION_MISMATCH'
      && /concurrent edit touched/.test(e.message),
  );
});

test('rebase: 저널에 없는 bump(사용자 편집)가 끼면 리베이스하지 않는다', async () => {
  const h = makeHarness(['하나', '둘', '셋']);
  const shared = h.revision();

  // 사용자 편집 — 실행기 저널에 기록되지 않는 revision bump
  h.eventBus.emit('document-mutated', { reason: 'user-typing' } as never);
  await new Promise((resolve) => setTimeout(resolve, 0)); // microtask dedupe 창 종료

  await assert.rejects(
    () => exec(h, 'insert_text', {
      expectedRevision: shared, sectionIdx: 0, paraIdx: 2, charOffset: 0, text: 'X',
    }),
    (e: unknown) => e instanceof AgentToolError
      && e.code === 'REVISION_MISMATCH'
      && !/concurrent edit touched/.test(e.message),
  );
});

test('rebase: 서식(char format)도 서로소 문단이면 통과하고 저널에 남는다', async () => {
  const h = makeHarness(['머리말', '본문입니다', '꼬리말']);
  const shared = h.revision();

  await exec(h, 'insert_text', {
    expectedRevision: shared, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '표지\n',
  });
  const fmt = await exec(h, 'apply_char_format', {
    expectedRevision: shared, sectionIdx: 0, paraIdx: 1, startOffset: 0, endOffset: 3, bold: true,
  });
  assert.equal(fmt['rebasedParaShift'], 1);
  assert.equal(fmt['applied'], true);

  // 서식이 남긴 저널 위로 세 번째 에이전트의 stale 쓰기도 이어진다
  const c = await exec(h, 'insert_text', {
    expectedRevision: shared, sectionIdx: 0, paraIdx: 2, charOffset: 3, text: '!',
  });
  assert.equal(c['rebasedParaShift'], 1);
  assert.equal(h.text(3), '꼬리말!');
});

test('rebase: 정확히 일치하는 revision 은 이동 없이 기존 경로 그대로다', async () => {
  const h = makeHarness(['하나']);
  const r = await exec(h, 'insert_text', {
    expectedRevision: h.revision(), sectionIdx: 0, paraIdx: 0, charOffset: 2, text: '!',
  });
  assert.equal(r['rebasedParaShift'], undefined);
  assert.equal(h.text(0), '하나!');
});

test('rebase: 미래 revision 을 주장하면 즉시 REVISION_MISMATCH', async () => {
  const h = makeHarness(['하나']);
  await assert.rejects(
    () => exec(h, 'insert_text', {
      expectedRevision: h.revision() + 7, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'X',
    }),
    (e: unknown) => e instanceof AgentToolError && e.code === 'REVISION_MISMATCH',
  );
});

/**
 * 고급 문서 도구(replace_all / 각주 / 책갈피 / 개요) — executor + pending 통합 테스트.
 *
 * 가짜 wasm 은 본문 텍스트(코드포인트 단위)와 각주/책갈피 저장소를 흉내 낸다.
 * PendingEditManager / AgentToolExecutor / RevisionTracker 는 실제 구현을 쓴다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';
import { RevisionTracker } from '../src/agent/revision.ts';
import { AgentToolError } from '../src/agent/types.ts';

interface FakePara { chars: string[] }
const paraOf = (t: string): FakePara => ({ chars: [...t] });

function makeHarness(initial: string[]) {
  let body: FakePara[] = initial.map(paraOf);
  interface FakeNote { kind: string; number: number; text: string }
  // 문단별 controls: 각주만 흉내 (controlIdx = 배열 인덱스)
  const notes = new Map<string, FakeNote>(); // "para/ctrl" → note
  let nextCtrl = 0;
  const bookmarks: Array<{ name: string; sec: number; para: number; ctrlIdx: number; charPos: number }> = [];
  let nextBookmarkCtrl = 100;

  let snapshotId = 0;
  interface Snapshot {
    body: FakePara[];
    notes: Map<string, FakeNote>;
    bookmarks: Array<{ name: string; sec: number; para: number; ctrlIdx: number; charPos: number }>;
  }
  const snapshots = new Map<number, Snapshot>();
  const clone = (b: FakePara[]): FakePara[] => b.map((p) => ({ chars: [...p.chars] }));
  // 실제 wasm 스냅샷은 문서 전체를 담는다 — 각주/책갈피도 함께 저장/복원해야
  // approve 의 "미리보기 스냅샷 채택" 경로가 재현된다.
  const takeSnapshot = (): Snapshot => ({
    body: clone(body),
    notes: new Map([...notes].map(([k, v]) => [k, { ...v }])),
    bookmarks: bookmarks.map((b) => ({ ...b })),
  });
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
    deleteRange: (_s: number, sp: number, so: number, ep: number, eo: number) => {
      const merged = { chars: [...body[sp].chars.slice(0, so), ...body[ep].chars.slice(eo)] };
      body.splice(sp, ep - sp + 1, merged);
      return { ok: true };
    },
    getCharPropertiesAt: () => ({ charShapeId: 0 }),
    setCharShapeId: () => okJson(),
    getParaPropertiesAt: () => ({ paraShapeId: 1 }),
    setParaShapeId: () => okJson(),
    saveSnapshot: () => { const id = ++snapshotId; snapshots.set(id, takeSnapshot()); return id; },
    restoreSnapshot: (id: number) => {
      const s = snapshots.get(id)!;
      body = clone(s.body);
      notes.clear();
      for (const [k, v] of s.notes) notes.set(k, { ...v });
      bookmarks.length = 0;
      bookmarks.push(...s.bookmarks.map((b) => ({ ...b })));
    },
    discardSnapshot: (id: number) => { snapshots.delete(id); },
    getSourceFormat: () => 'hwpx',
    get documentDigest() { return 'blake3:advanced-tools-test'; },
    getSelectionRects: () => [],
    pageCount: 0,
    // ── 각주 ──
    insertFootnote: (_s: number, p: number, _off: number) => {
      const ctrl = nextCtrl++;
      notes.set(`${p}/${ctrl}`, { kind: 'footnote', number: notes.size + 1, text: '' });
      return { ok: true, paraIdx: p, controlIdx: ctrl, footnoteNumber: notes.size };
    },
    insertEndnote: (_s: number, p: number, _off: number) => {
      const ctrl = nextCtrl++;
      notes.set(`${p}/${ctrl}`, { kind: 'endnote', number: notes.size + 1, text: '' });
      return { ok: true, paraIdx: p, controlIdx: ctrl, endnoteNumber: notes.size };
    },
    insertTextInFootnote: (_s: number, p: number, ctrl: number, _fp: number, off: number, t: string) => {
      const n = notes.get(`${p}/${ctrl}`);
      if (!n) return { ok: false };
      n.text = n.text.slice(0, off) + t + n.text.slice(off);
      return { ok: true, charOffset: off + [...t].length };
    },
    deleteTextInFootnote: (_s: number, p: number, ctrl: number, _fp: number, off: number, cnt: number) => {
      const n = notes.get(`${p}/${ctrl}`);
      if (!n) return { ok: false };
      const chars = [...n.text];
      const deleted = chars.splice(off, cnt).join('');
      n.text = chars.join('');
      return { ok: true, charOffset: off, deletedText: deleted };
    },
    getFootnoteInfo: (_s: number, p: number, ctrl: number) => {
      const n = notes.get(`${p}/${ctrl}`);
      if (!n) return { ok: false };
      return { ok: true, paraCount: 1, totalTextLen: [...n.text].length, number: n.number, texts: [n.text] };
    },
    deleteFootnote: (_s: number, p: number, ctrl: number) => {
      if (!notes.delete(`${p}/${ctrl}`)) return { ok: false };
      return { ok: true };
    },
    getPageFootnoteInfo: () => null,
    // ── 책갈피 ──
    getBookmarks: () => bookmarks.map((b) => ({ ...b })),
    addBookmark: (sec: number, para: number, off: number, name: string) => {
      if (bookmarks.some((b) => b.name === name)) return { ok: false, error: 'duplicate' };
      bookmarks.push({ name, sec, para, ctrlIdx: nextBookmarkCtrl++, charPos: off });
      return { ok: true };
    },
    deleteBookmark: (_s: number, para: number, ctrlIdx: number) => {
      const i = bookmarks.findIndex((b) => b.para === para && b.ctrlIdx === ctrlIdx);
      if (i < 0) return { ok: false };
      bookmarks.splice(i, 1);
      return { ok: true };
    },
    renameBookmark: (_s: number, para: number, ctrlIdx: number, newName: string) => {
      const b = bookmarks.find((cand) => cand.para === para && cand.ctrlIdx === ctrlIdx);
      if (!b) return { ok: false };
      b.name = newName;
      return { ok: true };
    },
    // ── 개요 ──
    getOutlineStructure: (mode: string) => ({
      mode,
      node_count: 2,
      roots: [{
        level: 1, kind: 'outline', marker: '', heading: '첫 장', section: 0, paragraph: 0,
        children: [{ level: 2, kind: 'outline', marker: '', heading: '첫 절', section: 0, paragraph: 1, children: [] }],
      }],
    }),
  };

  const eventBus = new EventBus();
  const inputHandler = {
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    getSelection: () => null,
    executeOperation: (desc: { kind: string; command?: { execute(w: unknown): void } }) => {
      // record 계열은 이미 execute 된 상태로 온다 — 여기서는 기록만 한다
      void desc;
    },
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
    executor, pending, wasm, eventBus,
    revision: () => revision.revision,
    text: (p: number) => body[p].chars.join(''),
    paraCount: () => body.length,
    notes, bookmarks,
  };
}

async function run(h: ReturnType<typeof makeHarness>, tool: string, args: Record<string, unknown>) {
  return await h.executor.execute(tool, { expectedRevision: h.revision(), ...args }, 'claude');
}

// ─── replace_all ─────────────────────────────────────────

test('replace_all: 같은 문단의 여러 매치가 역순 교체로 전부 정확히 바뀐다', async () => {
  const h = makeHarness(['foo 하나 foo 둘 foo', '다른 문단 foo 끝']);
  const r = await run(h, 'replace_all', { query: 'foo', replacement: 'BARBAR' }) as { replacedCount: number };
  assert.equal(r.replacedCount, 4);
  assert.equal(h.text(0), 'BARBAR 하나 BARBAR 둘 BARBAR');
  assert.equal(h.text(1), '다른 문단 BARBAR 끝');
});

test('replace_all: reject 하면 원문이 그대로 돌아온다', async () => {
  const h = makeHarness(['foo 하나 foo 둘']);
  const r = await run(h, 'replace_all', { query: 'foo', replacement: 'X' }) as { changeSetId: string };
  assert.equal(h.text(0), 'X 하나 X 둘');
  h.pending.reject(r.changeSetId);
  assert.equal(h.text(0), 'foo 하나 foo 둘');
});

test('replace_all: 삭제 마크 내부의 매치는 건너뛰고 개수로 보고한다', async () => {
  const h = makeHarness(['foo 유지 구간 foo 삭제 구간']);
  // "foo 삭제 구간" (8..16) 을 삭제 마크
  h.pending.markDelete('claude', {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 9, endParaIdx: 0, endCharOffset: 16,
  });
  const r = await run(h, 'replace_all', { query: 'foo', replacement: 'X' }) as {
    replacedCount: number; skippedPendingDelete: number;
  };
  assert.equal(r.replacedCount, 1);
  assert.equal(r.skippedPendingDelete, 1);
  assert.equal(h.text(0).startsWith('X 유지'), true);
});

test('replace_all: 빈 replacement 는 전부 삭제한다', async () => {
  const h = makeHarness(['지우기foo좋은foo날']);
  const r = await run(h, 'replace_all', { query: 'foo', replacement: '' }) as { replacedCount: number };
  assert.equal(r.replacedCount, 2);
  assert.equal(h.text(0), '지우기좋은날');
});

// ─── 각주 ─────────────────────────────────────────────────

test('insert_footnote: 적용 즉시 각주가 생기고 reject 로 사라진다', async () => {
  const h = makeHarness(['본문 문단입니다']);
  const r = await run(h, 'insert_footnote', {
    sectionIdx: 0, paraIdx: 0, charOffset: 2, text: '각주 내용',
  }) as { changeSetId: string; anchor: { paraIdx: number; controlIdx: number }; number: number };
  assert.equal(h.notes.size, 1);
  assert.equal(h.notes.get(`${r.anchor.paraIdx}/${r.anchor.controlIdx}`)?.text, '각주 내용');
  h.pending.reject(r.changeSetId);
  assert.equal(h.notes.size, 0);
});

test('insert_footnote: kind=endnote 는 미주로 삽입된다', async () => {
  const h = makeHarness(['본문']);
  const r = await run(h, 'insert_footnote', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '미주 내용', kind: 'endnote',
  }) as { anchor: { paraIdx: number; controlIdx: number } };
  assert.equal(h.notes.get(`${r.anchor.paraIdx}/${r.anchor.controlIdx}`)?.kind, 'endnote');
});

test('edit_footnote: 내용을 교체하고 reject 로 원래 내용이 복원된다', async () => {
  const h = makeHarness(['본문']);
  const ins = await run(h, 'insert_footnote', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '원래 각주',
  }) as { changeSetId: string; anchor: { paraIdx: number; controlIdx: number } };
  h.pending.approve(ins.changeSetId);
  const key = `${ins.anchor.paraIdx}/${ins.anchor.controlIdx}`;
  assert.equal(h.notes.get(key)?.text, '원래 각주');

  const ed = await run(h, 'edit_footnote', {
    sectionIdx: 0, paraIdx: ins.anchor.paraIdx, controlIdx: ins.anchor.controlIdx, text: '고친 각주',
  }) as { changeSetId: string };
  assert.equal(h.notes.get(key)?.text, '고친 각주');
  h.pending.reject(ed.changeSetId);
  assert.equal(h.notes.get(key)?.text, '원래 각주');
});

test('insert_footnote: 줄바꿈이 든 텍스트는 INVALID_ARGS', async () => {
  const h = makeHarness(['본문']);
  await assert.rejects(
    run(h, 'insert_footnote', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '두\n줄' }),
    (e: unknown) => e instanceof AgentToolError && e.code === 'INVALID_ARGS',
  );
});

// ─── 책갈피 ───────────────────────────────────────────────

test('set_bookmark add → list → rename → delete 왕복', async () => {
  const h = makeHarness(['책갈피 놓을 문단']);
  const add = await run(h, 'set_bookmark', {
    op: 'add', name: '서론', sectionIdx: 0, paraIdx: 0, charOffset: 3,
  }) as { changeSetId: string };
  h.pending.approve(add.changeSetId);
  let list = await run(h, 'list_bookmarks', {}) as { bookmarks: Array<{ name: string }> };
  assert.deepEqual(list.bookmarks.map((b) => b.name), ['서론']);

  const rn = await run(h, 'set_bookmark', { op: 'rename', name: '서론', newName: '개요' }) as { changeSetId: string };
  h.pending.approve(rn.changeSetId);
  assert.equal(h.bookmarks[0].name, '개요');

  const del = await run(h, 'set_bookmark', { op: 'delete', name: '개요' }) as { changeSetId: string };
  assert.equal(h.bookmarks.length, 0);
  // reject 로 삭제가 되돌아온다
  h.pending.reject(del.changeSetId);
  assert.equal(h.bookmarks.length, 1);
  assert.equal(h.bookmarks[0].name, '개요');
});

test('set_bookmark: 중복 이름 add 는 BOOKMARK_FAILED', async () => {
  const h = makeHarness(['문단']);
  const a = await run(h, 'set_bookmark', { op: 'add', name: '같은이름', sectionIdx: 0, paraIdx: 0, charOffset: 0 }) as { changeSetId: string };
  h.pending.approve(a.changeSetId);
  await assert.rejects(
    run(h, 'set_bookmark', { op: 'add', name: '같은이름', sectionIdx: 0, paraIdx: 0, charOffset: 1 }),
    (e: unknown) => e instanceof AgentToolError && e.code === 'BOOKMARK_FAILED',
  );
});

// ─── 개요 ─────────────────────────────────────────────────

test('get_outline: 트리를 문단 주소와 함께 반환한다', async () => {
  const h = makeHarness(['첫 장', '첫 절']);
  const r = await h.executor.execute('get_outline', {}, 'claude') as {
    roots: Array<{ heading: string; paraIdx: number; children?: Array<{ heading: string }> }>;
  };
  assert.equal(r.roots[0].heading, '첫 장');
  assert.equal(r.roots[0].paraIdx, 0);
  assert.equal(r.roots[0].children?.[0].heading, '첫 절');
});

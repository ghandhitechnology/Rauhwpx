/**
 * 에이전트 표 셀 텍스트 읽기/편집 (cell 주소 지원) 테스트.
 *
 * - AgentToolExecutor: get_structure 의 tables[], find_text 의 셀 매치,
 *   get_text_range / write 툴의 cell 인자 검증·라우팅
 * - PendingEditManager: 셀 내부 insert/delete/format 의 적용·reject·approve
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { RevisionTracker } from '../src/agent/revision.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { AgentToolError } from '../src/agent/types.ts';
import type { CellAddr } from '../src/agent/types.ts';

// 표 하나(2x2, paraIdx 1 / controlIdx 0)를 가진 가짜 wasm 문서.
// cells[cellIdx] = 셀 내부 문단 텍스트 배열.
function makeCellWasm() {
  const body = ['Intro', '', 'Outro'];
  const cells: string[][] = [['Name'], ['Value'], ['foo'], ['bar', 'baz']];
  const calls: string[] = [];
  const okJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ ok: true, ...extra });
  const wasm = {
    getSectionCount: () => 1,
    getParagraphCount: (_s: number) => body.length,
    getParagraphLength: (_s: number, p: number) => body[p].length,
    getTextRange: (_s: number, p: number, off: number, cnt: number) => body[p].slice(off, off + cnt),
    insertText: (_s: number, p: number, off: number, t: string) => {
      body[p] = body[p].slice(0, off) + t + body[p].slice(off);
      return okJson({ charOffset: off + t.length });
    },
    splitParagraph: (_s: number, p: number, off: number) => {
      const cur = body[p];
      body.splice(p, 1, cur.slice(0, off), cur.slice(off));
      return okJson();
    },
    deleteRange: (_s: number, sp: number, so: number, ep: number, eo: number) => {
      const first = body[sp].slice(0, so);
      const tail = body[ep].slice(eo);
      body.splice(sp, ep - sp + 1, first + tail);
      return { ok: true };
    },
    get pageCount() { return 1; },
    getPageControlLayout: (_pg: number) => ({
      controls: [{ type: 'table', secIdx: 0, paraIdx: 1, controlIdx: 0, x: 0, y: 0, w: 100, h: 50 }],
    }),
    getTableDimensions: (_s: number, para: number, ctrl: number) => {
      if (para !== 1 || ctrl !== 0) throw new Error('표 컨트롤이 없습니다');
      return { rowCount: 2, colCount: 2, cellCount: 4 };
    },
    getCellInfo: (_s: number, _p: number, _c: number, idx: number) => ({
      row: Math.floor(idx / 2), col: idx % 2, rowSpan: 1, colSpan: 1,
    }),
    getCellParagraphCount: (_s: number, _p: number, _c: number, cell: number) => cells[cell].length,
    getCellParagraphLength: (_s: number, _p: number, _c: number, cell: number, cp: number) => cells[cell][cp].length,
    getTextInCell: (_s: number, _p: number, _c: number, cell: number, cp: number, off: number, cnt: number) =>
      cells[cell][cp].slice(off, off + cnt),
    insertTextInCell: (_s: number, _p: number, _c: number, cell: number, cp: number, off: number, t: string) => {
      calls.push('insertTextInCell');
      cells[cell][cp] = cells[cell][cp].slice(0, off) + t + cells[cell][cp].slice(off);
      return okJson({ charOffset: off + t.length });
    },
    splitParagraphInCell: (_s: number, _p: number, _c: number, cell: number, cp: number, off: number) => {
      calls.push('splitParagraphInCell');
      const cur = cells[cell][cp];
      cells[cell].splice(cp, 1, cur.slice(0, off), cur.slice(off));
      return okJson({ cellParaIndex: cp + 1, charOffset: 0 });
    },
    deleteRangeInCell: (
      _s: number, _p: number, _c: number, cell: number,
      sp: number, so: number, ep: number, eo: number,
    ) => {
      calls.push('deleteRangeInCell');
      const first = cells[cell][sp].slice(0, so);
      const tail = cells[cell][ep].slice(eo);
      cells[cell].splice(sp, ep - sp + 1, first + tail);
      return { ok: true, paraIdx: sp, charOffset: so };
    },
    applyCharFormatInCell: (
      _s: number, _p: number, _c: number, _cell: number,
      _cp: number, _so: number, _eo: number, _json: string,
    ) => {
      calls.push('applyCharFormatInCell');
      return okJson();
    },
    getCellCharPropertiesAt: () => ({}),
    getCellParaPropertiesAt: () => ({ pageBreakBefore: false }),
    applyParaFormatInCell: () => okJson(),
    getCharPropertiesAt: () => ({}),
    getParaPropertiesAt: () => ({ pageBreakBefore: false }),
    applyParaFormat: () => okJson(),
    applyCharFormat: () => okJson(),
    setFieldValueByName: () => ({ ok: true }),
    getSourceFormat: () => 'hwpx',
    get documentDigest() { return 'blake3:cell-test'; },
    getFieldList: () => [],
    renderPageSvg: (_pg: number) => '<svg/>',
    getSelectionRects: () => [],
    getSelectionRectsInCell: () => [],
    refreshLayout: () => {},
  };
  return { wasm, body, cells, calls };
}

const CELL_FOO: CellAddr = { paraIdx: 1, controlIdx: 0, cellIdx: 2 }; // 'foo'
const CELL_BARBAZ: CellAddr = { paraIdx: 1, controlIdx: 0, cellIdx: 3 }; // ['bar','baz']

// ─── AgentToolExecutor ──────────────────────────────────────

function makeExecutor(cursor?: Record<string, unknown>) {
  const { wasm, body, cells, calls } = makeCellWasm();
  const bus = new EventBus();
  const revision = new RevisionTracker(bus);
  const pendingCalls: Array<{ method: string; args: unknown[] }> = [];
  const pending = {
    insertText: (agent: string, addr: unknown, text: string) => {
      pendingCalls.push({ method: 'insertText', args: [agent, addr, text] });
      const a = addr as { sectionIdx: number; paraIdx: number; charOffset: number; cell?: CellAddr };
      return {
        changeSetId: 'cs-1',
        insertedRange: {
          sectionIdx: a.sectionIdx, cell: a.cell,
          startParaIdx: a.paraIdx, startCharOffset: a.charOffset,
          endParaIdx: a.paraIdx, endCharOffset: a.charOffset + text.length,
        },
      };
    },
    markDelete: (agent: string, range: unknown) => {
      pendingCalls.push({ method: 'markDelete', args: [agent, range] });
      return { changeSetId: 'cs-1', markedText: 'marked' };
    },
    replaceText: (range: { sectionIdx: number; startParaIdx: number; startCharOffset: number; cell?: CellAddr }, text: string, agent: string) => {
      pendingCalls.push({ method: 'replaceText', args: [range, text, agent] });
      return {
        changeSetId: 'cs-1',
        insertedRange: {
          sectionIdx: range.sectionIdx, cell: range.cell,
          startParaIdx: range.startParaIdx, startCharOffset: range.startCharOffset,
          endParaIdx: range.startParaIdx, endCharOffset: range.startCharOffset + text.length,
        },
      };
    },
    applyCharFormat: (agent: string, range: unknown, format: unknown) => {
      pendingCalls.push({ method: 'applyCharFormat', args: [agent, range, format] });
      return { changeSetId: 'cs-1' };
    },
    setFieldValue: () => ({ changeSetId: 'cs-1', fieldId: 1, oldValue: '', newValue: '' }),
    hasDestructiveTableMark: () => false,
    hasPendingStructureOp: () => false,
    findDeleteMarkContaining: () => null as null | { range: Record<string, number>; text: string },
  };
  const inputHandler = {
    getCursorPosition: () => cursor ?? { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 },
    getSelection: () => null,
  };
  const executor = new AgentToolExecutor({
    wasm: wasm as never,
    inputHandler: inputHandler as never,
    documentState: { isDirty: () => false } as never,
    revision,
    pending: pending as never,
  });
  return { executor, pending, pendingCalls, body, cells, calls };
}

async function expectToolError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AgentToolError, `AgentToolError 기대, 실제: ${e}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`${code} 오류를 기대했지만 성공함`);
}

test('get_structure: 섹션에 tables[] 로 셀 주소와 셀 텍스트가 실린다', async () => {
  const { executor } = makeExecutor();
  const r = (await executor.execute('get_structure', {}, 'claude')) as {
    sections: Array<{ tables?: Array<Record<string, unknown>> }>;
  };
  const tables = r.sections[0].tables;
  assert.ok(tables && tables.length === 1);
  const t = tables[0] as {
    paraIdx: number; controlIdx: number; rowCount: number; colCount: number; cellCount: number;
    cells: Array<{ cellIdx: number; row: number; col: number; paragraphs: Array<{ text: string }> }>;
  };
  assert.equal(t.paraIdx, 1);
  assert.equal(t.controlIdx, 0);
  assert.equal(t.rowCount, 2);
  assert.equal(t.cellCount, 4);
  assert.equal(t.cells[2].paragraphs[0].text, 'foo');
  assert.equal(t.cells[3].paragraphs[1].text, 'baz');
  assert.equal(t.cells[3].row, 1);
  assert.equal(t.cells[3].col, 1);
});

test('find_text: 셀 내부 매치는 cell 주소를 포함한다', async () => {
  const { executor } = makeExecutor();
  const r = (await executor.execute('find_text', { query: 'baz' }, 'claude')) as {
    matches: Array<{ sectionIdx: number; paraIdx: number; charOffset: number; cell?: CellAddr }>;
  };
  assert.equal(r.matches.length, 1);
  const m = r.matches[0];
  assert.deepEqual(m.cell, CELL_BARBAZ);
  assert.equal(m.paraIdx, 1); // 셀 내부 문단 인덱스
  assert.equal(m.charOffset, 0);
});

test('find_text: 본문 매치에는 cell 이 없다', async () => {
  const { executor } = makeExecutor();
  const r = (await executor.execute('find_text', { query: 'Intro' }, 'claude')) as {
    matches: Array<{ cell?: CellAddr }>;
  };
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].cell, undefined);
});

test('get_text_range: cell 인자로 셀 문단을 읽는다', async () => {
  const { executor } = makeExecutor();
  const r = (await executor.execute(
    'get_text_range',
    { sectionIdx: 0, paraIdx: 0, cell: CELL_FOO },
    'claude',
  )) as { text: string; paraLength: number };
  assert.equal(r.text, 'foo');
  assert.equal(r.paraLength, 3);
});

test('insert_text: pending 삭제 마크 내부 지점은 PENDING_DELETE_OVERLAP 으로 거부된다', async () => {
  const { executor, pending, pendingCalls } = makeExecutor();
  pending.findDeleteMarkContaining = () => ({
    range: { startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 3 },
    text: 'foo',
  });
  await expectToolError(
    executor.execute(
      'insert_text',
      { expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 1, text: 'X' },
      'claude',
    ),
    'PENDING_DELETE_OVERLAP',
  );
  assert.equal(pendingCalls.length, 0, '가드에 걸리면 pending 에 도달하지 않아야 한다');
});

test('insert_text: cell 인자가 pending 으로 전달된다', async () => {
  const { executor, pendingCalls } = makeExecutor();
  await executor.execute(
    'insert_text',
    { expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 3, cell: CELL_FOO, text: 'X' },
    'claude',
  );
  assert.equal(pendingCalls.length, 1);
  const addr = pendingCalls[0].args[1] as { cell?: CellAddr };
  assert.deepEqual(addr.cell, CELL_FOO);
});

test('replace_range: 원자적 replaceText op 에 cell 이 그대로 전달된다', async () => {
  const { executor, pendingCalls } = makeExecutor();
  await executor.execute(
    'replace_range',
    {
      expectedRevision: 1, sectionIdx: 0, cell: CELL_FOO,
      startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 3, text: 'new',
    },
    'claude',
  );
  // markDelete + insertText 조합이 아니라 단일 원자적 op 이다
  assert.equal(pendingCalls.length, 1);
  assert.equal(pendingCalls[0].method, 'replaceText');
  const range = pendingCalls[0].args[0] as { cell?: CellAddr };
  assert.deepEqual(range.cell, CELL_FOO);
});

test('cell 검증: 표가 없는 문단/범위 밖 cellIdx/범위 밖 오프셋 → INVALID_ARGS', async () => {
  const { executor } = makeExecutor();
  await expectToolError(
    executor.execute('get_text_range', {
      sectionIdx: 0, paraIdx: 0, cell: { paraIdx: 0, controlIdx: 0, cellIdx: 0 },
    }, 'claude'),
    'INVALID_ARGS',
  );
  await expectToolError(
    executor.execute('get_text_range', {
      sectionIdx: 0, paraIdx: 0, cell: { paraIdx: 1, controlIdx: 0, cellIdx: 9 },
    }, 'claude'),
    'INVALID_ARGS',
  );
  await expectToolError(
    executor.execute('get_text_range', {
      sectionIdx: 0, paraIdx: 0, charOffset: 4, cell: CELL_FOO,
    }, 'claude'),
    'INVALID_ARGS',
  );
});

// ─── PendingEditManager (셀 내부 편집 수명주기) ──────────────

function makeManager() {
  const { wasm, body, cells, calls } = makeCellWasm();
  let snapshotId = 0;
  const snapshots = new Map<number, { body: string[]; cells: string[][] }>();
  Object.assign(wasm, {
    saveSnapshot: () => {
      const id = ++snapshotId;
      snapshots.set(id, { body: structuredClone(body), cells: structuredClone(cells) });
      return id;
    },
    restoreSnapshot: (id: number) => {
      const saved = snapshots.get(id)!;
      body.splice(0, body.length, ...structuredClone(saved.body));
      cells.splice(0, cells.length, ...structuredClone(saved.cells));
    },
    discardSnapshot: (id: number) => { snapshots.delete(id); },
  });
  const eventBus = new EventBus();
  const inputHandler = {
    executeOperation: (op: { operation?: (w: unknown) => unknown }) => { op.operation?.(wasm); },
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
  };
  const overlay = { setOps: () => {}, clear: () => {} };
  const mgr = new PendingEditManager({
    wasm: wasm as never,
    eventBus,
    inputHandler: inputHandler as never,
    canvasView: {} as never,
    overlay: overlay as never,
  });
  return { mgr, body, cells, calls };
}

test('pending: 셀 삽입은 insertTextInCell 로 적용되고 reject 시 되돌아간다', () => {
  const { mgr, cells, calls } = makeManager();
  const r = mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 3, cell: CELL_FOO }, 'X');
  assert.ok(calls.includes('insertTextInCell'));
  assert.equal(cells[2][0], 'fooX');
  assert.deepEqual(r.insertedRange.cell, CELL_FOO);
  mgr.reject(r.changeSetId);
  assert.ok(calls.includes('deleteRangeInCell'));
  assert.equal(cells[2][0], 'foo');
});

test('pending: 셀 멀티라인 삽입은 splitParagraphInCell 을 쓰고 reject 시 복원된다', () => {
  const { mgr, cells, calls } = makeManager();
  const r = mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 3, cell: CELL_BARBAZ }, 'A\nB');
  assert.ok(calls.includes('splitParagraphInCell'));
  assert.deepEqual(cells[3], ['barA', 'B', 'baz']);
  assert.equal(r.insertedRange.endParaIdx, 1);
  assert.equal(r.insertedRange.endCharOffset, 1);
  mgr.reject(r.changeSetId);
  assert.deepEqual(cells[3], ['bar', 'baz']);
});

test('pending: 셀 삽입 approve 는 미리보기 텍스트를 재삽입 없이 확정한다', () => {
  const { mgr, cells, calls } = makeManager();
  const r = mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 0, cell: CELL_FOO }, 'Y');
  assert.equal(cells[2][0], 'Yfoo');
  assert.equal(calls.filter((call) => call === 'insertTextInCell').length, 1);
  mgr.approve(r.changeSetId);
  assert.equal(cells[2][0], 'Yfoo');
  assert.equal(calls.filter((call) => call === 'insertTextInCell').length, 1);
  assert.equal(mgr.hasPending(), false);
});

test('pending: 셀 delete 마크는 셀 텍스트를 캡처하고 approve 시 삭제한다', () => {
  const { mgr, cells } = makeManager();
  const r = mgr.markDelete('claude', {
    sectionIdx: 0, cell: CELL_FOO,
    startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 3,
  });
  assert.equal(r.markedText, 'foo');
  assert.equal(cells[2][0], 'foo'); // 마크만, 아직 삭제 아님
  mgr.approve(r.changeSetId);
  assert.equal(cells[2][0], '');
});

test('pending: 셀 서식은 applyCharFormatInCell 로 적용된다', () => {
  const { mgr, calls } = makeManager();
  const r = mgr.applyCharFormat('claude', {
    sectionIdx: 0, cell: CELL_FOO,
    startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 3,
  }, { bold: true });
  assert.equal(calls.filter((call) => call === 'applyCharFormatInCell').length, 1);
  mgr.approve(r.changeSetId);
  assert.equal(mgr.hasPending(), false);
});

test('pending: 본문 문단 추가 삽입이 표 앞이면 셀 op 의 부모 문단 인덱스가 이동한다', () => {
  const { mgr, cells } = makeManager();
  const cellOp = mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 3, cell: CELL_FOO }, 'Z');
  // 표(paraIdx 1) 앞의 본문 문단 0 에 멀티라인 삽입 → 문단 1개 추가
  mgr.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 5 }, 'a\nb');
  const sets = mgr.getChangeSets();
  const op = sets.flatMap((s) => s.ops).find(
    (o) => (o.kind === 'insert') && o.range.cell !== undefined,
  )!;
  assert.equal(op.range.cell!.paraIdx, 2); // 1 → 2 로 이동
  // reject 는 이동한 주소 기준으로도 성공해야 한다
  mgr.reject(cellOp.changeSetId);
  assert.equal(cells[2][0], 'foo');
});

// ─── get_selection: 중첩 표 좌표 축 혼용 방지 ─────────────────

test('get_selection: 1중첩(깊이 1) 셀은 기존대로 write 가능한 cell 주소를 준다', async () => {
  const { executor } = makeExecutor({
    sectionIndex: 0, paragraphIndex: 1, charOffset: 2,
    parentParaIndex: 1, controlIndex: 0, cellIndex: 2, cellParaIndex: 0,
    cellPath: [{ parentParaIndex: 1, controlIndex: 0, cellIndex: 2, cellParaIndex: 0 }],
  });
  const r = (await executor.execute('get_selection', {}, 'claude')) as {
    cursor: { cell?: unknown; paraIdx: number; charOffset: number; nested?: boolean };
    nested?: boolean;
  };
  assert.deepEqual(r.cursor.cell, { paraIdx: 1, controlIdx: 0, cellIdx: 2 });
  assert.equal(r.cursor.paraIdx, 0);
  assert.equal(r.cursor.charOffset, 2);
  assert.equal(r.cursor.nested, undefined);
  assert.equal(r.nested, undefined);
});

test('get_selection: 중첩 표(깊이 2)에서는 cell 주소를 생략하고 nested/cellPath 로 알린다', async () => {
  const path = [
    { parentParaIndex: 1, controlIndex: 0, cellIndex: 2, cellParaIndex: 0 },
    { parentParaIndex: 0, controlIndex: 0, cellIndex: 3, cellParaIndex: 1 },
  ];
  const { executor } = makeExecutor({
    sectionIndex: 0, paragraphIndex: 1, charOffset: 4,
    parentParaIndex: 1, controlIndex: 0, cellIndex: 2, cellParaIndex: 0,
    cellPath: path,
  });
  const r = (await executor.execute('get_selection', {}, 'claude')) as {
    cursor: { cell?: unknown; paraIdx: number; charOffset: number; nested?: boolean; cellPath?: unknown };
    nested?: boolean; note?: string;
  };
  assert.equal(r.cursor.cell, undefined); // 최외곽 셀 주소 + 최내곽 문단 인덱스 혼용 금지
  assert.equal(r.cursor.nested, true);
  assert.equal(r.cursor.paraIdx, 1); // 최내곽 셀 문단
  assert.equal(r.cursor.charOffset, 4);
  assert.deepEqual(r.cursor.cellPath, path);
  assert.equal(r.nested, true);
  assert.ok(r.note && r.note.includes('get_structure'));
});

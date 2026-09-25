/**
 * 객체 op 의 오버레이 분류(insert/modify/remove)와 삭제 내용 보관 테스트.
 * 가짜 wasm 위에서 addObjectOp → overlay.setOps 경로를 검증한다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventBus } from '../src/core/event-bus.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { objectOverlayKind, type ObjectOp } from '../src/agent/types.ts';
import type { OverlayOp } from '../src/agent/pending-overlay.ts';

interface FakeTable {
  paraIdx: number;
  controlIdx: number;
  rows: number;
  cols: number;
  cells: string[][];
}

function makeEnv(headerFooterExists = true) {
  const body = ['첫 문단', '표가 있는 문단', '마지막'];
  const tables: FakeTable[] = [{
    paraIdx: 1, controlIdx: 0, rows: 2, cols: 2,
    cells: [['r1c1'], ['r1c2'], ['r2c1'], ['r2c2']],
  }];
  let lastOps: OverlayOp[] = [];
  const find = (p: number, c: number): FakeTable => {
    const t = tables.find((x) => x.paraIdx === p && x.controlIdx === c);
    if (!t) throw new Error(`표 없음 @${p}/${c}`);
    return t;
  };
  const okJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ ok: true, ...extra });

  const wasm = {
    getSectionCount: () => 1,
    getParagraphCount: () => body.length,
    getParagraphLength: (_s: number, p: number) => body[p].length,
    getTextRange: (_s: number, p: number, off: number, cnt: number) => body[p].slice(off, off + cnt),
    get pageCount() { return 1; },
    refreshLayout: () => {},
    get documentDigest() { return 'blake3:kinds'; },
    // 표
    createTableEx: (opts: { paraIdx: number; rowCount: number; colCount: number }) => {
      const controlIdx = tables.filter((t) => t.paraIdx === opts.paraIdx).length;
      tables.push({
        paraIdx: opts.paraIdx, controlIdx,
        rows: opts.rowCount, cols: opts.colCount,
        cells: Array.from({ length: opts.rowCount * opts.colCount }, () => ['']),
      });
      return { ok: true, paraIdx: opts.paraIdx, controlIdx };
    },
    insertTextInCell: (_s: number, p: number, c: number, cell: number, cp: number, off: number, text: string) => {
      const t = find(p, c);
      t.cells[cell][cp] = t.cells[cell][cp].slice(0, off) + text + t.cells[cell][cp].slice(off);
      return okJson({ charOffset: off + text.length });
    },
    getTableDimensions: (_s: number, p: number, c: number) => {
      const t = find(p, c);
      return { rowCount: t.rows, colCount: t.cols, cellCount: t.cells.length };
    },
    getCellInfo: (_s: number, p: number, c: number, i: number) => {
      const t = find(p, c);
      return { row: Math.floor(i / t.cols), col: i % t.cols, rowSpan: 1, colSpan: 1 };
    },
    getCellParagraphCount: () => 1,
    getCellParagraphLength: (_s: number, p: number, c: number, i: number, cp: number) => find(p, c).cells[i][cp].length,
    getTextInCell: (_s: number, p: number, c: number, i: number, cp: number, off: number, cnt: number) =>
      find(p, c).cells[i][cp].slice(off, off + cnt),
    getTableCellBboxes: (_s: number, p: number, c: number) => find(p, c).cells.map((_, i) => ({
      cellIdx: i, row: Math.floor(i / find(p, c).cols), col: i % find(p, c).cols,
      rowSpan: 1, colSpan: 1, pageIndex: 0, x: i * 10, y: 0, w: 10, h: 10,
    })),
    getControlTextPositions: (_s: number, p: number) =>
      tables.filter((t) => t.paraIdx === p).map(() => 4),
    insertTableRow: (_s: number, p: number, c: number, rowIdx: number, below: boolean) => {
      const t = find(p, c);
      const at = (below ? rowIdx + 1 : rowIdx) * t.cols;
      t.cells.splice(at, 0, ...Array.from({ length: t.cols }, () => ['']));
      t.rows += 1;
      return { ok: true, rowCount: t.rows, colCount: t.cols };
    },
    deleteTableRow: (_s: number, p: number, c: number, rowIdx: number) => {
      const t = find(p, c);
      t.cells.splice(rowIdx * t.cols, t.cols);
      t.rows -= 1;
      return { ok: true, rowCount: t.rows, colCount: t.cols };
    },
    deleteTableColumn: (_s: number, p: number, c: number, colIdx: number) => {
      const t = find(p, c);
      for (let r = t.rows - 1; r >= 0; r--) t.cells.splice(r * t.cols + colIdx, 1);
      t.cols -= 1;
      return { ok: true, rowCount: t.rows, colCount: t.cols };
    },
    mergeTableCells: (_s: number, p: number, c: number) => ({ ok: true, cellCount: find(p, c).cells.length }),
    deleteTableControl: (_s: number, p: number, c: number) => {
      const i = tables.findIndex((t) => t.paraIdx === p && t.controlIdx === c);
      if (i < 0) return { ok: false };
      tables.splice(i, 1);
      return { ok: true };
    },
    setCellProperties: () => ({ ok: true }),
    // 문단/머리말/쪽
    getParaPropertiesAt: () => ({ paraShapeId: 3, alignment: 'left' }),
    applyParaFormat: () => okJson(),
    getHeaderFooter: () => JSON.stringify({ exists: headerFooterExists, paraIndex: 0 }),
    getHeaderFooterParaInfo: () => JSON.stringify({ ok: true, paraCount: 1, charCount: 5 }),
    deleteTextInHeaderFooter: () => {},
    insertTextInHeaderFooter: () => okJson(),
    replaceRangeInHeaderFooter: () => ({ ok: true, hfParaIndex: 0, charOffset: 0 }),
    createHeaderFooter: () => okJson(),
    deleteHeaderFooter: () => {},
    applyParaFormatInHf: () => okJson(),
    setPageDef: () => ({ ok: true }),
    // 문단 보관본
    captureParagraph: () => 7,
    discardParagraphCapture: () => {},
    getParagraphContentDigest: () => 'digest',
  };

  const pending = new PendingEditManager({
    wasm: wasm as never,
    eventBus: new EventBus(),
    inputHandler: {} as never,
    canvasView: {} as never,
    overlay: { setOps: (ops: OverlayOp[]) => { lastOps = ops; }, clear: () => { lastOps = []; } } as never,
  });
  return { pending, tables, ops: () => lastOps };
}

const dims = { rowCount: 2, colCount: 2 };
const tableAt = { sectionIdx: 0, tableParaIdx: 1, controlIdx: 0 };

// ─── objectOverlayKind 분류 ─────────────────────────────

test('objectOverlayKind maps every object op to insert, modify, or remove', () => {
  const table = { sectionIdx: 0, tableParaIdx: 1, controlIdx: 0, dims };
  const cases: Array<[ObjectOp, 'insert' | 'modify' | 'remove']> = [
    [{ type: 'createTable', sectionIdx: 0, paraIdx: 0, charOffset: 0, rows: 2, cols: 2, headerRow: false, headerBold: false }, 'insert'],
    [{ type: 'insertImage', sectionIdx: 0, paraIdx: 0, charOffset: 0, bytes: new Uint8Array(), extension: 'png', widthHu: 1, heightHu: 1, naturalWidthPx: 1, naturalHeightPx: 1, description: '' }, 'insert'],
    [{ type: 'insertEquation', sectionIdx: 0, paraIdx: 0, charOffset: 0, script: 'x', fontSizeHu: 0, colorRef: 0 }, 'insert'],
    [{ type: 'insertNote', noteKind: 'footnote', sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 't' }, 'insert'],
    [{ type: 'tableStructure', ...table, op: 'insert_row', index: 0, after: true }, 'insert'],
    [{ type: 'tableStructure', ...table, op: 'insert_col', index: 0, after: false }, 'insert'],
    [{ type: 'tableStructure', ...table, op: 'merge_cells', startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, 'modify'],
    [{ type: 'tableStructure', ...table, op: 'split_cell', rowIdx: 0, colIdx: 0, splitRows: 1, splitCols: 2 }, 'modify'],
    [{ type: 'tableStructure', ...table, op: 'delete_row', rowIdx: 1 }, 'remove'],
    [{ type: 'tableStructure', ...table, op: 'delete_col', colIdx: 0 }, 'remove'],
    [{ type: 'deleteTable', ...table }, 'remove'],
    [{ type: 'setCellProps', ...table, cellIdx: 0, props: {} }, 'modify'],
    [{ type: 'setTableProps', ...table, props: {} }, 'modify'],
    [{ type: 'setColumnWidths', ...table, widthsHu: [1, 1] }, 'modify'],
    [{ type: 'fitToPage', ...table }, 'modify'],
    [{ type: 'setZoneProps', ...table, range: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, props: {} }, 'modify'],
    [{ type: 'applyFormula', ...table, row: 0, col: 0, formula: 'sum(1)' }, 'modify'],
    [{ type: 'setCaption', ...table, text: 't', withNumber: false }, 'modify'],
    [{ type: 'paraFormat', sectionIdx: 0, paraIdx: 0, propsJson: '{}', prevParaShapeId: 1, charOffset: 0 }, 'modify'],
    [{ type: 'applyStyle', sectionIdx: 0, paraIdx: 0, styleId: 3, charOffset: 0 }, 'modify'],
    [{ type: 'pageLayout', sectionIdx: 0 }, 'modify'],
    [{ type: 'headerFooter', sectionIdx: 0, isHeader: true, applyTo: 0, text: 't', existedBefore: true }, 'modify'],
    [{ type: 'headerFooter', sectionIdx: 0, isHeader: false, applyTo: 0, text: 't', existedBefore: false }, 'insert'],
    [{ type: 'setNoteText', sectionIdx: 0, paraIdx: 0, controlIdx: 0, text: 't' }, 'modify'],
    [{ type: 'bookmark', op: 'add', sectionIdx: 0, paraIdx: 0, charOffset: 0, name: 'b' }, 'insert'],
    [{ type: 'bookmark', op: 'rename', sectionIdx: 0, paraIdx: 0, ctrlIdx: 0, name: 'b' }, 'modify'],
    [{ type: 'bookmark', op: 'delete', sectionIdx: 0, paraIdx: 0, ctrlIdx: 0 }, 'remove'],
  ];
  for (const [obj, expected] of cases) {
    assert.equal(objectOverlayKind(obj), expected, `${obj.type} (${'op' in obj ? obj.op : ''})`);
  }
});

// ─── addObjectOp → overlay ops ──────────────────────────

test('새 표·행 삽입과 속성 변경은 insert/modify 마커로 보낸다', () => {
  const { pending, ops } = makeEnv();
  pending.addObjectOp('codex', {
    type: 'createTable', sectionIdx: 0, paraIdx: 2, charOffset: 0,
    rows: 2, cols: 2, headerRow: false, headerBold: false,
  });
  assert.deepEqual(ops().map((op) => [op.kind, op.objRef?.sort]), [['insert', 'table']]);

  pending.addObjectOp('codex', { type: 'tableStructure', ...tableAt, op: 'insert_row', index: 0, after: true });
  const insert = ops().at(-1)!;
  assert.equal(insert.kind, 'insert');
  assert.deepEqual(insert.objRef, { sort: 'cells', sectionIdx: 0, paraIdx: 1, controlIdx: 0, rowIdx: 1 });

  pending.addObjectOp('codex', { type: 'setCellProps', ...tableAt, cellIdx: 0, props: {}, dims: { rowCount: 3, colCount: 2 } });
  const modify = ops().at(-1)!;
  assert.equal(modify.kind, 'modify');
  assert.equal(modify.objRef?.sort, 'cells');
  assert.equal(modify.removedText, undefined);
});

test('행/열 삭제는 지워진 자리 앵커와 내용을 remove 로 보낸다', () => {
  const { pending, ops } = makeEnv();
  pending.addObjectOp('codex', { type: 'tableStructure', ...tableAt, op: 'delete_row', rowIdx: 1 });
  const op = ops().at(-1)!;
  assert.equal(op.kind, 'remove');
  assert.deepEqual(op.objRef, {
    sort: 'removed', what: 'row', sectionIdx: 0, paraIdx: 1, controlIdx: 0, rowIdx: 1, colIdx: undefined,
  });
  assert.equal(op.removedText, 'r2c1 | r2c2');

  pending.addObjectOp('codex', { type: 'tableStructure', ...tableAt, op: 'delete_col', colIdx: 0 });
  const col = ops().at(-1)!;
  assert.equal(col.kind, 'remove');
  assert.equal(col.objRef?.sort, 'removed');
  assert.equal(col.objRef?.sort === 'removed' && col.objRef.what, 'col');
  assert.equal(col.removedText, 'r1c1');
});

test('표 삭제는 삭제 전 내용과 문단 오프셋을 보관해 remove 앵커로 보낸다', () => {
  const { pending, ops } = makeEnv();
  pending.addObjectOp('codex', { type: 'deleteTable', ...tableAt, dims });
  const op = ops().at(-1)!;
  assert.equal(op.kind, 'remove');
  assert.deepEqual(op.objRef, {
    sort: 'removed', what: 'table', sectionIdx: 0, paraIdx: 1, controlIdx: 0, offset: 4,
  });
  assert.equal(op.removedText, 'r1c1 | r1c2\nr2c1 | r2c2');
});

test('기존 머리말·쪽 설정 변경은 modify 마커를, 새 머리말은 insert 를 보낸다', () => {
  const { pending, ops } = makeEnv();
  pending.addObjectOp('codex', {
    type: 'headerFooter', sectionIdx: 0, isHeader: true, applyTo: 0,
    lines: ['새 머리말'], existedBefore: true,
  });
  let op = ops().at(-1)!;
  assert.equal(op.kind, 'modify');
  assert.deepEqual(op.objRef, { sort: 'hf', sectionIdx: 0, isHeader: true, applyTo: 0 });

  pending.addObjectOp('codex', { type: 'pageLayout', sectionIdx: 0, pageDef: { next: {}, prev: {} } });
  op = ops().at(-1)!;
  assert.equal(op.kind, 'modify');
  assert.deepEqual(op.objRef, { sort: 'page', sectionIdx: 0 });

  const fresh = makeEnv(false);
  fresh.pending.addObjectOp('codex', {
    type: 'headerFooter', sectionIdx: 0, isHeader: false, applyTo: 0,
    lines: ['새 꼬리말'], existedBefore: false,
  });
  op = fresh.ops().at(-1)!;
  assert.equal(op.kind, 'insert');
  assert.equal(op.objRef?.sort, 'hf');
});

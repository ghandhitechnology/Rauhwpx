/**
 * 에이전트 객체 연산 (Phase 2: 표 생성/구조 변경, 문단 서식, 스타일, 폰트) 테스트.
 *
 * executor → 실제 PendingEditManager → 가짜 wasm 통합 경로로
 * apply / reject(역연산) / approve(미리보기 채택) / 가드 / 좌표 이동을 검증한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { RevisionTracker } from '../src/agent/revision.ts';
import { AgentToolExecutor, mmToHu } from '../src/agent/tool-executor.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { AgentToolError } from '../src/agent/types.ts';

interface FakeTable {
  paraIdx: number;
  controlIdx: number;
  rows: number;
  cols: number;
  /** flat cellIdx → 셀 문단 텍스트 배열 */
  cells: string[][];
  cellProps: Array<Record<string, unknown>>;
  tableProps: Record<string, unknown>;
}

function makeEnv() {
  const body = ['Title', 'Second paragraph with text', ''];
  const bodyParaShapes = [10, 11, 12];
  const tables: FakeTable[] = [];
  const calls: Array<{ m: string; a: unknown[] }> = [];
  const fonts = ['바탕'];
  const record = (m: string, ...a: unknown[]) => { calls.push({ m, a }); };
  const okJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ ok: true, ...extra });

  const findTable = (para: number, ctrl: number): FakeTable => {
    const t = tables.find((x) => x.paraIdx === para && x.controlIdx === ctrl);
    if (!t) throw new Error(`표 없음 @${para}/${ctrl}`);
    return t;
  };

  const wasm = {
    // ─ 본문 ─
    getSectionCount: () => 1,
    getParagraphCount: () => body.length,
    getParagraphLength: (_s: number, p: number) => body[p].length,
    getTextRange: (_s: number, p: number, off: number, cnt: number) => body[p].slice(off, off + cnt),
    insertText: (_s: number, p: number, off: number, t: string) => {
      body[p] = body[p].slice(0, off) + t + body[p].slice(off);
      return okJson();
    },
    splitParagraph: (_s: number, p: number, off: number) => {
      const cur = body[p];
      body.splice(p, 1, cur.slice(0, off), cur.slice(off));
      bodyParaShapes.splice(p, 1, bodyParaShapes[p], bodyParaShapes[p]);
      for (const t of tables) if (t.paraIdx > p) t.paraIdx += 1;
      return okJson();
    },
    splitParagraphLogical(this: any, s: number, p: number, off: number) {
      return this.splitParagraph(s, p, off);
    },
    deleteRange: (_s: number, sp: number, so: number, ep: number, eo: number) => {
      const removed = ep - sp;
      body.splice(sp, ep - sp + 1, body[sp].slice(0, so) + body[ep].slice(eo));
      bodyParaShapes.splice(sp + 1, removed);
      for (const t of tables) if (t.paraIdx > ep) t.paraIdx -= removed;
      return { ok: true };
    },
    get pageCount() { return 1; },
    getPageControlLayout: () => ({
      controls: tables.map((t) => ({ type: 'table', secIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx, x: 0, y: 0, w: 10, h: 10 })),
    }),
    // ─ 표 ─
    createTableEx: (opts: {
      sectionIdx: number; paraIdx: number; charOffset: number;
      rowCount: number; colCount: number; treatAsChar?: boolean; colWidths?: number[];
    }) => {
      record('createTableEx', opts);
      if (opts.treatAsChar !== true) throw new Error('테스트는 treatAsChar 경로만 허용');
      const controlIdx = tables.filter((t) => t.paraIdx === opts.paraIdx).length;
      tables.push({
        paraIdx: opts.paraIdx, controlIdx,
        rows: opts.rowCount, cols: opts.colCount,
        cells: Array.from({ length: opts.rowCount * opts.colCount }, () => ['']),
        cellProps: Array.from({ length: opts.rowCount * opts.colCount }, () => ({})),
        tableProps: {},
      });
      return { ok: true, paraIdx: opts.paraIdx, controlIdx };
    },
    deleteTableControl: (_s: number, para: number, ctrl: number) => {
      record('deleteTableControl', para, ctrl);
      const i = tables.findIndex((t) => t.paraIdx === para && t.controlIdx === ctrl);
      if (i < 0) return { ok: false };
      tables.splice(i, 1);
      return { ok: true };
    },
    getTableDimensions: (_s: number, para: number, ctrl: number) => {
      const t = findTable(para, ctrl);
      return { rowCount: t.rows, colCount: t.cols, cellCount: t.cells.length };
    },
    getTableProperties: (_s: number, para: number, ctrl: number) => ({
      cellSpacing: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
      pageBreak: 0, repeatHeader: false, tableWidth: 42520, tableHeight: 5000,
      outerLeft: 0, outerRight: 0, outerTop: 0, outerBottom: 0,
      treatAsChar: true, textWrap: 'TopAndBottom', vertRelTo: 'Para', vertAlign: 'Top',
      horzRelTo: 'Column', horzAlign: 'Left', vertOffset: 0, horzOffset: 0,
      restrictInPage: true, allowOverlap: false, keepWithAnchor: true, hasCaption: false,
      ...findTable(para, ctrl).tableProps,
    }),
    getCellProperties: (_s: number, para: number, ctrl: number, cell: number) => ({
      width: 21260, height: 2500, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
      applyInnerMargin: false, verticalAlign: 0, textDirection: 0, isHeader: false,
      cellProtect: false, editableInForm: false, fieldName: '',
      ...findTable(para, ctrl).cellProps[cell],
    }),
    getCellInfo: (_s: number, para: number, ctrl: number, idx: number) => {
      const t = findTable(para, ctrl);
      return { row: Math.floor(idx / t.cols), col: idx % t.cols, rowSpan: 1, colSpan: 1 };
    },
    getCellParagraphCount: (_s: number, para: number, ctrl: number, cell: number) =>
      findTable(para, ctrl).cells[cell].length,
    getCellParagraphLength: (_s: number, para: number, ctrl: number, cell: number, cp: number) =>
      findTable(para, ctrl).cells[cell][cp].length,
    getTextInCell: (_s: number, para: number, ctrl: number, cell: number, cp: number, off: number, cnt: number) =>
      findTable(para, ctrl).cells[cell][cp].slice(off, off + cnt),
    insertTextInCell: (_s: number, para: number, ctrl: number, cell: number, cp: number, off: number, t: string) => {
      const ft = findTable(para, ctrl);
      ft.cells[cell][cp] = ft.cells[cell][cp].slice(0, off) + t + ft.cells[cell][cp].slice(off);
      return okJson({ charOffset: off + t.length });
    },
    splitParagraphInCell: (_s: number, para: number, ctrl: number, cell: number, cp: number, off: number) => {
      const ft = findTable(para, ctrl);
      const cur = ft.cells[cell][cp];
      ft.cells[cell].splice(cp, 1, cur.slice(0, off), cur.slice(off));
      return okJson();
    },
    splitParagraphInCellLogical(this: any, s: number, para: number, ctrl: number, cell: number, cp: number, off: number) {
      return this.splitParagraphInCell(s, para, ctrl, cell, cp, off);
    },
    deleteRangeInCell: (_s: number, para: number, ctrl: number, cell: number, sp: number, so: number, ep: number, eo: number) => {
      const ft = findTable(para, ctrl);
      ft.cells[cell].splice(sp, ep - sp + 1, ft.cells[cell][sp].slice(0, so) + ft.cells[cell][ep].slice(eo));
      return { ok: true, paraIdx: sp, charOffset: so };
    },
    setCellProperties: (_s: number, para: number, ctrl: number, cell: number, props: Record<string, unknown>) => {
      record('setCellProperties', para, ctrl, cell, props);
      Object.assign(findTable(para, ctrl).cellProps[cell], props);
      return { ok: true };
    },
    setTableProperties: (_s: number, para: number, ctrl: number, props: Record<string, unknown>) => {
      record('setTableProperties', para, ctrl, props);
      Object.assign(findTable(para, ctrl).tableProps, props);
      return { ok: true };
    },
    applyCharFormatInCell: (_s: number, para: number, ctrl: number, cell: number, cp: number, so: number, eo: number, json: string) => {
      record('applyCharFormatInCell', para, ctrl, cell, cp, so, eo, json);
      return okJson();
    },
    insertTableRow: (_s: number, para: number, ctrl: number, rowIdx: number, below: boolean) => {
      record('insertTableRow', rowIdx, below);
      const t = findTable(para, ctrl);
      const at = (below ? rowIdx + 1 : rowIdx) * t.cols;
      t.cells.splice(at, 0, ...Array.from({ length: t.cols }, () => ['']));
      t.cellProps.splice(at, 0, ...Array.from({ length: t.cols }, () => ({})));
      t.rows += 1;
      return { ok: true, rowCount: t.rows, colCount: t.cols };
    },
    deleteTableRow: (_s: number, para: number, ctrl: number, rowIdx: number) => {
      record('deleteTableRow', rowIdx);
      const t = findTable(para, ctrl);
      t.cells.splice(rowIdx * t.cols, t.cols);
      t.cellProps.splice(rowIdx * t.cols, t.cols);
      t.rows -= 1;
      return { ok: true, rowCount: t.rows, colCount: t.cols };
    },
    insertTableColumn: (_s: number, para: number, ctrl: number, colIdx: number, right: boolean) => {
      record('insertTableColumn', colIdx, right);
      const t = findTable(para, ctrl);
      const at = right ? colIdx + 1 : colIdx;
      for (let r = t.rows - 1; r >= 0; r--) {
        t.cells.splice(r * t.cols + at, 0, ['']);
        t.cellProps.splice(r * t.cols + at, 0, {});
      }
      t.cols += 1;
      return { ok: true, rowCount: t.rows, colCount: t.cols };
    },
    deleteTableColumn: (_s: number, para: number, ctrl: number, colIdx: number) => {
      record('deleteTableColumn', colIdx);
      const t = findTable(para, ctrl);
      for (let r = t.rows - 1; r >= 0; r--) {
        t.cells.splice(r * t.cols + colIdx, 1);
        t.cellProps.splice(r * t.cols + colIdx, 1);
      }
      t.cols -= 1;
      return { ok: true, rowCount: t.rows, colCount: t.cols };
    },
    mergeTableCells: (_s: number, para: number, ctrl: number, sr: number, sc: number, er: number, ec: number) => {
      record('mergeTableCells', sr, sc, er, ec);
      return { ok: true, cellCount: findTable(para, ctrl).cells.length };
    },
    splitTableCellInto: (_s: number, para: number, ctrl: number, row: number, col: number, nRows: number, nCols: number, equal: boolean, mergeFirst: boolean) => {
      record('splitTableCellInto', row, col, nRows, nCols, equal, mergeFirst);
      return { ok: true, cellCount: findTable(para, ctrl).cells.length + nRows * nCols - 1 };
    },
    // ─ 문단 서식/스타일 ─
    getParaPropertiesAt: (_s: number, p: number) => ({ paraShapeId: bodyParaShapes[p], alignment: 'left' }),
    applyParaFormat: (_s: number, p: number, json: string) => {
      record('applyParaFormat', p, json);
      bodyParaShapes[p] = 99;
      return okJson();
    },
    setParaShapeId: (_s: number, p: number, id: number) => {
      record('setParaShapeId', p, id);
      bodyParaShapes[p] = id;
      return okJson();
    },
    getCellParaPropertiesAt: () => ({ paraShapeId: 55 }),
    applyParaFormatInCell: (...a: unknown[]) => { record('applyParaFormatInCell', ...a); return okJson(); },
    setCellParaShapeId: (...a: unknown[]) => { record('setCellParaShapeId', ...a); return okJson(); },
    getStyleList: () => [
      { id: 0, name: '바탕글', englishName: 'Normal', type: 0, nextStyleId: 0, paraShapeId: 1, charShapeId: 1 },
      { id: 3, name: '개요 1', englishName: 'Outline 1', type: 0, nextStyleId: 3, paraShapeId: 5, charShapeId: 5 },
    ],
    applyStyle: (...a: unknown[]) => { record('applyStyle', ...a); return { ok: true }; },
    applyCellStyle: (...a: unknown[]) => { record('applyCellStyle', ...a); return { ok: true }; },
    // ─ 폰트/글자 서식 ─
    findOrCreateFontId: (name: string) => {
      let i = fonts.indexOf(name);
      if (i < 0) { fonts.push(name); i = fonts.length - 1; }
      return i;
    },
    getCharPropertiesAt: () => ({ fontFamily: '바탕' }),
    getCellCharPropertiesAt: () => ({ fontFamily: '바탕' }),
    applyCharFormat: (...a: unknown[]) => { record('applyCharFormat', ...a); return okJson(); },
    // ─ 셀 수식 ─
    renderEquationPreview: (script: string) =>
      JSON.stringify({
        svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${script}</text></svg>`,
        widthPx: 40, heightPx: 20, baselinePx: 15, warnings: [],
      }),
    insertEquationInCell: (_s: number, para: number, ctrl: number, cell: number, cp: number, _off: number, script: string) => {
      record('insertEquationInCell', para, ctrl, cell, cp, script);
      const ft = findTable(para, ctrl);
      (ft as unknown as { eqs?: Map<string, string> }).eqs ??= new Map();
      (ft as unknown as { eqs: Map<string, string> }).eqs.set(`${cell}:${cp}`, script);
      return { ok: true, cellParaIdx: cp, controlIdx: 0 };
    },
    deleteEquationControlInCell: (_s: number, para: number, ctrl: number, cell: number, cp: number) => {
      record('deleteEquationControlInCell', para, ctrl, cell, cp);
      const ft = findTable(para, ctrl) as unknown as { eqs?: Map<string, string> };
      if (!ft.eqs?.delete(`${cell}:${cp}`)) return { ok: false };
      return { ok: true };
    },
    getEquationProperties: (_s: number, para: number, ctrl: number, cell?: number, cp?: number) => {
      const ft = findTable(para, ctrl) as unknown as { eqs?: Map<string, string> };
      const script = ft.eqs?.get(`${cell ?? -1}:${cp ?? -1}`);
      if (script === undefined) throw new Error('수식 없음');
      return { script, fontSize: 1000, color: 0, baseline: 0, fontName: '' };
    },
    getFontList: () => fonts.map((name, id) => ({ lang: 0, id, name })),
    // ─ 기타 ─
    setFieldValueByName: () => ({ ok: true }),
    getSourceFormat: () => 'hwpx',
    get documentDigest() { return 'blake3:obj-test'; },
    getFieldList: () => [],
    renderPageSvg: () => '<svg/>',
    getSelectionRects: () => [],
    getSelectionRectsInCell: () => [],
    getDocumentInfo: () => ({
      version: '5.0', sectionCount: 1, pageCount: 1, encrypted: false,
      fallbackFont: '바탕', fontsUsed: fonts.slice(),
    }),
  };

  let snapshotId = 0;
  const snapshots = new Map<number, {
    body: string[];
    bodyParaShapes: number[];
    tables: FakeTable[];
    fonts: string[];
  }>();
  Object.assign(wasm, {
    saveSnapshot: () => {
      const id = ++snapshotId;
      snapshots.set(id, {
        body: structuredClone(body),
        bodyParaShapes: structuredClone(bodyParaShapes),
        tables: structuredClone(tables),
        fonts: structuredClone(fonts),
      });
      return id;
    },
    restoreSnapshot: (id: number) => {
      const saved = snapshots.get(id)!;
      body.splice(0, body.length, ...structuredClone(saved.body));
      bodyParaShapes.splice(0, bodyParaShapes.length, ...structuredClone(saved.bodyParaShapes));
      tables.splice(0, tables.length, ...structuredClone(saved.tables));
      fonts.splice(0, fonts.length, ...structuredClone(saved.fonts));
    },
    discardSnapshot: (id: number) => { snapshots.delete(id); },
  });

  const bus = new EventBus();
  const revision = new RevisionTracker(bus);
  const inputHandler = {
    executeOperation: (op: { operation?: (w: unknown) => unknown }) => { op.operation?.(wasm); },
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    getSelection: () => null,
  };
  const pending = new PendingEditManager({
    wasm: wasm as never,
    eventBus: bus,
    inputHandler: inputHandler as never,
    canvasView: {} as never,
    overlay: { setOps: () => {}, clear: () => {} } as never,
  });
  const executor = new AgentToolExecutor({
    wasm: wasm as never,
    inputHandler: inputHandler as never,
    documentState: { isDirty: () => false } as never,
    revision,
    pending,
  });
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    executor.execute(tool, { expectedRevision: revision.revision, ...args }, 'claude');
  return { executor, pending, revision, call, body, tables, calls, bus, wasm };
}

async function expectErr(p: Promise<unknown>, code: string): Promise<AgentToolError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AgentToolError, `AgentToolError 기대, 실제: ${e}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`${code} 오류를 기대했지만 성공함`);
}

// ─── create_table ───────────────────────────────────────────

test('create_table: cells 로 rows/cols 유도 + 벌크 채움 + 헤더 행', async () => {
  const { call, tables, calls } = makeEnv();
  const r = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0,
    cells: [['이름', '값'], ['알파', '1'], ['베타', '2']],
    headerRow: true, headerFill: '#EEF1F5',
  })) as { table: { paraIdx: number; controlIdx: number; rowCount: number; colCount: number } };
  assert.equal(r.table.rowCount, 3);
  assert.equal(r.table.colCount, 2);
  const t = tables[0];
  assert.equal(t.cells[0][0], '이름');
  assert.equal(t.cells[5][0], '2');
  assert.equal(t.cellProps[0]['isHeader'], true);
  assert.equal(t.cellProps[0]['fillColor'], '#EEF1F5');
  assert.equal(t.tableProps['repeatHeader'], true);
  assert.ok(calls.some((c) => c.m === 'applyCharFormatInCell')); // 헤더 볼드
  // treatAsChar 경로 강제 (blocker 해결 확인)
  const create = calls.find((c) => c.m === 'createTableEx')!.a[0] as { treatAsChar?: boolean };
  assert.equal(create.treatAsChar, true);
});

test('create_table: cells 가 rows/cols 를 초과하면 행 번호를 짚어 INVALID_ARGS', async () => {
  const { call } = makeEnv();
  await expectErr(call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, rows: 1, cols: 2,
    cells: [['a', 'b'], ['c', 'd']],
  }), 'INVALID_ARGS');
  await expectErr(call('create_table', { sectionIdx: 0, paraIdx: 2, charOffset: 0 }), 'INVALID_ARGS');
});

test('create_table → reject: deleteTableControl 로 표가 사라진다', async () => {
  const { call, pending, tables } = makeEnv();
  const r = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['x']],
  })) as { changeSetId: string };
  assert.equal(tables.length, 1);
  pending.reject(r.changeSetId);
  assert.equal(tables.length, 0);
});

test('create_table → approve: 미리보기 표를 재생성 없이 확정한다', async () => {
  const { call, pending, tables, calls } = makeEnv();
  const r = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['A', 'B']], headerRow: false,
  })) as { changeSetId: string };
  pending.approve(r.changeSetId);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].cells[0][0], 'A');
  assert.equal(calls.filter((entry) => entry.m === 'createTableEx').length, 1);
  assert.equal(pending.hasPending(), false);
});

// ─── edit_table ─────────────────────────────────────────────

test('edit_table insert_row: 즉시 적용, reject 시 원상복구', async () => {
  const { call, pending, tables } = makeEnv();
  await call('create_table', { sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['a'], ['b']] });
  const t = tables[0];
  const r = (await call('edit_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx, op: 'insert_row', rowIdx: 0,
  })) as { changeSetId: string; rowCount: number };
  assert.equal(r.rowCount, 3);
  assert.equal(t.rows, 3);
  pending.reject(r.changeSetId);
  assert.equal(tables.length, 0); // 같은 change-set 의 createTable 도 함께 reject 된다
});

test('edit_table delete_row 는 mark-only + 같은 표 후속 편집은 PENDING_DESTRUCTIVE_OP', async () => {
  const { call, pending, tables, calls } = makeEnv();
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['a'], ['b'], ['c']],
  })) as { changeSetId: string; table: { paraIdx: number; controlIdx: number } };
  pending.approve(c.changeSetId);
  const t = tables[0];
  const del = (await call('edit_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx, op: 'delete_row', rowIdx: 1,
  })) as { changeSetId: string };
  assert.equal(t.rows, 3); // 아직 적용 안 됨
  await expectErr(call('edit_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx, op: 'insert_row', rowIdx: 0,
  }), 'PENDING_DESTRUCTIVE_OP');
  await expectErr(call('insert_text', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x',
    cell: { paraIdx: t.paraIdx, controlIdx: t.controlIdx, cellIdx: 0 },
  }), 'PENDING_DESTRUCTIVE_OP');
  calls.length = 0;
  pending.approve(del.changeSetId);
  assert.equal(tables[0].rows, 2); // approve 시 실행 (snapshot restore 뒤의 현재 표)
  assert.ok(calls.some((x) => x.m === 'deleteTableRow'));
});

test('delete_table 는 mark-only + 같은 표 후속 편집은 PENDING_DESTRUCTIVE_OP', async () => {
  const { call, pending, tables, calls } = makeEnv();
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['a', 'b'], ['c', 'd']],
  })) as { changeSetId: string; table: { paraIdx: number; controlIdx: number } };
  pending.approve(c.changeSetId);
  calls.length = 0;
  const t = tables[0];
  const del = (await call('delete_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx,
  })) as { changeSetId: string; marked: boolean; ok: boolean };
  assert.equal(del.ok, true);
  assert.equal(del.marked, true);
  assert.equal(tables.length, 1); // 아직 적용 안 됨
  assert.ok(!calls.some((x) => x.m === 'deleteTableControl'));
  await expectErr(call('edit_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx, op: 'insert_row', rowIdx: 0,
  }), 'PENDING_DESTRUCTIVE_OP');
  calls.length = 0;
  pending.approve(del.changeSetId);
  assert.equal(tables.length, 0);
  assert.ok(calls.some((x) => x.m === 'deleteTableControl'));
});

test('delete_table → reject: 표가 남고 deleteTableControl 을 부르지 않는다', async () => {
  const { call, pending, tables, calls } = makeEnv();
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['a']],
  })) as { changeSetId: string; table: { paraIdx: number; controlIdx: number } };
  pending.approve(c.changeSetId);
  calls.length = 0;
  const t = tables[0];
  const del = (await call('delete_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx,
  })) as { changeSetId: string };
  assert.equal(tables.length, 1);
  pending.reject(del.changeSetId);
  assert.equal(tables.length, 1);
  assert.ok(!calls.some((x) => x.m === 'deleteTableControl'));
});

test('delete_table: 없는 표 주소·누락 인자는 INVALID_ARGS', async () => {
  const { call } = makeEnv();
  await expectErr(call('delete_table', {
    sectionIdx: 0, paraIdx: 0, controlIdx: 0,
  }), 'INVALID_ARGS');
  await expectErr(call('delete_table', {
    sectionIdx: 0, paraIdx: 2,
  }), 'INVALID_ARGS');
});

test('edit_table merge_cells: 인자 검증과 mark-only 실행', async () => {
  const { call, pending, tables, calls } = makeEnv();
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['a', 'b'], ['c', 'd']],
  })) as { changeSetId: string };
  pending.approve(c.changeSetId);
  const t = tables[0];
  await expectErr(call('edit_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx,
    op: 'merge_cells', startRow: 0, startCol: 0, endRow: 0, endCol: 0,
  }), 'INVALID_ARGS');
  const m = (await call('edit_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx,
    op: 'merge_cells', startRow: 0, startCol: 0, endRow: 0, endCol: 1,
  })) as { changeSetId: string };
  assert.ok(!calls.some((x) => x.m === 'mergeTableCells'));
  pending.approve(m.changeSetId);
  assert.ok(calls.some((x) => x.m === 'mergeTableCells'));
});

test('get_table_properties + set_table_props: 표 개체를 가로 가운데로 배치한다', async () => {
  const { call, pending, tables, calls } = makeEnv();
  const created = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['a', 'b']],
  })) as { changeSetId: string };
  pending.approve(created.changeSetId);
  const t = tables[0];

  const before = (await call('get_table_properties', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx,
  })) as { table: { positionMode: string; horizontal: { align: string }; sizeMm: { width: number } } };
  assert.equal(before.table.positionMode, 'inline');
  assert.equal(before.table.horizontal.align, 'left');
  assert.ok(Math.abs(before.table.sizeMm.width - 150) < 0.1);

  const edit = (await call('edit_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx,
    op: 'set_table_props', props: { horizontalAlign: 'center' },
  })) as { changeSetId: string };
  assert.ok(!calls.some((entry) => entry.m === 'setTableProperties'));
  pending.approve(edit.changeSetId);
  const apply = calls.find((entry) => entry.m === 'setTableProperties')!;
  assert.deepEqual(apply.a[2], {
    horzAlign: 'Center', treatAsChar: false, horzRelTo: 'Column', horzOffset: 0,
  });

  const after = (await call('get_table_properties', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx,
  })) as { table: { positionMode: string; horizontal: { align: string; relativeTo: string; offsetMm: number } } };
  assert.equal(after.table.positionMode, 'floating');
  assert.deepEqual(after.table.horizontal, { align: 'center', relativeTo: 'column', offsetMm: 0 });
});

test('set_table_props ignores a null horizontal alignment without repositioning the table', async () => {
  const { call, pending, tables, calls } = makeEnv();
  const created = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['a']],
  })) as { changeSetId: string };
  pending.approve(created.changeSetId);
  const table = tables[0];
  const edit = (await call('edit_table', {
    sectionIdx: 0, paraIdx: table.paraIdx, controlIdx: table.controlIdx,
    op: 'set_table_props', props: { horizontalAlign: null, repeatHeader: true },
  })) as { changeSetId: string };
  pending.approve(edit.changeSetId);
  const props = calls.find((entry) => entry.m === 'setTableProperties')!.a[2] as Record<string, unknown>;

  assert.deepEqual(props, { repeatHeader: true });
});

test('set_table_props exposes pagination, wrapping, margins, overlap and captions', async () => {
  const { call, pending, tables, calls } = makeEnv();
  const created = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['a']],
  })) as { changeSetId: string };
  pending.approve(created.changeSetId);
  const t = tables[0];
  const edit = (await call('edit_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx, op: 'set_table_props',
    props: {
      pageBreak: 'row', repeatHeader: true, cellSpacingMm: 1.5,
      cellPaddingMm: { left: 2, right: 2, top: 1, bottom: 1 },
      outerMarginMm: { left: 3, right: 3 }, textWrap: 'topAndBottom',
      verticalRelativeTo: 'paragraph', verticalAlign: 'top', verticalOffsetMm: 4,
      restrictInPage: true, allowOverlap: false, keepWithAnchor: true,
      captionEnabled: true, captionDirection: 'bottom', captionSpacingMm: 2,
    },
  })) as { changeSetId: string };
  pending.approve(edit.changeSetId);
  const props = calls.find((entry) => entry.m === 'setTableProperties')!.a[2] as Record<string, unknown>;
  assert.equal(props['pageBreak'], 2);
  assert.equal(props['repeatHeader'], true);
  assert.equal(props['cellSpacing'], mmToHu(1.5));
  assert.equal(props['paddingLeft'], mmToHu(2));
  assert.equal(props['paddingTop'], mmToHu(1));
  assert.equal(props['outerLeft'], mmToHu(3));
  assert.equal(props['textWrap'], 'TopAndBottom');
  assert.equal(props['vertRelTo'], 'Para');
  assert.equal(props['vertAlign'], 'Top');
  assert.equal(props['vertOffset'], mmToHu(4));
  assert.equal(props['treatAsChar'], false);
  assert.equal(props['restrictInPage'], true);
  assert.equal(props['allowOverlap'], false);
  assert.equal(props['keepWithAnchor'], true);
  assert.equal(props['hasCaption'], true);
  assert.equal(props['captionDirection'], 3);
  assert.equal(props['captionSpacing'], mmToHu(2));
});

test('set_cell_props exposes padding, direction, protection, form field and readback', async () => {
  const { call, pending, tables, calls } = makeEnv();
  const created = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['value']],
  })) as { changeSetId: string };
  pending.approve(created.changeSetId);
  const t = tables[0];
  const edit = (await call('edit_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx, op: 'set_cell_props', cellIdx: 0,
    props: {
      paddingMm: { left: 2, top: 1 }, textDirection: 'vertical', protected: true,
      editableInForm: true, fieldName: 'amount', verticalAlign: 'center',
    },
  })) as { changeSetId: string };
  pending.approve(edit.changeSetId);
  const apply = calls.find((entry) => entry.m === 'setCellProperties')!;
  const props = apply.a[3] as Record<string, unknown>;
  assert.equal(props['paddingLeft'], mmToHu(2));
  assert.equal(props['paddingTop'], mmToHu(1));
  assert.equal(props['applyInnerMargin'], true);
  assert.equal(props['textDirection'], 1);
  assert.equal(props['cellProtect'], true);
  assert.equal(props['editableInForm'], true);
  assert.equal(props['fieldName'], 'amount');
  assert.equal(props['verticalAlign'], 1);

  const read = (await call('get_table_properties', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx, cellIdx: 0,
  })) as { cell: { paddingMm: { left: number; top: number }; textDirection: string; protected: boolean; fieldName: string } };
  assert.equal(read.cell.paddingMm.left, 2);
  assert.equal(read.cell.paddingMm.top, 1);
  assert.equal(read.cell.textDirection, 'vertical');
  assert.equal(read.cell.protected, true);
  assert.equal(read.cell.fieldName, 'amount');
});

test('edit_table split_cell rejects covered coordinates inside a merged cell', async () => {
  const { call, pending, tables, wasm } = makeEnv();
  const created = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['merged', '']],
  })) as { changeSetId: string };
  pending.approve(created.changeSetId);
  const t = tables[0];
  wasm.getCellInfo = () => ({ row: 0, col: 0, rowSpan: 1, colSpan: 2 });
  const error = await expectErr(call('edit_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx,
    op: 'split_cell', rowIdx: 0, colIdx: 1, splitRows: 1, splitCols: 2,
  }), 'INVALID_ARGS');
  assert.match(error.message, /covered coordinates/);
});

test('edit_table split_cell is mark-only and executes on approval', async () => {
  const { call, pending, tables, calls } = makeEnv();
  const created = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['wide']],
  })) as { changeSetId: string };
  pending.approve(created.changeSetId);
  const t = tables[0];
  const split = (await call('edit_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx,
    op: 'split_cell', rowIdx: 0, colIdx: 0, splitRows: 2, splitCols: 3,
  })) as { changeSetId: string };
  assert.ok(!calls.some((entry) => entry.m === 'splitTableCellInto'));
  pending.approve(split.changeSetId);
  const apply = calls.find((entry) => entry.m === 'splitTableCellInto')!;
  assert.deepEqual(apply.a, [0, 0, 2, 3, true, false]);
});

test('edit_table split_cell approval fails when the engine rejects the split', async () => {
  const { call, pending, tables, wasm } = makeEnv();
  const created = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['wide']],
  })) as { changeSetId: string };
  pending.approve(created.changeSetId);
  const table = tables[0];
  const split = (await call('edit_table', {
    sectionIdx: 0, paraIdx: table.paraIdx, controlIdx: table.controlIdx,
    op: 'split_cell', rowIdx: 0, colIdx: 0, splitRows: 2, splitCols: 2,
  })) as { changeSetId: string };
  wasm.splitTableCellInto = () => ({ ok: false, cellCount: 1 });

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(pending.approve(split.changeSetId), false);
    assert.equal(pending.hasPending(), true);
  } finally {
    console.warn = originalWarn;
  }
});

// ─── apply_para_format / apply_style ────────────────────────

test('apply_para_format: pt→HWPUNIT 변환 적용, reject 는 setParaShapeId 복원', async () => {
  const { call, pending, calls } = makeEnv();
  const r = (await call('apply_para_format', {
    sectionIdx: 0, paraIdx: 0, alignment: 'center', spaceBeforePt: 6, lineSpacingPercent: 160,
  })) as { changeSetId: string };
  const apply = calls.find((x) => x.m === 'applyParaFormat')!;
  const json = JSON.parse(apply.a[1] as string) as Record<string, unknown>;
  assert.equal(json['alignment'], 'center');
  assert.equal(json['spacingBefore'], 600);
  assert.equal(json['lineSpacing'], 160);
  assert.equal(json['lineSpacingType'], 'Percent');
  pending.reject(r.changeSetId);
  const restore = calls.find((x) => x.m === 'setParaShapeId')!;
  assert.deepEqual(restore.a, [0, 10]); // 이전 para_shape_id 복원
});

test('apply_style: mark-only, approve 시 applyStyle 실행 + 존재하지 않는 styleId 거부', async () => {
  const { call, pending, calls } = makeEnv();
  await expectErr(call('apply_style', { sectionIdx: 0, paraIdx: 0, styleId: 77 }), 'INVALID_ARGS');
  const r = (await call('apply_style', { sectionIdx: 0, paraIdx: 0, styleId: 3 })) as { changeSetId: string };
  assert.ok(!calls.some((x) => x.m === 'applyStyle'));
  pending.approve(r.changeSetId);
  const apply = calls.find((x) => x.m === 'applyStyle')!;
  assert.deepEqual(apply.a, [0, 0, 3]);
});

test('list_styles 는 스타일 목록을 반환한다', async () => {
  const { call } = makeEnv();
  const r = (await call('list_styles')) as { styles: Array<{ id: number; name: string }> };
  assert.equal(r.styles.length, 2);
  assert.equal(r.styles[1].name, '개요 1');
});

// ─── 폰트 ───────────────────────────────────────────────────

test('apply_char_format fontFamily: fontId 해석 + 역서식은 이전 폰트 id', async () => {
  const { call, pending, calls } = makeEnv();
  const r = (await call('apply_char_format', {
    sectionIdx: 0, paraIdx: 0, startOffset: 0, endOffset: 5, fontFamily: '맑은 고딕',
  })) as { changeSetId: string };
  const apply = calls.find((x) => x.m === 'applyCharFormat')!;
  const json = JSON.parse(apply.a[4] as string) as { fontId?: number };
  assert.equal(json.fontId, 1); // '맑은 고딕' 이 새로 등록된 id
  calls.length = 0;
  pending.reject(r.changeSetId);
  const inverse = calls.find((x) => x.m === 'applyCharFormat')!;
  const invJson = JSON.parse(inverse.a[4] as string) as { fontId?: number };
  assert.equal(invJson.fontId, 0); // 이전 폰트('바탕') id
});

test('get_document_info 에 fontsUsed 가 실린다', async () => {
  const { call } = makeEnv();
  const r = (await call('get_document_info')) as { fontsUsed: string[]; fallbackFont: string };
  assert.deepEqual(r.fontsUsed, ['바탕']);
  assert.equal(r.fallbackFont, '바탕');
});

// ─── 좌표 이동 ──────────────────────────────────────────────

test('본문 멀티라인 삽입이 표 앞이면 객체 앵커 paraIdx 가 이동하고 reject 도 정확하다', async () => {
  const { call, pending, tables } = makeEnv();
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['x']],
  })) as { changeSetId: string };
  // 표(문단 2) 앞의 문단 0 에 문단 추가 삽입 → fake wasm 이 표 paraIdx 를 3으로 옮긴다
  await call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 5, text: 'a\nb' });
  assert.equal(tables[0].paraIdx, 3);
  const sets = pending.getChangeSets();
  const objOp = sets.flatMap((s) => s.ops).find((o) => o.kind === 'object')!;
  assert.equal((objOp as { obj: { anchor?: { paraIdx: number } } }).obj.anchor?.paraIdx, 3);
  pending.reject(c.changeSetId); // 이동한 앵커 기준으로 삭제 성공해야 한다
  assert.equal(tables.length, 0);
});

// ─── 셀 수식 (Phase 4 Rust 배치 연동) ───────────────────────

test('insert_equation: cell 인자로 셀 문단에 삽입하고 reject 시 셀 수식이 제거된다', async () => {
  const { call, pending, tables, calls } = makeEnv();
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['합계']],
  })) as { changeSetId: string };
  pending.approve(c.changeSetId);
  const t = tables[0];
  const cellAddr = { paraIdx: t.paraIdx, controlIdx: t.controlIdx, cellIdx: 0 };
  const r = (await call('insert_equation', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, cell: cellAddr,
    script: 'sum _{k=1} ^{n} k',
  })) as { changeSetId: string };
  const ins = calls.find((x) => x.m === 'insertEquationInCell')!;
  assert.deepEqual(ins.a.slice(0, 4), [t.paraIdx, t.controlIdx, 0, 0]);
  pending.reject(r.changeSetId);
  assert.ok(calls.some((x) => x.m === 'deleteEquationControlInCell'));
});

test('get_document_info 에 registeredFonts 가 실린다', async () => {
  const { call } = makeEnv();
  const r = (await call('get_document_info')) as { registeredFonts: string[] };
  assert.deepEqual(r.registeredFonts, ['바탕']);
});

// ─── 리뷰 확정 결함 회귀 테스트 ─────────────────────────────

test('같은 표에 insert_row 두 번 → reject 가 둘 다 되돌린다 (형제 dims 갱신)', async () => {
  const { call, pending, tables } = makeEnv();
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['a'], ['b'], ['c'], ['d']],
  })) as { changeSetId: string };
  pending.approve(c.changeSetId);
  const t = tables[0];
  assert.equal(t.rows, 4);
  const r1 = (await call('edit_table', {
    sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx, op: 'insert_row', rowIdx: 1,
  })) as { changeSetId: string };
  // executor 가드가 같은 표의 후속 구조 편집을 PENDING_DESTRUCTIVE_OP 로 막으므로,
  // 두 번째 insert 는 매니저에 직접 등록한다 (reject 역연산 회귀 검증이 목적)
  pending.addObjectOp('claude', {
    type: 'tableStructure', sectionIdx: 0, tableParaIdx: t.paraIdx, controlIdx: t.controlIdx,
    op: 'insert_row', index: 2, after: true,
  });
  assert.equal(t.rows, 6);
  pending.reject(r1.changeSetId); // 두 op 은 같은 change-set 에 있다
  assert.equal(t.rows, 4); // 둘 다 되돌아감 — 이전에는 첫 op 이 드리프트로 오판·잔류했다
});

test('pending 표에 사용자가 입력하면 reject 는 표를 지우지 않고 남긴다 (내용 지문)', async () => {
  const { call, pending, tables } = makeEnv();
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['원본']],
  })) as { changeSetId: string };
  // 사용자가 승인 전 셀에 직접 타이핑 (에이전트 op 이 아님)
  tables[0].cells[0][0] = '원본 + 사용자 입력';
  pending.reject(c.changeSetId);
  assert.equal(tables.length, 1); // 표(와 사용자 내용)가 보존된다
  assert.equal(tables[0].cells[0][0], '원본 + 사용자 입력');
});

test('create_table + 같은 턴 셀 텍스트 op → reject 가 표를 정상 삭제한다 (에이전트 셀 op 은 지문 제외)', async () => {
  const { call, pending, tables } = makeEnv();
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, cells: [['머리', '']],
  })) as { changeSetId: string };
  const t = tables[0];
  await call('insert_text', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '추가',
    cell: { paraIdx: t.paraIdx, controlIdx: t.controlIdx, cellIdx: 1 },
  });
  assert.equal(t.cells[1][0], '추가');
  pending.reject(c.changeSetId);
  assert.equal(tables.length, 0); // 에이전트 자신의 셀 편집은 드리프트가 아니다
});

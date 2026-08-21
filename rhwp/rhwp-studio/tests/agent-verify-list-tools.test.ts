/**
 * 에이전트 목록/검증 툴 테스트.
 *
 * - apply_list: 번호 정의 생성/재사용, 문단별 paraFormat op, 글머리표 경로, startNumber
 * - list_numberings / get_para_format / get_char_format
 * - verify_changes: change-set 요약 + postEditText 다이제스트 + warnings + includeImage
 * - find_text: Unicode scalar 오프셋 (emoji)
 * - insert_text \r\n 정규화, PENDING_DESTRUCTIVE_OP 확장 가드, zero-length 서식 거부
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { RevisionTracker } from '../src/agent/revision.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { AgentToolError } from '../src/agent/types.ts';

interface FakeTable {
  paraIdx: number;
  controlIdx: number;
  rows: number;
  cols: number;
  cells: string[][];
  cellProps: Array<Record<string, unknown>>;
  tableProps: Record<string, unknown>;
}

function makeEnv() {
  const body = ['First item', 'Second item', 'Third item', ''];
  const bodyParaShapes = [10, 11, 12, 13];
  const tables: FakeTable[] = [];
  const numberings: Array<{ id: number; levelFormats: string[]; numberFormats: number[]; startNumber: number }> = [];
  const bullets: Array<{ id: number; char: string }> = [];
  const calls: Array<{ m: string; a: unknown[] }> = [];
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
    getParagraphLength: (_s: number, p: number) => [...body[p]].length,
    getTextRange: (_s: number, p: number, off: number, cnt: number) => [...body[p]].slice(off, off + cnt).join(''),
    insertText: (_s: number, p: number, off: number, t: string) => {
      const chars = [...body[p]];
      body[p] = chars.slice(0, off).join('') + t + chars.slice(off).join('');
      return okJson({ charOffset: off + [...t].length });
    },
    splitParagraph: (_s: number, p: number, off: number) => {
      const chars = [...body[p]];
      body.splice(p, 1, chars.slice(0, off).join(''), chars.slice(off).join(''));
      bodyParaShapes.splice(p, 1, bodyParaShapes[p], bodyParaShapes[p]);
      for (const t of tables) if (t.paraIdx > p) t.paraIdx += 1;
      return okJson();
    },
    splitParagraphLogical(this: any, s: number, p: number, off: number) {
      return this.splitParagraph(s, p, off);
    },
    deleteRange: (_s: number, sp: number, so: number, ep: number, eo: number) => {
      const head = [...body[sp]].slice(0, so).join('');
      const tail = [...body[ep]].slice(eo).join('');
      body.splice(sp, ep - sp + 1, head + tail);
      bodyParaShapes.splice(sp + 1, ep - sp);
      for (const t of tables) if (t.paraIdx > ep) t.paraIdx -= ep - sp;
      return { ok: true };
    },
    get pageCount() { return 2; },
    getPageControlLayout: () => ({
      controls: tables.map((t) => ({ type: 'table', secIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx, x: 0, y: 0, w: 10, h: 10 })),
    }),
    getCursorRect: () => ({ pageIndex: 0, x: 0, y: 0, height: 10 }),
    renderPageToCanvas: (page: number, canvas: { width: number; height: number }, _scale: number) => {
      // 승인 후 상태로 렌더됐는지 검증할 수 있도록 렌더 시점의 본문을 기록한다
      record('renderPageToCanvas', page, body[0]);
      canvas.width = 100;
      canvas.height = 50;
    },
    // ─ 표 ─
    createTableEx: (opts: { sectionIdx: number; paraIdx: number; charOffset: number; rowCount: number; colCount: number }) => {
      record('createTableEx', opts);
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
      const i = tables.findIndex((t) => t.paraIdx === para && t.controlIdx === ctrl);
      if (i < 0) return { ok: false };
      tables.splice(i, 1);
      return { ok: true };
    },
    getTableDimensions: (_s: number, para: number, ctrl: number) => {
      const t = findTable(para, ctrl);
      return { rowCount: t.rows, colCount: t.cols, cellCount: t.cells.length };
    },
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
    insertTableRow: (_s: number, para: number, ctrl: number, rowIdx: number, below: boolean) => {
      record('insertTableRow', rowIdx, below);
      const t = findTable(para, ctrl);
      const at = (below ? rowIdx + 1 : rowIdx) * t.cols;
      t.cells.splice(at, 0, ...Array.from({ length: t.cols }, () => ['']));
      t.cellProps.splice(at, 0, ...Array.from({ length: t.cols }, () => ({})));
      t.rows += 1;
      return { ok: true, rowCount: t.rows, colCount: t.cols };
    },
    insertTableColumn: (_s: number, para: number, ctrl: number, colIdx: number, right: boolean) => {
      const t = findTable(para, ctrl);
      const at = right ? colIdx + 1 : colIdx;
      for (let r = t.rows - 1; r >= 0; r--) {
        t.cells.splice(r * t.cols + at, 0, ['']);
        t.cellProps.splice(r * t.cols + at, 0, {});
      }
      t.cols += 1;
      return { ok: true, rowCount: t.rows, colCount: t.cols };
    },
    deleteTableRow: (_s: number, para: number, ctrl: number, rowIdx: number) => {
      const t = findTable(para, ctrl);
      t.cells.splice(rowIdx * t.cols, t.cols);
      t.cellProps.splice(rowIdx * t.cols, t.cols);
      t.rows -= 1;
      return { ok: true, rowCount: t.rows, colCount: t.cols };
    },
    applyCharFormat: () => okJson(),
    applyCharFormatInCell: () => okJson(),
    // ─ 문단/글자 서식 ─
    getParaPropertiesAt: (_s: number, p: number) => ({
      paraShapeId: bodyParaShapes[p],
      alignment: 'center',
      lineSpacing: 160,
      lineSpacingType: 'Percent',
      spacingBefore: 8,   // px (96dpi)
      spacingAfter: 4,
      indent: 0,
      marginLeft: 20,
      marginRight: 0,
      pageBreakBefore: false,
      headType: p === 1 ? 'Number' : 'None',
      paraLevel: p === 1 ? 2 : 0,
      numberingId: p === 1 ? 7 : 0,
    }),
    getCellParaPropertiesAt: () => ({
      paraShapeId: 55, alignment: 'left', lineSpacing: 130, lineSpacingType: 'Percent',
      headType: 'Bullet', paraLevel: 1, numberingId: 3,
    }),
    applyParaFormat: (_s: number, p: number, json: string) => {
      record('applyParaFormat', p, json);
      bodyParaShapes[p] = 99;
      return okJson();
    },
    setParaShapeId: (_s: number, p: number, id: number) => {
      bodyParaShapes[p] = id;
      return okJson();
    },
    applyParaFormatInCell: (...a: unknown[]) => { record('applyParaFormatInCell', ...a); return okJson(); },
    setCellParaShapeId: () => okJson(),
    getCharPropertiesAt: () => ({
      fontFamily: '바탕', fontSize: 1100, bold: true, italic: false,
      underline: true, strikethrough: false, textColor: '#FF0000', charShapeId: 4, fontId: 2,
    }),
    getCellCharPropertiesAt: () => ({ fontFamily: '맑은 고딕', fontSize: 900, bold: false, charShapeId: 8 }),
    // ─ 번호/글머리표 ─
    getNumberingList: () => numberings.map((n) => ({ id: n.id, levelFormats: n.levelFormats.slice(), numberFormats: n.numberFormats.slice(), startNumber: n.startNumber })),
    createNumbering: (json: string) => {
      record('createNumbering', JSON.parse(json));
      const parsed = JSON.parse(json) as { levelFormats: string[]; numberFormats: number[]; startNumber?: number };
      const id = numberings.length + 1;
      numberings.push({
        id, levelFormats: parsed.levelFormats, numberFormats: parsed.numberFormats,
        startNumber: parsed.startNumber ?? 1,
      });
      return id;
    },
    getBulletList: () => bullets.map((b) => ({ id: b.id, char: b.char, rawCode: b.char.codePointAt(0) })),
    ensureDefaultBullet: (ch: string) => {
      record('ensureDefaultBullet', ch);
      const found = bullets.find((b) => b.char === ch);
      if (found) return found.id;
      const id = bullets.length + 1;
      bullets.push({ id, char: ch });
      return id;
    },
    setNumberingRestart: (...a: unknown[]) => { record('setNumberingRestart', ...a); return okJson(); },
    // ─ 기타 ─
    setFieldValueByName: () => ({ ok: true }),
    getSourceFormat: () => 'hwpx',
    get documentDigest() { return 'blake3:verify-list'; },
    getFieldList: () => [],
    renderPageSvg: () => '<svg/>',
    getSelectionRects: () => [],
    getSelectionRectsInCell: () => [],
  };

  let snapshotId = 0;
  const snapshots = new Map<number, {
    body: string[]; bodyParaShapes: number[]; tables: FakeTable[];
    numberings: typeof numberings; bullets: typeof bullets;
  }>();
  Object.assign(wasm, {
    saveSnapshot: () => {
      const id = ++snapshotId;
      snapshots.set(id, {
        body: structuredClone(body),
        bodyParaShapes: structuredClone(bodyParaShapes),
        tables: structuredClone(tables),
        numberings: structuredClone(numberings),
        bullets: structuredClone(bullets),
      });
      return id;
    },
    restoreSnapshot: (id: number) => {
      const saved = snapshots.get(id)!;
      body.splice(0, body.length, ...structuredClone(saved.body));
      bodyParaShapes.splice(0, bodyParaShapes.length, ...structuredClone(saved.bodyParaShapes));
      tables.splice(0, tables.length, ...structuredClone(saved.tables));
      numberings.splice(0, numberings.length, ...structuredClone(saved.numberings));
      bullets.splice(0, bullets.length, ...structuredClone(saved.bullets));
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
  return { call, pending, revision, body, tables, numberings, bullets, calls, executor };
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

// ─── apply_list ─────────────────────────────────────────────

test('apply_list: 새 번호 정의를 만들고 문단별 paraFormat op 을 건다', async () => {
  const { call, calls, numberings } = makeEnv();
  const r = (await call('apply_list', {
    sectionIdx: 0, startParaIdx: 0, endParaIdx: 2, format: '1.',
  })) as { changeSetId: string; numberingId: number; paragraphs: number };
  assert.equal(r.numberingId, 1);
  assert.equal(r.paragraphs, 3);
  assert.equal(numberings.length, 1);
  const created = calls.find((c) => c.m === 'createNumbering')!.a[0] as {
    levelFormats: string[]; numberFormats: number[]; startNumber: number;
  };
  assert.equal(created.levelFormats[0], '^1.');
  assert.equal(created.numberFormats[0], 0); // DIGIT
  assert.equal(created.startNumber, 1);
  const applies = calls.filter((c) => c.m === 'applyParaFormat');
  assert.equal(applies.length, 3);
  for (const a of applies) {
    assert.deepEqual(JSON.parse(a.a[1] as string), { headType: 'Number', numberingId: 1, paraLevel: 0 });
  }
});

test('apply_list: 레벨 서식과 시작 번호가 모두 같은 기존 정의는 재사용한다', async () => {
  const { call, calls, numberings } = makeEnv();
  numberings.push({
    id: 1,
    levelFormats: ['^1.', '^2.', '^3)', '^4)', '(^5)', '(^6)', '^7'],
    numberFormats: [0, 8, 0, 8, 0, 8, 1],
    startNumber: 1,
  });
  const r = (await call('apply_list', {
    sectionIdx: 0, startParaIdx: 0, endParaIdx: 1, format: '1.',
  })) as { numberingId: number };
  assert.equal(r.numberingId, 1); // 재사용 — 새 정의 없음
  assert.equal(numberings.length, 1);
  assert.ok(!calls.some((c) => c.m === 'createNumbering'));
  // pending 밖 문서 변경 금지 — 문단 재시작을 직접 쓰지 않는다
  assert.ok(!calls.some((c) => c.m === 'setNumberingRestart'));
});

test('apply_list: 시작 번호가 다르면 재사용하지 않고 startNumber 를 품은 새 정의를 만든다', async () => {
  const { call, calls, numberings } = makeEnv();
  numberings.push({
    id: 1,
    levelFormats: ['^1.', '^2.', '^3)', '^4)', '(^5)', '(^6)', '^7'],
    numberFormats: [0, 8, 0, 8, 0, 8, 1],
    startNumber: 1,
  });
  const r = (await call('apply_list', {
    sectionIdx: 0, startParaIdx: 0, endParaIdx: 1, format: '1.', startNumber: 3,
  })) as { numberingId: number };
  assert.equal(r.numberingId, 2); // 시작 번호 불일치 → 신규 정의
  assert.equal(numberings.length, 2);
  const created = calls.find((c) => c.m === 'createNumbering')!.a[0] as { startNumber: number };
  assert.equal(created.startNumber, 3);
  // setNumberingRestart 는 pending 을 우회하는 문서 변경이라 호출하면 안 된다
  assert.ok(!calls.some((c) => c.m === 'setNumberingRestart'));
});

test('apply_list: 패턴은 같지만 번호 유형 코드가 일치하지 않으면 재사용하지 않고 새 정의를 만든다', async () => {
  const { call, calls, numberings } = makeEnv();
  // 문서 기본 정의: level 1 패턴 '^1.' 은 같지만 유형 코드는 HANGUL(8) — 요청 '1.'(DIGIT 0)과 다르다
  numberings.push({
    id: 1,
    levelFormats: ['^1.', '^2.', '^3)', '^4)', '(^5)', '(^6)', '^7'],
    numberFormats: [8, 8, 0, 8, 0, 8, 1],
    startNumber: 1,
  });
  const r = (await call('apply_list', {
    sectionIdx: 0, startParaIdx: 0, endParaIdx: 1, format: '1.',
  })) as { numberingId: number };
  assert.equal(r.numberingId, 2); // 코드 불일치 → 재사용 아닌 신규 정의
  assert.equal(numberings.length, 2);
  const created = calls.find((c) => c.m === 'createNumbering')!.a[0] as {
    levelFormats: string[]; numberFormats: number[];
  };
  assert.equal(created.levelFormats[0], '^1.');
  assert.equal(created.numberFormats[0], 0); // DIGIT
});

test('apply_list: level 2 의 (1) 형식은 ^3 패턴으로 생성된다', async () => {
  const { call, calls } = makeEnv();
  await call('apply_list', { sectionIdx: 0, startParaIdx: 0, endParaIdx: 0, format: '(1)', level: 2 });
  const created = calls.find((c) => c.m === 'createNumbering')!.a[0] as {
    levelFormats: string[]; numberFormats: number[];
  };
  assert.equal(created.levelFormats[2], '(^3)');
  assert.equal(created.numberFormats[2], 0);
  const apply = calls.find((c) => c.m === 'applyParaFormat')!;
  assert.deepEqual(JSON.parse(apply.a[1] as string), { headType: 'Number', numberingId: 1, paraLevel: 2 });
});

test('apply_list: bulletChar 는 ensureDefaultBullet + Bullet headType', async () => {
  const { call, calls } = makeEnv();
  const r = (await call('apply_list', {
    sectionIdx: 0, startParaIdx: 1, endParaIdx: 2, format: '1.', bulletChar: '•',
  })) as { numberingId: number };
  assert.equal(r.numberingId, 1);
  assert.ok(calls.some((c) => c.m === 'ensureDefaultBullet' && c.a[0] === '•'));
  const applies = calls.filter((c) => c.m === 'applyParaFormat');
  assert.equal(applies.length, 2);
  assert.deepEqual(JSON.parse(applies[0].a[1] as string), { headType: 'Bullet', numberingId: 1, paraLevel: 0 });
});

test('apply_list: 잘못된 format/범위 → INVALID_ARGS', async () => {
  const { call } = makeEnv();
  await expectErr(call('apply_list', { sectionIdx: 0, startParaIdx: 0, endParaIdx: 1, format: 'Z.' }), 'INVALID_ARGS');
  await expectErr(call('apply_list', { sectionIdx: 0, startParaIdx: 2, endParaIdx: 1, format: '1.' }), 'INVALID_ARGS');
  await expectErr(call('apply_list', { sectionIdx: 0, startParaIdx: 0, endParaIdx: 99, format: '1.' }), 'INVALID_ARGS');
});

// ─── list_numberings ────────────────────────────────────────

test('list_numberings: 번호/글머리표 정의 목록을 반환한다', async () => {
  const { call, numberings, bullets } = makeEnv();
  numberings.push({ id: 1, levelFormats: ['^1.'], numberFormats: [0], startNumber: 1 });
  bullets.push({ id: 1, char: '●' });
  const r = (await call('list_numberings')) as {
    revision: number;
    numberings: Array<{ id: number; levelFormats: string[] }>;
    bullets: Array<{ id: number; char: string }>;
  };
  assert.equal(r.numberings.length, 1);
  assert.equal(r.numberings[0].levelFormats[0], '^1.');
  assert.equal(r.bullets[0].char, '●');
  assert.equal(typeof r.revision, 'number');
});

// ─── get_para_format / get_char_format ──────────────────────

test('get_para_format: 목록 속성 + 정렬/간격을 pt 로 환산해 반환한다', async () => {
  const { call } = makeEnv();
  const r = (await call('get_para_format', { sectionIdx: 0, paraIdx: 1 })) as Record<string, unknown>;
  assert.equal(r['headType'], 'number'); // 소문자 정규화
  assert.equal(r['numberingId'], 7);
  assert.equal(r['paraLevel'], 2);
  assert.equal(r['alignment'], 'center');
  assert.equal(r['lineSpacingPercent'], 160);
  assert.equal(r['spaceBeforePt'], 6);   // 8px × 72/96
  assert.equal(r['marginLeftPt'], 15);   // 20px × 72/96
  const plain = (await call('get_para_format', { sectionIdx: 0, paraIdx: 0 })) as Record<string, unknown>;
  assert.equal(plain['headType'], 'none');
  assert.equal(plain['numberingId'], 0);
});

test('get_para_format: cell 주소로 셀 문단을 읽는다', async () => {
  const { call } = makeEnv();
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 3, charOffset: 0, cells: [['x']],
  })) as { table: { paraIdx: number; controlIdx: number } };
  const r = (await call('get_para_format', {
    sectionIdx: 0, paraIdx: 0,
    cell: { paraIdx: c.table.paraIdx, controlIdx: c.table.controlIdx, cellIdx: 0 },
  })) as Record<string, unknown>;
  assert.equal(r['headType'], 'bullet');
  assert.equal(r['paraLevel'], 1);
});

test('get_char_format: 글자 속성을 pt 환산과 함께 반환한다 (본문/셀)', async () => {
  const { call } = makeEnv();
  const r = (await call('get_char_format', { sectionIdx: 0, paraIdx: 0, charOffset: 1 })) as Record<string, unknown>;
  assert.equal(r['fontFamily'], '바탕');
  assert.equal(r['fontSizePt'], 11); // 1100 HWPUNIT
  assert.equal(r['bold'], true);
  assert.equal(r['underline'], true);
  assert.equal(r['textColor'], '#FF0000');
  assert.equal(r['charShapeId'], 4);
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 3, charOffset: 0, cells: [['x']],
  })) as { table: { paraIdx: number; controlIdx: number } };
  const rc = (await call('get_char_format', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0,
    cell: { paraIdx: c.table.paraIdx, controlIdx: c.table.controlIdx, cellIdx: 0 },
  })) as Record<string, unknown>;
  assert.equal(rc['fontFamily'], '맑은 고딕');
  assert.equal(rc['fontSizePt'], 9);
});

// ─── verify_changes ─────────────────────────────────────────

test('verify_changes: change-set 요약 + postEditText + 즉시 적용 삭제', async () => {
  const { call, body } = makeEnv();
  await call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'X' });
  const d = (await call('delete_range', {
    sectionIdx: 0, startParaIdx: 1, startCharOffset: 0, endParaIdx: 1, endCharOffset: 6,
  })) as { changeSetId: string; deletedText: string; collapsedAt: { paraIdx: number; charOffset: number } };
  assert.equal(d.deletedText, 'Second');
  assert.deepEqual(d.collapsedAt, { paraIdx: 1, charOffset: 0 });
  const r = (await call('verify_changes', {})) as {
    changeSetId: string; status: string;
    ops: Array<{ kind: string; applied: boolean }>;
    postEditText: Array<{ sectionIdx: number; paraIdx: number; text: string }>;
    warnings: string[]; revision: number;
  };
  assert.equal(r.changeSetId, d.changeSetId);
  assert.equal(r.ops.length, 2);
  assert.deepEqual(r.ops.map((o) => o.kind), ['insert', 'delete']);
  assert.equal(r.ops[0].applied, true);  // insert — 즉시 적용
  assert.equal(r.ops[1].applied, true);  // delete — 빈 교체로 즉시 적용 (미리보기 = 승인 후 상태)
  // 삭제가 라이브 미리보기에 이미 반영되어 있다
  const p0 = r.postEditText.find((p) => p.paraIdx === 0)!;
  const p1 = r.postEditText.find((p) => p.paraIdx === 1)!;
  assert.equal(p0.text, 'XFirst item');
  assert.equal(p1.text, ' item');
  assert.equal(body[1], ' item');
  assert.ok(!r.warnings.some((w) => w.includes('struck-through')));
  assert.equal(typeof r.revision, 'number');
});

test('verify_changes: 표 구조 op 경고 + 영향 페이지', async () => {
  const { call, tables } = makeEnv();
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 3, charOffset: 0, cells: [['a'], ['b']],
  })) as { table: { paraIdx: number; controlIdx: number } };
  await call('edit_table', {
    sectionIdx: 0, paraIdx: c.table.paraIdx, controlIdx: c.table.controlIdx, op: 'insert_row', rowIdx: 0,
  });
  assert.equal(tables[0].rows, 3);
  const r = (await call('verify_changes', {})) as {
    ops: Array<{ kind: string }>; warnings: string[]; affectedPages: number[];
  };
  assert.ok(r.ops.some((o) => o.kind === 'object:tableStructure'));
  assert.ok(r.warnings.some((w) => w.includes('cellIdx')));
  assert.deepEqual(r.affectedPages, [0]);
});

test('verify_changes: change set 이 없으면 경고만 반환한다', async () => {
  const { call } = makeEnv();
  const r = (await call('verify_changes', {})) as { changeSetId: string | null; warnings: string[] };
  assert.equal(r.changeSetId, null);
  assert.ok(r.warnings.some((w) => w.includes('no pending change set')));
});

test('verify_changes includeImage: 캔버스가 없으면 이미지 없이 경고로 degrade', async () => {
  const { call } = makeEnv();
  await call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'X' });
  const r = (await call('verify_changes', { includeImage: true })) as Record<string, unknown>;
  assert.equal(r['image'], undefined); // node 환경 — OffscreenCanvas/document 없음
  assert.ok((r['warnings'] as string[]).some((w) => w.includes('image skipped')));
});

test('verify_changes includeImage: withMarkedOpsApplied 로 승인 후 상태를 렌더한다', async () => {
  const { call, pending, body, calls } = makeEnv();
  // 삭제는 즉시 적용된다 — 미리보기가 곧 승인 후 상태
  await call('delete_range', {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 5,
  });
  let speculative = 0;
  const orig = pending.withMarkedOpsApplied.bind(pending);
  (pending as { withMarkedOpsApplied: unknown }).withMarkedOpsApplied =
    (id: string, fn: () => unknown) => { speculative++; return orig(id, fn); };
  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(w: number, h: number) { this.width = w; this.height = h; }
    async convertToBlob(): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }> {
      return { arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
    }
  }
  (globalThis as Record<string, unknown>)['OffscreenCanvas'] = FakeOffscreenCanvas;
  try {
    const r = (await call('verify_changes', { includeImage: true })) as {
      image: { data: string; mimeType: string }; imagePageIndex: number;
    };
    assert.equal(speculative, 1); // 승인 후 상태 래퍼를 거쳤다
    assert.equal(r.image.mimeType, 'image/png');
    assert.equal(r.image.data, 'AQIDBA=='); // [1,2,3,4] base64
    assert.equal(r.imagePageIndex, 0);
    // 렌더 시점의 본문은 삭제가 적용된('First' 제거) 상태 — 라이브 미리보기와 동일
    const render = calls.find((c) => c.m === 'renderPageToCanvas')!;
    assert.equal(render.a[1], ' item');
    assert.equal(body[0], ' item'); // 삭제는 즉시 적용 — 렌더 전후 동일
  } finally {
    delete (globalThis as Record<string, unknown>)['OffscreenCanvas'];
  }
});

// ─── find_text scalar 오프셋 ────────────────────────────────

test('find_text: emoji 가 있어도 charOffset/length 는 Unicode scalar 단위다', async () => {
  const { call, body } = makeEnv();
  body[0] = '😀 smile 😀!';
  const r = (await call('find_text', { query: '😀' })) as {
    matches: Array<{ paraIdx: number; charOffset: number; length: number }>;
  };
  assert.equal(r.matches.length, 2);
  // UTF-16 인덱스라면 두 번째 매치는 9 — scalar 단위로는 😀=1자라 8 이 맞다
  assert.deepEqual(r.matches.map((m) => [m.charOffset, m.length]), [[0, 1], [8, 1]]);
  const r2 = (await call('find_text', { query: 'SMILE' })) as {
    matches: Array<{ charOffset: number; length: number }>;
  };
  assert.deepEqual(r2.matches.map((m) => [m.charOffset, m.length]), [[2, 5]]); // 대소문자 무시 경로도 원본 기준
});

// ─── 기타 executor 수정 ─────────────────────────────────────

test('insert_text: \\r\\n/\\r 은 \\n 으로 정규화해 문단을 나눈다', async () => {
  const { call, body } = makeEnv();
  await call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'a\r\nb\rc' });
  assert.deepEqual(body.slice(0, 4), ['a', 'b', 'cFirst item', 'Second item']);
});

test('insert_text: 10000자 초과 오류는 분할 호출을 안내한다', async () => {
  const { call } = makeEnv();
  const err = await expectErr(
    call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x'.repeat(10001) }),
    'INVALID_ARGS',
  );
  assert.match(err.message, /multiple insert_text calls/);
});

test('PENDING_DESTRUCTIVE_OP: insert_row pending 중 같은 표의 셀 편집도 차단된다', async () => {
  const { call, tables } = makeEnv();
  const c = (await call('create_table', {
    sectionIdx: 0, paraIdx: 3, charOffset: 0, cells: [['a'], ['b']],
  })) as { table: { paraIdx: number; controlIdx: number } };
  await call('edit_table', {
    sectionIdx: 0, paraIdx: c.table.paraIdx, controlIdx: c.table.controlIdx, op: 'insert_row', rowIdx: 0,
  });
  assert.equal(tables[0].rows, 3); // insert_row 는 즉시 적용됐다
  // applied-now 구조 op 도 삽입 행부터 아래로 cellIdx 를 밀므로 그 행의 셀 편집은 차단된다
  const err = await expectErr(call('insert_text', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x',
    cell: { paraIdx: c.table.paraIdx, controlIdx: c.table.controlIdx, cellIdx: 1 },
  }), 'PENDING_DESTRUCTIVE_OP');
  assert.match(err.message, /next turn/);
  assert.match(err.message, /insert_row at row 1/);
  // 삽입 행보다 앞선 행 0 의 셀은 번호가 그대로라 통과한다
  await call('insert_text', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x',
    cell: { paraIdx: c.table.paraIdx, controlIdx: c.table.controlIdx, cellIdx: 0 },
  });
  // 구조 op 이 있는 동안은 후속 구조 op 도 차단된다
  await expectErr(call('edit_table', {
    sectionIdx: 0, paraIdx: c.table.paraIdx, controlIdx: c.table.controlIdx, op: 'insert_col', colIdx: 0,
  }), 'PENDING_DESTRUCTIVE_OP');
});

test('apply_char_format: startOffset === endOffset (zero-length) → INVALID_ARGS', async () => {
  const { call } = makeEnv();
  await expectErr(call('apply_char_format', {
    sectionIdx: 0, paraIdx: 0, startOffset: 3, endOffset: 3, bold: true,
  }), 'INVALID_ARGS');
});

test('apply_para_format: 목록 키(headType/numberingId/paraLevel/bulletChar) 매핑', async () => {
  const { call, calls } = makeEnv();
  await call('apply_para_format', {
    sectionIdx: 0, paraIdx: 0, headType: 'number', numberingId: 3, paraLevel: 2,
  });
  const apply = calls.find((c) => c.m === 'applyParaFormat')!;
  assert.deepEqual(JSON.parse(apply.a[1] as string), { headType: 'Number', numberingId: 3, paraLevel: 2 });
  calls.length = 0;
  await call('apply_para_format', { sectionIdx: 0, paraIdx: 1, bulletChar: '•' });
  const bullet = calls.find((c) => c.m === 'applyParaFormat')!;
  assert.deepEqual(JSON.parse(bullet.a[1] as string), { headType: 'Bullet', numberingId: 1 });
  await expectErr(call('apply_para_format', { sectionIdx: 0, paraIdx: 0, headType: 'weird' }), 'INVALID_ARGS');
});

test('render_page: format png 는 캔버스 없는 환경에서 RENDER_UNAVAILABLE', async () => {
  const { executor, revision } = makeEnv();
  await expectErr(
    executor.execute('render_page', { pageIndex: 0, format: 'png' }, 'claude'),
    'RENDER_UNAVAILABLE',
  );
  // svg 는 여전히 동작한다
  const r = (await executor.execute('render_page', { pageIndex: 0 }, 'claude')) as { svg: string; revision: number };
  assert.equal(r.svg, '<svg/>');
  assert.equal(r.revision, revision.revision);
});

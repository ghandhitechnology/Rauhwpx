/**
 * 텍스트 앵커 (anchor) — 숫자 좌표 대신 매치 텍스트로 쓰기 위치를 지정하는 계약 검증.
 *
 * executor → 실제 PendingEditManager → 가짜 wasm 통합 경로로
 * 해석(occurrence/within/position), 오류 진단, 배치 내 진화 문서 해석,
 * 결과 주소 에코, 롤백을 검증한다. 허브 측 스키마/혼용 검증은 tools.test.mjs 가 본다.
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
  /** flat cellIdx → 셀 문단 텍스트 배열 */
  cells: string[][];
}

function makeEnv(initialBody: string[]) {
  const body = [...initialBody];
  const bodyParaShapes = body.map((_, i) => 10 + i);
  const tables: FakeTable[] = [];
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
    getParagraphLength: (_s: number, p: number) => body[p].length,
    getTextRange: (_s: number, p: number, off: number, cnt: number) => body[p].slice(off, off + cnt),
    insertText: (_s: number, p: number, off: number, t: string) => {
      body[p] = body[p].slice(0, off) + t + body[p].slice(off);
      return okJson({ charOffset: off + t.length });
    },
    splitParagraph: (_s: number, p: number, off: number) => {
      const cur = body[p];
      body.splice(p, 1, cur.slice(0, off), cur.slice(off));
      bodyParaShapes.splice(p, 1, bodyParaShapes[p], bodyParaShapes[p]);
      for (const t of tables) if (t.paraIdx > p) t.paraIdx += 1;
      return okJson();
    },
    splitParagraphLogical(this: { splitParagraph(s: number, p: number, o: number): string }, s: number, p: number, o: number) {
      return this.splitParagraph(s, p, o);
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
      controls: tables.map((t) => ({ type: 'table', secIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx })),
    }),
    // ─ 표 셀 ─
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
    splitParagraphInCellLogical(this: { splitParagraphInCell: (...a: number[]) => string }, ...a: number[]) {
      return this.splitParagraphInCell(...a);
    },
    deleteRangeInCell: (_s: number, para: number, ctrl: number, cell: number, sp: number, so: number, ep: number, eo: number) => {
      const ft = findTable(para, ctrl);
      ft.cells[cell].splice(sp, ep - sp + 1, ft.cells[cell][sp].slice(0, so) + ft.cells[cell][ep].slice(eo));
      return { ok: true, paraIdx: sp, charOffset: so };
    },
    // ─ 서식 ─
    getCharPropertiesAt: () => ({ fontFamily: '바탕' }),
    getCellCharPropertiesAt: () => ({ fontFamily: '바탕' }),
    applyCharFormat: (...a: unknown[]) => { record('applyCharFormat', ...a); return okJson(); },
    applyCharFormatInCell: (...a: unknown[]) => { record('applyCharFormatInCell', ...a); return okJson(); },
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
    findOrCreateFontId: (name: string) => (name === '바탕' ? 0 : 1),
    // ─ 기타 ─
    getSourceFormat: () => 'hwpx',
    getFieldList: () => [],
    getDocumentInfo: () => ({
      version: '5.0', sectionCount: 1, pageCount: 1, encrypted: false,
      fallbackFont: '바탕', fontsUsed: ['바탕'],
    }),
  };

  let snapshotId = 0;
  const snapshots = new Map<number, { body: string[]; shapes: number[]; tables: FakeTable[] }>();
  Object.assign(wasm, {
    saveSnapshot: () => {
      const id = ++snapshotId;
      snapshots.set(id, {
        body: structuredClone(body),
        shapes: structuredClone(bodyParaShapes),
        tables: structuredClone(tables),
      });
      return id;
    },
    restoreSnapshot: (id: number) => {
      const saved = snapshots.get(id)!;
      body.splice(0, body.length, ...structuredClone(saved.body));
      bodyParaShapes.splice(0, bodyParaShapes.length, ...structuredClone(saved.shapes));
      tables.splice(0, tables.length, ...structuredClone(saved.tables));
    },
    discardSnapshot: (id: number) => { snapshots.delete(id); },
    captureParagraph: (_s: number, p: number) => {
      record('captureParagraph', p);
      return ++snapshotId + 10_000;
    },
    restoreCapturedParagraph: (id: number, _s: number, p: number) => { record('restoreCapturedParagraph', p); },
    discardParagraphCapture: (_id: number) => {},
    getParagraphContentDigest: (_s: number, p: number) => JSON.stringify(body[p]),
  });

  const bus = new EventBus();
  const revision = new RevisionTracker(bus);
  const inputHandler = {
    executeOperation: (op: { operation?: (w: unknown) => unknown }) => { op.operation?.(wasm); },
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    getSelection: () => null,
    prepareSnapshotCapacity: () => {},
    retainExternalSnapshot: () => {},
    releaseExternalSnapshot: () => {},
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
    executor.execute(tool, { expectedRevision: revision.revision, ...args }, 'claude') as Promise<Record<string, unknown>>;
  return { call, pending, revision, body, tables, calls };
}

function addTable(env: ReturnType<typeof makeEnv>, paraIdx: number, cells: string[][]): FakeTable {
  const t: FakeTable = { paraIdx, controlIdx: 0, rows: cells.length, cols: cells[0].length, cells: cells.flat().map((c) => [c]) };
  env.tables.push(t);
  return t;
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

// ─── position 해석 ────────────────────────────────────────

test('insert_text + anchor: 기본(after)은 매치 뒤에 삽입하고 해석된 주소를 돌려준다', async () => {
  const h = makeEnv(['안녕 세계', '둘째 문단']);
  const r = await h.call('insert_text', { anchor: { text: '세계' }, text: '!' });
  assert.equal(h.body[0], '안녕 세계!');
  assert.deepEqual(r['anchor'], { sectionIdx: 0, paraIdx: 0, charOffset: 3, endCharOffset: 5 });
});

test('insert_text + anchor before: 매치 앞에 삽입된다', async () => {
  const h = makeEnv(['안녕 세계']);
  const r = await h.call('insert_text', { anchor: { text: '세계', position: 'before' }, text: '아름다운 ' });
  assert.equal(h.body[0], '안녕 아름다운 세계');
  assert.equal((r['anchor'] as Record<string, number>).charOffset, 3);
});

test('insert_text + anchor replace: 매치를 새 텍스트로 바꾼다', async () => {
  const h = makeEnv(['안녕 세계']);
  await h.call('insert_text', { anchor: { text: '세계', position: 'replace' }, text: 'world' });
  assert.equal(h.body[0], '안녕 world');
});

test('replace_range + anchor: 매치 자체가 범위다', async () => {
  const h = makeEnv(['짧은 보고서']);
  const r = await h.call('replace_range', { anchor: { text: '보고서' }, text: '요약' });
  assert.equal(h.body[0], '짧은 요약');
  assert.deepEqual(r['anchor'], { sectionIdx: 0, paraIdx: 0, charOffset: 3, endCharOffset: 6 });
});

test('delete_range + anchor: 매치가 지워지고 collapsedAt 이 매치 시작점이다', async () => {
  const h = makeEnv(['앞뒤 중간 뒤']);
  const r = await h.call('delete_range', { anchor: { text: '중간 ' } });
  assert.equal(h.body[0], '앞뒤 뒤');
  assert.deepEqual(r['collapsedAt'], { paraIdx: 0, charOffset: 3 });
});

// ─── 매치 수 계약 ─────────────────────────────────────────

test('anchor: 매치 없음 → INVALID_ARGS', async () => {
  const h = makeEnv(['있는 말만']);
  const e = await expectErr(h.call('delete_range', { anchor: { text: '없는말' } }), 'INVALID_ARGS');
  assert.match(e.message, /matched nothing/);
});

test('anchor: 모호한 매치는 INVALID_ARGS 와 최대 5개 후보를 낸다', async () => {
  const h = makeEnv(['단어 하나', '다른 단어 둘', '또 단어 셋', '마지막 단어 넷', '끝 단어 다섯', '여섯 단어 여섯']);
  const e = await expectErr(h.call('delete_range', { anchor: { text: '단어' } }), 'INVALID_ARGS');
  assert.match(e.message, /ambiguous/);
  assert.match(e.message, /occurrence/);
  // 후보는 최대 5개 — 매치가 6개여도 5개까지만 싣는다
  const candidates = e.message.match(/\d+\) s0 p\d+@\d+/g) ?? [];
  assert.equal(candidates.length, 5);
});

test('anchor occurrence: 1-based 로 n번째 매치를 고른다', async () => {
  const h = makeEnv(['반복 하나', '반복 둘']);
  await h.call('insert_text', { anchor: { text: '반복', occurrence: 2 }, text: '!' });
  assert.equal(h.body[0], '반복 하나');
  assert.equal(h.body[1], '반복! 둘');
  const e = await expectErr(
    h.call('insert_text', { anchor: { text: '반복', occurrence: 3 }, text: '!' }),
    'INVALID_ARGS',
  );
  assert.match(e.message, /occurrence 3 but only 2 match/);
});

// ─── within 스코프 ────────────────────────────────────────

test('anchor within.paraRange: 범위 밖 매치는 모호함 계산에서 제외된다', async () => {
  const h = makeEnv(['표시 상단', '무관', '표시 하단']);
  await h.call('insert_text', { anchor: { text: '표시', within: { paraRange: [2, 2] } }, text: '*' });
  assert.equal(h.body[2], '표시* 하단');
  assert.equal(h.body[0], '표시 상단');
  // 범위 안에 매치가 없고 밖에만 있으면 후보를 안내한다
  const e = await expectErr(
    h.call('insert_text', { anchor: { text: '무관', within: { paraRange: [0, 0] } }, text: 'x' }),
    'INVALID_ARGS',
  );
  assert.match(e.message, /outside/);
});

test('anchor within.paraRange: 뒤집힌 범위는 INVALID_ARGS', async () => {
  const h = makeEnv(['본문']);
  await expectErr(
    h.call('insert_text', { anchor: { text: '본문', within: { paraRange: [3, 1] } }, text: 'x' }),
    'INVALID_ARGS',
  );
});

test('anchor within.cell: 그 셀 안의 매치만 대상이 된다', async () => {
  const h = makeEnv(['본문 항목', '', '말미']);
  const t = addTable(h, 1, [['셀 항목', '다른'], ['셋째', '넷째']]);
  const r = await h.call('replace_range', {
    anchor: { text: '항목', within: { cell: { paraIdx: t.paraIdx, controlIdx: t.controlIdx, cellIdx: 0 } } },
    text: '교체',
  });
  assert.equal(t.cells[0][0], '셀 교체');
  assert.equal(h.body[0], '본문 항목', '본문 매치는 건드리지 않는다');
  const anchor = r['anchor'] as Record<string, unknown>;
  assert.deepEqual(anchor['cell'], { paraIdx: 1, controlIdx: 0, cellIdx: 0 });
});

test('anchor: 셀 매치가 유일하면 cell 좌표로 삽입된다', async () => {
  const h = makeEnv(['본문만']);
  const t = addTable(h, 0, [['표 안쪽', '나머지']]);
  const r = await h.call('insert_text', { anchor: { text: '안쪽' }, text: '!' });
  assert.equal(t.cells[0][0], '표 안쪽!');
  assert.equal((r['anchor'] as Record<string, unknown>)['cell'] !== undefined, true);
});

test('apply_char_format + anchor: 매치 범위에 서식이 적용된다', async () => {
  const h = makeEnv(['강조할 부분']);
  const r = await h.call('apply_char_format', { anchor: { text: '부분' }, bold: true });
  assert.equal(r['applied'], true);
  const call = h.calls.find((c) => c.m === 'applyCharFormat')!;
  assert.deepEqual(call.a.slice(0, 4), [0, 0, 4, 6]);
  assert.match(String(call.a[4]), /"bold":true/);
  // 범위 도구에서 before/after 는 거절한다
  await expectErr(
    h.call('apply_char_format', { anchor: { text: '부분', position: 'before' }, bold: true }),
    'INVALID_ARGS',
  );
});

test('apply_para_format + anchor: 매치 문단이 대상, before/after 는 이웃 문단', async () => {
  const h = makeEnv(['제목 줄', '본문 줄', '다음 줄']);
  await h.call('apply_para_format', { anchor: { text: '본문' }, alignment: 'center' });
  assert.deepEqual(h.calls.find((c) => c.m === 'applyParaFormat')!.a[0], 1);
  h.calls.length = 0;
  // after → 매치 문단의 다음 문단
  await h.call('apply_para_format', { anchor: { text: '본문', position: 'after' }, alignment: 'right' });
  assert.deepEqual(h.calls.find((c) => c.m === 'applyParaFormat')!.a[0], 2);
  // before → 첫 문단의 매치에 before 를 쓰면 실패
  await expectErr(
    h.call('apply_para_format', { anchor: { text: '제목', position: 'before' }, alignment: 'right' }),
    'INVALID_ARGS',
  );
});

// ─── 혼용/누락 ────────────────────────────────────────────

test('anchor + 숫자 좌표 혼용은 INVALID_ARGS', async () => {
  const h = makeEnv(['본문']);
  await expectErr(
    h.call('insert_text', { anchor: { text: '본문' }, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x' }),
    'INVALID_ARGS',
  );
  await expectErr(
    h.call('insert_text', { anchor: { text: '본문' }, cell: { paraIdx: 0, controlIdx: 0, cellIdx: 0 }, text: 'x' }),
    'INVALID_ARGS',
  );
});

// ─── apply_edits 배치 해석 ────────────────────────────────

test('apply_edits: 뒤 항목의 앵커는 앞 항목이 바꾼 문서 기준으로 해석된다', async () => {
  const h = makeEnv(['alpha beta']);
  const r = await h.call('apply_edits', {
    edits: [
      { tool: 'replace_range', args: { anchor: { text: 'alpha' }, text: 'delta' } },
      { tool: 'insert_text', args: { anchor: { text: 'delta' }, text: '!' } },
    ],
  });
  assert.equal(h.body[0], 'delta! beta');
  assert.equal(r['applied'], 2);
  const item2 = (r['results'] as Array<Record<string, unknown>>)[1];
  assert.equal((item2['anchor'] as Record<string, number>).charOffset, 0);
});

test('apply_edits: 뒤 항목 앵커가 실패하면 배치 전체가 롤백된다', async () => {
  const h = makeEnv(['alpha beta']);
  const e = await expectErr(
    h.call('apply_edits', {
      edits: [
        { tool: 'replace_range', args: { anchor: { text: 'alpha' }, text: 'zeta' } },
        // item1 이 'alpha' 를 지웠으므로 여기서 매치가 없다 → 배치 실패
        { tool: 'delete_range', args: { anchor: { text: 'alpha' } } },
      ],
    }),
    'INVALID_ARGS',
  );
  assert.match(e.message, /edits\[1\]/);
  assert.match(e.message, /rolled back/);
  assert.equal(h.body[0], 'alpha beta', '앞 항목 변경도 되돌아가야 한다');
  assert.equal(h.pending.hasPending(), false);
});

test('apply_edits: 앞 항목이 만든 모호함을 뒤 항목이 occurrence 로 해결한다', async () => {
  const h = makeEnv(['대상 하나']);
  const r = await h.call('apply_edits', {
    edits: [
      { tool: 'insert_text', args: { anchor: { text: '하나' }, text: ' 대상' } },
      { tool: 'apply_char_format', args: { anchor: { text: '대상', occurrence: 2 }, bold: true } },
    ],
  });
  assert.equal(h.body[0], '대상 하나 대상');
  const fmt = h.calls.find((c) => c.m === 'applyCharFormat')!;
  assert.deepEqual(fmt.a.slice(0, 4), [0, 0, 6, 8]);
  assert.equal(r['applied'], 2);
});

// ─── revision ─────────────────────────────────────────────

test('anchor 쓰기는 stale revision 이라도 저널이 덮는 정밀 편집만 있으면 통과한다', async () => {
  const h = makeEnv(['형제 문단', '내 문단']);
  const shared = h.revision.revision;
  // 형제 에이전트가 다른 문단을 편집해 revision 을 밀어 올린다
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'A' });
  // stale expectedRevision + 앵커 — 좌표 리베이스 없이 현재 문서 기준으로 해석돼 통과해야 한다
  const r = await h.call('insert_text', {
    expectedRevision: shared,
    anchor: { text: '내 문단' },
    text: '!',
  });
  assert.equal(h.body[1], '내 문단!');
  assert.equal(r['rebasedParaShift'], undefined, '앵커 쓰기는 리베이스 이동량을 보고하지 않는다');
});

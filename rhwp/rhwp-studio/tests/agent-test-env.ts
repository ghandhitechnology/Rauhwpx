/**
 * 에이전트 도구 실행기 통합 테스트 환경 — executor → 실제 PendingEditManager →
 * 가짜 wasm 경로. agent-text-anchors.test.ts 와 agent-cheap-reads.test.ts 가 공유한다.
 */
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { RevisionTracker } from '../src/agent/revision.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { AgentToolError } from '../src/agent/types.ts';

export interface FakeTable {
  paraIdx: number;
  controlIdx: number;
  rows: number;
  cols: number;
  /** flat cellIdx → 셀 문단 텍스트 배열 */
  cells: string[][];
}

/** extend 는 가짜 wasm 에 조판·표 프로브를 덧붙인다 (쓰기 결과 보고 테스트). */
export function makeEnv(
  initialBody: string[],
  extend?: (wasm: Record<string, unknown>, body: string[], tables: FakeTable[]) => void,
) {
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

  extend?.(wasm as unknown as Record<string, unknown>, body, tables);

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
  return { call, pending, revision, bus, body, tables, calls };
}

export function addTable(env: ReturnType<typeof makeEnv>, paraIdx: number, cells: string[][]): FakeTable {
  const t: FakeTable = { paraIdx, controlIdx: 0, rows: cells.length, cols: cells[0].length, cells: cells.flat().map((c) => [c]) };
  env.tables.push(t);
  return t;
}

export async function expectErr(p: Promise<unknown>, code: string): Promise<AgentToolError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AgentToolError, `AgentToolError 기대, 실제: ${e}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`${code} 오류를 기대했지만 성공함`);
}

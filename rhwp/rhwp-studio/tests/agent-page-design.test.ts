/**
 * 에이전트 쪽/문서 설계 (Phase 2: set_page_layout, edit_header_footer, insert_page_break) 테스트.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { RevisionTracker } from '../src/agent/revision.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { AgentToolError } from '../src/agent/types.ts';

function makeEnv() {
  const body = ['첫 문단', '둘째 문단'];
  const bodyParaShapes = [10, 11];
  let pageDef: Record<string, unknown> = {
    width: 59528, height: 84186, marginLeft: 8504, marginRight: 8504,
    marginTop: 5668, marginBottom: 4252, marginHeader: 4252, marginFooter: 4252,
    marginGutter: 0, landscape: false, binding: 0,
  };
  let columnDef = { columnCount: 1, columnType: 0, sameWidth: true, spacing: 1300 };
  /** key: `${isHeader}:${applyTo}` → 문단 텍스트 */
  const hfs = new Map<string, string>();
  const calls: Array<{ m: string; a: unknown[] }> = [];
  const record = (m: string, ...a: unknown[]) => { calls.push({ m, a }); };
  const okJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ ok: true, ...extra });

  const wasm = {
    getSectionCount: () => 1,
    getParagraphCount: () => body.length,
    getParagraphLength: (_s: number, p: number) => body[p].length,
    getTextRange: (_s: number, p: number, off: number, cnt: number) => body[p].slice(off, off + cnt),
    get pageCount() { return 2; },
    getPageDef: () => ({ ...pageDef }),
    setPageDef: (_s: number, def: Record<string, unknown>) => {
      record('setPageDef', { ...def });
      pageDef = { ...def };
      return { ok: true, pageCount: 2 };
    },
    getColumnDef: () => ({ ...columnDef }),
    setColumnDef: (_s: number, count: number, type: number, sameWidth: number, spacing: number) => {
      record('setColumnDef', count, type, sameWidth, spacing);
      columnDef = { columnCount: count, columnType: type, sameWidth: sameWidth !== 0, spacing };
      return okJson();
    },
    getHeaderFooter: (_s: number, isHeader: boolean, applyTo: number) => {
      const t = hfs.get(`${isHeader}:${applyTo}`);
      return t === undefined
        ? JSON.stringify({ ok: true, exists: false })
        : JSON.stringify({ ok: true, exists: true, paraCount: 1, text: t });
    },
    createHeaderFooter: (_s: number, isHeader: boolean, applyTo: number) => {
      record('createHeaderFooter', isHeader, applyTo);
      if (hfs.has(`${isHeader}:${applyTo}`)) throw new Error('이미 존재');
      hfs.set(`${isHeader}:${applyTo}`, '');
      return okJson({ kind: isHeader ? 'header' : 'footer', applyTo });
    },
    deleteHeaderFooter: (_s: number, isHeader: boolean, applyTo: number) => {
      record('deleteHeaderFooter', isHeader, applyTo);
      hfs.delete(`${isHeader}:${applyTo}`);
    },
    insertTextInHeaderFooter: (_s: number, isHeader: boolean, applyTo: number, _p: number, off: number, text: string) => {
      record('insertTextInHeaderFooter', isHeader, applyTo, off, text);
      const k = `${isHeader}:${applyTo}`;
      const cur = hfs.get(k) ?? '';
      hfs.set(k, cur.slice(0, off) + text + cur.slice(off));
      return okJson();
    },
    deleteTextInHeaderFooter: (_s: number, isHeader: boolean, applyTo: number, _p: number, off: number, count: number) => {
      record('deleteTextInHeaderFooter', isHeader, applyTo, off, count);
      const k = `${isHeader}:${applyTo}`;
      const cur = hfs.get(k) ?? '';
      hfs.set(k, cur.slice(0, off) + cur.slice(off + count));
      return okJson();
    },
    getHeaderFooterParaInfo: (_s: number, isHeader: boolean, applyTo: number) =>
      JSON.stringify({ ok: true, length: (hfs.get(`${isHeader}:${applyTo}`) ?? '').length }),
    insertFieldInHf: (_s: number, isHeader: boolean, applyTo: number, _p: number, off: number, fieldType: number) => {
      record('insertFieldInHf', isHeader, applyTo, off, fieldType);
      return { ok: true, charOffset: off + 1, insertedAt: off, insertedLength: 1 };
    },
    applyParaFormatInHf: (_s: number, isHeader: boolean, applyTo: number, _p: number, json: string) => {
      record('applyParaFormatInHf', isHeader, applyTo, json);
      return okJson();
    },
    getParaPropertiesAt: (_s: number, p: number) => ({ paraShapeId: bodyParaShapes[p] }),
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
    getPageControlLayout: () => ({ controls: [] }),
    setFieldValueByName: () => ({ ok: true }),
    getSourceFormat: () => 'hwpx',
    get documentDigest() { return 'blake3:page-test'; },
    getFieldList: () => [],
    renderPageSvg: () => '<svg/>',
    getSelectionRects: () => [],
    getSelectionRectsInCell: () => [],
  };

  let snapshotId = 0;
  const snapshots = new Map<number, {
    pageDef: Record<string, unknown>;
    columnDef: typeof columnDef;
    hfs: Map<string, string>;
    bodyParaShapes: number[];
  }>();
  Object.assign(wasm, {
    saveSnapshot: () => {
      const id = ++snapshotId;
      snapshots.set(id, {
        pageDef: structuredClone(pageDef),
        columnDef: structuredClone(columnDef),
        hfs: structuredClone(hfs),
        bodyParaShapes: structuredClone(bodyParaShapes),
      });
      return id;
    },
    restoreSnapshot: (id: number) => {
      const saved = snapshots.get(id)!;
      pageDef = structuredClone(saved.pageDef);
      columnDef = structuredClone(saved.columnDef);
      hfs.clear();
      for (const [key, value] of saved.hfs) hfs.set(key, value);
      bodyParaShapes.splice(0, bodyParaShapes.length, ...structuredClone(saved.bodyParaShapes));
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
  return {
    call, pending, calls, hfs,
    getPageDefNow: () => pageDef,
    getColumnDefNow: () => columnDef,
    getParaShape: (p: number) => bodyParaShapes[p],
  };
}

async function expectErr(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AgentToolError, `AgentToolError 기대, 실제: ${e}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`${code} 오류를 기대했지만 성공함`);
}

// ─── set_page_layout ────────────────────────────────────────

test('set_page_layout: A4 landscape 는 가로/세로 스왑 + reject 시 원상복구', async () => {
  const { call, pending, getPageDefNow } = makeEnv();
  const r = (await call('set_page_layout', {
    sectionIdx: 0, paper: 'A4', landscape: true,
  })) as { changeSetId: string };
  const d = getPageDefNow();
  assert.equal(d['landscape'], true);
  assert.ok((d['width'] as number) > (d['height'] as number)); // 가로가 길다
  assert.equal(d['height'], Math.round(210 * (7200 / 25.4)));
  pending.reject(r.changeSetId);
  const d2 = getPageDefNow();
  assert.equal(d2['landscape'], false);
  assert.equal(d2['width'], 59528);
});

test('set_page_layout: 여백 + 다단 설정, reject 는 다단도 복원한다', async () => {
  const { call, pending, getColumnDefNow, getPageDefNow } = makeEnv();
  const r = (await call('set_page_layout', {
    sectionIdx: 0, marginsMm: { left: 20, right: 20 }, columns: { count: 2, spacingMm: 8 },
  })) as { changeSetId: string };
  assert.equal(getPageDefNow()['marginLeft'], Math.round(20 * (7200 / 25.4)));
  assert.equal(getColumnDefNow().columnCount, 2);
  assert.equal(getColumnDefNow().spacing, Math.round(8 * (7200 / 25.4)));
  pending.reject(r.changeSetId);
  assert.equal(getColumnDefNow().columnCount, 1);
  assert.equal(getPageDefNow()['marginLeft'], 8504);
});

test('set_page_layout: 아무 키도 없으면 INVALID_ARGS', async () => {
  const { call } = makeEnv();
  await expectErr(call('set_page_layout', { sectionIdx: 0 }), 'INVALID_ARGS');
});

// ─── edit_header_footer ─────────────────────────────────────

test('edit_header_footer: 신규 꼬리말 + 쪽번호 필드는 즉시 적용, reject 시 삭제', async () => {
  const { call, pending, calls, hfs } = makeEnv();
  const r = (await call('edit_header_footer', {
    sectionIdx: 0, which: 'footer', text: '- ', pageNumber: 'center',
  })) as { changeSetId: string };
  assert.ok(calls.some((c) => c.m === 'createHeaderFooter'));
  assert.equal(hfs.get('false:0'), '- ');
  const field = calls.find((c) => c.m === 'insertFieldInHf')!;
  assert.equal(field.a[3], 1); // fieldType 1 = 쪽 번호
  const align = calls.find((c) => c.m === 'applyParaFormatInHf')!;
  assert.ok((align.a[2] as string).includes('center'));
  pending.reject(r.changeSetId);
  assert.ok(!hfs.has('false:0'));
});

test('edit_header_footer: 기존 머리말 수정은 mark-only, turn commit 시 교체', async () => {
  const { call, pending, hfs, calls } = makeEnv();
  hfs.set('true:0', '기존 머리말');
  const r = (await call('edit_header_footer', {
    sectionIdx: 0, which: 'header', text: '새 머리말',
  })) as { changeSetId: string; note: string };
  assert.ok(r.note.includes('replaced at the successful turn commit'));
  assert.equal(hfs.get('true:0'), '기존 머리말'); // 아직 그대로
  calls.length = 0;
  pending.approve(r.changeSetId);
  assert.equal(hfs.get('true:0'), '새 머리말');
  assert.ok(calls.some((c) => c.m === 'deleteTextInHeaderFooter'));
  assert.ok(!calls.some((c) => c.m === 'createHeaderFooter')); // 재생성 아님
});

test('edit_header_footer: 줄바꿈 포함 텍스트 거부', async () => {
  const { call } = makeEnv();
  await expectErr(call('edit_header_footer', {
    sectionIdx: 0, which: 'header', text: '두\n줄',
  }), 'INVALID_ARGS');
});

// ─── insert_page_break ──────────────────────────────────────

test('insert_page_break: pageBreakBefore 속성 적용 + reject 는 para shape 복원', async () => {
  const { call, pending, calls, getParaShape } = makeEnv();
  const r = (await call('insert_page_break', { sectionIdx: 0, paraIdx: 1 })) as { changeSetId: string };
  const apply = calls.find((c) => c.m === 'applyParaFormat')!;
  assert.equal(apply.a[0], 1);
  assert.ok((apply.a[1] as string).includes('pageBreakBefore'));
  assert.equal(getParaShape(1), 99);
  pending.reject(r.changeSetId);
  assert.equal(getParaShape(1), 11); // 원래 para shape 복원
});

test('insert_page_break → approve: 한 번의 스냅샷으로 확정', async () => {
  const { call, pending, calls, getParaShape } = makeEnv();
  const r = (await call('insert_page_break', { sectionIdx: 0, paraIdx: 0 })) as { changeSetId: string };
  pending.approve(r.changeSetId);
  assert.equal(getParaShape(0), 99);
  assert.equal(calls.filter((entry) => entry.m === 'applyParaFormat').length, 1);
  assert.equal(pending.hasPending(), false);
});

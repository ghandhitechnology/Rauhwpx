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
  let sectionDef: Record<string, unknown> = {
    pageNum: 0, pageNumType: 0, pictureNum: 0, tableNum: 0, equationNum: 0,
    columnSpacing: 0, defaultTabSpacing: 0, hideHeader: false, hideFooter: false,
    hideMasterPage: false, hideBorder: false, hideFill: false, hideEmptyLine: false,
  };
  /** key: `${isHeader}:${applyTo}` → HF 문단 배열 */
  const hfs = new Map<string, string[]>();
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
    getSectionDef: () => ({ ...sectionDef }),
    setSectionDef: (_s: number, def: Record<string, unknown>) => {
      record('setSectionDef', { ...def });
      sectionDef = { ...def };
      return { ok: true, pageCount: 2 };
    },
    getHeaderFooter: (_s: number, isHeader: boolean, applyTo: number) => {
      const t = hfs.get(`${isHeader}:${applyTo}`);
      return t === undefined
        ? JSON.stringify({ ok: true, exists: false })
        : JSON.stringify({ ok: true, exists: true, paraIndex: 0, paraCount: t.length, text: t.join('\n') });
    },
    createHeaderFooter: (_s: number, isHeader: boolean, applyTo: number) => {
      record('createHeaderFooter', isHeader, applyTo);
      if (hfs.has(`${isHeader}:${applyTo}`)) throw new Error('이미 존재');
      hfs.set(`${isHeader}:${applyTo}`, ['']);
      return okJson({ kind: isHeader ? 'header' : 'footer', applyTo });
    },
    deleteHeaderFooter: (_s: number, isHeader: boolean, applyTo: number) => {
      record('deleteHeaderFooter', isHeader, applyTo);
      hfs.delete(`${isHeader}:${applyTo}`);
    },
    insertTextInHeaderFooter: (_s: number, isHeader: boolean, applyTo: number, p: number, off: number, text: string) => {
      record('insertTextInHeaderFooter', isHeader, applyTo, p, off, text);
      const k = `${isHeader}:${applyTo}`;
      const paras = hfs.get(k) ?? [''];
      paras[p] = paras[p].slice(0, off) + text + paras[p].slice(off);
      hfs.set(k, paras);
      return okJson();
    },
    deleteTextInHeaderFooter: (_s: number, isHeader: boolean, applyTo: number, p: number, off: number, count: number) => {
      record('deleteTextInHeaderFooter', isHeader, applyTo, p, off, count);
      const k = `${isHeader}:${applyTo}`;
      const paras = hfs.get(k) ?? [''];
      paras[p] = paras[p].slice(0, off) + paras[p].slice(off + count);
      hfs.set(k, paras);
      return okJson();
    },
    getHeaderFooterParaInfo: (_s: number, isHeader: boolean, applyTo: number, hfParaIdx: number) => {
      const paras = hfs.get(`${isHeader}:${applyTo}`) ?? [''];
      return JSON.stringify({
        ok: true, paraCount: paras.length,
        charCount: paras[hfParaIdx]?.length ?? 0, text: paras[hfParaIdx] ?? '',
      });
    },
    replaceRangeInHeaderFooter: (_s: number, isHeader: boolean, applyTo: number,
      sp: number, so: number, ep: number, eo: number, text: string) => {
      record('replaceRangeInHeaderFooter', isHeader, applyTo, sp, so, ep, eo, text);
      const k = `${isHeader}:${applyTo}`;
      const paras = hfs.get(k);
      if (!paras || sp >= paras.length || ep >= paras.length) throw new Error('HF 문단 범위 초과');
      const lines = text.replace(/\r\n/g, '\n').split('\n');
      const merged = paras[sp].slice(0, so) + lines[0] + paras[ep].slice(eo);
      const next = [...paras.slice(0, sp), merged, ...lines.slice(1), ...paras.slice(ep + 1)];
      hfs.set(k, next);
      return { ok: true, hfParaIndex: sp + lines.length - 1, charOffset: lines[lines.length - 1].length };
    },
    insertFieldInHf: (_s: number, isHeader: boolean, applyTo: number, _p: number, off: number, fieldType: number) => {
      record('insertFieldInHf', isHeader, applyTo, off, fieldType);
      return { ok: true, charOffset: off + 1, insertedAt: off, insertedLength: 1 };
    },
    applyParaFormatInHf: (_s: number, isHeader: boolean, applyTo: number, hfParaIdx: number, json: string) => {
      record('applyParaFormatInHf', isHeader, applyTo, hfParaIdx, json);
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
    sectionDef: Record<string, unknown>;
    hfs: Map<string, string[]>;
    bodyParaShapes: number[];
  }>();
  Object.assign(wasm, {
    saveSnapshot: () => {
      const id = ++snapshotId;
      snapshots.set(id, {
        pageDef: structuredClone(pageDef),
        columnDef: structuredClone(columnDef),
        sectionDef: structuredClone(sectionDef),
        hfs: structuredClone(hfs),
        bodyParaShapes: structuredClone(bodyParaShapes),
      });
      return id;
    },
    restoreSnapshot: (id: number) => {
      const saved = snapshots.get(id)!;
      pageDef = structuredClone(saved.pageDef);
      columnDef = structuredClone(saved.columnDef);
      sectionDef = structuredClone(saved.sectionDef);
      hfs.clear();
      for (const [key, value] of saved.hfs) hfs.set(key, value);
      bodyParaShapes.splice(0, bodyParaShapes.length, ...structuredClone(saved.bodyParaShapes));
    },
    discardSnapshot: (id: number) => { snapshots.delete(id); },
  });

  // 문단 보관본 — HF 컨트롤을 품은 문단은 HF 내용까지 통째로 보관/복원한다
  let captureId = 0;
  const paraCaptures = new Map<number, { body: string; hfs: Map<string, string[]> }>();
  Object.assign(wasm, {
    captureParagraph: (_s: number, p: number) => {
      const id = ++captureId;
      paraCaptures.set(id, { body: body[p], hfs: structuredClone(hfs) });
      return id;
    },
    restoreCapturedParagraph: (id: number, _s: number, p: number) => {
      const saved = paraCaptures.get(id)!;
      body[p] = saved.body;
      hfs.clear();
      for (const [key, value] of saved.hfs) hfs.set(key, value);
      return okJson();
    },
    discardParagraphCapture: (id: number) => { paraCaptures.delete(id); },
    getParagraphContentDigest: (_s: number, p: number) => `digest:${body[p]}`,
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
    getSectionDefNow: () => sectionDef,
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

test('edit_header_footer: 신규 꼬리말 + 쪽번호 문단은 즉시 적용, reject 시 삭제', async () => {
  const { call, pending, calls, hfs } = makeEnv();
  const r = (await call('edit_header_footer', {
    sectionIdx: 0, which: 'footer', lines: ['- '], pageNumber: { template: '{n}', align: 'center' },
  })) as { changeSetId: string };
  assert.ok(calls.some((c) => c.m === 'createHeaderFooter'));
  assert.deepEqual(hfs.get('false:0'), ['- ', '\u{0015}']);
  const align = calls.find((c) => c.m === 'applyParaFormatInHf')!;
  assert.equal(align.a[2], 1); // 쪽번호는 마지막 문단
  assert.ok((align.a[3] as string).includes('center'));
  pending.reject(r.changeSetId);
  assert.ok(!hfs.has('false:0'));
});

test('edit_header_footer: pageNumber.template 의 {n}/{total} 은 필드 문자로 들어간다', async () => {
  const { call, hfs } = makeEnv();
  await call('edit_header_footer', {
    sectionIdx: 0, which: 'footer', pageNumber: { template: '- {n} / {total} -', align: 'right' },
  });
  assert.deepEqual(hfs.get('false:0'), ['- \u{0015} / \u{0016} -']);
});

test('edit_header_footer: template 에 {n}·{total} 이 없으면 거부', async () => {
  const { call } = makeEnv();
  await expectErr(call('edit_header_footer', {
    sectionIdx: 0, which: 'footer', pageNumber: { template: 'page only' },
  }), 'INVALID_ARGS');
});

test('edit_header_footer: lines[] 는 문단 단위로 들어가고 빈 줄도 보존된다', async () => {
  const { call, hfs } = makeEnv();
  await call('edit_header_footer', {
    sectionIdx: 0, which: 'header', lines: ['첫 줄', '', '셋째 줄'],
  });
  assert.deepEqual(hfs.get('true:0'), ['첫 줄', '', '셋째 줄']);
});

test('edit_header_footer: applyTo odd/even 은 엔진 값 2/1 로 매핑된다', async () => {
  const { call, calls, hfs } = makeEnv();
  await call('edit_header_footer', { sectionIdx: 0, which: 'header', applyTo: 'odd', lines: ['홀수'] });
  await call('edit_header_footer', { sectionIdx: 0, which: 'header', applyTo: 'even', lines: ['짝수'] });
  const creates = calls.filter((c) => c.m === 'createHeaderFooter');
  assert.deepEqual(creates.map((c) => c.a[1]), [2, 1]);
  assert.deepEqual(hfs.get('true:2'), ['홀수']);
  assert.deepEqual(hfs.get('true:1'), ['짝수']);
});

test('edit_header_footer: outside 쪽번호는 홀수-오른쪽/짝수-왼쪽 쌍을 원자적으로 만든다', async () => {
  const { call, pending, calls, hfs } = makeEnv();
  const r = (await call('edit_header_footer', {
    sectionIdx: 0, which: 'footer',
    pageNumber: { template: '{n}', align: 'outside' },
  })) as { changeSetId: string };
  const aligns = calls.filter((c) => c.m === 'applyParaFormatInHf');
  // applyTo 2(odd)=right, applyTo 1(even)=left
  const odd = aligns.find((c) => c.a[1] === 2)!;
  const even = aligns.find((c) => c.a[1] === 1)!;
  assert.ok((odd.a[3] as string).includes('right'));
  assert.ok((even.a[3] as string).includes('left'));
  assert.deepEqual(hfs.get('false:2'), ['\u{0015}']);
  assert.deepEqual(hfs.get('false:1'), ['\u{0015}']);
  pending.reject(r.changeSetId); // 한 세트로 되돌린다 — 둘 다 사라져야 한다
  assert.ok(!hfs.has('false:2'));
  assert.ok(!hfs.has('false:1'));
});

test('edit_header_footer: outside 쌍 — 기존 홀수 머리말은 보관본으로 되살리고 새 짝수는 지운다', async () => {
  const { call, pending, hfs } = makeEnv();
  hfs.set('true:2', ['기존 홀수 머리말']);
  const r = (await call('edit_header_footer', {
    sectionIdx: 0, which: 'header',
    pageNumber: { template: '{n}', align: 'outside' },
  })) as { changeSetId: string };
  assert.deepEqual(hfs.get('true:2'), ['\u{0015}']);
  assert.deepEqual(hfs.get('true:1'), ['\u{0015}']);
  pending.reject(r.changeSetId);
  assert.deepEqual(hfs.get('true:2'), ['기존 홀수 머리말']);
  assert.ok(!hfs.has('true:1'));
});

test('edit_header_footer: startPageNumber 는 SectionDef.pageNum 으로 들어가고 reject 가 복원한다', async () => {
  const { call, pending, calls, getSectionDefNow } = makeEnv();
  const r = (await call('edit_header_footer', {
    sectionIdx: 0, which: 'footer', pageNumber: { template: '{n}', align: 'center' },
    startPageNumber: 5,
  })) as { changeSetId: string };
  const setDef = calls.find((c) => c.m === 'setSectionDef')!;
  assert.equal((setDef.a[0] as Record<string, unknown>)['pageNum'], 5);
  assert.equal(getSectionDefNow()['pageNum'], 5);
  pending.reject(r.changeSetId);
  assert.equal(getSectionDefNow()['pageNum'], 0);
});

test('edit_header_footer: 인자가 하나도 없으면 INVALID_ARGS', async () => {
  const { call } = makeEnv();
  await expectErr(call('edit_header_footer', { sectionIdx: 0 }), 'INVALID_ARGS');
});

test('edit_header_footer: 기존 머리말은 바로 교체되고 reject 가 원래 내용을 되살린다', async () => {
  const { call, pending, hfs, calls } = makeEnv();
  hfs.set('true:0', ['기존 머리말']);
  const r = (await call('edit_header_footer', {
    sectionIdx: 0, which: 'header', lines: ['새 머리말'],
  })) as { changeSetId: string; note: string };
  assert.ok(r.note.includes('was replaced'));
  assert.deepEqual(hfs.get('true:0'), ['새 머리말']);
  assert.ok(calls.some((c) => c.m === 'replaceRangeInHeaderFooter'));
  assert.ok(!calls.some((c) => c.m === 'createHeaderFooter')); // 재생성 아님
  pending.reject(r.changeSetId);
  assert.deepEqual(hfs.get('true:0'), ['기존 머리말']);
});

test('edit_header_footer: 기존 다문단 머리말 교체 → 문단 보관본이 전체를 되살린다', async () => {
  const { call, pending, hfs } = makeEnv();
  hfs.set('true:0', ['첫째', '둘째', '셋째']);
  const r = (await call('edit_header_footer', {
    sectionIdx: 0, which: 'header', lines: ['하나'],
  })) as { changeSetId: string };
  assert.deepEqual(hfs.get('true:0'), ['하나']);
  pending.reject(r.changeSetId);
  assert.deepEqual(hfs.get('true:0'), ['첫째', '둘째', '셋째']);
});

test('edit_header_footer: 기존 머리말 교체 → approve 는 다시 쓰지 않고 채택한다', async () => {
  const { call, pending, hfs, calls } = makeEnv();
  hfs.set('true:0', ['기존 머리말']);
  const r = (await call('edit_header_footer', {
    sectionIdx: 0, which: 'header', lines: ['새 머리말'],
  })) as { changeSetId: string };
  calls.length = 0;
  assert.equal(pending.approve(r.changeSetId), true);
  assert.deepEqual(hfs.get('true:0'), ['새 머리말']);
  assert.ok(!calls.some((c) => c.m === 'replaceRangeInHeaderFooter'));
});

test('edit_header_footer: 줄바꿈 포함 lines 항목 거부', async () => {
  const { call } = makeEnv();
  await expectErr(call('edit_header_footer', {
    sectionIdx: 0, which: 'header', lines: ['두\n줄'],
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

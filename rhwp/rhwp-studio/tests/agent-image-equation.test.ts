/**
 * 에이전트 그림/수식 삽입 (Phase 2) 테스트.
 *
 * - insert_image: base64 디코드, mm/자연크기→HWPUNIT 변환, 본문 폭 캡, inline 전환,
 *   reject 시 deletePictureControl
 * - insert_equation: 삽입 전 렌더 검증 게이트(INVALID_SCRIPT), pt→HU/색 변환,
 *   reject 시 deleteEquationControl
 * - preview_equation: 삽입 없는 렌더
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { RevisionTracker } from '../src/agent/revision.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { AgentToolError } from '../src/agent/types.ts';

interface FakePic { paraIdx: number; controlIdx: number; widthHu: number; heightHu: number; ext: string; props: Record<string, unknown> }
interface FakeEq { paraIdx: number; controlIdx: number; script: string; fontSizeHu: number; colorRef: number; off: number }

function makeEnv() {
  const body = ['Hello world', ''];
  const pics: FakePic[] = [];
  const eqs: FakeEq[] = [];
  const calls: Array<{ m: string; a: unknown[] }> = [];
  const record = (m: string, ...a: unknown[]) => { calls.push({ m, a }); };

  const wasm = {
    getSectionCount: () => 1,
    getParagraphCount: () => body.length,
    getParagraphLength: (_s: number, p: number) => body[p].length,
    getTextRange: (_s: number, p: number, off: number, cnt: number) => body[p].slice(off, off + cnt),
    get pageCount() { return 1; },
    getPageDef: () => ({
      width: 59528, height: 84186, marginLeft: 8504, marginRight: 8504,
      marginTop: 5668, marginBottom: 4252, marginHeader: 4252, marginFooter: 4252,
      marginGutter: 0, landscape: false, binding: 0,
    }),
    insertPicture: (
      _s: number, paraIdx: number, _off: number, cellPath: string, data: Uint8Array,
      w: number, h: number, nw: number, nh: number, ext: string, desc: string,
    ) => {
      record('insertPicture', paraIdx, cellPath, data.length, w, h, nw, nh, ext, desc);
      const controlIdx = pics.length;
      pics.push({ paraIdx, controlIdx, widthHu: w, heightHu: h, ext, props: {} });
      return { ok: true, paraIdx, controlIdx };
    },
    setPictureProperties: (_s: number, para: number, ci: number, props: Record<string, unknown>) => {
      record('setPictureProperties', para, ci, props);
      const p = pics.find((x) => x.paraIdx === para && x.controlIdx === ci);
      if (p) Object.assign(p.props, props);
      return { ok: true };
    },
    deletePictureControl: (_s: number, para: number, ci: number) => {
      record('deletePictureControl', para, ci);
      const i = pics.findIndex((x) => x.paraIdx === para && x.controlIdx === ci);
      if (i < 0) return { ok: false };
      pics.splice(i, 1);
      return { ok: true };
    },
    getPictureProperties: (_s: number, para: number, ci: number) => {
      const p = pics.find((x) => x.paraIdx === para && x.controlIdx === ci);
      if (!p) throw new Error('그림 없음');
      return { width: p.widthHu, height: p.heightHu };
    },
    // Rust insert_equation_native 모사: 문단 내 위치(charOffset) 기반 splice —
    // 낮은 오프셋 삽입이 기존 컨트롤의 인덱스를 밀어낸다 (controlIdx 이동 회귀 테스트용).
    insertEquation: (_s: number, paraIdx: number, off: number, script: string, fontSizeHu: number, colorRef: number) => {
      record('insertEquation', paraIdx, script, fontSizeHu, colorRef);
      const inPara = eqs.filter((x) => x.paraIdx === paraIdx);
      const controlIdx = inPara.filter((x) => x.off <= off).length;
      const flatIdx = eqs.findIndex((x) => x.paraIdx === paraIdx && x.off > off);
      const entry = { paraIdx, controlIdx, script, fontSizeHu, colorRef, off };
      if (flatIdx < 0) eqs.push(entry);
      else eqs.splice(flatIdx, 0, entry);
      for (const e of eqs) {
        if (e.paraIdx === paraIdx) e.controlIdx = eqs.filter((x) => x.paraIdx === paraIdx).indexOf(e);
      }
      return { ok: true, paraIdx, controlIdx };
    },
    deleteEquationControl: (_s: number, para: number, ci: number) => {
      record('deleteEquationControl', para, ci);
      const i = eqs.findIndex((x) => x.paraIdx === para && x.controlIdx === ci);
      if (i < 0) return { ok: false };
      eqs.splice(i, 1);
      for (const e of eqs) {
        if (e.paraIdx === para) e.controlIdx = eqs.filter((x) => x.paraIdx === para).indexOf(e);
      }
      return { ok: true };
    },
    getEquationProperties: (_s: number, para: number, ci: number) => {
      const e = eqs.find((x) => x.paraIdx === para && x.controlIdx === ci);
      if (!e) throw new Error('수식 없음');
      return { script: e.script, fontSize: e.fontSizeHu, color: e.colorRef, baseline: 0, fontName: '' };
    },
    renderEquationPreview: (script: string, _fs: number, _c: number) => {
      record('renderEquationPreview', script);
      if (script.includes('BADTOKEN')) throw new Error('알 수 없는 토큰');
      return `<svg xmlns="http://www.w3.org/2000/svg"><text>${script}</text></svg>`;
    },
    getPageControlLayout: () => ({ controls: [] }),
    setFieldValueByName: () => ({ ok: true }),
    getSourceFormat: () => 'hwpx',
    get documentDigest() { return 'blake3:img-eq'; },
    getFieldList: () => [],
    renderPageSvg: () => '<svg/>',
    getSelectionRects: () => [],
    getSelectionRectsInCell: () => [],
  };

  let snapshotId = 0;
  const snapshots = new Map<number, { body: string[]; pics: FakePic[]; eqs: FakeEq[] }>();
  Object.assign(wasm, {
    saveSnapshot: () => {
      const id = ++snapshotId;
      snapshots.set(id, {
        body: structuredClone(body),
        pics: structuredClone(pics),
        eqs: structuredClone(eqs),
      });
      return id;
    },
    restoreSnapshot: (id: number) => {
      const saved = snapshots.get(id)!;
      body.splice(0, body.length, ...structuredClone(saved.body));
      pics.splice(0, pics.length, ...structuredClone(saved.pics));
      eqs.splice(0, eqs.length, ...structuredClone(saved.eqs));
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
  return { call, pending, pics, eqs, calls };
}

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64');

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

// ─── insert_image ───────────────────────────────────────────

test('insert_image: 자연 크기가 본문 폭을 넘으면 비율 유지로 캡 + inline 전환', async () => {
  const { call, pics, calls } = makeEnv();
  const r = (await call('insert_image', {
    sectionIdx: 0, paraIdx: 1, charOffset: 0,
    imageBase64: PNG_B64, extension: 'png', naturalWidthPx: 800, naturalHeightPx: 400,
  })) as { image: { paraIdx: number; controlIdx: number; widthMm: number } };
  // 800px*75 = 60000HU > 본문 42520HU → 캡
  const p = pics[0];
  assert.equal(p.widthHu, 42520);
  assert.equal(p.heightHu, 21260);
  assert.equal(p.props['treatAsChar'], true);
  assert.equal(r.image.paraIdx, 1);
  assert.ok(Math.abs(r.image.widthMm - 150) < 1);
  const ins = calls.find((c) => c.m === 'insertPicture')!;
  assert.equal(ins.a[1], ''); // 본문 삽입 (cellPath 없음)
});

test('insert_image: widthMm 지정 시 비율로 heightHu 산출', async () => {
  const { call, pics } = makeEnv();
  await call('insert_image', {
    sectionIdx: 0, paraIdx: 1, charOffset: 0,
    imageBase64: PNG_B64, extension: 'png', naturalWidthPx: 200, naturalHeightPx: 100,
    widthMm: 50,
  });
  assert.equal(pics[0].widthHu, 14173);
  assert.equal(pics[0].heightHu, Math.round(14173 / 2));
});

test('insert_image: 잘못된 base64/확장자/크기 → INVALID_ARGS', async () => {
  const { call } = makeEnv();
  const base = { sectionIdx: 0, paraIdx: 1, charOffset: 0, naturalWidthPx: 10, naturalHeightPx: 10 };
  await expectErr(call('insert_image', { ...base, imageBase64: '!!notbase64!!', extension: 'png' }), 'INVALID_ARGS');
  await expectErr(call('insert_image', { ...base, imageBase64: PNG_B64, extension: 'tiff' }), 'INVALID_ARGS');
  await expectErr(call('insert_image', { ...base, imageBase64: PNG_B64, extension: 'png', widthMm: -3 }), 'INVALID_ARGS');
});

test('insert_image → reject: deletePictureControl 로 사라진다', async () => {
  const { call, pending, pics } = makeEnv();
  const r = (await call('insert_image', {
    sectionIdx: 0, paraIdx: 1, charOffset: 0,
    imageBase64: PNG_B64, extension: 'png', naturalWidthPx: 10, naturalHeightPx: 10,
  })) as { changeSetId: string };
  assert.equal(pics.length, 1);
  pending.reject(r.changeSetId);
  assert.equal(pics.length, 0);
});

test('insert_image → approve: 미리보기 그림을 재삽입 없이 확정한다', async () => {
  const { call, pending, pics, calls } = makeEnv();
  const r = (await call('insert_image', {
    sectionIdx: 0, paraIdx: 1, charOffset: 0,
    imageBase64: PNG_B64, extension: 'png', naturalWidthPx: 10, naturalHeightPx: 10,
  })) as { changeSetId: string };
  pending.approve(r.changeSetId);
  assert.equal(pics.length, 1);
  assert.equal(calls.filter((entry) => entry.m === 'insertPicture').length, 1);
  assert.equal(pending.hasPending(), false);
});

// ─── insert_equation / preview_equation ─────────────────────

test('insert_equation: 렌더 검증 통과 후 pt→HU/색 변환으로 삽입', async () => {
  const { call, eqs, calls } = makeEnv();
  const r = (await call('insert_equation', {
    sectionIdx: 0, paraIdx: 0, charOffset: 5,
    script: 'x = {-b +- sqrt {b^2 - 4ac}} over {2a}', fontSizePt: 12, color: '#FF0000',
  })) as { equation: { paraIdx: number; controlIdx: number } };
  assert.ok(calls.findIndex((c) => c.m === 'renderEquationPreview') < calls.findIndex((c) => c.m === 'insertEquation'));
  assert.equal(eqs[0].fontSizeHu, 1200);
  assert.equal(eqs[0].colorRef, 0x0000ff); // '#FF0000' → r|g<<8|b<<16
  assert.equal(r.equation.paraIdx, 0);
});

test('insert_equation: 렌더 실패 스크립트는 INVALID_SCRIPT 로 거부되고 삽입되지 않는다', async () => {
  const { call, eqs } = makeEnv();
  await expectErr(call('insert_equation', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, script: 'BADTOKEN x over',
  }), 'INVALID_SCRIPT');
  assert.equal(eqs.length, 0);
});

test('insert_equation → reject: deleteEquationControl 로 사라진다', async () => {
  const { call, pending, eqs } = makeEnv();
  const r = (await call('insert_equation', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, script: 'sum _{k=1} ^{n} k',
  })) as { changeSetId: string };
  assert.equal(eqs.length, 1);
  pending.reject(r.changeSetId);
  assert.equal(eqs.length, 0);
});

test('preview_equation: 삽입 없이 SVG 만 반환', async () => {
  const { call, eqs } = makeEnv();
  const r = (await call('preview_equation', { script: '{a} over {b}' })) as { svg: string };
  assert.ok(r.svg.includes('<svg'));
  assert.equal(eqs.length, 0);
});

test('수식 스크립트 8000자 상한', async () => {
  const { call } = makeEnv();
  await expectErr(call('insert_equation', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, script: 'x'.repeat(8001),
  }), 'INVALID_ARGS');
});

// ─── insert_chart (Phase 3: 차트→PNG→그림 경로) ─────────────

test('insert_chart: 잘못된 spec 은 INVALID_ARGS (렌더 이전에 거부)', async () => {
  const { call } = makeEnv();
  await expectErr(call('insert_chart', {
    sectionIdx: 0, paraIdx: 1, charOffset: 0,
    spec: { type: 'pie', series: [{ name: 'a', values: [1] }, { name: 'b', values: [2] }] },
  }), 'INVALID_ARGS');
});

test('insert_chart: OffscreenCanvas 가 없는 환경에서는 CHART_RENDER_FAILED', async () => {
  const { call, pics } = makeEnv();
  await expectErr(call('insert_chart', {
    sectionIdx: 0, paraIdx: 1, charOffset: 0,
    spec: { type: 'bar', series: [{ name: '매출', values: [3, 5, 2] }], categories: ['1월', '2월', '3월'] },
  }), 'CHART_RENDER_FAILED');
  assert.equal(pics.length, 0); // 아무것도 삽입되지 않았다
});

test('낮은 오프셋의 두 번째 수식 삽입이 첫 수식 앵커를 밀어도 reject 가 둘 다 제거한다', async () => {
  const { call, pending, eqs } = makeEnv();
  const r1 = (await call('insert_equation', {
    sectionIdx: 0, paraIdx: 0, charOffset: 5, script: 'a^2',
  })) as { changeSetId: string; equation: { controlIdx: number } };
  assert.equal(r1.equation.controlIdx, 0);
  await call('insert_equation', {
    sectionIdx: 0, paraIdx: 0, charOffset: 2, script: 'b^2',
  });
  // splice 로 첫 수식이 controlIdx 1 로 밀렸다
  assert.equal(eqs.find((e) => e.script === 'a^2')!.controlIdx, 1);
  pending.reject(r1.changeSetId);
  assert.equal(eqs.length, 0); // 이전에는 스테일 앵커가 드리프트로 오판되어 수식이 잔류했다
});

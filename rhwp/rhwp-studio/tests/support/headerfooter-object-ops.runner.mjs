// [Task #825] 행위 러너 — 머리말/꼬리말 그림의 Undo/Redo 가 본문 인덱스 공간이 아니라
// setHeaderFooterPictureProperties 로 라우팅되는지 실제 command.ts 클래스를 로드해 검증한다.
//
// 머리말/꼬리말 그림의 paraIdx 는 머리말 내부 문단 인덱스라, 본문용
// setPictureProperties(sec, ppi, ci) 로 되돌리면 (1) 해당 인덱스에 그림이 없어 throw →
// CommandHistory.undo 가 항목을 버려 영구 undo 불가, 또는 (2) 우연히 같은 인덱스에 있는
// 본문 그림을 엉뚱하게 되돌린다. 그래서 "본문 setter 가 절대 불리지 않는다" 까지 단언한다.
//
// tests/support/drag-command-behaviour.runner.mjs 와 동일하게 부모 테스트가
// support/ts-transform-hooks.mjs 를 --import 로 등록해 spawn 한다. 실패 시 비정상 종료.
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

// @/ 별칭 + 확장자 없는 상대 import 를 .ts 로 해석(tsconfig paths 재현).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const abs = join(srcDir, specifier.slice(2));
      const withTs = abs.endsWith('.ts') ? abs : abs + '.ts';
      return { url: pathToFileURL(withTs).href, shortCircuit: true };
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[tj]s$/.test(specifier)) {
      const parent = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : srcDir;
      return { url: pathToFileURL(join(parent, specifier + '.ts')).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { MovePictureCommand, MoveShapeCommand, ResizeObjectCommand } =
  await import(pathToFileURL(join(srcDir, 'engine', 'command.ts')).href);

const HF = { kind: 'header', outerParaIdx: 4, outerControlIdx: 1 };

/**
 * mock WasmBridge — 호출된 setter 이름과 인자를 전부 기록한다.
 * 본문 setter 는 "불리면 안 되는" 경로라 호출 자체를 기록해 뒤에서 단언한다.
 */
function makeWasm(hfProps = { horzOffset: 1000, vertOffset: 2000 }) {
  const calls = [];
  return {
    calls,
    getHeaderFooterPictureProperties(...a) {
      calls.push(['getHF', a]);
      return { ...hfProps };
    },
    setHeaderFooterPictureProperties(...a) { calls.push(['setHF', a]); return { ok: true }; },
    getPictureProperties(...a) {
      calls.push(['getBody', a]);
      // 본문 경로로 새면 즉시 드러나도록 다른 값을 준다.
      return { horzOffset: -1, vertOffset: -1 };
    },
    setPictureProperties(...a) { calls.push(['setBody', a]); return { ok: true }; },
    getCellPicturePropertiesByPath(...a) { calls.push(['getCell', a]); return { horzOffset: -2, vertOffset: -2 }; },
    setCellPicturePropertiesByPath(...a) { calls.push(['setCell', a]); return { ok: true }; },
    getShapeProperties(...a) { calls.push(['getShape', a]); return { horzOffset: 500, vertOffset: 600 }; },
    setShapeProperties(...a) { calls.push(['setShape', a]); return { ok: true }; },
    getCellShapePropertiesByPath(...a) { calls.push(['getCellShape', a]); return { horzOffset: -3, vertOffset: -3 }; },
    setCellShapePropertiesByPath(...a) { calls.push(['setCellShape', a]); return { ok: true }; },
  };
}

function names(wasm) { return wasm.calls.map((c) => c[0]); }

function assertNoBodyPictureCall(wasm, label) {
  const leaked = names(wasm).filter((n) => n === 'getBody' || n === 'setBody' || n === 'setCell');
  assert.deepEqual(leaked, [], `${label}: 본문 그림 setter 로 새면 안 됨 (호출: ${names(wasm).join(',')})`);
}

// ── MovePictureCommand: 머리말 그림 이동의 execute/undo ──────────────────────
{
  const wasm = makeWasm();
  // sec=0, 머리말 내부 문단 3, 컨트롤 0 — 본문에는 존재하지 않는 좌표.
  const cmd = new MovePictureCommand(0, 3, 0, 700, -300, 1000, 2000, undefined, HF);

  cmd.execute(wasm);
  assert.deepEqual(wasm.calls[0], ['getHF', [0, 4, 1, 3, 0]],
    'execute 는 outerParaIdx/outerControlIdx 를 붙여 머리말 getter 를 써야 함');
  assert.deepEqual(wasm.calls[1],
    ['setHF', [0, 4, 1, 3, 0, { horzOffset: 1700, vertOffset: 1700 }]],
    'execute 는 머리말 setter 에 delta 를 더한 offset 을 적용해야 함');

  cmd.undo(wasm);
  assert.deepEqual(wasm.calls[2],
    ['setHF', [0, 4, 1, 3, 0, { horzOffset: 1000, vertOffset: 2000 }]],
    'undo 는 머리말 setter 로 원래 offset 을 복원해야 함');
  assertNoBodyPictureCall(wasm, 'MovePictureCommand(머리말)');
}

// ── MovePictureCommand: marker 없는 본문 그림은 기존 경로 유지 (회귀 방지) ──
{
  const wasm = makeWasm();
  const cmd = new MovePictureCommand(0, 3, 0, 700, -300, 1000, 2000);
  cmd.execute(wasm);
  cmd.undo(wasm);
  assert.deepEqual(names(wasm), ['getBody', 'setBody', 'setBody'],
    '본문 그림은 종전대로 본문 setter 를 써야 함');
}

// ── MovePictureCommand.mergeWith: 머리말/본문 혼동 병합 금지 ─────────────────
{
  const t = Date.now();
  const hfCmd = new MovePictureCommand(0, 3, 0, 10, 10, 0, 0, undefined, HF, t);
  const bodyCmd = new MovePictureCommand(0, 3, 0, 10, 10, 0, 0, undefined, undefined, t + 10);
  assert.equal(hfCmd.mergeWith(bodyCmd), null,
    'sec/ppi/ci 가 같아도 머리말 그림과 본문 그림은 병합하면 안 됨');
  assert.equal(bodyCmd.mergeWith(hfCmd), null, '반대 방향도 마찬가지');

  const hfCmd2 = new MovePictureCommand(0, 3, 0, 5, 5, 0, 0, undefined, { ...HF }, t + 20);
  const merged = hfCmd.mergeWith(hfCmd2);
  assert.notEqual(merged, null, '같은 머리말 그림의 연속 이동은 병합돼야 함');

  const wasm = makeWasm();
  merged.execute(wasm);
  assert.equal(wasm.calls[0][0], 'getHF', '병합 결과도 머리말 marker 를 유지해야 함');
  assert.deepEqual(wasm.calls[1], ['setHF', [0, 4, 1, 3, 0, { horzOffset: 1015, vertOffset: 2015 }]],
    '병합 결과는 delta 합(15)을 적용해야 함');
}

// ── MoveShapeCommand: 위치 인자 정렬 확인 (CmdClass 로 동적 생성되는 경로) ───
{
  const wasm = makeWasm();
  const cmd = new MoveShapeCommand(1, 2, 3, 50, 60, 500, 600, undefined, HF);
  cmd.execute(wasm);
  cmd.undo(wasm);
  assert.deepEqual(names(wasm), ['getShape', 'setShape', 'setShape'],
    '도형은 라이브 드래그(setObjectProperties)와 동일하게 도형 setter 를 써야 함');
  assert.deepEqual(wasm.calls[2], ['setShape', [1, 2, 3, { horzOffset: 500, vertOffset: 600 }]],
    'headerFooter 인자가 timestamp 자리를 밀어 먹으면 안 됨(위치 인자 정렬)');
  // headerFooter 를 timestamp 로 오해했다면 timestamp 가 NaN/객체가 된다.
  assert.equal(typeof cmd.timestamp, 'number', 'timestamp 는 숫자여야 함');
  assert.ok(Number.isFinite(cmd.timestamp), 'timestamp 는 유한한 숫자여야 함');
}

// ── ResizeObjectCommand: 머리말 그림 리사이즈/회전 기록 ─────────────────────
{
  const wasm = makeWasm();
  const cmd = new ResizeObjectCommand([{
    sec: 0, ppi: 3, ci: 0, type: 'image', headerFooter: HF,
    before: { width: 1000, height: 800 },
    after: { width: 2000, height: 1600 },
  }]);

  cmd.execute(wasm);
  assert.deepEqual(wasm.calls[0],
    ['setHF', [0, 4, 1, 3, 0, { width: 2000, height: 1600 }]],
    'execute(redo) 는 머리말 setter 로 after 를 적용해야 함');

  cmd.undo(wasm);
  assert.deepEqual(wasm.calls[1],
    ['setHF', [0, 4, 1, 3, 0, { width: 1000, height: 800 }]],
    'undo 는 머리말 setter 로 before 를 복원해야 함');
  assertNoBodyPictureCall(wasm, 'ResizeObjectCommand(머리말)');
}

// ── ResizeObjectCommand: 꼬리말 회전 + marker 없는 본문 타깃 혼재 ────────────
{
  const wasm = makeWasm();
  const footer = { kind: 'footer', outerParaIdx: 9, outerControlIdx: 2 };
  const cmd = new ResizeObjectCommand([
    {
      sec: 0, ppi: 0, ci: 0, type: 'image', headerFooter: footer,
      before: { rotationAngle: 0 }, after: { rotationAngle: 45 },
    },
    {
      sec: 0, ppi: 7, ci: 1, type: 'image',
      before: { rotationAngle: 0 }, after: { rotationAngle: 45 },
    },
  ]);

  cmd.undo(wasm);
  assert.deepEqual(names(wasm), ['setHF', 'setBody'],
    '꼬리말 타깃은 꼬리말 setter, 본문 타깃은 본문 setter 로 각각 분기해야 함');
  assert.deepEqual(wasm.calls[0],
    ['setHF', [0, 9, 2, 0, 0, { rotationAngle: 0 }]], '꼬리말 회전 복원 인자');
  assert.deepEqual(wasm.calls[1],
    ['setBody', [0, 7, 1, { rotationAngle: 0 }]], '본문 회전 복원 인자');
}

// ── ResizeObjectCommand: headerFooter 가 cellPath 보다 우선 ─────────────────
{
  const wasm = makeWasm();
  const cmd = new ResizeObjectCommand([{
    sec: 0, ppi: 3, ci: 0, type: 'image', headerFooter: HF,
    cellPath: [{ controlIndex: 0, cellIndex: 0, paraIndex: 0 }],
    before: { width: 10 }, after: { width: 20 },
  }]);
  cmd.undo(wasm);
  assert.deepEqual(names(wasm), ['setHF'],
    'headerFooter 가 있으면 cellPath by-path 경로보다 우선해야 함 (라이브 드래그와 동일)');
}

console.log('HEADERFOOTER_OBJECT_OPS_OK');

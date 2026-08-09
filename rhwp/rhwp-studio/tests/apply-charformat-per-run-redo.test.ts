import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ApplyCharFormatCommand 의 MIXED 서식 범위 redo per-run 복원 가드.
//
// Rust 측 apply_char_mods_to_paragraph(formatting.rs)가 MIXED 범위에서 run 별 base 서식을
// 보존(= run 별 파생 shape)하도록 바뀐 뒤, 범위 시작에서 샘플링한 단일 afterCharShapeId 를
// redo 에서 범위 전체에 setCharShapeId 하면 보존된 run 들이 하나의 서식으로 붕괴한다.
// 그래서 execute 가 before/after 모두 run(균일 charShapeId 구간) 단위 스팬으로 캡처하고,
// undo/redo 는 스팬별로 복원해야 한다. WASM 에 run 열거 export 가 없어 오프셋별
// getCharPropertiesAt 샘플링(sampleCharShapeSpans)으로 경계를 복원한다.
//
// node --test 는 strip-only TS 라 engine 클래스를 실행할 수 없어(이 저장소 undo 테스트
// 관례) 소스 배선을 정적으로 검증한다. 행위 증명(브라우저 undo/redo 왕복)은 PR 검증에서
// 별도 수행.

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const commandSrc = readFileSync(join(rootDir, 'src/engine/command.ts'), 'utf8');

function classBlock(name: string): string {
  const start = commandSrc.indexOf(`export class ${name}`);
  assert.notEqual(start, -1, `${name} 클래스 not found`);
  const rel = commandSrc.slice(start + 1).indexOf('\nexport class ');
  return rel === -1 ? commandSrc.slice(start) : commandSrc.slice(start, start + 1 + rel);
}

test('서식 이력은 문단당 단일 ID 가 아니라 run 단위 스팬(before/after)으로 캡처한다', () => {
  const block = classBlock('ApplyCharFormatCommand');
  assert.match(commandSrc, /interface CharShapeSpan \{/, 'run 스팬 타입 필요');
  assert.match(commandSrc, /beforeSpans: CharShapeSpan\[\]/, 'undo용 before run 스팬');
  assert.match(commandSrc, /afterSpans\?: CharShapeSpan\[\]/, 'redo용 after run 스팬');
  // 단일 ID 캡처가 남아 있으면 MIXED 범위 redo 붕괴가 재발한다.
  assert.doesNotMatch(commandSrc, /beforeCharShapeId/, '단일 beforeCharShapeId 캡처 금지');
  assert.doesNotMatch(commandSrc, /afterCharShapeId/, '단일 afterCharShapeId 캡처 금지');
  assert.match(
    block,
    /entries\.push\(\{\s*paraIndex: p,\s*beforeSpans,\s*afterSpans:/,
    '문단별 스팬 엔트리 축적',
  );
});

test('execute 는 서식 적용 전 run 경계를 샘플링하고 적용 후 run별 파생 shape 를 캡처한다', () => {
  const block = classBlock('ApplyCharFormatCommand');
  for (const applyCall of ['wasm.applyCharFormat(', 'wasm.applyCharFormatInCellByPath(']) {
    const applyIdx = block.indexOf(applyCall);
    assert.notEqual(applyIdx, -1, `${applyCall} 호출 not found`);
    const sampleIdx = block.lastIndexOf('sampleCharShapeSpans(', applyIdx);
    const deriveIdx = block.indexOf('deriveAfterSpans(', applyIdx);
    assert.ok(sampleIdx !== -1 && sampleIdx < applyIdx,
      `${applyCall} 전에 run 경계 샘플링(beforeSpans)이 와야 함`);
    assert.ok(deriveIdx !== -1, `${applyCall} 후에 after run 스팬 캡처가 와야 함`);
  }
});

test('run 경계 샘플링은 오프셋별 charShapeId 비교로 균일 구간을 자른다', () => {
  const fnIdx = commandSrc.indexOf('function sampleCharShapeSpans(');
  assert.notEqual(fnIdx, -1, 'sampleCharShapeSpans not found');
  const fnBlock = commandSrc.slice(fnIdx, fnIdx + 1200);
  // Rust char_shape_runs_in_range 와 동형: 오프셋을 순회하며 id 변경 지점을 경계로 삼는다.
  assert.match(fnBlock, /for \(let o = from \+ 1; o < to; o\+\+\)/, '오프셋 전수 순회');
  assert.match(fnBlock, /if \(id !== runId\)/, 'charShapeId 변경 지점에서 스팬 분할');
  assert.match(fnBlock, /endOffset: to/, '마지막 스팬은 범위 끝까지');
});

test('after 캡처는 Rust 의 run별 파생 규칙을 따라 전 스팬 시작만 샘플링하고 같은 파생 id 는 합친다', () => {
  const fnIdx = commandSrc.indexOf('function deriveAfterSpans(');
  assert.notEqual(fnIdx, -1, 'deriveAfterSpans not found');
  const fnBlock = commandSrc.slice(fnIdx, fnIdx + 1200);
  assert.match(fnBlock, /propsAt\(before\.startOffset\)/, '전 run 시작 오프셋에서 파생 id 샘플링');
  assert.match(fnBlock, /last\.charShapeId === charShapeId/, '인접 동일 파생 id 병합');
});

test('redo(재실행)는 before 가 아니라 after run 스팬을 복원한다', () => {
  const block = classBlock('ApplyCharFormatCommand');
  const eIdx = block.indexOf('execute(wasm: WasmBridge): DocumentPosition {');
  const uIdx = block.indexOf('undo(wasm: WasmBridge): DocumentPosition {');
  const execute = block.slice(eIdx, uIdx);
  assert.match(execute, /every\(\(entry\) => entry\.afterSpans !== undefined\)/,
    '재실행 판정은 afterSpans 캡처 완료 여부');
  assert.match(execute, /restoreCharShapeIds\(wasm, 'after'\)/, 'redo 는 after 스팬 복원');
  const undo = block.slice(uIdx);
  assert.match(undo, /restoreCharShapeIds\(wasm, 'before'\)/, 'undo 는 before 스팬 복원');
});

test('undo/redo 복원은 스팬별 setCharShapeId 호출이다(본문·셀 모두)', () => {
  const block = classBlock('ApplyCharFormatCommand');
  const rIdx = block.indexOf('private restoreCharShapeIds(');
  assert.notEqual(rIdx, -1, 'restoreCharShapeIds not found');
  const restore = block.slice(rIdx);
  assert.match(restore, /for \(const span of spans\)/, '스팬 순회 복원');
  assert.match(restore, /wasm\.setCharShapeId\([^)]*span\.startOffset, span\.endOffset, span\.charShapeId\)/s,
    '본문은 스팬 경계로 setCharShapeId');
  assert.match(restore, /wasm\.setCharShapeIdInCellByPath\([\s\S]*?span\.startOffset, span\.endOffset, span\.charShapeId\)/,
    '셀은 ...ByPath 로 스팬 경계 복원(중첩 셀 축 정합 유지)');
});

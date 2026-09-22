import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const commandSrc = readFileSync(join(rootDir, 'src/engine/command.ts'), 'utf8');

function classBlock(name: string): string {
  const start = commandSrc.indexOf(`export class ${name}`);
  assert.notEqual(start, -1, `${name} 클래스 not found`);
  const rel = commandSrc.slice(start + 1).indexOf('\nexport class ');
  return rel === -1 ? commandSrc.slice(start) : commandSrc.slice(start, start + 1 + rel);
}

test('서식 이력은 문단당 단일 ID 가 아니라 run 목록(before/after)으로 캡처한다', () => {
  const block = classBlock('ApplyCharFormatCommand');
  assert.match(commandSrc, /beforeRuns: CharShapeRun\[\]/, 'undo용 before run 목록');
  assert.match(commandSrc, /afterRuns\?: CharShapeRun\[\]/, 'redo용 after run 목록');
  assert.doesNotMatch(commandSrc, /beforeCharShapeId/, '단일 beforeCharShapeId 캡처 금지');
  assert.doesNotMatch(commandSrc, /afterCharShapeId/, '단일 afterCharShapeId 캡처 금지');
  assert.match(block, /beforeRuns: this\.readRuns\(/, '문단별 run 엔트리 축적');
});

test('execute 는 서식 적용 전 run 을 읽고 적용 후 run 을 캡처한다', () => {
  const block = classBlock('ApplyCharFormatCommand');
  const readIdx = block.indexOf('this.readRuns(');
  const applyIdx = block.indexOf('applyCharFormatToTarget(');
  const afterIdx = block.indexOf('entry.afterRuns = this.readRuns(');
  assert.ok(readIdx !== -1 && readIdx < applyIdx,
    '대상별 서식 적용 전에 beforeRuns 캡처가 와야 함');
  assert.ok(afterIdx > applyIdx, '대상별 서식 적용 후 afterRuns 를 캡처해야 함');
});

test('본문/셀 복원은 구간 API 한 호출이고 HF/FN 은 setCharShapeId 를 유지한다', () => {
  const block = classBlock('ApplyCharFormatCommand');
  assert.match(block, /wasm\.setCharShapeRuns\(/, '본문 원자 복원');
  assert.match(block, /wasm\.setCharShapeRunsInCellByPath\(/, '셀 원자 복원');
  assert.match(block, /setCharShapeIdAtTarget\(wasm, target, span\)/, 'HF/FN 스팬 복원');
  const execute = block.slice(block.indexOf('execute(wasm'), block.indexOf('undo(wasm'));
  assert.match(execute, /restoreCharShapeRuns\(wasm, 'after'\)/, 'redo 는 after run 복원');
  assert.match(block, /restoreCharShapeRuns\(wasm, 'before'\)/, 'undo 는 before run 복원');
});

test('적용 실패 시 부분 변경을 되돌리고 복원 실패는 retainOnFailure 로 남긴다', () => {
  const block = classBlock('ApplyCharFormatCommand');
  assert.match(block, /retainOnFailure\(\): boolean/, '실패 보존 훅');
  assert.match(block, /CharFormatRecoveryError/, '부분 복원 실패 오류');
  assert.match(block, /attempted\.reverse\(\)/, '적용한 문단부터 역순 rollback');
});

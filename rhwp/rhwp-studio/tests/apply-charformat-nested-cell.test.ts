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

test('ApplyCharFormatCommand 셀 서식 적용/복원이 최내곽 셀 대상 ...ByPath 로 라우팅한다', () => {
  const applyBlock = commandSrc.slice(
    commandSrc.indexOf('export function applyCharFormatToTarget('),
    commandSrc.indexOf('function setCharShapeIdAtTarget('),
  );
  assert.match(applyBlock, /applyCharFormatInCellByPath\(/, 'execute 는 applyCharFormatInCellByPath 로 최내곽 셀 적용');
  const block = classBlock('ApplyCharFormatCommand');
  assert.match(block, /getCharShapeRunsInCellByPath\(/, 'before/after run 은 ...ByPath 로 조회');
  assert.match(block, /setCharShapeRunsInCellByPath\(/, 'undo/redo 도 ...ByPath 로 복원');
  assert.match(commandSrc, /function useContainerPath\(/);
  assert.match(commandSrc, /target\.cellPath\.length > 1/, '중첩 컨테이너는 path 라우팅');
});

test('ApplyCharFormatCommand 는 컨테이너 target을 보존하고 legacy 시작 위치에 의존하지 않는다', () => {
  const block = classBlock('ApplyCharFormatCommand');
  assert.match(block, /target: range\.target/, '각 범위의 최내곽 target을 undo/redo에 보존');
  assert.doesNotMatch(block, /start\.cellParaIndex!/, '중첩 셀에서 start.cellParaIndex 는 바깥 셀 값 (cellParaIndexOf 사용)');
  assert.doesNotMatch(block, /end\.cellParaIndex!/, '중첩 셀에서 end.cellParaIndex 는 바깥 셀 값 (cellParaIndexOf 사용)');
});

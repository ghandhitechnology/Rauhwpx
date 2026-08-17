import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findWordSelectionRange } from '../src/engine/word-selection.ts';

const mouseHandler = readFileSync(
  new URL('../src/engine/input-handler-mouse.ts', import.meta.url),
  'utf8',
);

test('한글과 영문 단어의 전체 범위를 찾는다', () => {
  assert.deepEqual(findWordSelectionRange('안녕하세요 세계', 2), { start: 0, end: 5 });
  assert.deepEqual(findWordSelectionRange('hello world', 8), { start: 6, end: 11 });
});

test('문서 scalar offset을 astral 문자가 포함된 문자열에서도 유지한다', () => {
  assert.deepEqual(findWordSelectionRange('😀hello', 3), { start: 1, end: 6 });
});

test('구두점만 있는 위치에는 단어 선택을 만들지 않는다', () => {
  assert.equal(findWordSelectionRange('...', 1), null);
});

test('더블클릭은 텍스트 컨텍스트별 선택 anchor를 설정한다', () => {
  assert.match(mouseHandler, /if \(selectCurrentWord\(this\)\) e\.preventDefault\(\)/);
  assert.match(mouseHandler, /self\.cursor\.setHfAnchor\(\)/);
  assert.match(mouseHandler, /self\.cursor\.setFnAnchor\(\)/);
  assert.match(mouseHandler, /self\.cursor\.setAnchor\(\)/);
  assert.match(mouseHandler, /getTextInCellByPath/);
});

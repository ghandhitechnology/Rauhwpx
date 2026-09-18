import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findWordSelectionRange } from '../src/engine/word-selection.ts';
import { selectCurrentTableCell } from '../src/engine/table-cell-selection.ts';

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

function tableCellHarness(options: { protected?: boolean; textBoxDepth?: number } = {}) {
  const calls: string[] = [];
  const protectedCell = options.protected === true;
  const textBoxDepth = options.textBoxDepth ?? 0;
  const self = {
    active: false,
    cellSelectionDragCandidate: { stale: true },
    cursor: {
      isInCell: () => true,
      isInTextBox: () => textBoxDepth > 0,
      nestingDepth: () => textBoxDepth,
      isProtectedCellSelectionMode: () => protectedCell,
      clearSelection: () => calls.push('clear-text-selection'),
      exitCellSelectionMode: () => calls.push('exit-cell-selection'),
      enterCellSelectionMode: () => { calls.push('enter-cell-selection'); return true; },
    },
    stopTextSelectionDrag: () => calls.push('stop-text-drag'),
    caret: { hide: () => calls.push('hide-caret') },
    fieldMarker: { hide: () => calls.push('hide-field-marker') },
    selectionRenderer: { clear: () => calls.push('clear-text-renderer') },
    tableResizeRenderer: { clear: () => calls.push('clear-resize-renderer') },
    updateCellSelection: () => calls.push('render-cell-selection'),
    eventBus: { emit: (event: string) => calls.push(`emit:${event}`) },
    textarea: { focus: () => calls.push('focus') },
  };
  return { self, calls };
}

test('표 셀에서 더블클릭하면 현재 셀을 셀 선택 모드로 전환한다', () => {
  const { self, calls } = tableCellHarness();

  assert.equal(selectCurrentTableCell(self), true);
  assert.equal(self.active, true);
  assert.equal(self.cellSelectionDragCandidate, null);
  assert.ok(calls.indexOf('clear-text-selection') < calls.indexOf('enter-cell-selection'));
  assert.ok(calls.includes('render-cell-selection'));
  assert.ok(calls.includes('emit:command-state-changed'));
  assert.ok(calls.includes('focus'));
});

test('보호 셀 더블클릭은 보호 선택 사유를 유지한다', () => {
  const { self, calls } = tableCellHarness({ protected: true });

  assert.equal(selectCurrentTableCell(self), true);
  assert.equal(calls.includes('exit-cell-selection'), false);
  assert.equal(calls.includes('enter-cell-selection'), false);
  assert.ok(calls.includes('render-cell-selection'));
});

test('글상자 본문은 제외하고 글상자 안 중첩 표 셀은 선택한다', () => {
  const textBox = tableCellHarness({ textBoxDepth: 1 });
  assert.equal(selectCurrentTableCell(textBox.self), false);
  assert.deepEqual(textBox.calls, []);

  const nestedTable = tableCellHarness({ textBoxDepth: 2 });
  assert.equal(selectCurrentTableCell(nestedTable.self), true);
  assert.ok(nestedTable.calls.includes('enter-cell-selection'));
});

test('더블클릭 라우팅은 표 셀 선택을 단어 선택보다 먼저 시도한다', () => {
  const tableCell = mouseHandler.indexOf('if (selectCurrentTableCell(this))');
  const word = mouseHandler.lastIndexOf('if (selectCurrentWord(this))');
  assert.notEqual(tableCell, -1);
  assert.notEqual(word, -1);
  assert.ok(tableCell < word);
});

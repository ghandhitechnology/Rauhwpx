import test from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentPosition } from '../src/core/types.ts';
import { liftSelectionAcrossTables } from '../src/engine/selection-table-lift.ts';
import { selectedTablesInRange } from '../src/engine/selected-tables.ts';

const body = (paragraphIndex: number, charOffset = 0): DocumentPosition =>
  ({ sectionIndex: 0, paragraphIndex, charOffset });
const inner = (outerPara: number, cellPara: number, charOffset = 0): DocumentPosition => ({
  sectionIndex: 0, paragraphIndex: cellPara, charOffset, parentParaIndex: outerPara,
  controlIndex: 1, cellIndex: 0, cellParaIndex: cellPara,
  cellPath: [{ controlIndex: 1, cellIndex: 0, cellParaIndex: cellPara }],
});

test('마지막 본문 문단의 블록 표를 지나는 선택은 가상 뒤 경계까지 올린다', () => {
  const resolver = ({ after }: { after: boolean }) => ({ paraIdx: after ? 1 : 0, charOffset: after ? 1 : 3 });
  const forward = liftSelectionAcrossTables(body(0, 1), inner(1, 0), resolver);
  const backward = liftSelectionAcrossTables(inner(1, 0), body(2), resolver);
  assert.deepEqual(forward, { start: body(0, 1), end: body(1, 1) });
  assert.deepEqual(backward, { start: body(0, 3), end: body(2) });
});

test('본문과 셀 안 범위의 표 주소를 같은 선택 축에서 찾는다', () => {
  const calls: unknown[][] = [];
  const reader = {
    getParagraphCount: () => 3,
    getLogicalLength: () => 0,
    getTableControlsInSelection: (...args: unknown[]) => {
      calls.push(args);
      return [{ sec: 0, ppi: 1, ci: 1 }];
    },
  };
  assert.equal(selectedTablesInRange(reader, body(0), body(2)).length, 1);
  assert.deepEqual(calls[0], [0, 0, [], 0, 0, 2, 0]);
  const start = inner(1, 2, 4);
  const end = inner(1, 5, 0);
  assert.equal(selectedTablesInRange(reader, start, end).length, 1);
  assert.deepEqual(calls[1], [0, 1, start.cellPath, 2, 4, 5, 0]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { isLastTableCell, remapTableCellPosition, tableModelPathJson } from '../src/core/table-structural-cursor.ts';

test('last-cell Tab detection handles ordinary and merged terminal cells', () => {
  const table = { rowCount: 4, colCount: 3 };
  assert.equal(isLastTableCell({ row: 3, col: 2 }, table), true);
  assert.equal(isLastTableCell({ row: 2, col: 1, rowSpan: 2, colSpan: 2 }, table), true);
  assert.equal(isLastTableCell({ row: 3, col: 1 }, table), false);
  assert.equal(isLastTableCell({ row: 2, col: 2 }, table), false);
});

test('structural table remap updates flat and nested targets without mutating history positions', () => {
  const before = {
    sectionIndex: 0,
    paragraphIndex: 1,
    charOffset: 7,
    parentParaIndex: 2,
    controlIndex: 3,
    cellIndex: 5,
    cellParaIndex: 1,
    cellPath: [
      { controlIndex: 3, cellIndex: 0, cellParaIndex: 0 },
      { controlIndex: 1, cellIndex: 5, cellParaIndex: 1 },
    ],
  };

  const after = remapTableCellPosition(before, {
    cellIndex: 1,
    cellParaIndex: 0,
    charCount: 4,
  });

  assert.equal(after.cellIndex, 1);
  assert.equal(after.cellParaIndex, 0);
  assert.equal(after.paragraphIndex, 0);
  assert.equal(after.charOffset, 4);
  assert.equal(after.cellPath?.at(-1)?.cellIndex, 1);
  assert.equal(before.cellPath.at(-1)?.cellIndex, 5);
  assert.notEqual(after.cellPath, before.cellPath);
});

test('merge reset and flat fallback use an independent model path', () => {
  const before = {
    sectionIndex: 0,
    paragraphIndex: 2,
    charOffset: 9,
    parentParaIndex: 4,
    controlIndex: 6,
    cellIndex: 3,
    cellParaIndex: 2,
  };
  const after = remapTableCellPosition(before, {
    cellIndex: 0,
    cellParaIndex: 0,
    charCount: 20,
  }, true);

  assert.equal(after.charOffset, 0);
  assert.deepEqual(JSON.parse(tableModelPathJson(before)), [{
    controlIndex: 6,
    cellIndex: 3,
    cellParaIndex: 2,
  }]);
});

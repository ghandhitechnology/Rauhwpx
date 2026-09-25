import test from 'node:test';
import assert from 'node:assert/strict';
import type { CellBbox, DocumentPosition } from '../src/core/types.ts';
import { cellSelectionRects, crossCellTableTarget } from '../src/engine/table-selection-rects.ts';

function cell(cellIdx: number, row: number, col: number, x: number, y: number, w: number, h: number,
  extra: Partial<CellBbox> = {}): CellBbox {
  return { cellIdx, row, col, rowSpan: 1, colSpan: 1, pageIndex: 0, x, y, w, h, ...extra };
}

// 2×2 표: 라벨 열(좁음) + 내용 열(넓음). 사용자 문서의 "목표/준비물" 머리 표와 같은 모양.
const grid: CellBbox[] = [
  cell(0, 0, 0, 83, 244, 61, 73),
  cell(1, 0, 1, 144, 244, 563, 73),
  cell(2, 1, 0, 83, 317, 61, 25),
  cell(3, 1, 1, 144, 317, 563, 25),
];

test('표 전체 선택은 모든 열의 셀 사각형을 그대로 칠한다 (라벨 열 포함, 표 밖으로 나가지 않음)', () => {
  const rects = cellSelectionRects(grid, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
  assert.deepEqual(rects.map((r) => [r.x, r.y, r.width, r.height]), [
    [83, 244, 61, 73], [144, 244, 563, 73], [83, 317, 61, 25], [144, 317, 563, 25],
  ]);
  const left = Math.min(...rects.map((r) => r.x));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  assert.equal(left, 83);
  assert.equal(right, 707);
});

test('병합 셀은 걸친 범위로 겹침을 판정하고, 여러 쪽 조각은 쪽마다 사각형이 된다', () => {
  const merged = [
    cell(0, 0, 0, 80, 100, 640, 800, { colSpan: 2, rowSpan: 2 }),
    cell(0, 0, 0, 80, 80, 640, 300, { colSpan: 2, rowSpan: 2, pageIndex: 1 }),
    cell(1, 2, 0, 80, 380, 320, 30, { pageIndex: 1 }),
  ];
  const rects = cellSelectionRects(merged, { startRow: 1, startCol: 1, endRow: 1, endCol: 1 });
  assert.deepEqual(rects.map((r) => r.pageIndex), [0, 1]);
  assert.equal(cellSelectionRects(merged, null).length, 3);
  assert.equal(cellSelectionRects(merged, null, new Set(['2,0'])).length, 2);
});

function inCell(cellPath: Array<[number, number, number]>, charOffset = 0): DocumentPosition {
  const path = cellPath.map(([controlIndex, cellIndex, cellParaIndex]) => ({ controlIndex, cellIndex, cellParaIndex }));
  return {
    sectionIndex: 0,
    paragraphIndex: path[path.length - 1].cellParaIndex,
    charOffset,
    parentParaIndex: 1,
    controlIndex: path[0].controlIndex,
    cellIndex: path[0].cellIndex,
    cellParaIndex: path[0].cellParaIndex,
    cellPath: path,
  };
}

test('같은 표의 다른 셀로 넘어간 선택만 셀 블록 대상이 된다', () => {
  // 바깥 셀(1,5) 문단 4에 든 중첩 표의 셀 0 → 셀 2
  const target = crossCellTableTarget(inCell([[1, 5, 4], [0, 0, 0]], 3), inCell([[1, 5, 4], [0, 2, 0]], 2));
  assert.equal(target?.depth, 1);
  assert.deepEqual(target?.anchorPath.at(-1), { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 });
  assert.deepEqual(target?.focusPath.at(-1), { controlIndex: 0, cellIndex: 2, cellParaIndex: 0 });

  // 같은 셀 안 여러 문단은 글자 선택으로 남는다.
  assert.equal(crossCellTableTarget(inCell([[1, 5, 4], [0, 1, 0]]), inCell([[1, 5, 4], [0, 1, 1]])), null);
  // 바깥 셀의 다른 문단에 든 서로 다른 표는 셀 블록이 아니다 (표 가로지르기).
  assert.equal(crossCellTableTarget(inCell([[1, 5, 4], [0, 1, 0]]), inCell([[1, 5, 9], [0, 1, 0]])), null);
  // 한쪽이 셀 안 중첩 표 속이면 바깥 표 기준 셀로 올린다.
  const lifted = crossCellTableTarget(inCell([[1, 5, 4], [0, 1, 0], [0, 0, 0]]), inCell([[1, 5, 4], [0, 3, 0]]));
  assert.equal(lifted?.depth, 1);
  assert.deepEqual(lifted?.anchorPath.map((e) => e.cellIndex), [5, 1]);
});

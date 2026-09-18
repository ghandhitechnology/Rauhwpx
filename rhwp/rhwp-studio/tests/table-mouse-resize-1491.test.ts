import test from 'node:test';
import assert from 'node:assert/strict';
import type { CellBbox } from '../src/core/types.ts';
import { buildCellSelectionColumnDragUpdates, cellOverlapsSelectionRange, findResizeCompensationNeighbors } from '../src/engine/table-resize-updates.ts';

// #1491 후속: Shift+경계선 드래그는 셀 선택 확장보다 resize 판정이 우선해야 한다.
// #4117: 셀 선택 클릭 전에는 아무도 bbox 캐시를 채우지 않아 표 경계 리사이즈가
// 시작되지 않았다. 이제 hover 가 단일 채움 지점(ensureTableCellBboxCache)으로
// 캐시를 채우되, task 2010 이 막은 "이동마다 표 전체 재계산"은 캐시·실패 메모가
// 계속 막는다 (행동 계약은 tests/table-resize-bbox-cache.test.ts).
// 병합 셀이 섞인 표에서 마우스 드래그 리사이즈가 셀 선택 범위 내 병합 셀을
// 누락시키지 않는다. 이 파일의 다른 테스트와 달리 finishResizeDrag 가 실제로 쓰는
// cellOverlapsSelectionRange 를 직접 호출해 검증한다.

function mergedGridBbox(row: number, col: number, rowSpan: number, colSpan: number): CellBbox {
  return { cellIdx: row * 100 + col, row, col, rowSpan, colSpan, pageIndex: 0, x: 0, y: 0, w: 40, h: 20 };
}

test('세로 병합 셀은 시작 행이 선택 범위 밖이어도 하위 행 선택과 겹친다', () => {
  // row0~1 세로 병합 셀(col0). 사용자가 row1 만 셀 선택한 채 열 경계를 드래그하는 시나리오 —
  // 시작 좌표 비교(row >= startRow)라면 이 병합 셀이 통째로 빠진다.
  const merged = mergedGridBbox(0, 0, 2, 1);
  const range = { startRow: 1, startCol: 0, endRow: 1, endCol: 0 };
  assert.equal(cellOverlapsSelectionRange(merged, range), true);
});

test('가로 병합 셀은 시작 열이 선택 범위 밖이어도 하위 열 선택과 겹친다', () => {
  const merged = mergedGridBbox(0, 0, 1, 3);
  const range = { startRow: 0, startCol: 2, endRow: 0, endCol: 2 };
  assert.equal(cellOverlapsSelectionRange(merged, range), true);
});

test('선택 범위와 겹치지 않는 셀은 여전히 제외된다', () => {
  const plain = mergedGridBbox(2, 2, 1, 1);
  const range = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
  assert.equal(cellOverlapsSelectionRange(plain, range), false);
});

test('병합 셀 열 드래그는 걸친 모든 행의 오른쪽 이웃을 보상한다', () => {
  // 3x2 표, col0 rows0-1 세로 병합. 경계 왼쪽 선택 셀 = 병합 셀 + (2,0).
  // 실측(2026-09-01, headless studio): 시작 행 이웃만 보상하면 row1 의 열 폭 합이
  // 어긋나 병합 셀이 최소폭으로 붕괴했다 (279.7px → 24px). 걸친 행 전부의 이웃
  // (0,1)·(1,1)·(2,1) 이 반대 delta 를 받아야 행별 합이 유지된다.
  const merged = mergedGridBbox(0, 0, 2, 1);
  const r2c0 = mergedGridBbox(2, 0, 1, 1);
  const r0c1 = mergedGridBbox(0, 1, 1, 1);
  const r1c1 = mergedGridBbox(1, 1, 1, 1);
  const r2c1 = mergedGridBbox(2, 1, 1, 1);
  const all = [merged, r0c1, r1c1, r2c0, r2c1];

  const updates = buildCellSelectionColumnDragUpdates([merged, r2c0], all, 100);
  const byCell = new Map(updates.map(u => [u.cellIdx, u.widthDelta]));

  assert.equal(byCell.get(merged.cellIdx), 100, '병합 셀은 +delta');
  assert.equal(byCell.get(r2c0.cellIdx), 100, '(2,0) 은 +delta');
  assert.equal(byCell.get(r0c1.cellIdx), -100, '(0,1) 은 -delta');
  assert.equal(byCell.get(r1c1.cellIdx), -100, '(1,1) 도 -delta — 시작 행만 보상하면 여기가 빠진다');
  assert.equal(byCell.get(r2c1.cellIdx), -100, '(2,1) 은 -delta');
  assert.equal(updates.length, 5, '표의 다섯 셀 전부가 정확히 한 번씩 update 를 받는다');
});

test('일반 모드 경계 드래그 보상 이웃은 병합 셀이 걸친 모든 줄을 쓴다', () => {
  // 실측(2026-09-01, headless studio): 2x3 표에서 row0 cols0-1 을 가로 병합하고
  // row0|row1 경계를 드래그하면, 아래 이웃 보상이 병합 셀의 시작 열 이웃만 찾아
  // (1,1) 이 -delta 를 받지 못했다. 드래그가 절반만 먹고 표 전체 높이가
  // 194.2px → 208.2px 로 불었다. 걸친 모든 열의 이웃이 보상을 받아야 한다.
  const hMerged = mergedGridBbox(0, 0, 1, 2); // row0, cols0-1 가로 병합
  const r02 = mergedGridBbox(0, 2, 1, 1);
  const r10 = mergedGridBbox(1, 0, 1, 1);
  const r11 = mergedGridBbox(1, 1, 1, 1);
  const r12 = mergedGridBbox(1, 2, 1, 1);
  const all = [hMerged, r02, r10, r11, r12];

  const below = findResizeCompensationNeighbors({ type: 'row' }, hMerged, all);
  assert.deepEqual(
    below.map(b => b.cellIdx).sort((a, b) => a - b),
    [r10.cellIdx, r11.cellIdx].sort((a, b) => a - b),
    '가로 병합 셀의 행 경계 보상은 걸친 두 열의 아래 이웃 모두여야 한다',
  );

  // 세로 병합(rowSpan=2) 열 경계 대칭: 걸친 두 행의 오른쪽 이웃 모두
  const vMerged = mergedGridBbox(0, 0, 2, 1);
  const c01 = mergedGridBbox(0, 1, 1, 1);
  const c11 = mergedGridBbox(1, 1, 1, 1);
  const right = findResizeCompensationNeighbors({ type: 'col' }, vMerged, [vMerged, c01, c11]);
  assert.deepEqual(
    right.map(b => b.cellIdx).sort((a, b) => a - b),
    [c01.cellIdx, c11.cellIdx].sort((a, b) => a - b),
    '세로 병합 셀의 열 경계 보상은 걸친 두 행의 오른쪽 이웃 모두여야 한다',
  );

  // 병합 없는 셀은 종전처럼 이웃 하나
  const single = findResizeCompensationNeighbors({ type: 'row' }, r02, all);
  assert.deepEqual(single.map(b => b.cellIdx), [r12.cellIdx]);
});

test('병합 없는 표의 열 드래그 보상은 기존과 같다', () => {
  const r0c0 = mergedGridBbox(0, 0, 1, 1);
  const r1c0 = mergedGridBbox(1, 0, 1, 1);
  const r0c1 = mergedGridBbox(0, 1, 1, 1);
  const r1c1 = mergedGridBbox(1, 1, 1, 1);
  const all = [r0c0, r0c1, r1c0, r1c1];

  const updates = buildCellSelectionColumnDragUpdates([r1c0], all, 100);
  assert.deepEqual(
    updates,
    [
      { cellIdx: r1c0.cellIdx, widthDelta: 100 },
      { cellIdx: r1c1.cellIdx, widthDelta: -100 },
    ],
    '선택된 (1,0) 과 그 행의 오른쪽 이웃만 반대 delta 를 받는다',
  );
});

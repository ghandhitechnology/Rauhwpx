// 마우스 표 경계 드래그의 update 구성. WASM/DOM 의존이 없는 순수 로직이라
// 단위 테스트가 직접 검증한다 (tests/table-mouse-resize-1491.test.ts).
// F5 키보드 3모드 빌더는 이 포크에 없으므로 추출하지 않는다.

import type { CellBbox } from '@/core/types';

export type CellSelectionRange = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

export type LocalResizeUpdate = {
  cellIdx: number;
  widthDelta?: number;
  heightDelta?: number;
  localResize?: boolean;
  renderWidth?: number;
  renderHeight?: number;
};

function axisStart(b: CellBbox, isHoriz: boolean): number {
  return isHoriz ? b.col : b.row;
}

function axisEnd(b: CellBbox, isHoriz: boolean): number {
  return axisStart(b, isHoriz) + (isHoriz ? b.colSpan : b.rowSpan) - 1;
}

function overlapCount(b: CellBbox, isHoriz: boolean, start: number, end: number): number {
  return Math.max(0, Math.min(axisEnd(b, isHoriz), end) - Math.max(axisStart(b, isHoriz), start) + 1);
}

/**
 * 셀 선택 범위와 셀이 실제로 겹치는지 판정한다. 병합 셀은 bbox에 시작 행/열만
 * 저장되므로 시작 좌표를 범위와 직접 비교하면 선택 범위가 병합 셀의 하위 행/열일 때
 * 그 병합 셀이 통째로 누락된다. finishResizeDrag 가 이 판정을 쓴다.
 */
export function cellOverlapsSelectionRange(b: CellBbox, range: CellSelectionRange): boolean {
  return overlapCount(b, true, range.startCol, range.endCol) > 0
    && overlapCount(b, false, range.startRow, range.endRow) > 0;
}

/**
 * 셀 선택 상태의 마우스 열 경계 드래그: 경계 왼쪽의 선택 셀에 delta, 오른쪽 이웃에
 * 반대 delta 를 만들어 표 외곽 폭을 유지한다. 병합 셀은 걸친 모든 행의 이웃을
 * 보상해야 한다 — 시작 행의 이웃 하나만 보상하면 나머지 행의 열 폭 합이 어긋나
 * 표가 깨진다 (finishResizeDrag 가 사용).
 */
export function buildCellSelectionColumnDragUpdates(
  selectedBboxes: CellBbox[],
  allBboxes: CellBbox[],
  deltaHwpUnit: number,
): LocalResizeUpdate[] {
  const updates: LocalResizeUpdate[] = [];
  const addedNeighbors = new Set<number>();
  for (const bbox of selectedBboxes) {
    updates.push({ cellIdx: bbox.cellIdx, widthDelta: deltaHwpUnit });
    const neighbors = allBboxes.filter(b =>
      b.col === bbox.col + bbox.colSpan
      && b.row < bbox.row + bbox.rowSpan
      && b.row + b.rowSpan > bbox.row);
    for (const neighbor of neighbors) {
      if (addedNeighbors.has(neighbor.cellIdx)) continue;
      updates.push({ cellIdx: neighbor.cellIdx, widthDelta: -deltaHwpUnit });
      addedNeighbors.add(neighbor.cellIdx);
    }
  }
  return updates;
}

/**
 * 경계 반대편에서 보상(-delta)을 받아야 하는 이웃 셀 전부. 병합 셀은 걸친
 * 모든 행(열 경계)/열(행 경계)의 이웃을 쓸어야 한다 — 시작 행/열의 이웃
 * 하나만 보상하면 나머지 줄의 폭/높이 합이 어긋나 표 크기가 뒤틀린다.
 */
export function findResizeCompensationNeighbors(
  edge: { type: 'row' | 'col' },
  bbox: CellBbox,
  bboxes: CellBbox[],
): CellBbox[] {
  if (edge.type === 'col') {
    return bboxes.filter(b =>
      b.col === bbox.col + bbox.colSpan
      && b.row < bbox.row + bbox.rowSpan
      && b.row + b.rowSpan > bbox.row);
  }

  return bboxes.filter(b =>
    b.row === bbox.row + bbox.rowSpan
    && b.col < bbox.col + bbox.colSpan
    && b.col + b.colSpan > bbox.col);
}

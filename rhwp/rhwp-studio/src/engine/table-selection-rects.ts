/**
 * 표 셀 선택 하이라이트 기하.
 *
 * 셀 블록(F5·셀 드래그·셀을 넘는 Shift 선택)이나 표 전체가 선택되면 글자 줄이 아니라
 * 셀 사각형을 칠해야 한다. 이 모듈은 셀 bbox → 하이라이트 사각형 변환을 한곳에 둔다.
 * 셀 선택 렌더러와, 표를 가로지르는 본문 선택이 표 부분을 칠할 때 같은 함수를 쓴다.
 *
 * WASM·DOM 의존이 없는 순수 함수 + 얇은 조회 래퍼라 node --test 로 직접 검증한다.
 */
import type { CellBbox, SelectionRect } from '../core/types.ts';

export interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface TableSelectionRef {
  sec: number;
  ppi: number;
  ci: number;
  /** 중첩 표면 표까지의 셀 경로 (깊이 ≥ 2). 없거나 깊이 1이면 평면 표. */
  cellPath?: readonly unknown[];
}

interface CellBboxSource {
  getTableCellBboxes(sec: number, ppi: number, ci: number, pageHint?: number): CellBbox[];
  getTableCellBboxesByPath(sec: number, ppi: number, pathJson: string): CellBbox[];
}

/** 병합 셀은 시작 행/열만 가지므로 걸친 범위 전체로 겹침을 판정한다. */
export function cellOverlapsRange(cell: CellBbox, range: CellRange): boolean {
  const endRow = cell.row + Math.max(1, cell.rowSpan) - 1;
  const endCol = cell.col + Math.max(1, cell.colSpan) - 1;
  return cell.row <= range.endRow && endRow >= range.startRow
    && cell.col <= range.endCol && endCol >= range.startCol;
}

/**
 * 선택 범위에 드는 셀 bbox 를 하이라이트 사각형으로 바꾼다.
 * `range` 가 없으면 표 전체다. 여러 쪽에 걸친 셀은 쪽마다 한 사각형이 된다.
 * `excluded` 는 Ctrl+클릭으로 뺀 셀(`"row,col"`)이다.
 */
export function cellSelectionRects(
  bboxes: readonly CellBbox[],
  range?: CellRange | null,
  excluded?: ReadonlySet<string>,
): SelectionRect[] {
  const rects: SelectionRect[] = [];
  for (const cell of bboxes) {
    if (range && !cellOverlapsRange(cell, range)) continue;
    if (excluded?.has(`${cell.row},${cell.col}`)) continue;
    if (!(cell.w > 0) || !(cell.h > 0)) continue;
    rects.push({ pageIndex: cell.pageIndex, x: cell.x, y: cell.y, width: cell.w, height: cell.h });
  }
  return rects;
}

/** 표(중첩 포함)의 모든 쪽 셀 bbox 를 읽는다. 실패하면 빈 배열. */
export function fetchTableCellBboxes(wasm: CellBboxSource, ref: TableSelectionRef): CellBbox[] {
  try {
    return ref.cellPath && ref.cellPath.length > 1
      ? wasm.getTableCellBboxesByPath(ref.sec, ref.ppi, JSON.stringify(ref.cellPath))
      // pageHint 0: 표가 시작하는 쪽부터 끝까지 모두 담는다.
      : wasm.getTableCellBboxes(ref.sec, ref.ppi, ref.ci, 0);
  } catch {
    return [];
  }
}

/** 표 셀 선택 하이라이트 사각형 (조회 + 변환). `range` 없으면 표 전체. */
export function tableSelectionRects(
  wasm: CellBboxSource,
  ref: TableSelectionRef,
  range?: CellRange | null,
  excluded?: ReadonlySet<string>,
): SelectionRect[] {
  return cellSelectionRects(fetchTableCellBboxes(wasm, ref), range, excluded);
}

export interface CellChainEntry {
  controlIndex: number;
  cellIndex: number;
  cellParaIndex: number;
}

interface ChainPosition {
  sectionIndex: number;
  paragraphIndex: number;
  charOffset: number;
  parentParaIndex?: number;
  controlIndex?: number;
  cellIndex?: number;
  cellParaIndex?: number;
  cellPath?: CellChainEntry[];
  isTextBox?: boolean;
}

export function cellChain(pos: ChainPosition): CellChainEntry[] {
  if (pos.parentParaIndex === undefined) return [];
  if ((pos.cellPath?.length ?? 0) > 0) return pos.cellPath!;
  return [{
    controlIndex: pos.controlIndex ?? 0,
    cellIndex: pos.cellIndex ?? 0,
    cellParaIndex: pos.cellParaIndex ?? 0,
  }];
}

export interface CrossCellTarget {
  /** 두 끝이 함께 속한 표의 깊이 (0 = 본문 표). */
  depth: number;
  /** 표 셀까지 자른 anchor/focus 경로 (길이 depth + 1). */
  anchorPath: CellChainEntry[];
  focusPath: CellChainEntry[];
}

/**
 * 글자 선택의 두 끝이 같은 표의 서로 다른 셀에 있으면 그 표와 두 셀을 돌려준다.
 * 한쪽이 셀 안의 중첩 표 속이어도 바깥 표 기준 셀로 올린다. 같은 셀이거나 다른
 * 표면 null — 표를 가로지르는 선택은 selection-table-lift 가 다룬다.
 */
export function crossCellTableTarget(anchor: ChainPosition, focus: ChainPosition): CrossCellTarget | null {
  if (anchor.isTextBox || focus.isTextBox) return null;
  if (anchor.sectionIndex !== focus.sectionIndex || anchor.parentParaIndex !== focus.parentParaIndex) return null;
  const a = cellChain(anchor);
  const f = cellChain(focus);
  const limit = Math.min(a.length, f.length);
  for (let depth = 0; depth < limit; depth++) {
    if (depth > 0 && a[depth - 1].cellParaIndex !== f[depth - 1].cellParaIndex) return null;
    if (a[depth].controlIndex !== f[depth].controlIndex) return null;
    if (a[depth].cellIndex !== f[depth].cellIndex) {
      return { depth, anchorPath: a.slice(0, depth + 1), focusPath: f.slice(0, depth + 1) };
    }
  }
  return null;
}

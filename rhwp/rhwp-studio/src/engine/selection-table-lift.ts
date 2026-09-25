import type { CellPathEntry, DocumentPosition } from '@/core/types';

/**
 * 표 바깥에서 시작해 표 안으로 들어간(또는 그 반대) 선택을 표 단위로 올린다.
 *
 * 한쪽 끝이 다른 쪽이 모르는 표 안에 있으면, 두 끝을 공통 컨테이너(본문 또는 바깥 셀)
 * 좌표로 끌어올려 그 표가 통째로 범위에 들어가게 한다. 선택 잉크·복사·삭제·인라인
 * 프롬프트가 모두 같은 정렬 선택을 읽으므로 한곳에서 정규화한다.
 * 같은 표의 서로 다른 셀 사이 선택(셀 블록)은 표 선택 경로가 다루므로 건드리지 않는다.
 */

export interface TableBoundaryRequest {
  sectionIndex: number;
  parentParaIndex: number;
  /** 표를 품은 컨테이너 셀까지의 경로. 본문이면 빈 배열. */
  containerPath: CellPathEntry[];
  hostParaIndex: number;
  controlIndex: number;
  /** 선택 끝(뒤쪽)이면 true — 표 뒤 경계를 돌려준다. */
  after: boolean;
}

export type TableBoundaryResolver = (
  request: TableBoundaryRequest,
) => { paraIdx: number; charOffset: number } | null;

function cellChain(pos: DocumentPosition): CellPathEntry[] {
  if (pos.parentParaIndex === undefined) return [];
  if ((pos.cellPath?.length ?? 0) > 0) return pos.cellPath!;
  return [{
    controlIndex: pos.controlIndex ?? 0,
    cellIndex: pos.cellIndex ?? 0,
    cellParaIndex: pos.cellParaIndex ?? 0,
  }];
}

/** 두 끝이 함께 속한 가장 깊은 컨테이너 깊이 (0 = 본문). */
function sharedContainerDepth(a: DocumentPosition, b: DocumentPosition): number {
  const ca = cellChain(a);
  const cb = cellChain(b);
  if (a.sectionIndex !== b.sectionIndex || ca.length === 0 || cb.length === 0) return 0;
  if (a.parentParaIndex !== b.parentParaIndex) return 0;
  let depth = 0;
  const limit = Math.min(ca.length, cb.length);
  while (depth < limit) {
    if (depth > 0 && ca[depth - 1].cellParaIndex !== cb[depth - 1].cellParaIndex) break;
    if (ca[depth].controlIndex !== cb[depth].controlIndex || ca[depth].cellIndex !== cb[depth].cellIndex) break;
    depth++;
  }
  return depth;
}

/** depth 에서 두 끝이 같은 표의 서로 다른 셀에 있는지 (셀 블록 선택 영역). */
function inSameTableAtDepth(a: DocumentPosition, b: DocumentPosition, depth: number): boolean {
  const ca = cellChain(a);
  const cb = cellChain(b);
  if (ca.length <= depth || cb.length <= depth) return false;
  if (a.sectionIndex !== b.sectionIndex || a.parentParaIndex !== b.parentParaIndex) return false;
  if (depth > 0 && ca[depth - 1].cellParaIndex !== cb[depth - 1].cellParaIndex) return false;
  return ca[depth].controlIndex === cb[depth].controlIndex;
}

function liftToDepth(
  pos: DocumentPosition,
  depth: number,
  after: boolean,
  resolve: TableBoundaryResolver,
): DocumentPosition | null {
  const chain = cellChain(pos);
  if (chain.length <= depth) return pos;
  const containerPath = chain.slice(0, depth).map((entry) => ({ ...entry }));
  const hostParaIndex = depth === 0 ? pos.parentParaIndex! : chain[depth - 1].cellParaIndex;
  const boundary = resolve({
    sectionIndex: pos.sectionIndex,
    parentParaIndex: pos.parentParaIndex!,
    containerPath,
    hostParaIndex,
    controlIndex: chain[depth].controlIndex,
    after,
  });
  if (!boundary) return null;
  if (depth === 0) {
    return { sectionIndex: pos.sectionIndex, paragraphIndex: boundary.paraIdx, charOffset: boundary.charOffset };
  }
  containerPath[depth - 1] = { ...containerPath[depth - 1], cellParaIndex: boundary.paraIdx };
  return {
    sectionIndex: pos.sectionIndex,
    paragraphIndex: depth === 1 ? boundary.paraIdx : pos.paragraphIndex,
    charOffset: boundary.charOffset,
    parentParaIndex: pos.parentParaIndex,
    controlIndex: containerPath[0].controlIndex,
    cellIndex: containerPath[0].cellIndex,
    cellParaIndex: containerPath[0].cellParaIndex,
    cellPath: containerPath,
  };
}

/** 정렬된 선택(start ≤ end)을 표 단위로 정규화한다. 바꿀 것이 없거나 실패하면 그대로 돌려준다. */
export function liftSelectionAcrossTables(
  start: DocumentPosition,
  end: DocumentPosition,
  resolve: TableBoundaryResolver,
): { start: DocumentPosition; end: DocumentPosition } {
  if (start.isTextBox || end.isTextBox) return { start, end };
  const startDepth = cellChain(start).length;
  const endDepth = cellChain(end).length;
  const depth = sharedContainerDepth(start, end);
  if (depth === startDepth && depth === endDepth) return { start, end };
  if (inSameTableAtDepth(start, end, depth)) return { start, end };
  try {
    const liftedStart = liftToDepth(start, depth, false, resolve);
    const liftedEnd = liftToDepth(end, depth, true, resolve);
    if (!liftedStart || !liftedEnd) return { start, end };
    return { start: liftedStart, end: liftedEnd };
  } catch {
    return { start, end };
  }
}

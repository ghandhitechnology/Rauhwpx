/** 같은 경계로 볼 좌표 간 거리 상한(px, 줌 적용 전 페이지 좌표). */
export const BORDER_LINE_MERGE_EPS_PX = 1.0;

export type MergedBorderCoords = {
  /** 병합 후 대표 좌표 (오름차순). 각 그룹의 최솟값을 쓴다. */
  positions: number[];
  /** 병합 **전** 반올림 좌표 → 대표 좌표의 인덱스. 그룹의 모든 좌표가 들어 있다. */
  indexByCoord: Map<number, number>;
};

export function mergeBorderCoords(
  roundedCoords: Iterable<number>,
  eps: number = BORDER_LINE_MERGE_EPS_PX,
): MergedBorderCoords {
  const sorted = [...new Set(roundedCoords)].sort((a, b) => a - b);
  const positions: number[] = [];
  const indexByCoord = new Map<number, number>();

  for (const coord of sorted) {
    const representative = positions[positions.length - 1];
    if (representative === undefined || coord - representative > eps) {
      positions.push(coord);
    }
    indexByCoord.set(coord, positions.length - 1);
  }

  return { positions, indexByCoord };
}

/** 경계선이 실제로 존재하는 한 구간. */
export interface BorderSpan { start: number; end: number }

/** 칸 상자에서 span 을 뽑는 데 필요한 최소 형태. */
export interface SpanCell { x: number; y: number; w: number; h: number }

/** 맞닿은 칸 변을 잇는 허용 오차(px). 공유 변은 정확히 같으므로 반올림 오차만 허용한다. */
export const BORDER_SPAN_JOIN_EPS_PX = 0.5;

export function coalesceSpans(
  spans: readonly BorderSpan[],
  eps: number = BORDER_SPAN_JOIN_EPS_PX,
): BorderSpan[] {
  if (spans.length <= 1) return spans.map((s) => ({ ...s }));
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: BorderSpan[] = [{ ...sorted[0] }];
  for (const span of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (span.start <= last.end + eps) {
      last.end = Math.max(last.end, span.end);
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

export function computeBorderSpans(
  cells: readonly SpanCell[],
  rowIndexByY: ReadonlyMap<number, number>,
  colIndexByX: ReadonlyMap<number, number>,
  round: (value: number) => number,
): { rowSpans: Map<number, BorderSpan[]>; colSpans: Map<number, BorderSpan[]> } {
  const rowSpans = new Map<number, BorderSpan[]>();
  const colSpans = new Map<number, BorderSpan[]>();
  const add = (target: Map<number, BorderSpan[]>, index: number, start: number, end: number) => {
    const list = target.get(index);
    if (list) list.push({ start, end });
    else target.set(index, [{ start, end }]);
  };

  for (const cell of cells) {
    const top = rowIndexByY.get(round(cell.y));
    if (top !== undefined) add(rowSpans, top, cell.x, cell.x + cell.w);
    const bottom = rowIndexByY.get(round(cell.y + cell.h));
    if (bottom !== undefined) add(rowSpans, bottom, cell.x, cell.x + cell.w);

    const left = colIndexByX.get(round(cell.x));
    if (left !== undefined) add(colSpans, left, cell.y, cell.y + cell.h);
    const right = colIndexByX.get(round(cell.x + cell.w));
    if (right !== undefined) add(colSpans, right, cell.y, cell.y + cell.h);
  }

  for (const [index, spans] of rowSpans) rowSpans.set(index, coalesceSpans(spans));
  for (const [index, spans] of colSpans) colSpans.set(index, coalesceSpans(spans));
  return { rowSpans, colSpans };
}

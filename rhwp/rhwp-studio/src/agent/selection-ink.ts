import type { SelectionRect } from '../core/types.ts';
import type { DocRange } from './types.ts';

/** rect 와 캐럿을 같은 줄로 볼 세로 허용 오차(문서 단위). */
export const LINE_MATCH_SLOP = 2;

export interface MeasuredInkRange {
  rects: SelectionRect[];
  /** 문단이 끝나는 자리의 캐럿 — 개행 표시용. 범위의 마지막 문단은 제외. */
  paraEnds: Array<{ paraIdx: number; rect: SelectionRect }>;
}

export interface InkGeometryProbe {
  rects(): SelectionRect[];
  paragraphLength(paraIdx: number): number;
  text(paraIdx: number, start: number, count: number): string;
  caret(paraIdx: number, offset: number): SelectionRect;
}

/**
 * 엔진 selection rect 는 강제 줄바꿈·문단 부호를 여백까지 밀어 반환한다.
 * 에이전트 잉크/커버는 실제 글자 끝까지만 남긴다.
 */
export function measureInkRange(range: DocRange, probe: InkGeometryProbe): MeasuredInkRange {
  const rects = probe.rects();
  const ends: SelectionRect[] = [];
  const paraEnds: Array<{ paraIdx: number; rect: SelectionRect }> = [];

  for (let paraIdx = range.startParaIdx; paraIdx <= range.endParaIdx; paraIdx++) {
    const startOff = paraIdx === range.startParaIdx ? range.startCharOffset : 0;
    const endOff = paraIdx === range.endParaIdx
      ? range.endCharOffset
      : probe.paragraphLength(paraIdx);
    if (endOff > startOff) {
      try {
        const text = probe.text(paraIdx, startOff, endOff - startOff);
        for (const offset of newlineOffsets(text, startOff)) {
          pushCaret(ends, () => probe.caret(paraIdx, offset));
        }
      } catch {
        // 주소 드리프트 — 이 문단의 강제 줄바꿈 끝은 건너뛴다.
      }
    }
    const endRect = pushCaret(ends, () => probe.caret(paraIdx, endOff));
    if (endRect && paraIdx !== range.endParaIdx) {
      paraEnds.push({ paraIdx, rect: endRect });
    }
  }

  return { rects: clampRectsToTextEnds(rects, ends), paraEnds };
}

/** `text` 안의 `\n` 을 startOffset 기준 스칼라 오프셋으로 돌려준다. */
export function newlineOffsets(text: string, startOffset: number): number[] {
  const offsets: number[] = [];
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\n') offsets.push(startOffset + i);
  }
  return offsets;
}

export function clampRectsToTextEnds(
  rects: readonly SelectionRect[],
  ends: readonly SelectionRect[],
): SelectionRect[] {
  const clamped: SelectionRect[] = [];
  for (const rect of rects) {
    const end = ends.find((candidate) => isTextEndOnRect(candidate, rect));
    if (!end) {
      clamped.push(rect);
      continue;
    }
    const width = Math.max(0, end.x - rect.x);
    if (width > 0.05) clamped.push({ ...rect, width });
  }
  return clamped;
}

export function isTextEndOnRect(caret: SelectionRect, rect: SelectionRect): boolean {
  return caret.pageIndex === rect.pageIndex
    && caret.y + caret.height > rect.y + LINE_MATCH_SLOP
    && caret.y < rect.y + rect.height - LINE_MATCH_SLOP
    && caret.x >= rect.x - LINE_MATCH_SLOP
    && caret.x <= rect.x + rect.width + LINE_MATCH_SLOP;
}

function pushCaret(
  ends: SelectionRect[],
  read: () => SelectionRect,
): SelectionRect | null {
  try {
    const rect = read();
    ends.push(rect);
    return rect;
  } catch {
    return null;
  }
}

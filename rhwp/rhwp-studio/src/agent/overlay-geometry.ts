import type { SelectionRect } from '../core/types.ts';

/** Extra gap that keeps semantic exact-diff ink readable over legacy ink. */
export const EXACT_INK_GUTTER = 0.35;

export type ExactTextRectIndex = ReadonlyMap<number, readonly SelectionRect[]>;

export function indexExactTextRects(exactRects: readonly SelectionRect[]): ExactTextRectIndex {
  const exactByPage = new Map<number, SelectionRect[]>();
  for (const exact of exactRects) {
    if (exact.width <= 0 || exact.height <= 0) continue;
    const page = exactByPage.get(exact.pageIndex);
    if (page) page.push(exact);
    else exactByPage.set(exact.pageIndex, [exact]);
  }
  for (const page of exactByPage.values()) page.sort((a, b) => a.x - b.x);
  return exactByPage;
}

/**
 * Remove legacy ink under exact replace text. The index is built once per page,
 * so a document with thousands of pages never compares every legacy rect with
 * exact text on unrelated pages.
 */
export function subtractExactTextRects(
  sourceRects: readonly SelectionRect[],
  exactRects: readonly SelectionRect[],
  exactByPage: ExactTextRectIndex = indexExactTextRects(exactRects),
): SelectionRect[] {
  const next: SelectionRect[] = [];
  for (const source of sourceRects) {
    const page = exactByPage.get(source.pageIndex);
    if (!page || source.width <= 0 || source.height <= 0) {
      next.push(source);
      continue;
    }
    let fragments: SelectionRect[] = [source];
    for (const exact of page) {
      // x-sorted pages let us stop before scanning unrelated exact text.
      if (exact.x > source.x + source.width + EXACT_INK_GUTTER) break;
      if (exact.x + exact.width + EXACT_INK_GUTTER <= source.x) continue;
      fragments = fragments.flatMap((piece) => {
        const overlapY = Math.min(piece.y + piece.height, exact.y + exact.height)
          - Math.max(piece.y, exact.y);
        if (overlapY <= Math.min(piece.height, exact.height) * 0.5) return [piece];
        const cutLeft = exact.x - EXACT_INK_GUTTER;
        const cutRight = exact.x + exact.width + EXACT_INK_GUTTER;
        const pieceRight = piece.x + piece.width;
        if (cutRight <= piece.x || cutLeft >= pieceRight) return [piece];
        const split: SelectionRect[] = [];
        if (cutLeft > piece.x) split.push({ ...piece, width: cutLeft - piece.x });
        if (cutRight < pieceRight) split.push({ ...piece, x: cutRight, width: pieceRight - cutRight });
        return split.filter((candidate) => candidate.width > 0.05);
      });
      if (fragments.length === 0) break;
    }
    next.push(...fragments);
  }
  return next;
}

import type { DocumentPosition, CellPathEntry } from '../core/types';

/** Text-only reads from the document model, never from painted glyphs. */
export interface StatusCountDocument {
  getDocumentCharacterCount(): number;
  getBodyRangeCharacterCount(startSection: number, startParagraph: number, startOffset: number, endSection: number, endParagraph: number, endOffset: number): number;
  getContainerCharacterCountByPath(section: number, paragraph: number, path: string): number;
  getContainerRangeCharacterCountByPath(section: number, paragraph: number, path: string, startParagraph: number, startOffset: number, endParagraph: number, endOffset: number): number;
  getTableDimensions(section: number, paragraph: number, control: number): { cellCount: number };
  getTableDimensionsByPath(section: number, paragraph: number, path: string): { cellCount: number };
  getCellInfo(section: number, paragraph: number, control: number, cell: number): { row: number; col: number };
  getCellInfoByPath(section: number, paragraph: number, path: string): { row: number; col: number };
}

export interface StatusCountInput {
  getCursorPosition(): DocumentPosition;
  getSelection(): { start: DocumentPosition; end: DocumentPosition } | null;
  getAuxiliaryTextSelection?(): string | null;
  isInCellSelectionMode?(): boolean;
  getSelectedCellRange?(): { startRow: number; startCol: number; endRow: number; endCol: number } | null;
  getCellTableContext?(): { sec: number; ppi: number; ci: number; cellPath?: CellPathEntry[] } | null;
  getExcludedCells?(): ReadonlySet<string>;
}

export interface StatusCharacterCount {
  current: number;
  total: number;
  scope: 'document' | 'selection' | 'cell';
}

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('ko', { granularity: 'grapheme' })
  : null;

/** Counts written characters, including punctuation; spaces and control markers are excluded. */
export function countWrittenCharacters(text: string): number {
  const clusters = segmenter ? Array.from(segmenter.segment(text), item => item.segment) : Array.from(text);
  let count = 0;
  for (const cluster of clusters) {
    if (!Array.from(cluster).some(char => !/[\s\p{Cc}\p{Cf}\uFE0E\uFE0F\uFFFC]/u.test(char))) continue;
    count++;
  }
  return count;
}

function cellParagraphIndex(position: DocumentPosition): number {
  return position.cellPath?.at(-1)?.cellParaIndex ?? position.cellParaIndex ?? position.paragraphIndex;
}

function countCell(wasm: StatusCountDocument, position: DocumentPosition): number {
  const path = position.cellPath?.length
    ? position.cellPath
    : [{ controlIndex: position.controlIndex!, cellIndex: position.cellIndex!, cellParaIndex: 0 }];
  return wasm.getContainerCharacterCountByPath(position.sectionIndex, position.parentParaIndex!, JSON.stringify(path));
}

function sameCell(a: DocumentPosition, b: DocumentPosition): boolean {
  if (a.parentParaIndex !== b.parentParaIndex || a.sectionIndex !== b.sectionIndex) return false;
  const ap = a.cellPath;
  const bp = b.cellPath;
  if (ap?.length || bp?.length) {
    if (ap?.length !== bp?.length) return false;
    return ap!.every((entry, index) => entry.controlIndex === bp![index].controlIndex && entry.cellIndex === bp![index].cellIndex);
  }
  return a.controlIndex === b.controlIndex && a.cellIndex === b.cellIndex;
}

function countSelectedCellText(wasm: StatusCountDocument, start: DocumentPosition, end: DocumentPosition): number {
  const path = start.cellPath?.length
    ? start.cellPath
    : [{ controlIndex: start.controlIndex!, cellIndex: start.cellIndex!, cellParaIndex: 0 }];
  return wasm.getContainerRangeCharacterCountByPath(
    start.sectionIndex, start.parentParaIndex!, JSON.stringify(path),
    cellParagraphIndex(start), start.charOffset, cellParagraphIndex(end), end.charOffset,
  );
}

function countSelectedCells(wasm: StatusCountDocument, input: StatusCountInput): number | null {
  if (!input.isInCellSelectionMode?.()) return null;
  const range = input.getSelectedCellRange?.();
  const context = input.getCellTableContext?.();
  if (!range || !context) return null;
  const nested = (context.cellPath?.length ?? 0) > 1;
  const pathFor = (cell: number): string => JSON.stringify(context.cellPath!.map((entry, index) =>
    index === context.cellPath!.length - 1 ? { ...entry, cellIndex: cell, cellParaIndex: 0 } : entry));
  const cells = nested
    ? wasm.getTableDimensionsByPath(context.sec, context.ppi, pathFor(0)).cellCount
    : wasm.getTableDimensions(context.sec, context.ppi, context.ci).cellCount;
  let total = 0;
  for (let cell = 0; cell < cells; cell++) {
    const info = nested
      ? wasm.getCellInfoByPath(context.sec, context.ppi, pathFor(cell))
      : wasm.getCellInfo(context.sec, context.ppi, context.ci, cell);
    if (info.row < range.startRow || info.row > range.endRow || info.col < range.startCol || info.col > range.endCol) continue;
    if (input.getExcludedCells?.().has(`${info.row},${info.col}`)) continue;
    total += countCell(wasm, {
      sectionIndex: context.sec, paragraphIndex: context.ppi,
      parentParaIndex: context.ppi, controlIndex: context.ci,
      cellIndex: cell, cellParaIndex: 0, charOffset: 0,
      cellPath: nested ? JSON.parse(pathFor(cell)) as CellPathEntry[] : undefined,
    });
  }
  return total;
}

/** Cache the document count across caret moves; invalidate after edits and document switches. */
export class StatusCharacterCounter {
  private total: number | null = null;

  invalidate(): void {
    this.total = null;
  }

  read(wasm: StatusCountDocument, input: StatusCountInput): StatusCharacterCount {
    if (this.total === null) {
      this.total = wasm.getDocumentCharacterCount();
    }
    const auxiliarySelection = input.getAuxiliaryTextSelection?.();
    if (auxiliarySelection !== null && auxiliarySelection !== undefined) {
      return { current: countWrittenCharacters(auxiliarySelection), total: this.total, scope: 'selection' };
    }
    const selectedCells = countSelectedCells(wasm, input);
    if (selectedCells !== null) return { current: selectedCells, total: this.total, scope: 'selection' };

    const selection = input.getSelection();
    if (selection && (selection.start.sectionIndex !== selection.end.sectionIndex
      || selection.start.paragraphIndex !== selection.end.paragraphIndex
      || selection.start.charOffset !== selection.end.charOffset
      || !sameCell(selection.start, selection.end))) {
      const { start, end } = selection;
      if (start.parentParaIndex !== undefined && sameCell(start, end)) {
        return { current: countSelectedCellText(wasm, start, end), total: this.total, scope: 'selection' };
      }
      if (start.parentParaIndex === undefined && end.parentParaIndex === undefined) {
        return { current: wasm.getBodyRangeCharacterCount(
          start.sectionIndex, start.paragraphIndex, start.charOffset,
          end.sectionIndex, end.paragraphIndex, end.charOffset,
        ), total: this.total, scope: 'selection' };
      }
    }

    const cursor = input.getCursorPosition();
    if (cursor.parentParaIndex !== undefined) {
      return { current: countCell(wasm, cursor), total: this.total, scope: 'cell' };
    }
    return { current: this.total, total: this.total, scope: 'document' };
  }
}

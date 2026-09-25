import type { CellPathEntry, DocumentPosition } from '../core/types.ts';
import { getBodySelectionSegments, type BodyRangeReader } from './body-selection-range.ts';
import { cellChain } from './table-selection-rects.ts';

export interface SelectedTableRef {
  sec: number;
  ppi: number;
  ci: number;
  cellPath?: CellPathEntry[];
}

interface TableRangeReader extends BodyRangeReader {
  getTableControlsInSelection(
    sec: number, parentPara: number, path: CellPathEntry[],
    startPara: number, startOffset: number, endPara: number, endOffset: number,
  ): SelectedTableRef[];
}

/** 정렬된 글자 선택에 통째로 든 본문·중첩 표 주소. */
export function selectedTablesInRange(
  reader: TableRangeReader,
  start: DocumentPosition,
  end: DocumentPosition,
): SelectedTableRef[] {
  if (start.parentParaIndex === undefined && end.parentParaIndex === undefined) {
    return getBodySelectionSegments(reader, start, end).flatMap(segment =>
      reader.getTableControlsInSelection(
        segment.sectionIndex, 0, [],
        segment.startParagraphIndex, segment.startCharOffset,
        segment.endParagraphIndex, segment.endCharOffset,
      ),
    );
  }
  if (start.sectionIndex !== end.sectionIndex || start.parentParaIndex !== end.parentParaIndex) return [];
  const a = cellChain(start);
  const b = cellChain(end);
  if (!a.length || a.length !== b.length) return [];
  if (!a.every((entry, i) => entry.controlIndex === b[i].controlIndex
    && entry.cellIndex === b[i].cellIndex
    && (i === a.length - 1 || entry.cellParaIndex === b[i].cellParaIndex))) return [];
  return reader.getTableControlsInSelection(
    start.sectionIndex, start.parentParaIndex!, a,
    a.at(-1)!.cellParaIndex, start.charOffset,
    b.at(-1)!.cellParaIndex, end.charOffset,
  );
}

import type { DocumentPosition } from '../core/types';

/** Read-only document shape needed to segment a body selection by section. */
export interface BodyRangeReader {
  getParagraphCount(sectionIndex: number): number;
  getParagraphLength(sectionIndex: number, paragraphIndex: number): number;
}

/** A single-section slice of an ordered body selection. */
export interface BodySelectionSegment {
  sectionIndex: number;
  startParagraphIndex: number;
  startCharOffset: number;
  endParagraphIndex: number;
  endCharOffset: number;
}

function isBodyPosition(position: DocumentPosition): boolean {
  return position.parentParaIndex === undefined;
}

/**
 * Split an ordered body selection into exact, document-order section slices.
 *
 * Section boundaries remain structural: the first slice selects to the end of
 * its section, intermediate slices select their complete section, and the last
 * slice selects from its section start to the range endpoint.
 */
export function getBodySelectionSegments(
  reader: BodyRangeReader,
  start: DocumentPosition,
  end: DocumentPosition,
): BodySelectionSegment[] {
  if (!isBodyPosition(start) || !isBodyPosition(end)) return [];
  if (start.sectionIndex > end.sectionIndex) {
    throw new RangeError('body selection endpoints must be ordered by section');
  }

  const segments: BodySelectionSegment[] = [];
  for (let sectionIndex = start.sectionIndex; sectionIndex <= end.sectionIndex; sectionIndex++) {
    const paragraphCount = reader.getParagraphCount(sectionIndex);
    if (paragraphCount <= 0) continue;

    const startParagraphIndex = sectionIndex === start.sectionIndex
      ? start.paragraphIndex
      : 0;
    const endParagraphIndex = sectionIndex === end.sectionIndex
      ? end.paragraphIndex
      : paragraphCount - 1;
    if (
      startParagraphIndex < 0 ||
      endParagraphIndex < startParagraphIndex ||
      endParagraphIndex >= paragraphCount
    ) {
      throw new RangeError(`invalid body selection paragraph range in section ${sectionIndex}`);
    }

    segments.push({
      sectionIndex,
      startParagraphIndex,
      startCharOffset: sectionIndex === start.sectionIndex ? start.charOffset : 0,
      endParagraphIndex,
      endCharOffset: sectionIndex === end.sectionIndex
        ? end.charOffset
        : reader.getParagraphLength(sectionIndex, endParagraphIndex),
    });
  }
  return segments;
}

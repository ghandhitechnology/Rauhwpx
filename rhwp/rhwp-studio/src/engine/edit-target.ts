import type { CellPathEntry, DocumentPosition } from '@/core/types';

/** A paragraph address independent of the UI mode that exposed it. */
export type EditableParagraphTarget =
  | { kind: 'body'; sectionIndex: number; paragraphIndex: number }
  | {
      kind: 'container';
      sectionIndex: number;
      parentParagraphIndex: number;
      paragraphIndex: number;
      controlIndex: number;
      cellIndex: number;
      cellPath: CellPathEntry[];
      isTextBox: boolean;
    }
  | {
      kind: 'headerFooter';
      sectionIndex: number;
      isHeader: boolean;
      applyTo: number;
      paragraphIndex: number;
    }
  | {
      kind: 'note';
      sectionIndex: number;
      hostParagraphIndex: number;
      controlIndex: number;
      paragraphIndex: number;
      footnoteIndex: number;
      pageNum: number;
    };

export interface EditableTextRange {
  target: EditableParagraphTarget;
  startOffset: number;
  endOffset: number;
}

export function editableTargetFromPosition(
  position: DocumentPosition,
  paragraphIndex = position.cellPath?.at(-1)?.cellParaIndex
    ?? position.cellParaIndex
    ?? position.paragraphIndex,
): EditableParagraphTarget {
  if (position.parentParaIndex === undefined) {
    return {
      kind: 'body',
      sectionIndex: position.sectionIndex,
      paragraphIndex,
    };
  }
  return {
    kind: 'container',
    sectionIndex: position.sectionIndex,
    parentParagraphIndex: position.parentParaIndex,
    paragraphIndex,
    controlIndex: position.controlIndex ?? position.cellPath?.[0]?.controlIndex ?? 0,
    cellIndex: position.cellIndex ?? position.cellPath?.at(-1)?.cellIndex ?? 0,
    cellPath: (position.cellPath ?? []).map((entry, index, path) =>
      index + 1 === path.length ? { ...entry, cellParaIndex: paragraphIndex } : { ...entry },
    ),
    isTextBox: position.isTextBox === true,
  };
}

export function targetCellPathJson(target: Extract<EditableParagraphTarget, { kind: 'container' }>) {
  return JSON.stringify(target.cellPath);
}

export function targetSectionIndex(target: EditableParagraphTarget) {
  return target.sectionIndex;
}

/** Whether two positions address paragraphs in the same innermost editable container. */
export function positionsShareEditableContainer(
  first: DocumentPosition,
  second: DocumentPosition,
): boolean {
  if (first.parentParaIndex === undefined || second.parentParaIndex === undefined) return false;
  if (first.sectionIndex !== second.sectionIndex
      || first.parentParaIndex !== second.parentParaIndex
      || first.isTextBox !== second.isTextBox) return false;

  const firstPath = first.cellPath ?? [];
  const secondPath = second.cellPath ?? [];
  if (firstPath.length !== secondPath.length) return false;
  if (firstPath.length === 0) {
    return first.controlIndex === second.controlIndex && first.cellIndex === second.cellIndex;
  }
  return firstPath.every((entry, index) => {
    const other = secondPath[index];
    if (!other
        || entry.controlIndex !== other.controlIndex
        || entry.cellIndex !== other.cellIndex) return false;
    // Intermediate paragraph indices identify the nested container itself. The last one is the
    // editable paragraph and may legitimately differ for a multi-paragraph selection.
    return index + 1 === firstPath.length || entry.cellParaIndex === other.cellParaIndex;
  });
}

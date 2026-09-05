import type { DocumentPosition } from '../core/types';

/** Resolve the same cell address for image insertion and the resulting caret. */
export function inlinePictureInsertionTarget(position: DocumentPosition): {
  paragraphIndex: number;
  cellPathJson: string;
  position: DocumentPosition;
} {
  if (position.parentParaIndex === undefined) {
    return { paragraphIndex: position.paragraphIndex, cellPathJson: '', position };
  }

  let cellPath = position.cellPath;
  if (!cellPath?.length) {
    const { controlIndex, cellIndex, cellParaIndex } = position;
    if (controlIndex === undefined || cellIndex === undefined || cellParaIndex === undefined) {
      throw new Error('그림을 넣을 셀 문단 주소가 불완전합니다.');
    }
    cellPath = [{ controlIndex, cellIndex, cellParaIndex }];
  }
  return {
    paragraphIndex: position.parentParaIndex,
    cellPathJson: JSON.stringify(cellPath),
    position: { ...position, cellPath },
  };
}

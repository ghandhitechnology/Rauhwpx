import type { DocumentPosition, TableCellTarget } from './types';

export function isLastTableCell(
  cell: { row: number; col: number; rowSpan?: number; colSpan?: number },
  table: { rowCount: number; colCount: number },
): boolean {
  return cell.row + Math.max(1, cell.rowSpan ?? 1) >= table.rowCount
    && cell.col + Math.max(1, cell.colSpan ?? 1) >= table.colCount;
}

export function tableModelPathJson(pos: DocumentPosition): string {
  return JSON.stringify(pos.cellPath?.length ? pos.cellPath : [{
    controlIndex: pos.controlIndex ?? 0,
    cellIndex: pos.cellIndex ?? 0,
    cellParaIndex: pos.cellParaIndex ?? pos.paragraphIndex,
  }]);
}

export function remapTableCellPosition(
  pos: DocumentPosition,
  target: TableCellTarget,
  resetToStart = false,
): DocumentPosition {
  const cellPath = pos.cellPath?.map((entry, index, path) => index === path.length - 1
    ? { ...entry, cellIndex: target.cellIndex, cellParaIndex: target.cellParaIndex }
    : { ...entry });
  return {
    ...pos,
    paragraphIndex: target.cellParaIndex,
    charOffset: resetToStart ? 0 : Math.min(pos.charOffset, target.charCount),
    cellIndex: target.cellIndex,
    cellParaIndex: target.cellParaIndex,
    cellPath,
  };
}

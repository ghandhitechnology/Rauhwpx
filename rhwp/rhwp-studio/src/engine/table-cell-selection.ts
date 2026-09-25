import { editableTargetFromPosition, type EditableParagraphTarget } from './edit-target.ts';
import {
  cellChain,
  cellOverlapsRange,
  crossCellTableTarget,
  fetchTableCellBboxes,
  type CellChainEntry,
} from './table-selection-rects.ts';

/** Promote the current table cell into the same selection mode used by F5. */
export function selectCurrentTableCell(self: any): boolean {
  if (!self.cursor.isInCell?.()) return false;

  // A text box itself also has a one-entry cellPath. Only deeper paths identify
  // an actual table nested inside the text box.
  if (self.cursor.isInTextBox?.() && (self.cursor.nestingDepth?.() ?? 0) < 2) {
    return false;
  }

  self.stopTextSelectionDrag?.();
  self.cellSelectionDragCandidate = null;
  self.cursor.clearSelection();

  // Protected-cell clicks already enter a guarded selection mode. Preserve the
  // reason so a double-click cannot accidentally make the cell editable.
  if (!self.cursor.isProtectedCellSelectionMode?.()) {
    self.cursor.exitCellSelectionMode();
    if (!self.cursor.enterCellSelectionMode()) return false;
  }

  self.active = true;
  self.caret.hide();
  self.fieldMarker.hide();
  self.selectionRenderer.clear();
  self.tableResizeRenderer?.clear();
  self.updateCellSelection();
  self.eventBus.emit('command-state-changed');
  self.textarea.focus();
  return true;
}

/**
 * 셀 경계를 넘은 글자 선택(Shift+방향키·Shift+클릭)을 셀 블록 선택으로 바꾼다.
 * 한컴·Google Docs 처럼 두 셀을 모서리로 하는 사각형의 셀 전체가 선택된다.
 */
export function promoteCrossCellSelection(self: any): boolean {
  if (self.cursor.isInCellSelectionMode?.()) return false;
  const sel = self.cursor.getSelection?.();
  if (!sel) return false;
  const target = crossCellTableTarget(sel.anchor, sel.focus);
  if (!target) return false;

  const { sectionIndex: sec, parentParaIndex: ppi } = sel.focus;
  const cellInfo = (path: CellChainEntry[]): { row: number; col: number } | null => {
    try {
      return path.length > 1 || (sel.focus.cellPath?.length ?? 0) > 0
        ? self.wasm.getCellInfoByPath(sec, ppi, JSON.stringify(path))
        : self.wasm.getCellInfo(sec, ppi, path[0].controlIndex, path[0].cellIndex);
    } catch {
      return null;
    }
  };
  const anchorRC = cellInfo(target.anchorPath);
  const focusRC = cellInfo(target.focusPath);
  if (!anchorRC || !focusRC) return false;

  // 셀 선택 컨텍스트는 커서 위치에서 읽는다 — focus 가 더 깊은 중첩 표 안이면
  // 이 표의 셀 문단으로 올려 둔다.
  if (cellChain(sel.focus).length > target.depth + 1) {
    const last = target.focusPath[target.focusPath.length - 1];
    self.cursor.moveTo({
      sectionIndex: sec,
      paragraphIndex: last.cellParaIndex,
      charOffset: 0,
      parentParaIndex: ppi,
      controlIndex: target.focusPath[0].controlIndex,
      cellIndex: target.focusPath[0].cellIndex,
      cellParaIndex: target.focusPath[0].cellParaIndex,
      cellPath: target.focusPath.map((entry) => ({ ...entry })),
    });
  }

  self.cursor.clearSelection();
  if (!self.cursor.enterCellSelectionMode('extend')) return false;
  self.cursor.setCellSelectionAnchor(anchorRC.row, anchorRC.col);
  self.cursor.setCellSelectionFocus(focusRC.row, focusRC.col);
  self.cursor.advanceCellSelectionPhase();

  self.caret.hide();
  self.fieldMarker?.hide();
  self.selectionRenderer.clear();
  self.updateCellSelection();
  self.eventBus.emit('command-state-changed');
  return true;
}

/**
 * 셀 블록 선택에 든 모든 셀의 모든 문단을 문단 서식 대상으로 돌려준다.
 * 선택이 셀 블록이 아니거나 조회에 실패하면 빈 배열.
 */
export function cellSelectionParagraphTargets(self: any): EditableParagraphTarget[] {
  const cursor = self.cursor;
  if (!cursor.isInCellSelectionMode?.()) return [];
  const ctx = cursor.getCellTableContext?.();
  const range = cursor.getSelectedCellRange?.();
  if (!ctx || !range) return [];
  const excluded: ReadonlySet<string> = cursor.getExcludedCells?.() ?? new Set();
  const basePath: CellChainEntry[] = (ctx.cellPath?.length ? ctx.cellPath : [{
    controlIndex: ctx.ci, cellIndex: 0, cellParaIndex: 0,
  }]).map((entry: CellChainEntry) => ({ ...entry }));
  const bboxes = fetchTableCellBboxes(self.wasm, { sec: ctx.sec, ppi: ctx.ppi, ci: ctx.ci, cellPath: basePath });
  const seen = new Set<number>();
  const targets: EditableParagraphTarget[] = [];
  for (const cell of bboxes) {
    if (seen.has(cell.cellIdx)) continue;
    if (!cellOverlapsRange(cell, range) || excluded.has(`${cell.row},${cell.col}`)) continue;
    seen.add(cell.cellIdx);
    const path = basePath.map((entry) => ({ ...entry }));
    const last = path.length - 1;
    path[last] = { controlIndex: path[last].controlIndex, cellIndex: cell.cellIdx, cellParaIndex: 0 };
    let count = 0;
    try {
      count = self.wasm.getCellParagraphCountByPath(ctx.sec, ctx.ppi, JSON.stringify(path));
    } catch {
      count = 0;
    }
    for (let para = 0; para < count; para++) {
      targets.push(editableTargetFromPosition({
        sectionIndex: ctx.sec,
        paragraphIndex: para,
        charOffset: 0,
        parentParaIndex: ctx.ppi,
        controlIndex: path[0].controlIndex,
        cellIndex: path[0].cellIndex,
        cellParaIndex: last === 0 ? para : path[0].cellParaIndex,
        cellPath: path,
      }, para));
    }
  }
  return targets;
}

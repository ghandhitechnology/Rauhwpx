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

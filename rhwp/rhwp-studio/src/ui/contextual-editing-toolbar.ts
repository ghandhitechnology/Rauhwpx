export type ContextualEditingToolbarMode =
  | 'default'
  | 'object'
  | 'table'
  | 'header-footer'
  | 'note';

export interface ContextualEditingToolbarState {
  objectSelected: boolean;
  inTable: boolean;
  headerFooterActive: boolean;
  noteActive: boolean;
}

export interface ContextualObjectSelectionState {
  kind: string | null;
  count: number;
  topLevel: boolean;
  arrangeable: boolean;
  groupable: boolean;
  ungroupable: boolean;
  deletable: boolean;
  propertyEditable: boolean;
}

export function contextualEditingToolbarMode(
  state: ContextualEditingToolbarState,
): ContextualEditingToolbarMode {
  if (state.objectSelected) return 'object';
  if (state.inTable) return 'table';
  if (state.noteActive) return 'note';
  if (state.headerFooterActive) return 'header-footer';
  return 'default';
}

export function contextualObjectCommandEnabled(
  command: string,
  selection: ContextualObjectSelectionState,
): boolean {
  switch (command) {
    case 'insert:picture-props':
      return selection.propertyEditable;
    case 'insert:arrange-front':
    case 'insert:arrange-forward':
    case 'insert:arrange-backward':
    case 'insert:arrange-back':
      return selection.arrangeable;
    case 'insert:group-shapes':
      return selection.groupable;
    case 'insert:ungroup-shapes':
      return selection.ungroupable;
    case 'insert:picture-delete':
      return selection.deletable;
    case 'insert:caption-toggle':
      return selection.topLevel
        && (selection.kind === 'image' || selection.kind === 'shape');
    case 'insert:rotate-ccw':
    case 'insert:rotate-cw':
    case 'insert:flip-horz':
    case 'insert:flip-vert':
      return selection.propertyEditable
        && (selection.kind === 'image' || selection.kind === 'shape');
    default:
      return true;
  }
}

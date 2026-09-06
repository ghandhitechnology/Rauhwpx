import { showConfirm } from '../ui/confirm-dialog';
import { showSaveAs } from '../ui/save-as-dialog';
import { showUnsavedChangesDialog } from '../ui/unsaved-changes-dialog';
import { showDropConfirmDialog } from '../ui/drop-confirm-dialog';
import { showPendingAgentEditsDialog } from '../ui/pending-agent-edits-dialog';
import { showHmlSaveFormatDialog } from '../ui/hml-save-format-dialog';
import { FieldInsertDialog } from '../ui/field-insert-dialog';
import { FieldEditDialog } from '../ui/field-edit-dialog';
import { TableCreateDialog } from '../ui/table-create-dialog';
import { CellSplitDialog } from '../ui/cell-split-dialog';
import { TableInsertRowColumnDialog, TableDeleteRowColumnDialog } from '../ui/table-row-column-dialog';
import { GridSettingsDialog } from '../ui/grid-settings-dialog';
import { getGridViewSettings } from '../view/grid-settings';
import { FontSetEditDialog } from '../ui/font-set-edit-dialog';
import { LocalFontsModal } from '../ui/local-fonts-modal';
import type { DocumentFontStatusReport } from '../core/document-font-status';
import { prepareUncommittedMerge } from '../ui/version-merge-preparation';
import { showActionMenu } from '../ui/action-menu';
import { showShapePicker } from '../ui/shape-picker';

type AuditAction = (button: HTMLButtonElement) => void | Promise<unknown>;

const fontReport: DocumentFontStatusReport = {
  fonts: [
    { fontName: '함초롬바탕', status: 'available', source: 'web', substituteFont: null },
    { fontName: '한컴바탕', status: 'needs-local-check', source: 'unknown', substituteFont: null },
    { fontName: '신명조', status: 'web-substitute', source: 'web', substituteFont: '함초롬바탕' },
    { fontName: '문서 전용 글꼴', status: 'missing', source: 'unknown', substituteFont: null },
  ],
  summary: { available: 1, needsLocalCheck: 1, webSubstitute: 1, missing: 1 },
  total: 4,
  localSupported: true,
  localSnapshotLoaded: false,
  localSnapshotStored: false,
  localSnapshotComplete: false,
  localSnapshotSource: null,
  localCheckedFonts: [],
  detectionMethod: null,
  shouldPromptLocalAccess: true,
};

/** 실제 대화상자를 띄우되 결과는 미리보기 알림으로만 소비한다. */
export function mountAuditDialogs(
  container: HTMLElement,
  report: (message: string) => void = () => {},
): void {
  const result = (label: string, value: unknown) => {
    report(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value) ?? 'closed'}`);
  };
  const group = (title: string, actions: Array<[string, AuditAction]>) => {
    const section = document.createElement('details');
    section.className = 'audit-dialog-group';
    const summary = document.createElement('summary');
    summary.textContent = title;
    section.append(summary);
    for (const [label, action] of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.auditDialog = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      button.addEventListener('click', () => {
        void Promise.resolve().then(() => action(button)).then((value) => {
          if (value !== undefined) result(label, value);
        }).catch((error: unknown) => {
          report(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
      section.append(button);
    }
    container.append(section);
  };

  group('Files & confirmations', [
    ['Confirm action', () => showConfirm('문서 변경 확인', '선택한 문서 변경을 적용하시겠습니까?')],
    ['Save as', () => showSaveAs('사업 제안서', 'hwpx')],
    ['Unsaved changes', () => showUnsavedChangesDialog({ fileName: '사업 제안서.hwpx', canSave: true })],
    ['Unsaved read-only document', () => showUnsavedChangesDialog({ fileName: '참고 자료.hwpx', canSave: false })],
    ['Dropped file confirmation', () => showDropConfirmDialog('참고 자료.hwpx')],
    ['Pending agent changes', () => showPendingAgentEditsDialog(4)],
    ['HML save formats', () => showHmlSaveFormatDialog()],
    ['Prepare version merge', () => prepareUncommittedMerge('main')],
  ]);

  group('Tables & fields', [
    ['Create table', (button) => {
      const dialog = new TableCreateDialog();
      dialog.onApply = (rows, cols, options) => result('Table', { rows, cols, options });
      dialog.show(button);
    }],
    ['Split cell', () => {
      const dialog = new CellSplitDialog(false);
      dialog.onApply = (rows, cols, equalHeight, mergeFirst) => result('Split cell', { rows, cols, equalHeight, mergeFirst });
      dialog.show();
    }],
    ['Split merged cell', () => {
      const dialog = new CellSplitDialog(true);
      dialog.onApply = (rows, cols, equalHeight, mergeFirst) => result('Split merged cell', { rows, cols, equalHeight, mergeFirst });
      dialog.show();
    }],
    ['Insert rows or columns', () => {
      const dialog = new TableInsertRowColumnDialog();
      dialog.onApply = (value) => result('Insert rows or columns', value);
      dialog.show();
    }],
    ['Delete rows or columns', () => {
      const dialog = new TableDeleteRowColumnDialog();
      dialog.onApply = (value) => result('Delete rows or columns', value);
      dialog.show();
    }],
    ['Insert field', () => {
      const dialog = new FieldInsertDialog();
      dialog.onApply = (value) => result('Insert field', value);
      dialog.show();
    }],
    ['Edit field', () => {
      const dialog = new FieldEditDialog();
      dialog.onApply = (value) => result('Edit field', value);
      dialog.showWith({ guide: '담당자 이름을 입력하세요', memo: '문서 작성 담당자', name: '담당자', editable: true });
    }],
  ]);

  group('Fonts, layout & menus', [
    ['Grid settings', () => new GridSettingsDialog(
      getGridViewSettings(), { page: { x: 20, y: 20 }, paper: { x: 0, y: 0 } }, 1,
      (settings, moveStepMm) => result('Grid settings', { settings, moveStepMm }),
    ).show()],
    ['Add font set', () => new FontSetEditDialog(null, (value) => result('Font set', value)).show()],
    ['Edit font set', () => new FontSetEditDialog({
      name: '제안서 본문', korean: '함초롬바탕', english: 'serif', chinese: 'serif',
      japanese: 'serif', other: 'serif', symbol: 'sans-serif', user: 'serif',
    }, (value) => result('Font set', value)).show()],
    ['Document font status', () => new LocalFontsModal(fontReport).showAsync()],
    ['Font status without web fonts', () => new LocalFontsModal(fontReport, { disableExternalWebFonts: true }).showAsync()],
    ['Shape picker', (button) => showShapePicker(button, { onSelect: (value) => result('Shape', value) })],
    ['Action menu', (button) => {
      const rect = button.getBoundingClientRect();
      showActionMenu(rect.left, rect.bottom, [
        { label: '이름 바꾸기', onSelect: () => result('Action', 'rename') },
        { label: '복제', onSelect: () => result('Action', 'duplicate') },
        { label: '삭제', disabled: true, title: '현재 문서는 삭제할 수 없습니다', onSelect: () => {} },
      ]);
    }],
  ]);

  const note = document.createElement('p');
  note.className = 'audit-dialog-coverage-note';
  note.textContent = 'Document rendering, formatting properties, equations, comparisons, and editor toolbars are reviewed in the running Electron app. These dialogs use local sample values.';
  container.append(note);
}

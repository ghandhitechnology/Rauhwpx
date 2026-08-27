import type { EventBus } from '../../core/event-bus.ts';
import { createEditingSettings } from './settings-editing.ts';
import type { EditorSettingsRuntime } from './settings-contract.ts';
import './agent-sidebar.css';
import './settings.css';
import './sidebar-button-modern.css';

interface EditingSettingsFallbackOptions {
  eventBus: EventBus;
  runtime: EditorSettingsRuntime;
}

let activeDialog: HTMLElement | null = null;

/** 에이전트 초기화가 실패해도 편집기 설정만은 독립 모달로 연다. */
export function showEditingSettingsFallback(options: EditingSettingsFallbackOptions): void {
  if (activeDialog) {
    activeDialog.focus();
    return;
  }

  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const overlay = document.createElement('div');
  overlay.className = 'ag-settings-fallback-overlay';
  const dialog = document.createElement('section');
  dialog.className = 'ag-root ag-settings-fallback-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'ag-settings-fallback-title');
  dialog.tabIndex = -1;

  const header = document.createElement('header');
  header.className = 'ag-settings-fallback-header';
  const title = document.createElement('h1');
  title.id = 'ag-settings-fallback-title';
  title.textContent = '편집 설정';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ag-header-icon-btn';
  close.setAttribute('aria-label', '설정 닫기');
  close.textContent = '×';
  header.append(title, close);

  const body = document.createElement('div');
  body.className = 'ag-settings-fallback-body';
  const footer = document.createElement('div');
  footer.className = 'ag-settings-apply-footer';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ag-settings-btn';
  cancel.textContent = '취소';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'ag-settings-primary';
  apply.textContent = '적용';
  footer.append(cancel, apply);

  let dirty = false;
  const controller = createEditingSettings({
    eventBus: options.eventBus,
    runtime: options.runtime,
    onDirtyChange(nextDirty) {
      dirty = nextDirty;
      apply.disabled = !dirty;
      cancel.disabled = !dirty;
    },
  });
  body.appendChild(controller.element);
  dialog.append(header, body, footer);
  overlay.appendChild(dialog);

  const finish = (discard: boolean): void => {
    if (discard) controller.cancel();
    controller.dispose();
    overlay.remove();
    activeDialog = null;
    previousFocus?.focus();
  };
  const requestClose = (): void => {
    if (dirty && !window.confirm('적용하지 않은 설정을 버릴까요?')) return;
    finish(dirty);
  };

  close.addEventListener('click', requestClose);
  cancel.addEventListener('click', () => finish(true));
  apply.addEventListener('click', () => {
    if (controller.apply()) finish(false);
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    requestClose();
  });

  activeDialog = dialog;
  document.body.appendChild(overlay);
  controller.open();
  dialog.focus();
}

import { createIcon } from './icons.ts';

type Mode = 'local' | 'cloud';

export function createExecutionLocation(options: {
  select(mode: Mode, trigger: HTMLButtonElement): void;
  configure(trigger: HTMLButtonElement): void;
}) {
  const root = document.createElement('div');
  root.className = 'ag-execution-location';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', '실행 위치');
  let started = false;
  const buttons = (['local', 'cloud'] as const).map((mode) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ag-header-icon-btn ag-execution-location-option';
    button.dataset.workspaceMode = mode;
    const label = document.createElement('span');
    label.textContent = mode === 'local' ? 'Local' : 'Cloud';
    button.append(createIcon(mode === 'local' ? 'local' : 'cloud'), label);
    button.addEventListener('click', () => {
      if (started) {
        if (mode === 'cloud') options.configure(button);
      } else options.select(mode, button);
    });
    root.append(button);
    return { mode, button, label };
  });
  return {
    root,
    update(state: { mode: Mode; started: boolean; localDisabled: boolean; cloudDisabled: boolean }) {
      started = state.started;
      root.dataset.mode = state.mode;
      root.dataset.started = String(started);
      for (const { mode, button, label } of buttons) {
        button.hidden = started && mode !== state.mode;
        label.hidden = started;
        button.disabled = started ? false : mode === 'local' ? state.localDisabled : state.cloudDisabled;
        button.setAttribute('aria-label', mode === 'cloud' ? (started ? 'Cloud 설정' : 'Cloud') : 'Local');
        button.title = mode === 'cloud' && started ? 'Cloud 설정' : mode === 'local' ? '로컬에서 실행' : 'Cloud에서 실행';
        if (started) button.removeAttribute('aria-pressed');
        else button.setAttribute('aria-pressed', String(mode === state.mode));
        if (started && mode === 'cloud') button.setAttribute('aria-haspopup', 'dialog');
        else button.removeAttribute('aria-haspopup');
      }
    },
  };
}

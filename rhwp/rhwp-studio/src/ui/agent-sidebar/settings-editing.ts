import {
  BUILTIN_FONT_SETS,
  LANG_LABELS,
  userSettings,
  type EditorScalarSettings,
  type FontSet,
} from '../../core/user-settings.ts';
import {
  clearStoredLocalFonts,
  detectLocalFonts,
  getLocalFontState,
  isLocalFontAccessSupported,
  loadStoredLocalFonts,
  type LocalFontState,
} from '../../core/local-fonts.ts';
import type { EventBus } from '../../core/event-bus.ts';
import { FontSetEditDialog } from '../font-set-edit-dialog.ts';
import {
  cloneEditorDraft,
  editorDraftEquals,
  normalizeEditorDraft,
  type EditorSettingsRuntime,
} from './settings-contract.ts';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function group(title: string, description?: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('section', 'ag-settings-group');
  const heading = el('div', 'ag-settings-group-heading');
  heading.appendChild(el('h2', 'ag-settings-group-title', title));
  if (description) heading.appendChild(el('p', 'ag-settings-group-description', description));
  const body = el('div', 'ag-settings-group-body');
  root.append(heading, body);
  return { root, body };
}

function toggleRow(
  label: string,
  description: string,
): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = el('label', 'ag-settings-control-row ag-settings-toggle-row');
  const copy = el('span', 'ag-settings-control-copy');
  copy.append(
    el('span', 'ag-settings-control-label', label),
    el('span', 'ag-settings-control-description', description),
  );
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'ag-settings-toggle-input';
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', label);
  const track = el('span', 'ag-settings-toggle-track');
  track.setAttribute('aria-hidden', 'true');
  root.append(copy, input, track);
  return { root, input };
}

function numberRow(
  label: string,
  description: string,
  min: number,
  max: number,
  unit: string,
): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = el('label', 'ag-settings-control-row');
  const copy = el('span', 'ag-settings-control-copy');
  copy.append(
    el('span', 'ag-settings-control-label', label),
    el('span', 'ag-settings-control-description', description),
  );
  const field = el('span', 'ag-settings-number-field');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.className = 'ag-settings-number-input';
  field.append(input, el('span', 'ag-settings-number-unit', unit));
  root.append(copy, field);
  return { root, input };
}

function fontValue(fontSet: FontSet, index: number): string {
  const keys: (keyof Omit<FontSet, 'name'>)[] = [
    'korean', 'english', 'chinese', 'japanese', 'other', 'symbol', 'user',
  ];
  return fontSet[keys[index] ?? 'korean'];
}

function localFontStatus(state: LocalFontState): string {
  if (state.lastError) return `저장소 접근 실패 · ${state.lastError}`;
  if (!state.stored) {
    if (!state.supported) return '이 브라우저에서는 로컬 글꼴 전체 감지를 지원하지 않습니다.';
    return '저장된 감지 결과가 없습니다.';
  }
  const date = state.detectedAt ? new Date(state.detectedAt).toLocaleDateString('ko-KR') : '';
  return `${state.count.toLocaleString()}개 감지${date ? ` · ${date}` : ''}`;
}

export interface EditingSettingsController {
  element: HTMLElement;
  documentResources: HTMLElement;
  open(): void;
  isDirty(): boolean;
  apply(): boolean;
  cancel(): void;
  dispose(): void;
}

export function createEditingSettings(options: {
  eventBus?: EventBus;
  runtime: EditorSettingsRuntime;
  onDirtyChange: (dirty: boolean) => void;
}): EditingSettingsController {
  const { eventBus, runtime, onDirtyChange } = options;
  let baseline = userSettings.getEditorScalarSettings();
  let draft = cloneEditorDraft(baseline);
  let conflictSnapshot: EditorScalarSettings | null = null;

  const element = el('div', 'ag-settings-destination-content ag-settings-editing-content');
  const conflict = el('div', 'ag-settings-conflict');
  conflict.hidden = true;
  conflict.setAttribute('role', 'status');
  const conflictCopy = el(
    'span',
    'ag-settings-conflict-copy',
    '다른 문서 창에서 설정이 변경됐습니다. 이 초안을 다시 불러오거나 유지하세요.',
  );
  const conflictActions = el('span', 'ag-settings-actions');
  const conflictReload = el('button', 'ag-settings-btn', '다시 불러오기');
  conflictReload.type = 'button';
  const conflictKeep = el('button', 'ag-settings-btn', '내 변경 유지');
  conflictKeep.type = 'button';
  conflictActions.append(conflictReload, conflictKeep);
  conflict.append(conflictCopy, conflictActions);

  const appearance = group('화면과 보기', '편집 화면과 문서 표시 방식을 정합니다.');
  const themeRow = el('div', 'ag-settings-control-row');
  const themeCopy = el('span', 'ag-settings-control-copy');
  themeCopy.append(
    el('span', 'ag-settings-control-label', '테마'),
    el('span', 'ag-settings-control-description', '앱 화면의 밝기를 선택합니다.'),
  );
  const themeChoices = el('div', 'ag-settings-segmented');
  themeChoices.setAttribute('role', 'radiogroup');
  themeChoices.setAttribute('aria-label', '테마');
  const themeButtons = new Map<EditorScalarSettings['theme']['mode'], HTMLButtonElement>();
  for (const [mode, label] of [['system', '시스템'], ['light', '밝게'], ['dark', '어둡게']] as const) {
    const button = el('button', 'ag-settings-segment', label);
    button.type = 'button';
    button.dataset.value = mode;
    button.setAttribute('role', 'radio');
    button.addEventListener('click', () => {
      draft.theme.mode = mode;
      previewAndRender();
    });
    themeChoices.appendChild(button);
    themeButtons.set(mode, button);
  }
  themeRow.append(themeCopy, themeChoices);

  const paragraphMarks = toggleRow('문단 부호', '문단 끝에 ¶ 표시를 보여 줍니다.');
  const controlCodes = toggleRow('조판 부호', '개체와 조판 제어 표시를 문단 부호와 함께 보여 줍니다.');
  const clipView = toggleRow('잘림 보기', '편집용지 경계 밖의 내용을 계속 보여 줍니다.');
  const pictureRatio = toggleRow('그림 비율 유지', '그림 속성을 열 때 너비와 높이의 비율을 기본으로 고정합니다.');
  appearance.body.append(
    themeRow,
    paragraphMarks.root,
    controlCodes.root,
    clipView.root,
    pictureRatio.root,
  );

  paragraphMarks.input.addEventListener('change', () => {
    draft.view.showParagraphMarks = paragraphMarks.input.checked;
    if (!draft.view.showParagraphMarks) draft.view.showControlCodes = false;
    previewAndRender();
  });
  controlCodes.input.addEventListener('change', () => {
    draft.view.showControlCodes = controlCodes.input.checked;
    if (draft.view.showControlCodes) draft.view.showParagraphMarks = true;
    previewAndRender();
  });
  clipView.input.addEventListener('change', () => {
    draft.view.clipView = clipView.input.checked;
    previewAndRender();
  });
  pictureRatio.input.addEventListener('change', () => {
    draft.dialog.picturePropsKeepRatio = pictureRatio.input.checked;
    render();
  });

  const fonts = group('글꼴', '최근 글꼴, 대표 글꼴, 이 기기의 로컬 글꼴을 관리합니다.');
  const recentFonts = toggleRow('최근 사용 글꼴 보이기', '글꼴 메뉴에 직접 적용한 글꼴을 최신순으로 표시합니다.');
  const recentCount = numberRow('표시 개수', '최근 글꼴 목록에 표시할 개수입니다.', 1, 5, '개');
  const fontSetHeader = el('div', 'ag-settings-resource-header');
  const fontSetHeaderCopy = el('div', 'ag-settings-control-copy');
  fontSetHeaderCopy.append(
    el('span', 'ag-settings-control-label', '대표 글꼴'),
    el('span', 'ag-settings-control-description', '언어별 글꼴을 한 묶음으로 적용합니다.'),
  );
  const addFontSet = el('button', 'ag-settings-btn', '대표 글꼴 추가');
  addFontSet.type = 'button';
  fontSetHeader.append(fontSetHeaderCopy, addFontSet);
  const fontSetList = el('div', 'ag-settings-resource-list');

  const localHeader = el('div', 'ag-settings-resource-header');
  const localCopy = el('div', 'ag-settings-control-copy');
  const localTitle = el('span', 'ag-settings-control-label', '로컬 글꼴');
  const localStatus = el('span', 'ag-settings-control-description', '감지 결과 확인 중…');
  localCopy.append(localTitle, localStatus);
  const localActions = el('div', 'ag-settings-actions');
  const detectFonts = el('button', 'ag-settings-btn', '로컬 글꼴 감지');
  detectFonts.type = 'button';
  const clearFonts = el('button', 'ag-settings-btn', '감지 결과 초기화');
  clearFonts.type = 'button';
  localActions.append(detectFonts, clearFonts);
  localHeader.append(localCopy, localActions);
  fonts.body.append(recentFonts.root, recentCount.root, fontSetHeader, fontSetList, localHeader);

  recentFonts.input.addEventListener('change', () => {
    draft.font.showRecentFonts = recentFonts.input.checked;
    render();
  });
  recentCount.input.addEventListener('input', () => {
    draft.font.recentFontCount = Number(recentCount.input.value);
    renderDirty();
  });

  const renderFontSets = (): void => {
    fontSetList.replaceChildren();
    const appendRow = (fontSet: FontSet, index: number | null) => {
      const row = el('div', 'ag-settings-resource-row');
      const copy = el('div', 'ag-settings-control-copy');
      const name = el('span', 'ag-settings-control-label', fontSet.name);
      const summary = el(
        'span',
        'ag-settings-control-description',
        `${LANG_LABELS[0]} ${fontValue(fontSet, 0)} · ${LANG_LABELS[1]} ${fontValue(fontSet, 1)}`,
      );
      copy.append(name, summary);
      const actions = el('div', 'ag-settings-actions');
      if (index === null) {
        actions.appendChild(el('span', 'ag-settings-resource-badge', '내장'));
      } else {
        const edit = el('button', 'ag-settings-btn', '편집');
        edit.type = 'button';
        edit.addEventListener('click', () => {
          new FontSetEditDialog(fontSet, (updated) => {
            const duplicate = userSettings.getAllFontSets().some((candidate) => (
              candidate.name === updated.name && candidate !== fontSet
            ));
            if (duplicate) {
              window.alert('같은 이름의 대표 글꼴이 이미 등록되어 있습니다.');
              return;
            }
            userSettings.updateFontSet(index, updated);
            renderFontSets();
            eventBus?.emit('font-settings-changed');
          }).show();
        });
        const remove = el('button', 'ag-settings-btn ag-settings-danger', '삭제');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          if (!window.confirm(`“${fontSet.name}” 대표 글꼴을 삭제할까요?`)) return;
          userSettings.removeFontSet(index);
          renderFontSets();
          eventBus?.emit('font-settings-changed');
        });
        actions.append(edit, remove);
      }
      row.append(copy, actions);
      fontSetList.appendChild(row);
    };
    BUILTIN_FONT_SETS.forEach((fontSet) => appendRow(fontSet, null));
    userSettings.getUserFontSets().forEach((fontSet, index) => appendRow(fontSet, index));
  };

  addFontSet.addEventListener('click', () => {
    new FontSetEditDialog(null, (created) => {
      if (!userSettings.addFontSet(created)) {
        window.alert('같은 이름의 대표 글꼴이 이미 등록되어 있습니다.');
        return;
      }
      renderFontSets();
      eventBus?.emit('font-settings-changed');
    }).show();
  });

  const renderLocalFonts = (message?: string): void => {
    const state = getLocalFontState();
    localStatus.textContent = message ?? localFontStatus(state);
    clearFonts.disabled = !state.stored;
    detectFonts.disabled = !isLocalFontAccessSupported();
    detectFonts.textContent = state.stored ? '로컬 글꼴 재감지' : '로컬 글꼴 감지';
  };
  detectFonts.addEventListener('click', async () => {
    detectFonts.disabled = true;
    clearFonts.disabled = true;
    renderLocalFonts('감지 중…');
    detectFonts.disabled = true;
    clearFonts.disabled = true;
    try {
      const detected = await detectLocalFonts({ force: true });
      renderLocalFonts(`${detected.length.toLocaleString()}개 로컬 글꼴을 감지했습니다.`);
      eventBus?.emit('local-fonts-changed', { fonts: detected, source: 'settings' });
    } catch (error) {
      renderLocalFonts(error instanceof Error ? error.message : String(error));
    }
    detectFonts.disabled = !isLocalFontAccessSupported();
  });
  clearFonts.addEventListener('click', async () => {
    if (!window.confirm('저장된 로컬 글꼴 감지 결과를 초기화할까요?')) return;
    detectFonts.disabled = true;
    clearFonts.disabled = true;
    localStatus.textContent = '초기화 중…';
    try {
      await clearStoredLocalFonts();
      renderLocalFonts('저장된 감지 결과를 초기화했습니다.');
      eventBus?.emit('local-fonts-changed', { fonts: [], source: 'settings-clear' });
    } catch (error) {
      renderLocalFonts(error instanceof Error ? error.message : String(error));
    }
    detectFonts.disabled = !isLocalFontAccessSupported();
  });

  const files = group('저장과 파일', '문서 복구와 파일 저장 안내를 정합니다.');
  const recovery = toggleRow('복구용 자동 저장', '편집 중인 문서의 복구본을 주기적으로 만듭니다.');
  const recoveryInterval = numberRow('복구 간격', '대형 문서는 간격을 길게 두면 멈춤을 줄일 수 있습니다.', 1, 120, '분');
  const idleSave = toggleRow('쉴 때 자동 저장', '입력이 멈춘 뒤 복구본을 만듭니다.');
  const idleDelay = numberRow('대기 시간', '마지막 입력 뒤 자동 저장까지 기다리는 시간입니다.', 5, 600, '초');
  const pdfGuidance = toggleRow('PDF 저장 안내', 'PDF 저장을 시작하기 전에 인쇄 대상 선택 방법을 보여 줍니다.');
  files.body.append(
    recovery.root,
    recoveryInterval.root,
    idleSave.root,
    idleDelay.root,
    pdfGuidance.root,
  );
  recovery.input.addEventListener('change', () => {
    draft.autosave.recoveryEnabled = recovery.input.checked;
    render();
  });
  recoveryInterval.input.addEventListener('input', () => {
    draft.autosave.recoveryIntervalMinutes = Number(recoveryInterval.input.value);
    renderDirty();
  });
  idleSave.input.addEventListener('change', () => {
    draft.autosave.idleSaveEnabled = idleSave.input.checked;
    render();
  });
  idleDelay.input.addEventListener('input', () => {
    draft.autosave.idleDelaySeconds = Number(idleDelay.input.value);
    renderDirty();
  });
  pdfGuidance.input.addEventListener('change', () => {
    draft.dialog.showPdfPrintGuidance = pdfGuidance.input.checked;
    render();
  });

  const documentGroup = group('문서 자원', '문서 템플릿과 버전 관리 방식을 선택합니다.');
  const versionControl = toggleRow('한컴용 Git 사용하기', '기본 문서 이력 대신 브랜치 기반 버전 관리를 사용합니다.');
  const documentResources = el('div', 'ag-settings-document-resources');
  documentGroup.body.append(versionControl.root, documentResources);
  versionControl.input.addEventListener('change', () => {
    draft.versionControl.useHancomGit = versionControl.input.checked;
    render();
  });

  const status = el('p', 'ag-settings-apply-status');
  status.hidden = true;
  status.setAttribute('role', 'status');
  const footer = el('div', 'ag-settings-apply-footer');
  const cancel = el('button', 'ag-settings-btn', '취소');
  cancel.type = 'button';
  const apply = el('button', 'ag-settings-primary', '적용');
  apply.type = 'button';
  footer.append(status, cancel, apply);

  element.append(conflict, appearance.root, fonts.root, files.root, documentGroup.root, footer);

  function isDirty(): boolean {
    return !editorDraftEquals(normalizeEditorDraft(draft), normalizeEditorDraft(baseline));
  }

  function renderDirty(): void {
    const dirty = isDirty();
    apply.disabled = !dirty;
    cancel.disabled = !dirty;
    onDirtyChange(dirty);
  }

  function render(): void {
    for (const [mode, button] of themeButtons) {
      const selected = draft.theme.mode === mode;
      button.classList.toggle('ag-active', selected);
      button.setAttribute('aria-checked', String(selected));
    }
    paragraphMarks.input.checked = draft.view.showParagraphMarks;
    controlCodes.input.checked = draft.view.showControlCodes;
    clipView.input.checked = draft.view.clipView;
    pictureRatio.input.checked = draft.dialog.picturePropsKeepRatio;
    recentFonts.input.checked = draft.font.showRecentFonts;
    recentCount.input.value = String(draft.font.recentFontCount);
    recentCount.input.disabled = !draft.font.showRecentFonts;
    recovery.input.checked = draft.autosave.recoveryEnabled;
    recoveryInterval.input.value = String(draft.autosave.recoveryIntervalMinutes);
    recoveryInterval.input.disabled = !draft.autosave.recoveryEnabled;
    idleSave.input.checked = draft.autosave.idleSaveEnabled;
    idleDelay.input.value = String(draft.autosave.idleDelaySeconds);
    idleDelay.input.disabled = !draft.autosave.idleSaveEnabled;
    pdfGuidance.input.checked = draft.dialog.showPdfPrintGuidance;
    versionControl.input.checked = draft.versionControl.useHancomGit;
    renderDirty();
  }

  function previewAndRender(): void {
    draft = normalizeEditorDraft(draft);
    runtime.preview(draft);
    render();
  }

  function applyDraft(): boolean {
    const next = normalizeEditorDraft(draft);
    const result = userSettings.tryApplyEditorScalarSettings(next);
    if (!result.ok) {
      status.textContent = `설정을 저장하지 못했습니다 · ${result.error}`;
      status.hidden = false;
      return false;
    }
    baseline = cloneEditorDraft(result.value);
    draft = cloneEditorDraft(result.value);
    status.textContent = '편집 설정을 적용했습니다.';
    status.hidden = false;
    conflictSnapshot = null;
    conflict.hidden = true;
    runtime.committed(result.value);
    render();
    return true;
  }

  function cancelDraft(): void {
    draft = cloneEditorDraft(baseline);
    conflictSnapshot = null;
    conflict.hidden = true;
    status.hidden = true;
    runtime.preview(baseline);
    render();
  }

  apply.addEventListener('click', applyDraft);
  cancel.addEventListener('click', cancelDraft);
  conflictReload.addEventListener('click', () => {
    if (!conflictSnapshot) return;
    baseline = cloneEditorDraft(conflictSnapshot);
    draft = cloneEditorDraft(conflictSnapshot);
    conflictSnapshot = null;
    conflict.hidden = true;
    runtime.committed(draft);
    render();
  });
  conflictKeep.addEventListener('click', () => {
    if (!conflictSnapshot) return;
    baseline = cloneEditorDraft(conflictSnapshot);
    conflictSnapshot = null;
    conflict.hidden = true;
    runtime.preview(draft);
    render();
  });

  const unsubscribe = userSettings.subscribe((_settings, source) => {
    if (source !== 'external') return;
    const external = userSettings.getEditorScalarSettings();
    runtime.committed(external);
    if (isDirty()) {
      conflictSnapshot = external;
      conflict.hidden = false;
      runtime.preview(draft);
      return;
    }
    baseline = cloneEditorDraft(external);
    draft = cloneEditorDraft(external);
    render();
  });

  renderFontSets();
  render();
  void loadStoredLocalFonts().then(
    () => renderLocalFonts(),
    () => renderLocalFonts('저장된 감지 결과를 확인하지 못했습니다.'),
  );

  return {
    element,
    documentResources,
    open(): void {
      if (!isDirty()) {
        baseline = userSettings.getEditorScalarSettings();
        draft = cloneEditorDraft(baseline);
      }
      renderFontSets();
      renderLocalFonts();
      render();
    },
    isDirty,
    apply: applyDraft,
    cancel: cancelDraft,
    dispose(): void {
      unsubscribe();
    },
  };
}

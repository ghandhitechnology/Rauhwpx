import type { EditorScalarSettings } from '../../core/user-settings.ts';

export type SettingsDestination = 'editing' | 'ai' | 'connections';

export interface EditorSettingsRuntime {
  /** 테마와 문서 보기 상태를 저장 없이 현재 창에 반영한다. */
  preview(settings: EditorScalarSettings): void;
  /** 저장 뒤 자동저장, 메뉴, 글꼴 목록 같은 소비자를 갱신한다. */
  committed(settings: EditorScalarSettings): void;
}

export type DirtyExitChoice = 'apply' | 'discard' | 'continue';

export function cloneEditorDraft(settings: EditorScalarSettings): EditorScalarSettings {
  return {
    font: { ...settings.font },
    theme: { ...settings.theme },
    dialog: { ...settings.dialog },
    view: { ...settings.view },
    versionControl: { ...settings.versionControl },
    autosave: { ...settings.autosave },
  };
}

export function editorDraftEquals(
  left: EditorScalarSettings,
  right: EditorScalarSettings,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 한컴 보기 계약을 초안 단계에서도 지켜 미리보기와 저장값이 어긋나지 않게 한다. */
export function normalizeEditorDraft(settings: EditorScalarSettings): EditorScalarSettings {
  const normalized = cloneEditorDraft(settings);
  normalized.font.recentFontCount = Math.min(
    5,
    Math.max(1, Math.round(normalized.font.recentFontCount || 3)),
  );
  normalized.autosave.recoveryIntervalMinutes = Math.min(
    120,
    Math.max(1, Math.round(normalized.autosave.recoveryIntervalMinutes || 10)),
  );
  normalized.autosave.idleDelaySeconds = Math.min(
    600,
    Math.max(5, Math.round(normalized.autosave.idleDelaySeconds || 10)),
  );
  if (normalized.view.showControlCodes) normalized.view.showParagraphMarks = true;
  if (!normalized.view.showParagraphMarks) normalized.view.showControlCodes = false;
  return normalized;
}

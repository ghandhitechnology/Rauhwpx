import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cloneEditorDraft,
  editorDraftEquals,
  isSettingsDestination,
  normalizeEditorDraft,
} from '../src/ui/agent-sidebar/settings-contract.ts';
import { normalizeAppSettings } from '../src/core/user-settings.ts';

function editorSettings() {
  const settings = normalizeAppSettings({});
  return {
    font: {
      showRecentFonts: settings.font.showRecentFonts,
      recentFontCount: settings.font.recentFontCount,
    },
    theme: settings.theme,
    dialog: settings.dialog,
    view: settings.view,
    versionControl: settings.versionControl,
    autosave: settings.autosave,
  };
}

test('편집 초안은 중첩 객체까지 복제하고 동등성을 판정한다', () => {
  const original = editorSettings();
  const clone = cloneEditorDraft(original);
  assert.ok(editorDraftEquals(original, clone));
  clone.theme.mode = 'dark';
  assert.equal(original.theme.mode, 'system');
  assert.equal(editorDraftEquals(original, clone), false);
});

test('초안 정규화는 표시 범위와 조판 부호 불변식을 지킨다', () => {
  const draft = editorSettings();
  draft.font.recentFontCount = 80;
  draft.autosave.recoveryIntervalMinutes = -1;
  draft.autosave.idleDelaySeconds = 900;
  draft.view.showParagraphMarks = false;
  draft.view.showControlCodes = true;
  const normalized = normalizeEditorDraft(draft);
  assert.equal(normalized.font.recentFontCount, 5);
  assert.equal(normalized.autosave.recoveryIntervalMinutes, 1);
  assert.equal(normalized.autosave.idleDelaySeconds, 600);
  assert.equal(normalized.view.showParagraphMarks, true);
  assert.equal(normalized.view.showControlCodes, true);
});

test('설정 목적지는 편집·AI·연결만 받고 그 외 값은 버린다', () => {
  assert.equal(isSettingsDestination('product'), false);
  assert.equal(isSettingsDestination('editing'), true);
  assert.equal(isSettingsDestination('about'), false);
});

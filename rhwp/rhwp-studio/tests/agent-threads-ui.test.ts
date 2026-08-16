import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const calibration = readFileSync(new URL('../src/ui/agent-sidebar/writing-style-calibration.ts', import.meta.url), 'utf8');
const calibrationCss = readFileSync(new URL('../src/ui/agent-sidebar/writing-style-calibration.css', import.meta.url), 'utf8');

test('threads column control sits on the selector bar and opens a page', () => {
  assert.match(source, /ag-threads-btn/);
  assert.match(source, /createColumnIcon/);
  assert.match(source, /새 채팅/);
  assert.match(source, /startNewChat/);
  assert.match(source, /requestTitle/);
  assert.match(source, /ag-chat-page/);
  assert.match(source, /ag-threads-page/);
  assert.match(source, /chatPage\.append\(header,/);
  assert.match(css, /\.ag-threads-page/);
  assert.match(css, /\.ag-threads-open \.ag-chat-page/);
  assert.match(css, /\.ag-threads-open \.ag-threads-page/);
});

test('sidebar header keeps one compact model summary and expands all settings together', () => {
  assert.match(source, /ag-document-context/);
  assert.match(source, /ag-document-name/);
  assert.match(source, /ag-selection-context/);
  assert.match(source, /ag-model-summary/);
  assert.match(source, /ag-config-panel/);
  assert.match(source, /providerTrigger\.append\(providerIcon, providerName\)/);
  assert.match(source, /llmTrigger\.append\(llmName\)/);
  assert.match(source, /effortTrigger\.append\(effortName, summaryCaret\)/);
  assert.doesNotMatch(source, /createChevron\('ag-model-caret'\)/);
  assert.match(source, /configPanelInner\.append\(providerGroup, llmGroup, effortGroup\)/);
  assert.match(css, /\.ag-config-panel\s*\{[^}]*display:\s*grid;/s);
  assert.match(css, /\.ag-config-panel \.ag-model-menu\s*\{[^}]*position:\s*static;/s);
});

test('model, permission, and skill utilities live in the composer accessory row', () => {
  assert.match(source, /ag-composer-utilities/);
  assert.match(source, /ag-composer-meta/);
  assert.match(source, /composerUtilityActions\.append\(phaseBadge, permissionBtn, skillsBtn\)/);
  assert.match(source, /composerUtilities\.append\(composerUtilityActions\)/);
  assert.match(source, /composerMeta\.append\(selectors, composerUtilities\)/);
  assert.match(source, /composer\.append\(composerOverlay, slashMenu, composerField, composerMeta, configPanel\)/);
  assert.match(source, /chatPage\.append\(header, connBanner, messages, review, planSurface, composer\)/);
  assert.match(source, /permissionBtn\.textContent = unrestricted \? '전체' : '안전'/);
  assert.match(css, /\.ag-composer-meta\s*\{/);
  assert.doesNotMatch(css, /\.ag-composer-utilities\s*\{[^}]*flex-direction:\s*column;/s);
});

test('writing-style calibration opens from a local slash command', () => {
  assert.match(source, /value: '\/calibration'[^\n]*local: 'calibration'/);
  assert.match(source, /option\.local === 'calibration'[^\n]*writingStyleCalibration\.open\(\)/);
  assert.match(source, /text === '\/calibration'[^\n]*writingStyleCalibration\.open\(\)/);
  assert.ok(source.indexOf("if (text === '/calibration')") < source.indexOf('recordUserMessage(visibleText,'));
  assert.match(calibration, /export interface WritingStyleCalibrationUi \{\s*open\(\): void;/);
  assert.match(calibration, /if \(requestId \|\| submitting\) \{\s*setStep\(2\);/);
  assert.match(calibration, /else if \(activeStatus\?\.active\) showResult\(activeStatus\);/);
  assert.doesNotMatch(calibration, /ag-calibration-launch/);
  assert.doesNotMatch(calibrationCss, /ag-calibration-launch/);
});

test('replaced connection state exposes an explicit takeover action', () => {
  assert.match(source, /이 탭에서 연결/);
  assert.match(source, /bridge\.takeOverConnection\(\)/);
  assert.match(source, /takeoverBtn\.hidden = state !== 'replaced'/);
  assert.match(css, /\.ag-takeover-btn/);
});

test('library move is a context menu on document group names', () => {
  assert.match(source, /showActionMenu/);
  assert.match(source, /groupBtn\.addEventListener\('contextmenu'/);
  assert.match(source, /label: '이동'/);
  assert.match(source, /moveToLibraryDocument\?\.\(\{[\s\S]*documentId: group\.documentId[\s\S]*fileName: group\.docKey/s);
  assert.match(source, /disabled: isCurrentDoc/);
  assert.match(source, /dataset\.libraryDoc = 'true'/);
  assert.match(source, /aria-haspopup', 'menu'/);
});

test('saving a document rebinds the current chat instead of starting a new one', () => {
  assert.match(
    source,
    /const sameIdentity = Boolean\(\s*nextDocumentId && currentDocumentId && nextDocumentId === currentDocumentId/s,
  );
  assert.match(source, /currentThread\.docKey = nextKey;/);
  assert.match(source, /currentThread\.documentId = nextDocumentId;/);
});

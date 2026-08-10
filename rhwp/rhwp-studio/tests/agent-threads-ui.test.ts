import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');

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

test('permission and skill utilities remain visible above the composer', () => {
  assert.match(source, /ag-composer-utilities/);
  assert.match(source, /composerWorkflowRow\.append\(workflowGroup, phaseBadge\)/);
  assert.match(source, /composerUtilityActions\.append\(writingStyleCalibration\.button, permissionBtn, skillsBtn\)/);
  assert.match(source, /composerUtilities\.append\(composerWorkflowRow, composerUtilityActions\)/);
  assert.match(source, /chatPage\.append\(header, messages, review, composerUtilities, composer\)/);
  assert.match(source, /permissionBtn\.textContent = unrestricted \? '권한: 전체 접근' : '권한: 안전'/);
  assert.match(css, /\.ag-composer-utilities\s*\{[^}]*flex-direction:\s*column;/s);
});

test('replaced connection state exposes an explicit takeover action', () => {
  assert.match(source, /이 탭에서 연결/);
  assert.match(source, /bridge\.takeOverConnection\(\)/);
  assert.match(source, /takeoverBtn\.hidden = state !== 'replaced'/);
  assert.match(css, /\.ag-takeover-btn/);
});

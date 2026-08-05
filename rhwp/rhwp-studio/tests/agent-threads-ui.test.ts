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

test('sidebar header foregrounds document context and demotes model controls', () => {
  assert.match(source, /ag-document-context/);
  assert.match(source, /ag-document-name/);
  assert.match(source, /ag-selection-context/);
  assert.match(source, /ag-config-panel/);
  assert.match(source, /settingsBtn\.setAttribute\('aria-controls', 'ag-config-panel'\)/);
  assert.match(source, /configPanel\.append\(selectors, configActions\)/);
  assert.match(css, /\.ag-config-panel\s*\{[^}]*position:\s*absolute;/s);
});

test('replaced connection state exposes an explicit takeover action', () => {
  assert.match(source, /이 탭에서 연결/);
  assert.match(source, /bridge\.takeOverConnection\(\)/);
  assert.match(source, /takeoverBtn\.hidden = state !== 'replaced'/);
  assert.match(css, /\.ag-takeover-btn/);
});

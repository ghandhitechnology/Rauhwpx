import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const shelf = readFileSync(new URL('../src/ui/agent-sidebar/skills-shelf.ts', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');

test('sidebar exposes safe/full permissions without allowing changes during a turn', () => {
  assert.match(source, /permissionProfile === 'safe'/);
  assert.match(source, /await confirmSheet\(permissionBtn, '전체 접근', '승인 없이 편집하고 파일에 접근합니다\.'/);
  assert.match(source, /permissionBtn\.disabled = controlsLocked \|\| connState !== 'connected'/);
  assert.match(bridge, /chat-permission-set/);
  assert.match(bridge, /this\.permissionProfile = 'safe'/);
});

test('skill shelf lists, imports, edits, and creates product skills', () => {
  assert.match(source, /스킬 라이브러리/);
  assert.match(source, /createSkillsShelf/);
  assert.match(shelf, /placeholder = '검색'/);
  assert.match(shelf, /'가져오기'/);
  assert.match(shelf, /'닫기'/);
  assert.match(shelf, /'삭제'/);
  assert.match(shelf, /'되돌리기'/);
  assert.match(shelf, /'없음'/);
  assert.match(shelf, /'새 스킬 만들기'/);
  assert.match(shelf, /createNewSkillEditor/);
  assert.match(shelf, /action: 'create'/);
  assert.match(css, /\.ag-skill-editor \{/);
  assert.match(css, /\.ag-fullscreen \.ag-skill-new-editor/);
  assert.doesNotMatch(css, /\.ag-skill-editor-artifact/);
  assert.match(shelf, /aria-label', '사용'/);
  assert.match(shelf, /action: 'import'/);
  assert.match(shelf, /mode: 'adopt'/);
  assert.match(shelf, /mode: 'replace'/);
  assert.match(shelf, /LOCAL_EDITS/);
  assert.doesNotMatch(shelf, /검증하기|사용 중|window\.confirm|ag-skills-group-title/);
  assert.doesNotMatch(source, /bridge\.validateSkill|generateSkillDraft|\/skill-create|\/skill-edit|\/skill-delete/);
  assert.doesNotMatch(css, /\.ag-skills-group-title/);
  assert.match(css, /\.ag-skills-search\s*\{[^}]*border:\s*0/s);
  assert.match(css, /\.ag-skill-text\s*\{[^}]*border:\s*0/s);
  assert.match(css, /\.ag-skill-toggle\s*\{[^}]*border:\s*0/s);
});

test('slash menu supports local commands and explicit product-skill invocation', () => {
  assert.match(source, /value: '\/skills'/);
  assert.doesNotMatch(source, /value: '\/skill-create'/);
  assert.doesNotMatch(source, /value: '\/skill-edit'/);
  assert.doesNotMatch(source, /value: '\/skill-delete'/);
  assert.match(source, /bridge\.sendUserMessage\(requestText, skillNameForMessage, staged\.map/);
  assert.match(source, /startsWith\('\/\/'\)/);
  assert.match(source, /row\.classList\.add\('ag-command-option'\)/);
  assert.match(source, /ag-slash-command-icon/);
  assert.match(source, /icon\.appendChild\(createIcon\('external'\)\)/);
});

test('skill UI has keyboard and live-region semantics', () => {
  assert.match(source, /aria-label', '슬래시 명령과 스킬'/);
  assert.match(source, /e\.key === 'ArrowDown'/);
  assert.match(source, /aria-activedescendant/);
  assert.match(source, /aria-autocomplete/);
  assert.match(shelf, /skillsStatus\.setAttribute\('aria-live', 'polite'\)|status\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(source, /skillsClose\.setAttribute\('aria-label', '채팅으로 돌아가기'\)/);
});

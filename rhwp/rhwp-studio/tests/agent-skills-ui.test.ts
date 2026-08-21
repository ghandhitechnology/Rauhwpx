import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');

test('sidebar exposes safe/full permissions without allowing changes during a turn', () => {
  assert.match(source, /permissionProfile === 'safe'/);
  assert.match(source, /window\.confirm\('전체 접근/);
  assert.match(source, /permissionBtn\.disabled = controlsLocked \|\| connState !== 'connected'/);
  assert.match(bridge, /chat-permission-set/);
  assert.match(bridge, /this\.permissionProfile = 'safe'/);
});

test('skill library includes catalog, guided draft, review, and recoverable management controls', () => {
  assert.match(source, /스킬 라이브러리/);
  assert.match(source, /AI로 초안 만들기/);
  assert.match(source, /검증하기/);
  assert.match(source, /bridge\.validateSkill/);
  assert.match(source, /복구 가능한 휴지통/);
  assert.match(source, /skillResources\.type = 'file'/);
  assert.match(source, /skill\.required \? '필수'/);
  assert.match(source, /toggle\.disabled = Boolean\(skill\.required\)/);
  assert.match(source, /\['references', '참고자료'\]/);
  assert.match(source, /\['scripts', '스크립트'\]/);
});

test('skill creator exposes a compact persistent icon selector at the top', () => {
  assert.match(source, /const skillIconPicker = el\('fieldset', 'ag-skill-icon-picker'\)/);
  assert.match(source, /\['pencil', '연필'\]/);
  assert.match(source, /\['bot', '봇'\]/);
  assert.match(source, /\['system', '시스템'\]/);
  assert.match(source, /const skillIconLabel = el\('span', 'ag-skill-icon-label', '아이콘'\)/);
  assert.match(source, /skillIconPicker\.setAttribute\('aria-labelledby', skillIconLabel\.id\)/);
  assert.doesNotMatch(source, /ag-skill-icon-option-label/);
  assert.match(source, /skillEditor\.append\(skillEditorHeader, skillIconPicker,/);
  assert.match(source, /withSkillIconFrontmatter\(file\.content, selectedSkillIcon\)/);
  assert.match(source, /radio\.addEventListener\('change'/);
  assert.match(css, /\.ag-skill-icon-options[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.ag-skill-icon-option:has\(input:checked\)/);
  assert.match(css, /width: 112px/);
  assert.match(css, /min-height: 30px/);
  assert.match(css, /var\(--ag-accent\)/);
});

test('slash menu supports local commands and explicit product-skill invocation', () => {
  assert.match(source, /value: '\/skills'/);
  assert.match(source, /value: '\/skill-create'/);
  assert.match(source, /value: '\/skill-edit'/);
  assert.match(source, /value: '\/skill-delete'/);
  assert.match(source, /bridge\.sendUserMessage\(text, skillNameForMessage, staged\.map/);
  assert.match(source, /startsWith\('\/\/'\)/);
  assert.match(source, /row\.classList\.add\('ag-command-option'\)/);
  assert.match(source, /ag-slash-command-icon/);
  assert.match(source, /icon\.appendChild\(createIcon\('external'\)\)/);
  assert.match(css, /\.ag-slash-command-icon \{ color: var\(--ag-text-muted\); \}/);
  assert.match(css, /\.ag-slash-menu/);
});

test('skill UI has keyboard and live-region semantics', () => {
  assert.match(source, /aria-label', '슬래시 명령과 스킬'/);
  assert.match(source, /e\.key === 'ArrowDown'/);
  assert.match(source, /aria-activedescendant/);
  assert.match(source, /aria-autocomplete/);
  assert.match(source, /skillsStatus\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(source, /skillsClose\.setAttribute\('aria-label', '채팅으로 돌아가기'\)/);
});

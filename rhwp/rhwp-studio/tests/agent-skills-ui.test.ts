import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
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

test('slash menu supports local commands and explicit product-skill invocation', () => {
  assert.match(source, /value: '\/skills'/);
  assert.match(source, /value: '\/skill-create'/);
  assert.match(source, /value: '\/skill-edit'/);
  assert.match(source, /value: '\/skill-delete'/);
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
  assert.match(source, /skillsStatus\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(source, /skillsClose\.setAttribute\('aria-label', '채팅으로 돌아가기'\)/);
});

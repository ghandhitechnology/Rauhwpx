import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { fallbackTitle } from '../src/agent/threads.ts';
import { requestTextForSkillInvocation } from '../src/ui/agent-sidebar/skill-presentation.ts';

const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
test('a skill token keeps empty history text while sending a valid wire request', () => {
  assert.match(sidebar, /!text && !activeComposerSkill && !referenceLibrary\.hasDrafts\(\)/);
  assert.match(sidebar, /text = invocation\[2\]\?\.trim\(\) \?\? ''/);
  assert.doesNotMatch(sidebar, /이 스킬을 현재 문서에 적용해 주세요/);
  assert.match(sidebar, /const requestText = requestTextForSkillInvocation\(text, skillNameForMessage\)/);
  assert.match(sidebar, /recordUserMessage\(messageText,[\s\S]*skillNameForMessage,[\s\S]*skillIconForMessage/);
  assert.match(sidebar, /bridge\.sendUserMessage\(requestText, skillNameForMessage/);

  const messageText = '';
  assert.equal(requestTextForSkillInvocation(messageText, 'summarize-document'), '/summarize-document');
  assert.equal(messageText, '');
  assert.equal(fallbackTitle([{ role: 'user', text: messageText, skillName: 'summarize-document' }]), '/summarize-document');
});

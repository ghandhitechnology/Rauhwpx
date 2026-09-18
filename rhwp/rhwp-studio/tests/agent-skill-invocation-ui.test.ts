import assert from 'node:assert/strict';
import test from 'node:test';

import { fallbackTitle } from '../src/agent/threads.ts';
import { requestTextForSkillInvocation } from '../src/ui/agent-sidebar/skill-presentation.ts';

test('a skill token keeps empty history text while sending a valid wire request', () => {
  const messageText = '';
  assert.equal(requestTextForSkillInvocation(messageText, 'summarize-document'), '/summarize-document');
  assert.equal(messageText, '');
  assert.equal(fallbackTitle([{ role: 'user', text: messageText, skillName: 'summarize-document' }]), '/summarize-document');
});

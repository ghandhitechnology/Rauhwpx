import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const threads = readFileSync(new URL('../src/agent/threads.ts', import.meta.url), 'utf8');

test('slash-selected product skills become composer tokens with separate request text', () => {
  assert.match(sidebar, /skillName:\s*skill\.name/);
  assert.match(sidebar, /if \(option\.skillName\)/);
  assert.match(sidebar, /setComposerSkill\(skill, ''\)/);
  assert.match(sidebar, /typedInvocation[\s\S]*setComposerSkill\(typedSkill, typedInvocation\[2\]\)/);
  assert.match(sidebar, /composerField\.append\(caret, composerSkill, input, sendHint, send\)/);
});

test('a skill token is a valid message without fallback prose', () => {
  assert.match(sidebar, /!text && !activeComposerSkill && !referenceLibrary\.hasDrafts\(\)/);
  assert.match(sidebar, /text = invocation\[2\]\?\.trim\(\) \?\? ''/);
  assert.doesNotMatch(sidebar, /이 스킬을 현재 문서에 적용해 주세요/);
  assert.match(sidebar, /recordUserMessage\(visibleText, messageAttachments, undefined, skillNameForMessage\)/);
});

test('skill invocation structure persists and renders independently from its sentence', () => {
  assert.match(threads, /skillName\?: string/);
  assert.match(sidebar, /bubble\.classList\.add\('ag-has-skill'\)/);
  assert.match(sidebar, /if \(message\.text\) bubble\.appendChild/);
  assert.match(css, /\.ag-msg-user\.ag-has-skill\s*\{[^}]*background:\s*transparent/s);
});

test('skill tokens follow provider colors and use the hand-drawn outline', () => {
  for (const provider of ['codex', 'pi', 'grok', 'cursor']) {
    assert.match(css, new RegExp(`\\.ag-skill-token\\[data-agent='${provider}'\\]`));
  }
  assert.match(css, /\.ag-skill-token::before\s*\{[^}]*filter:\s*var\(--ag-sketch-line\)/s);
  assert.match(css, /\.ag-skill-token\s*\{[^}]*border-radius:\s*[^;]*\/[^;]*;/s);
});

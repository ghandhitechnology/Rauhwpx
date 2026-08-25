import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const controller = readFileSync(new URL('../src/ui/agent-sidebar/user-question-controller.ts', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const types = readFileSync(new URL('../src/agent/types.ts', import.meta.url), 'utf8');

test('question interaction uses strict protocol v4 and a reconnect-idempotent answer frame', () => {
  assert.match(types, /AGENT_PROTOCOL_VERSION = 4/);
  assert.match(bridge, /answerUserQuestion\(interactionId: string, answers: Record<string, UserQuestionAnswer>\)/);
  assert.match(bridge, /type: 'user-question-answer'/);
  assert.match(bridge, /interactionId,\s*responseId,\s*answers/);
  assert.match(bridge, /flushPendingQuestionAnswer\(\)/);
  assert.match(bridge, /case 'user-question-answer-result'/);
  assert.match(bridge, /case 'user-question-resolved'/);
  assert.match(
    bridge,
    /const droppedQuestion = this\.pendingUserQuestion;[\s\S]*this\.pendingQuestionAnswer = null;[\s\S]*interactionId: droppedQuestion\.interactionId,[\s\S]*reason: 'hub-restarted'/,
  );
});

test('drawer is composer-attached and blocks ordinary chat without hiding Stop', () => {
  assert.match(sidebar, /chatPage\.append\(header, connBanner, messages, review, planSurface, questionController\.root, composer\)/);
  assert.match(sidebar, /if \(questionController\.hasPending\(\)\) \{[\s\S]*questionController\.handleComposerSubmit\(\)/);
  assert.match(controller, /const stop = element\('button', 'ag-question-stop', '중지'\)/);
  assert.match(controller, /stop\.addEventListener\('click', options\.stop\)/);
  assert.match(css, /\.ag-user-question \{/);
  assert.match(css, /--ag-question-surface: var\(--ag-input-bg\)/);
  assert.match(css, /\.ag-user-question \{[\s\S]*?border: 1px solid var\(--ag-question-border\);[\s\S]*?border-bottom: 0;[\s\S]*?background: var\(--ag-question-surface\)/);
  assert.match(css, /\.ag-user-question:not\(\[data-inactive='true'\]\) \+ \.ag-composer/);
  assert.match(css, /border-radius: 0 0 var\(--ag-r-panel\) var\(--ag-r-panel\)/);
});

test('cards support single, multiple, Other, navigation and atomic submission', () => {
  assert.match(controller, /question\.mode === 'single'/);
  assert.match(controller, /question\.mode === 'multiple'/);
  assert.match(controller, /setComposerOther\(question\.id, true\)/);
  assert.match(controller, /function allAnswered\(\)/);
  assert.match(controller, /submitAnswers\(interaction\.interactionId, answers\)/);
  assert.match(controller, /draft\.activeQuestionIndex/);
  assert.match(controller, /root\.append\(body, actions\)/);
  assert.match(controller, /'이전'/);
  assert.match(controller, /final \? '제출' : '다음'/);
});

test('keyboard and accessibility behavior is explicit', () => {
  assert.match(controller, /button\.setAttribute\('aria-pressed'/);
  assert.match(controller, /aria-expanded/);
  assert.match(controller, /aria-controls/);
  assert.match(controller, /aria-live', 'polite'/);
  assert.match(controller, /!visible \|\| collapsed/);
  assert.match(controller, /isEditable\(event\.target\)/);
  assert.match(controller, /digit < 1 \|\| digit > 9/);
  assert.match(sidebar, /e\.key === 'Enter' && !e\.shiftKey && !e\.isComposing && questionController\.usesComposerForOther\(\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('retry errors retain the draft and history is rendered as plain text', () => {
  assert.match(controller, /submitting = false;[\s\S]*errorMessage = result\.message/);
  assert.doesNotMatch(controller, /innerHTML/);
  assert.match(sidebar, /renderUserQuestionHistory/);
  assert.match(sidebar, /message\.outcome\.answers\[question\.id\]/);
  assert.match(sidebar, /serializeThreadMessagesForProviderHistory\(currentThread\.messages\)/);
});

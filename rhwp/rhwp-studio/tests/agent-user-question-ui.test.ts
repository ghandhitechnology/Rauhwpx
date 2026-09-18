import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const controller = readFileSync(new URL('../src/ui/agent-sidebar/user-question-controller.ts', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const types = readFileSync(new URL('../src/agent/types.ts', import.meta.url), 'utf8');

test('question interaction uses strict protocol v5 and a reconnect-idempotent answer frame', () => {
  assert.match(types, /AGENT_PROTOCOL_VERSION = 5/);
  assert.match(bridge, /answerUserQuestion\(interactionId: string, answers: Record<string, UserQuestionAnswer>\)/);
  assert.match(bridge, /type: 'user-question-answer'/);
  assert.match(bridge, /interactionId,\s*responseId,\s*answers/);
  assert.match(bridge, /flushPendingQuestionAnswer\(\)/);
  assert.match(bridge, /pendingQuestionCancellation/);
  assert.match(bridge, /flushPendingQuestionCancellation\(\)/);
  assert.match(bridge, /QUESTION_CANCELLATION_STORAGE_PREFIX/);
  assert.match(bridge, /this\.restorePendingQuestionCancellation\(\)/);
  assert.match(bridge, /this\.persistPendingQuestionCancellation\(\)/);
  assert.match(bridge, /case 'user-question-answer-result'/);
  assert.match(bridge, /case 'user-question-resolved'/);
  assert.match(
    bridge,
    /const droppedQuestion = this\.pendingUserQuestion;[\s\S]*this\.pendingQuestionAnswer = null;[\s\S]*interactionId: droppedQuestion\.interactionId,[\s\S]*reason: 'hub-restarted'/,
  );
  assert.match(
    bridge,
    /case 'chat-error': \{[\s\S]*const chatStartFailed = this\.pendingChatStart !== null;[\s\S]*if \(chatStartFailed\) \{[\s\S]*const droppedQuestion = this\.pendingUserQuestion;[\s\S]*reason: 'request-invalidated'/,
  );
  assert.match(
    bridge,
    /pendingQuestionCancellation\?\.interactionId === interaction\.interactionId[\s\S]*flushPendingQuestionCancellation\(\)[\s\S]*break;/,
  );
  assert.match(
    bridge,
    /pendingQuestionCancellation\?\.interactionId === interactionId[\s\S]*clearPendingQuestionCancellation\(\)/,
  );
});

test('pending question stays above the composer while its transcript position is reserved', () => {
  assert.match(sidebar, /chatPage\.append\(header, connBanner, messages, review, planSurface, questionController\.root, composer\)/);
  assert.match(sidebar, /const questionTimelineAnchor = el\('span', 'ag-question-timeline-anchor'\)/);
  assert.match(sidebar, /function mountQuestionTimelineAnchor\(\): void \{[\s\S]*appendConversation\(questionTimelineAnchor\)/);
  assert.doesNotMatch(sidebar, /appendConversation\(questionController\.root\)/);
  assert.match(sidebar, /case 'user-question-requested': \{[\s\S]*flushAssistantBuffer\(\{ kind: 'progress' \}\);[\s\S]*compactStreamIntoActivity\(e\.interaction\.agent\);[\s\S]*streamBubble = null;[\s\S]*questionController\.request\(e\.interaction, stored\);[\s\S]*mountQuestionTimelineAnchor\(\);/);
  assert.match(sidebar, /if \(questionController\.hasPending\(\)\) \{[\s\S]*questionController\.handleComposerSubmit\(\)/);
  assert.match(controller, /const stop = element\('button', 'ag-question-stop', '중지'\)/);
  assert.match(controller, /stop\.addEventListener\('click', options\.stop\)/);
  assert.match(css, /\.ag-user-question \{/);
  assert.match(css, /--ag-question-surface: var\(--ag-input-bg\)/);
  assert.match(css, /--ag-question-border/);
  assert.match(css, /\.ag-user-question:not\(\[data-inactive='true'\]\) \+ \.ag-composer/);
  assert.match(css, /\.ag-user-question\s*\{[^}]*margin:\s*0 12px;[^}]*border-bottom:\s*0;[^}]*border-radius:\s*12px 12px 0 0;/s);
});

test('question resolution replaces its chronological anchor with immutable history', () => {
  assert.match(sidebar, /const historyCard = renderUserQuestionHistory\(historyMessage\)/);
  assert.match(sidebar, /questionTimelineAnchorInteractionId === interaction\.interactionId[\s\S]*questionTimelineAnchor\.parentElement === messages[\s\S]*questionTimelineAnchor\.replaceWith\(historyCard\)/);
  assert.match(sidebar, /else appendConversation\(historyCard\)/);
});

test('question history separates its label and outcome across the card header', () => {
  assert.match(sidebar, /title\.append\([\s\S]*'ag-question-history-label', '에이전트 질문'[\s\S]*'ag-question-history-status', status[\s\S]*\)/);
  assert.doesNotMatch(sidebar, /`에이전트 질문 · \$\{status\}`/);
  assert.match(sidebar, /\? '답변 완료'[\s\S]*\? '중단됨'[\s\S]*: '만료됨'/);
  assert.match(css, /\.ag-question-history-title\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*align-items:\s*center;/s);
  assert.match(css, /\.ag-question-history-status\s*\{[^}]*text-align:\s*right;[^}]*white-space:\s*nowrap;/s);
});

test('question drawer starts with the question instead of a redundant metadata header', () => {
  assert.match(controller, /const prompt = element\('h3', 'ag-question-prompt', question\.question\)/);
  assert.doesNotMatch(controller, /ag-question-disclosure|ag-question-mode|ag-question-count/);
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
  assert.match(controller, /aria-live', 'polite'/);
  assert.match(controller, /!visible \|\| submitting/);
  assert.match(controller, /isEditable\(event\.target\)/);
  assert.match(controller, /digit < 1 \|\| digit > 9/);
  assert.match(sidebar, /e\.key === 'Enter' && !e\.shiftKey && !e\.isComposing && questionController\.usesComposerForOther\(\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('retry errors retain the draft and history is rendered as plain text', () => {
  assert.match(controller, /errorMessage = result\.message/);
  assert.doesNotMatch(controller, /innerHTML/);
  assert.match(sidebar, /renderUserQuestionHistory/);
  assert.match(sidebar, /message\.outcome\.answers\[question\.id\]/);
  assert.match(sidebar, /serializeThreadMessagesForProviderHistory\(currentThread\.messages\)/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/ui/agent-sidebar/index.ts', import.meta.url),
  'utf8',
);
const css = readFileSync(
  new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url),
  'utf8',
);
const chatMarkdown = readFileSync(
  new URL('../src/ui/agent-sidebar/chat-markdown.ts', import.meta.url),
  'utf8',
);

test('assistant responses render as flat Markdown transcripts', () => {
  assert.match(source, /renderChatMarkdown\(bubble, text\)/);
  assert.match(source, /scheduleAssistantRender\(bubble, assistantBuffer\)/);
  assert.match(source, /window\.requestAnimationFrame/);
  assert.match(chatMarkdown, /katexModule\.render/);
  assert.match(chatMarkdown, /import\('katex'\)/);
  assert.match(chatMarkdown, /trust:\s*false/);
  assert.match(chatMarkdown, /normalizeKoreanLatex/);
});

test('meaningful progress stays visible as a milestone timeline with nested tool calls', () => {
  assert.match(source, /compactStreamIntoActivity/);
  assert.match(source, /ensureTurnActivity/);
  assert.match(source, /completeTurnActivity/);
  assert.match(source, /animateActivityLabel/);
  assert.match(source, /flushAssistantBuffer\(\{ kind: 'progress' \}\)/);
  assert.match(source, /ag-progress-step ag-progress-step-restored/);
  assert.match(source, /milestone\.appendChild\(activity\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('conversation follows streamed output until the user scrolls away', () => {
  assert.match(source, /followConversation/);
  assert.match(source, /new MutationObserver/);
  assert.match(source, /scrollConversationToMessage/);
  assert.match(source, /scrollConversationToEnd/);
  assert.match(source, /return content\.classList\.contains\('ag-msg-user'\) \? content : messagesEnd/);
  assert.doesNotMatch(source, /return questionController\.root/);
  assert.match(source, /function conversationScrollTarget\(node: HTMLElement\)/);
  assert.match(source, /conversationAnchorTop\(node\) - conversationFocusOffset\(\)/);
  assert.match(source, /Math\.min\(target, Math\.max\(0, messages\.scrollHeight - messages\.clientHeight\)\)/);
  assert.match(source, /followConversation = isConversationFollowingTurn\(\)/);
  assert.match(source, /appendConversation\(userBubble\)/);
  assert.match(source, /scrollConversationToMessage\(userBubble, \{ smooth: true \}\)/);
  assert.match(source, /opts\?\.smooth !== false/);
  assert.match(source, /conversationScrollTargetNode = node/);
  assert.match(source, /if \(conversationScrollRaf === null\) conversationScrollRaf = window\.requestAnimationFrame\(animateConversationScroll\)/);
  assert.match(source, /function animateConversationScroll\(now: number\): void/);
  assert.match(source, /conversationScrollTarget\(node\)/);
  assert.doesNotMatch(source, /messages\.scrollTo\(\{ top: target, behavior: smooth \? 'smooth' : 'auto' \}\)/);
  assert.doesNotMatch(css, /\.ag-messages\s*\{[^}]*scroll-behavior:\s*smooth;/s);
  assert.match(source, /function stopFollowingConversation\(\): void[\s\S]*followConversation = false/);
  assert.match(source, /ag-messages-end/);
  assert.doesNotMatch(source, /messages\.scrollTop = messages\.scrollHeight/);
});

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
const backend = readFileSync(
  new URL('../../rhwp-agent/agents/backend.mjs', import.meta.url),
  'utf8',
);

test('assistant responses render as flat Markdown transcripts', () => {
  assert.match(
    css,
    /\.ag-msg-assistant\s*\{[^}]*padding:\s*0 2px;[^}]*line-height:\s*1\.7;/s,
  );
  assert.doesNotMatch(
    css,
    /\.ag-msg-assistant\s*\{[^}]*background:/s,
  );
  assert.doesNotMatch(
    css,
    /\.ag-msg-assistant\s*\{[^}]*border:/s,
  );
  assert.match(source, /renderChatMarkdown\(bubble, text\)/);
  assert.match(source, /scheduleAssistantRender\(bubble, assistantBuffer\)/);
  assert.match(source, /window\.requestAnimationFrame/);
  assert.match(chatMarkdown, /katexModule\.render/);
  assert.match(chatMarkdown, /import\('katex'\)/);
  assert.match(chatMarkdown, /trust:\s*false/);
  assert.match(chatMarkdown, /normalizeKoreanLatex/);
});

test('chat Markdown uses a flat typographic reading surface', () => {
  assert.match(css, /\.ag-md-code\s*\{[^}]*border-radius:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(css, /\.ag-md-pre\s*\{[^}]*border:\s*0;[^}]*border-left:\s*2px solid/s);
  assert.match(css, /\.ag-md-table-wrap\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
  assert.match(css, /\.ag-msg-assistant \.ag-md-h\s*\{[^}]*border:\s*0;/s);
  assert.doesNotMatch(css, /\.ag-send,\s*\.ag-approve,/s);
});

test('meaningful progress stays visible as a milestone timeline with nested tool calls', () => {
  assert.match(source, /compactStreamIntoActivity/);
  assert.match(source, /ensureTurnActivity/);
  assert.match(source, /completeTurnActivity/);
  assert.match(source, /animateActivityLabel/);
  assert.match(source, /flushAssistantBuffer\(\{ kind: 'progress' \}\)/);
  assert.match(source, /ag-progress-step ag-progress-step-restored/);
  assert.match(source, /milestone\.appendChild\(activity\)/);
  assert.match(css, /\.ag-progress-step\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(css, /\.ag-progress-milestone\s*\{[^}]*line-height:\s*1\.6;/s);
  assert.match(css, /\.ag-activity-collapse\s*\{[^}]*grid-template-rows:\s*1fr;/s);
  assert.match(
    css,
    /\.ag-activity-collapsed \.ag-activity-collapse\s*\{[^}]*grid-template-rows:\s*0fr;/s,
  );
  assert.match(css, /@keyframes ag-message-arrive/);
  assert.match(css, /@keyframes ag-activity-arrive/);
  assert.doesNotMatch(css, /@keyframes ag-activity-scan/);
  assert.match(css, /@keyframes ag-step-arrive/);
  assert.match(css, /@keyframes ag-status-settle/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('conversation follows streamed output until the user scrolls away', () => {
  assert.match(source, /followConversation/);
  assert.match(source, /new MutationObserver/);
  assert.match(source, /scrollConversationToMessage/);
  assert.match(source, /scrollConversationToEnd/);
  assert.match(source, /followConversation = isConversationFollowingTurn\(\)/);
  assert.match(source, /appendConversation\(userBubble\)/);
  assert.match(source, /scrollConversationToMessage\(userBubble, \{ smooth: true \}\)/);
  assert.match(source, /opts\?\.smooth !== false/);
  assert.match(source, /behavior: smooth \? 'smooth' : 'auto'/);
  assert.match(css, /\.ag-messages\s*\{[^}]*scroll-behavior:\s*smooth;/s);
  assert.match(source, /ag-messages-end/);
  assert.doesNotMatch(source, /messages\.scrollTop = messages\.scrollHeight/);
});

test('active editing and a minimized plan share a compact composer overlay', () => {
  assert.match(source, /const composerOverlay = el\('div', 'ag-composer-overlay'\)/);
  assert.match(source, /const turnPending = el\('div', 'ag-turn-pending'\)/);
  assert.match(source, /createHieumGlyph/);
  assert.match(source, /composerOverlay\.append\(planRestore\)/);
  assert.match(source, /composer\.append\(composerOverlay, slashMenu, templateChip, composerField, composerMeta, configPanel\)/);
  assert.match(source, /const activeEdit = changeSets\.find\(\(set\) => set\.status === 'open'\)/);
  assert.match(source, /updateTurnPending/);
  assert.match(source, /`\$\{AGENT_LABEL\[who\]\} 편집 중…`/);
  assert.match(css, /@keyframes ag-hieum-top/);
  assert.match(css, /@keyframes ag-hieum-mid/);
  assert.match(css, /@keyframes ag-hieum-ring/);
  assert.match(source, /const reviewSets = changeSets\.filter\(\(set\) => set\.status !== 'open'\)/);
  assert.doesNotMatch(source, /ag-review-open/);
});

test('tool calls stay collapsed while the header names active tools', () => {
  assert.match(source, /scrollActivityToLatest/);
  assert.match(source, /content\.scrollTo\(\{/);
  assert.match(source, /top: content\.scrollHeight/);
  assert.match(source, /ag-activity-running ag-activity-collapsed/);
  assert.match(source, /toggle\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(source, /`도구 호출 · \$\{active\[0\]\} 실행 중`/);
  assert.match(source, /도구 호출 내역/);
  assert.match(
    css,
    /\.ag-activity-content\s*\{[^}]*max-height:\s*clamp\([^;]+;[^}]*overflow-y:\s*auto;/s,
  );
  assert.match(css, /\.ag-tool-row\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(css, /\.ag-activity-collapsed \.ag-activity-content\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.ag-activity-toggle\s*\{[^}]*align-items:\s*center;/s);
  assert.match(css, /\.ag-activity-toggle\s*\{[^}]*justify-content:\s*flex-start;/s);
  assert.match(css, /\.ag-activity-toggle\s*\{[^}]*text-align:\s*left;/s);
  assert.match(css, /\.ag-activity-toggle\s*\{[^}]*line-height:\s*1;/s);
  assert.match(css, /\.ag-activity-label\s*\{[^}]*flex:\s*0 1 auto;[^}]*line-height:\s*1;/s);
  assert.match(css, /\.ag-activity-chevron\s*\{[^}]*position:\s*absolute;[^}]*right:\s*10px;/s);
  assert.match(
    css,
    /\.ag-activity-collapsed \.ag-activity-content\s*\{[^}]*padding-top:\s*0;[^}]*padding-bottom:\s*0;[^}]*border-top-color:\s*transparent;/s,
  );
});

test('long tasks request meaningful updates without artificial heartbeats', () => {
  assert.match(backend, /roughly every 30 seconds when there is concrete new progress/);
  assert.match(backend, /Do not send heartbeat or filler updates/);
  assert.match(backend, /nests related tool calls beneath them/);
});

test('editing tool turns hand off document checks unless a plan card is presented', () => {
  assert.match(source, /appendCheckDocumentMessage/);
  assert.match(source, /작업을 마쳤습니다\. 문서를 확인해 보세요\./);
  assert.match(source, /const editingPhase = chatWorkflow === 'direct' \|\| planningPhase === 'implementing'/);
  assert.match(source, /turnToolCount > 0 && !turnPresentedPlan && !finalBubble && completed && editingPhase/);
  assert.match(backend, /After every tool-using turn, always send a separate final/);
  assert.match(backend, /asks the user to check the document/);
});

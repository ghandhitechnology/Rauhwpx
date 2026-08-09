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
const backend = readFileSync(
  new URL('../../rhwp-agent/agents/backend.mjs', import.meta.url),
  'utf8',
);

test('assistant responses render as flat transcript text', () => {
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
});

test('progress prose and tool calls compact into one calm activity disclosure', () => {
  assert.match(source, /compactStreamIntoActivity/);
  assert.match(source, /ensureTurnActivity/);
  assert.match(source, /completeTurnActivity/);
  assert.match(source, /animateActivityLabel/);
  assert.match(source, /flushAssistantBuffer\(\{ persist: false \}\)/);
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
  assert.match(source, /scrollConversationToEnd/);
  assert.match(source, /messages\.scrollTop = messages\.scrollHeight/);
  assert.match(source, /followConversation = isConversationNearBottom\(\)/);
});

test('running tool activity is a bounded self-scrolling stream', () => {
  assert.match(source, /scrollActivityToLatest/);
  assert.match(source, /content\.scrollTop = content\.scrollHeight/);
  assert.match(source, /실시간 도구 실행 내역/);
  assert.match(
    css,
    /\.ag-activity-content\s*\{[^}]*max-height:\s*clamp\([^;]+;[^}]*overflow-y:\s*auto;/s,
  );
  assert.match(css, /\.ag-tool-row\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(css, /\.ag-activity-collapsed \.ag-activity-content\s*\{[^}]*overflow:\s*hidden;/s);
});

test('tool turns always produce a final document-check handoff', () => {
  assert.match(source, /appendCheckDocumentMessage/);
  assert.match(source, /작업을 마쳤습니다\. 문서를 확인해 보세요\./);
  assert.match(backend, /After every tool-using turn, always send a separate final/);
  assert.match(backend, /asks the user to check the document or pending changes/);
});

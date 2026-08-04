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
    /\.ag-msg-assistant\s*\{[^}]*padding:\s*2px 0;[^}]*line-height:\s*1\.65;/s,
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

test('progress prose and tool calls compact into one smooth activity disclosure', () => {
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
  assert.match(css, /@keyframes ag-activity-arrive/);
  assert.match(css, /@keyframes ag-activity-scan/);
  assert.match(css, /@keyframes ag-step-arrive/);
  assert.match(css, /@keyframes ag-status-settle/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('tool turns always produce a final document-check handoff', () => {
  assert.match(source, /appendCheckDocumentMessage/);
  assert.match(source, /작업을 마쳤습니다\. 문서를 확인해 보세요\./);
  assert.match(backend, /After every tool-using turn, always send a separate final/);
  assert.match(backend, /asks the user to check the document or pending changes/);
});

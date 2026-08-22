import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const mcp = readFileSync(new URL('../mcp-stdio.mjs', import.meta.url), 'utf8');

test('hub launches the copy-layout worker as a real isolated provider session', () => {
  assert.match(server, /const createBackend = SESSION_FACTORIES\[job\.agent\]/);
  assert.match(server, /job\.backend = createBackend\(opts\)/);
  assert.match(server, /toolProfile: 'copy-layout-worker'/);
  assert.match(server, /agentRole: job\.workerRole/);
  assert.match(server, /permissionProfile: 'safe'/);
  // 헬퍼 실행은 모든 워커에 필요하다 — grok 만 잡 헬퍼 경로로 고정한 접두사를 소비한다.
  assert.match(server, /shellAllowPrefixes: copyLayoutShellAllowPrefixes\(helperPath\)/);
  assert.doesNotMatch(server, /shellAllowPrefixes: \['python3', 'python'\]/);
  assert.match(server, /copy-layout-providers/);
  assert.match(server, /prepareCodexHome\(codexHome/);
  assert.match(server, /prepareClaudeHome\(isolatedHome/);
  assert.match(server, /prepareGrokHome\(grokHome/);
  assert.match(server, /prepareCursorHome\(cursorHome/);
  assert.match(mcp, /url\.searchParams\.set\('role', AGENT_ROLE\)/);
  assert.match(server, /ws\.agentRole = url\.searchParams\.get\('role'\)/);
});

test('hub reuses fleet task events and keeps worker tools source-bound', () => {
  assert.match(server, /type: 'task-start'[\s\S]*taskKind: 'agent', background: true/);
  assert.doesNotMatch(server, /전용 백그라운드 워커/);
  assert.match(server, /taskProgressForJob\(job/);
  assert.match(server, /type: 'task-end'/);
  assert.match(server, /COPY_LAYOUT_TOOL_DENIED/);
  assert.match(server, /args\.sourceDocumentId !== workerJob\.binding\.documentId/);
  assert.match(server, /args\.sourceDigest !== workerJob\.binding\.digest/);
  assert.match(server, /documentIdentity: workerJob[\s\S]*workerJob\.binding\.documentId/);
});

test('template artifacts are card-triggered instead of auto-opened', () => {
  assert.match(server, /downloadUrl\.searchParams\.set\('templatePreview', '1'\)/);
  assert.doesNotMatch(server, /template-preview-ready/);
  assert.doesNotMatch(server, /template-preview-opened/);
  assert.doesNotMatch(server, /sendTemplatePreviewReady/);
});

test('completion wakes the owning chat without collaboration wait polling', () => {
  assert.match(server, /completionDelivery: 'automatic-owning-chat-turn'/);
  assert.match(server, /waitForCompletion: false/);
  assert.match(server, /wait_agent로 기다리거나 폴링하지 말고 현재 턴을 끝내세요/);
  assert.match(server, /record\.pendingTemplateCompletions\.push/);
  assert.match(server, /activeSession\.backend\.sendUserMessage\(buildCopyLayoutCompletionPrompt\(entry\.result\)\)/);
  assert.match(server, /if \(evt\.type === 'turn-end'\) drainTemplateCompletion\(record\)/);
});

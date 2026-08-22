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
  assert.match(server, /taskProgressForJob\(job/);
  assert.match(server, /type: 'task-end'/);
  assert.match(server, /COPY_LAYOUT_TOOL_DENIED/);
  assert.match(server, /args\.sourceDocumentId !== workerJob\.binding\.documentId/);
  assert.match(server, /args\.sourceDigest !== workerJob\.binding\.digest/);
  assert.match(server, /documentIdentity: workerJob[\s\S]*workerJob\.binding\.documentId/);
});

test('preview delivery is replayed until Studio confirms the read-only window opened', () => {
  assert.match(server, /function sendTemplatePreviewReady/);
  assert.match(server, /readOnly: true/);
  assert.match(server, /previewAcknowledged/);
  assert.match(server, /case 'template-preview-opened'/);
  assert.match(server, /sendTemplatePreviewReady\(record, job\)/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('reference-bearing messages route through the staged-attachment gate only', () => {
  // referencesPending / chat-reference-uploads-complete 경로는 폐기됨 —
  // 부활하면 발신자 없는 대기 상태로 세션이 잠길 수 있다.
  assert.doesNotMatch(server, /referencesPending/);
  assert.doesNotMatch(server, /chat-reference-uploads-complete/);
  assert.match(
    server,
    /function dispatchUserMessage[\s\S]*addReferenceContext\(activeSession, msg\.text, prompt, messageAttachments\)/,
  );
});

test('pre-uploaded message attachments promote before agent dispatch and report status', () => {
  assert.match(server, /async function dispatchStagedUserMessage/);
  assert.match(server, /referenceStore\.promoteStaged\(\{ stageId, scopeId: activeSession\.threadId \}\)/);
  assert.match(server, /type: 'chat-reference-status'/);
  assert.match(server, /dispatchUserMessage\(record, sock, msg, activeSession, readyFiles\)/);
  assert.match(server, /<message_attachments trust="untrusted-data">/);
});

test('staged messages cannot leak across stopped or disconnected studio sessions', () => {
  assert.match(server, /function disposeSession\(record\) \{\s*record\.pendingReferenceMessage = null/);
  assert.match(server, /record\.studioSocket = null;\s*record\.pendingReferenceMessage = null;/);
});

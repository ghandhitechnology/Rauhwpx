import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('reference-bearing messages wait for post-send uploads before agent dispatch', () => {
  assert.match(server, /if \(msg\.referencesPending === true\)/);
  assert.match(server, /pendingReferenceMessage = \{ messageId: msg\.messageId, message: msg, owner: session \}/);
  assert.match(server, /case 'chat-reference-uploads-complete'/);
  assert.match(
    server,
    /pendingReferenceMessage = null;\s*dispatchUserMessage\(sock, pending\.message, pending\.owner\)/,
  );
  assert.match(
    server,
    /function dispatchUserMessage[\s\S]*addReferenceContext\(activeSession, msg\.text, prompt, messageAttachments\)/,
  );
});

test('pre-uploaded message attachments promote before agent dispatch and report status', () => {
  assert.match(server, /async function dispatchStagedUserMessage/);
  assert.match(server, /referenceStore\.promoteStaged\(\{ stageId, scopeId: activeSession\.threadId \}\)/);
  assert.match(server, /type: 'chat-reference-status'/);
  assert.match(server, /dispatchUserMessage\(sock, msg, activeSession, readyFiles\)/);
  assert.match(server, /<message_attachments trust="untrusted-data">/);
});

test('staged messages cannot leak across stopped or disconnected studio sessions', () => {
  assert.match(server, /function disposeSession\(\) \{\s*pendingReferenceMessage = null/);
  assert.match(server, /studioSocket = null;\s*pendingReferenceMessage = null;/);
});

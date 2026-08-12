import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertMessageScope,
  referenceScopesForSession,
  resolveSessionIdentity,
} from '../reference-session.mjs';

test('stable thread/document identities are preserved and legacy starts get an id', () => {
  const legacy = resolveSessionIdentity({ createThreadId: () => 'generated-chat' });
  assert.deepEqual(legacy, { threadId: 'generated-chat', documentId: null, documentName: null });
  const explicit = resolveSessionIdentity({
    threadId: ' thread-1 ', documentId: 'doc-1', documentName: '보고서.hwp',
  });
  assert.deepEqual(explicit, { threadId: 'thread-1', documentId: 'doc-1', documentName: '보고서.hwp' });
  const retained = resolveSessionIdentity({ existing: explicit, createThreadId: () => 'unused' });
  assert.deepEqual(retained, explicit);
});

test('chat-user-message scope validation rejects stale chat and document ids but allows legacy omission', () => {
  const active = { threadId: 'chat-a', documentId: 'doc-a' };
  assert.equal(assertMessageScope(active, { text: 'legacy client' }), true);
  assert.equal(assertMessageScope(active, { threadId: 'chat-a', documentId: 'doc-a' }), true);
  assert.throws(
    () => assertMessageScope(active, { threadId: 'chat-b', documentId: 'doc-a' }),
    (error) => error.code === 'STALE_CHAT_SCOPE',
  );
  assert.throws(
    () => assertMessageScope(active, { threadId: 'chat-a', documentId: 'doc-b' }),
    (error) => error.code === 'STALE_DOCUMENT_SCOPE',
  );
  assert.throws(
    () => assertMessageScope(active, { threadId: 'chat-a', documentId: null }),
    (error) => error.code === 'STALE_DOCUMENT_SCOPE',
  );
});

test('MCP reference scope is exactly global + active document + active chat', () => {
  assert.deepEqual(referenceScopesForSession({ threadId: 'chat-a', documentId: 'doc-a' }), [
    { scope: 'global', scopeId: 'global' },
    { scope: 'document', scopeId: 'doc-a' },
    { scope: 'chat', scopeId: 'chat-a' },
  ]);
});

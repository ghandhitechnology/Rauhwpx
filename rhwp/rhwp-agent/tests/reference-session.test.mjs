import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeDocumentIdentity,
  addActiveDocumentContext,
  assertMessageScope,
  attachActiveDocumentIdentity,
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

test('agents receive exact active-document identity without filename matching', () => {
  const first = { documentId: 'doc-a', documentName: '보고서.hwp' };
  const sameNamedSecond = { documentId: 'doc-b', documentName: '보고서.hwp' };

  assert.deepEqual(activeDocumentIdentity(first), first);
  assert.notEqual(
    addActiveDocumentContext(first, 'copy it'),
    addActiveDocumentContext(sameNamedSecond, 'copy it'),
  );
  const prompt = addActiveDocumentContext(first, 'copy it');
  assert.match(prompt, /"documentId":"doc-a"/);
  assert.match(prompt, /documentId—not documentName/);
  assert.match(prompt, /filesystem search/);
  assert.match(prompt, /exact sourcePath/);
  assert.match(prompt, /copy it$/);
});

test('get_document_info identity is hub-authored and cannot be replaced by Studio data', () => {
  assert.deepEqual(
    attachActiveDocumentIdentity(
      { pageCount: 3, documentId: 'stale', documentName: 'wrong.hwp' },
      { documentId: 'doc-live', documentName: '보고서.hwp' },
    ),
    { pageCount: 3, documentId: 'doc-live', documentName: '보고서.hwp' },
  );
  assert.deepEqual(activeDocumentIdentity(null), { documentId: null, documentName: null });
});

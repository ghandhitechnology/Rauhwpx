import assert from 'node:assert/strict';
import test from 'node:test';

import { createCloudEditorScope } from '../src/cloud/editor-scope.ts';

test('mounted Cloud transcripts never become editor lease authority', () => {
  const editor = createCloudEditorScope({ threadId: 'local-thread-a', documentId: 'document-a' });
  const selectedCloud = { threadId: 'cloud-thread-b', documentId: 'document-b' };

  assert.deepEqual(selectedCloud, { threadId: 'cloud-thread-b', documentId: 'document-b' });
  assert.deepEqual(editor.current(), { threadId: 'local-thread-a', documentId: 'document-a' });
  assert.equal(editor.bind({ threadId: 'local-thread-a', documentId: 'document-a' }), false);
  assert.deepEqual(editor.current(), { threadId: 'local-thread-a', documentId: 'document-a' });
});

test('successful primary replacement moves editor scope exactly once', () => {
  const editor = createCloudEditorScope({ threadId: 'local-thread-a', documentId: 'document-a' });
  let changes = 0;
  const bind = (threadId: string, documentId: string) => {
    if (editor.bind({ threadId, documentId })) changes += 1;
  };

  bind('replacement-thread', 'replacement-document');
  bind('replacement-thread', 'replacement-document');
  assert.equal(changes, 1);
  assert.deepEqual(editor.current(), {
    threadId: 'replacement-thread',
    documentId: 'replacement-document',
  });
});

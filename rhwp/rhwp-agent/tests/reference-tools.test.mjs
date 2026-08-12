import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ReferenceStore } from '../reference-store.mjs';
import { executeReferenceTool } from '../reference-tools.mjs';

test('hub-local MCP list/search/read tools enforce active session scopes', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-reference-tools-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const store = await new ReferenceStore({ root: path.join(parent, 'refs') }).init();
  const visible = await store.addBuffer({
    scope: 'document', scopeId: 'doc-a', name: 'visible.txt', bytes: Buffer.from('문서별 참조에 출시 일정이 있습니다.'),
  });
  const hidden = await store.addBuffer({
    scope: 'chat', scopeId: 'chat-b', name: 'hidden.txt', bytes: Buffer.from('다른 채팅 비밀'),
  });
  const session = { threadId: 'chat-a', documentId: 'doc-a' };

  const listed = await executeReferenceTool({ tool: 'list_reference_files', args: {}, store, session });
  assert.equal(listed.handled, true);
  assert.deepEqual(listed.result.files.map((file) => file.id), [visible.id]);

  const searched = await executeReferenceTool({
    tool: 'search_reference_files', args: { query: '출시 일정', maxResults: 2 }, store, session,
  });
  assert.equal(searched.result.results[0].fileId, visible.id);
  assert.ok(!searched.result.results.some((result) => result.fileId === hidden.id));

  const read = await executeReferenceTool({
    tool: 'read_reference_chunk', args: { fileId: visible.id, chunkId: 'c0' }, store, session,
  });
  assert.match(read.result.text, /출시 일정/);
  await assert.rejects(
    executeReferenceTool({ tool: 'read_reference_chunk', args: { fileId: hidden.id, chunkId: 'c0' }, store, session }),
    (error) => error.code === 'REFERENCE_NOT_FOUND',
  );
  assert.deepEqual(await executeReferenceTool({ tool: 'not_reference', args: {}, store, session }), { handled: false, result: null });
});

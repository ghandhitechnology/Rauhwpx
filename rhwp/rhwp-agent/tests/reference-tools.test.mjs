import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ReferenceStore } from '../reference-store.mjs';
import {
  executeReferenceTool,
  referenceImageNeedsStudio,
  referenceImageSize,
  resolveReferenceImageArgs,
} from '../reference-tools.mjs';

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

test('hub-local image reads return native vision payloads', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-reference-image-tool-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const store = await new ReferenceStore({ root: path.join(parent, 'refs') }).init();
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const image = await store.addBuffer({ scope: 'chat', scopeId: 'chat-a', name: 'shot.png', mimeType: 'image/png', bytes });
  const result = await executeReferenceTool({
    tool: 'read_reference_image', args: { fileId: image.id }, store, session: { threadId: 'chat-a', documentId: null },
  });
  assert.equal(result.handled, true);
  assert.equal(result.result.image.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(result.result.image.data, 'base64'), bytes);
});

test('reference image crops and inserts resolve stored bytes for Studio without touching disk paths', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-reference-image-resolve-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const store = await new ReferenceStore({ root: path.join(parent, 'refs') }).init();
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const image = await store.addBuffer({ scope: 'document', scopeId: 'doc-a', name: 'logo.png', mimeType: 'image/png', bytes });
  const hidden = await store.addBuffer({ scope: 'chat', scopeId: 'chat-b', name: 'other.png', mimeType: 'image/png', bytes });
  const session = { threadId: 'chat-a', documentId: 'doc-a' };

  assert.equal(referenceImageNeedsStudio('read_reference_image', { fileId: image.id }), false);
  assert.equal(referenceImageNeedsStudio('read_reference_image', { fileId: image.id, zoom: 2 }), true);
  assert.equal(referenceImageNeedsStudio('insert_image', { referenceFileId: image.id }), true);
  assert.equal(referenceImageNeedsStudio('insert_image', { imageBase64: 'AAAA' }), false);

  const plain = await executeReferenceTool({ tool: 'read_reference_image', args: { fileId: image.id }, store, session });
  assert.deepEqual([plain.result.widthPx, plain.result.heightPx], [1, 1]);

  const insert = await resolveReferenceImageArgs({
    tool: 'insert_image',
    args: { expectedRevision: 3, sectionIdx: 0, paraIdx: 1, charOffset: 0, referenceFileId: image.id, cropPx: { x: 0, y: 0, width: 1, height: 1 } },
    store,
    session,
  });
  assert.deepEqual(insert, {
    expectedRevision: 3, sectionIdx: 0, paraIdx: 1, charOffset: 0,
    cropPx: { x: 0, y: 0, width: 1, height: 1 }, referenceFileId: image.id,
    imageBase64: bytes.toString('base64'), mimeType: 'image/png',
    extension: 'png', naturalWidthPx: 1, naturalHeightPx: 1,
  });

  const read = await resolveReferenceImageArgs({
    tool: 'read_reference_image', args: { fileId: image.id, cropPx: { x: 0, y: 0, width: 1, height: 1 }, zoom: 3 }, store, session,
  });
  assert.equal(read.name, 'logo.png');
  assert.equal(read.zoom, 3);
  assert.equal(read.imageBase64, bytes.toString('base64'));

  await assert.rejects(
    resolveReferenceImageArgs({ tool: 'insert_image', args: { referenceFileId: hidden.id }, store, session }),
    (error) => error.code === 'REFERENCE_NOT_FOUND',
  );
  await assert.rejects(
    resolveReferenceImageArgs({ tool: 'insert_image', args: { referenceFileId: image.id, imagePath: '/tmp/x.png' }, store, session }),
    (error) => error.code === 'INVALID_ARGS',
  );
});

test('referenceImageSize reads WebP headers that the insertion parser rejects', () => {
  const vp8x = Buffer.alloc(30);
  vp8x.write('RIFF', 0, 'ascii');
  vp8x.write('WEBP', 8, 'ascii');
  vp8x.write('VP8X', 12, 'ascii');
  vp8x.writeUIntLE(639, 24, 3);
  vp8x.writeUIntLE(479, 27, 3);
  assert.deepEqual(referenceImageSize(vp8x), { width: 640, height: 480 });
  assert.equal(referenceImageSize(Buffer.from('not an image at all, clearly')), null);
});

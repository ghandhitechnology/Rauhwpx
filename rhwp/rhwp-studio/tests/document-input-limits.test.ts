import test from 'node:test';
import assert from 'node:assert/strict';
import { EXACT_LOCAL_DOCUMENT_MAX_BYTES, INSERTED_IMAGE_MAX_BYTES, PORTABLE_HISTORY_MAX_BYTES, cancelResponseBody, readBlobBytesWithLimit, readResponseBytesWithLimit } from '../src/core/document-input-limits.ts';
import { readFileFromHandle, type FileSystemFileHandleLike } from '../src/command/file-system-access.ts';

test('early HTTP rejection cancels an unread renderer response body', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  }), { status: 503 });

  await cancelResponseBody(response, 'rejected-before-read');
  assert.equal(cancelled, true);
});

test('blob limits reject from metadata before allocating its buffer', async () => {
  let allocated = false;
  const oversized = {
    name: 'oversized.hwp',
    size: EXACT_LOCAL_DOCUMENT_MAX_BYTES + 1,
    async arrayBuffer() {
      allocated = true;
      return new ArrayBuffer(0);
    },
  } as unknown as File;
  const handle = {
    kind: 'file',
    name: 'oversized.hwp',
    async getFile() { return oversized; },
    async createWritable() { throw new Error('not used'); },
  } satisfies FileSystemFileHandleLike;

  await assert.rejects(() => readFileFromHandle(handle), /512 MiB/);
  assert.equal(allocated, false);
  await assert.rejects(() => readBlobBytesWithLimit(new Blob([new Uint8Array(3)]), 2), /0 MiB/);
});

test('portable-history handles reject over 128 MiB before allocating archive bytes', async () => {
  let allocated = false;
  const oversized = {
    name: 'history.rhwpx',
    size: PORTABLE_HISTORY_MAX_BYTES + 1,
    async arrayBuffer() {
      allocated = true;
      return new ArrayBuffer(0);
    },
  } as unknown as File;
  const handle = {
    kind: 'file',
    name: 'history.rhwpx',
    async getFile() { return oversized; },
    async createWritable() { throw new Error('not used'); },
  } satisfies FileSystemFileHandleLike;

  await assert.rejects(() => readFileFromHandle(handle), /128 MiB/);
  assert.equal(allocated, false);
});

test('image blob limits reject from metadata before allocating 64 MiB inputs', async () => {
  let allocated = false;
  const oversized = {
    size: INSERTED_IMAGE_MAX_BYTES + 1,
    async arrayBuffer() {
      allocated = true;
      return new ArrayBuffer(0);
    },
  } as unknown as Blob;

  await assert.rejects(
    () => readBlobBytesWithLimit(oversized, INSERTED_IMAGE_MAX_BYTES, '그림'),
    /64 MiB/,
  );
  assert.equal(allocated, false);
});

test('response limits reject both oversized declarations and streamed bodies', async () => {
  let declarationCanceled = false;
  const declaredBody = new ReadableStream<Uint8Array>({
    cancel() { declarationCanceled = true; },
  });
  await assert.rejects(
    () => readResponseBytesWithLimit(new Response(declaredBody, {
      headers: { 'content-length': '5' },
    }), 4),
    /0 MiB/,
  );
  assert.equal(declarationCanceled, true);
  await assert.rejects(
    () => readResponseBytesWithLimit(new Response(new Uint8Array([1, 2, 3, 4, 5])), 4),
    /0 MiB/,
  );
  assert.deepEqual(
    await readResponseBytesWithLimit(new Response(new Uint8Array([1, 2, 3])), 3),
    new Uint8Array([1, 2, 3]),
  );
});

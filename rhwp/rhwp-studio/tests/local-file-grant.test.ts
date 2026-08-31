import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileFromHandle, type FileSystemFileHandleLike } from '../src/command/file-system-access.ts';
import { consumeExactLocalFileRead } from '../src/core/local-file-grant.ts';

function handleFor(bytes: Uint8Array): FileSystemFileHandleLike {
  return {
    kind: 'file',
    name: 'local.hwp',
    async getFile() {
      return new File([bytes as BlobPart], 'local.hwp');
    },
    async createWritable() {
      throw new Error('not used');
    },
  };
}

test('an exact handle read grants only its returned byte view and only once', async () => {
  const handle = handleFor(new Uint8Array([1, 2, 3]));
  const { bytes } = await readFileFromHandle(handle);

  assert.equal(consumeExactLocalFileRead(new Uint8Array(bytes), handle), false);
  assert.equal(consumeExactLocalFileRead(bytes, handleFor(bytes)), false);
  assert.equal(consumeExactLocalFileRead(bytes, handle), true);
  assert.equal(consumeExactLocalFileRead(bytes, handle), false);
});

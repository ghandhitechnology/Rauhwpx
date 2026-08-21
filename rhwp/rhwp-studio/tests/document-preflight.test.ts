import test from 'node:test';
import assert from 'node:assert/strict';

import type { FileSystemFileHandleLike } from '../src/command/file-system-access.ts';
import {
  documentSourceDigest,
  resolveDocumentPreflight,
} from '../src/recent/document-preflight.ts';
import type { RecentDoc } from '../src/recent/recent-store.ts';

function handle(name: string, same: (other: FileSystemFileHandleLike) => Promise<boolean>) {
  return {
    kind: 'file' as const,
    name,
    getFile: async () => new File([], name),
    createWritable: async () => ({
      write: async () => {},
      close: async () => {},
    }),
    isSameEntry: same,
  } satisfies FileSystemFileHandleLike;
}

function recent(
  documentId: string,
  sourceDigest: string,
  fileHandle?: FileSystemFileHandleLike,
): RecentDoc {
  return {
    id: `recent-${documentId}`,
    documentId,
    sourceDigest,
    fileName: fileHandle?.name ?? 'report.hwp',
    sourceFormat: 'hwp',
    openedAt: 1,
    ...(fileHandle ? { handle: fileHandle } : {}),
  };
}

test('preflight uses the same blake3 source digest before WASM load', () => {
  assert.equal(
    documentSourceDigest(new Uint8Array([1, 2, 3])),
    'blake3:b177ec1bf26dfb3b7010d473e6d44713b29b765b99c6e60ecbfae742de496543',
  );
});

test('preflight restores documentId through isSameEntry before parsing', async () => {
  const stored = handle('report.hwp', async () => false);
  const selected = handle('report.hwp', async (other) => other === stored);
  const bytes = new Uint8Array([4, 5, 6]);
  const result = await resolveDocumentPreflight(
    bytes,
    selected,
    [recent('stable-document', 'blake3:old', stored)],
    () => 'new-document',
  );

  assert.deepEqual(result, {
    documentId: 'stable-document',
    sourceDigest: documentSourceDigest(bytes),
    useSourceDigest: false,
  });
});

test('digest is the duplicate fallback when handles cannot be compared', async () => {
  const bytes = new Uint8Array([7, 8, 9]);
  const digest = documentSourceDigest(bytes);
  const unavailable = handle('report.hwp', async () => {
    throw new DOMException('blocked', 'SecurityError');
  });
  const result = await resolveDocumentPreflight(
    bytes,
    unavailable,
    [recent('digest-document', digest, handle('stored.hwp', async () => false))],
    () => 'new-document',
  );

  assert.equal(result.documentId, 'digest-document');
  assert.equal(result.useSourceDigest, true);
});

test('opaque native-path identity does not collapse distinct files with identical bytes', async () => {
  const bytes = new Uint8Array([10, 11]);
  const digest = documentSourceDigest(bytes);
  const selected = {
    ...handle('copy.hwp', async () => false),
    identityKind: 'native-path' as const,
  };
  const result = await resolveDocumentPreflight(
    bytes,
    selected,
    [recent('other-copy', digest)],
    () => 'new-native-copy',
  );

  assert.deepEqual(result, {
    documentId: 'new-native-copy',
    sourceDigest: digest,
    useSourceDigest: false,
  });
});

test('preferred documentId survives native-path reopens that cannot compare handles', async () => {
  const bytes = new Uint8Array([12, 13]);
  const digest = documentSourceDigest(bytes);
  const selected = {
    ...handle('report.hwp', async () => {
      throw new DOMException('Handle kinds cannot be compared', 'NotSupportedError');
    }),
    identityKind: 'native-path' as const,
  };
  const result = await resolveDocumentPreflight(
    bytes,
    selected,
    [recent('library-doc', digest)],
    () => 'new-native-copy',
    { kind: 'verified', documentId: 'library-doc' },
  );

  assert.deepEqual(result, {
    documentId: 'library-doc',
    sourceDigest: digest,
    useSourceDigest: false,
  });
});

test('successful isSameEntry=false keeps identical copies logically separate', async () => {
  const bytes = new Uint8Array([10, 11]);
  const digest = documentSourceDigest(bytes);
  const selected = handle('copy.hwp', async () => false);
  const result = await resolveDocumentPreflight(
    bytes,
    selected,
    [recent('other-copy', digest, handle('copy.hwp', async () => false))],
    () => 'new-copy',
  );

  assert.deepEqual(result, {
    documentId: 'new-copy',
    sourceDigest: digest,
    useSourceDigest: false,
  });
});

test('picker without a verified grant mints a new id', async () => {
  const bytes = new Uint8Array([14, 15]);
  const digest = documentSourceDigest(bytes);
  const selected = {
    ...handle('report.hwp', async () => false),
    identityKind: 'native-path' as const,
  };
  const result = await resolveDocumentPreflight(
    bytes,
    selected,
    [recent('library-doc', digest)],
    () => 'fresh-from-picker',
  );

  assert.deepEqual(result, {
    documentId: 'fresh-from-picker',
    sourceDigest: digest,
    useSourceDigest: false,
  });
});

test('verified grant wins over a same-entry recent with a different documentId', async () => {
  const stored = handle('report.hwp', async () => true);
  const selected = handle('report.hwp', async () => true);
  const bytes = new Uint8Array([20, 21]);
  const result = await resolveDocumentPreflight(
    bytes,
    selected,
    [recent('other-id', documentSourceDigest(bytes), stored)],
    () => 'new-document',
    { kind: 'verified', documentId: 'project-id' },
  );

  assert.deepEqual(result, {
    documentId: 'project-id',
    sourceDigest: documentSourceDigest(bytes),
    useSourceDigest: false,
  });
});

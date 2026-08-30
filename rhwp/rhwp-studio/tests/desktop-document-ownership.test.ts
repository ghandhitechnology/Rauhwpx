import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open as openFs,
  readFile as readFs,
  readdir,
  rm as rmFs,
  stat as statFs,
  writeFile as writeFs,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { DocumentLeaseManager } from '../../../desktop/document-leases.mjs';
import {
  bindNativeFileHandleIdentity,
  createNativeFileHandle,
} from '../src/desktop-integration.ts';
import {
  canonicalNativePath,
  fingerprintNativeFile,
  NATIVE_FILE_ATOMIC_UNSUPPORTED_CODE,
  NATIVE_FILE_CONFLICT_CODE,
  NATIVE_FILE_CONFLICT_MESSAGE,
  NATIVE_FILE_RECOVERY_REQUIRED_CODE,
  NATIVE_FILE_WRITE_BUSY_CODE,
  MAX_NATIVE_DOCUMENT_BYTES,
  MAX_PORTABLE_HISTORY_BYTES,
  NativeFileHandleRegistry,
  nativePathOwnershipKey,
  readPortableHistoryBytes,
  runNativeMetadataCommand,
  validateNativeDocumentBytes,
  validateNativeDocumentPath,
  writeNativeFileAtomically,
} from '../../../desktop/native-file-handles.mjs';

function minimalCfbBytes(fill = 0): Uint8Array {
  const bytes = new Uint8Array(1536).fill(fill);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  bytes.set([0xfe, 0xff], 28);
  bytes.set([9, 0], 30);
  return bytes;
}

function minimalPortableHistoryBytes(marker = 0): Uint8Array {
  const magic = new TextEncoder().encode('RAUHWPX-HISTORY\0');
  const manifest = new TextEncoder().encode(JSON.stringify({
    format: 'rauhwpx-history',
    version: 1,
    document: {},
    repository: {},
    objects: [{ kind: 'blob', id: 'test-object', offset: 0, byteLength: 1 }],
  }));
  const result = new Uint8Array(magic.byteLength + 4 + manifest.byteLength + 1);
  result.set(magic);
  new DataView(result.buffer).setUint32(magic.byteLength, manifest.byteLength, true);
  result.set(manifest, magic.byteLength + 4);
  result[result.length - 1] = marker;
  return result;
}

async function withTemporaryDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'rauhwpx-native-save-'));
  try {
    await run(directory);
  } finally {
    await rmFs(directory, { recursive: true, force: true });
  }
}

function identity(documentId: string, sourceDigest: string) {
  return { documentId, sourceDigest };
}

const TEST_NATIVE_FINGERPRINT = Object.freeze({
  state: 'file',
  generation: 'test-generation',
  changeTime: 'test-change',
  digest: `sha256:${'0'.repeat(64)}`,
});
const fakeNativeFingerprint = async () => TEST_NATIVE_FINGERPRINT;

test('failed duplicate reservation preserves the caller and owner leases', () => {
  const ids = ['reservation-a', 'reservation-b', 'reservation-c'];
  const leases = new DocumentLeaseManager({ createId: () => ids.shift() });
  const current = identity('document-a', 'blake3:a');
  const first = leases.reserve('session-a', current, '/docs/a.hwp');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  leases.commit('session-a', first.reservationId);

  const duplicate = leases.reserve('session-b', current, '/docs/a.hwp');
  assert.deepEqual(duplicate, { ok: false, ownerSessionId: 'session-a' });
  assert.equal(leases.leaseForSession('session-a')?.identity.documentId, 'document-a');
  assert.equal(leases.leaseForSession('session-b'), null);

  const retry = leases.reserve('session-a', current, '/docs/a.hwp');
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  leases.cancel('session-a', retry.reservationId);
  assert.deepEqual(
    leases.reserve('session-b', current, '/docs/a.hwp'),
    { ok: false, ownerSessionId: 'session-a' },
    'cancelling a same-window replacement must not unindex its committed lease',
  );
});

test('committing replacement releases old identity and close releases the replacement', () => {
  const ids = ['first', 'replacement', 'claim-old', 'claim-new'];
  const leases = new DocumentLeaseManager({ createId: () => ids.shift() });
  const first = leases.reserve('session-a', identity('document-a', 'blake3:a'));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  leases.commit('session-a', first.reservationId);

  const replacement = leases.reserve('session-a', identity('document-b', 'blake3:b'));
  assert.equal(replacement.ok, true);
  if (!replacement.ok) return;
  leases.commit('session-a', replacement.reservationId);

  assert.equal(leases.reserve('session-b', identity('document-a', 'blake3:a')).ok, true);
  assert.equal(leases.reserve('session-b', identity('document-b', 'blake3:b')).ok, false);
  leases.releaseSession('session-a');
  assert.equal(leases.reserve('session-c', identity('document-b', 'blake3:b')).ok, true);
});

test('pending Save As reservation authorizes only its exact destination until commit', () => {
  const ids = ['open', 'save-as'];
  const leases = new DocumentLeaseManager({ createId: () => ids.shift() });
  const active = identity('document-a', 'blake3:a');
  const opened = leases.reserve('session-a', active, '/old/report.hwp');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  leases.commit('session-a', opened.reservationId);

  const saveAs = leases.reserve('session-a', active, '/new/report.hwp');
  assert.equal(saveAs.ok, true);
  if (!saveAs.ok) return;
  assert.equal(leases.validateSaveTarget('session-a', active, '/new/report.hwp'), true);
  assert.throws(
    () => leases.validateSaveTarget('session-a', active, '/other/report.hwp'),
    /another document/,
  );
  leases.cancel('session-a', saveAs.reservationId);
  assert.throws(
    () => leases.validateSaveTarget('session-a', active, '/new/report.hwp'),
    /another document/,
  );
});

test('authoritative handle identities allow distinct files with identical bytes', () => {
  const ids = ['first', 'second', 'fallback', 'blocked'];
  const leases = new DocumentLeaseManager({ createId: () => ids.shift() });
  const first = leases.reserve('session-a', {
    documentId: 'copy-a',
    sourceDigest: 'blake3:same',
    useSourceDigest: false,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  leases.commit('session-a', first.reservationId);

  const second = leases.reserve('session-b', {
    documentId: 'copy-b',
    sourceDigest: 'blake3:same',
    useSourceDigest: false,
  });
  assert.equal(second.ok, true);

  const fallback = leases.reserve('session-c', {
    documentId: 'digest-only-copy',
    sourceDigest: 'blake3:same',
    useSourceDigest: true,
  });
  assert.equal(fallback.ok, true, 'handle-backed leases do not claim the digest fallback key');
  if (!fallback.ok) return;
  leases.commit('session-c', fallback.reservationId);
  assert.equal(leases.reserve('session-d', {
    documentId: 'another-digest-only-copy',
    sourceDigest: 'blake3:same',
    useSourceDigest: true,
  }).ok, false);
});

test('opaque native handles are sender-scoped and validate ownership before writing', async () => {
  const writes: Array<{ path: string; bytes: number[] }> = [];
  const registry = new NativeFileHandleRegistry({
    createId: () => 'opaque-handle',
    canonicalize: async () => '/canonical/report.hwp',
    fingerprintImpl: fakeNativeFingerprint,
    readFileImpl: async () => new Uint8Array([1, 2, 3]),
    writeFileImpl: async (path: string, bytes: Uint8Array) => {
      writes.push({ path, bytes: [...bytes] });
    },
  });
  const created = await registry.create('session-a', '/ignored/report.hwp');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.deepEqual(created.descriptor, {
    kind: 'file',
    handleId: 'opaque-handle',
    name: 'report.hwp',
  });
  assert.equal('path' in created.descriptor, false);
  assert.equal(
    registry.sourcePathForSender('session-a', created.descriptor.handleId),
    '/canonical/report.hwp',
  );
  assert.throws(
    () => registry.sourcePathForSender('session-b', created.descriptor.handleId),
    /does not belong/,
  );

  await assert.rejects(registry.read('session-b', created.descriptor.handleId), /does not belong/);

  const leases = new DocumentLeaseManager({ createId: () => 'reservation' });
  const activeIdentity = identity('document-a', 'blake3:a');
  const reservation = leases.reserve('session-a', activeIdentity, '/canonical/report.hwp');
  assert.equal(reservation.ok, true);
  if (!reservation.ok) return;
  leases.commit('session-a', reservation.reservationId);

  await assert.rejects(
    registry.write(
      'session-a',
      created.descriptor.handleId,
      new Uint8Array([9]),
      identity('document-b', 'blake3:b'),
      leases,
    ),
    /active document|stale/,
  );
  assert.equal(writes.length, 0, 'ownership must be checked before bytes reach fs.writeFile');

  await registry.write(
    'session-a',
    created.descriptor.handleId,
    minimalCfbBytes(4),
    activeIdentity,
    leases,
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/canonical/report.hwp');
  assert.deepEqual(writes[0].bytes, [...minimalCfbBytes(4)]);
});

test('concurrent open fingerprinting cannot publish two owners for one path', async () => {
  const finish: Array<() => void> = [];
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/canonical/report.hwp',
    createId: () => 'winner',
    fingerprintImpl: async () => new Promise((resolve) => {
      finish.push(() => resolve(TEST_NATIVE_FINGERPRINT));
    }),
  });
  const first = registry.create('session-a', '/report.hwp');
  const second = registry.create('session-b', '/report.hwp');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finish.length, 2);
  finish[0]();
  const winner = await first;
  assert.equal(winner.ok, true);
  finish[1]();
  assert.deepEqual(await second, { ok: false, ownerSessionId: 'session-a' });
});

test('an in-flight atomic write pins its path until completion', async () => {
  let finishWrite: (() => void) | undefined;
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/Canonical/Report.HWP',
    fingerprintImpl: fakeNativeFingerprint,
    createId: (() => {
      const ids = ['writer', 'next-owner'];
      return () => ids.shift()!;
    })(),
    writeFileImpl: async () => new Promise<void>((resolve) => { finishWrite = resolve; }),
  });
  const opened = await registry.create('session-a', '/report.hwp');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const leases = new DocumentLeaseManager({ createId: () => 'open' });
  const active = identity('document-a', 'blake3:a');
  const ownershipPath = registry.pathForSender('session-a', opened.descriptor.handleId);
  const reservation = leases.reserve('session-a', active, ownershipPath);
  assert.equal(reservation.ok, true);
  if (!reservation.ok) return;
  leases.commit('session-a', reservation.reservationId);

  const writing = registry.write(
    'session-a', opened.descriptor.handleId, minimalCfbBytes(1), active, leases,
  );
  registry.releaseHandle('session-a', opened.descriptor.handleId);
  assert.deepEqual(
    await registry.create('session-b', '/report.hwp'),
    { ok: false, ownerSessionId: 'session-a' },
  );
  finishWrite?.();
  await writing;
  assert.equal((await registry.create('session-b', '/report.hwp')).ok, true);
});

test('native Save As targets canonicalize missing paths and release sender claims', async () => {
  let canonicalizeOptions: { allowMissing?: boolean } | undefined;
  const ids = ['save-a', 'save-b'];
  const registry = new NativeFileHandleRegistry({
    canonicalize: async (_filePath, options) => {
      canonicalizeOptions = options;
      return '/canonical/new-report.hwp';
    },
    createId: () => ids.shift()!,
  });

  const first = await registry.createSaveTarget('session-a', '/new/report.hwp');
  assert.equal(first.ok, true);
  assert.deepEqual(canonicalizeOptions, { allowMissing: true });
  const blocked = await registry.createSaveTarget('session-b', '/new/report.hwp');
  assert.deepEqual(blocked, { ok: false, ownerSessionId: 'session-a' });
  if (!first.ok) return;
  registry.releaseHandle('session-a', first.descriptor.handleId);
  assert.equal((await registry.createSaveTarget('session-b', '/new/report.hwp')).ok, true);
});

test('renderer native adapter reads and writes only through opaque IPC contracts', async () => {
  const writes: Array<{ handleId: string; bytes: number[]; documentId: string }> = [];
  const api = {
    readNativeFile: async (handleId: string) => ({
      name: 'opened.hwp',
      bytes: new Uint8Array(handleId === 'opaque-1' ? [1, 2] : []),
    }),
    validateNativeSave: async () => {},
    writeNativeFile: async (
      handleId: string,
      bytes: Uint8Array,
      owner: { documentId: string },
    ) => {
      writes.push({ handleId, bytes: [...bytes], documentId: owner.documentId });
      return { name: 'opened.hwp', byteLength: bytes.byteLength };
    },
    isSameNativeFile: async (first: string, second: string) => first === second,
  };
  const fileHandle = createNativeFileHandle({
    kind: 'file',
    handleId: 'opaque-1',
    name: 'opened.hwp',
  }, api);

  assert.equal((await fileHandle.getFile()).name, 'opened.hwp');
  const unowned = await fileHandle.createWritable();
  await unowned.write(new Blob(['blocked']));
  await assert.rejects(unowned.close(), /no active document ownership/);
  assert.equal(writes.length, 0);

  bindNativeFileHandleIdentity(fileHandle, identity('document-a', 'blake3:a'));
  const writable = await fileHandle.createWritable();
  await writable.write(new Blob([new Uint8Array([7, 8])]));
  await writable.close();
  assert.deepEqual(writes, [{
    handleId: 'opaque-1',
    bytes: [7, 8],
    documentId: 'document-a',
  }]);
});

test('native ownership keys fold case on default macOS and Windows volumes', () => {
  assert.equal(
    nativePathOwnershipKey('/Users/Andy/Report.HWP', { platform: 'darwin' }),
    nativePathOwnershipKey('/users/andy/report.hwp', { platform: 'darwin' }),
  );
  assert.notEqual(
    nativePathOwnershipKey('/home/Andy/Report.HWP', { platform: 'linux' }),
    nativePathOwnershipKey('/home/andy/report.hwp', { platform: 'linux' }),
  );
});

test('native paths validate extensions while Windows I/O preserves resolved case', async () => {
  assert.throws(() => validateNativeDocumentPath('/tmp/report.txt'), /Only HWP/);
  const canonical = await canonicalNativePath('C:\\Docs\\REPORT.HWP', {
    platform: 'win32',
    resolveRealPath: async () => 'C:\\Docs\\REPORT.HWP',
  });
  assert.equal(canonical, 'C:\\Docs\\REPORT.HWP');
  assert.equal(
    nativePathOwnershipKey(canonical, { platform: 'win32' }),
    'c:\\docs\\report.hwp',
  );
});

test('re-acquiring a handle cancels a release pending behind an in-flight write', async () => {
  let finishWrite: (() => void) | undefined;
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/canonical/report.hwp',
    fingerprintImpl: fakeNativeFingerprint,
    createId: () => 'writer',
    writeFileImpl: async () => new Promise<void>((resolve) => { finishWrite = resolve; }),
  });
  const opened = await registry.create('session-a', '/report.hwp');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const leases = new DocumentLeaseManager({ createId: () => 'open' });
  const active = identity('document-a', 'blake3:a');
  const reservation = leases.reserve(
    'session-a', active, registry.pathForSender('session-a', opened.descriptor.handleId),
  );
  assert.equal(reservation.ok, true);
  if (!reservation.ok) return;
  leases.commit('session-a', reservation.reservationId);

  const writing = registry.write(
    'session-a', opened.descriptor.handleId, minimalCfbBytes(1), active, leases,
  );
  registry.releaseHandle('session-a', opened.descriptor.handleId);
  const reacquired = await registry.create('session-a', '/report.hwp');
  assert.equal(reacquired.ok, true);
  if (!reacquired.ok) return;
  assert.equal(reacquired.descriptor.handleId, opened.descriptor.handleId);
  finishWrite?.();
  await writing;
  // The write finishing must not delete the handle the session just re-acquired.
  assert.deepEqual(registry.descriptorsForSession('session-a'), [reacquired.descriptor]);
});

test('native bookmarks reopen a released handle without leaking the path', async () => {
  const ids = ['first', 'restored'];
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/canonical/report.hwp',
    fingerprintImpl: fakeNativeFingerprint,
    createId: () => ids.shift()!,
    readFileImpl: async () => new Uint8Array([1, 2, 3]),
  });
  const created = await registry.create('session-a', '/report.hwp');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(registry.rememberDocument('document-a', 'session-a', created.descriptor.handleId), '/canonical/report.hwp');
  registry.releaseHandle('session-a', created.descriptor.handleId);

  const reopened = await registry.reopenDocument('session-a', 'document-a');
  assert.equal(reopened?.ok, true);
  if (!reopened?.ok) return;
  assert.equal(reopened.descriptor.handleId, 'restored');
  assert.equal(reopened.descriptor.verifiedDocumentId, 'document-a');
  assert.equal('path' in reopened.descriptor, false);
  assert.deepEqual(await registry.read('session-a', reopened.descriptor.handleId), {
    name: 'report.hwp',
    bytes: new Uint8Array([1, 2, 3]),
  });
});

test('native bookmarks persist independently of live handles', async () => {
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/canonical/report.hwp',
    fingerprintImpl: fakeNativeFingerprint,
    createId: () => 'bookmarked',
  });
  registry.loadBookmarks([['document-a', '/canonical/report.hwp']]);
  const reopened = await registry.reopenDocument('session-b', 'document-a');
  assert.equal(reopened?.ok, true);
  if (!reopened?.ok) return;
  assert.deepEqual(reopened.descriptor, {
    kind: 'file',
    handleId: 'bookmarked',
    name: 'report.hwp',
    verifiedDocumentId: 'document-a',
  });
  assert.deepEqual(registry.dumpBookmarks(), [[
    'document-a',
    { path: '/canonical/report.hwp', digest: null },
  ]]);
});

test('native descriptors omit identity for unbookmarked files and different canonical paths', async () => {
  const registry = new NativeFileHandleRegistry({
    canonicalize: async (filePath: string) => filePath,
    fingerprintImpl: fakeNativeFingerprint,
    createId: () => 'unbookmarked',
  });
  registry.loadBookmarks([['document-a', '/canonical/original.hwp']]);

  const opened = await registry.create('session-a', '/canonical/copy.hwp');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.deepEqual(opened.descriptor, {
    kind: 'file',
    handleId: 'unbookmarked',
    name: 'copy.hwp',
  });
});

test('legacy duplicate bookmark paths prefer the oldest owner and collapse after remember', async () => {
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/canonical/report.hwp',
    fingerprintImpl: fakeNativeFingerprint,
    createId: () => 'restored',
  });
  registry.loadBookmarks([
    ['original-history', '/canonical/report.hwp'],
    ['broken-reopen', '/canonical/report.hwp'],
  ]);

  const reopened = await registry.reopenDocument('session-a', 'broken-reopen');
  assert.equal(reopened?.ok, true);
  if (!reopened?.ok) return;
  assert.equal(reopened.descriptor.verifiedDocumentId, 'original-history');

  registry.rememberDocument(
    'original-history',
    'session-a',
    reopened.descriptor.handleId,
    VALID_DIGEST,
  );
  assert.deepEqual(registry.dumpBookmarks(), [[
    'original-history',
    { path: '/canonical/report.hwp', digest: VALID_DIGEST },
  ]]);
});

test('native package validation accepts real fixtures and rejects truncation or format mismatch', async () => {
  const realHwp = new Uint8Array(await readFs(new URL('../../saved/blank2010.hwp', import.meta.url)));
  const realHwpx = new Uint8Array(await readFs(new URL('../../samples/hwpx/footnote-01.hwpx', import.meta.url)));
  assert.doesNotThrow(() => validateNativeDocumentBytes('/docs/report.hwp', realHwp));
  assert.doesNotThrow(() => validateNativeDocumentBytes('/docs/report.hwpx', realHwpx));
  assert.doesNotThrow(() => validateNativeDocumentBytes('/docs/report.rhwpx', minimalPortableHistoryBytes()));
  assert.doesNotThrow(() => validateNativeDocumentBytes(
    '/docs/report.hml',
    new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"></HWPML>'),
  ));

  assert.throws(
    () => validateNativeDocumentBytes('/docs/report.hml', new Uint8Array()),
    /empty or oversized/,
  );
  assert.throws(
    () => validateNativeDocumentBytes('/docs/report.hml', new TextEncoder().encode('<html>wrong</html>')),
    /invalid or truncated XML/,
  );
  assert.throws(
    () => validateNativeDocumentBytes('/docs/report.hwp', realHwp.subarray(0, 900)),
    /invalid or truncated CFB/,
  );
  assert.throws(
    () => validateNativeDocumentBytes('/docs/report.hwp', realHwpx),
    /invalid or truncated CFB/,
  );
  assert.throws(
    () => validateNativeDocumentBytes('/docs/report.hwpx', realHwpx.subarray(0, realHwpx.length - 8)),
    /invalid or truncated ZIP/,
  );
  assert.throws(
    () => validateNativeDocumentBytes('/docs/report.rhwpx', new Uint8Array([1, 2, 3])),
    /invalid or truncated history archive/,
  );
  const portable = minimalPortableHistoryBytes();
  assert.throws(
    () => validateNativeDocumentBytes('/docs/report.rhwpx', portable.subarray(0, -1)),
    /invalid or truncated history archive/,
  );
  const portableWithTrailingData = new Uint8Array(portable.byteLength + 1);
  portableWithTrailingData.set(portable);
  assert.throws(
    () => validateNativeDocumentBytes('/docs/report.rhwpx', portableWithTrailingData),
    /invalid or truncated history archive/,
  );
});

test('portable reads reject oversized files before allocating their contents', async () => {
  let readAttempted = false;
  await assert.rejects(
    readPortableHistoryBytes('/docs/huge.rhwpx', {
      statImpl: async () => ({
        isDirectory: () => false,
        isFile: () => true,
        size: MAX_PORTABLE_HISTORY_BYTES + 1,
      }),
      readFileImpl: async () => {
        readAttempted = true;
        return new Uint8Array();
      },
    }),
    /128 MiB limit/,
  );
  assert.equal(readAttempted, false);
});

test('portable fallback reads retain the 128 MiB cap when the file changes after stat', async () => {
  const oversized = Object.create(Uint8Array.prototype) as Uint8Array;
  Object.defineProperty(oversized, 'byteLength', {
    value: MAX_PORTABLE_HISTORY_BYTES + 1,
  });

  await assert.rejects(
    readPortableHistoryBytes('/docs/growing.rhwpx', {
      statImpl: async () => ({
        isDirectory: () => false,
        isFile: () => true,
        size: 1,
      }),
      readFileImpl: async () => oversized,
      openImpl: null,
    }),
    /changed while it was being read/,
  );
});

test('native reads use one opened file, reject its fstat size, and preserve Buffer views', async () => {
  let handleRead = false;
  let handleClosed = false;
  await assert.rejects(
    readPortableHistoryBytes('/docs/growing.hwp', {
      statImpl: async () => ({
        isDirectory: () => false,
        isFile: () => true,
        size: 10,
      }),
      openImpl: async () => ({
        stat: async () => ({
          isFile: () => true,
          size: MAX_NATIVE_DOCUMENT_BYTES + 1,
        }),
        read: async () => {
          handleRead = true;
          return { bytesRead: 0 };
        },
        close: async () => { handleClosed = true; },
      }),
    }),
    /512 MiB limit/,
  );
  assert.equal(handleRead, false);
  assert.equal(handleClosed, true);

  const original = Buffer.from([1, 2, 3, 4]);
  const read = await readPortableHistoryBytes('/docs/report.hwp', {
    statImpl: async () => ({
      isDirectory: () => false,
      isFile: () => true,
      size: original.byteLength,
    }),
    readFileImpl: async () => original,
    openImpl: null,
  });
  assert.equal(Buffer.isBuffer(read), false);
  assert.equal(read.buffer, original.buffer);
  assert.equal(read.byteOffset, original.byteOffset);
  assert.equal(read.byteLength, original.byteLength);
});

test('atomic native replacement preserves the destination on temp write and rename failures', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');

    const writeFailureOpen = async (path: string, flags: string) => {
      const file = await openFs(path, flags);
      return {
        truncate: (length: number) => file.truncate(length),
        writeFile: async () => { throw new Error('injected write failure'); },
        chmod: (mode: number) => file.chmod(mode),
        sync: () => file.sync(),
        close: () => file.close(),
      };
    };
    await assert.rejects(
      writeNativeFileAtomically(target, new Uint8Array([1]), { openImpl: writeFailureOpen }),
      /injected write failure/,
    );
    assert.equal(await readFs(target, 'utf8'), 'previous');
    assert.deepEqual(await readdir(directory), ['report.hwp'], 'failed temp write must be cleaned up');

    await assert.rejects(
      writeNativeFileAtomically(target, new Uint8Array([2]), {
        renameImpl: async () => { throw new Error('injected rename failure'); },
      }),
      /injected rename failure/,
    );
    assert.equal(await readFs(target, 'utf8'), 'previous');
    assert.deepEqual(await readdir(directory), ['report.hwp'], 'failed rename temp must be cleaned up');
  });
});

test('portable history archives are single atomic files that can be rewritten in place', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.rhwpx');
    await writeFs(target, 'old-file');
    const history = minimalPortableHistoryBytes(7);
    await writeNativeFileAtomically(target, history);

    assert.deepEqual((await readdir(directory)).sort(), ['report.rhwpx']);
    assert.deepEqual(await readPortableHistoryBytes(target), history);

    const files = new NativeFileHandleRegistry();
    const opened = await files.create('session-a', target);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const read = await files.read('session-a', opened.descriptor.handleId);
    assert.equal(read.name, 'report.rhwpx');
    assert.equal(opened.descriptor.legacyPortableHistoryFolder, undefined);
    assert.deepEqual(read.bytes, history);

    const nextHistory = minimalPortableHistoryBytes(9);
    const active = identity('document-a', 'blake3:a');
    const leases = new DocumentLeaseManager({ createId: () => 'open' });
    const reservation = leases.reserve(
      'session-a', active, files.pathForSender('session-a', opened.descriptor.handleId),
    );
    assert.equal(reservation.ok, true);
    if (!reservation.ok) return;
    leases.commit('session-a', reservation.reservationId);

    await files.write('session-a', opened.descriptor.handleId, nextHistory, active, leases);
    assert.deepEqual(await readPortableHistoryBytes(target), nextHistory);
  });
});

test('legacy RHWPX folders are readable for import but can never become save targets', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'legacy.rhwpx');
    const history = minimalPortableHistoryBytes(4);
    await mkdir(target);
    await writeFs(join(target, 'history'), history);
    await writeFs(join(target, 'report.hwpx'), new Uint8Array([0x50, 0x4b, 3, 4]));

    const files = new NativeFileHandleRegistry();
    const opened = await files.create('session-a', target);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(opened.descriptor.legacyPortableHistoryFolder, true);
    assert.deepEqual((await files.read('session-a', opened.descriptor.handleId)).bytes, history);

    const active = identity('document-a', 'blake3:a');
    const leases = new DocumentLeaseManager({ createId: () => 'open' });
    const reservation = leases.reserve(
      'session-a', active, files.pathForSender('session-a', opened.descriptor.handleId),
    );
    assert.equal(reservation.ok, true);
    if (!reservation.ok) return;
    leases.commit('session-a', reservation.reservationId);
    await assert.rejects(
      files.write('session-a', opened.descriptor.handleId, minimalPortableHistoryBytes(5), active, leases),
      /import-only/,
    );
    await assert.rejects(files.createSaveTarget('session-b', target), /import-only/);
    assert.deepEqual(await readPortableHistoryBytes(target), history);
  });
});

test('atomic native replacement fsyncs and replaces a real destination', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    await writeNativeFileAtomically(target, new Uint8Array([4, 5, 6]));
    assert.deepEqual(new Uint8Array(await readFs(target)), new Uint8Array([4, 5, 6]));
    assert.deepEqual(await readdir(directory), ['report.hwp']);
  });
});

test('native save rejects an external same-size edit and leaves those bytes untouched', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    const original = minimalCfbBytes(1);
    const external = minimalCfbBytes(2);
    const local = minimalCfbBytes(3);
    await writeFs(target, original);

    const registry = new NativeFileHandleRegistry();
    const opened = await registry.create('session-a', target);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const active = identity('document-a', 'blake3:a');
    const leases = new DocumentLeaseManager({ createId: () => 'open' });
    const reservation = leases.reserve(
      'session-a', active, registry.pathForSender('session-a', opened.descriptor.handleId),
    );
    assert.equal(reservation.ok, true);
    if (!reservation.ok) return;
    leases.commit('session-a', reservation.reservationId);

    await writeFs(target, external);
    await assert.rejects(
      registry.write('session-a', opened.descriptor.handleId, local, active, leases),
      (error: NodeJS.ErrnoException) => (
        error.code === NATIVE_FILE_CONFLICT_CODE
        && error.message === NATIVE_FILE_CONFLICT_MESSAGE
      ),
    );
    assert.deepEqual(new Uint8Array(await readFs(target)), external);
    assert.deepEqual(await readdir(directory), ['report.hwp']);
  });
});

test('rename-aside CAS catches an external replacement made after temp preparation', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    const original = minimalCfbBytes(1);
    const external = minimalCfbBytes(8);
    await writeFs(target, original);
    const expectedFingerprint = await fingerprintNativeFile(target);
    let injected = false;

    await assert.rejects(
      writeNativeFileAtomically(target, minimalCfbBytes(9), {
        platform: 'linux',
        expectedFingerprint,
        renameImpl: async (from: string, to: string) => {
          if (!injected) {
            injected = true;
            await writeFs(target, external);
          }
          const { rename } = await import('node:fs/promises');
          await rename(from, to);
        },
      }),
      { code: NATIVE_FILE_CONFLICT_CODE },
    );
    assert.equal(injected, true);
    assert.deepEqual(new Uint8Array(await readFs(target)), external);
    assert.deepEqual(await readdir(directory), ['report.hwp']);
  });
});

test('a destination recreated after compare preserves both it and the recovery original', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    const original = minimalCfbBytes(1);
    const external = minimalCfbBytes(7);
    await writeFs(target, original);
    const expectedFingerprint = await fingerprintNativeFile(target);
    let injected = false;
    let recoveryFile = '';

    await assert.rejects(
      writeNativeFileAtomically(target, minimalCfbBytes(9), {
        platform: 'linux',
        expectedFingerprint,
        linkImpl: async (from: string, to: string) => {
          if (!injected && to === target) {
            injected = true;
            await writeFs(target, external);
          }
          const { link } = await import('node:fs/promises');
          await link(from, to);
        },
      }),
      (error: any) => {
        assert.equal(error?.code, NATIVE_FILE_RECOVERY_REQUIRED_CODE);
        assert.equal(error?.cause?.code, NATIVE_FILE_CONFLICT_CODE);
        assert.equal(error?.errors?.filter((entry: any) => entry?.code === 'EEXIST').length, 2);
        recoveryFile = error.recoveryFile;
        return true;
      },
    );
    assert.equal(injected, true);
    assert.deepEqual(new Uint8Array(await readFs(target)), external);
    assert.match(recoveryFile, /report\.rauhwpx-recovery-.*\.hwp$/);
    assert.deepEqual(new Uint8Array(await readFs(recoveryFile)), original);
    assert.deepEqual((await readdir(directory)).sort(), [basename(recoveryFile), 'report.hwp'].sort());
  });
});

test('unsupported hard links fail before an existing destination is moved', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    let renamed = false;
    const unsupported = Object.assign(new Error('hard links unavailable'), { code: 'ENOTSUP' });
    await assert.rejects(
      writeNativeFileAtomically(target, new Uint8Array([1, 2, 3]), {
        platform: 'linux',
        linkImpl: async () => { throw unsupported; },
        renameImpl: async () => { renamed = true; },
      }),
      { code: NATIVE_FILE_ATOMIC_UNSUPPORTED_CODE },
    );
    assert.equal(renamed, false);
    assert.equal(await readFs(target, 'utf8'), 'previous');
    assert.deepEqual(await readdir(directory), ['report.hwp']);
  });
});

test('unsupported hard links leave a missing Save As destination missing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'new-report.hwp');
    const unsupported = Object.assign(new Error('hard links unavailable'), { code: 'EOPNOTSUPP' });
    await assert.rejects(
      writeNativeFileAtomically(target, new Uint8Array([1, 2, 3]), {
        platform: 'linux',
        linkImpl: async () => { throw unsupported; },
      }),
      { code: NATIVE_FILE_ATOMIC_UNSUPPORTED_CODE },
    );
    assert.deepEqual(await readdir(directory), []);
  });
});

test('a post-probe hard-link failure restores the moved file without overwriting', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    let linkCalls = 0;
    await assert.rejects(
      writeNativeFileAtomically(target, new Uint8Array([1, 2, 3]), {
        platform: 'linux',
        linkImpl: async (from: string, to: string) => {
          linkCalls += 1;
          if (linkCalls > 1) {
            throw Object.assign(new Error('link support disappeared'), { code: 'ENOTSUP' });
          }
          const { link } = await import('node:fs/promises');
          await link(from, to);
        },
      }),
      { code: NATIVE_FILE_ATOMIC_UNSUPPORTED_CODE },
    );
    assert.equal(linkCalls, 3, 'probe, publication, and hard-link rollback were attempted');
    assert.equal(await readFs(target, 'utf8'), 'previous');
    assert.deepEqual(await readdir(directory), ['report.hwp']);
  });
});

test('dual rollback failure retains an openable recovery document and reports its path', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    let linkCalls = 0;
    let recoveryFile = '';
    await assert.rejects(
      writeNativeFileAtomically(target, new Uint8Array([1, 2, 3]), {
        platform: 'linux',
        linkImpl: async (from: string, to: string) => {
          linkCalls += 1;
          if (linkCalls === 1) {
            const { link } = await import('node:fs/promises');
            await link(from, to);
            return;
          }
          throw Object.assign(new Error('hard-link operation failed'), { code: 'EIO' });
        },
        copyFileImpl: async () => {
          throw Object.assign(new Error('exclusive copy failed'), { code: 'EIO' });
        },
      }),
      (error: any) => {
        assert.equal(error?.code, NATIVE_FILE_RECOVERY_REQUIRED_CODE);
        assert.match(error?.message ?? '', /recovery copy was retained/);
        assert.equal(typeof error?.recoveryFile, 'string');
        recoveryFile = error.recoveryFile;
        return true;
      },
    );
    assert.equal(await statFs(target).catch((error) => error?.code), 'ENOENT');
    assert.match(recoveryFile, /report\.rauhwpx-recovery-.*\.hwp$/);
    assert.equal(await readFs(recoveryFile, 'utf8'), 'previous');
    assert.deepEqual(await readdir(directory), [basename(recoveryFile)]);
  });
});

test('content digest detects an edit even when the disk-generation token is unchanged', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'external');
    await assert.rejects(
      writeNativeFileAtomically(target, new Uint8Array([1, 2, 3]), {
        platform: 'linux',
        expectedFingerprint: TEST_NATIVE_FINGERPRINT,
        fingerprintImpl: async () => ({
          ...TEST_NATIVE_FINGERPRINT,
          digest: `sha256:${'1'.repeat(64)}`,
        }),
      }),
      { code: NATIVE_FILE_CONFLICT_CODE },
    );
    assert.equal(await readFs(target, 'utf8'), 'external');
    assert.deepEqual(await readdir(directory), ['report.hwp']);
  });
});

test('a Save As handle never overwrites a destination created after the picker returned', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'new-report.hwp');
    const external = minimalCfbBytes(4);
    const local = minimalCfbBytes(5);
    const registry = new NativeFileHandleRegistry();
    const picked = await registry.createSaveTarget('session-a', target);
    assert.equal(picked.ok, true);
    if (!picked.ok) return;
    const active = identity('document-a', 'blake3:a');
    const leases = new DocumentLeaseManager({ createId: () => 'save-as' });
    const reservation = leases.reserve(
      'session-a', active, registry.pathForSender('session-a', picked.descriptor.handleId),
    );
    assert.equal(reservation.ok, true);
    if (!reservation.ok) return;
    leases.commit('session-a', reservation.reservationId);

    await writeFs(target, external);
    await assert.rejects(
      registry.write('session-a', picked.descriptor.handleId, local, active, leases),
      { code: NATIVE_FILE_CONFLICT_CODE },
    );
    assert.deepEqual(new Uint8Array(await readFs(target)), external);
  });
});

test('successful native saves advance the disk fingerprint for the next save', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, minimalCfbBytes(1));
    const registry = new NativeFileHandleRegistry();
    const opened = await registry.create('session-a', target);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const active = identity('document-a', 'blake3:a');
    const leases = new DocumentLeaseManager({ createId: () => 'open' });
    const reservation = leases.reserve(
      'session-a', active, registry.pathForSender('session-a', opened.descriptor.handleId),
    );
    assert.equal(reservation.ok, true);
    if (!reservation.ok) return;
    leases.commit('session-a', reservation.reservationId);

    await registry.write(
      'session-a', opened.descriptor.handleId, minimalCfbBytes(6), active, leases,
    );
    await registry.write(
      'session-a', opened.descriptor.handleId, minimalCfbBytes(7), active, leases,
    );
    assert.deepEqual(new Uint8Array(await readFs(target)), minimalCfbBytes(7));
  });
});

test('POSIX atomic replacement preserves the destination mode bits', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    await chmod(target, 0o640);
    await writeNativeFileAtomically(target, new Uint8Array([4, 5, 6]), {
      platform: 'linux',
    });
    assert.equal((await statFs(target)).mode & 0o7777, 0o640);
  });
});

test('macOS replacement copies ACLs and extended attributes before writing the temp file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    const commands: Array<{ command: string; args: string[] }> = [];
    await writeNativeFileAtomically(target, new Uint8Array([8, 9]), {
      platform: 'darwin',
      runCommandImpl: async (command: string, args: string[]) => {
        commands.push({ command, args });
        await copyFile(args.at(-2)!, args.at(-1)!);
      },
    });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command, '/bin/cp');
    assert.deepEqual(commands[0].args.slice(0, 1), ['-p']);
    assert.equal(commands[0].args[1], target);
    assert.match(commands[0].args[2], /\.rauhwpx-.*\.tmp$/);
    assert.deepEqual(new Uint8Array(await readFs(target)), new Uint8Array([8, 9]));
  });
});

test('real macOS replacement preserves an ACL and extended attribute', {
  skip: process.platform !== 'darwin',
}, async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    execFileSync('/usr/bin/xattr', [
      '-w', 'com.rauhwpx.metadata-test', 'preserved', target,
    ]);
    execFileSync('/bin/chmod', ['+a', 'everyone deny execute', target]);

    await writeNativeFileAtomically(target, new Uint8Array([8, 9]), {
      platform: 'darwin',
    });

    assert.equal(
      execFileSync('/usr/bin/xattr', [
        '-p', 'com.rauhwpx.metadata-test', target,
      ], { encoding: 'utf8' }).trim(),
      'preserved',
    );
    assert.match(
      execFileSync('/bin/ls', ['-le', target], { encoding: 'utf8' }),
      /everyone deny execute/,
    );
  });
});

test('macOS metadata-copy failure leaves the destination and removes the temp file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    await assert.rejects(
      writeNativeFileAtomically(target, new Uint8Array([8, 9]), {
        platform: 'darwin',
        runCommandImpl: async () => { throw new Error('ACL copy failed'); },
      }),
      /ACL copy failed/,
    );
    assert.equal(await readFs(target, 'utf8'), 'previous');
    assert.deepEqual(await readdir(directory), ['report.hwp']);
  });
});

test('Windows replacement copies only the source DACL before compare and rename', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    const events: string[] = [];
    let commandCall: { command: string; args: string[]; options: { env: Record<string, string> } } | null = null;
    await writeNativeFileAtomically(target, new Uint8Array([7, 8]), {
      platform: 'win32',
      windowsSystemRoot: 'C:\\Windows',
      expectedFingerprint: TEST_NATIVE_FINGERPRINT,
      fingerprintImpl: async () => {
        events.push('fingerprint');
        return TEST_NATIVE_FINGERPRINT;
      },
      runCommandImpl: async (command: string, args: string[], options: { env: Record<string, string> }) => {
        events.push('dacl');
        commandCall = { command, args, options };
      },
      renameImpl: async (from: string, to: string) => {
        events.push('rename-aside');
        const { rename } = await import('node:fs/promises');
        await rename(from, to);
      },
      linkImpl: async (from: string, to: string) => {
        if (to === target) events.push('publish');
        const { link } = await import('node:fs/promises');
        await link(from, to);
      },
    });
    assert.deepEqual(events, ['dacl', 'rename-aside', 'fingerprint', 'publish']);
    assert.equal(
      commandCall?.command,
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    assert.equal(commandCall?.options.env.RAUHWPX_METADATA_SOURCE, target);
    assert.match(commandCall?.options.env.RAUHWPX_METADATA_TARGET ?? '', /\.rauhwpx-.*\.tmp$/);
    assert.deepEqual(Object.keys(commandCall?.options.env ?? {}).sort(), [
      'RAUHWPX_METADATA_SOURCE',
      'RAUHWPX_METADATA_TARGET',
      'SystemRoot',
      'WINDIR',
    ]);
    const encoded = commandCall?.args.at(-1) ?? '';
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.match(script, /AccessControlSections\]::Access/);
    assert.match(script, /Get-Acl -LiteralPath/);
    assert.match(script, /Set-Acl -LiteralPath/);
    assert.doesNotMatch(script, /AccessControlSections\]::(?:Owner|Audit|Group)/);
  });
});

test('Windows DACL-copy failure leaves the destination and removes the temp file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    await assert.rejects(
      writeNativeFileAtomically(target, new Uint8Array([7, 8]), {
        platform: 'win32',
        windowsSystemRoot: 'C:\\Windows',
        runCommandImpl: async () => { throw new Error('DACL copy failed'); },
      }),
      /DACL copy failed/,
    );
    assert.equal(await readFs(target, 'utf8'), 'previous');
    assert.deepEqual(await readdir(directory), ['report.hwp']);
  });
});

test('a hung Windows metadata command is tree-killed and awaited before rejection', async () => {
  class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: string | null = null;
    pid: number;

    constructor(pid: number) {
      super();
      this.pid = pid;
    }

    kill() {}
  }

  const metadata = new FakeChild(4242);
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnImpl = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (calls.length === 1) return metadata;
    const killer = new FakeChild(4343);
    setImmediate(() => {
      killer.exitCode = 0;
      killer.emit('exit', 0, null);
      metadata.exitCode = 1;
      metadata.emit('exit', 1, null);
    });
    return killer;
  };

  await assert.rejects(
    runNativeMetadataCommand(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-EncodedCommand', 'ignored'],
      {
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
        spawnImpl,
        timeoutMs: 1,
      },
    ),
    { code: 'NATIVE_FILE_METADATA_COPY_TIMEOUT' },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(calls[1].args, ['/PID', '4242', '/T', '/F']);
  assert.notEqual(metadata.exitCode, null, 'timeout rejection must wait for observed child exit');
});

test('atomic native replacement reports a real directory fsync failure after rename', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    const failure = Object.assign(new Error('storage I/O failed'), { code: 'EIO' });

    await assert.rejects(
      writeNativeFileAtomically(target, new Uint8Array([4, 5, 6]), {
        platform: 'linux',
        syncParentImpl: async () => { throw failure; },
      }),
      (error: NodeJS.ErrnoException) => error === failure && error.code === 'EIO',
    );
    assert.deepEqual(new Uint8Array(await readFs(target)), new Uint8Array([4, 5, 6]));
  });
});

test('Windows atomic replacement retries transient destination locks without deleting the old file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    let attempts = 0;
    await writeNativeFileAtomically(target, new Uint8Array([7, 8]), {
      platform: 'win32',
      windowsSystemRoot: 'C:\\Windows',
      runCommandImpl: async () => {},
      renameImpl: async (from: string, to: string) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
        const { rename } = await import('node:fs/promises');
        await rename(from, to);
      },
    });
    assert.equal(attempts, 2);
    assert.deepEqual(new Uint8Array(await readFs(target)), new Uint8Array([7, 8]));
  });
});

test('a second native save is rejected while the first retains its large buffer', async () => {
  const started: number[] = [];
  const finish: Array<() => void> = [];
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/canonical/report.hwp',
    fingerprintImpl: fakeNativeFingerprint,
    createId: () => 'writer',
    writeFileImpl: async (_path: string, bytes: Uint8Array) => new Promise<void>((resolve) => {
      started.push(bytes[34]);
      finish.push(resolve);
    }),
  });
  const opened = await registry.create('session-a', '/report.hwp');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const leases = new DocumentLeaseManager({ createId: () => 'open' });
  const active = identity('document-a', 'blake3:a');
  const reservation = leases.reserve(
    'session-a', active, registry.pathForSender('session-a', opened.descriptor.handleId),
  );
  assert.equal(reservation.ok, true);
  if (!reservation.ok) return;
  leases.commit('session-a', reservation.reservationId);

  const older = minimalCfbBytes();
  older[34] = 1;
  const newer = minimalCfbBytes();
  newer[34] = 2;
  const first = registry.write('session-a', opened.descriptor.handleId, older, active, leases);
  const second = registry.write('session-a', opened.descriptor.handleId, newer, active, leases);
  await assert.rejects(second, { code: NATIVE_FILE_WRITE_BUSY_CODE });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1]);
  finish.shift()?.();
  await first;

  const retry = registry.write('session-a', opened.descriptor.handleId, newer, active, leases);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2]);
  finish.shift()?.();
  await retry;
});

test('legacy bookmark pairs still reopen after the digest-aware dump format', async () => {
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/canonical/report.hwp',
    fingerprintImpl: fakeNativeFingerprint,
    createId: () => 'bookmarked',
  });
  registry.loadBookmarks([['document-a', '/canonical/report.hwp']]);
  const reopened = await registry.reopenDocument('session-b', 'document-a');
  assert.equal(reopened?.ok, true);
  if (!reopened?.ok) return;
  assert.deepEqual(registry.dumpBookmarks(), [[
    'document-a',
    { path: '/canonical/report.hwp', digest: null },
  ]]);
});

test('moved file in the same directory is offered as a nearby probe without exposing the path', async () => {
  await withTemporaryDirectory(async (directory) => {
    const original = join(directory, 'report.hwp');
    const moved = join(directory, 'renamed.hwp');
    const bytes = new Uint8Array([7, 8, 9, 10]);
    await writeFs(original, bytes);
    const registry = new NativeFileHandleRegistry();
    const created = await registry.create('session-a', original);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    registry.rememberDocument('document-a', 'session-a', created.descriptor.handleId);
    registry.releaseHandle('session-a', created.descriptor.handleId);
    await rmFs(original);
    await writeFs(moved, bytes);

    const probes = await registry.searchNearby('session-a', 'document-a', { basenameHint: 'report.hwp' });
    assert.equal(probes.length, 1);
    assert.equal(probes[0]?.fileName, 'renamed.hwp');
    assert.equal('path' in (probes[0] ?? {}), false);
    assert.equal(JSON.stringify(probes).includes(directory), false);
    assert.deepEqual(await registry.readProbe('session-a', probes[0]!.probeId), {
      name: 'renamed.hwp',
      bytes,
    });
    const claimed = await registry.claimProbe('session-a', probes[0]!.probeId);
    assert.equal(claimed?.ok, true);
    if (!claimed?.ok) return;
    assert.equal('path' in claimed.descriptor, false);
    assert.equal(JSON.stringify(claimed.descriptor).includes(directory), false);
    assert.equal(claimed.descriptor.name, 'renamed.hwp');
  });
});

test('nearby probes include same-basename files without claiming them', async () => {
  await withTemporaryDirectory(async (directory) => {
    const original = join(directory, 'original.hwp');
    const decoy = join(directory, 'report.hwp');
    const originalBytes = new Uint8Array([1, 2, 3]);
    const decoyBytes = new Uint8Array([4, 5, 6]);
    await writeFs(original, originalBytes);
    const registry = new NativeFileHandleRegistry();
    const created = await registry.create('session-a', original);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    registry.rememberDocument('document-a', 'session-a', created.descriptor.handleId);
    registry.releaseHandle('session-a', created.descriptor.handleId);
    await rmFs(original);
    await writeFs(decoy, decoyBytes);

    const probes = await registry.searchNearby('session-a', 'document-a', { basenameHint: 'report.hwp' });
    assert.equal(probes.length, 1);
    assert.equal(probes[0]?.fileName, 'report.hwp');
    assert.equal('path' in (probes[0] ?? {}), false);
    assert.equal(JSON.stringify(probes).includes(directory), false);
    const read = await registry.readProbe('session-a', probes[0]!.probeId);
    assert.deepEqual(read.bytes, decoyBytes);
  });
});

test('verifyPick accepts the bookmarked path and rejects a different file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const original = join(directory, 'report.hwp');
    const other = join(directory, 'other.hwp');
    const bytes = new Uint8Array([1, 2, 3]);
    await writeFs(original, bytes);
    await writeFs(other, bytes);
    const registry = new NativeFileHandleRegistry();
    const created = await registry.create('session-a', original);
    const extra = await registry.create('session-a', other);
    assert.equal(created.ok && extra.ok, true);
    if (!created.ok || !extra.ok) return;
    registry.rememberDocument('document-a', 'session-a', created.descriptor.handleId);
    assert.equal(
      await registry.verifyPick('session-a', 'document-a', created.descriptor.handleId),
      true,
    );
    assert.equal(
      await registry.verifyPick('session-a', 'document-a', extra.descriptor.handleId),
      false,
    );
  });
});

test('nearby probes skip files owned by another session', async () => {
  await withTemporaryDirectory(async (directory) => {
    const owned = join(directory, 'secret.hwp');
    const searchable = join(directory, 'report.hwp');
    await writeFs(owned, new Uint8Array([1, 2, 3]));
    await writeFs(searchable, new Uint8Array([4, 5, 6]));
    const registry = new NativeFileHandleRegistry();
    const owner = await registry.create('session-a', owned);
    const bookmark = await registry.create('session-b', searchable);
    assert.equal(owner.ok && bookmark.ok, true);
    if (!owner.ok || !bookmark.ok) return;
    registry.rememberDocument('document-b', 'session-b', bookmark.descriptor.handleId);
    registry.releaseHandle('session-b', bookmark.descriptor.handleId);

    const probes = await registry.searchNearby('session-b', 'document-b', {
      basenameHint: 'report.hwp',
    });
    assert.deepEqual(probes.map((probe) => probe.fileName), ['report.hwp']);
    const read = await registry.readProbe('session-b', probes[0]!.probeId);
    assert.deepEqual(read.bytes, new Uint8Array([4, 5, 6]));
  });
});

test('a later nearby search expires unclaimed probes from the same session', async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, 'report.hwp');
    await writeFs(filePath, new Uint8Array([1]));
    const registry = new NativeFileHandleRegistry();
    const created = await registry.create('session-a', filePath);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    registry.rememberDocument('document-a', 'session-a', created.descriptor.handleId);
    registry.releaseHandle('session-a', created.descriptor.handleId);

    const first = await registry.searchNearby('session-a', 'document-a', {
      basenameHint: 'report.hwp',
    });
    assert.equal(first.length, 1);
    const second = await registry.searchNearby('session-a', 'document-a', {
      basenameHint: 'report.hwp',
    });
    assert.equal(second.length, 1);
    await assert.rejects(
      registry.readProbe('session-a', first[0]!.probeId),
      /does not belong/,
    );
    assert.deepEqual(await registry.readProbe('session-a', second[0]!.probeId), {
      name: 'report.hwp',
      bytes: new Uint8Array([1]),
    });
  });
});

const VALID_DIGEST = `blake3:${'ab'.repeat(32)}`;

test('bookmark digest must be a 64-character blake3 hex string', async () => {
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/canonical/report.hwp',
    fingerprintImpl: fakeNativeFingerprint,
    createId: () => 'handle',
  });
  const created = await registry.create('session-a', '/canonical/report.hwp');
  assert.equal(created.ok, true);
  if (!created.ok) return;

  registry.rememberDocument('document-a', 'session-a', created.descriptor.handleId, 'blake3:not-hex');
  assert.deepEqual(registry.dumpBookmarks(), [[
    'document-a',
    { path: '/canonical/report.hwp', digest: null },
  ]]);

  registry.rememberDocument('document-a', 'session-a', created.descriptor.handleId, VALID_DIGEST);
  assert.deepEqual(registry.dumpBookmarks(), [[
    'document-a',
    { path: '/canonical/report.hwp', digest: VALID_DIGEST },
  ]]);

  registry.loadBookmarks([['document-a', { path: '/canonical/report.hwp', digest: 'blake3:nope' }]]);
  assert.deepEqual(registry.dumpBookmarks(), [[
    'document-a',
    { path: '/canonical/report.hwp', digest: null },
  ]]);

  registry.loadBookmarks([['document-a', { path: '/canonical/report.hwp', digest: VALID_DIGEST }]]);
  assert.deepEqual(registry.dumpBookmarks(), [[
    'document-a',
    { path: '/canonical/report.hwp', digest: VALID_DIGEST },
  ]]);
});

test('remembering a replaced handle without a digest does not revert the bookmark', async () => {
  await withTemporaryDirectory(async (directory) => {
    const original = join(directory, 'old.hwp');
    const savedAs = join(directory, 'new.hwp');
    await writeFs(original, new Uint8Array([1]));
    await writeFs(savedAs, new Uint8Array([2]));
    const registry = new NativeFileHandleRegistry();
    const previous = await registry.create('session-a', original);
    const next = await registry.create('session-a', savedAs);
    assert.equal(previous.ok && next.ok, true);
    if (!previous.ok || !next.ok) return;

    registry.rememberDocument('document-b', 'session-a', next.descriptor.handleId, VALID_DIGEST);
    registry.rememberDocument('document-a', 'session-a', previous.descriptor.handleId, VALID_DIGEST);
    registry.rememberDocument('document-a', 'session-a', next.descriptor.handleId, VALID_DIGEST);
    registry.rememberDocument('document-a', 'session-a', previous.descriptor.handleId);

    const bookmark = registry.dumpBookmarks();
    assert.equal(bookmark.length, 1, 'successful Save As transfers the destination path owner');
    assert.equal(bookmark[0]?.[0], 'document-a');
    assert.equal(bookmark[0]?.[1].path.endsWith('new.hwp'), true);
    assert.equal(bookmark[0]?.[1].digest, VALID_DIGEST);
  });
});

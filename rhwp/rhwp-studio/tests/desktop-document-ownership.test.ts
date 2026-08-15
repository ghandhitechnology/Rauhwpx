import test from 'node:test';
import assert from 'node:assert/strict';

import { DocumentLeaseManager } from '../../../desktop/document-leases.mjs';
import {
  bindNativeFileHandleIdentity,
  createNativeFileHandle,
} from '../src/desktop-integration.ts';
import {
  canonicalNativePath,
  NativeFileHandleRegistry,
  nativePathOwnershipKey,
  validateNativeDocumentPath,
} from '../../../desktop/native-file-handles.mjs';

function identity(documentId: string, sourceDigest: string) {
  return { documentId, sourceDigest };
}

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
    new Uint8Array([4, 5]),
    activeIdentity,
    leases,
  );
  assert.deepEqual(writes, [{ path: '/canonical/report.hwp', bytes: [4, 5] }]);
});

test('an in-flight atomic write pins its path until completion', async () => {
  let finishWrite: (() => void) | undefined;
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/Canonical/Report.HWP',
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
    'session-a', opened.descriptor.handleId, new Uint8Array([1]), active, leases,
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

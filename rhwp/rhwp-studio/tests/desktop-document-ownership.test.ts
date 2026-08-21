import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  open as openFs,
  readFile as readFs,
  readdir,
  rm as rmFs,
  writeFile as writeFs,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DocumentLeaseManager } from '../../../desktop/document-leases.mjs';
import {
  bindNativeFileHandleIdentity,
  createNativeFileHandle,
} from '../src/desktop-integration.ts';
import {
  canonicalNativePath,
  NativeFileHandleRegistry,
  nativePathOwnershipKey,
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
    minimalCfbBytes(4),
    activeIdentity,
    leases,
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/canonical/report.hwp');
  assert.deepEqual(writes[0].bytes, [...minimalCfbBytes(4)]);
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
  assert.equal('path' in reopened.descriptor, false);
  assert.deepEqual(await registry.read('session-a', reopened.descriptor.handleId), {
    name: 'report.hwp',
    bytes: new Uint8Array([1, 2, 3]),
  });
});

test('native bookmarks persist independently of live handles', async () => {
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/canonical/report.hwp',
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
  });
  assert.deepEqual(registry.dumpBookmarks(), [[
    'document-a',
    { path: '/canonical/report.hwp', digest: null },
  ]]);
});

test('native package validation accepts real fixtures and rejects truncation or format mismatch', async () => {
  const realHwp = new Uint8Array(await readFs(new URL('../../saved/blank2010.hwp', import.meta.url)));
  const realHwpx = new Uint8Array(await readFs(new URL('../../samples/hwpx/footnote-01.hwpx', import.meta.url)));
  assert.doesNotThrow(() => validateNativeDocumentBytes('/docs/report.hwp', realHwp));
  assert.doesNotThrow(() => validateNativeDocumentBytes('/docs/report.hwpx', realHwpx));

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
});

test('atomic native replacement preserves the destination on temp write and rename failures', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');

    const writeFailureOpen = async (path: string, flags: string) => {
      const file = await openFs(path, flags);
      return {
        writeFile: async () => { throw new Error('injected write failure'); },
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

test('atomic native replacement fsyncs and replaces a real destination', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    await writeNativeFileAtomically(target, new Uint8Array([4, 5, 6]));
    assert.deepEqual(new Uint8Array(await readFs(target)), new Uint8Array([4, 5, 6]));
    assert.deepEqual(await readdir(directory), ['report.hwp']);
  });
});

test('Windows atomic replacement retries transient destination locks without deleting the old file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFs(target, 'previous');
    let attempts = 0;
    await writeNativeFileAtomically(target, new Uint8Array([7, 8]), {
      platform: 'win32',
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

test('concurrent native saves are serialized in invocation order', async () => {
  const started: number[] = [];
  const finish: Array<() => void> = [];
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/canonical/report.hwp',
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1], 'the newer save must wait for the older save');
  finish.shift()?.();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2]);
  finish.shift()?.();
  await second;
});

test('legacy bookmark pairs still reopen after the digest-aware dump format', async () => {
  const registry = new NativeFileHandleRegistry({
    canonicalize: async () => '/canonical/report.hwp',
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

    registry.rememberDocument('document-a', 'session-a', previous.descriptor.handleId, VALID_DIGEST);
    registry.rememberDocument('document-a', 'session-a', next.descriptor.handleId, VALID_DIGEST);
    registry.rememberDocument('document-a', 'session-a', previous.descriptor.handleId);

    const bookmark = registry.dumpBookmarks();
    assert.equal(bookmark[0]?.[1].path.endsWith('new.hwp'), true);
    assert.equal(bookmark[0]?.[1].digest, VALID_DIGEST);
  });
});

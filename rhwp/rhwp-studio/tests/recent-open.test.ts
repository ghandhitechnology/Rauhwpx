import test from 'node:test';
import assert from 'node:assert/strict';

import { claimForRecentDoc } from '../src/project-file/claim.ts';
import { openProjectFile, type ProjectFileDeps } from '../src/project-file/open.ts';
import type { RecentDoc } from '../src/recent/recent-store.ts';
import type { FileSystemFileHandleLike } from '../src/command/file-system-access.ts';
import type { DocumentDigest } from '../src/project-file/identity.ts';

function makeEntry(overrides: Partial<RecentDoc> = {}): RecentDoc {
  return {
    id: 'r1',
    documentId: 'doc-1',
    sourceDigest: 'blake3:r1',
    fileName: '보고서.hwp',
    sourceFormat: 'hwp',
    openedAt: 1,
    handle: { kind: 'file', name: '보고서.hwp' } as unknown as FileSystemFileHandleLike,
    ...overrides,
  };
}

function digestOf(bytes: Uint8Array): DocumentDigest {
  return bytes[0] === 1 ? 'blake3:r1' : 'blake3:other';
}

function makeDeps(overrides: Partial<ProjectFileDeps> = {}) {
  const calls = {
    forgotten: [] as string[],
    toasts: [] as string[],
    loaded: [] as string[],
    documentIds: [] as string[],
    picks: 0,
  };
  const deps: ProjectFileDeps = {
    ensurePermission: async () => true,
    readHandle: async (file) => ({ bytes: new Uint8Array([1]), name: file.name }),
    digestOf,
    loadBound: async (_bytes, name, _handle, documentId) => {
      calls.loaded.push(name);
      calls.documentIds.push(documentId);
    },
    pickForProject: async () => {
      calls.picks += 1;
      return null;
    },
    forgetRecent: async (id) => {
      calls.forgotten.push(id);
    },
    toast: (msg) => {
      calls.toasts.push(msg);
    },
    ...overrides,
  };
  return { deps, calls };
}

async function openRecent(entry: RecentDoc, deps: ProjectFileDeps) {
  return openProjectFile(claimForRecentDoc(entry), deps);
}

test('권한 거부 시 항목을 유지하고 안내한다', async () => {
  const { deps, calls } = makeDeps({ ensurePermission: async () => false });
  const result = await openRecent(makeEntry(), deps);
  assert.equal(result.kind, 'permission-denied');
  assert.equal(calls.forgotten.length, 0);
  assert.equal(calls.loaded.length, 0);
  assert.match(calls.toasts[0] ?? '', /권한/);
});

test('권한 확인 자체가 실패해도 항목을 유지한다', async () => {
  const { deps, calls } = makeDeps({
    ensurePermission: async () => {
      throw new DOMException('SecurityError');
    },
  });
  const result = await openRecent(makeEntry(), deps);
  assert.equal(result.kind, 'permission-denied');
  assert.equal(calls.forgotten.length, 0);
});

test('파일 이동/삭제(read 실패) 시 항목을 제거하고 피커로 이어간다', async () => {
  const live = { kind: 'file', name: '보고서.hwp' } as unknown as FileSystemFileHandleLike;
  const { deps, calls } = makeDeps({
    readHandle: async (file) => {
      if (file === live) throw new DOMException('NotFoundError');
      return { bytes: new Uint8Array([1]), name: file.name };
    },
  });
  const result = await openRecent(makeEntry({ handle: live }), deps);
  assert.equal(result.kind, 'cancelled');
  assert.deepEqual(calls.forgotten, ['r1']);
  assert.equal(calls.loaded.length, 0);
  assert.equal(calls.picks, 1);
  assert.match(calls.toasts[0] ?? '', /찾을 수 없어/);
});

test('성공 시 라이브 파일 bytes와 핸들로 확인된 documentId를 넘긴다', async () => {
  const { deps, calls } = makeDeps();
  const result = await openRecent(makeEntry(), deps);
  assert.equal(result.kind, 'opened');
  assert.deepEqual(calls.loaded, ['보고서.hwp']);
  assert.deepEqual(calls.documentIds, ['doc-1']);
  assert.equal(calls.forgotten.length, 0);
  assert.equal(calls.picks, 0);
});

test('메타-only 항목(핸들 없음)은 겨냥한 피커를 연다', async () => {
  const { deps, calls } = makeDeps();
  const metaEntry: RecentDoc = {
    id: 'm1',
    documentId: 'doc-meta',
    sourceDigest: 'blake3:meta',
    fileName: '드롭.hwp',
    sourceFormat: 'hwp',
    openedAt: 1,
  };
  const result = await openRecent(metaEntry, deps);
  assert.equal(result.kind, 'cancelled');
  assert.equal(calls.picks, 1);
  assert.equal(calls.loaded.length, 0);
  assert.equal(calls.forgotten.length, 0);
});

test('핸들이 없어도 native 북마크로 복구되면 자동으로 연다', async () => {
  const restored = {
    kind: 'file',
    name: '보고서.hwp',
    identityKind: 'native-path',
  } as FileSystemFileHandleLike;
  const { deps, calls } = makeDeps({
    reopenRemembered: async (documentId) => {
      assert.equal(documentId, 'doc-1');
      return restored;
    },
  });
  const result = await openRecent(makeEntry({ handle: undefined }), deps);
  assert.equal(result.kind, 'opened');
  assert.deepEqual(calls.loaded, ['보고서.hwp']);
  assert.equal(calls.forgotten.length, 0);
  assert.equal(calls.picks, 0);
});

test('stale native 핸들은 북마크로 복구한 뒤 목록을 유지한다', async () => {
  let reads = 0;
  const stale = {
    kind: 'file',
    name: '보고서.hwp',
    identityKind: 'native-path',
  } as FileSystemFileHandleLike;
  const restored = {
    kind: 'file',
    name: '보고서.hwp',
    identityKind: 'native-path',
  } as FileSystemFileHandleLike;
  const { deps, calls } = makeDeps({
    readHandle: async (handle) => {
      reads += 1;
      if (handle === stale) throw new Error('Native file handle does not belong to this window');
      return { bytes: new Uint8Array([1]), name: '보고서.hwp' };
    },
    reopenRemembered: async () => restored,
  });
  const result = await openRecent(makeEntry({ handle: stale }), deps);
  assert.equal(result.kind, 'opened');
  assert.equal(reads, 2);
  assert.equal(calls.forgotten.length, 0);
  assert.deepEqual(calls.loaded, ['보고서.hwp']);
});

test('native 복구가 다른 창 소유면 항목을 유지한다', async () => {
  const { deps, calls } = makeDeps({
    reopenRemembered: async () => 'owned',
  });
  const result = await openRecent(makeEntry({ handle: undefined }), deps);
  assert.equal(result.kind, 'owned-elsewhere');
  assert.equal(calls.forgotten.length, 0);
  assert.equal(calls.loaded.length, 0);
  assert.match(calls.toasts[0] ?? '', /다른 창/);
});

test('stale native 핸들에 북마크가 없으면 목록을 유지하고 다시 고른다', async () => {
  const stale = {
    kind: 'file',
    name: '보고서.hwp',
    identityKind: 'native-path',
  } as FileSystemFileHandleLike;
  const { deps, calls } = makeDeps({
    readHandle: async () => {
      throw new Error('Native file handle does not belong to this window');
    },
    reopenRemembered: async () => null,
  });
  const result = await openRecent(makeEntry({ handle: stale }), deps);
  assert.equal(result.kind, 'cancelled');
  assert.equal(calls.forgotten.length, 0);
  assert.equal(calls.picks, 1);
  assert.equal(calls.loaded.length, 0);
});

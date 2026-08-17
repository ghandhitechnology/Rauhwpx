import test from 'node:test';
import assert from 'node:assert/strict';

import { openRecentEntry, type OpenRecentDeps } from '../src/recent/recent-open.ts';
import type { RecentDoc } from '../src/recent/recent-store.ts';
import type { FileSystemFileHandleLike } from '../src/command/file-system-access.ts';

/**
 * PR #2286 리뷰 회귀: 재열기 UX 규칙 고정.
 * - 권한 거부 → 항목 유지 + 안내 (제거하지 않음)
 * - 파일 이동/삭제(read 실패) → 항목 제거 + 안내
 * - 성공 → 라이브 파일 bytes 로 open 이벤트 (바이트 스냅샷 폴백 없음)
 */

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

function makeDeps(overrides: Partial<OpenRecentDeps> = {}) {
  const calls = { removed: [] as string[], toasts: [] as string[], opened: [] as string[], documentIds: [] as string[] };
  const deps: OpenRecentDeps = {
    ensurePermission: async () => true,
    readFile: async () => ({ bytes: new Uint8Array([1]), name: '보고서.hwp' }),
    remove: async (id) => {
      calls.removed.push(id);
    },
    toast: (msg) => {
      calls.toasts.push(msg);
    },
    emitOpen: (p) => {
      calls.opened.push(p.fileName);
      if (p.documentId) calls.documentIds.push(p.documentId);
    },
    ...overrides,
  };
  return { deps, calls };
}

test('권한 거부 시 항목을 유지하고 안내한다', async () => {
  const { deps, calls } = makeDeps({ ensurePermission: async () => false });
  const result = await openRecentEntry(makeEntry(), deps);
  assert.equal(result, 'permission-denied');
  assert.equal(calls.removed.length, 0, '권한 거부는 일시적일 수 있어 항목을 제거하면 안 된다');
  assert.equal(calls.opened.length, 0);
  assert.match(calls.toasts[0] ?? '', /권한/);
});

test('권한 확인 자체가 실패해도 항목을 유지한다', async () => {
  const { deps, calls } = makeDeps({
    ensurePermission: async () => {
      throw new DOMException('SecurityError');
    },
  });
  const result = await openRecentEntry(makeEntry(), deps);
  assert.equal(result, 'permission-denied');
  assert.equal(calls.removed.length, 0);
});

test('파일 이동/삭제(read 실패) 시 항목을 제거하고 안내한다', async () => {
  const { deps, calls } = makeDeps({
    readFile: async () => {
      throw new DOMException('NotFoundError');
    },
  });
  const result = await openRecentEntry(makeEntry(), deps);
  assert.equal(result, 'removed');
  assert.deepEqual(calls.removed, ['r1']);
  assert.equal(calls.opened.length, 0);
  assert.match(calls.toasts[0] ?? '', /찾을 수 없어/);
});

test('성공 시 라이브 파일 bytes와 핸들로 open 이벤트를 낸다', async () => {
  const { deps, calls } = makeDeps();
  const result = await openRecentEntry(makeEntry(), deps);
  assert.equal(result, 'opened');
  assert.deepEqual(calls.opened, ['보고서.hwp']);
  assert.deepEqual(calls.documentIds, ['doc-1']);
  assert.equal(calls.removed.length, 0);
  assert.equal(calls.toasts.length, 0);
});

test('메타-only 항목(핸들 없음)은 파일 재선택을 유도한다', async () => {
  let reopenCalled = 0;
  const { deps, calls } = makeDeps({ requestReopen: () => { reopenCalled++; } });
  const metaEntry: RecentDoc = {
    id: 'm1',
    documentId: 'doc-meta',
    sourceDigest: 'blake3:meta',
    fileName: '드롭.hwp',
    sourceFormat: 'hwp',
    openedAt: 1,
  };
  const result = await openRecentEntry(metaEntry, deps);
  assert.equal(result, 'needs-pick');
  assert.equal(reopenCalled, 1, '파일 재선택 대화상자를 연다');
  assert.equal(calls.opened.length, 0, '핸들이 없으므로 자동 open 이벤트는 없다');
  assert.equal(calls.removed.length, 0, '메타-only 항목은 제거하지 않는다');
  assert.match(calls.toasts[0] ?? '', /선택/);
  assert.doesNotMatch(calls.toasts[0] ?? '', /핸들/);
});

test('핸들이 없어도 native 북마크로 복구되면 자동으로 연다', async () => {
  const restored = { kind: 'file', name: '보고서.hwp', identityKind: 'native-path' } as FileSystemFileHandleLike;
  const { deps, calls } = makeDeps({
    restoreNativeDocument: async (documentId) => {
      assert.equal(documentId, 'doc-1');
      return restored;
    },
  });
  const result = await openRecentEntry(makeEntry({ handle: undefined }), deps);
  assert.equal(result, 'opened');
  assert.deepEqual(calls.opened, ['보고서.hwp']);
  assert.equal(calls.removed.length, 0);
  assert.equal(calls.toasts.length, 0);
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
    readFile: async (handle) => {
      reads += 1;
      if (handle === stale) throw new Error('Native file handle does not belong to this window');
      return { bytes: new Uint8Array([1]), name: '보고서.hwp' };
    },
    restoreNativeDocument: async () => restored,
  });
  const result = await openRecentEntry(makeEntry({ handle: stale }), deps);
  assert.equal(result, 'opened');
  assert.equal(reads, 2);
  assert.equal(calls.removed.length, 0);
  assert.deepEqual(calls.opened, ['보고서.hwp']);
});

test('native 복구가 다른 창 소유면 항목을 유지한다', async () => {
  const { deps, calls } = makeDeps({
    restoreNativeDocument: async () => 'owned',
  });
  const result = await openRecentEntry(makeEntry({ handle: undefined }), deps);
  assert.equal(result, 'permission-denied');
  assert.equal(calls.removed.length, 0);
  assert.equal(calls.opened.length, 0);
  assert.match(calls.toasts[0] ?? '', /다른 창/);
});

test('stale native 핸들에 북마크가 없으면 목록을 유지하고 다시 고른다', async () => {
  let reopenCalled = 0;
  const stale = {
    kind: 'file',
    name: '보고서.hwp',
    identityKind: 'native-path',
  } as FileSystemFileHandleLike;
  const { deps, calls } = makeDeps({
    readFile: async () => {
      throw new Error('Native file handle does not belong to this window');
    },
    restoreNativeDocument: async () => null,
    requestReopen: () => { reopenCalled += 1; },
  });
  const result = await openRecentEntry(makeEntry({ handle: stale }), deps);
  assert.equal(result, 'needs-pick');
  assert.equal(calls.removed.length, 0, '북마크 없는 stale native는 파일이 사라진 게 아닐 수 있다');
  assert.equal(reopenCalled, 1);
});

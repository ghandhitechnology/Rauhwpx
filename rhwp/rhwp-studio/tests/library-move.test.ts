import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canMoveToLibraryDocument,
  findLibraryRecentDoc,
  isSameLibraryDocument,
  moveToLibraryDocument,
  type LibraryMoveCurrent,
  type MoveToLibraryDocumentDeps,
} from '../src/library/move-to-document.ts';
import type { RecentDoc } from '../src/recent/recent-store.ts';
import type { FileSystemFileHandleLike } from '../src/command/file-system-access.ts';
import type { ProjectOpenOutcome } from '../src/project-file/open.ts';

function recent(partial: Partial<RecentDoc> & Pick<RecentDoc, 'id' | 'fileName'>): RecentDoc {
  return {
    documentId: partial.documentId ?? `doc-${partial.id}`,
    sourceDigest: partial.sourceDigest ?? `blake3:${partial.id}`,
    sourceFormat: partial.sourceFormat ?? 'hwp',
    openedAt: partial.openedAt ?? 1,
    ...partial,
  };
}

function current(partial: Partial<LibraryMoveCurrent> = {}): LibraryMoveCurrent {
  return {
    documentId: 'current-id',
    fileName: '현재.hwp',
    hasDocument: true,
    ...partial,
  };
}

function makeDeps(overrides: Partial<MoveToLibraryDocumentDeps> = {}) {
  const calls = {
    saved: 0,
    opened: [] as string[],
    picker: 0,
    toasts: [] as string[],
  };
  const recents = [
    recent({ id: 'r-target', documentId: 'target-id', fileName: '대상.hwp', handle: { name: '대상.hwp' } as FileSystemFileHandleLike }),
  ];
  const deps: MoveToLibraryDocumentDeps = {
    getCurrent: () => current(),
    saveCurrent: async () => {
      calls.saved += 1;
      return 'saved';
    },
    listRecent: async () => recents,
    openProjectFile: async (claim) => {
      calls.opened.push(claim.documentId);
      return { kind: 'opened' };
    },
    openViaPicker: async () => {
      calls.picker += 1;
    },
    toast: (message) => {
      calls.toasts.push(message);
    },
    ...overrides,
  };
  return { deps, calls, recents };
}

test('라이브러리 이동은 문서 ID 또는 파일명이 있어야 한다', () => {
  assert.equal(canMoveToLibraryDocument({ documentId: null, fileName: null }), false);
  assert.equal(canMoveToLibraryDocument({ documentId: 'a', fileName: null }), true);
  assert.equal(canMoveToLibraryDocument({ documentId: null, fileName: 'a.hwp' }), true);
});

test('같은 논리 문서로의 이동은 저장하지 않는다', async () => {
  const { deps, calls } = makeDeps();
  const result = await moveToLibraryDocument(
    { documentId: 'current-id', fileName: '다른이름.hwp' },
    deps,
  );
  assert.equal(result, 'same');
  assert.equal(calls.saved, 0);
  assert.equal(calls.opened.length, 0);
});

test('파일명만 있는 레거시 그룹은 현재 파일명과 같으면 같은 문서로 본다', () => {
  assert.equal(
    isSameLibraryDocument(
      current({ documentId: null, fileName: '보고서.hwp' }),
      { documentId: null, fileName: '보고서.hwp' },
    ),
    true,
  );
});

test('최근 문서는 documentId만으로 identity를 고른다', () => {
  const recents = [
    recent({ id: 'by-name', documentId: 'other', fileName: '대상.hwp' }),
    recent({ id: 'by-id', documentId: 'target-id', fileName: '이름변경.hwp' }),
  ];
  const found = findLibraryRecentDoc(recents, { documentId: 'target-id', fileName: '대상.hwp' });
  assert.equal(found?.id, 'by-id');
});

test('documentId가 목록에 없으면 파일명으로 identity를 고르지 않는다', () => {
  const recents = [
    recent({ id: 'by-name', documentId: 'other', fileName: '대상.hwp' }),
  ];
  const found = findLibraryRecentDoc(recents, { documentId: 'target-id', fileName: '대상.hwp' });
  assert.equal(found, undefined);
});

test('이동은 현재 문서를 저장한 뒤 대상 문서를 연다', async () => {
  const { deps, calls } = makeDeps();
  const result = await moveToLibraryDocument(
    { documentId: 'target-id', fileName: '대상.hwp' },
    deps,
  );
  assert.equal(result, 'moved');
  assert.equal(calls.saved, 1);
  assert.deepEqual(calls.opened, ['target-id']);
  assert.equal(calls.picker, 0);
});

test('첫 저장을 취소하면 대상을 열지 않는다', async () => {
  const { deps, calls } = makeDeps({
    saveCurrent: async () => 'cancelled',
  });
  const result = await moveToLibraryDocument(
    { documentId: 'target-id', fileName: '대상.hwp' },
    deps,
  );
  assert.equal(result, 'cancelled');
  assert.equal(calls.opened.length, 0);
  assert.equal(calls.picker, 0);
});

test('저장 실패 시 이동하지 않고 안내한다', async () => {
  const { deps, calls } = makeDeps({
    saveCurrent: async () => 'failed',
  });
  const result = await moveToLibraryDocument(
    { documentId: 'target-id', fileName: '대상.hwp' },
    deps,
  );
  assert.equal(result, 'failed');
  assert.equal(calls.opened.length, 0);
  assert.match(calls.toasts[0] ?? '', /저장하지 못해/);
});

test('빈 뷰어에서는 저장 없이 대상만 연다', async () => {
  const { deps, calls } = makeDeps({
    getCurrent: () => current({ hasDocument: false, documentId: null, fileName: null }),
  });
  const result = await moveToLibraryDocument(
    { documentId: 'target-id', fileName: '대상.hwp' },
    deps,
  );
  assert.equal(result, 'moved');
  assert.equal(calls.saved, 0);
  assert.deepEqual(calls.opened, ['target-id']);
});

test('최근 목록에 없어도 documentId로 재열기를 시도한다', async () => {
  const { deps, calls } = makeDeps({
    listRecent: async () => [],
  });
  const result = await moveToLibraryDocument(
    { documentId: 'missing-id', fileName: '없는파일.hwp' },
    deps,
  );
  assert.equal(result, 'moved');
  assert.equal(calls.saved, 1);
  assert.deepEqual(calls.opened, ['missing-id']);
  assert.equal(calls.picker, 0);
});

test('레거시 파일명 그룹은 열기 대화상자로 넘긴다', async () => {
  const { deps, calls } = makeDeps({
    listRecent: async () => [],
  });
  const result = await moveToLibraryDocument(
    { documentId: null, fileName: '없는파일.hwp' },
    deps,
  );
  assert.equal(result, 'moved');
  assert.equal(calls.opened.length, 0);
  assert.equal(calls.picker, 1);
  assert.match(calls.toasts[0] ?? '', /없는파일/);
});

test('확인되지 않은 대상은 이동 성공으로 치지 않는다', async () => {
  const { deps, calls } = makeDeps({
    openProjectFile: async () => ({ kind: 'not-found' } satisfies ProjectOpenOutcome),
  });
  const result = await moveToLibraryDocument(
    { documentId: 'target-id', fileName: '대상.hwp' },
    deps,
  );
  assert.equal(result, 'failed');
  assert.equal(calls.picker, 0);
});

test('대상 열기를 취소하면 이동도 취소된다', async () => {
  const { deps, calls } = makeDeps({
    openProjectFile: async () => ({ kind: 'cancelled' }),
  });
  const result = await moveToLibraryDocument(
    { documentId: 'target-id', fileName: '대상.hwp' },
    deps,
  );
  assert.equal(result, 'cancelled');
  assert.equal(calls.picker, 0);
});

test('권한 거부는 이동 실패로 남기고 피커를 열지 않는다', async () => {
  const { deps, calls } = makeDeps({
    openProjectFile: async () => ({ kind: 'permission-denied' }),
  });
  const result = await moveToLibraryDocument(
    { documentId: 'target-id', fileName: '대상.hwp' },
    deps,
  );
  assert.equal(result, 'failed');
  assert.equal(calls.picker, 0);
});

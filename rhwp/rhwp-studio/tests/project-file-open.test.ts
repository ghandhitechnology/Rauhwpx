import test from 'node:test';
import assert from 'node:assert/strict';

import type { FileSystemFileHandleLike } from '../src/command/file-system-access.ts';
import type { RecentDoc } from '../src/recent/recent-store.ts';
import { claimForExplorerGroup, claimForRecentDoc } from '../src/project-file/claim.ts';
import type { DocumentDigest, ProjectFileClaim } from '../src/project-file/identity.ts';
import {
  openProjectFile,
  type NativeProbe,
  type ProjectFileDeps,
} from '../src/project-file/open.ts';

const MATCH = 'blake3:match' as const satisfies DocumentDigest;
const OTHER = 'blake3:other' as const satisfies DocumentDigest;

function handle(
  name: string,
  options: { identityKind?: 'native-path'; same?: boolean } = {},
): FileSystemFileHandleLike {
  return {
    kind: 'file',
    name,
    ...(options.identityKind ? { identityKind: options.identityKind } : {}),
    isSameEntry: async () => options.same === true,
  } as FileSystemFileHandleLike;
}

function claim(overrides: Partial<ProjectFileClaim> = {}): ProjectFileClaim {
  return {
    documentId: 'doc-1',
    displayName: '보고서.hwp',
    knownDigest: MATCH,
    liveHandle: null,
    recentId: 'r1',
    ...overrides,
  };
}

function recent(overrides: Partial<RecentDoc> = {}): RecentDoc {
  return {
    id: 'r1',
    documentId: 'doc-1',
    sourceDigest: MATCH,
    fileName: '보고서.hwp',
    sourceFormat: 'hwp',
    openedAt: 1,
    ...overrides,
  };
}

function digestOf(bytes: Uint8Array): DocumentDigest {
  return bytes[0] === 1 ? MATCH : OTHER;
}

function makeDeps(overrides: Partial<ProjectFileDeps> = {}) {
  const calls = {
    picks: 0,
    searches: 0,
    claimedProbes: [] as string[],
    forgotten: [] as string[],
    loaded: [] as { name: string; documentId: string }[],
    toasts: [] as string[],
  };
  const deps: ProjectFileDeps = {
    ensurePermission: async () => true,
    readHandle: async (file) => ({
      bytes: new Uint8Array([1]),
      name: file.name,
    }),
    digestOf,
    loadBound: async (_bytes, name, _handle, documentId) => {
      calls.loaded.push({ name, documentId });
    },
    pickForProject: async () => {
      calls.picks += 1;
      return null;
    },
    forgetRecent: async (id) => {
      calls.forgotten.push(id);
    },
    toast: (message) => {
      calls.toasts.push(message);
    },
    ...overrides,
  };
  return { deps, calls };
}

test('documentId가 없는 탐색기 그룹은 claim이 없다', () => {
  assert.equal(
    claimForExplorerGroup(
      { documentId: null, displayName: '보고서.hwp' },
      [recent({ fileName: '보고서.hwp' })],
    ),
    null,
  );
});

test('탐색기 claim은 파일명이 같아도 다른 documentId 행을 쓰지 않는다', () => {
  const made = claimForExplorerGroup(
    { documentId: 'doc-1', displayName: '보고서.hwp' },
    [
      recent({
        id: 'other',
        documentId: 'doc-other',
        sourceDigest: OTHER,
        fileName: '보고서.hwp',
        handle: handle('보고서.hwp'),
      }),
      recent({ id: 'mine', documentId: 'doc-1', fileName: '이름변경.hwp' }),
    ],
  );
  assert.equal(made?.documentId, 'doc-1');
  assert.equal(made?.recentId, 'mine');
  assert.equal(made?.knownDigest, MATCH);
  assert.equal(made?.liveHandle, null);
});

test('최근 문서 행은 그대로 claim이 된다', () => {
  const live = handle('보고서.hwp');
  const made = claimForRecentDoc(recent({ handle: live }));
  assert.equal(made.documentId, 'doc-1');
  assert.equal(made.liveHandle, live);
  assert.equal(made.recentId, 'r1');
  assert.equal(made.knownDigest, MATCH);
});

test('라이브 핸들이 있으면 탐색과 피커를 건너뛴다', async () => {
  const live = handle('보고서.hwp');
  let searched = 0;
  const { deps, calls } = makeDeps({
    searchNearby: async () => {
      searched += 1;
      return [];
    },
  });
  const result = await openProjectFile(claim({ liveHandle: live }), deps);
  assert.equal(result.kind, 'opened');
  assert.deepEqual(calls.loaded, [{ name: '보고서.hwp', documentId: 'doc-1' }]);
  assert.equal(calls.picks, 0);
  assert.equal(searched, 0);
});

test('권한 거부는 최근 행을 유지하고 열지 않는다', async () => {
  const { deps, calls } = makeDeps({ ensurePermission: async () => false });
  const result = await openProjectFile(claim({ liveHandle: handle('보고서.hwp') }), deps);
  assert.equal(result.kind, 'permission-denied');
  assert.equal(calls.forgotten.length, 0);
  assert.equal(calls.loaded.length, 0);
  assert.equal(calls.picks, 0);
  assert.match(calls.toasts[0] ?? '', /권한/);
});

test('브라우저 라이브 핸들을 못 읽으면 행을 지우고 사다리를 이어간다', async () => {
  const live = handle('보고서.hwp');
  const { deps, calls } = makeDeps({
    readHandle: async (file) => {
      if (file === live) throw new DOMException('NotFoundError');
      return { bytes: new Uint8Array([1]), name: file.name };
    },
    pickForProject: async () => {
      calls.picks += 1;
      return null;
    },
  });
  const result = await openProjectFile(claim({ liveHandle: live }), deps);
  assert.equal(result.kind, 'cancelled');
  assert.deepEqual(calls.forgotten, ['r1']);
  assert.equal(calls.loaded.length, 0);
  assert.equal(calls.picks, 1);
});

test('탐색이 피커보다 먼저 돌고 확인되면 피커를 열지 않는다', async () => {
  const probe: NativeProbe = { probeId: 'p1', fileName: '보고서.hwp' };
  const found = handle('보고서.hwp');
  const { deps, calls } = makeDeps({
    searchNearby: async () => {
      calls.searches += 1;
      assert.equal(calls.picks, 0);
      return [probe];
    },
    readProbe: async (probeId) => {
      assert.equal(probeId, 'p1');
      return { bytes: new Uint8Array([1]), fileName: '보고서.hwp' };
    },
    claimProbe: async (probeId) => {
      calls.claimedProbes.push(probeId);
      return found;
    },
  });
  const result = await openProjectFile(claim(), deps);
  assert.equal(result.kind, 'opened');
  assert.equal(calls.searches, 1);
  assert.equal(calls.picks, 0);
  assert.deepEqual(calls.claimedProbes, ['p1']);
  assert.deepEqual(calls.loaded, [{ name: '보고서.hwp', documentId: 'doc-1' }]);
});

test('digest가 다른 탐색 후보는 소유권을 주장하지 않는다', async () => {
  const { deps, calls } = makeDeps({
    searchNearby: async () => [{ probeId: 'p-wrong', fileName: '보고서.hwp' }],
    readProbe: async () => ({ bytes: new Uint8Array([9]), fileName: '보고서.hwp' }),
    claimProbe: async (probeId) => {
      calls.claimedProbes.push(probeId);
      return handle('보고서.hwp');
    },
    pickForProject: async () => {
      calls.picks += 1;
      return null;
    },
  });
  const result = await openProjectFile(claim(), deps);
  assert.equal(result.kind, 'cancelled');
  assert.deepEqual(calls.claimedProbes, []);
  assert.equal(calls.loaded.length, 0);
  assert.equal(calls.picks, 1);
});

test('잘못 고른 파일은 loadBound 하지 않는다', async () => {
  const picked = handle('다른파일.hwp', { same: false });
  const { deps, calls } = makeDeps({
    pickForProject: async () => {
      calls.picks += 1;
      return picked;
    },
    readHandle: async () => ({ bytes: new Uint8Array([9]), name: picked.name }),
  });
  const result = await openProjectFile(claim(), deps);
  assert.equal(result.kind, 'not-this-file');
  assert.equal(calls.loaded.length, 0);
  assert.equal(calls.picks, 1);
  assert.match(calls.toasts.join('\n'), /내용이 이 프로젝트 문서와 달라/);
});

test('digest를 모르는 선택은 재시도 없이 안내하고 열지 않는다', async () => {
  const picked = handle('비슷한이름.hwp');
  const { deps, calls } = makeDeps({
    pickForProject: async () => {
      calls.picks += 1;
      return picked;
    },
  });
  const result = await openProjectFile(claim({ knownDigest: null }), deps);
  assert.equal(result.kind, 'not-this-file');
  assert.equal(calls.picks, 1);
  assert.equal(calls.loaded.length, 0);
  assert.match(calls.toasts.join('\n'), /확인할 수 없어/);
});

test('digest가 같은 선택은 원래 documentId로 연다', async () => {
  const picked = handle('보고서.hwp');
  const { deps, calls } = makeDeps({
    pickForProject: async () => {
      calls.picks += 1;
      return picked;
    },
  });
  const result = await openProjectFile(claim(), deps);
  assert.equal(result.kind, 'opened');
  assert.deepEqual(calls.loaded, [{ name: '보고서.hwp', documentId: 'doc-1' }]);
});

test('피커를 취소하면 아무것도 열지 않는다', async () => {
  const { deps, calls } = makeDeps();
  const result = await openProjectFile(claim(), deps);
  assert.equal(result.kind, 'cancelled');
  assert.equal(calls.loaded.length, 0);
  assert.equal(calls.picks, 1);
});

test('거절된 선택은 피커를 한 번 더 열고 두 번째도 아니면 열지 않는다', async () => {
  const live = handle('원본.hwp');
  const first = handle('다른파일.hwp');
  const second = handle('또다른파일.hwp');
  first.isSameEntry = async () => false;
  second.isSameEntry = async () => false;
  const queue = [first, second];
  const { deps, calls } = makeDeps({
    readHandle: async (file) => {
      if (file === live) throw new DOMException('NotFoundError');
      return { bytes: new Uint8Array([9]), name: file.name };
    },
    pickForProject: async () => {
      calls.picks += 1;
      return queue.shift() ?? null;
    },
  });
  const result = await openProjectFile(claim({ liveHandle: live }), deps);
  assert.equal(result.kind, 'not-this-file');
  assert.equal(calls.picks, 2);
  assert.equal(calls.loaded.length, 0);
  assert.match(calls.toasts.join('\n'), /이 프로젝트 문서가 아닙니다/);
});

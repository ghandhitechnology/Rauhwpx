import type {
  VersionCommitView,
  VersionManagerController,
  VersionManagerState,
} from '../ui/agent-sidebar/version-manager.ts';
import { timestamp } from './fixtures.ts';

export function createMockVersions(
  report: (message: string) => void,
): VersionManagerController {
  const listeners = new Set<(state: VersionManagerState) => void>();
  const commit = (
    id: string,
    title: string,
    parentIds: string[],
    isHead: boolean,
  ): VersionCommitView => ({
    id,
    shortId: id.slice(0, 7),
    title,
    createdAt: Date.parse(timestamp),
    reason: 'manual',
    parentIds,
    branchLabels: isHead ? ['main'] : [],
    tagLabels: [],
    lane: 0,
    laneCount: 1,
    startsLane: false,
    lanesBefore: [],
    lanesAfter: [],
    activeLanesBefore: [],
    parentLanes: [0],
    isHead,
    byteLength: 24000,
  });
  const state: VersionManagerState = {
    documentId: 'preview-proposal',
    documentName: '사업 제안서.hwpx',
    saved: true,
    enabled: true,
    dirty: true,
    mutationBlockedReason: null,
    activeBranch: 'main',
    commits: [
      commit(
        'c3a1b2c',
        '추진 일정과 기대 효과를 정리했습니다.',
        ['b2a1b2c'],
        true,
      ),
      commit('b2a1b2c', '사업 개요를 작성했습니다.', ['a1a1b2c'], false),
      commit('a1a1b2c', '새 문서를 만들었습니다.', [], false),
    ],
    branches: [
      {
        name: 'main',
        headId: 'c3a1b2c',
        isActive: true,
        isDefault: true,
        updatedAt: Date.parse(timestamp),
      },
      {
        name: '대안',
        headId: 'b2a1b2c',
        isActive: false,
        isDefault: false,
        updatedAt: Date.parse(timestamp),
      },
    ],
    shelves: [
      {
        id: 'shelf-sample',
        title: '검토 전 초안',
        createdAt: Date.parse(timestamp),
        baseCommitId: 'b2a1b2c',
        byteLength: 20000,
      },
    ],
    mergeDrafts: [],
    legacy: [],
    hasMoreCommits: false,
    loading: false,
    storageBytes: 92000,
    storageQuotaBytes: 100000000,
    aiTitlesEnabled: true,
  };
  function changed() {
    for (const item of state.commits) {
      item.branchLabels = state.branches
        .filter((branch) => branch.headId === item.id)
        .map((branch) => branch.name);
      item.isHead =
        state.branches.find((branch) => branch.isActive)?.headId === item.id;
    }
    listeners.forEach((listener) => listener(state));
  }
  function checkpoint(title = '문서 변경 사항을 저장했습니다.') {
    const active = state.branches.find((branch) => branch.isActive)!;
    const next = commit(crypto.randomUUID(), title, [active.headId], true);
    next.createdAt = Date.now();
    state.commits.unshift(next);
    active.headId = next.id;
    state.dirty = false;
    changed();
  }
  function switchBranch(name: string) {
    state.activeBranch = name;
    state.branches.forEach((branch) => {
      branch.isActive = branch.name === name;
    });
    changed();
  }
  return {
    getState: () => state,
    refresh: async () => changed(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enable: async () => {
      state.enabled = true;
      changed();
    },
    checkpoint: async (title) => checkpoint(title),
    loadMore: async () => {
      state.hasMoreCommits = false;
      changed();
    },
    restore: async (id) => {
      state.branches.find((branch) => branch.isActive)!.headId = id;
      state.dirty = false;
      changed();
      report('Sample document restored');
    },
    adopt: async (id) => {
      checkpoint(
        `채택: ${state.commits.find((item) => item.id === id)?.title}`,
      );
    },
    compare: async (id) =>
      report(
        `Document comparison placeholder: ${state.commits.find((item) => item.id === id)?.title}`,
      ),
    amendTitle: async (id, title) => {
      state.commits.find((item) => item.id === id)!.title = title;
      changed();
    },
    createBranch: async (name, from) => {
      if (state.branches.some((branch) => branch.name === name))
        throw new Error('이미 존재하는 가지입니다.');
      state.branches.push({
        name,
        headId:
          from ?? state.branches.find((branch) => branch.isActive)!.headId,
        isActive: false,
        isDefault: false,
        updatedAt: Date.now(),
      });
      changed();
    },
    switchBranch: async (name) => switchBranch(name),
    renameBranch: async (name, nextName) => {
      if (state.branches.some((branch) => branch.name === nextName))
        throw new Error('이미 존재하는 가지입니다.');
      state.branches.find((branch) => branch.name === name)!.name = nextName;
      if (state.activeBranch === name) state.activeBranch = nextName;
      changed();
    },
    deleteBranch: async (name) => {
      state.branches = state.branches.filter((branch) => branch.name !== name);
      changed();
    },
    startMerge: async (sourceBranch) => {
      state.mergeDrafts.push({
        id: crypto.randomUUID(),
        sourceBranch,
        targetBranch: state.activeBranch!,
        conflictCount: 2,
        resolvedCount: 0,
        updatedAt: Date.now(),
      });
      changed();
      report('Sample merge created; document conflict editor is a placeholder');
    },
    resumeMerge: async (id) => {
      const draft = state.mergeDrafts.find((item) => item.id === id)!;
      checkpoint(`${draft.sourceBranch} 가지를 병합했습니다.`);
      state.mergeDrafts = state.mergeDrafts.filter((item) => item.id !== id);
      changed();
    },
    discardMergeDraft: async (id) => {
      state.mergeDrafts = state.mergeDrafts.filter((item) => item.id !== id);
      changed();
    },
    createTag: async (name, id) => {
      state.commits.find((item) => item.id === id)!.tagLabels.push(name);
      changed();
    },
    createShelf: async (title = '작업 중인 변경 사항') => {
      state.shelves.unshift({
        id: crypto.randomUUID(),
        title,
        createdAt: Date.now(),
        baseCommitId: state.branches.find((branch) => branch.isActive)!.headId,
        byteLength: 20000,
      });
      state.dirty = false;
      changed();
    },
    applyShelf: async (id, remove) => {
      state.dirty = true;
      if (remove)
        state.shelves = state.shelves.filter((item) => item.id !== id);
      changed();
    },
    deleteShelf: async (id) => {
      state.shelves = state.shelves.filter((item) => item.id !== id);
      changed();
    },
    compareLegacy: async () => report('Legacy document comparison placeholder'),
    setAiTitlesEnabled: (enabled) => {
      state.aiTitlesEnabled = enabled;
      changed();
    },
    collectGarbage: async () => {
      state.storageBytes = state.commits.reduce(
        (sum, item) => sum + item.byteLength,
        0,
      );
      changed();
      report('Sample history storage cleaned');
    },
    dispose: () => listeners.clear(),
  };
}

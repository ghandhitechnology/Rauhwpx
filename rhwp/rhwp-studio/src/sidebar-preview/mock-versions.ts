import type {
  VersionCommitView,
  VersionManagerController,
  VersionManagerState,
} from '../ui/agent-sidebar/version-manager.ts';
import { layoutCommitGraph, orderBranchHeadFrontier, type GraphCommit } from '../versioning/graph-layout.ts';
import { commitId } from '../versioning/types.ts';
import { timestamp } from './fixtures.ts';

export function createMockVersions(
  report: (message: string) => void,
  branchedHistory = false,
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
  if (branchedHistory) {
    state.commits = [
      commit('e8f21a0', '표지의 타이포그래피와 여백 조정', ['d7e10b2'], false),
      commit('f9a32b1', '검토 의견을 반영한 최종 제안서', ['c6d09a1', 'b5c98f0'], true),
      commit('d7e10b2', '새로운 표지 레이아웃 시도', ['c6d09a1'], false),
      commit('c6d09a1', '추진 일정과 마일스톤 정리', ['a4b87e9'], false),
      commit('b5c98f0', '예산 항목과 산출 근거 보완', ['a4b87e9'], false),
      commit('a4b87e9', '사업 목표와 기대 효과 구체화', ['93a76d8'], false),
      commit('93a76d8', '주요 지표를 표로 정리', ['82b65c7'], false),
      commit('82b65c7', '시장 분석과 참고 자료 추가', ['71c54b6'], false),
      commit('71c54b6', '문서 구조와 목차 정리', ['60d43a5'], false),
      commit('60d43a5', '사업 개요 초안 작성', ['50e32a4'], false),
      commit('50e32a4', '새 문서 만들기', [], false),
    ];
    state.commits.forEach((item, index) => { item.createdAt = Date.now() - index * 28 * 60_000; });
    state.commits[1].reason = 'merge';
    state.commits[1].tagLabels = ['검토완료'];
    state.branches = [
      { name: 'main', headId: 'f9a32b1', isActive: false, isDefault: true, updatedAt: Date.now() },
      { name: '표지-디자인', headId: 'e8f21a0', isActive: true, isDefault: false, updatedAt: Date.now() },
      { name: '예산-검토', headId: 'b5c98f0', isActive: false, isDefault: false, updatedAt: Date.now() },
    ];
    state.activeBranch = '표지-디자인';
  }
  function changed() {
    const frontier = orderBranchHeadFrontier(
      state.branches.map((branch) => ({ name: branch.name, target: commitId(branch.headId) })),
      state.branches.find((branch) => branch.isDefault)?.name ?? null,
      null,
    );
    const rows = layoutCommitGraph(state.commits.map((item, index): GraphCommit => {
      const parents = item.parentIds.map(commitId);
      if (parents.length > 2) throw new Error('A preview commit can have at most two parents.');
      return {
        id: commitId(item.id),
        parents: parents.length === 2 ? [parents[0], parents[1]] : parents.length === 1 ? [parents[0]] : [],
        ordinal: state.commits.length - index,
      };
    }), [], frontier);
    const byId = new Map(rows.map((row) => [row.commitId, row]));
    for (const item of state.commits) {
      const row = byId.get(commitId(item.id))!;
      Object.assign(item, {
        lane: row.lane, laneCount: row.laneCount, startsLane: row.startsLane,
        lanesBefore: [...row.lanesBefore], lanesAfter: [...row.lanesAfter],
        activeLanesBefore: [...row.activeLanesBefore], parentLanes: row.edges.map((edge) => edge.toLane),
      });
    }

    for (const item of state.commits) {
      item.branchLabels = state.branches
        .filter((branch) => branch.headId === item.id)
        .map((branch) => branch.name);
      item.isHead =
        state.branches.find((branch) => branch.isActive)?.headId === item.id;
    }
    listeners.forEach((listener) => listener(state));
  }
  function checkpoint(title = '문서 변경 사항을 저장했습니다.', additionalParents: string[] = []) {
    const active = state.branches.find((branch) => branch.isActive)!;
    const next = commit(crypto.randomUUID(), title, [active.headId, ...additionalParents], true);
    next.createdAt = Date.now();
    state.commits.unshift(next);
    active.headId = next.id;
    active.updatedAt = next.createdAt;
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
  changed();
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
      switchBranch(name);
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
      checkpoint(`${draft.sourceBranch} 가지를 병합했습니다.`, [state.branches.find((branch) => branch.name === draft.sourceBranch)!.headId]);
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
    dispose: () => listeners.clear(),
  };
}

import type {
  VersionCommitView,
  VersionManagerController,
  VersionManagerState,
} from '../ui/agent-sidebar/version-manager.ts';
import { layoutCommitGraph, orderBranchHeadFrontier, type GraphCommit } from '../versioning/graph-layout.ts';
import { commitId } from '../versioning/types.ts';
import type { DiffItem, DiffKind, DiffSeverity } from '../compare/types.ts';
import { timestamp } from './fixtures.ts';

function sampleDiff(
  id: string,
  kind: DiffKind,
  severity: DiffSeverity,
  title: string,
  leftPreview: string,
  rightPreview: string,
  paragraph: number,
): DiffItem {
  return {
    id, kind, severity, title, leftPreview, rightPreview,
    path: { section: 0, paragraph },
    leftSectionPage: 1,
    rightSectionPage: 1,
  };
}

const longProposal = [
  '지역 소상공인이 예약과 재고를 한 화면에서 관리할 수 있도록 주문 흐름을 정리합니다.',
  '첫 달에는 참여 매장 다섯 곳의 접수 방식을 조사하고, 직원이 수기로 옮겨 적는 항목을 확인합니다.',
  '다음 달에는 예약 변경 알림과 재고 부족 표시를 시범 적용합니다.',
  '매장별 처리 시간을 매주 기록해 중복 입력이 줄었는지 살펴보고, 사용하지 않는 입력란은 제거합니다.',
  '시범 운영이 끝나면 참여 매장의 의견을 모아 교육 자료와 도움말을 고칩니다.',
  '운영팀은 문의가 몰리는 시간대를 확인해 대응 인력을 배치하고, 서비스 장애가 나면 종이 접수표로 업무를 이어갈 수 있게 합니다.',
].join(' ');

/** The working copy covers text edits and document objects in one review. */
export const workingDiffFixture: DiffItem[] = [
  sampleDiff('working-replace', 'text', 'modified', '사업 목표 수정',
    '이번 사업은 업무 효율을 높이는 것을 목표로 합니다.',
    '이번 사업은 지역 소상공인의 주문과 예약 업무를 줄이는 것을 목표로 합니다.', 0),
  sampleDiff('working-insert', 'text', 'added', '실행 계획 추가', '', longProposal, 2),
  sampleDiff('working-delete', 'text', 'removed', '이전 일정 삭제',
    '시범 운영은 3월 첫째 주에 시작합니다.', '', 4),
  sampleDiff('working-table', 'table', 'modified', '예산표 수정',
    '홍보비 200만 원 · 교육비 100만 원', '홍보비 150만 원 · 교육비 150만 원', 6),
  sampleDiff('working-image', 'image', 'added', '서비스 흐름도 추가', '',
    '주문 접수부터 정산까지 이어지는 흐름도', 8),
];

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
  let workingDiffs = [...workingDiffFixture];
  const committedDiffs = new Map<string, DiffItem[]>(state.commits.map((item, index) => [
    item.id,
    index === state.commits.length - 1
      ? [sampleDiff(`${item.id}-initial`, 'text', 'added', '문서 작성', '', '사업 제안서 초안', 0)]
      : [
          sampleDiff(`${item.id}-text`, 'text', 'modified', '본문 수정',
            '검토 전 문장입니다.', `${item.title} 변경 내용을 반영했습니다.`, index),
          sampleDiff(`${item.id}-table`, 'table', 'modified', '일정표 수정',
            '1단계 · 2주', '1단계 · 3주', index + 1),
        ],
  ]));
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
    committedDiffs.set(next.id, [...workingDiffs]);
    workingDiffs = [];
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
      workingDiffs = [];
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
    diffWorkingTree: async () => state.dirty ? structuredClone(workingDiffs) : [],
    diffCommit: async (id) => structuredClone(committedDiffs.get(id) ?? []),
    discardUncommitted: async () => {
      workingDiffs = [];
      state.dirty = false;
      changed();
      report('Sample uncommitted changes discarded');
    },
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
      if (workingDiffs.length === 0) workingDiffs = [...workingDiffFixture];
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

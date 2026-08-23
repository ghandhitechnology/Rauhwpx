import './versions.css';

import { createIcon } from './icons.ts';

export type VersionTab = 'history' | 'branches' | 'shelves' | 'legacy';

export interface VersionCommitView {
  id: string;
  shortId: string;
  title: string;
  createdAt: number;
  reason: string;
  parentIds: string[];
  branchLabels: string[];
  tagLabels: string[];
  lane: number;
  parentLanes: number[];
  isHead: boolean;
  byteLength: number;
}

export interface VersionBranchView {
  name: string;
  headId: string;
  isActive: boolean;
  isDefault: boolean;
  updatedAt: number;
}

export interface VersionShelfView {
  id: string;
  title: string;
  createdAt: number;
  baseCommitId: string;
  byteLength: number;
}

export interface LegacyVersionView {
  id: string;
  title: string;
  createdAt: number;
  byteLength: number;
}

export interface VersionManagerState {
  documentId: string | null;
  documentName: string | null;
  saved: boolean;
  enabled: boolean;
  dirty: boolean;
  mutationBlockedReason: string | null;
  activeBranch: string | null;
  commits: VersionCommitView[];
  branches: VersionBranchView[];
  shelves: VersionShelfView[];
  legacy: LegacyVersionView[];
  hasMoreCommits: boolean;
  loading: boolean;
  storageBytes: number;
  storageQuotaBytes: number | null;
  aiTitlesEnabled: boolean;
}

export interface VersionManagerController {
  getState(): VersionManagerState;
  refresh(): Promise<void>;
  subscribe(listener: (state: VersionManagerState) => void): () => void;
  enable(): Promise<void>;
  checkpoint(message?: string): Promise<void>;
  loadMore(): Promise<void>;
  restore(commitId: string): Promise<void>;
  adopt(commitId: string): Promise<void>;
  compare(commitId: string): Promise<void>;
  amendTitle(commitId: string, title: string): Promise<void>;
  createBranch(name: string, fromCommitId?: string): Promise<void>;
  switchBranch(name: string): Promise<void>;
  renameBranch(name: string, nextName: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  createTag(name: string, commitId: string): Promise<void>;
  createShelf(title?: string): Promise<void>;
  applyShelf(id: string, remove: boolean): Promise<void>;
  deleteShelf(id: string): Promise<void>;
  compareLegacy(id: string): Promise<void>;
  setAiTitlesEnabled(enabled: boolean): void;
  collectGarbage(): Promise<void>;
  dispose?(): void;
}

export interface VersionManagerPage {
  element: HTMLElement;
  open(): void;
  close(): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface VersionTextPromptOptions {
  title: string;
  label: string;
  initial?: string;
  maxLength?: number;
  optional?: boolean;
  validate?: (value: string) => string | null;
}

let textPromptSequence = 0;

function requestVersionText(options: VersionTextPromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const promptId = `ag-version-text-prompt-${++textPromptSequence}`;
    const overlay = el('div', 'ag-version-prompt-overlay');
    const dialog = el('form', 'ag-version-prompt');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', `${promptId}-title`);

    const title = el('h3', 'ag-version-prompt-title', options.title);
    title.id = `${promptId}-title`;
    const label = el('label', 'ag-version-prompt-label', options.label);
    label.htmlFor = `${promptId}-input`;
    const input = el('input', 'ag-version-prompt-input');
    input.id = `${promptId}-input`;
    input.type = 'text';
    input.maxLength = options.maxLength ?? 200;
    input.autocomplete = 'off';
    input.value = options.initial ?? '';
    const error = el('p', 'ag-version-prompt-error');
    error.id = `${promptId}-error`;
    error.hidden = true;
    input.setAttribute('aria-describedby', error.id);

    const actions = el('div', 'ag-version-prompt-actions');
    const cancel = el('button', 'ag-versions-secondary', '취소');
    cancel.type = 'button';
    const confirm = el('button', 'ag-versions-primary', '확인');
    confirm.type = 'submit';
    actions.append(cancel, confirm);
    dialog.append(title, label, input, error, actions);
    overlay.appendChild(dialog);

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    };
    const submit = (): void => {
      const value = input.value.trim();
      const validation = !value && !options.optional
        ? '값을 입력하세요.'
        : options.validate?.(value) ?? null;
      if (validation) {
        error.textContent = validation;
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      finish(value);
    };

    dialog.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    });
    input.addEventListener('input', () => {
      error.hidden = true;
      input.removeAttribute('aria-invalid');
    });
    cancel.addEventListener('click', () => finish(null));
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(null);
    });

    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function validRefName(value: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,62}$/u.test(value)
    && !value.includes('..')
    && !value.endsWith('/');
}

const PASSIVE_COMPARISON_FIELDS = new Set<keyof VersionManagerState>([
  'mutationBlockedReason',
  'loading',
  'storageBytes',
  'storageQuotaBytes',
  'aiTitlesEnabled',
]);

function sameStateField(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Controller emissions with no visible state delta are document mutation signals:
 * the controller emits after every document-mutated/document-changed event even
 * when the document was already dirty. Explicitly passive UI state may change
 * without making a completed comparison stale.
 */
function invalidatesCompletedComparisons(
  previous: VersionManagerState,
  next: VersionManagerState,
): boolean {
  const changed = (Object.keys(next) as Array<keyof VersionManagerState>)
    .filter((key) => !sameStateField(previous[key], next[key]));
  return changed.length === 0 || changed.some((key) => !PASSIVE_COMPARISON_FIELDS.has(key));
}

function laneSvg(commit: VersionCommitView, laneCount: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const width = Math.max(28, laneCount * 18 + 10);
  const x = 9 + commit.lane * 18;
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('ag-versions-lanes');
  svg.setAttribute('viewBox', `0 0 ${width} 48`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', '48');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.setProperty('--ag-version-lane', String(commit.lane));

  if (commit.parentLanes.length === 0) {
    const tail = document.createElementNS(ns, 'path');
    tail.setAttribute('d', `M${x} 24V48`);
    tail.classList.add('ag-version-lane-path');
    svg.appendChild(tail);
  } else {
    for (const parentLane of commit.parentLanes) {
      const parentX = 9 + parentLane * 18;
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', parentX === x
        ? `M${x} 0V48`
        : `M${x} 0V16C${x} 30 ${parentX} 18 ${parentX} 48`);
      path.classList.add('ag-version-lane-path');
      path.style.setProperty('--ag-parent-lane', String(parentLane));
      svg.appendChild(path);
    }
  }

  const node = document.createElementNS(ns, 'circle');
  node.setAttribute('cx', String(x));
  node.setAttribute('cy', '24');
  node.setAttribute('r', commit.isHead ? '5' : '4');
  node.classList.add('ag-version-node');
  if (commit.isHead) node.classList.add('ag-head');
  svg.appendChild(node);
  return svg;
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    initial: '첫 버전',
    manual: '수동',
    save: '저장',
    agent: '에이전트',
    approval: '승인',
    'pre-restore': '복원 전 자동 저장',
    'pre-switch': '브랜치 전환 전 자동 저장',
    restore: '복원',
    adopt: '채택',
    merge: '채택',
  };
  return labels[reason] ?? reason;
}

export function createVersionManagerPage(controller: VersionManagerController): VersionManagerPage {
  const page = el('section', 'ag-versions-page');
  page.id = 'ag-versions-panel';
  page.setAttribute('aria-labelledby', 'ag-versions-title');
  page.setAttribute('aria-hidden', 'true');
  page.inert = true;

  const head = el('header', 'ag-versions-head');
  const titleWrap = el('div', 'ag-versions-title-wrap');
  const title = el('h2', 'ag-versions-title', '버전');
  title.id = 'ag-versions-title';
  const subtitle = el('span', 'ag-versions-subtitle');
  titleWrap.append(title, subtitle);
  const closeButton = el('button', 'ag-header-icon-btn ag-versions-close');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '버전 닫기');
  closeButton.title = '버전 닫기';
  closeButton.appendChild(createIcon('close'));
  head.append(titleWrap, closeButton);

  const notice = el('div', 'ag-versions-notice');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.setAttribute('aria-atomic', 'true');
  const tabs = el('div', 'ag-versions-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '버전 보기');
  const tabDefs: Array<{ id: VersionTab; label: string }> = [
    { id: 'history', label: '기록' },
    { id: 'branches', label: '브랜치' },
    { id: 'shelves', label: '보관함' },
    { id: 'legacy', label: '이전 기록' },
  ];
  const tabButtons = new Map<VersionTab, HTMLButtonElement>();
  for (const tab of tabDefs) {
    const button = el('button', 'ag-versions-tab', tab.label);
    button.type = 'button';
    button.dataset.tab = tab.id;
    button.id = `ag-versions-${tab.id}-tab`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `ag-versions-${tab.id}-tabpanel`);
    tabs.appendChild(button);
    tabButtons.set(tab.id, button);
  }

  const toolbar = el('div', 'ag-versions-toolbar');
  const activeBranch = el('button', 'ag-versions-branch-pill');
  activeBranch.type = 'button';
  activeBranch.append(createIcon('changes'), el('span', 'ag-versions-branch-name', 'main'));
  const checkpointButton = el('button', 'ag-versions-primary', '체크포인트 저장');
  checkpointButton.type = 'button';
  toolbar.append(activeBranch, checkpointButton);

  const body = el('div', 'ag-versions-body');
  const historyPanel = el('div', 'ag-versions-panel ag-versions-history');
  historyPanel.setAttribute('role', 'tabpanel');
  const graph = el('div', 'ag-versions-graph');
  graph.setAttribute('role', 'listbox');
  graph.setAttribute('aria-label', '체크포인트 기록');
  const inspector = el('aside', 'ag-versions-inspector');
  const loadMoreButton = el('button', 'ag-versions-load-more', '이전 기록 더 보기');
  loadMoreButton.type = 'button';
  historyPanel.append(graph, loadMoreButton, inspector);

  const branchesPanel = el('div', 'ag-versions-panel ag-versions-branches');
  branchesPanel.setAttribute('role', 'tabpanel');
  const shelvesPanel = el('div', 'ag-versions-panel ag-versions-shelves');
  shelvesPanel.setAttribute('role', 'tabpanel');
  const legacyPanel = el('div', 'ag-versions-panel ag-versions-legacy');
  legacyPanel.setAttribute('role', 'tabpanel');
  const tabPanels = new Map<VersionTab, HTMLElement>([
    ['history', historyPanel],
    ['branches', branchesPanel],
    ['shelves', shelvesPanel],
    ['legacy', legacyPanel],
  ]);
  for (const [id, panel] of tabPanels) {
    panel.id = `ag-versions-${id}-tabpanel`;
    panel.setAttribute('aria-labelledby', `ag-versions-${id}-tab`);
  }
  body.append(historyPanel, branchesPanel, shelvesPanel, legacyPanel);

  const footer = el('footer', 'ag-versions-footer');
  const storage = el('span', 'ag-versions-storage');
  const aiLabel = el('label', 'ag-versions-ai');
  const aiToggle = document.createElement('input');
  aiToggle.type = 'checkbox';
  aiLabel.append(aiToggle, document.createTextNode('AI 제목'));
  const privacy = el('span', 'ag-versions-privacy', '작은 변경 요약만 사용 가능한 제공자에 순서대로 전송할 수 있습니다.');
  const gcButton = el('button', 'ag-versions-gc', '사용하지 않는 데이터 정리');
  gcButton.type = 'button';
  footer.append(storage, aiLabel, privacy, gcButton);
  page.append(head, notice, tabs, toolbar, body, footer);

  let current = controller.getState();
  let tab: VersionTab = 'history';
  let selectedCommitId: string | null = null;
  let active = false;
  let actionPending = false;
  const comparedCommits = new Set<string>();

  function setBusy(pending: boolean): void {
    actionPending = pending;
    page.classList.toggle('ag-action-pending', pending);
    renderMutationState();
  }

  async function perform(action: () => Promise<void>): Promise<void> {
    if (actionPending) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notice.textContent = message;
      notice.hidden = false;
      notice.dataset.kind = 'error';
    } finally {
      setBusy(false);
    }
  }

  function askName(label: string, initial = ''): Promise<string | null> {
    return requestVersionText({
      title: label,
      label: '이름',
      initial,
      maxLength: 63,
      validate: (value) => validRefName(value)
        ? null
        : '글자나 숫자로 시작하는 63자 이하 이름을 입력하세요.',
    });
  }

  function renderMutationState(): void {
    const savedDocument = Boolean(current.documentId && current.saved);
    const versioningAvailable = savedDocument && current.enabled;
    const blockedReason = actionPending
      ? '작업을 처리하고 있습니다.'
      : !savedDocument
        ? '먼저 문서를 저장하세요.'
        : !current.enabled
          ? '이 문서에서 버전 기록을 먼저 켜세요.'
          : current.mutationBlockedReason;
    const blocked = blockedReason !== null;

    checkpointButton.disabled = blocked;
    checkpointButton.title = blockedReason ?? '';
    // This control only navigates to the branch browser. It remains available
    // while an agent turn blocks mutations so browsing never gets locked out.
    activeBranch.disabled = !versioningAvailable;
    activeBranch.title = versioningAvailable ? '' : (blockedReason ?? '');
    for (const button of page.querySelectorAll<HTMLButtonElement>('[data-version-mutation]')) {
      const prerequisiteDisabled = button.dataset.versionPrerequisiteDisabled === 'true';
      button.disabled = blocked || prerequisiteDisabled;
      button.title = blockedReason
        ?? (prerequisiteDisabled ? (button.dataset.versionPrerequisiteTitle ?? '') : '');
    }
    for (const button of page.querySelectorAll<HTMLButtonElement>('[data-version-enable]')) {
      const enableBlockedReason = actionPending
        ? '작업을 처리하고 있습니다.'
        : !savedDocument
          ? '먼저 문서를 저장하세요.'
          : current.mutationBlockedReason;
      button.disabled = enableBlockedReason !== null;
      button.title = enableBlockedReason ?? '';
    }
  }

  function renderTabs(): void {
    for (const [id, button] of tabButtons) {
      const selected = id === tab;
      button.classList.toggle('ag-active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const [id, panel] of tabPanels) {
      panel.hidden = id !== tab;
      panel.inert = id !== tab;
    }
  }

  function commitBadges(commit: VersionCommitView): HTMLElement {
    const badges = el('span', 'ag-version-badges');
    for (const branch of commit.branchLabels) {
      const badge = el('span', 'ag-version-badge ag-branch-badge', branch);
      badge.appendChild(createIcon('changes'));
      badges.appendChild(badge);
    }
    for (const tag of commit.tagLabels) {
      badges.appendChild(el('span', 'ag-version-badge ag-tag-badge', `# ${tag}`));
    }
    if (commit.isHead) badges.appendChild(el('span', 'ag-version-badge ag-head-badge', '현재'));
    return badges;
  }

  function renderInspector(): void {
    inspector.replaceChildren();
    const selected = current.commits.find((commit) => commit.id === selectedCommitId) ?? null;
    if (!selected) {
      inspector.appendChild(el('p', 'ag-versions-placeholder', '체크포인트를 선택하면 세부 정보와 복원 작업을 볼 수 있습니다.'));
      return;
    }
    inspector.append(
      el('span', 'ag-versions-inspector-kicker', `${selected.shortId} · ${reasonLabel(selected.reason)}`),
      el('h3', 'ag-versions-inspector-title', selected.title),
      el('p', 'ag-versions-inspector-meta', `${formatTime(selected.createdAt)} · ${formatBytes(selected.byteLength)}`),
      commitBadges(selected),
    );
    const actions = el('div', 'ag-versions-inspector-actions');
    const compare = el('button', 'ag-versions-secondary', '현재와 비교');
    compare.type = 'button';
    compare.addEventListener('click', () => void perform(async () => {
      await controller.compare(selected.id);
      comparedCommits.add(selected.id);
      renderInspector();
    }));
    const restore = el('button', 'ag-versions-primary', '이 버전 복원');
    restore.type = 'button';
    restore.dataset.versionMutation = 'true';
    restore.dataset.versionPrerequisiteDisabled = String(!comparedCommits.has(selected.id));
    restore.dataset.versionPrerequisiteTitle = '먼저 현재 문서와 비교하세요.';
    restore.disabled = !comparedCommits.has(selected.id);
    restore.title = restore.disabled ? '먼저 현재 문서와 비교하세요.' : '';
    restore.addEventListener('click', () => {
      if (!window.confirm('현재 작업을 체크포인트로 남기고 이 버전의 내용으로 복원할까요? 파일은 저장할 때까지 바뀌지 않습니다.')) return;
      void perform(() => controller.restore(selected.id));
    });
    const branch = el('button', 'ag-versions-secondary', '여기서 브랜치');
    branch.type = 'button';
    branch.dataset.versionMutation = 'true';
    branch.addEventListener('click', () => void (async () => {
      const name = await askName('새 브랜치 이름');
      if (name) await perform(() => controller.createBranch(name, selected.id));
    })());
    const tag = el('button', 'ag-versions-secondary', '태그');
    tag.type = 'button';
    tag.dataset.versionMutation = 'true';
    tag.addEventListener('click', () => void (async () => {
      const name = await askName('새 태그 이름');
      if (name) await perform(() => controller.createTag(name, selected.id));
    })());
    actions.append(compare, restore);
    if (!selected.isHead) {
      const adopt = el('button', 'ag-versions-secondary', '이 버전 채택');
      adopt.type = 'button';
      adopt.dataset.versionMutation = 'true';
      adopt.dataset.versionPrerequisiteDisabled = String(!comparedCommits.has(selected.id));
      adopt.dataset.versionPrerequisiteTitle = '먼저 현재 문서와 비교하세요.';
      adopt.disabled = !comparedCommits.has(selected.id);
      adopt.title = adopt.disabled ? '먼저 현재 문서와 비교하세요.' : '';
      adopt.addEventListener('click', () => {
        if (!window.confirm('선택한 버전의 내용을 현재 브랜치에 두 부모를 가진 채택 체크포인트로 남길까요?')) return;
        void perform(() => controller.adopt(selected.id));
      });
      actions.appendChild(adopt);
    }
    actions.append(branch, tag);
    if (selected.isHead) {
      const amend = el('button', 'ag-versions-quiet', '메시지 수정');
      amend.type = 'button';
      amend.dataset.versionMutation = 'true';
      amend.addEventListener('click', () => void (async () => {
        const next = await requestVersionText({
          title: '체크포인트 메시지 수정',
          label: '메시지',
          initial: selected.title,
        });
        if (next) await perform(() => controller.amendTitle(selected.id, next));
      })());
      actions.appendChild(amend);
    }
    inspector.appendChild(actions);
    renderMutationState();
  }

  function selectCommit(id: string, focus = false): void {
    selectedCommitId = id;
    for (const row of graph.querySelectorAll<HTMLButtonElement>('.ag-version-row')) {
      const selected = row.dataset.commitId === id;
      row.classList.toggle('ag-selected', selected);
      row.setAttribute('aria-selected', String(selected));
      row.tabIndex = selected ? 0 : -1;
      if (selected && focus) row.focus();
    }
    renderInspector();
  }

  function renderHistory(): void {
    graph.replaceChildren();
    const laneCount = Math.max(1, ...current.commits.map((commit) => commit.lane + 1));
    if (!selectedCommitId || !current.commits.some((commit) => commit.id === selectedCommitId)) {
      selectedCommitId = current.commits[0]?.id ?? null;
    }
    if (current.commits.length === 0) {
      graph.appendChild(el('p', 'ag-versions-placeholder', '아직 체크포인트가 없습니다.'));
    }
    for (const commit of current.commits) {
      const row = el('button', 'ag-version-row');
      row.type = 'button';
      row.dataset.commitId = commit.id;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-label', `${commit.title}, ${formatTime(commit.createdAt)}`);
      row.tabIndex = commit.id === selectedCommitId ? 0 : -1;
      const copy = el('span', 'ag-version-copy');
      const heading = el('span', 'ag-version-heading');
      heading.append(el('strong', 'ag-version-title', commit.title), commitBadges(commit));
      copy.append(
        heading,
        el('span', 'ag-version-meta', `${formatTime(commit.createdAt)} · ${reasonLabel(commit.reason)} · ${commit.shortId}`),
      );
      row.append(laneSvg(commit, laneCount), copy);
      row.addEventListener('click', () => selectCommit(commit.id));
      row.addEventListener('dblclick', () => void perform(async () => {
        await controller.compare(commit.id);
        comparedCommits.add(commit.id);
        renderInspector();
      }));
      graph.appendChild(row);
    }
    if (selectedCommitId) selectCommit(selectedCommitId);
    else renderInspector();
    loadMoreButton.hidden = !current.hasMoreCommits;
    loadMoreButton.disabled = current.loading;
  }

  function renderBranches(): void {
    branchesPanel.replaceChildren();
    const create = el('button', 'ag-versions-primary', '새 브랜치');
    create.type = 'button';
    create.dataset.versionMutation = 'true';
    create.addEventListener('click', () => void (async () => {
      const name = await askName('새 브랜치 이름');
      if (name) await perform(() => controller.createBranch(name));
    })());
    branchesPanel.appendChild(create);
    const list = el('div', 'ag-versions-card-list');
    for (const branch of current.branches) {
      const row = el('article', 'ag-versions-card');
      const copy = el('div', 'ag-versions-card-copy');
      copy.append(
        el('strong', 'ag-versions-card-title', branch.name),
        el('span', 'ag-versions-card-meta', `${branch.headId.slice(0, 8)} · ${formatTime(branch.updatedAt)}`),
      );
      if (branch.isActive) copy.appendChild(el('span', 'ag-version-badge ag-head-badge', '현재 브랜치'));
      const actions = el('div', 'ag-versions-card-actions');
      if (!branch.isActive) {
        const switchButton = el('button', 'ag-versions-secondary', '전환');
        switchButton.type = 'button';
        switchButton.dataset.versionMutation = 'true';
        switchButton.addEventListener('click', () => {
          if (current.dirty && !window.confirm('현재 작업을 체크포인트로 남기고 브랜치를 전환할까요?')) return;
          void perform(() => controller.switchBranch(branch.name));
        });
        actions.appendChild(switchButton);
      }
      const rename = el('button', 'ag-versions-quiet', '이름 변경');
      rename.type = 'button';
      rename.dataset.versionMutation = 'true';
      rename.addEventListener('click', () => void (async () => {
        const name = await askName('브랜치 이름 변경', branch.name);
        if (name && name !== branch.name) await perform(() => controller.renameBranch(branch.name, name));
      })());
      actions.appendChild(rename);
      if (!branch.isActive && !branch.isDefault) {
        const remove = el('button', 'ag-versions-danger', '삭제');
        remove.type = 'button';
        remove.dataset.versionMutation = 'true';
        remove.addEventListener('click', () => {
          if (!window.confirm(`“${branch.name}” 브랜치를 영구 삭제할까요? 태그나 다른 브랜치가 참조하지 않는 체크포인트는 정리 전까지 남습니다.`)) return;
          void perform(() => controller.deleteBranch(branch.name));
        });
        actions.appendChild(remove);
      }
      row.append(copy, actions);
      list.appendChild(row);
    }
    branchesPanel.appendChild(list);
  }

  function renderShelves(): void {
    shelvesPanel.replaceChildren();
    const shelf = el('button', 'ag-versions-primary', '현재 변경 보관');
    shelf.type = 'button';
    shelf.dataset.versionMutation = 'true';
    shelf.dataset.versionPrerequisiteDisabled = String(!current.dirty);
    shelf.dataset.versionPrerequisiteTitle = '보관할 변경 내용이 없습니다.';
    shelf.disabled = !current.dirty;
    shelf.addEventListener('click', () => void (async () => {
      const title = await requestVersionText({
        title: '현재 변경 보관',
        label: '보관 이름 (선택)',
        optional: true,
      });
      if (title !== null) await perform(() => controller.createShelf(title || undefined));
    })());
    shelvesPanel.appendChild(shelf);
    const list = el('div', 'ag-versions-card-list');
    if (current.shelves.length === 0) list.appendChild(el('p', 'ag-versions-placeholder', '보관한 변경이 없습니다.'));
    for (const item of current.shelves) {
      const row = el('article', 'ag-versions-card');
      const copy = el('div', 'ag-versions-card-copy');
      copy.append(
        el('strong', 'ag-versions-card-title', item.title),
        el('span', 'ag-versions-card-meta', `${formatTime(item.createdAt)} · ${formatBytes(item.byteLength)}`),
      );
      const actions = el('div', 'ag-versions-card-actions');
      const apply = el('button', 'ag-versions-secondary', '적용');
      apply.type = 'button';
      apply.dataset.versionMutation = 'true';
      apply.addEventListener('click', () => void perform(() => controller.applyShelf(item.id, false)));
      const pop = el('button', 'ag-versions-secondary', '적용 후 제거');
      pop.type = 'button';
      pop.dataset.versionMutation = 'true';
      pop.addEventListener('click', () => void perform(() => controller.applyShelf(item.id, true)));
      const remove = el('button', 'ag-versions-danger', '삭제');
      remove.type = 'button';
      remove.dataset.versionMutation = 'true';
      remove.addEventListener('click', () => {
        if (window.confirm('이 보관 항목을 영구 삭제할까요?')) void perform(() => controller.deleteShelf(item.id));
      });
      actions.append(apply, pop, remove);
      row.append(copy, actions);
      list.appendChild(row);
    }
    shelvesPanel.appendChild(list);
  }

  function renderLegacy(): void {
    legacyPanel.replaceChildren(
      el('p', 'ag-versions-legacy-note', '기존 문서 이력은 비교 전용입니다. 새 버전 기록과 합치거나 복원하지 않습니다.'),
    );
    const list = el('div', 'ag-versions-card-list');
    if (current.legacy.length === 0) list.appendChild(el('p', 'ag-versions-placeholder', '이전 기록이 없습니다.'));
    for (const item of current.legacy) {
      const row = el('article', 'ag-versions-card');
      const copy = el('div', 'ag-versions-card-copy');
      copy.append(
        el('strong', 'ag-versions-card-title', item.title),
        el('span', 'ag-versions-card-meta', `${formatTime(item.createdAt)} · ${formatBytes(item.byteLength)}`),
      );
      const compare = el('button', 'ag-versions-secondary', '현재와 비교');
      compare.type = 'button';
      compare.addEventListener('click', () => void perform(() => controller.compareLegacy(item.id)));
      row.append(copy, compare);
      list.appendChild(row);
    }
    legacyPanel.appendChild(list);
  }

  function renderAvailability(): void {
    notice.hidden = true;
    notice.dataset.kind = '';
    const available = Boolean(current.documentId && current.saved && current.enabled);
    tabs.hidden = !available;
    toolbar.hidden = !available;
    body.hidden = !available;
    footer.hidden = !available;
    if (!current.documentId || !current.saved) {
      notice.hidden = false;
      notice.dataset.kind = 'empty';
      notice.replaceChildren(
        el('strong', '', '먼저 문서를 저장하세요'),
        el('span', '', '버전 기록은 저장된 문서에 연결됩니다. 다른 이름으로 저장해도 같은 기록이 이어집니다.'),
      );
      return;
    }
    if (!current.enabled) {
      notice.hidden = false;
      notice.dataset.kind = 'empty';
      const enable = el('button', 'ag-versions-primary', '이 문서에서 버전 사용');
      enable.type = 'button';
      enable.dataset.versionEnable = 'true';
      enable.addEventListener('click', () => void perform(() => controller.enable()));
      notice.replaceChildren(
        el('strong', '', '문서 변경을 안전하게 되돌리세요'),
        el('span', '', '체크포인트와 브랜치는 이 기기에만 저장됩니다. 원본 파일은 일반 저장 전까지 바뀌지 않습니다.'),
        enable,
      );
    }
  }

  function render(next = current): void {
    if (next !== current && invalidatesCompletedComparisons(current, next)) {
      comparedCommits.clear();
    }
    current = next;
    subtitle.textContent = current.documentName ?? '문서 없음';
    renderAvailability();
    renderMutationState();
    if (!current.documentId || !current.saved || !current.enabled) return;
    activeBranch.querySelector('.ag-versions-branch-name')!.textContent = current.activeBranch ?? 'main';
    storage.textContent = current.storageQuotaBytes
      ? `${formatBytes(current.storageBytes)} / ${formatBytes(current.storageQuotaBytes)}`
      : `${formatBytes(current.storageBytes)} 사용`;
    aiToggle.checked = current.aiTitlesEnabled;
    renderTabs();
    renderHistory();
    renderBranches();
    renderShelves();
    renderLegacy();
    renderMutationState();
  }

  for (const [id, button] of tabButtons) {
    button.addEventListener('click', () => {
      tab = id;
      renderTabs();
    });
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const index = tabDefs.findIndex((item) => item.id === tab);
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      tab = tabDefs[(index + delta + tabDefs.length) % tabDefs.length].id;
      renderTabs();
      tabButtons.get(tab)?.focus();
    });
  }

  graph.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = Array.from(graph.querySelectorAll<HTMLButtonElement>('.ag-version-row'));
    if (rows.length === 0) return;
    event.preventDefault();
    const index = rows.findIndex((row) => row.dataset.commitId === selectedCommitId);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    const id = rows[next]?.dataset.commitId;
    if (id) selectCommit(id, true);
  });

  closeButton.addEventListener('click', () => page.dispatchEvent(new CustomEvent('ag-versions-close')));
  checkpointButton.addEventListener('click', () => void (async () => {
    const message = await requestVersionText({
      title: '체크포인트 저장',
      label: '메시지 (비워 두면 자동 제목)',
      optional: true,
    });
    if (message !== null) await perform(() => controller.checkpoint(message));
  })());
  activeBranch.addEventListener('click', () => {
    tab = 'branches';
    renderTabs();
  });
  loadMoreButton.addEventListener('click', () => void perform(() => controller.loadMore()));
  aiToggle.addEventListener('change', () => controller.setAiTitlesEnabled(aiToggle.checked));
  gcButton.dataset.versionMutation = 'true';
  gcButton.addEventListener('click', () => {
    if (!window.confirm('브랜치, 태그, 보관함에서 참조하지 않는 버전 데이터를 영구 정리할까요? 이 작업은 되돌릴 수 없습니다.')) return;
    void perform(() => controller.collectGarbage());
  });
  page.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    page.dispatchEvent(new CustomEvent('ag-versions-close'));
  });

  const unsubscribe = controller.subscribe((state) => {
    if (active) render(state);
    else {
      if (invalidatesCompletedComparisons(current, state)) comparedCommits.clear();
      current = state;
    }
  });
  render();

  return {
    element: page,
    open(): void {
      active = true;
      void controller.refresh();
      render(controller.getState());
      closeButton.focus();
    },
    close(): void {
      active = false;
    },
    dispose(): void {
      unsubscribe();
    },
  };
}

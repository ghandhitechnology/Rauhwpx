import './versions.css';

import { createIcon } from './icons.ts';

export type VersionTab = 'history' | 'branches' | 'shelves';

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
  laneCount: number;
  startsLane: boolean;
  lanesBefore: string[];
  lanesAfter: string[];
  activeLanesBefore: string[];
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

export interface VersionMergeDraftView {
  id: string;
  sourceBranch: string;
  targetBranch: string;
  conflictCount: number;
  resolvedCount: number;
  updatedAt: number;
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
  mergeDrafts: VersionMergeDraftView[];
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
  startMerge(sourceBranch: string): Promise<void>;
  resumeMerge(draftId: string): Promise<void>;
  discardMergeDraft(draftId: string): Promise<void>;
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

interface VersionTextPrompt {
  promise: Promise<string | null>;
  cancel(): void;
}

let textPromptSequence = 0;

function requestVersionText(options: VersionTextPromptOptions): VersionTextPrompt {
  let cancelPrompt = (): void => undefined;
  const promise = new Promise<string | null>((resolve) => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
      returnFocus?.focus();
      resolve(value);
    };
    cancelPrompt = () => finish(null);
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
  return { promise, cancel: () => cancelPrompt() };
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

const VERSION_GRAPH_ROW_HEIGHT = 30;
const VERSION_LANE_COLORS = ['#379cff', '#e7ae45', '#cb79d7', '#53bdab', '#8e9dff', '#ed8592'];

function laneColor(lane: number): string {
  return VERSION_LANE_COLORS[lane % VERSION_LANE_COLORS.length];
}

function laneGeometry(laneCount: number): { gap: number; width: number } {
  const width = Math.min(110, 24 + (laneCount - 1) * 17);
  const gap = laneCount === 1 ? 0 : (width - 24) / (laneCount - 1);
  return { gap, width };
}

function laneGraph(
  commit: VersionCommitView,
  laneCount: number,
): HTMLElement {
  const ns = 'http://www.w3.org/2000/svg';
  const height = VERSION_GRAPH_ROW_HEIGHT;
  const centerY = height / 2;
  const { gap, width } = laneGeometry(laneCount);
  const laneX = (lane: number): number => 10 + lane * gap;
  const x = laneX(commit.lane);
  const graph = el('span', 'ag-version-lane-graph');
  graph.style.setProperty('--ag-version-graph-width', `${width}px`);
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('ag-versions-lanes');
  svg.setAttribute('viewBox', `0 0 ${width + 18} ${height}`);
  svg.setAttribute('width', String(width + 18));
  svg.setAttribute('height', String(height));
  svg.setAttribute('aria-hidden', 'true');
  svg.style.setProperty('--ag-version-lane', String(commit.lane));

  const appendPath = (
    d: string,
    lane: number,
    kind: 'rail' | 'edge',
  ): void => {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.classList.add('ag-version-lane-path', `ag-version-${kind}`);
    path.style.setProperty('--ag-parent-lane', String(lane));
    path.style.setProperty('--ag-version-lane-color', laneColor(lane));
    svg.appendChild(path);
  };

  commit.lanesBefore.forEach((id, fromLane) => {
    if (id === commit.id || !commit.activeLanesBefore.includes(id)) return;
    const toLane = commit.lanesAfter.indexOf(id);
    if (toLane < 0) return;
    const fromX = laneX(fromLane);
    const toX = laneX(toLane);
    appendPath(
      fromX === toX
        ? `M${fromX} 0V${height}`
        : `M${fromX} 0C${fromX} ${centerY} ${toX} ${centerY} ${toX} ${height}`,
      toLane,
      'rail',
    );
  });

  if (!commit.startsLane) {
    appendPath(`M${x} 0V${centerY}`, commit.lane, 'edge');
  }

  for (const parentLane of commit.parentLanes) {
    const parentX = laneX(parentLane);
    appendPath(
      parentX === x
        ? `M${x} ${centerY}V${height}`
        : `M${x} ${centerY}C${x} ${height} ${parentX} ${centerY} ${parentX} ${height}`,
      parentLane,
      'edge',
    );
  }

  const connector = document.createElementNS(ns, 'path');
  connector.setAttribute('d', `M${width + 1} ${centerY}H${x + 7}`);
  connector.classList.add('ag-version-node-connector');
  connector.style.setProperty('--ag-version-lane-color', laneColor(commit.lane));
  svg.appendChild(connector);
  const arrow = document.createElementNS(ns, 'path');
  arrow.setAttribute('d', `M${width + 6} ${centerY - 3}L${width + 12} ${centerY}L${width + 6} ${centerY + 3}Z`);
  arrow.classList.add('ag-version-connector-arrow');
  arrow.style.setProperty('--ag-version-lane-color', laneColor(commit.lane));
  svg.appendChild(arrow);
  const halo = document.createElementNS(ns, 'circle');
  halo.setAttribute('cx', String(x));
  halo.setAttribute('cy', String(centerY));
  halo.setAttribute('r', '6.5');
  halo.classList.add('ag-version-node-halo');
  halo.style.setProperty('--ag-version-lane-color', laneColor(commit.lane));
  svg.appendChild(halo);
  const node = document.createElementNS(ns, 'circle');
  node.setAttribute('cx', String(x));
  node.setAttribute('cy', String(centerY));
  node.setAttribute('r', commit.isHead ? '4' : '3.25');
  node.classList.add('ag-version-node');
  node.style.setProperty('--ag-version-lane-color', laneColor(commit.lane));
  if (commit.isHead) node.classList.add('ag-head');
  if (commit.parentIds.length > 1) node.classList.add('ag-merge-node');
  svg.appendChild(node);
  graph.appendChild(svg);
  return graph;
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
    'pre-merge': '병합 전 자동 저장',
    restore: '복원',
    adopt: '채택',
    merge: '병합',
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
    { id: 'history', label: '그래프' },
    { id: 'branches', label: '브랜치' },
    { id: 'shelves', label: '보관함' },
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
  const checkpointButton = el('button', 'ag-versions-primary', '+ 커밋');
  checkpointButton.type = 'button';
  checkpointButton.setAttribute('aria-label', '새 커밋 만들기');
  const branchButton = el('button', 'ag-versions-secondary', '분기');
  branchButton.type = 'button';
  branchButton.dataset.versionMutation = 'true';
  branchButton.setAttribute('aria-label', '이 커밋에서 브랜치 만들기');
  const mergeButton = el('button', 'ag-versions-secondary', '병합');
  mergeButton.type = 'button';
  mergeButton.dataset.versionMutation = 'true';
  mergeButton.dataset.versionAction = 'merge';
  toolbar.append(mergeButton, branchButton, checkpointButton);
  const createBranchButton = el('button', 'ag-versions-primary ag-versions-create-branch', '+ 브랜치');
  createBranchButton.type = 'button';
  createBranchButton.setAttribute('aria-label', '새 브랜치 만들기');
  createBranchButton.dataset.versionMutation = 'true';
  createBranchButton.addEventListener('click', () => void (async () => {
    const name = await askName('새 브랜치 이름');
    if (name) await perform(() => controller.createBranch(name));
  })());
  toolbar.prepend(createBranchButton);
  const shelf = el('button', 'ag-versions-primary ag-versions-create-shelf', '현재 변경 보관');
  shelf.type = 'button';
  shelf.dataset.versionMutation = 'true';
  shelf.dataset.versionPrerequisiteTitle = '보관할 변경 내용이 없습니다.';
  shelf.addEventListener('click', () => void (async () => {
    const title = await promptVersionText({
      title: '현재 변경 보관',
      label: '보관 이름 (선택)',
      optional: true,
    });
    if (title !== null) await perform(() => controller.createShelf(title || undefined));
  })());
  toolbar.prepend(shelf);

  const body = el('div', 'ag-versions-body');
  const historyPanel = el('div', 'ag-versions-panel ag-versions-history');
  historyPanel.setAttribute('role', 'tabpanel');
  const graph = el('div', 'ag-versions-graph');
  graph.setAttribute('role', 'listbox');
  graph.setAttribute('aria-label', '커밋 기록');
  const inspector = el('aside', 'ag-versions-inspector');
  const dateTooltip = el('div', 'ag-version-date-tooltip');
  dateTooltip.setAttribute('role', 'tooltip');
  let dateTooltipHideTimer: ReturnType<typeof setTimeout> | null = null;
  function cancelDateTooltipHide(): void {
    if (dateTooltipHideTimer !== null) clearTimeout(dateTooltipHideTimer);
    dateTooltipHideTimer = null;
  }
  function scheduleDateTooltipHide(): void {
    cancelDateTooltipHide();
    dateTooltipHideTimer = setTimeout(hideDateTooltip, 100);
  }
  dateTooltip.addEventListener('pointerenter', cancelDateTooltipHide);
  dateTooltip.addEventListener('pointerleave', hideDateTooltip);
  function hideDateTooltip(): void {
    cancelDateTooltipHide();
    dateTooltip.classList.remove('ag-visible');
  }
  function showDateTooltip(row: HTMLElement, commit: VersionCommitView): void {
    cancelDateTooltipHide();
    dateTooltip.textContent = formatTime(commit.createdAt);
    if (!dateTooltip.isConnected) document.body.appendChild(dateTooltip);
    const rect = row.getBoundingClientRect();
    const width = dateTooltip.offsetWidth;
    const height = dateTooltip.offsetHeight;
    dateTooltip.style.left = `${Math.max(8, Math.min(rect.right - width - 8, window.innerWidth - width - 8))}px`;
    dateTooltip.style.top = `${rect.bottom + height + 8 < window.innerHeight ? rect.bottom + 4 : rect.top - height - 4}px`;
    dateTooltip.classList.add('ag-visible');
  }
  graph.addEventListener('scroll', hideDateTooltip, { passive: true });
  window.addEventListener('resize', hideDateTooltip);
  const loadMoreButton = el('button', 'ag-versions-load-more', '이전 기록 더 보기');
  loadMoreButton.type = 'button';
  const branchStrip = el('div', 'ag-versions-branch-strip');
  branchStrip.setAttribute('aria-label', '브랜치 전환');
  const graphCaption = el('div', 'ag-versions-graph-caption');
  toolbar.prepend(branchStrip);
  historyPanel.append(graphCaption, graph, loadMoreButton, inspector);

  const branchesPanel = el('div', 'ag-versions-panel ag-versions-branches');
  branchesPanel.setAttribute('role', 'tabpanel');
  const shelvesPanel = el('div', 'ag-versions-panel ag-versions-shelves');
  shelvesPanel.setAttribute('role', 'tabpanel');
  const tabPanels = new Map<VersionTab, HTMLElement>([
    ['history', historyPanel],
    ['branches', branchesPanel],
    ['shelves', shelvesPanel],
  ]);
  for (const [id, panel] of tabPanels) {
    panel.id = `ag-versions-${id}-tabpanel`;
    panel.setAttribute('aria-labelledby', `ag-versions-${id}-tab`);
  }
  body.append(historyPanel, branchesPanel, shelvesPanel);

  const footer = el('footer', 'ag-versions-footer');
  const storage = el('span', 'ag-versions-storage');
  const aiLabel = el('label', 'ag-versions-ai');
  const aiToggle = document.createElement('input');
  aiToggle.type = 'checkbox';
  aiLabel.append(aiToggle, document.createTextNode('AI 제목'));
  footer.append(storage, aiLabel);
  page.append(head, notice, tabs, toolbar, body, footer);

  let current = controller.getState();
  let tab: VersionTab = 'history';
  let selectedCommitId: string | null = null;
  let active = false;
  let actionPending = false;
  let activeTextPrompt: VersionTextPrompt | null = null;
  const comparedCommits = new Set<string>();

  async function promptVersionText(options: VersionTextPromptOptions): Promise<string | null> {
    activeTextPrompt?.cancel();
    const prompt = requestVersionText(options);
    activeTextPrompt = prompt;
    try {
      return await prompt.promise;
    } finally {
      if (activeTextPrompt === prompt) activeTextPrompt = null;
    }
  }

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

  async function createCheckpointAndSelect(message: string): Promise<void> {
    const previousCommitIds = new Set(current.commits.map((commit) => commit.id));
    await controller.checkpoint(message);
    const next = controller.getState();
    selectedCommitId = next.commits.find((commit) => !previousCommitIds.has(commit.id))?.id
      ?? next.commits.find((commit) => commit.isHead)?.id
      ?? next.commits[0]?.id
      ?? null;
    render(next);
  }

  function askName(label: string, initial = ''): Promise<string | null> {
    return promptVersionText({
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
    const branchNeedsSelection = current.commits.length === 0 || !selectedCommitId;
    const branchBlockedReason = blockedReason ?? (branchNeedsSelection ? '선택된 커밋이 없습니다.' : null);
    branchButton.disabled = branchBlockedReason !== null;
    branchButton.title = branchBlockedReason ?? '';
    for (const button of page.querySelectorAll<HTMLButtonElement>('[data-version-mutation]')) {
      const prerequisiteDisabled = button.dataset.versionPrerequisiteDisabled === 'true';
      button.disabled = blocked || prerequisiteDisabled;
      button.title = blockedReason
        ?? (prerequisiteDisabled
          ? (button.dataset.versionPrerequisiteTitle ?? '')
          : (button.dataset.versionTitle ?? ''));
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
    hideDateTooltip();
    branchStrip.hidden = tab !== 'history';
    createBranchButton.hidden = tab !== 'branches';
    shelf.hidden = tab !== 'shelves';
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

  function commitRefs(commit: VersionCommitView): HTMLElement {
    const refs = el('span', 'ag-version-refs');
    for (const branch of commit.branchLabels) {
      const active = commit.isHead && branch === current.activeBranch;
      refs.appendChild(el(
        'span',
        `ag-version-ref ag-branch-ref${active ? ' ag-active-ref' : ''}`,
        active ? `● ${branch}` : branch,
      ));
    }
    for (const tag of commit.tagLabels) {
      refs.appendChild(el('span', 'ag-version-ref ag-tag-ref', `tag: ${tag}`));
    }
    return refs;
  }

  function renderInspector(): void {
    inspector.replaceChildren();
    const selected = current.commits.find((commit) => commit.id === selectedCommitId) ?? null;
    if (!selected) {
      inspector.appendChild(el('p', 'ag-versions-placeholder', '커밋을 선택하면 세부 정보와 복원 작업을 볼 수 있습니다.'));
      return;
    }
    inspector.style.setProperty('--ag-version-lane-color', laneColor(selected.lane));
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
      if (!window.confirm('현재 작업을 커밋하고 이 버전의 내용으로 복원할까요? 파일은 저장할 때까지 바뀌지 않습니다.')) return;
      void perform(() => controller.restore(selected.id));
    });
    const tag = el('button', 'ag-versions-secondary', '태그');
    tag.type = 'button';
    tag.dataset.versionMutation = 'true';
    tag.addEventListener('click', () => void (async () => {
      const name = await askName('새 태그 이름');
      if (name) await perform(() => controller.createTag(name, selected.id));
    })());
    actions.append(compare, restore);
    if (!selected.isHead) {
      const adopt = el('button', 'ag-versions-secondary', '병합');
      adopt.type = 'button';
      adopt.dataset.versionMutation = 'true';
      adopt.dataset.versionPrerequisiteDisabled = String(!comparedCommits.has(selected.id));
      adopt.dataset.versionPrerequisiteTitle = '먼저 현재 문서와 비교하세요.';
      adopt.disabled = !comparedCommits.has(selected.id);
      adopt.title = adopt.disabled ? '먼저 현재 문서와 비교하세요.' : '';
      adopt.addEventListener('click', () => {
        if (!window.confirm('선택한 버전을 현재 브랜치에 두 부모를 둔 병합 커밋으로 남길까요?')) return;
        void perform(() => controller.adopt(selected.id));
      });
      actions.appendChild(adopt);
    }
    actions.append(tag);
    if (selected.isHead) {
      const amend = el('button', 'ag-versions-quiet', '메시지 수정');
      amend.type = 'button';
      amend.dataset.versionMutation = 'true';
      amend.addEventListener('click', () => void (async () => {
        const next = await promptVersionText({
          title: '커밋 메시지 수정',
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
      if (selected && focus) { row.focus(); row.scrollIntoView({ block: 'nearest' }); }
    }
    renderInspector();
  }

  function renderHistory(): void {
    hideDateTooltip();
    branchStrip.replaceChildren();
    for (const branch of current.branches) {
      const tip = current.commits.find((commit) => commit.id === branch.headId);
      const chip = el('button', `ag-versions-branch-chip${branch.isActive ? ' ag-current' : ''}`);
      chip.type = 'button';
      chip.dataset.versionMutation = 'true';
      chip.style.setProperty('--ag-version-lane-color', laneColor(tip?.lane ?? 0));
      chip.setAttribute('aria-pressed', String(branch.isActive));
      chip.title = branch.isActive ? `${branch.name} · 작업 중` : branch.name;
      chip.setAttribute('aria-label', `${branch.name} 브랜치로 전환`);
      chip.appendChild(el('span', 'ag-versions-chip-name', `⑂ ${branch.name}`));
      if (branch.isActive) chip.appendChild(el('span', 'ag-versions-chip-state', '작업 중'));
      chip.addEventListener('click', () => {
        if (!branch.isActive) void perform(() => controller.switchBranch(branch.name));
      });
      branchStrip.appendChild(chip);
    }
    graphCaption.replaceChildren(el('span', '', `커밋 ${current.commits.length}`), el('span', '', `${current.branches.length}개 브랜치`));
    graph.replaceChildren();
    const laneCount = Math.max(1, ...current.commits.map((commit) => commit.laneCount));
    if (!selectedCommitId || !current.commits.some((commit) => commit.id === selectedCommitId)) {
      selectedCommitId = current.commits[0]?.id ?? null;
    }
    if (current.commits.length === 0) {
      graph.appendChild(el('p', 'ag-versions-placeholder', '아직 커밋이 없습니다.'));
    }
    for (const commit of current.commits) {
      const row = el('button', 'ag-version-row');
      row.type = 'button';
      row.dataset.commitId = commit.id;
      row.style.setProperty('--ag-version-lane-color', laneColor(commit.lane));
      row.setAttribute('role', 'option');
      const accessibleRefs = [
        ...commit.branchLabels.map((branch) => (
          commit.isHead && branch === current.activeBranch ? `HEAD ${branch}` : `브랜치 ${branch}`
        )),
        ...commit.tagLabels.map((tag) => `태그 ${tag}`),
      ];
      row.setAttribute('aria-label', [
        commit.title,
        ...accessibleRefs,
        formatTime(commit.createdAt),
      ].join(', '));
      row.tabIndex = commit.id === selectedCommitId ? 0 : -1;
      const copy = el('span', 'ag-version-copy');
      const heading = el('span', 'ag-version-heading');
      heading.appendChild(el('span', 'ag-version-title', commit.title));
      const refs = commitRefs(commit);
      heading.appendChild(refs);
      copy.appendChild(heading);
      const chevron = el('span', 'ag-version-chevron');
      chevron.setAttribute('aria-hidden', 'true');
      row.append(laneGraph(commit, laneCount), chevron, copy);
      row.addEventListener('pointerenter', () => showDateTooltip(row, commit));
      row.addEventListener('pointerleave', scheduleDateTooltipHide);
      row.addEventListener('focus', () => {
        if (row.matches(':focus-visible')) showDateTooltip(row, commit);
      });
      row.addEventListener('blur', hideDateTooltip);
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
    const list = el('div', 'ag-versions-ref-list');
    for (const branch of current.branches) {
      const row = el('article', 'ag-versions-ref-row');
      row.dataset.branchName = branch.name;
      const copy = el('div', 'ag-versions-ref-copy');
      copy.append(
        el('strong', 'ag-versions-ref-title', `${branch.isActive ? 'HEAD> ' : ''}${branch.name}`),
        el(
          'span',
          'ag-versions-ref-meta',
          `${branch.headId.slice(0, 8)}  ${formatTime(branch.updatedAt)}${branch.isDefault ? '  default' : ''}`,
        ),
      );
      const actions = el('div', 'ag-versions-ref-actions');
      if (!branch.isActive) {
        const mergeDirection = `${branch.name} → ${current.activeBranch ?? '현재'}`;
        const mergeLabel = `병합: ${mergeDirection}`;
        const merge = el('button', 'ag-versions-primary', mergeLabel);
        merge.type = 'button';
        merge.dataset.versionAction = 'merge';
        merge.dataset.versionMutation = 'true';
        merge.dataset.versionTitle = mergeLabel;
        merge.setAttribute('aria-label', `${branch.name}에서 ${current.activeBranch ?? '현재 브랜치'}로 병합`);
        merge.addEventListener('click', () => void perform(() => controller.startMerge(branch.name)));
        actions.appendChild(merge);
        const switchButton = el('button', 'ag-versions-secondary', '전환');
        switchButton.type = 'button';
        switchButton.dataset.versionAction = 'switch';
        switchButton.setAttribute('aria-label', `${branch.name} 브랜치로 전환`);
        switchButton.dataset.versionMutation = 'true';
        switchButton.addEventListener('click', () => {
          if (current.dirty && !window.confirm('현재 작업을 커밋하고 브랜치를 전환할까요?')) return;
          void perform(() => controller.switchBranch(branch.name));
        });
        actions.appendChild(switchButton);
      }
      const rename = el('button', 'ag-versions-quiet', '이름');
      rename.type = 'button';
      rename.dataset.versionAction = 'rename';
      rename.setAttribute('aria-label', `${branch.name} 브랜치 이름 변경`);
      rename.dataset.versionMutation = 'true';
      rename.addEventListener('click', () => void (async () => {
        const name = await askName('브랜치 이름 변경', branch.name);
        if (name && name !== branch.name) await perform(() => controller.renameBranch(branch.name, name));
      })());
      actions.appendChild(rename);
      if (!branch.isActive && !branch.isDefault) {
        const remove = el('button', 'ag-versions-danger', '삭제');
        remove.type = 'button';
        remove.dataset.versionAction = 'delete';
        remove.setAttribute('aria-label', `${branch.name} 브랜치 삭제`);
        remove.dataset.versionMutation = 'true';
        remove.addEventListener('click', () => {
          if (!window.confirm(`“${branch.name}” 브랜치를 영구 삭제할까요? 태그나 다른 브랜치가 참조하지 않는 커밋은 정리 전까지 남습니다.`)) return;
          void perform(() => controller.deleteBranch(branch.name));
        });
        actions.appendChild(remove);
      }
      row.append(copy, actions);
      list.appendChild(row);
    }
    if (current.mergeDrafts.length > 0) {
      const draftsHeading = el('h3', 'ag-versions-section-title', '저장된 병합 검토');
      list.appendChild(draftsHeading);
      for (const draft of current.mergeDrafts) {
        const row = el('article', 'ag-versions-ref-row ag-versions-merge-draft');
        const copy = el('div', 'ag-versions-ref-copy');
        copy.append(
          el('strong', 'ag-versions-ref-title', `${draft.sourceBranch} → ${draft.targetBranch}`),
          el('span', 'ag-versions-ref-meta', `${draft.resolvedCount}/${draft.conflictCount} 해결  ${formatTime(draft.updatedAt)}`),
        );
        const actions = el('div', 'ag-versions-ref-actions');
        const resume = el('button', 'ag-versions-primary', '계속');
        resume.type = 'button';
        resume.setAttribute('aria-label', `${draft.sourceBranch} 병합 초안 계속 검토`);
        resume.dataset.versionMutation = 'true';
        resume.addEventListener('click', () => void perform(() => controller.resumeMerge(draft.id)));
        const discard = el('button', 'ag-versions-danger', '버리기');
        discard.type = 'button';
        discard.setAttribute('aria-label', `${draft.sourceBranch} 병합 초안 버리기`);
        discard.dataset.versionMutation = 'true';
        discard.addEventListener('click', () => {
          if (window.confirm(`${draft.sourceBranch} → ${draft.targetBranch} 병합 초안을 버릴까요?`)) {
            void perform(() => controller.discardMergeDraft(draft.id));
          }
        });
        actions.append(resume, discard);
        row.append(copy, actions);
        list.appendChild(row);
      }
    }
    branchesPanel.appendChild(list);
  }

  function renderShelves(): void {
    shelvesPanel.replaceChildren();
    shelf.dataset.versionPrerequisiteDisabled = String(!current.dirty);
    shelf.disabled = !current.dirty;
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
        el('span', '', '커밋과 브랜치는 이 기기에만 저장됩니다.'),
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
    const targetBranch = current.activeBranch ?? 'main';
    mergeButton.textContent = '병합';
    const mergeDirection = `다른 브랜치 → ${targetBranch}`;
    const mergeLabel = `병합: ${mergeDirection}`;
    mergeButton.dataset.versionTitle = mergeLabel;
    mergeButton.setAttribute('aria-label', mergeLabel);
    storage.textContent = current.storageQuotaBytes
      ? `${formatBytes(current.storageBytes)} / ${formatBytes(current.storageQuotaBytes)}`
      : `${formatBytes(current.storageBytes)} 사용`;
    aiToggle.checked = current.aiTitlesEnabled;
    renderTabs();
    renderHistory();
    renderBranches();
    renderShelves();
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
    const message = await promptVersionText({
      title: '새 커밋 만들기',
      label: '메시지 (비워 두면 자동 제목)',
      optional: true,
    });
    if (message !== null) await perform(() => createCheckpointAndSelect(message));
  })());
  branchButton.addEventListener('click', () => void (async () => {
    const targetId = selectedCommitId ?? current.commits.find((commit) => commit.isHead)?.id ?? current.commits[0]?.id;
    if (!targetId) return;
    const name = await askName('새 브랜치 이름');
    if (name) await perform(() => controller.createBranch(name, targetId));
  })());
  mergeButton.addEventListener('click', () => void (async () => {
    const candidates = current.branches.filter((branch) => !branch.isActive);
    if (candidates.length === 0) {
      notice.textContent = '병합할 다른 브랜치가 없습니다.';
      notice.hidden = false;
      notice.dataset.kind = 'error';
      return;
    }
    const source = candidates.length === 1
      ? candidates[0].name
      : await promptVersionText({
          title: `현재 브랜치로 병합 · → ${current.activeBranch ?? '현재'}`,
          label: `소스 브랜치 (${candidates.map((branch) => branch.name).join(', ')})`,
          validate: (value) => candidates.some((branch) => branch.name === value)
            ? null
            : '목록에 있는 브랜치 이름을 정확히 입력하세요.',
        });
    if (source) await perform(() => controller.startMerge(source));
  })());
  loadMoreButton.addEventListener('click', () => void perform(() => controller.loadMore()));
  aiToggle.addEventListener('change', () => controller.setAiTitlesEnabled(aiToggle.checked));
  page.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (dateTooltip.classList.contains('ag-visible')) { hideDateTooltip(); return; }
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
      hideDateTooltip();
      active = false;
      activeTextPrompt?.cancel();
    },
    dispose(): void {
      hideDateTooltip();
      dateTooltip.remove();
      window.removeEventListener('resize', hideDateTooltip);
      active = false;
      activeTextPrompt?.cancel();
      unsubscribe();
    },
  };
}

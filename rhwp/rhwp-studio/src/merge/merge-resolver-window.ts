import type {
  MergeConflict,
  MergeResolution,
  VersionMergeDraft,
} from '../versioning/types.ts';
import type {
  MaterializedMergeResult,
  MergeApplicationRequest,
  MergeCompletionRequest,
  MergePreviewRole,
  MergeResolverCloseOptions,
  MergeResolverOpenOptions,
  MergeResolverSnapshot,
  MergeValidationResult,
} from './domain.ts';
import { DocumentPreviewPane } from './document-preview-pane.ts';
import { adjacentPreviewRole, syncPreviewTabState, wrappedFocusIndex } from './accessibility.ts';
import { MergeCompletionCoordinator } from './completion-coordinator.ts';
import { buildManualConflictEditor } from './manual-conflict-editor.ts';
import { formatMergeValue, mergeErrorMessage, mergePathLabel, mergeTokenLabel } from './merge-labels.ts';
import { MergeResolverState } from './resolver-state.ts';
import './merge-resolver.css';

const PREVIEW_ROLES: MergePreviewRole[] = ['base', 'current', 'incoming', 'result'];
const ROLE_LABELS: Record<MergePreviewRole, string> = {
  base: '기준',
  current: '현재',
  incoming: '가져올 변경',
  result: '병합 결과',
};

const REASON_LABELS: Record<string, string> = {
  'same-field-changed': '같은 항목이 서로 다르게 변경됨',
  'delete-versus-edit': '한쪽은 삭제하고 다른 쪽은 편집함',
  'incompatible-move': '서로 양립할 수 없는 위치로 이동함',
  'concurrent-insertion': '같은 위치에 양쪽 변경이 추가됨',
  'unknown-control-modified': '알 수 없는 개체가 양쪽에서 변경됨',
  'low-confidence-match': '동일 개체인지 확실하게 판단할 수 없음',
  'budget-exceeded': '분석 제한 시간을 초과함',
};

let mergeResolverSequence = 0;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function conflictLabel(conflict: MergeConflict): string {
  const leaf = mergeTokenLabel(conflict.path.at(-1) ?? conflict.kind, '충돌 항목');
  return `${leaf}: ${REASON_LABELS[conflict.reason] ?? conflict.reason}`;
}

function groupKey(conflict: MergeConflict): string {
  if (conflict.path.length === 0) return '문서';
  return mergePathLabel(conflict.path.slice(0, Math.min(4, conflict.path.length)), '문서');
}

export class MergeResolverWindow {
  private root: HTMLDivElement | null = null;
  private options: MergeResolverOpenOptions | null = null;
  private state: MergeResolverState | null = null;
  private panes = new Map<MergePreviewRole, DocumentPreviewPane>();
  private conflictButtons = new Map<string, HTMLButtonElement>();
  private selectedConflictId: string | null = null;
  private editorEl: HTMLElement | null = null;
  private conflictListEl: HTMLElement | null = null;
  private conflictFilter: 'all' | 'unresolved' | 'resolved' = 'all';
  private conflictQuery = '';
  private completionButton: HTMLButtonElement | null = null;
  private undoButton: HTMLButtonElement | null = null;
  private redoButton: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private actionStatusEl: HTMLElement | null = null;
  private progressEl: HTMLProgressElement | null = null;
  private titleInput: HTMLInputElement | null = null;
  private modeSelect: HTMLSelectElement | null = null;
  private activePreview: MergePreviewRole = 'result';
  private materialized: MaterializedMergeResult | null = null;
  private validation: MergeValidationResult | null = null;
  private materializeTimer: ReturnType<typeof setTimeout> | null = null;
  private materializeAbort: AbortController | null = null;
  private materializeSequence = 0;
  private readonly completion = new MergeCompletionCoordinator();
  private busy = false;
  private completionPromise: Promise<MergeCompletionRequest | null> | null = null;
  private resolveCompletion: ((request: MergeCompletionRequest | null) => void) | null = null;
  private previousFocus: HTMLElement | null = null;
  private readonly onKeyDownBound = (event: KeyboardEvent) => this.onKeyDown(event);
  private readonly instanceId = `merge-resolver-${++mergeResolverSequence}`;

  isOpen(): boolean {
    return this.root !== null;
  }

  snapshot(): MergeResolverSnapshot | null {
    if (!this.state) return null;
    return {
      resolutions: this.state.toRecord(),
      unresolvedCount: this.state.unresolvedCount,
      canUndo: this.state.canUndo,
      canRedo: this.state.canRedo,
      validation: this.validation ? structuredClone(this.validation) : null,
      materialized: this.materialized ? structuredClone(this.materialized) : null,
    };
  }

  open(options: MergeResolverOpenOptions): Promise<MergeCompletionRequest | null> {
    if (this.isOpen()) throw new Error('병합 검토 창이 이미 열려 있습니다.');
    this.options = options;
    this.state = new MergeResolverState(
      options.analysis.conflicts,
      options.draft.resolutions,
      options.draft.history,
      options.draft.historyIndex,
    );
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.completionPromise = new Promise((resolve) => { this.resolveCompletion = resolve; });
    this.build();
    document.body.appendChild(this.root!);
    document.body.classList.add('merge-resolver-open');
    document.addEventListener('keydown', this.onKeyDownBound, true);
    void this.loadPreviews().catch((cause) => {
      this.announce(`미리보기 실패: ${mergeErrorMessage(cause, '문서를 미리 볼 수 없습니다.')}`);
    });
    this.renderConflictList();
    const first = options.analysis.conflicts[0];
    if (first) this.selectConflict(first.id);
    else this.renderCleanMergeEditor();
    this.updateControls();
    this.scheduleMaterialize();
    queueMicrotask(() => this.root?.querySelector<HTMLElement>('button, input')?.focus());
    return this.completionPromise;
  }

  /** 닫을 때는 기본적으로 저장하며, 폐기는 항상 명시적으로 선택해야 한다. */
  async close(options: MergeResolverCloseOptions = {}): Promise<void> {
    if (!this.options || !this.state || !this.root || this.busy) return;
    if (this.completion.hasPending) {
      let request: MergeCompletionRequest | null = null;
      await this.runBusy('적용한 병합을 안전하게 마무리하는 중입니다…', async () => {
        request = await this.completion.finalize(
          'keep',
          (receipt, disposition) => this.options!.finalizeSourceDisposition(receipt, disposition),
        );
      });
      this.finishClose('completed', request);
      return;
    }
    if (options.discard) {
      const confirmed = window.confirm('이 병합 초안과 지금까지 선택한 해결 내용을 모두 버릴까요?');
      if (!confirmed) return;
      await this.runBusy('병합 초안을 버리는 중입니다…', async () => {
        await this.options!.discardDraft(this.options!.draft.id);
      });
      this.finishClose('discarded', null);
      return;
    }
    await this.runBusy('병합 초안을 저장하는 중입니다…', async () => {
      await this.options!.saveDraft(this.updatedDraft());
    });
    this.finishClose('saved', null);
  }

  private build(): void {
    const options = this.options!;
    const root = element('div', 'merge-resolver-window');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'merge-resolver-title');
    this.root = root;

    const header = element('header', 'merge-resolver-header');
    const headingWrap = element('div', 'merge-resolver-heading');
    const heading = element('h1', '', '브랜치 병합');
    heading.id = 'merge-resolver-title';
    const direction = element('p', 'merge-direction', `${options.sourceBranch} → ${options.currentBranch}`);
    headingWrap.append(heading, direction);
    const headerActions = element('div', 'merge-resolver-header-actions');
    const saveClose = element('button', 'merge-secondary-button', '저장하고 닫기');
    saveClose.type = 'button';
    saveClose.addEventListener('click', () => { void this.close().catch(() => undefined); });
    saveClose.setAttribute('aria-label', '병합 초안을 저장하고 닫기');
    const close = element('button', 'merge-icon-button merge-close-button', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '병합 초안을 저장하고 닫기');
    close.addEventListener('click', () => { void this.close().catch(() => undefined); });
    headerActions.append(saveClose, close);
    header.append(headingWrap, headerActions);

    const body = element('div', 'merge-resolver-body');
    body.append(this.buildConflictSidebar(), this.buildPreviewArea(), this.buildEditor());
    root.append(header, body, this.buildFooter());

    this.statusEl = element('div', 'merge-live-status');
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');
    this.statusEl.setAttribute('aria-atomic', 'true');
    root.appendChild(this.statusEl);
    this.actionStatusEl = element('div', 'merge-action-status');
    this.actionStatusEl.setAttribute('role', 'status');
    this.actionStatusEl.setAttribute('aria-live', 'polite');
    root.appendChild(this.actionStatusEl);
  }

  private buildConflictSidebar(): HTMLElement {
    const sidebar = element('aside', 'merge-conflict-sidebar');
    sidebar.setAttribute('aria-label', '병합 충돌');
    const top = element('div', 'merge-sidebar-top');
    const title = element('h2', '', '충돌');
    const globalActions = element('div', 'merge-bulk-actions');
    const current = element('button', 'merge-small-button', '모두 현재');
    const incoming = element('button', 'merge-small-button', '모두 가져오기');
    current.type = incoming.type = 'button';
    current.addEventListener('click', () => this.resolveBulk(this.options!.analysis.conflicts, { kind: 'current' }, '전체 충돌'));
    incoming.addEventListener('click', () => this.resolveBulk(this.options!.analysis.conflicts, { kind: 'incoming' }, '전체 충돌'));
    globalActions.append(current, incoming);
    const filters = element('div', 'merge-conflict-filters');
    const statusFilter = document.createElement('select');
    statusFilter.setAttribute('aria-label', '해결 상태로 충돌 필터링');
    statusFilter.append(
      new Option('모든 충돌', 'all'),
      new Option('해결하지 않은 충돌', 'unresolved'),
      new Option('해결한 충돌', 'resolved'),
    );
    statusFilter.addEventListener('change', () => {
      this.conflictFilter = statusFilter.value as typeof this.conflictFilter;
      this.renderConflictList();
    });
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = '경로나 종류 검색';
    search.setAttribute('aria-label', '경로나 종류로 충돌 검색');
    search.addEventListener('input', () => {
      this.conflictQuery = search.value.trim().toLocaleLowerCase();
      this.renderConflictList();
    });
    filters.append(statusFilter, search);
    top.append(title, globalActions, filters);
    this.conflictListEl = element('div', 'merge-conflict-list');
    this.conflictListEl.setAttribute('role', 'tree');
    this.conflictListEl.addEventListener('keydown', (event) => this.onConflictListKeyDown(event));
    sidebar.append(top, this.conflictListEl);
    return sidebar;
  }

  private buildPreviewArea(): HTMLElement {
    const area = element('main', 'merge-preview-area');
    const tabs = element('div', 'merge-preview-tabs');
    tabs.setAttribute('role', 'tablist');
    const grid = element('div', 'merge-preview-grid');
    for (const role of PREVIEW_ROLES) {
      const tab = element('button', 'merge-preview-tab', ROLE_LABELS[role]);
      const tabId = `${this.instanceId}-tab-${role}`;
      const panelId = `${this.instanceId}-panel-${role}`;
      tab.type = 'button';
      tab.id = tabId;
      tab.dataset.role = role;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(role === this.activePreview));
      tab.setAttribute('aria-controls', panelId);
      tab.tabIndex = role === this.activePreview ? 0 : -1;
      tab.addEventListener('click', () => this.activatePreview(role));
      tab.addEventListener('keydown', (event) => this.onPreviewTabKeyDown(event, role));
      tabs.appendChild(tab);
      const pane = new DocumentPreviewPane({
        role,
        title: ROLE_LABELS[role],
        onPageChange: (page, source) => {
          for (const candidate of this.panes.values()) if (candidate !== source) candidate.setPage(page, false);
        },
      });
      pane.configureTabPanel(panelId, tabId);
      pane.element.classList.toggle('is-active', role === this.activePreview);
      this.panes.set(role, pane);
      grid.appendChild(pane.element);
    }
    area.append(tabs, grid);
    return area;
  }

  private buildEditor(): HTMLElement {
    const editor = element('aside', 'merge-conflict-editor');
    editor.setAttribute('aria-label', '충돌 해결 편집기');
    this.editorEl = editor;
    return editor;
  }

  private buildFooter(): HTMLElement {
    const footer = element('footer', 'merge-resolver-footer');
    const progressWrap = element('div', 'merge-validation-status');
    this.progressEl = document.createElement('progress');
    this.progressEl.max = 1;
    this.progressEl.value = 0;
    this.progressEl.setAttribute('aria-label', '병합 결과 검증 진행률');
    progressWrap.append(this.progressEl, element('span', 'merge-validation-label', '모든 충돌을 해결하면 결과를 검증합니다.'));

    const historyActions = element('div', 'merge-history-actions');
    this.undoButton = element('button', 'merge-secondary-button', '실행 취소');
    this.redoButton = element('button', 'merge-secondary-button', '다시 실행');
    this.undoButton.type = this.redoButton.type = 'button';
    this.undoButton.addEventListener('click', () => this.undo());
    this.redoButton.addEventListener('click', () => this.redo());
    historyActions.append(this.undoButton, this.redoButton);

    const mergeMeta = element('div', 'merge-completion-meta');
    const titleLabel = element('label', 'merge-field-label', '커밋 메시지');
    this.titleInput = document.createElement('input');
    this.titleInput.className = 'merge-title-input';
    this.titleInput.maxLength = 200;
    this.titleInput.value = this.options!.title ?? `${this.options!.sourceBranch} → ${this.options!.currentBranch} 병합`;
    titleLabel.appendChild(this.titleInput);
    mergeMeta.appendChild(titleLabel);
    if (this.options!.mode === 'fast-forward' || this.options!.mode === 'explicit-checkpoint') {
      const modeLabel = element('label', 'merge-field-label', '완료 방식');
      this.modeSelect = document.createElement('select');
      this.modeSelect.className = 'merge-mode-select';
      this.modeSelect.append(new Option('Fast-forward 병합', 'fast-forward'), new Option('병합 커밋 만들기', 'explicit-checkpoint'));
      this.modeSelect.value = this.options!.mode === 'explicit-checkpoint' ? 'explicit-checkpoint' : 'fast-forward';
      modeLabel.appendChild(this.modeSelect);
      mergeMeta.appendChild(modeLabel);
    }

    const finalActions = element('div', 'merge-final-actions');
    const discard = element('button', 'merge-danger-button', '초안 버리기');
    discard.type = 'button';
    discard.addEventListener('click', () => { void this.close({ discard: true }).catch(() => undefined); });
    this.completionButton = element('button', 'merge-primary-button', '병합 완료');
    this.completionButton.type = 'button';
    this.completionButton.addEventListener('click', () => void this.confirmCompletion());
    finalActions.append(discard, this.completionButton);
    footer.append(progressWrap, historyActions, mergeMeta, finalActions);
    return footer;
  }

  private renderConflictList(): void {
    const list = this.conflictListEl;
    if (!list || !this.options || !this.state) return;
    list.replaceChildren();
    this.conflictButtons.clear();
    if (this.options.analysis.conflicts.length === 0) {
      list.appendChild(element('p', 'merge-clean-message', '충돌이 없습니다. 자동 변경은 모두 결과에 포함됩니다.'));
      return;
    }
    const groups = new Map<string, MergeConflict[]>();
    const visibleConflicts = this.options.analysis.conflicts.filter((conflict) => {
      const resolved = Boolean(this.state!.get(conflict.id));
      if (this.conflictFilter === 'unresolved' && resolved) return false;
      if (this.conflictFilter === 'resolved' && !resolved) return false;
      if (!this.conflictQuery) return true;
      const searchable = `${conflict.kind} ${conflict.reason} ${conflict.path.join(' ')}`.toLocaleLowerCase();
      return searchable.includes(this.conflictQuery);
    });
    if (visibleConflicts.length === 0) {
      list.appendChild(element('p', 'merge-clean-message', '조건에 맞는 충돌이 없습니다.'));
      return;
    }
    for (const conflict of visibleConflicts) {
      const key = groupKey(conflict);
      groups.set(key, [...(groups.get(key) ?? []), conflict]);
    }
    for (const [name, conflicts] of groups) {
      const details = element('details', 'merge-conflict-group');
      details.open = true;
      const summary = document.createElement('summary');
      const unresolved = conflicts.filter((conflict) => !this.state!.get(conflict.id)).length;
      summary.textContent = `${name} (미해결 ${unresolved}/${conflicts.length})`;
      const groupActions = element('div', 'merge-group-actions');
      const current = element('button', 'merge-inline-button', '현재');
      const incoming = element('button', 'merge-inline-button', '가져오기');
      current.type = incoming.type = 'button';
      current.addEventListener('click', () => this.resolveBulk(conflicts, { kind: 'current' }, name));
      incoming.addEventListener('click', () => this.resolveBulk(conflicts, { kind: 'incoming' }, name));
      groupActions.append(current, incoming);
      details.append(summary, groupActions);
      const groupList = element('div', 'merge-conflict-group-list');
      groupList.setAttribute('role', 'group');
      for (const conflict of conflicts) {
        const button = element('button', 'merge-conflict-item');
        button.type = 'button';
        button.dataset.conflictId = conflict.id;
        button.setAttribute('role', 'treeitem');
        button.setAttribute('aria-selected', String(this.selectedConflictId === conflict.id));
        button.classList.toggle('is-resolved', Boolean(this.state.get(conflict.id)));
        const kind = element('span', 'merge-conflict-kind', mergeTokenLabel(conflict.kind, '구조 충돌'));
        const label = element('span', 'merge-conflict-label', conflictLabel(conflict));
        const resolution = this.state.get(conflict.id);
        const resolutionLabel = resolution?.kind === 'current'
          ? '현재 선택'
          : resolution?.kind === 'incoming'
            ? '가져올 변경 선택'
            : resolution?.kind === 'both'
              ? '둘 다 선택'
              : resolution?.kind === 'manual'
                ? '직접 편집'
                : '미해결';
        const status = element('span', 'merge-conflict-state', resolutionLabel);
        button.append(kind, label, status);
        button.addEventListener('click', () => this.selectConflict(conflict.id));
        this.conflictButtons.set(conflict.id, button);
        groupList.appendChild(button);
      }
      details.appendChild(groupList);
      list.appendChild(details);
    }
  }

  private selectConflict(id: string): void {
    if (!this.options || !this.editorEl || !this.state) return;
    const conflict = this.options.analysis.conflicts.find((candidate) => candidate.id === id);
    if (!conflict) return;
    this.selectedConflictId = id;
    for (const [conflictId, button] of this.conflictButtons) {
      const selected = conflictId === id;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-selected', String(selected));
    }
    this.renderConflictEditor(conflict);
  }

  private renderConflictEditor(conflict: MergeConflict): void {
    const editor = this.editorEl!;
    editor.replaceChildren();
    const heading = element('div', 'merge-editor-heading');
    heading.append(
      element('h2', '', mergeTokenLabel(conflict.path.at(-1) ?? conflict.kind, '충돌 항목')),
      element('p', 'merge-conflict-path', mergePathLabel(conflict.path)),
      element('p', 'merge-conflict-reason', REASON_LABELS[conflict.reason] ?? conflict.reason),
    );
    const values = element('div', 'merge-value-comparison');
    for (const [label, value] of [
      ['기준', conflict.base],
      ['현재', conflict.current],
      ['가져올 변경', conflict.incoming],
    ] as const) {
      const card = element('section', 'merge-value-card');
      card.append(element('h3', '', label), element('pre', '', formatMergeValue(value)));
      values.appendChild(card);
    }

    const controls = element('div', 'merge-resolution-controls');
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', '충돌 해결 방법 선택');
    const addResolution = (label: string, resolution: MergeResolution): void => {
      const button = element('button', 'merge-resolution-button', label);
      button.type = 'button';
      button.classList.toggle('is-selected', this.state!.get(conflict.id)?.kind === resolution.kind);
      button.addEventListener('click', () => this.resolveConflict(conflict.id, resolution));
      controls.appendChild(button);
    };
    addResolution('현재 변경 사용', { kind: 'current' });
    addResolution('가져올 변경 사용', { kind: 'incoming' });
    if (conflict.supportsBoth) {
      addResolution('둘 다 유지: 현재 변경 먼저', { kind: 'both', order: 'current-first' });
      addResolution('둘 다 유지: 가져올 변경 먼저', { kind: 'both', order: 'incoming-first' });
    }
    editor.append(heading, values, controls);
    const existing = this.state!.get(conflict.id);
    const manual = buildManualConflictEditor({
      conflict,
      initialValue: existing?.kind === 'manual' ? existing.payload : conflict.current,
      onResolve: (payload) => this.resolveConflict(conflict.id, { kind: 'manual', payload }),
      onChooseSide: (side) => this.resolveConflict(conflict.id, { kind: side }),
      uploadAsset: this.options?.uploadAsset,
    });
    if (manual) {
      editor.appendChild(manual);
    } else {
      editor.appendChild(element(
        'p',
        'merge-manual-unavailable',
        '이 값은 나누어 병합할 수 없습니다. 현재 변경이나 가져올 변경 전체를 선택하세요.',
      ));
    }
  }

  private renderCleanMergeEditor(): void {
    this.editorEl?.replaceChildren(
      element('h2', '', '충돌 없는 병합'),
      element('p', 'merge-clean-message', `자동 변경 ${this.options!.analysis.automaticOperationCount}개가 결과에 포함됩니다.`),
    );
  }

  private resolveConflict(id: string, resolution: MergeResolution): void {
    if (!this.state?.resolve(id, resolution)) return;
    this.afterResolutionChange(`${conflictLabel(this.options!.analysis.conflicts.find((item) => item.id === id)!)} 해결 방법을 적용했습니다.`);
  }

  private resolveBulk(conflicts: readonly MergeConflict[], resolution: MergeResolution, label: string): void {
    const affected = this.state?.resolveMany(conflicts.map((conflict) => conflict.id), resolution) ?? 0;
    if (affected === 0) return;
    this.afterResolutionChange(`${label}에서 충돌 ${affected}개를 해결했습니다.`);
  }

  private undo(): void {
    const change = this.state?.undo();
    if (!change) return;
    this.afterResolutionChange(`충돌 ${change.ids.length}개의 해결을 취소했습니다.`);
  }

  private redo(): void {
    const change = this.state?.redo();
    if (!change) return;
    this.afterResolutionChange(`충돌 ${change.ids.length}개의 해결을 다시 적용했습니다.`);
  }

  private afterResolutionChange(announcement: string): void {
    this.validation = null;
    this.materialized = null;
    this.renderConflictList();
    if (this.selectedConflictId) this.selectConflict(this.selectedConflictId);
    this.announce(announcement);
    this.updateControls();
    this.scheduleMaterialize();
  }

  private scheduleMaterialize(): void {
    if (!this.state) return;
    if (this.materializeTimer) {
      clearTimeout(this.materializeTimer);
      this.materializeTimer = null;
    }
    this.materializeAbort?.abort();
    this.materializeAbort = null;
    if (this.state.unresolvedCount > 0) return;
    this.materializeTimer = setTimeout(() => {
      this.materializeTimer = null;
      void this.materializeResult();
    }, 150);
  }

  private async materializeResult(): Promise<void> {
    if (!this.options || !this.state || this.state.unresolvedCount > 0) return;
    const sequence = ++this.materializeSequence;
    this.materializeAbort?.abort();
    const abort = new AbortController();
    this.materializeAbort = abort;
    this.validation = null;
    this.materialized = null;
    this.setValidationLabel('병합 결과를 만들고 검증하는 중입니다…');
    if (this.progressEl) this.progressEl.removeAttribute('value');
    this.updateControls();
    try {
      const materialized = await this.options.materialize({
        analysis: this.options.analysis,
        resolutions: this.state.toRecord(),
        signal: abort.signal,
      });
      if (abort.signal.aborted || sequence !== this.materializeSequence) return;
      this.materialized = materialized;
      this.validation = materialized.validation;
      if (this.progressEl) this.progressEl.value = materialized.validation.valid ? 1 : 0;
      this.setValidationLabel(materialized.validation.valid
        ? '결과를 다시 열어 문서 구조와 리소스를 검증했습니다.'
        : `검증 실패: ${materialized.validation.errors
          .map((error) => mergeErrorMessage(error, '문서 구조를 검증하지 못했습니다.'))
          .join(' ')}`);
      if (materialized.document) {
        try {
          await this.panes.get('result')?.load(materialized.document);
        } catch (cause) {
          if (abort.signal.aborted || sequence !== this.materializeSequence) return;
          this.announce(`병합 결과 미리보기 실패: ${mergeErrorMessage(cause, '문서를 미리 볼 수 없습니다.')}`);
          return;
        }
      }
      this.announce(materialized.validation.valid ? '병합 결과가 준비되었습니다.' : '병합 결과를 검증하지 못했습니다.');
    } catch (cause) {
      if (abort.signal.aborted || sequence !== this.materializeSequence) return;
      this.validation = {
        valid: false,
        errors: [mergeErrorMessage(cause, '병합 결과 문서를 검증하지 못했습니다.')],
      };
      if (this.progressEl) this.progressEl.value = 0;
      this.setValidationLabel(`검증 실패: ${this.validation.errors.join(' ')}`);
    } finally {
      if (sequence === this.materializeSequence) this.updateControls();
    }
  }

  private async confirmCompletion(): Promise<void> {
    if (!this.options || !this.state || !this.materialized || !this.validation?.valid || this.busy) return;
    let application = this.completion.application;
    if (!this.completion.hasPending || !application) {
      const title = this.titleInput?.value.trim() ?? '';
      if (!title) {
        this.titleInput?.focus();
        this.showActionStatus('병합을 완료하려면 커밋 메시지를 입력하세요.', 'error');
        this.announce('병합을 완료하려면 커밋 메시지를 입력하세요.');
        return;
      }
      const mode = this.options.mode === 'diverged'
        ? 'diverged'
        : (this.modeSelect?.value === 'explicit-checkpoint' ? 'explicit-checkpoint' : 'fast-forward');
      const draft = this.updatedDraft(mode);
      application = {
        draft,
        title,
        mode,
        resolutions: this.state.toRecord(),
        materialized: this.materialized,
      };
      try {
        await this.runBusy('병합을 문서와 브랜치에 적용하는 중입니다…', async () => {
          await this.completion.ensureApplied(application!, (request) => this.options!.complete(request));
        });
      } catch {
        return;
      }
      this.updateControls();
    }
    const sourceDisposition = await this.requestSourceDisposition();
    let request: MergeCompletionRequest;
    try {
      await this.runBusy('병합을 마무리하는 중입니다…', async () => {
        request = await this.completion.finalize(
          sourceDisposition,
          (receipt, disposition) => this.options!.finalizeSourceDisposition(receipt, disposition),
        );
      });
    } catch {
      return;
    }
    this.finishClose('completed', request!);
  }

  private requestSourceDisposition(): Promise<'keep' | 'delete'> {
    return new Promise((resolve) => {
      const overlay = element('div', 'merge-confirm-overlay');
      const dialog = element('form', 'merge-confirm-dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      const title = element('h2', '', '소스 브랜치');
      title.id = `${this.instanceId}-source-choice-title`;
      dialog.setAttribute('aria-labelledby', title.id);
      const canDeleteSource = this.options?.canDeleteSource === true;
      const copy = element('p', '', canDeleteSource
        ? `병합을 적용했습니다. “${this.options!.sourceBranch}” 브랜치를 유지하거나 삭제할 수 있습니다.`
        : `병합을 적용했습니다. “${this.options!.sourceBranch}” 브랜치는 기본 브랜치이므로 유지됩니다.`);
      copy.id = `${this.instanceId}-source-choice-description`;
      dialog.setAttribute('aria-describedby', copy.id);
      const select = document.createElement('select');
      select.className = 'merge-source-select';
      select.setAttribute('aria-label', '소스 브랜치 처리 방법');
      const keepOption = new Option('소스 브랜치 유지', 'keep');
      const deleteOption = new Option(
        canDeleteSource ? '소스 브랜치 삭제' : '소스 브랜치 삭제 불가 (기본 브랜치)',
        'delete',
      );
      deleteOption.disabled = !canDeleteSource;
      select.append(keepOption, deleteOption);
      select.value = 'keep';
      const actions = element('div', 'merge-confirm-actions');
      const cancel = element('button', 'merge-secondary-button', '소스 유지');
      cancel.type = 'button';
      const confirm = element('button', 'merge-primary-button', '병합 완료');
      confirm.type = 'submit';
      actions.append(cancel, confirm);
      dialog.append(title, copy, select, actions);
      overlay.appendChild(dialog);
      const resolverRoot = this.root;
      if (resolverRoot) {
        resolverRoot.inert = true;
        resolverRoot.setAttribute('aria-hidden', 'true');
      }
      const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const finish = (value: 'keep' | 'delete'): void => {
        overlay.remove();
        if (resolverRoot) {
          resolverRoot.inert = false;
          resolverRoot.removeAttribute('aria-hidden');
        }
        returnFocus?.focus();
        resolve(value);
      };
      cancel.addEventListener('click', () => finish('keep'));
      // 병합 후 브랜치 선택 창을 닫으면 안전한 기본값인 소스 브랜치 유지로 처리한다.
      overlay.addEventListener('click', (event) => { if (event.target === overlay) finish('keep'); });
      dialog.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); finish('keep'); }
        else if (event.key === 'Tab') this.trapFocus(event, dialog);
      });
      dialog.addEventListener('submit', (event) => {
        event.preventDefault();
        finish(select.value === 'delete' ? 'delete' : 'keep');
      });
      document.body.appendChild(overlay);
      select.focus();
    });
  }

  private updatedDraft(mode?: MergeResolverOpenOptions['mode']): VersionMergeDraft {
    const history = this.state!.toPersistedHistory();
    return {
      ...structuredClone(this.options!.draft),
      mode: mode ?? (this.modeSelect?.value as VersionMergeDraft['mode'] | undefined) ?? this.options!.mode,
      resolutions: this.state!.toRecord(),
      history: history.history,
      historyIndex: history.historyIndex,
      updatedAt: Date.now(),
    };
  }

  private async loadPreviews(): Promise<void> {
    if (!this.options) return;
    await Promise.all([
      this.panes.get('base')!.load(this.options.documents.base),
      this.panes.get('current')!.load(this.options.documents.current),
      this.panes.get('incoming')!.load(this.options.documents.incoming),
      this.panes.get('result')!.load(this.options.documents.result ?? null),
    ]);
  }

  private activatePreview(role: MergePreviewRole): void {
    this.activePreview = role;
    for (const [candidate, pane] of this.panes) pane.element.classList.toggle('is-active', candidate === role);
    syncPreviewTabState(this.root?.querySelectorAll<HTMLElement>('.merge-preview-tab') ?? [], role);
  }

  private onPreviewTabKeyDown(event: KeyboardEvent, role: MergePreviewRole): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const nextRole = adjacentPreviewRole(
      PREVIEW_ROLES,
      role,
      event.key as 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
    );
    event.preventDefault();
    this.activatePreview(nextRole);
    this.root?.querySelector<HTMLElement>(`.merge-preview-tab[data-role="${nextRole}"]`)?.focus();
  }

  private updateControls(): void {
    if (!this.state) return;
    const applied = this.completion.hasPending;
    if (this.undoButton) this.undoButton.disabled = this.busy || applied || !this.state.canUndo;
    if (this.redoButton) this.redoButton.disabled = this.busy || applied || !this.state.canRedo;
    this.root?.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>(
      '.merge-resolver-header-actions button, .merge-final-actions .merge-danger-button, '
      + '.merge-bulk-actions button, .merge-group-actions button, .merge-resolution-button, '
      + '.merge-manual-editor button, .merge-manual-editor input, .merge-manual-editor select, .merge-manual-editor textarea, '
      + '.merge-title-input, .merge-mode-select',
    ).forEach((control) => { control.disabled = this.busy || applied; });
    if (this.completionButton) {
      this.completionButton.textContent = this.busy ? '처리 중…' : '병합 완료';
      this.completionButton.disabled = this.busy || (!applied
        && (this.state.unresolvedCount > 0 || !this.validation?.valid || !this.materialized));
    }
    if (this.state.unresolvedCount > 0) {
      this.setValidationLabel(`해결하지 않은 충돌이 ${this.state.unresolvedCount}개 있습니다.`);
      if (this.progressEl) this.progressEl.value = 0;
    }
  }

  private setValidationLabel(text: string): void {
    const label = this.root?.querySelector<HTMLElement>('.merge-validation-label');
    if (label) label.textContent = text;
  }

  private async runBusy(label: string, action: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.root?.setAttribute('aria-busy', 'true');
    this.showActionStatus(label, 'busy');
    this.announce(label);
    this.updateControls();
    try {
      await action();
      this.clearActionStatus();
    } catch (cause) {
      const message = `병합 작업 실패: ${mergeErrorMessage(cause)}`;
      this.showActionStatus(message, 'error');
      this.announce(message);
      throw cause;
    } finally {
      this.busy = false;
      this.root?.removeAttribute('aria-busy');
      this.updateControls();
    }
  }

  private showActionStatus(message: string, kind: 'busy' | 'error'): void {
    if (!this.actionStatusEl) return;
    this.actionStatusEl.textContent = message;
    this.actionStatusEl.dataset.kind = kind;
  }

  private clearActionStatus(): void {
    if (!this.actionStatusEl) return;
    this.actionStatusEl.textContent = '';
    delete this.actionStatusEl.dataset.kind;
  }

  private finishClose(
    reason: 'saved' | 'discarded' | 'completed',
    completion: MergeCompletionRequest | null,
  ): void {
    if (this.materializeTimer) clearTimeout(this.materializeTimer);
    this.materializeAbort?.abort();
    document.removeEventListener('keydown', this.onKeyDownBound, true);
    document.body.classList.remove('merge-resolver-open');
    for (const pane of this.panes.values()) pane.dispose();
    this.panes.clear();
    this.root?.remove();
    this.root = null;
    const options = this.options;
    this.options = null;
    this.state = null;
    this.selectedConflictId = null;
    this.validation = null;
    this.materialized = null;
    this.actionStatusEl = null;
    this.completion.reset();
    this.previousFocus?.focus();
    this.previousFocus = null;
    this.resolveCompletion?.(completion);
    this.resolveCompletion = null;
    this.completionPromise = null;
    options?.onClosed?.(reason);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.root) return;
    const nestedDialog = document.querySelector<HTMLElement>('.merge-confirm-dialog');
    if (nestedDialog) {
      if (event.key === 'Tab') this.trapFocus(event, nestedDialog);
      return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (this.busy || this.completion.hasPending) return;
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      if (this.busy || this.completion.hasPending) return;
      this.redo();
      return;
    }
    if (event.key === 'Escape' && !document.querySelector('.merge-confirm-overlay')) {
      event.preventDefault();
      void this.close().catch(() => undefined);
      return;
    }
    if (event.key !== 'Tab') return;
    this.trapFocus(event, this.root);
  }

  private trapFocus(event: KeyboardEvent, container: HTMLElement): void {
    const focusable = [...container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    )].filter((node) => !node.hidden && node.offsetParent !== null);
    if (focusable.length === 0) return;
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const targetIndex = wrappedFocusIndex(currentIndex, focusable.length, event.shiftKey);
    if (targetIndex !== null) {
      event.preventDefault();
      focusable[targetIndex].focus();
    }
  }

  private onConflictListKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...this.conflictButtons.values()];
    const current = document.activeElement instanceof HTMLButtonElement
      ? buttons.indexOf(document.activeElement)
      : buttons.findIndex((button) => button.dataset.conflictId === this.selectedConflictId);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const next = buttons[(Math.max(0, current) + direction + buttons.length) % buttons.length];
    if (!next) return;
    event.preventDefault();
    next.focus();
    this.selectConflict(next.dataset.conflictId!);
  }

  private announce(message: string): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = '';
    requestAnimationFrame(() => { if (this.statusEl) this.statusEl.textContent = message; });
  }
}

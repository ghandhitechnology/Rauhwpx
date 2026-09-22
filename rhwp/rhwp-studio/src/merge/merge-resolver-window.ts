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
  result: '결과',
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
  const leaf = mergeTokenLabel(conflict.path.at(-1) ?? conflict.kind, '변경 항목');
  if (conflict.automatic !== undefined) return conflict.path.length === 0 ? '문서와 연결된 변경'
    : conflict.position ? `문단 ${conflict.position.paragraph + 1} 변경` : `${leaf} 변경`;
  return `${leaf}: ${REASON_LABELS[conflict.reason] ?? conflict.reason}`;
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
  private sourceSelect: HTMLSelectElement | null = null;
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
    this.activePreview = this.state.unresolvedCount > 0 ? 'incoming' : 'result';
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
    const heading = element('h1', '', '변경 검토');
    heading.id = 'merge-resolver-title';
    const direction = element('p', 'merge-direction', options.sourceBranch.startsWith('Cloud ')
      ? 'Cloud 문서 → 현재 문서' : `${options.sourceBranch} → ${options.currentBranch}`);
    headingWrap.append(heading, direction);
    const headerActions = element('div', 'merge-resolver-header-actions');
    const applyAll = element('button', 'merge-secondary-button', '모두 적용');
    applyAll.type = 'button';
    applyAll.title = '호환되는 변경을 모두 선택합니다';
    applyAll.addEventListener('click', () => {
      this.resolveBulk(options.analysis.conflicts.filter((item) => item.automatic === true), { kind: 'incoming' }, '호환되는 변경');
      const unresolved = options.analysis.conflicts.find((item) => !this.state?.get(item.id));
      if (unresolved) this.selectConflict(unresolved.id);
    });
    const saveClose = element('button', 'merge-secondary-button', '저장하고 닫기');
    saveClose.type = 'button';
    saveClose.addEventListener('click', () => { void this.close().catch(() => undefined); });
    saveClose.setAttribute('aria-label', '병합 초안을 저장하고 닫기');
    headerActions.append(applyAll, saveClose);
    header.append(headingWrap, headerActions);

    const body = element('div', 'merge-resolver-body');
    const resolutionSidebar = element('div', 'merge-resolution-sidebar');
    resolutionSidebar.append(this.buildConflictSidebar(), this.buildEditor());
    root.classList.toggle('is-clean', this.options!.analysis.conflicts.length === 0);
    body.append(resolutionSidebar, this.buildPreviewArea());
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
    sidebar.setAttribute('aria-label', '변경 목록');
    const top = element('div', 'merge-sidebar-top');
    const title = element('h2', '', '변경');
    const globalActions = element('div', 'merge-bulk-actions');
    const current = element('button', 'merge-small-button', '모두 거절');
    const incoming = element('button', 'merge-small-button', '호환 변경 모두 수락');
    current.type = incoming.type = 'button';
    current.addEventListener('click', () => this.resolveBulk(this.options!.analysis.conflicts, { kind: 'current' }, '전체 변경'));
    incoming.addEventListener('click', () => this.resolveBulk(this.options!.analysis.conflicts.filter((item) => item.automatic === true), { kind: 'incoming' }, '호환되는 변경'));
    globalActions.append(current, incoming);
    const filters = element('div', 'merge-conflict-filters');
    const statusFilter = document.createElement('select');
    statusFilter.setAttribute('aria-label', '검토 상태로 변경 필터링');
    statusFilter.append(
      new Option('모든 변경', 'all'),
      new Option('검토 전 변경', 'unresolved'),
      new Option('검토한 변경', 'resolved'),
    );
    statusFilter.addEventListener('change', () => {
      this.conflictFilter = statusFilter.value as typeof this.conflictFilter;
      this.renderConflictList();
    });
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = '경로나 종류 검색';
    search.setAttribute('aria-label', '경로나 종류로 변경 검색');
    search.addEventListener('input', () => {
      this.conflictQuery = search.value.trim().toLocaleLowerCase();
      this.renderConflictList();
    });
    filters.append(statusFilter, search);
    const tools = element('details', 'merge-conflict-tools');
    tools.append(element('summary', '', '검색 · 일괄 선택'), globalActions, filters);
    top.append(title, tools);
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
      pane.element.inert = role !== this.activePreview;
      pane.element.classList.toggle('is-active', role === this.activePreview);
      this.panes.set(role, pane);
      grid.appendChild(pane.element);
    }
    area.append(tabs, grid);
    return area;
  }

  private buildEditor(): HTMLElement {
    const editor = element('aside', 'merge-conflict-editor');
    editor.setAttribute('aria-label', '변경 검토 편집기');
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
    progressWrap.append(this.progressEl, element('span', 'merge-validation-label', '변경을 확인하세요.'));

    const historyActions = element('div', 'merge-history-actions');
    this.undoButton = element('button', 'merge-secondary-button', '실행 취소');
    this.redoButton = element('button', 'merge-secondary-button', '다시 실행');
    this.undoButton.type = this.redoButton.type = 'button';
    this.undoButton.addEventListener('click', () => this.undo());
    this.redoButton.addEventListener('click', () => this.redo());
    historyActions.append(this.undoButton, this.redoButton);

    const mergeOptions = element('details', 'merge-options');
    mergeOptions.append(element('summary', '', '더 보기'));
    const mergeMeta = element('div', 'merge-completion-meta');
    const titleLabel = element('label', 'merge-field-label', '버전 이름');
    this.titleInput = document.createElement('input');
    this.titleInput.className = 'merge-title-input';
    this.titleInput.maxLength = 200;
    this.titleInput.value = this.options!.sourceBranch.startsWith('Cloud ')
      ? 'Cloud 변경 적용' : this.options!.title ?? `${this.options!.sourceBranch} 변경 적용`;
    titleLabel.appendChild(this.titleInput);
    mergeMeta.appendChild(titleLabel);
    if (this.options!.analysis.analysisVersion < 2 && (this.options!.mode === 'fast-forward' || this.options!.mode === 'explicit-checkpoint')) {
      const modeLabel = element('label', 'merge-field-label', '완료 방식');
      this.modeSelect = document.createElement('select');
      this.modeSelect.className = 'merge-mode-select';
      this.modeSelect.append(new Option('Fast-forward 병합', 'fast-forward'), new Option('병합 커밋 만들기', 'explicit-checkpoint'));
      this.modeSelect.value = this.options!.mode === 'explicit-checkpoint' ? 'explicit-checkpoint' : 'fast-forward';
      modeLabel.appendChild(this.modeSelect);
      mergeMeta.appendChild(modeLabel);
    }

    const sourceLabel = element('label', 'merge-field-label', '가져온 버전');
    this.sourceSelect = document.createElement('select');
    this.sourceSelect.className = 'merge-source-select';
    this.sourceSelect.setAttribute('aria-label', '가져온 버전 보관 방법');
    this.sourceSelect.append(new Option('보관', 'keep'));
    const deleteSource = new Option('적용 후 삭제', 'delete');
    deleteSource.disabled = !this.options!.canDeleteSource;
    this.sourceSelect.append(deleteSource);
    sourceLabel.append(this.sourceSelect);
    if (this.options!.canDeleteSource) mergeMeta.append(sourceLabel);
    const finalActions = element('div', 'merge-final-actions');
    const discard = element('button', 'merge-danger-button', '초안 버리기');
    discard.type = 'button';
    discard.addEventListener('click', () => { void this.close({ discard: true }).catch(() => undefined); });
    this.completionButton = element('button', 'merge-primary-button', '병합 완료');
    this.completionButton.type = 'button';
    this.completionButton.addEventListener('click', () => void this.confirmCompletion());
    mergeMeta.append(discard);
    if (this.options!.reanalyze) {
      const refresh = element('button', 'merge-secondary-button', '최신 문서로 다시 검토');
      refresh.type = 'button';
      refresh.addEventListener('click', () => void this.options?.reanalyze?.().catch((cause) => this.announce(mergeErrorMessage(cause, '검토를 다시 열지 못했습니다.'))));
      mergeMeta.append(refresh);
    }
    if (this.options!.materializeReplacement) {
      const replace = element('button', 'merge-danger-button', '가져온 문서로 교체…');
      replace.type = 'button';
      replace.addEventListener('click', () => void this.replaceWithIncoming());
      mergeMeta.append(replace);
    }
    mergeOptions.append(mergeMeta);
    finalActions.append(this.completionButton);
    footer.append(progressWrap, historyActions, mergeOptions, finalActions);
    return footer;
  }

  private renderConflictList(): void {
    const list = this.conflictListEl;
    if (!list || !this.options || !this.state) return;
    list.replaceChildren();
    this.conflictButtons.clear();
    if (this.options.analysis.conflicts.length === 0) {
      list.appendChild(element('p', 'merge-clean-message', '검토할 변경이 없습니다.'));
      return;
    }
    const visibleConflicts = this.options.analysis.conflicts.filter((conflict) => {
      const resolved = Boolean(this.state!.get(conflict.id));
      if (this.conflictFilter === 'unresolved' && resolved) return false;
      if (this.conflictFilter === 'resolved' && !resolved) return false;
      if (!this.conflictQuery) return true;
      const searchable = `${conflict.kind} ${conflict.reason} ${conflict.path.join(' ')}`.toLocaleLowerCase();
      return searchable.includes(this.conflictQuery);
    });
    if (visibleConflicts.length === 0) {
      list.appendChild(element('p', 'merge-clean-message', '조건에 맞는 변경이 없습니다.'));
      return;
    }
    for (const conflict of visibleConflicts) {
        const button = element('button', 'merge-conflict-item');
        button.type = 'button';
        button.dataset.conflictId = conflict.id;
        button.setAttribute('role', 'treeitem');
        button.setAttribute('aria-selected', String(this.selectedConflictId === conflict.id));
        button.classList.toggle('is-resolved', Boolean(this.state.get(conflict.id)));
        const kind = element('span', 'merge-conflict-kind', this.state.get(conflict.id)?.kind === 'incoming' ? '✓' : this.state.get(conflict.id)?.kind === 'current' ? '✕' : '○');
        const label = element('span', 'merge-conflict-label', conflictLabel(conflict));
        const resolution = this.state.get(conflict.id);
        const resolutionLabel = resolution?.kind === 'current'
          ? '거절'
          : resolution?.kind === 'incoming'
            ? '수락'
            : resolution?.kind === 'both'
              ? '둘 다 선택'
              : resolution?.kind === 'manual'
                ? '직접 편집'
                : conflict.automatic === false ? '선택 필요' : '검토 전';
        const status = element('span', 'merge-conflict-state', resolutionLabel);
        button.append(kind, label, status);
        button.addEventListener('click', () => this.selectConflict(conflict.id));
        this.conflictButtons.set(conflict.id, button);
        list.appendChild(button);
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
    if (conflict.position) {
      for (const pane of this.panes.values()) pane.focus(null, conflict.position);
    }
  }

  private renderConflictEditor(conflict: MergeConflict): void {
    const editor = this.editorEl!;
    editor.replaceChildren();
    const heading = element('div', 'merge-editor-heading');
    heading.append(
      element('h2', '', conflictLabel(conflict)),
      element('p', 'merge-conflict-path', conflict.path.length ? mergePathLabel(conflict.path) : ''),
      element('p', 'merge-conflict-reason', conflict.automatic === true ? '' : conflict.automatic === false ? '양쪽에서 바뀐 내용을 확인하세요.' : REASON_LABELS[conflict.reason] ?? conflict.reason),
    );
    const values = element('div', 'merge-value-comparison');
    for (const [label, value] of [
      ['기준', conflict.base],
      ['현재', conflict.current],
      ['가져올 변경', conflict.incoming],
    ] as const) {
      const card = element('section', 'merge-value-card');
      const display = value && typeof value === 'object' && 'text' in value ? (value as { text: unknown }).text : value;
      card.append(element('h3', '', label), element('pre', '', formatMergeValue(display)));
      values.appendChild(card);
    }

    const controls = element('div', 'merge-resolution-controls');
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', '변경 적용 방법 선택');
    const addResolution = (label: string, resolution: MergeResolution): void => {
      const button = element('button', 'merge-resolution-button', label);
      button.type = 'button';
      const selected = this.state!.get(conflict.id);
      const matches = selected?.kind === resolution.kind
        && (selected.kind !== 'both' || (resolution.kind === 'both' && selected.order === resolution.order));
      button.classList.toggle('is-selected', matches);
      button.setAttribute('aria-pressed', String(matches));
      const value = resolution.kind === 'current' ? conflict.current : resolution.kind === 'incoming' ? conflict.incoming : null;
      if (typeof value === 'string' && value.trim()) {
        const preview = value.replace(/\s+/g, ' ').trim();
        button.append(element('small', 'merge-choice-preview', preview.length > 160 ? `${preview.slice(0, 160)}…` : preview));
      }
      button.addEventListener('click', () => this.resolveConflict(conflict.id, resolution));
      controls.appendChild(button);
    };
    addResolution('✕ 거절', { kind: 'current' });
    addResolution('✓ 수락', { kind: 'incoming' });
    if (conflict.supportsBoth) {
      addResolution('둘 다 유지: 현재 변경 먼저', { kind: 'both', order: 'current-first' });
      addResolution('둘 다 유지: 가져올 변경 먼저', { kind: 'both', order: 'incoming-first' });
    }
    const valueDetails = element('details', 'merge-value-details');
    valueDetails.append(element('summary', '', '변경 내용 비교'), values);
    editor.append(heading, controls, valueDetails);
    const existing = this.state!.get(conflict.id);
    const manualConflict = conflict.id.startsWith('review:') && conflict.supportsManual
      ? { ...conflict, current: (conflict.current as { text: string }).text, incoming: (conflict.incoming as { text: string }).text }
      : conflict;
    const manual = buildManualConflictEditor({
      conflict: manualConflict,
      initialValue: existing?.kind === 'manual' ? existing.payload : manualConflict.current,
      onResolve: (payload) => this.resolveConflict(conflict.id, { kind: 'manual', payload }),
      onChooseSide: (side) => this.resolveConflict(conflict.id, { kind: side }),
      uploadAsset: this.options?.uploadAsset,
    });
    if (manual) {
      const manualDetails = element('details', 'merge-manual-details');
      manualDetails.open = existing?.kind === 'manual';
      manualDetails.append(element('summary', '', '직접 수정'), manual);
      editor.appendChild(manualDetails);
    } else {
      editor.appendChild(element(
        'p',
        'merge-manual-unavailable',
        '연결된 변경을 함께 선택합니다.',
      ));
    }
  }

  private renderCleanMergeEditor(): void {
    this.editorEl?.replaceChildren(
      element('h2', '', '변경 검토 완료'),
      element('p', 'merge-clean-message', `자동 변경 ${this.options!.analysis.automaticOperationCount}개가 결과에 포함됩니다.`),
    );
  }

  private async replaceWithIncoming(): Promise<void> {
    if (!this.options?.materializeReplacement || !this.state || this.busy) return;
    if (!window.confirm('현재 문서의 변경을 가져온 문서로 모두 교체할까요? 교체 전 문서는 버전 기록에서 복원할 수 있습니다.')) return;
    if (this.materializeTimer) clearTimeout(this.materializeTimer);
    this.materializeTimer = null;
    this.materializeAbort?.abort();
    this.materializeSequence += 1;
    try {
      await this.runBusy('문서를 확인하는 중…', async () => {
        this.materialized = await this.options!.materializeReplacement!();
        this.validation = this.materialized.validation;
      });
      this.state.resolveMany(this.options.analysis.conflicts.map((item) => item.id), { kind: 'incoming' });
      await this.confirmCompletion();
    } catch { this.updateControls(); }
  }

  private resolveConflict(id: string, resolution: MergeResolution): void {
    if (!this.state?.resolve(id, resolution)) return;
    this.afterResolutionChange(`${conflictLabel(this.options!.analysis.conflicts.find((item) => item.id === id)!)} 해결 방법을 적용했습니다.`);
  }

  private resolveBulk(conflicts: readonly MergeConflict[], resolution: MergeResolution, label: string): void {
    const affected = this.state?.resolveMany(conflicts.map((conflict) => conflict.id), resolution) ?? 0;
    if (affected === 0) return;
    this.afterResolutionChange(`${label} ${affected}개를 선택했습니다.`);
  }

  private undo(): void {
    const change = this.state?.undo();
    if (!change) return;
    this.afterResolutionChange(`변경 ${change.ids.length}개의 선택을 취소했습니다.`);
  }

  private redo(): void {
    const change = this.state?.redo();
    if (!change) return;
    this.afterResolutionChange(`변경 ${change.ids.length}개의 선택을 다시 적용했습니다.`);
  }

  private afterResolutionChange(announcement: string): void {
    this.validation = null;
    this.materialized = null;
    this.activatePreview('result');
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
    this.materializeTimer = setTimeout(() => {
      this.materializeTimer = null;
      void this.materializeResult();
    }, 150);
  }

  private async materializeResult(): Promise<void> {
    if (!this.options || !this.state) return;
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
        resolutions: Object.fromEntries(this.options.analysis.conflicts.flatMap((item) => {
          const resolution = this.state!.get(item.id) ?? { kind: 'current' };
          const keys: Array<[string, MergeResolution]> = [
            [item.id, resolution],
            [item.fingerprint, resolution],
          ];
          if (item.position) {
            keys.push([
              `review-pos:${item.position.section}:${item.position.paragraph}`,
              resolution,
            ]);
          }
          return keys;
        })),
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
    if (!this.options || !this.state || this.state.unresolvedCount > 0 || !this.materialized || !this.validation?.valid || this.busy) return;
    let application = this.completion.application;
    if (!this.completion.hasPending || !application) {
      const title = this.titleInput?.value.trim() ?? '';
      if (!title) {
        const options = this.titleInput?.closest('details');
        if (options) options.open = true;
        this.titleInput?.focus();
        this.showActionStatus('저장할 버전 이름을 입력하세요.', 'error');
        this.announce('저장할 버전 이름을 입력하세요.');
        return;
      }
      const mode = this.options.mode === 'diverged'
        ? 'diverged'
        : (this.options.analysis.analysisVersion >= 2 || this.modeSelect?.value === 'explicit-checkpoint' ? 'explicit-checkpoint' : 'fast-forward');
      const draft = this.updatedDraft(mode);
      application = {
        draft,
        title,
        mode,
        resolutions: this.state.toRecord(),
        materialized: this.materialized,
      };
      try {
        await this.runBusy('변경을 문서에 적용하는 중입니다…', async () => {
          await this.completion.ensureApplied(application!, (request) => this.options!.complete(request));
        });
      } catch {
        return;
      }
      this.updateControls();
    }
    const sourceDisposition = this.options.canDeleteSource && this.sourceSelect?.value === 'delete' ? 'delete' : 'keep';
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
    for (const [candidate, pane] of this.panes) {
      pane.element.classList.toggle('is-active', candidate === role);
      pane.element.inert = candidate !== role;
    }
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
      '.merge-resolver-header-actions button, .merge-options button, .merge-final-actions .merge-danger-button, '
      + '.merge-bulk-actions button, .merge-group-actions button, .merge-resolution-button, '
      + '.merge-manual-editor button, .merge-manual-editor input, .merge-manual-editor select, .merge-manual-editor textarea, '
      + '.merge-title-input, .merge-mode-select',
    ).forEach((control) => { control.disabled = this.busy || applied; });
    if (this.completionButton) {
      this.completionButton.textContent = this.busy ? '처리 중…' : '선택한 변경 적용';
      this.completionButton.disabled = this.busy || (!applied
        && (this.state.unresolvedCount > 0 || !this.validation?.valid || !this.materialized));
    }
    if (this.state.unresolvedCount > 0) {
      this.setValidationLabel(`검토할 변경 ${this.state.unresolvedCount}개`);
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

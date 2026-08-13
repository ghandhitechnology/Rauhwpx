import './reference-library.css';

import type { AgentBridge } from '../../agent/bridge.ts';
import type {
  ReferenceFile,
  ReferenceScope,
  ReferenceSearchHit,
} from '../../agent/types.ts';
import { createIcon } from './icons.ts';

const ACCEPTED_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm',
  '.pdf', '.docx', '.hwp', '.hwpx', '.hml',
] as const;
const ACCEPTED_FILES = ACCEPTED_EXTENSIONS.join(',');
const MAX_FILES_PER_PICK = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SEARCH_DEBOUNCE_MS = 240;

const SCOPE_LABEL: Record<ReferenceScope, string> = {
  chat: '이 채팅',
  document: '이 문서',
  global: '모든 채팅',
};

const STATUS_LABEL: Record<ReferenceFile['status'], string> = {
  uploading: '업로드 중',
  extracting: '내용 읽는 중',
  indexing: '검색 준비 중',
  ready: '준비됨',
  error: '오류',
};

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ReferenceLibraryContext {
  threadId: string;
  documentId: string | null;
  documentName: string | null;
}

export interface ReferenceLibraryOptions {
  bridge: AgentBridge;
  getContext(): ReferenceLibraryContext;
  onOpenChange?(open: boolean): void;
}

export interface ReferenceLibraryUi {
  page: HTMLElement;
  trigger: HTMLButtonElement;
  quickAddButton: HTMLButtonElement;
  quickUploads: HTMLElement;
  isOpen(): boolean;
  setOpen(open: boolean, scope?: ReferenceScope): void;
  setConnectionState(state: ReturnType<AgentBridge['getConnectionState']>): void;
  contextChanged(): void;
  refresh(): Promise<void>;
  dispose(): void;
}

type ScopeTarget = { scope: ReferenceScope; scopeId: string };

function targetFor(scope: ReferenceScope, context: ReferenceLibraryContext): ScopeTarget | null {
  if (scope === 'chat') return context.threadId ? { scope, scopeId: context.threadId } : null;
  if (scope === 'document') {
    return context.documentId ? { scope, scopeId: context.documentId } : null;
  }
  return { scope, scopeId: 'global' };
}

export function createReferenceLibrary(options: ReferenceLibraryOptions): ReferenceLibraryUi {
  const { bridge } = options;
  let open = false;
  let activeScope: ReferenceScope = 'chat';
  let connectionState = bridge.getConnectionState();
  let disposed = false;
  let requestRevision = 0;
  let countRevision = 0;
  let searchTimer: number | null = null;
  let pickerTarget: ScopeTarget | null = null;
  let lastFocus: HTMLElement | null = null;
  const filesByScope = new Map<ReferenceScope, ReferenceFile[]>();

  const trigger = el('button', 'ag-references-btn');
  trigger.type = 'button';
  trigger.setAttribute('aria-controls', 'ag-references-panel');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', '참고자료 열기');
  trigger.title = '참고자료';
  trigger.append(createIcon('references'), el('span', 'ag-references-btn-label', '참고자료'));
  const count = el('span', 'ag-references-count', '0');
  count.setAttribute('aria-hidden', 'true');
  trigger.appendChild(count);

  const quickAddButton = el('button', 'ag-reference-quick-add');
  quickAddButton.type = 'button';
  quickAddButton.setAttribute('aria-label', '이 채팅에 참고자료 추가');
  quickAddButton.title = '이 채팅에 참고자료 추가';
  quickAddButton.appendChild(createIcon('paperclip'));

  const quickUploads = el('div', 'ag-reference-quick-uploads');
  quickUploads.setAttribute('role', 'status');
  quickUploads.setAttribute('aria-live', 'polite');
  quickUploads.setAttribute('aria-label', '참고자료 업로드 상태');

  const fileInput = el('input', 'ag-reference-file-input') as HTMLInputElement;
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = ACCEPTED_FILES;
  fileInput.hidden = true;
  fileInput.setAttribute('aria-label', '참고자료 파일 선택');

  const page = el('section', 'ag-references-page');
  page.id = 'ag-references-panel';
  page.setAttribute('role', 'region');
  page.setAttribute('aria-labelledby', 'ag-references-title');
  page.setAttribute('aria-hidden', 'true');
  page.inert = true;

  const header = el('div', 'ag-references-header');
  const title = el('h2', 'ag-references-title', '참고자료');
  title.id = 'ag-references-title';
  const close = el('button', 'ag-references-close');
  close.type = 'button';
  close.setAttribute('aria-label', '참고자료 닫기');
  close.title = '참고자료 닫기';
  close.appendChild(createIcon('close'));
  header.append(title, close);

  const tabs = el('div', 'ag-reference-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '참고자료 범위');
  const tabButtons = new Map<ReferenceScope, HTMLButtonElement>();
  const tabPanels = new Map<ReferenceScope, HTMLElement>();
  for (const scope of ['chat', 'document', 'global'] as const) {
    const tab = el('button', 'ag-reference-tab', SCOPE_LABEL[scope]);
    tab.type = 'button';
    tab.id = `ag-reference-tab-${scope}`;
    tab.dataset.scope = scope;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `ag-reference-tabpanel-${scope}`);
    tab.setAttribute('aria-selected', 'false');
    tab.tabIndex = -1;
    tab.addEventListener('click', () => selectScope(scope));
    tabButtons.set(scope, tab);
    tabs.appendChild(tab);

    const panel = el('div', 'ag-reference-tabpanel');
    panel.id = `ag-reference-tabpanel-${scope}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.hidden = true;
    panel.inert = true;
    tabPanels.set(scope, panel);
  }

  const toolbar = el('div', 'ag-reference-toolbar');
  const add = el('button', 'ag-reference-add', '파일 추가');
  add.type = 'button';
  add.appendChild(createIcon('paperclip'));
  const search = el('input', 'ag-reference-search') as HTMLInputElement;
  search.type = 'search';
  search.placeholder = '파일 내용 검색';
  search.setAttribute('aria-label', '참고자료 내용 검색');
  toolbar.append(add, search);

  const scopeHint = el('p', 'ag-reference-scope-hint');
  const status = el('div', 'ag-reference-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const error = el('div', 'ag-reference-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const results = el('div', 'ag-reference-results');
  const dropHint = el('p', 'ag-reference-drop-hint', '여기에 파일을 놓아 추가할 수도 있습니다.');
  page.append(header, tabs, ...tabPanels.values(), fileInput);

  function showError(message = ''): void {
    error.textContent = message;
    error.hidden = !message;
  }

  function updateAvailability(): void {
    const context = options.getContext();
    const connected = connectionState === 'connected';
    const documentTab = tabButtons.get('document')!;
    documentTab.disabled = !context.documentId;
    documentTab.title = context.documentId ? '' : '문서를 열면 문서별 참고자료를 추가할 수 있습니다.';
    quickAddButton.disabled = !connected || !context.threadId;
    add.disabled = !connected || targetFor(activeScope, context) === null;
    if (!connected) add.title = '에이전트 서버가 연결되면 파일을 추가할 수 있습니다.';
    else add.removeAttribute('title');
    if (activeScope === 'document' && !context.documentId) {
      scopeHint.textContent = '문서를 열면 해당 문서의 모든 채팅에서 쓸 참고자료를 추가할 수 있습니다.';
    } else if (activeScope === 'document') {
      scopeHint.textContent = `${context.documentName ?? '현재 문서'}의 모든 채팅에서 사용합니다.`;
    } else if (activeScope === 'global') {
      scopeHint.textContent = '모든 문서와 모든 채팅에서 항상 검색합니다.';
    } else {
      scopeHint.textContent = '현재 채팅에서만 검색합니다.';
    }
  }

  function updateTabs(): void {
    for (const [scope, button] of tabButtons) {
      const active = scope === activeScope;
      button.classList.toggle('ag-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
      const panel = tabPanels.get(scope)!;
      panel.hidden = !active;
      panel.inert = !active;
    }
    // 범위마다 실제 tabpanel을 유지하고, 공유 목록 UI만 현재 패널로 옮긴다.
    // aria-controls가 존재하지 않는 노드를 가리키거나 패널 밖 콘텐츠를 제어하지 않게 한다.
    tabPanels.get(activeScope)!.append(toolbar, scopeHint, status, error, results, dropHint);
    updateAvailability();
  }

  function selectScope(scope: ReferenceScope): void {
    if (scope === 'document' && !options.getContext().documentId) return;
    activeScope = scope;
    search.value = '';
    updateTabs();
    void refreshActiveScope();
  }

  function scopeTarget(): ScopeTarget | null {
    return targetFor(activeScope, options.getContext());
  }

  function renderFiles(files: ReferenceFile[]): void {
    results.replaceChildren();
    if (files.length === 0) {
      results.appendChild(el('p', 'ag-reference-empty', '추가된 참고자료가 없습니다.'));
      return;
    }
    const list = el('ul', 'ag-reference-file-list');
    for (const file of files) {
      const item = el('li', 'ag-reference-file');
      const icon = createIcon('document');
      const copy = el('span', 'ag-reference-file-copy');
      const name = el('strong', 'ag-reference-file-name', file.name);
      name.title = file.name;
      const state = el(
        'span',
        `ag-reference-file-meta ag-reference-status-${file.status}`,
        `${formatBytes(file.size)} · ${STATUS_LABEL[file.status]}`,
      );
      copy.append(name, state);
      const remove = el('button', 'ag-reference-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `${file.name} 참고자료 제거`);
      remove.title = '제거';
      remove.appendChild(createIcon('close'));
      remove.disabled = file.status === 'uploading' || file.status === 'extracting' || file.status === 'indexing';
      remove.addEventListener('click', async () => {
        if (!window.confirm(`"${file.name}" 참고자료를 제거할까요? 원본 파일은 삭제되지 않습니다.`)) return;
        remove.disabled = true;
        status.textContent = `${file.name} 제거 중…`;
        showError();
        try {
          await bridge.deleteReference(file);
          status.textContent = `${file.name} 참고자료를 제거했습니다.`;
          await Promise.all([refreshActiveScope(), refreshCounts()]);
        } catch (caught) {
          remove.disabled = false;
          showError(errorMessage(caught));
          status.textContent = '참고자료를 제거하지 못했습니다.';
        }
      });
      item.append(icon, copy, remove);
      list.appendChild(item);
    }
    results.appendChild(list);
  }

  function renderSearchHits(hits: ReferenceSearchHit[]): void {
    results.replaceChildren();
    if (hits.length === 0) {
      results.appendChild(el('p', 'ag-reference-empty', '검색 결과가 없습니다.'));
      return;
    }
    const list = el('ol', 'ag-reference-search-results');
    for (const hit of hits) {
      const item = el('li', 'ag-reference-search-hit');
      const head = el('div', 'ag-reference-search-hit-head');
      head.append(
        el('strong', 'ag-reference-search-hit-name', hit.name),
        el('span', 'ag-reference-search-hit-scope', SCOPE_LABEL[hit.scope]),
      );
      item.append(head, el('p', 'ag-reference-search-snippet', hit.snippet || '일치하는 내용'));
      list.appendChild(item);
    }
    results.appendChild(list);
  }

  async function refreshActiveScope(): Promise<void> {
    const target = scopeTarget();
    const revision = ++requestRevision;
    showError();
    if (!target) {
      status.textContent = '현재 범위에 참고자료를 연결할 수 없습니다.';
      renderFiles([]);
      return;
    }
    if (connectionState !== 'connected') {
      status.textContent = '에이전트 서버 연결을 기다리는 중입니다.';
      renderFiles(filesByScope.get(activeScope) ?? []);
      return;
    }
    status.textContent = '참고자료 불러오는 중…';
    try {
      const files = await bridge.listReferences(target.scope, target.scopeId);
      if (disposed || revision !== requestRevision) return;
      filesByScope.set(target.scope, files);
      renderFiles(files);
      status.textContent = `${files.length}개 참고자료`;
    } catch (caught) {
      if (disposed || revision !== requestRevision) return;
      renderFiles(filesByScope.get(activeScope) ?? []);
      showError(errorMessage(caught));
      status.textContent = '참고자료를 불러오지 못했습니다.';
    }
  }

  async function refreshCounts(): Promise<void> {
    if (connectionState !== 'connected') return;
    const revision = ++countRevision;
    const context = options.getContext();
    const targets = (['chat', 'document', 'global'] as const)
      .map((scope) => targetFor(scope, context))
      .filter((target): target is ScopeTarget => target !== null);
    const settled = await Promise.allSettled(
      targets.map(async (target) => ({
        scope: target.scope,
        files: await bridge.listReferences(target.scope, target.scopeId),
      })),
    );
    if (disposed || revision !== countRevision) return;
    let total = 0;
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      filesByScope.set(result.value.scope, result.value.files);
      total += result.value.files.length;
    }
    count.textContent = String(total);
    trigger.setAttribute('aria-label', `참고자료 열기, ${total}개 연결됨`);
  }

  async function runSearch(): Promise<void> {
    const query = search.value.trim();
    if (!query) {
      await refreshActiveScope();
      return;
    }
    const target = scopeTarget();
    if (!target || connectionState !== 'connected') return;
    const revision = ++requestRevision;
    showError();
    status.textContent = `“${query}” 내용 검색 중…`;
    try {
      const hits = await bridge.searchReferences(query, target.scope, target.scopeId, 20);
      if (disposed || revision !== requestRevision) return;
      renderSearchHits(hits);
      status.textContent = `${hits.length}개 내용 일치`;
    } catch (caught) {
      if (disposed || revision !== requestRevision) return;
      showError(errorMessage(caught));
      status.textContent = '참고자료 내용을 검색하지 못했습니다.';
    }
  }

  function validateFiles(files: File[]): File[] {
    showError();
    if (files.length > MAX_FILES_PER_PICK) {
      showError(`한 번에 최대 ${MAX_FILES_PER_PICK}개까지 추가할 수 있습니다.`);
    }
    const accepted: File[] = [];
    for (const file of files.slice(0, MAX_FILES_PER_PICK)) {
      const dot = file.name.lastIndexOf('.');
      const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
      if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
        showError(`${file.name}: 지원하지 않는 파일 형식입니다.`);
      } else if (file.size === 0) {
        showError(`${file.name}: 빈 파일은 추가할 수 없습니다.`);
      } else if (file.size > MAX_FILE_BYTES) {
        showError(`${file.name}: 파일 하나는 20 MB 이하여야 합니다.`);
      } else {
        accepted.push(file);
      }
    }
    return accepted;
  }

  type UploadChip = {
    root: HTMLElement;
    state: HTMLElement;
    retry: HTMLButtonElement;
  };

  function pendingChip(file: File, target: ScopeTarget): UploadChip {
    // Keep the scope snapshot with this specific upload. A retry after the user
    // changes chat or document must never silently attach to the new context.
    const retryTarget = { ...target };
    const root = el('span', 'ag-reference-upload-chip');
    const state = el('span', 'ag-reference-upload-chip-state', '업로드 중');
    const retry = el('button', 'ag-reference-upload-retry', '다시 시도');
    retry.type = 'button';
    retry.hidden = true;
    retry.setAttribute('aria-label', `${file.name} 참고자료 업로드 다시 시도`);
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      showError();
      status.textContent = `${file.name} 다시 업로드 중…`;
      try {
        await uploadOne(file, retryTarget, { root, state, retry });
        status.textContent = `${file.name} 참고자료를 추가했습니다.`;
        await Promise.all([refreshCounts(), open ? refreshActiveScope() : Promise.resolve()]);
      } catch (caught) {
        showError(`${file.name} 파일을 추가하지 못했습니다. 다시 시도하거나 파일을 다시 추가해 주세요. ${errorMessage(caught)}`);
        status.textContent = `${file.name} 업로드 실패`;
      }
    });
    root.append(
      createIcon('document'),
      el('span', 'ag-reference-upload-chip-name', file.name),
      state,
      retry,
    );
    quickUploads.appendChild(root);
    return { root, state, retry };
  }

  async function uploadOne(file: File, target: ScopeTarget, chip: UploadChip | null): Promise<ReferenceFile> {
    if (chip) {
      chip.root.classList.remove('ag-ready', 'ag-error');
      chip.root.removeAttribute('title');
      chip.state.textContent = '업로드 중';
      chip.retry.hidden = true;
    }
    try {
      const uploaded = await bridge.uploadReference(target.scope, target.scopeId, file);
      if (chip) {
        chip.root.classList.add('ag-ready');
        chip.state.textContent = STATUS_LABEL[uploaded.status];
        window.setTimeout(() => chip.root.remove(), 4000);
      }
      return uploaded;
    } catch (caught) {
      if (chip) {
        chip.root.classList.add('ag-error');
        chip.state.textContent = '실패';
        chip.root.title = errorMessage(caught);
        chip.retry.hidden = false;
        chip.retry.disabled = false;
      }
      throw caught;
    }
  }

  async function uploadFiles(files: File[], target: ScopeTarget, quick: boolean): Promise<void> {
    const accepted = validateFiles(files);
    if (accepted.length === 0) return;
    status.textContent = `${accepted.length}개 파일 업로드 중…`;
    const work = accepted.map(async (file) => {
      const targetSnapshot = { ...target };
      const chip = quick ? pendingChip(file, targetSnapshot) : null;
      return uploadOne(file, targetSnapshot, chip);
    });
    const settled = await Promise.allSettled(work);
    const failed = settled.filter((entry) => entry.status === 'rejected');
    if (failed.length > 0) {
      const first = failed[0] as PromiseRejectedResult;
      showError(`${failed.length}개 파일을 추가하지 못했습니다. 다시 시도하거나 파일을 다시 추가해 주세요. ${errorMessage(first.reason)}`);
      status.textContent = `${settled.length - failed.length}개 추가, ${failed.length}개 실패`;
    } else {
      status.textContent = `${settled.length}개 참고자료를 추가했습니다.`;
    }
    await Promise.all([refreshCounts(), open ? refreshActiveScope() : Promise.resolve()]);
  }

  function openPicker(target: ScopeTarget | null): void {
    if (!target || connectionState !== 'connected') return;
    pickerTarget = target;
    fileInput.click();
  }

  function setOpen(next: boolean, scope: ReferenceScope = activeScope): void {
    if (disposed) return;
    if (next && scope === 'document' && !options.getContext().documentId) scope = 'chat';
    activeScope = scope;
    open = next;
    page.setAttribute('aria-hidden', next ? 'false' : 'true');
    page.inert = !next;
    trigger.setAttribute('aria-expanded', next ? 'true' : 'false');
    updateTabs();
    options.onOpenChange?.(next);
    if (next) {
      lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
      void refreshActiveScope();
      window.requestAnimationFrame(() => search.focus());
    } else {
      search.value = '';
      showError();
    }
  }

  trigger.addEventListener('click', () => setOpen(true));
  close.addEventListener('click', () => {
    setOpen(false);
    (lastFocus?.isConnected ? lastFocus : trigger)?.focus();
  });
  quickAddButton.addEventListener('click', () => {
    openPicker(targetFor('chat', options.getContext()));
  });
  add.addEventListener('click', () => openPicker(scopeTarget()));
  fileInput.addEventListener('change', () => {
    const selected = [...(fileInput.files ?? [])];
    const target = pickerTarget;
    const quick = target?.scope === 'chat' && !open;
    pickerTarget = null;
    fileInput.value = '';
    if (target) void uploadFiles(selected, target, quick);
  });
  search.addEventListener('input', () => {
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = null;
      void runSearch();
    }, SEARCH_DEBOUNCE_MS);
  });
  tabs.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const available = (['chat', 'document', 'global'] as const)
      .filter((scope) => !tabButtons.get(scope)!.disabled);
    const current = available.indexOf(activeScope);
    const next = event.key === 'Home'
      ? available[0]
      : event.key === 'End'
        ? available[available.length - 1]
        : available[(current + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length];
    if (!next) return;
    event.preventDefault();
    selectScope(next);
    tabButtons.get(next)?.focus();
  });
  page.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setOpen(false);
    trigger.focus();
  });
  for (const type of ['dragenter', 'dragover']) {
    page.addEventListener(type, (event) => {
      if (!open || !scopeTarget()) return;
      event.preventDefault();
      page.classList.add('ag-dragging');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    page.addEventListener(type, (event) => {
      event.preventDefault();
      page.classList.remove('ag-dragging');
    });
  }
  page.addEventListener('drop', (event) => {
    const target = scopeTarget();
    if (target && connectionState === 'connected') {
      void uploadFiles([...(event.dataTransfer?.files ?? [])], target, false);
    }
  });

  updateTabs();
  void refreshCounts();

  return {
    page,
    trigger,
    quickAddButton,
    quickUploads,
    isOpen: () => open,
    setOpen,
    setConnectionState(state): void {
      connectionState = state;
      updateAvailability();
      if (state === 'connected') void refreshCounts();
      else if (open) status.textContent = '에이전트 서버 연결을 기다리는 중입니다.';
    },
    contextChanged(): void {
      requestRevision++;
      countRevision++;
      filesByScope.clear();
      if (activeScope === 'document' && !options.getContext().documentId) activeScope = 'chat';
      updateTabs();
      void refreshCounts();
      if (open) void refreshActiveScope();
    },
    async refresh(): Promise<void> {
      await Promise.all([refreshCounts(), open ? refreshActiveScope() : Promise.resolve()]);
    },
    dispose(): void {
      disposed = true;
      requestRevision++;
      countRevision++;
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      page.remove();
      fileInput.remove();
    },
  };
}

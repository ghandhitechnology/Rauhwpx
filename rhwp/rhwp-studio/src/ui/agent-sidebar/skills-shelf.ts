import type {
  CatalogRow,
  HarnessSkillRow,
  ProductSkillIcon,
  SkillCommitChange,
  SkillCommitOutcome,
  SkillHarnessId,
  SkillEditorDocument,
} from '../../agent/types.ts';
import { createIcon } from './icons.ts';
import { PRODUCT_SKILL_ICONS, skillGlyphForSkill } from './skill-presentation.ts';
import { createNewSkillEditor, createSkillEditor } from './skill-editor.ts';

export interface SkillsShelf {
  root: HTMLElement;
  setCatalog(rows: CatalogRow[]): void;
  setHarness(rows: HarnessSkillRow[]): void;
  applyOutcome(outcome: SkillCommitOutcome): void;
  setStatus(message: string): void;
  showCatalog(): void;
  focusSearch(): void;
}

type ShelfMode = 'catalog' | 'harness';

type PendingChange =
  | { action: 'create'; name: string }
  | { action: 'icon'; name: string; icon: ProductSkillIcon }
  | { action: 'enable'; name: string }
  | { action: 'delete'; name: string }
  | { action: 'restore'; name: string }
  | { action: 'import'; harness: SkillHarnessId; name: string };

export function createSkillsShelf(options: {
  onCommit(change: SkillCommitChange): void;
  onListHarness(): void;
  readEditor(name: string): Promise<SkillEditorDocument | null>;
  saveEditor(name: string, body: string, base: string): Promise<SkillCommitOutcome | null>;
  refresh(): void;
}): SkillsShelf {
  const root = el('div', 'ag-skills-shelf');
  const toolbar = el('div', 'ag-skills-toolbar');
  const search = el('input', 'ag-skills-search') as HTMLInputElement;
  search.type = 'search';
  search.placeholder = '검색';
  search.setAttribute('aria-label', '검색');
  const modeButton = el('button', 'ag-skill-text', '가져오기');
  modeButton.type = 'button';
  modeButton.setAttribute('aria-expanded', 'false');
  modeButton.setAttribute('aria-controls', 'ag-skills-import-panel');
  const importPanel = el('div', 'ag-skills-import-panel');
  importPanel.id = 'ag-skills-import-panel';
  importPanel.hidden = true;
  const importList = el('div', 'ag-skills-import-list');
  importPanel.appendChild(importList);
  toolbar.append(search, modeButton);
  const status = el('div', 'ag-skills-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const list = el('div', 'ag-skills-list');
  root.append(toolbar, status, importPanel, list);

  let mode: ShelfMode = 'catalog';
  let rows: CatalogRow[] = [];
  let harnessRows: HarnessSkillRow[] = [];
  let undoName: string | null = null;
  let pending: PendingChange | null = null;
  let importedName: string | null = null;
  let focusName: string | null = null;
  let draggingName: string | null = null;
  let dragOriginalNames: string[] = [];
  const orderStorageKey = 'rhwp-skill-order';
  const replaceDigests = new Map<string, string>();
  let reflowFrame: number | null = null;
  const reflowAnimations = new Set<Animation>();
  const editors = new Map<string, HTMLElement>();
  let newEditor: HTMLElement | null = null;
  let createResolve: ((outcome: SkillCommitOutcome) => void) | null = null;
  let activeIconPicker: HTMLElement | null = null;
  let activeIconPickerClose: (() => void) | null = null;

  search.addEventListener('input', () => render());
  modeButton.addEventListener('click', () => {
    const before = capturePositions();
    if (mode === 'harness') {
      showCatalog(before);
      return;
    }
    mode = 'harness';
    modeButton.setAttribute('aria-expanded', 'true');
    importPanel.hidden = false;
    importPanel.classList.add('ag-skills-import-open');
    render(before);
    options.onListHarness();
  });

  function capturePositions(): Map<string, DOMRect> {
    cancelReflowAnimations();
    const positions = new Map<string, DOMRect>();
    for (const item of list.querySelectorAll<HTMLElement>('[data-skill-name]')) {
      if (item.dataset.skillName) positions.set(item.dataset.skillName, item.getBoundingClientRect());
    }
    return positions;
  }

  function cancelReflowAnimations(): void {
    if (reflowFrame !== null) {
      cancelAnimationFrame(reflowFrame);
      reflowFrame = null;
    }
    for (const animation of reflowAnimations) animation.cancel();
    reflowAnimations.clear();
  }

  function showCatalog(before?: Map<string, DOMRect>): void {
    mode = 'catalog';
    modeButton.setAttribute('aria-expanded', 'false');
    importPanel.hidden = true;
    importPanel.classList.remove('ag-skills-import-open');
    render(before);
  }

  function query(): string {
    return search.value.trim().toLowerCase();
  }

  function render(before?: Map<string, DOMRect>): void {
    modeButton.textContent = mode === 'harness' ? '닫기' : '가져오기';
    if (mode === 'harness') {
      renderHarness();
    }
    renderCatalog(before);
  }

  function storedOrder(): string[] {
    try {
      const value = JSON.parse(localStorage.getItem(orderStorageKey) ?? '[]');
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  function writeStoredOrder(order: string[]): void {
    try {
      localStorage.setItem(orderStorageKey, JSON.stringify(order));
    } catch {
      // Storage can be unavailable in private or restricted browsing contexts.
    }
  }

  function sortByStoredOrder(next: CatalogRow[]): CatalogRow[] {
    const order = storedOrder();
    if (order.length === 0) return next;
    const rank = new Map(order.map((name, index) => [name, index]));
    return [...next].sort((a, b) => {
      const aRank = a.name === importedName ? -1 : (rank.get(a.name) ?? next.length);
      const bRank = b.name === importedName ? -1 : (rank.get(b.name) ?? next.length);
      return aRank - bRank;
    });
  }

  function rememberOrder(): void {
    const visibleNames = [...list.querySelectorAll<HTMLElement>('[data-skill-name]')]
      .map((item) => item.dataset.skillName)
      .filter((name): name is string => Boolean(name));
    if (visibleNames.length === 0) return;
    const visible = new Set(visibleNames);
    const allNames = sortByStoredOrder(rows).map((row) => row.name);
    let visibleIndex = 0;
    const names = allNames.map((name) => visible.has(name) ? visibleNames[visibleIndex++] : name);
    writeStoredOrder(names);
  }

  function animateReflow(before: Map<string, DOMRect>): void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (reflowFrame !== null) cancelAnimationFrame(reflowFrame);
    reflowFrame = requestAnimationFrame(() => {
      reflowFrame = null;
      for (const item of list.querySelectorAll<HTMLElement>('[data-skill-name]')) {
        const name = item.dataset.skillName;
        const old = name ? before.get(name) : undefined;
        if (!old) continue;
        const next = item.getBoundingClientRect();
        const dx = old.left - next.left;
        const dy = old.top - next.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        const animation = item.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 390, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        );
        reflowAnimations.add(animation);
        const forget = () => reflowAnimations.delete(animation);
        animation.addEventListener('finish', forget, { once: true });
        animation.addEventListener('cancel', forget, { once: true });
      }
    });
  }

  function renderCatalog(previousPositions?: Map<string, DOMRect>): void {
    const before = previousPositions ?? capturePositions();
    activeIconPickerClose?.();
    activeIconPicker = null;
    list.replaceChildren();
    const needle = query();
    const visible = sortByStoredOrder(rows).filter((row) => !needle || `${row.name} ${row.description}`.toLowerCase().includes(needle));
    if (undoName) {
      const undo = el('button', 'ag-skill-text', '되돌리기');
      undo.type = 'button';
      const name = undoName;
      undo.addEventListener('click', () => {
        pending = { action: 'restore', name };
        options.onCommit({ action: 'restore', name });
      });
      list.appendChild(undo);
    }
    if (visible.length === 0) list.appendChild(el('div', 'ag-skills-empty', '없음'));
    else for (const skill of visible) list.appendChild(renderCatalogRow(skill));
    const create = el('button', 'ag-skill-new', '새 스킬 만들기') as HTMLButtonElement;
    create.type = 'button';
    create.hidden = editors.size > 0 || Boolean(newEditor);
    create.setAttribute('aria-label', '새 스킬 만들기');
    create.addEventListener('click', openNewEditor);
    list.appendChild(create);
    if (newEditor) list.appendChild(newEditor);
    animateReflow(before);
    if (importedName && visible.some((skill) => skill.name === importedName)) {
      const name = importedName;
      importedName = null;
      const row = list.querySelector<HTMLElement>(`[data-skill-name="${CSS.escape(name)}"]`);
      if (row) {
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          row.animate(
            [
              { opacity: 0, transform: 'translateY(-8px) scale(0.98)' },
              { opacity: 1, transform: 'translateY(0) scale(1)' },
            ],
            { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
          );
        }
        row.classList.add('ag-skill-imported');
        requestAnimationFrame(() => row.classList.add('ag-skill-import-settled'));
      }
    }
    if (focusName && visible.some((skill) => skill.name === focusName)) {
      const name = focusName;
      const focusCopy = () => list
        .querySelector<HTMLElement>(`[data-skill-name="${CSS.escape(name)}"]`)
        ?.querySelector<HTMLButtonElement>('.ag-skill-copy');
      focusCopy()?.focus();
      requestAnimationFrame(() => {
        if (focusName !== name) return;
        focusName = null;
        focusCopy()?.focus();
      });
    }
  }

  function closeNewEditor(): void {
    newEditor?.remove();
    newEditor = null;
    syncCreateButtonVisibility();
  }

  function syncCreateButtonVisibility(): void {
    const create = list.querySelector<HTMLButtonElement>('.ag-skill-new');
    if (create) create.hidden = editors.size > 0 || Boolean(newEditor);
  }

  function openNewEditor(): void {
    if (newEditor) {
      newEditor.querySelector<HTMLInputElement>('.ag-skill-editor-name')?.focus();
      return;
    }
    const editor = createNewSkillEditor({
      commit(name, description, body) {
        return new Promise((resolve) => {
          createResolve = resolve;
          pending = { action: 'create', name };
          options.onCommit({ action: 'create', name, description, body });
        });
      },
      close: closeNewEditor,
      saved(outcome) {
        const name = outcome.name;
        closeNewEditor();
        focusName = name;
        options.refresh();
      },
    });
    newEditor = editor.root;
    render();
    editor.root.querySelector<HTMLInputElement>('.ag-skill-editor-name')?.focus();
  }

  function renderCatalogRow(skill: CatalogRow): HTMLElement {
    const item = el('article', 'ag-skill-item');
    item.dataset.skillName = skill.name;
    if (!skill.enabled) item.classList.add('ag-skill-disabled');
    if (skill.kind === 'broken') item.title = skill.description;
    const copy = el('button', 'ag-skill-copy') as HTMLButtonElement;
    copy.type = 'button';
    copy.setAttribute('aria-expanded', 'false');
    const copyIcon = el('span', 'ag-skill-kind-icon');
    copyIcon.appendChild(createIcon(skillGlyphForSkill(skill)));
    if (skill.kind === 'skill' && skill.origin === 'user' && skill.editable === true) {
      copyIcon.classList.add('ag-skill-icon-button');
      copyIcon.setAttribute('role', 'button');
      copyIcon.setAttribute('tabindex', '0');
      copyIcon.setAttribute('aria-label', `${skill.name} 아이콘 선택`);
      copyIcon.setAttribute('aria-haspopup', 'dialog');
      copyIcon.setAttribute('aria-expanded', 'false');
      const open = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        openIconPicker(skill, item, copyIcon);
      };
      copyIcon.addEventListener('click', open);
      copyIcon.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        open(event);
      });
    }
    const copyText = el('span', 'ag-skill-copy-text');
    copyText.append(
      el('strong', 'ag-skill-item-name', skill.name),
      el('span', 'ag-skill-item-description', skill.description),
    );
    copy.append(copyIcon, copyText);
    copy.addEventListener('click', () => {
      const before = capturePositions();
      const expanded = item.classList.toggle('ag-skill-expanded');
      if (expanded) {
        for (const other of list.querySelectorAll<HTMLElement>('.ag-skill-item.ag-skill-expanded')) {
          if (other === item) continue;
          other.classList.remove('ag-skill-expanded');
          other.querySelector<HTMLButtonElement>('.ag-skill-copy')?.setAttribute('aria-expanded', 'false');
        }
      }
      copy.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      animateReflow(before);
    });
    const actions = el('div', 'ag-skill-item-actions');
    switch (skill.kind) {
      case 'sealed':
        break;
      case 'skill':
        if (skill.editable === true) {
          const edit = el('button', 'ag-skill-text ag-skill-edit', '편집');
          edit.type = 'button';
          edit.setAttribute('aria-label', `${skill.name} 편집`);
          edit.addEventListener('click', () => {
            activeIconPickerClose?.();
            const existing = editors.get(skill.name);
            if (existing) { existing.querySelector('textarea')?.focus(); return; }
            const close = () => {
              editors.get(skill.name)?.remove();
              editors.delete(skill.name);
              syncCreateButtonVisibility();
              edit.focus();
            };
            const editor = createSkillEditor({
              name: skill.name,
              async read() {
                const value = await options.readEditor(skill.name);
                if (!value) throw new Error('Read failed');
                return value;
              },
              async save(body, base) {
                const value = await options.saveEditor(skill.name, body, base);
                if (!value) throw new Error('Save failed');
                return value;
              },
              close,
              saved() { close(); options.refresh(); },
            });
            editors.set(skill.name, editor.root);
            item.appendChild(editor.root);
            syncCreateButtonVisibility();
          });
          actions.appendChild(edit);
        }
        actions.appendChild(renderSwitch(skill.name, skill.enabled));
        if (skill.origin === 'user') actions.appendChild(renderDelete(skill.name, skill.digest));
        break;
      case 'broken':
        actions.appendChild(renderDelete(skill.name, skill.digest));
        break;
      default: {
        const unknown: never = skill;
        return unknown;
      }
    }
    actions.appendChild(renderDragHandle(item, skill.name));
    item.append(copy, actions);
    const editor = editors.get(skill.name);
    if (editor) item.appendChild(editor);
    return item;
  }

  function openIconPicker(skill: Extract<CatalogRow, { kind: 'skill' }>, item: HTMLElement, anchor: HTMLElement): void {
    if (activeIconPicker && item.contains(activeIconPicker)) {
      activeIconPickerClose?.();
      return;
    }
    activeIconPickerClose?.();
    if (item.querySelector('.ag-skill-icon-picker')) {
      activeIconPicker = null;
      return;
    }
    const picker = el('div', 'ag-skill-icon-picker') as HTMLDivElement;
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', `${skill.name} 아이콘 선택`);
    const grid = el('div', 'ag-skill-icon-picker-grid');
    const selectedIcon = skillGlyphForSkill(skill);
    for (const icon of PRODUCT_SKILL_ICONS) {
      const option = el('button', 'ag-skill-icon-option') as HTMLButtonElement;
      option.type = 'button';
      option.dataset.skillIcon = icon.value;
      option.title = icon.label;
      option.setAttribute('aria-label', icon.label);
      option.setAttribute('aria-pressed', selectedIcon === icon.value ? 'true' : 'false');
      option.appendChild(createIcon(icon.value));
      option.addEventListener('click', (event) => {
        event.stopPropagation();
        activeIconPickerClose?.();
        pending = { action: 'icon', name: skill.name, icon: icon.value };
        options.onCommit({ action: 'icon', name: skill.name, icon: icon.value, base: skill.digest });
      });
      grid.appendChild(option);
    }
    picker.append(grid);
    item.appendChild(picker);
    activeIconPicker = picker;
    anchor.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
      if (activeIconPicker !== picker) return;
      const first = picker.querySelector<HTMLButtonElement>(`[aria-pressed="true"]`)
        ?? picker.querySelector<HTMLButtonElement>('button');
      first?.focus();
    });
    let closeOnEscape: ((event: KeyboardEvent) => void) | null = null;
    const close = () => {
      if (activeIconPicker !== picker) return;
      activeIconPicker = null;
      picker.remove();
      anchor.setAttribute('aria-expanded', 'false');
      if (closeOnEscape) window.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('pointerdown', closeOnPointerDown, true);
      activeIconPickerClose = null;
    };
    closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || activeIconPicker !== picker) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      anchor.focus();
    };
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (picker.contains(target) || anchor.contains(target))) return;
      close();
    };
    activeIconPickerClose = close;
    window.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('pointerdown', closeOnPointerDown, true);
  }

  function renderDragHandle(item: HTMLElement, name: string): HTMLButtonElement {
    const handle = el('button', 'ag-skill-drag-handle') as HTMLButtonElement;
    handle.type = 'button';
    handle.setAttribute('aria-label', `${name} 순서 이동`);
    handle.title = '드래그해서 순서 변경';
    handle.appendChild(createIcon('grip'));
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const sibling = event.key === 'ArrowUp' ? item.previousElementSibling : item.nextElementSibling;
      if (!(sibling instanceof HTMLElement) || !sibling.dataset.skillName) return;
      const before = capturePositions();
      if (event.key === 'ArrowUp') list.insertBefore(item, sibling);
      else list.insertBefore(sibling, item);
      rememberOrder();
      animateReflow(before);
      item.classList.add('ag-skill-drag-settled');
      window.setTimeout(() => item.classList.remove('ag-skill-drag-settled'), 420);
      handle.focus();
    });
    handle.addEventListener('pointerdown', (event) => beginDrag(event, item));
    return handle;
  }

  function beginDrag(event: PointerEvent, item: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault();
    cancelReflowAnimations();
    draggingName = item.dataset.skillName ?? null;
    dragOriginalNames = [...list.querySelectorAll<HTMLElement>('[data-skill-name]')]
      .map((candidate) => candidate.dataset.skillName)
      .filter((name): name is string => Boolean(name));
    const pointerId = event.pointerId;
    const grabOffset = event.clientY - item.getBoundingClientRect().top;
    let dragTranslateY = 0;
    item.style.top = '0px';
    item.classList.add('ag-skill-dragging');
    root.classList.add('ag-skills-dragging');
    const move = (moveEvent: PointerEvent) => {
      if (!draggingName || moveEvent.pointerId !== pointerId) return;
      let moved = false;
      let next = item.nextElementSibling as HTMLElement | null;
      while (next?.dataset.skillName && moveEvent.clientY >= next.getBoundingClientRect().top + next.getBoundingClientRect().height / 2) {
        list.insertBefore(next, item);
        moved = true;
        next = item.nextElementSibling as HTMLElement | null;
      }
      let previous = item.previousElementSibling as HTMLElement | null;
      while (previous?.dataset.skillName && moveEvent.clientY <= previous.getBoundingClientRect().top + previous.getBoundingClientRect().height / 2) {
        list.insertBefore(item, previous);
        moved = true;
        previous = item.previousElementSibling as HTMLElement | null;
      }
      const nextTop = item.getBoundingClientRect().top - dragTranslateY;
      dragTranslateY = moveEvent.clientY - grabOffset - nextTop;
      item.style.top = `${dragTranslateY}px`;
      if (moved) item.classList.add('ag-skill-dragging');
    };
    let ended = false;
    const end = (endEvent?: PointerEvent) => {
      if (ended) return;
      if (endEvent && endEvent.pointerId !== pointerId) return;
      ended = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', cancel, true);
      item.classList.remove('ag-skill-dragging');
      root.classList.remove('ag-skills-dragging');
      item.style.removeProperty('top');
      rememberOrder();
      item.classList.add('ag-skill-drag-settled');
      window.setTimeout(() => item.classList.remove('ag-skill-drag-settled'), 420);
      draggingName = null;
      dragOriginalNames = [];
    };
    const cancel = (cancelEvent: KeyboardEvent) => {
      if (cancelEvent.key !== 'Escape' || !draggingName) return;
      cancelEvent.preventDefault();
      cancelEvent.stopPropagation();
      const byName = new Map([...list.querySelectorAll<HTMLElement>('[data-skill-name]')]
        .map((candidate) => [candidate.dataset.skillName, candidate] as const));
      for (const name of dragOriginalNames) {
        const candidate = byName.get(name);
        if (candidate) list.appendChild(candidate);
      }
      end();
    };
    window.addEventListener('pointermove', move);
    try { item.setPointerCapture(event.pointerId); } catch { /* Pointer capture is unavailable in some test drivers. */ }
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', cancel, true);
  }

  function renderSwitch(name: string, enabled: boolean): HTMLButtonElement {
    const toggle = el('button', 'ag-skill-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', '사용');
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    toggle.addEventListener('click', () => {
      const nextEnabled = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', nextEnabled ? 'true' : 'false');
      toggle.closest<HTMLElement>('[data-skill-name]')?.classList.toggle('ag-skill-disabled', !nextEnabled);
      pending = { action: 'enable', name };
      options.onCommit({ action: 'enable', name, enabled: nextEnabled });
    });
    return toggle;
  }

  function renderDelete(name: string, digest: string): HTMLButtonElement {
    const remove = el('button', 'ag-skill-text', '삭제');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      pending = { action: 'delete', name };
      options.onCommit({ action: 'delete', name, base: digest });
    });
    return remove;
  }

  function renderHarness(): void {
    importList.replaceChildren();
    const needle = query();
    const visible = harnessRows.filter((row) => !needle || `${row.name} ${row.description}`.toLowerCase().includes(needle));
    if (visible.length === 0) {
      importList.appendChild(el('div', 'ag-skills-empty', '가져올 스킬이 없습니다'));
      return;
    }
    for (const row of visible) {
      const item = el('button', 'ag-skill-import-row');
      item.type = 'button';
      item.dataset.skillName = row.name;
      const copyText = el('span', 'ag-skill-copy-text');
      copyText.append(
        el('strong', 'ag-skill-item-name', row.name),
        el('span', 'ag-skill-item-description', row.description),
      );
      item.appendChild(copyText);
      item.addEventListener('click', () => {
        const key = `${row.harness}:${row.name}`;
        const base = replaceDigests.get(key);
        pending = { action: 'import', harness: row.harness, name: row.name };
        if (base) {
          options.onCommit({ action: 'import', harness: row.harness, name: row.name, mode: 'replace', base });
          return;
        }
        options.onCommit({ action: 'import', harness: row.harness, name: row.name, mode: 'adopt' });
      });
      importList.appendChild(item);
    }
  }

  function applyOutcome(outcome: SkillCommitOutcome): void {
    const current = pending;
    pending = null;
    if (!current) return;
    switch (current.action) {
      case 'create': {
        createResolve?.(outcome);
        createResolve = null;
        if (outcome.ok) {
          importedName = current.name;
          focusName = current.name;
          writeStoredOrder([
            current.name,
            ...storedOrder().filter((name) => name !== current.name),
          ]);
          closeNewEditor();
        }
        break;
      }
      case 'icon':
        break;
      case 'import':
        if (!outcome.ok && outcome.code === 'LOCAL_EDITS' && outcome.digest) {
          replaceDigests.set(`${current.harness}:${current.name}`, outcome.digest);
        } else if (outcome.ok) {
          replaceDigests.delete(`${current.harness}:${current.name}`);
          importedName = current.name;
          focusName = current.name;
          writeStoredOrder([
            current.name,
            ...storedOrder().filter((name) => name !== current.name),
          ]);
          showCatalog();
        }
        break;
      case 'delete':
        if (outcome.ok) undoName = current.name;
        break;
      case 'restore':
        if (outcome.ok) undoName = null;
        break;
      case 'enable':
        break;
      default: {
        const unknown: never = current;
        void unknown;
        break;
      }
    }
    status.textContent = outcome.ok ? '' : outcome.message;
    if (current.action !== 'enable') render();
  }

  function setStatus(message: string): void {
    status.textContent = message;
  }

  render();

  return {
    root,
    setCatalog(next) {
      const previousNames = [...list.querySelectorAll<HTMLElement>('[data-skill-name]')]
        .map((item) => item.dataset.skillName)
        .filter((name): name is string => Boolean(name));
      const needle = query();
      const nextNames = sortByStoredOrder(next)
        .filter((item) => !needle || `${item.name} ${item.description}`.toLowerCase().includes(needle))
        .map((item) => item.name);
      rows = next;
      if (mode === 'catalog') {
        if (previousNames.length === nextNames.length && previousNames.every((name, index) => name === nextNames[index])) {
          for (const row of next) {
            const item = list.querySelector<HTMLElement>(`[data-skill-name="${CSS.escape(row.name)}"]`);
            const toggle = item?.querySelector<HTMLButtonElement>('.ag-skill-toggle');
            if (toggle) {
              toggle.setAttribute('aria-pressed', row.enabled ? 'true' : 'false');
              toggle.disabled = row.kind !== 'skill';
              item?.classList.toggle('ag-skill-disabled', !row.enabled);
            }
          }
        } else render();
      }
    },
    setHarness(next) {
      harnessRows = next;
      if (mode === 'harness') render();
    },
    applyOutcome,
    setStatus,
    showCatalog,
    focusSearch() {
      search.focus();
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

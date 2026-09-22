import type {
  CatalogRow,
  HarnessSkillRow,
  SkillCommitChange,
  SkillCommitOutcome,
  SkillHarnessId,
} from '../../agent/types.ts';
import { createIcon } from './icons.ts';
import { skillGlyphForSkill } from './skill-presentation.ts';

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
  | { action: 'enable'; name: string }
  | { action: 'delete'; name: string }
  | { action: 'restore'; name: string }
  | { action: 'import'; harness: SkillHarnessId; name: string };

export function createSkillsShelf(options: {
  onCommit(change: SkillCommitChange): void;
  onListHarness(): void;
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
    const positions = new Map<string, DOMRect>();
    for (const item of list.querySelectorAll<HTMLElement>('[data-skill-name]')) {
      if (item.dataset.skillName) positions.set(item.dataset.skillName, item.getBoundingClientRect());
    }
    return positions;
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
    const names = [...list.querySelectorAll<HTMLElement>('[data-skill-name]')]
      .map((item) => item.dataset.skillName)
      .filter((name): name is string => Boolean(name));
    if (names.length > 0) localStorage.setItem(orderStorageKey, JSON.stringify(names));
  }

  function animateReflow(before: Map<string, DOMRect>): void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    requestAnimationFrame(() => {
      for (const item of list.querySelectorAll<HTMLElement>('[data-skill-name]')) {
        const name = item.dataset.skillName;
        const old = name ? before.get(name) : undefined;
        if (!old) continue;
        const next = item.getBoundingClientRect();
        const dx = old.left - next.left;
        const dy = old.top - next.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        item.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 390, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        );
      }
    });
  }

  function renderCatalog(previousPositions?: Map<string, DOMRect>): void {
    const before = previousPositions ?? capturePositions();
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
    if (visible.length === 0) {
      list.appendChild(el('div', 'ag-skills-empty', '없음'));
      return;
    }
    for (const skill of visible) list.appendChild(renderCatalogRow(skill));
    animateReflow(before);
    if (focusName && visible.some((skill) => skill.name === focusName)) {
      const name = focusName;
      const row = [...list.querySelectorAll<HTMLElement>('[data-skill-name]')]
        .find((candidate) => candidate.dataset.skillName === name);
      row?.querySelector<HTMLButtonElement>('.ag-skill-copy')?.focus();
      requestAnimationFrame(() => {
        const nextRow = [...list.querySelectorAll<HTMLElement>('[data-skill-name]')]
          .find((candidate) => candidate.dataset.skillName === name);
        nextRow?.querySelector<HTMLButtonElement>('.ag-skill-copy')?.focus();
        focusName = null;
      });
    }
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
    const copyText = el('span', 'ag-skill-copy-text');
    copyText.append(
      el('strong', 'ag-skill-item-name', skill.name),
      el('span', 'ag-skill-item-description', skill.description),
    );
    copy.append(copyIcon, copyText);
    copy.addEventListener('click', () => {
      const expanded = item.classList.toggle('ag-skill-expanded');
      copy.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
    const actions = el('div', 'ag-skill-item-actions');
    switch (skill.kind) {
      case 'sealed':
        break;
      case 'skill':
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
    if (importedName === skill.name) {
      item.classList.add('ag-skill-imported');
      importedName = null;
      copy.focus();
      requestAnimationFrame(() => {
        item.classList.add('ag-skill-import-settled');
        copy.focus();
      });
    }
    return item;
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
      if (event.key === 'ArrowUp') list.insertBefore(item, sibling);
      else list.insertBefore(sibling, item);
      rememberOrder();
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
    draggingName = item.dataset.skillName ?? null;
    dragOriginalNames = [...list.querySelectorAll<HTMLElement>('[data-skill-name]')]
      .map((candidate) => candidate.dataset.skillName)
      .filter((name): name is string => Boolean(name));
    const startY = event.clientY;
    item.classList.add('ag-skill-dragging');
    root.classList.add('ag-skills-dragging');
    const move = (moveEvent: PointerEvent) => {
      if (!draggingName) return;
      const next = item.nextElementSibling as HTMLElement | null;
      const previous = item.previousElementSibling as HTMLElement | null;
      const itemRect = item.getBoundingClientRect();
      if (moveEvent.clientY > startY + 8 && next && moveEvent.clientY >= itemRect.bottom - 8) {
        list.insertBefore(next, item);
      } else if (moveEvent.clientY < startY - 8 && previous && moveEvent.clientY <= itemRect.top + 8) {
        list.insertBefore(item, previous);
      }
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('keydown', cancel);
      item.classList.remove('ag-skill-dragging');
      root.classList.remove('ag-skills-dragging');
      rememberOrder();
      item.classList.add('ag-skill-drag-settled');
      window.setTimeout(() => item.classList.remove('ag-skill-drag-settled'), 420);
      draggingName = null;
      dragOriginalNames = [];
    };
    const cancel = (cancelEvent: KeyboardEvent) => {
      if (cancelEvent.key !== 'Escape' || !draggingName) return;
      cancelEvent.preventDefault();
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
    window.addEventListener('pointerup', end, { once: true });
    window.addEventListener('keydown', cancel);
  }

  function renderSwitch(name: string, enabled: boolean): HTMLButtonElement {
    const toggle = el('button', 'ag-skill-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', '사용');
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    toggle.addEventListener('click', () => {
      pending = { action: 'enable', name };
      options.onCommit({ action: 'enable', name, enabled: !enabled });
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
      case 'import':
        if (!outcome.ok && outcome.code === 'LOCAL_EDITS' && outcome.digest) {
          replaceDigests.set(`${current.harness}:${current.name}`, outcome.digest);
        } else if (outcome.ok) {
          replaceDigests.delete(`${current.harness}:${current.name}`);
          importedName = current.name;
          focusName = current.name;
          localStorage.setItem(orderStorageKey, JSON.stringify([
            current.name,
            ...storedOrder().filter((name) => name !== current.name),
          ]));
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
      const nextNames = sortByStoredOrder(next).map((item) => item.name);
      rows = next;
      if (mode === 'catalog') {
        if (previousNames.length === nextNames.length && previousNames.every((name, index) => name === nextNames[index])) {
          for (const row of next) {
            const item = list.querySelector<HTMLElement>(`[data-skill-name="${CSS.escape(row.name)}"]`);
            const toggle = item?.querySelector<HTMLButtonElement>('.ag-skill-toggle');
            if (toggle) {
              toggle.setAttribute('aria-pressed', row.enabled ? 'true' : 'false');
              toggle.disabled = row.kind !== 'skill';
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

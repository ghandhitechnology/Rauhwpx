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
  toolbar.append(search, modeButton);
  const status = el('div', 'ag-skills-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const list = el('div', 'ag-skills-list');
  root.append(toolbar, status, list);

  let mode: ShelfMode = 'catalog';
  let rows: CatalogRow[] = [];
  let harnessRows: HarnessSkillRow[] = [];
  let undoName: string | null = null;
  let pending: PendingChange | null = null;
  const replaceDigests = new Map<string, string>();

  search.addEventListener('input', () => render());
  modeButton.addEventListener('click', () => {
    if (mode === 'harness') {
      showCatalog();
      return;
    }
    mode = 'harness';
    render();
    options.onListHarness();
  });

  function showCatalog(): void {
    mode = 'catalog';
    render();
  }

  function query(): string {
    return search.value.trim().toLowerCase();
  }

  function render(): void {
    modeButton.textContent = mode === 'harness' ? '닫기' : '가져오기';
    list.replaceChildren();
    if (mode === 'harness') {
      renderHarness();
      return;
    }
    renderCatalog();
  }

  function renderCatalog(): void {
    const needle = query();
    const visible = rows.filter((row) => !needle || `${row.name} ${row.description}`.toLowerCase().includes(needle));
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
  }

  function renderCatalogRow(skill: CatalogRow): HTMLElement {
    const item = el('article', 'ag-skill-item');
    if (!skill.enabled) item.classList.add('ag-skill-disabled');
    if (skill.kind === 'broken') item.title = skill.description;
    const copy = el('div', 'ag-skill-copy');
    const copyIcon = el('span', 'ag-skill-kind-icon');
    copyIcon.appendChild(createIcon(skillGlyphForSkill(skill)));
    const copyText = el('span', 'ag-skill-copy-text');
    copyText.append(
      el('strong', 'ag-skill-item-name', skill.name),
      el('span', 'ag-skill-item-description', skill.description),
    );
    copy.append(copyIcon, copyText);
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
    item.append(copy, actions);
    return item;
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
    const needle = query();
    const visible = harnessRows.filter((row) => !needle || `${row.name} ${row.description}`.toLowerCase().includes(needle));
    if (visible.length === 0) {
      list.appendChild(el('div', 'ag-skills-empty', '없음'));
      return;
    }
    for (const row of visible) {
      const item = el('button', 'ag-skill-item ag-skill-copy');
      item.type = 'button';
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
      list.appendChild(item);
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
    render();
  }

  function setStatus(message: string): void {
    status.textContent = message;
  }

  render();

  return {
    root,
    setCatalog(next) {
      rows = next;
      if (mode === 'catalog') render();
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

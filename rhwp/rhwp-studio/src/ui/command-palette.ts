import type { CommandRegistry } from '@/command/registry';
import type { CommandDispatcher } from '@/command/dispatcher';
import type { CommandDef } from '@/command/types';
import { formatShortcutLabel } from '@/engine/navigation-keymap';

/**
 * `/` 커맨드 팔레트
 *
 * Ctrl/Cmd+/ 또는 메뉴 행의 검색 버튼으로 여는 명령 실행창.
 * Notion/Linear/GitHub 패턴: 한글/영문 레이블 + 단축키로 필터링.
 */
export class CommandPalette {
  private overlay: HTMLDivElement | null = null;
  private input: HTMLInputElement | null = null;
  private list: HTMLDivElement | null = null;
  private items: CommandDef[] = [];
  private selectedIdx = 0;
  private captureHandler: ((e: KeyboardEvent) => void) | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(
    private registry: CommandRegistry,
    private dispatcher: CommandDispatcher,
  ) {}

  /** 팔레트를 열고 검색 입력에 포커스 */
  open(): void {
    if (this.overlay) return; // 이미 열림

    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    this.items = this.buildItems();
    this.selectedIdx = 0;

    this.overlay = document.createElement('div');
    this.overlay.className = 'cp-overlay';

    const panel = document.createElement('div');
    panel.className = 'cp-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '명령 검색');

    // 입력 영역
    const inputWrap = document.createElement('div');
    inputWrap.className = 'cp-input-wrap';

    const slash = document.createElement('span');
    slash.className = 'cp-slash';
    slash.setAttribute('aria-hidden', 'true');
    slash.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4" stroke-linecap="round"/></svg>';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'cp-input';
    this.input.placeholder = '명령 검색';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', '명령 검색');
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-controls', 'editor-command-results');

    inputWrap.appendChild(slash);
    inputWrap.appendChild(this.input);
    panel.appendChild(inputWrap);

    // 결과 목록
    this.list = document.createElement('div');
    this.list.className = 'cp-list';
    this.list.id = 'editor-command-results';
    this.list.setAttribute('role', 'listbox');
    panel.appendChild(this.list);

    this.overlay.appendChild(panel);
    document.body.appendChild(this.overlay);

    this.renderList(this.items);

    // 입력 이벤트
    this.input.addEventListener('input', () => {
      const filtered = this.filter(this.input!.value);
      this.selectedIdx = filtered.findIndex(def => this.dispatcher.isEnabled(def.id));
      this.renderList(filtered);
    });

    // 키보드 캡처
    this.captureHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        this.moveSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        this.moveSelection(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.executeSelected();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        this.input?.focus();
        return;
      }
      // 그 외 키는 input으로 전달 허용 — stopPropagation만 (편집 영역 방지)
      e.stopPropagation();
    };
    document.addEventListener('keydown', this.captureHandler, true);

    // 오버레이 바깥 클릭 시 닫기
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });

    this.input.focus();
  }

  close(): void {
    if (this.captureHandler) {
      document.removeEventListener('keydown', this.captureHandler, true);
      this.captureHandler = null;
    }
    this.overlay?.remove();
    this.overlay = null;
    this.input = null;
    this.list = null;
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  isOpen(): boolean {
    return this.overlay !== null;
  }

  // ─── private ────────────────────────────────────────────────

  /** 팔레트에 노출할 커맨드 목록 구성 */
  private buildItems(): CommandDef[] {
    const all: CommandDef[] = [];
    for (const id of this.registry.getAllIds()) {
      const def = this.registry.get(id)!;
      // canExecute는 실행 시점에 dispatcher가 판단하므로 목록에는 전부 포함
      all.push(def);
    }
    return all;
  }

  /** 검색어로 필터링 */
  private filter(query: string): CommandDef[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter(def => {
      if (def.label.toLowerCase().includes(q)) return true;
      if (def.id.toLowerCase().includes(q)) return true;
      if (def.shortcutLabel && (def.shortcutLabel.toLowerCase().includes(q) || formatShortcutLabel(def.shortcutLabel).toLowerCase().includes(q))) return true;
      return false;
    });
  }

  private renderList(filtered: CommandDef[]): void {
    if (!this.list) return;
    this.list.replaceChildren();
    if (this.selectedIdx === 0 && filtered.length > 0 && !this.dispatcher.isEnabled(filtered[0].id)) {
      this.selectedIdx = filtered.findIndex(def => this.dispatcher.isEnabled(def.id));
    }

    if (filtered.length === 0) {
      this.input?.removeAttribute('aria-activedescendant');
      const empty = document.createElement('div');
      empty.className = 'cp-empty';
      empty.textContent = '검색 결과 없음';
      this.list.appendChild(empty);
      return;
    }

    filtered.forEach((def, idx) => {
      const enabled = this.dispatcher.isEnabled(def.id);
      const row = document.createElement('div');
      row.className = 'cp-item' + (idx === this.selectedIdx ? ' cp-item--selected' : '')
        + (enabled ? '' : ' cp-item--disabled');
      row.dataset.idx = String(idx);
      row.id = `editor-command-option-${idx}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(idx === this.selectedIdx));
      row.setAttribute('aria-disabled', String(!enabled));

      const labelEl = document.createElement('span');
      labelEl.className = 'cp-item-label';
      labelEl.textContent = def.label;

      row.appendChild(labelEl);

      if (def.shortcutLabel) {
        const kbd = document.createElement('span');
        kbd.className = 'cp-item-shortcut';
        kbd.textContent = formatShortcutLabel(def.shortcutLabel);
        row.appendChild(kbd);
      }

      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (!enabled) return;
        this.selectedIdx = idx;
        this.executeSelected(filtered);
      });

      row.addEventListener('mousemove', () => {
        if (!enabled) return;
        this.selectedIdx = idx;
        this.updateSelection(filtered.length);
      });

      this.list!.appendChild(row);
    });
    if (this.selectedIdx >= 0) this.input?.setAttribute('aria-activedescendant', `editor-command-option-${this.selectedIdx}`);
    else this.input?.removeAttribute('aria-activedescendant');

    // 현재 선택 항목이 보이도록 스크롤
    this.scrollToSelected();
  }

  private moveSelection(delta: number): void {
    if (!this.list) return;
    const count = this.list.querySelectorAll('.cp-item').length;
    if (count === 0) return;
    let next = this.selectedIdx;
    for (let i = 0; i < count; i++) {
      next = (next + delta + count) % count;
      const row = this.list.querySelectorAll('.cp-item')[next];
      if (row.getAttribute('aria-disabled') !== 'true') {
        this.selectedIdx = next;
        break;
      }
    }
    this.updateSelection(count);
    this.scrollToSelected();
  }

  private updateSelection(count: number): void {
    if (!this.list) return;
    this.list.querySelectorAll('.cp-item').forEach((el, i) => {
      el.classList.toggle('cp-item--selected', i === this.selectedIdx);
      el.setAttribute('aria-selected', String(i === this.selectedIdx));
    });
    if (this.selectedIdx >= 0) this.input?.setAttribute('aria-activedescendant', `editor-command-option-${this.selectedIdx}`);
    else this.input?.removeAttribute('aria-activedescendant');
    void count; // suppress unused warning
  }

  private scrollToSelected(): void {
    if (!this.list) return;
    const sel = this.list.querySelector('.cp-item--selected') as HTMLElement | null;
    sel?.scrollIntoView({ block: 'nearest' });
  }

  private executeSelected(filtered?: CommandDef[]): void {
    const items = filtered ?? this.filter(this.input?.value ?? '');
    const def = items[this.selectedIdx];
    if (!def || !this.dispatcher.isEnabled(def.id)) return;
    this.close();
    this.dispatcher.dispatch(def.id);
  }
}

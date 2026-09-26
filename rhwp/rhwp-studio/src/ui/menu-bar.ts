import type { EventBus } from '@/core/event-bus';
import type { CommandDispatcher } from '@/command/dispatcher';
import type { CommandRegistry } from '@/command/registry';
import { syncMenuShortcutLabels } from './menu-shortcut-labels';

/**
 * 메뉴바 드롭다운 컨트롤러
 *
 * - 메뉴 타이틀 클릭 → 드롭다운 토글
 * - 열린 상태에서 다른 메뉴 hover → 자동 전환
 * - 바깥 클릭 / Escape → 닫기
 * - 항목 클릭 → CommandDispatcher 경유 실행
 * - 드롭다운 열릴 때 컨텍스트 감응 활성/비활성 갱신
 */
/** MenuBar 옵션 */
export interface MenuBarOptions {
  /** 드롭다운 메뉴가 열릴 때 호출 (동적 하위 항목 렌더 등). menuName = data-menu 값. */
  onMenuOpen?: (menuName: string, menuEl: HTMLElement) => void;
}

export class MenuBar {
  private menuItems: HTMLElement[];
  private openMenu: HTMLElement | null = null;
  private returnFocus: HTMLElement | null = null;
  private onMenuOpen?: (menuName: string, menuEl: HTMLElement) => void;

  constructor(
    private container: HTMLElement,
    private eventBus: EventBus,
    private dispatcher: CommandDispatcher,
    registry: CommandRegistry,
    options: MenuBarOptions = {},
  ) {
    this.onMenuOpen = options.onMenuOpen;
    this.menuItems = Array.from(container.querySelectorAll('.menu-item'));
    syncMenuShortcutLabels(container, registry);
    this.setupAccessibility();
    this.setupTitleClicks();
    this.setupTitleHover();
    this.setupItemClicks();
    this.setupPointerHighlight();
    this.setupOutsideClose();
    this.setupKeyboardClose();
  }

  private setupAccessibility(): void {
    this.container.setAttribute('role', 'menubar');
    this.container.querySelector('#editor-command-search')?.setAttribute('role', 'menuitem');
    for (const menu of this.menuItems) {
      const title = menu.querySelector<HTMLElement>('.menu-title');
      const dropdown = menu.querySelector<HTMLElement>('.menu-dropdown');
      if (!title || !dropdown) continue;
      title.tabIndex = 0;
      title.setAttribute('role', 'menuitem');
      title.setAttribute('aria-haspopup', 'menu');
      title.setAttribute('aria-expanded', String(menu === this.openMenu));
      dropdown.setAttribute('role', 'menu');
    }
    this.container.querySelectorAll<HTMLElement>('.md-sub').forEach(sub => {
      sub.tabIndex = -1;
      sub.setAttribute('role', 'menuitem');
      sub.setAttribute('aria-haspopup', 'menu');
      sub.querySelector('.md-sub-panel')?.setAttribute('role', 'menu');
    });
    this.container.querySelectorAll<HTMLElement>('.md-item[data-cmd]').forEach(item => {
      item.tabIndex = -1;
      // 토글·선택 항목(menuitemcheckbox/radio)의 역할은 덮어쓰지 않는다.
      if (!item.hasAttribute('role')) item.setAttribute('role', 'menuitem');
    });
  }

  private showMenu(item: HTMLElement): void {
    if (!this.openMenu) {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    this.openMenu?.classList.remove('open');
    this.openMenu?.querySelector('.menu-title')?.setAttribute('aria-expanded', 'false');
    this.container.querySelectorAll<HTMLElement>('.md-sub-panel').forEach(panel => { panel.style.display = ''; });
    item.classList.add('open');
    item.querySelector('.menu-title')?.setAttribute('aria-expanded', 'true');
    this.openMenu = item;
    this.updateMenuStates(item);
    this.onMenuOpen?.(item.dataset.menu ?? '', item);
    this.setupAccessibility();
  }

  private menuEntries(menu: HTMLElement): HTMLElement[] {
    return Array.from(menu.querySelector<HTMLElement>('.menu-dropdown')?.children ?? [])
      .filter((entry): entry is HTMLElement => entry instanceof HTMLElement)
      .filter(entry => (entry.matches('.md-item[data-cmd], .md-sub') && !entry.classList.contains('disabled')));
  }

  private focusEntry(menu: HTMLElement, index: number): void {
    const entries = this.menuEntries(menu);
    if (!entries.length) return;
    const entry = entries[(index + entries.length) % entries.length];
    entry.tabIndex = -1;
    entry.focus();
  }

  /** 메뉴 타이틀 클릭 → 드롭다운 토글 */
  private setupTitleClicks(): void {
    for (const item of this.menuItems) {
      const title = item.querySelector('.menu-title') as HTMLElement;
      if (!title) continue;
      title.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (this.openMenu === item) {
          this.closeAll();
        } else {
          this.showMenu(item);
        }
      });
    }
  }

  /** 열린 상태에서 다른 메뉴 hover → 자동 전환 */
  private setupTitleHover(): void {
    for (const item of this.menuItems) {
      const title = item.querySelector('.menu-title') as HTMLElement;
      if (!title) continue;
      title.addEventListener('mouseenter', () => {
        if (this.openMenu && this.openMenu !== item) {
          this.showMenu(item);
        }
      });
    }
  }

  /** 드롭다운 항목 클릭 → 커맨드 디스패치 + 닫기 */
  private setupItemClicks(): void {
    this.container.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('.md-item') as HTMLElement;
      if (!target) return;
      if (target.classList.contains('disabled')) return;

      const cmd = target.dataset.cmd;
      if (cmd) {
        // data-* 속성을 params로 변환 (data-cmd 제외)
        const params: Record<string, unknown> = { anchorEl: target };
        for (const [key, val] of Object.entries(target.dataset)) {
          if (key !== 'cmd') params[key] = val;
        }
        this.dispatcher.dispatch(cmd, params);
      }
      this.closeAll(document.activeElement === target);
    });
  }

  /**
   * 키보드로 메뉴를 탐색하는 중이면 마우스와 키보드가 같은 강조 하나를 쓰도록
   * hover 한 항목에 포커스를 옮긴다. 편집기가 포커스를 가진 채 마우스로 연
   * 메뉴는 포커스를 건드리지 않는다(IME 조합이 끊기지 않게).
   * 포인터가 패널을 벗어나면 강조를 거두고 포커스를 메뉴 제목으로 돌린다.
   */
  private setupPointerHighlight(): void {
    this.container.addEventListener('mouseover', (e) => {
      if (!this.openMenu || !this.openMenu.contains(document.activeElement)) return;
      const entry = (e.target as HTMLElement).closest<HTMLElement>('.md-item, .md-sub');
      if (!entry || !this.openMenu.contains(entry)) return;
      if (entry.classList.contains('disabled')) {
        if (this.openMenu.contains(document.activeElement) && document.activeElement !== entry.closest('.md-sub')) {
          this.openMenu.querySelector<HTMLElement>('.menu-title')?.focus({ preventScroll: true });
        }
        return;
      }
      if (document.activeElement === entry) return;
      entry.tabIndex = -1;
      entry.focus({ preventScroll: true });
    });
    this.container.addEventListener('mouseout', (e) => {
      if (!this.openMenu) return;
      const dropdown = this.openMenu.querySelector<HTMLElement>('.menu-dropdown');
      const next = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (!dropdown || (next && dropdown.contains(next))) return;
      if (!dropdown.contains(document.activeElement)) return;
      this.openMenu.querySelector<HTMLElement>('.menu-title')?.focus({ preventScroll: true });
    });
  }

  /** 바깥 클릭 → 닫기 */
  private setupOutsideClose(): void {
    document.addEventListener('mousedown', (e) => {
      if (!this.openMenu) return;
      if (!this.container.contains(e.target as Node)) {
        this.closeAll(false);
      }
    });
  }

  /** 메뉴 열린 상태 키보드 처리: Escape 닫기 + 단일 키 hotkey 항목 활성 (#792) */
  private setupKeyboardClose(): void {
    document.addEventListener('keydown', (e) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const launcher = this.container.querySelector<HTMLElement>('#editor-command-search');
      if (!this.openMenu && target === launcher && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        const menu = e.key === 'ArrowLeft' ? this.menuItems.at(-1) : this.menuItems[0];
        menu?.querySelector<HTMLElement>('.menu-title')?.focus();
        return;
      }
      const title = target?.closest<HTMLElement>('.menu-title');
      if (!this.openMenu && title && this.container.contains(title)
        && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        const menu = title.closest<HTMLElement>('.menu-item');
        const index = menu ? this.menuItems.indexOf(menu) : -1;
        if (index >= 0) {
          const next = index + (e.key === 'ArrowRight' ? 1 : -1);
          if (next < 0 || next >= this.menuItems.length) launcher?.focus();
          else this.menuItems[next].querySelector<HTMLElement>('.menu-title')?.focus();
        }
        return;
      }
      if (!this.openMenu && title && this.container.contains(title)
        && ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        const menu = title.closest<HTMLElement>('.menu-item');
        if (menu) {
          e.preventDefault();
          e.stopPropagation();
          this.showMenu(menu);
          this.focusEntry(menu, e.key === 'ArrowUp' ? -1 : 0);
        }
        return;
      }
      if (!this.openMenu) return;
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        this.closeAll();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeAll(true);
        return;
      }
      if (e.key === 'Tab') {
        this.closeAll(false);
        return;
      }
      if (target?.closest('input, textarea, select, [contenteditable="true"]')
        && !target.closest('[data-rhwp-editor-input]')) return;
      const entry = target?.closest<HTMLElement>('.md-item, .md-sub');
      const submenu = entry?.closest<HTMLElement>('.md-sub');
      const submenuPanel = entry?.closest<HTMLElement>('.md-sub-panel');
      if (e.key === 'ArrowRight' && entry?.classList.contains('md-sub')) {
        const first = entry.querySelector<HTMLElement>('.md-sub-panel .md-item[data-cmd]:not(.disabled)');
        if (first) {
          e.preventDefault();
          e.stopPropagation();
          entry.querySelector<HTMLElement>('.md-sub-panel')!.style.display = 'block';
          first.focus();
        }
        return;
      }
      if (e.key === 'ArrowLeft' && submenuPanel && submenu) {
        e.preventDefault();
        e.stopPropagation();
        submenu.querySelector<HTMLElement>('.md-sub-panel')!.style.display = '';
        submenu.focus();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        const entries = submenuPanel
          ? Array.from(submenuPanel.querySelectorAll<HTMLElement>('.md-item[data-cmd]:not(.disabled)'))
          : this.menuEntries(this.openMenu);
        if (!entries.length) return;
        const index = entry ? entries.indexOf(entry) : -1;
        let next: number;
        if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = entries.length - 1;
        else if (index < 0) next = e.key === 'ArrowDown' ? 0 : entries.length - 1;
        else next = (index + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
        entries[next].tabIndex = -1;
        entries[next].focus();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        const index = this.menuItems.indexOf(this.openMenu);
        if (launcher && ((e.key === 'ArrowRight' && index === this.menuItems.length - 1)
          || (e.key === 'ArrowLeft' && index === 0))) {
          this.closeAll(false);
          launcher.focus();
          return;
        }
        const next = this.menuItems[(index + (e.key === 'ArrowRight' ? 1 : -1) + this.menuItems.length) % this.menuItems.length];
        this.showMenu(next);
        next.querySelector<HTMLElement>('.menu-title')?.focus();
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && entry && !entry.classList.contains('disabled')) {
        e.preventDefault();
        e.stopPropagation();
        if (entry.classList.contains('md-sub')) {
          const first = entry.querySelector<HTMLElement>('.md-sub-panel .md-item[data-cmd]:not(.disabled)');
          if (first) {
            entry.querySelector<HTMLElement>('.md-sub-panel')!.style.display = 'block';
            first.focus();
          }
          return;
        }
        entry.click();
        return;
      }
      // 메뉴 열린 상태에서 단일 키 (modifier 없음) → shortcutLabel 매칭
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (e.key.length !== 1) return;
      const key = e.key.toUpperCase();
      const items = this.openMenu.querySelectorAll('.md-item[data-cmd]:not(.disabled)');
      for (const item of items) {
        const shortcut = item.querySelector('.md-shortcut');
        if (shortcut && shortcut.textContent?.toUpperCase() === key) {
          e.preventDefault();
          const el = item as HTMLElement;
          const cmd = el.dataset.cmd;
          if (cmd) {
            const params: Record<string, unknown> = { anchorEl: item };
            for (const [k, v] of Object.entries(el.dataset)) {
              if (k !== 'cmd') params[k] = v;
            }
            this.dispatcher.dispatch(cmd, params);
          }
          this.closeAll();
          return;
        }
      }
    }, true);
  }

  /** 드롭다운 열릴 때 항목별 활성/비활성 상태를 컨텍스트 기반으로 갱신 */
  private updateMenuStates(menuElement: HTMLElement): void {
    // 일반 항목
    const items = menuElement.querySelectorAll('.md-item[data-cmd]');
    for (const item of items) {
      const el = item as HTMLElement;
      const cmdId = el.dataset.cmd!;
      const enabled = this.dispatcher.isEnabled(cmdId);
      el.classList.toggle('disabled', !enabled);
      el.setAttribute('aria-disabled', String(!enabled));
      if (cmdId === 'file:save') {
        el.removeAttribute('title');
      }
    }
    // 서브메뉴 컨테이너: 하위 항목 중 활성이 하나라도 있으면 서브메뉴도 활성
    const subs = menuElement.querySelectorAll('.md-sub');
    for (const sub of subs) {
      const subItems = sub.querySelectorAll('.md-item[data-cmd]');
      let anyEnabled = false;
      for (const si of subItems) {
        if (!si.classList.contains('disabled')) {
          anyEnabled = true;
          break;
        }
      }
      sub.classList.toggle('disabled', !anyEnabled);
      sub.setAttribute('aria-disabled', String(!anyEnabled));
    }
  }

  /** restoreFocus 를 생략하면 포커스가 메뉴 안에 남아 있을 때만 원래 자리로 돌린다. */
  private closeAll(restoreFocus = this.container.contains(document.activeElement)): void {
    this.openMenu?.classList.remove('open');
    this.openMenu?.querySelector('.menu-title')?.setAttribute('aria-expanded', 'false');
    this.container.querySelectorAll<HTMLElement>('.md-sub-panel').forEach(panel => { panel.style.display = ''; });
    this.openMenu = null;
    if (restoreFocus) this.returnFocus?.focus();
    this.returnFocus = null;
  }
}

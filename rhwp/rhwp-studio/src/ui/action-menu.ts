/**
 * 우클릭 액션 메뉴 — 커맨드 레지스트리 없이 콜백만 실행한다.
 * 편집기 ContextMenu 와 같은 .context-menu 면을 쓴다.
 *
 * 키보드: ↑/↓ 이동, Home/End 처음·끝, Return/Space 실행, Esc 닫기.
 */

export interface ActionMenuItem {
  label: string;
  disabled?: boolean;
  /** 켜진 토글 — 체크 칸에 체크 표시를 그린다. */
  checked?: boolean;
  /** 이 항목 앞에 구분선을 둔다. */
  separatorBefore?: boolean;
  title?: string;
  onSelect: () => void;
}

let openMenu: HTMLDivElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let outsideHandler: ((e: MouseEvent) => void) | null = null;
let returnFocus: HTMLElement | null = null;

function hideActionMenu(): void {
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
  if (outsideHandler) {
    document.removeEventListener('mousedown', outsideHandler, true);
    outsideHandler = null;
  }
  const hadFocus = openMenu?.contains(document.activeElement) ?? false;
  openMenu?.remove();
  openMenu = null;
  if (hadFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

export function showActionMenu(x: number, y: number, items: ActionMenuItem[]): void {
  hideActionMenu();
  if (items.length === 0) return;

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;

  const rows: HTMLElement[] = [];
  items.forEach((item, index) => {
    if (item.separatorBefore && index > 0) {
      const sep = document.createElement('div');
      sep.className = 'md-sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
    }
    const row = document.createElement('div');
    row.className = 'md-item';
    row.tabIndex = -1;
    if (item.checked !== undefined) {
      row.setAttribute('role', 'menuitemcheckbox');
      row.setAttribute('aria-checked', String(item.checked));
      row.classList.toggle('active', item.checked);
    } else {
      row.setAttribute('role', 'menuitem');
    }
    row.textContent = item.label;
    if (item.title) row.title = item.title;
    if (item.disabled) {
      row.classList.add('disabled');
      row.setAttribute('aria-disabled', 'true');
    } else {
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        hideActionMenu();
        item.onSelect();
      });
      // 마우스와 키보드가 같은 강조 하나를 쓴다.
      row.addEventListener('mouseenter', () => row.focus({ preventScroll: true }));
      rows.push(row);
    }
    menu.appendChild(row);
  });
  menu.addEventListener('mouseleave', () => {
    if (menu.contains(document.activeElement)) menu.focus({ preventScroll: true });
  });

  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(menu);
  openMenu = menu;

  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 2;
  if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 2;
  menu.style.left = `${Math.max(0, left)}px`;
  menu.style.top = `${Math.max(0, top)}px`;
  // 열 때는 아무 행도 강조하지 않는다. 첫 ↓ 가 첫 행을 강조한다.
  menu.focus({ preventScroll: true });

  keyHandler = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const current = rows.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        hideActionMenu();
        return;
      case 'ArrowDown':
        next = current < 0 ? 0 : (current + 1) % rows.length;
        break;
      case 'ArrowUp':
        next = current < 0 ? rows.length - 1 : (current - 1 + rows.length) % rows.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      case 'Enter':
      case ' ':
        if (current < 0) return;
        event.preventDefault();
        event.stopPropagation();
        rows[current].click();
        return;
      case 'Tab':
        event.preventDefault();
        event.stopPropagation();
        hideActionMenu();
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (rows.length) rows[next].focus({ preventScroll: true });
  };
  document.addEventListener('keydown', keyHandler, true);

  requestAnimationFrame(() => {
    if (openMenu !== menu) return;
    outsideHandler = (event: MouseEvent) => {
      if (openMenu && !openMenu.contains(event.target as Node)) hideActionMenu();
    };
    document.addEventListener('mousedown', outsideHandler, true);
  });
}

/**
 * 우클릭 액션 메뉴 — 커맨드 레지스트리 없이 콜백만 실행한다.
 * 편집기 ContextMenu 와 같은 .context-menu 면을 쓴다.
 */

export interface ActionMenuItem {
  label: string;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}

let openMenu: HTMLDivElement | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;
let outsideHandler: ((e: MouseEvent) => void) | null = null;

function hideActionMenu(): void {
  if (escHandler) {
    document.removeEventListener('keydown', escHandler, true);
    escHandler = null;
  }
  if (outsideHandler) {
    document.removeEventListener('mousedown', outsideHandler, true);
    outsideHandler = null;
  }
  openMenu?.remove();
  openMenu = null;
}

export function showActionMenu(x: number, y: number, items: ActionMenuItem[]): void {
  hideActionMenu();
  if (items.length === 0) return;

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'md-item';
    row.setAttribute('role', 'menuitem');
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
    }
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  openMenu = menu;

  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 2;
  if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 2;
  menu.style.left = `${Math.max(0, left)}px`;
  menu.style.top = `${Math.max(0, top)}px`;

  escHandler = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    hideActionMenu();
  };
  document.addEventListener('keydown', escHandler, true);

  requestAnimationFrame(() => {
    if (openMenu !== menu) return;
    outsideHandler = (event: MouseEvent) => {
      if (openMenu && !openMenu.contains(event.target as Node)) hideActionMenu();
    };
    document.addEventListener('mousedown', outsideHandler, true);
  });
}

interface TableRibbonMenu {
  wrapper: HTMLElement;
  trigger: HTMLButtonElement;
  panel: HTMLElement;
  items: HTMLButtonElement[];
}

export interface TableRibbonMenusController {
  refresh(): void;
  closeAll(): void;
  destroy(): void;
}

/** Handles the table ribbon's menus even when overflow moves their groups. */
export function setupTableRibbonMenus(
  toolbar: HTMLElement,
  dispatch: (cmd: string, anchor: HTMLElement) => void,
  isEnabled: (cmd: string) => boolean,
): TableRibbonMenusController {
  const menus = Array.from(toolbar.querySelectorAll<HTMLElement>('[data-table-ribbon-menu]'))
    .map((wrapper): TableRibbonMenu | null => {
      const trigger = wrapper.querySelector<HTMLButtonElement>('.tb-table-menu-trigger');
      const panel = wrapper.querySelector<HTMLElement>('.tb-table-menu-panel');
      if (!trigger || !panel) return null;
      return {
        wrapper,
        trigger,
        panel,
        items: Array.from(panel.querySelectorAll<HTMLButtonElement>('.tb-table-menu-item[data-cmd]')),
      };
    }).filter((menu): menu is TableRibbonMenu => menu !== null);
  const byWrapper = new Map(menus.map(menu => [menu.wrapper, menu]));
  let openMenu: TableRibbonMenu | null = null;
  let contextMode = toolbar.dataset.contextMode;

  const menuFor = (target: EventTarget | null): TableRibbonMenu | null => {
    if (!(target instanceof Element)) return null;
    const wrapper = target.closest<HTMLElement>('[data-table-ribbon-menu]');
    return wrapper ? byWrapper.get(wrapper) ?? null : null;
  };
  const enabledItems = (menu: TableRibbonMenu): HTMLButtonElement[] =>
    menu.items.filter(item => !item.disabled);

  const close = (restoreFocus: boolean): void => {
    if (!openMenu) return;
    const { panel, trigger } = openMenu;
    openMenu = null;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && trigger.isConnected && !trigger.disabled) {
      trigger.focus({ preventScroll: true });
    }
  };

  const position = (menu: TableRibbonMenu): void => {
    const anchor = menu.trigger.getBoundingClientRect();
    const width = menu.panel.offsetWidth;
    const height = menu.panel.offsetHeight;
    const margin = 8;
    const below = anchor.bottom + 4;
    const above = anchor.top - height - 4;
    const top = below + height <= window.innerHeight - margin || below <= margin
      ? below : Math.max(margin, above);
    menu.panel.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))}px`;
    menu.panel.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`;
  };

  const refresh = (): void => {
    for (const menu of menus) {
      for (const item of menu.items) item.disabled = !isEnabled(item.dataset.cmd ?? '');
    }
    if (openMenu) {
      if (!openMenu.trigger.getClientRects().length) close(false);
      else position(openMenu);
    }
  };

  const open = (menu: TableRibbonMenu, focusItem: 'first' | 'last' | null): void => {
    if (openMenu !== menu) close(false);
    refresh();
    menu.panel.hidden = false;
    menu.trigger.setAttribute('aria-expanded', 'true');
    openMenu = menu;
    position(menu);
    if (focusItem) {
      const items = enabledItems(menu);
      (focusItem === 'first' ? items[0] : items.at(-1))?.focus({ preventScroll: true });
    }
  };

  const activate = (item: HTMLButtonElement): void => {
    const cmd = item.dataset.cmd;
    if (!cmd || item.disabled || !isEnabled(cmd)) return;
    const trigger = openMenu?.trigger ?? menuFor(item)?.trigger;
    close(false);
    dispatch(cmd, trigger ?? item);
  };

  const onPointerDown = (event: PointerEvent): void => {
    const menu = menuFor(event.target);
    if (menu && event.target instanceof Element
      && event.target.closest('.tb-table-menu-trigger, .tb-table-menu-item')) {
      // Table commands use the editor's existing cell/text selection.
      event.preventDefault();
    }
  };
  const onClick = (event: MouseEvent): void => {
    const menu = menuFor(event.target);
    if (!menu || !(event.target instanceof Element)) return;
    if (event.target.closest('.tb-table-menu-trigger')) {
      if (openMenu === menu) close(false);
      else open(menu, event.detail === 0 ? 'first' : null);
      return;
    }
    const item = event.target.closest<HTMLButtonElement>('.tb-table-menu-item[data-cmd]');
    if (item && menu.panel.contains(item)) activate(item);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.target instanceof Element)) return;
    const tile = event.target.closest<HTMLButtonElement>('.tb-table-context-group .tb-btn');
    if (tile && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const stack = tile.closest<HTMLElement>('.tb-table-tile-equal');
      if (stack) {
        const actions = Array.from(stack.querySelectorAll<HTMLButtonElement>('.tb-btn'))
          .filter(button => !button.disabled && button.getClientRects().length > 0);
        const index = actions.indexOf(tile);
        if (index >= 0 && actions.length > 1) {
          event.preventDefault();
          actions[(index + (event.key === 'ArrowDown' ? 1 : -1) + actions.length) % actions.length]
            .focus({ preventScroll: true });
          return;
        }
      }
    }
    if (tile && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const groups = Array.from(toolbar.querySelectorAll<HTMLElement>('.tb-table-context-group'))
        .map(group => ({
          group,
          first: Array.from(group.querySelectorAll<HTMLButtonElement>('.tb-btn'))
            .find(button => !button.disabled && button.getClientRects().length > 0),
        }))
        .filter((entry): entry is { group: HTMLElement; first: HTMLButtonElement } => Boolean(entry.first));
      const index = groups.findIndex(({ group }) => group.contains(tile));
      if (index < 0 || groups.length < 2) return;
      event.preventDefault();
      close(false);
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      groups[(index + direction + groups.length) % groups.length].first.focus({ preventScroll: true });
      return;
    }

    const menu = menuFor(event.target);
    if (!menu) return;
    const onTrigger = menu.trigger.contains(event.target);
    const current = event.target.closest<HTMLButtonElement>('.tb-table-menu-item[data-cmd]');
    if (!onTrigger && (!current || !menu.panel.contains(current))) return;

    if (event.key === 'Escape' && openMenu) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (onTrigger) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp'
        || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        open(menu, event.key === 'ArrowUp' || event.key === 'End' ? 'last' : 'first');
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (openMenu === menu) close(false);
        else open(menu, 'first');
      }
      return;
    }
    if (!current) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(current);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = enabledItems(menu);
    if (!items.length) return;
    const index = items.indexOf(current);
    const next = event.key === 'Home' ? items[0]
      : event.key === 'End' ? items.at(-1)!
        : items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next.focus({ preventScroll: true });
  };
  const onOutsidePointerDown = (event: PointerEvent): void => {
    if (openMenu && event.target instanceof Node && !openMenu.wrapper.contains(event.target)) close(false);
  };
  const onFocusOut = (event: FocusEvent): void => {
    if (!openMenu || !openMenu.wrapper.contains(event.target as Node)) return;
    if (event.relatedTarget instanceof Node && openMenu.wrapper.contains(event.relatedTarget)) return;
    close(false);
  };
  const onEscape = (event: KeyboardEvent): void => {
    if (!openMenu || event.key !== 'Escape') return;
    // The overflow dialog also handles Escape on document capture. The menu gets it first.
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };
  const onModeChange = (): void => {
    const nextMode = toolbar.dataset.contextMode;
    if (nextMode !== contextMode) {
      contextMode = nextMode;
      close(false);
    }
  };
  const modeObserver = new MutationObserver(onModeChange);
  modeObserver.observe(toolbar, { attributes: true, attributeFilter: ['data-context-mode'] });

  toolbar.addEventListener('pointerdown', onPointerDown, true);
  toolbar.addEventListener('click', onClick);
  toolbar.addEventListener('keydown', onKeyDown);
  toolbar.addEventListener('focusout', onFocusOut);
  document.addEventListener('pointerdown', onOutsidePointerDown, true);
  window.addEventListener('keydown', onEscape, true);
  window.addEventListener('resize', refresh);
  window.addEventListener('scroll', refresh, true);
  refresh();

  return {
    refresh,
    closeAll: () => close(false),
    destroy: () => {
      close(false);
      modeObserver.disconnect();
      toolbar.removeEventListener('pointerdown', onPointerDown, true);
      toolbar.removeEventListener('click', onClick);
      toolbar.removeEventListener('keydown', onKeyDown);
      toolbar.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onOutsidePointerDown, true);
      window.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
    },
  };
}

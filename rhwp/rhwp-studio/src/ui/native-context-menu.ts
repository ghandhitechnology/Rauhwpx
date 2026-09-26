/**
 * 우클릭 메뉴 공용 진입점.
 *
 * 데스크톱 셸은 preload 로 네이티브 Menu.popup 을 띄우고, 웹은 기존 HTML 액션 메뉴로 대신한다.
 * 어느 쪽이든 고른 항목 id 를, 닫히면 null 을 돌려준다.
 */

import type { NativeContextMenuItem } from '../desktop-integration.ts';
import { showActionMenu, type ActionMenuItem } from './action-menu.ts';

export type ContextMenuItem = NativeContextMenuItem;

function isSeparator(item: ContextMenuItem): item is { type: 'separator' } {
  return 'type' in item && item.type === 'separator';
}

export function showContextMenu(
  items: ContextMenuItem[],
  anchor: { x: number; y: number },
): Promise<string | null> {
  const nativeShow = (globalThis as { rhwpDesktop?: { showContextMenu?: (items: ContextMenuItem[]) => Promise<string | null> } })
    .rhwpDesktop?.showContextMenu;
  if (typeof nativeShow === 'function') {
    const payload = items.map((item) => (isSeparator(item)
      ? { type: 'separator' as const }
      : {
          id: item.id,
          label: item.label,
          enabled: item.enabled !== false,
          checked: item.checked === true ? true : undefined,
          danger: item.danger === true ? true : undefined,
        }));
    return nativeShow(payload).then(
      (id) => (typeof id === 'string' ? id : null),
      () => null,
    );
  }
  return showHtmlFallback(items, anchor);
}

function showHtmlFallback(
  items: ContextMenuItem[],
  anchor: { x: number; y: number },
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (id: string | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      resolve(id);
    };
    // 구분선은 다음 행의 separatorBefore 로 옮긴다.
    const rows: ActionMenuItem[] = [];
    let pendingSeparator = false;
    for (const item of items) {
      if (isSeparator(item)) {
        pendingSeparator = rows.length > 0;
        continue;
      }
      rows.push({
        label: item.label,
        disabled: item.enabled === false,
        checked: item.checked,
        separatorBefore: pendingSeparator,
        onSelect: () => settle(item.id),
      });
      pendingSeparator = false;
    }
    let menu: Element | null = null;
    const observer = new MutationObserver(() => {
      if (!menu?.isConnected) settle(null);
    });
    showActionMenu(anchor.x, anchor.y, rows);
    menu = document.body.lastElementChild;
    if (!menu?.classList.contains('context-menu')) {
      settle(null);
      return;
    }
    observer.observe(document.body, { childList: true });
  });
}

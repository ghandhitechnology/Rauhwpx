/**
 * macOS 네이티브 메뉴 막대 연동.
 *
 * HTML 메뉴바(#menu-bar)를 그대로 메뉴 모델의 원본으로 삼는다. 항목·구분선·하위 메뉴·
 * 활성 여부·체크 상태·단축키 표시를 직렬화해 메인 프로세스로 보내고, 네이티브 메뉴에서
 * 고른 명령은 HTML 메뉴 클릭과 같은 CommandDispatcher 경로로 실행한다.
 * 키 입력은 계속 렌더러가 처리하므로(IME·사이드바 입력) 단축키는 표시 전용이다.
 */

import type { EventBus } from '@/core/event-bus';
import type { CommandDispatcher } from '@/command/dispatcher';
import type { CommandRegistry } from '@/command/registry';

export type NativeMenuEntry =
  | { type: 'separator' }
  | { type: 'recent' }
  | { label: string; submenu: NativeMenuEntry[] }
  | {
    id: string;
    label: string;
    enabled: boolean;
    checked?: boolean;
    radio?: boolean;
    accelerator?: string;
  };

export interface NativeMenuModel {
  menus: Array<{ key: string; label: string; items: NativeMenuEntry[] }>;
}

interface NativeMenuApi {
  platform?: string;
  setAppMenuModel?: (model: NativeMenuModel) => void;
  onMenuCommand?: (callback: (commandId: string) => void) => (() => void) | void;
  onAgentCommand?: (callback: (command: string) => void) => (() => void) | void;
}

export interface DesktopNativeMenuOptions {
  menuBar: HTMLElement;
  dispatcher: CommandDispatcher;
  registry: CommandRegistry;
  eventBus: EventBus;
}

// 명령 활성 상태가 바뀔 수 있는 신호. 모두 한 번의 지연 갱신으로 합친다.
const STATE_EVENTS = [
  'command-state-changed',
  'document-changed',
  'document-context-changed',
  'document-dirty-changed',
  'document-saved',
  'document-swapped',
  'document-view-changed',
  'history-jumped',
  'cursor-format-changed',
  'cursor-cell-changed',
  'cell-selection-changed',
  'table-object-selection-changed',
  'picture-object-selection-changed',
  'field-info-changed',
  'grid-view-changed',
  'theme-changed',
];
const SYNC_DELAY_MS = 150;

const MODIFIER_WORDS: Record<string, string> = {
  ctrl: 'CmdOrCtrl',
  cmd: 'CmdOrCtrl',
  meta: 'CmdOrCtrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};
const MODIFIER_SYMBOLS: Record<string, string> = {
  '⌘': 'CmdOrCtrl',
  '⌃': 'Ctrl',
  '⌥': 'Alt',
  '⇧': 'Shift',
};
const NAMED_KEYS: Record<string, string> = {
  'num +': 'numadd',
  'num -': 'numsub',
  '+': 'Plus',
  enter: 'Enter',
  delete: 'Delete',
  del: 'Delete',
  backspace: 'Backspace',
  tab: 'Tab',
  space: 'Space',
  esc: 'Esc',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

/**
 * 메뉴 단축키 표시("Ctrl+Shift+S", "⌘⇧S")를 Electron accelerator 문자열로 바꾼다.
 * 연속 입력(Ctrl+G,P)과 수정키 없는 메뉴 내 단일 키(H)는 네이티브 메뉴가 표현하지 못하므로 뺀다.
 */
export function shortcutToAccelerator(label: string | null | undefined): string | undefined {
  let rest = label?.trim() ?? '';
  if (!rest || /,./.test(rest)) return undefined;
  const modifiers = new Set<string>();
  for (;;) {
    const symbol = MODIFIER_SYMBOLS[rest[0]];
    if (symbol && rest.length > 1) {
      modifiers.add(symbol);
      rest = rest.slice(1);
      continue;
    }
    const word = /^(\w+)\+(?=.)/.exec(rest);
    const modifier = word ? MODIFIER_WORDS[word[1].toLowerCase()] : undefined;
    if (!word || !modifier) break;
    modifiers.add(modifier);
    rest = rest.slice(word[0].length);
  }
  let key = NAMED_KEYS[rest.toLowerCase()];
  if (!key && /^F([1-9]|1[0-9]|2[0-4])$/i.test(rest)) key = rest.toUpperCase();
  if (!key && /^[A-Za-z0-9\-=[\];',./\\`]$/.test(rest)) key = rest.toUpperCase();
  if (!key) return undefined;
  if (modifiers.size === 0 && !/^F\d/.test(key)) return undefined;
  return [...modifiers, key].join('+');
}

/** 네이티브 메뉴는 니모닉 "(F)"를 쓰지 않고, 말줄임은 한 글자 "…"로 적는다. */
function nativeLabel(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\([A-Z]\)(?=(?:\.\.\.|…)?$)/, '')
    .replace(/\.\.\.$/, '…');
}

/** data-cmd 와 나머지 data-* 파라미터를 한 문자열 ID 로 묶는다(같은 명령의 다른 템플릿 구분). */
export function encodeMenuCommandId(cmd: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  if (keys.length === 0) return cmd;
  const query = new URLSearchParams(keys.map(key => [key, params[key]]));
  return `${cmd}?${query.toString()}`;
}

export function decodeMenuCommandId(id: string): { cmd: string; params: Record<string, string> } {
  const index = id.indexOf('?');
  if (index < 0) return { cmd: id, params: {} };
  return {
    cmd: id.slice(0, index),
    params: Object.fromEntries(new URLSearchParams(id.slice(index + 1))),
  };
}

function itemParams(el: HTMLElement): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(el.dataset)) {
    if (key !== 'cmd' && value !== undefined) params[key] = value;
  }
  return params;
}

export function serializeMenuBar(
  menuBar: HTMLElement,
  dispatcher: Pick<CommandDispatcher, 'isEnabled'>,
  registry: Pick<CommandRegistry, 'get'>,
): NativeMenuModel {
  const entries = (parent: Element | null | undefined): NativeMenuEntry[] => {
    const out: NativeMenuEntry[] = [];
    for (const child of Array.from(parent?.children ?? [])) {
      if (!(child instanceof HTMLElement) || child.hidden) continue;
      if (child.classList.contains('md-sep')) {
        out.push({ type: 'separator' });
      } else if (child.classList.contains('md-sub')) {
        if (child.hasAttribute('data-recent')) {
          out.push({ type: 'recent' });
          continue;
        }
        const label = nativeLabel(child.querySelector(':scope > .md-label')?.textContent);
        const submenu = entries(child.querySelector(':scope > .md-sub-panel'));
        if (label && submenu.length > 0) out.push({ label, submenu });
      } else if (child.classList.contains('md-item') && child.dataset.cmd) {
        const cmd = child.dataset.cmd;
        const label = nativeLabel(child.querySelector('.md-label')?.textContent);
        if (!label) continue;
        const shortcut = registry.get(cmd)?.shortcutLabel
          ?? child.querySelector('.md-shortcut')?.textContent;
        const checked = child.classList.contains('active') || child.getAttribute('aria-checked') === 'true';
        const accelerator = shortcutToAccelerator(shortcut);
        out.push({
          id: encodeMenuCommandId(cmd, itemParams(child)),
          label,
          enabled: dispatcher.isEnabled(cmd),
          ...(checked ? { checked } : {}),
          ...(child.getAttribute('role') === 'menuitemradio' ? { radio: true } : {}),
          ...(accelerator ? { accelerator } : {}),
        });
      }
    }
    return out;
  };
  const menus: NativeMenuModel['menus'] = [];
  for (const menu of Array.from(menuBar.querySelectorAll<HTMLElement>(':scope > .menu-item[data-menu]'))) {
    const label = nativeLabel(menu.querySelector(':scope > .menu-title')?.textContent);
    if (!label) continue;
    menus.push({
      key: menu.dataset.menu ?? '',
      label,
      items: entries(menu.querySelector(':scope > .menu-dropdown')),
    });
  }
  return { menus };
}

/**
 * macOS 데스크톱에서만 네이티브 메뉴를 켠다. 켜지면 `html.desktop-native-menu` 로
 * HTML 메뉴 제목을 숨기고 제목 막대를 창 드래그 영역으로 쓴다.
 */
export function installDesktopNativeMenu(options: DesktopNativeMenuOptions): boolean {
  if (typeof window === 'undefined') return false;
  const api = (window as unknown as { rhwpDesktop?: NativeMenuApi }).rhwpDesktop;
  if (api?.platform !== 'darwin' || typeof api.setAppMenuModel !== 'function') return false;
  const { menuBar, dispatcher, registry, eventBus } = options;

  let lastSent = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sync = () => {
    timer = null;
    const model = serializeMenuBar(menuBar, dispatcher, registry);
    const serialized = JSON.stringify(model);
    if (serialized === lastSent) return;
    lastSent = serialized;
    api.setAppMenuModel?.(model);
  };
  const schedule = () => {
    if (timer === null) timer = setTimeout(sync, SYNC_DELAY_MS);
  };

  for (const name of STATE_EVENTS) eventBus.on(name, schedule);
  window.addEventListener('focus', schedule);
  api.onMenuCommand?.((commandId) => {
    const { cmd, params } = decodeMenuCommandId(commandId);
    dispatcher.dispatch(cmd, params);
  });
  api.onAgentCommand?.((command) => {
    window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command } }));
  });

  document.documentElement.classList.add('desktop-native-menu');
  sync();
  return true;
}


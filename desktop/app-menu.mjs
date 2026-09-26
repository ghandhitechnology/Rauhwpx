import { app, BrowserWindow, Menu, clipboard, ipcMain } from 'electron';
import { documentEditMenuItem } from './edit-menu.mjs';
import { deliverPlainTextPaste } from './plain-text-paste.mjs';

export const APP_MENU_MODEL_CHANNEL = 'desktop:set-app-menu-model';
export const MENU_COMMAND_CHANNEL = 'desktop:menu-command';
export const AGENT_COMMAND_CHANNEL = 'desktop:agent-command';

const isMac = process.platform === 'darwin';

// 렌더러 모델 상한: 신뢰된 렌더러라도 네이티브 메뉴 빌드 비용을 묶어 둔다.
const MAX_DEPTH = 4;
const MAX_ENTRIES = 800;
const MAX_LABEL = 120;
const MAX_ID = 300;
const TOP_LEVEL_KEYS = new Set(['file', 'edit', 'view', 'insert', 'format', 'page', 'table', 'tool']);
// 네이티브 편집 메뉴가 이미 가진 명령. 렌더러 편집 메뉴에서 중복을 뺀다.
const NATIVE_EDIT_IDS = new Set([
  'edit:undo', 'edit:redo', 'edit:cut', 'edit:copy', 'edit:paste', 'edit:delete', 'edit:select-all',
]);
const ACCELERATOR_MODIFIERS = new Set(['CmdOrCtrl', 'Cmd', 'Ctrl', 'Alt', 'Shift']);
const ACCELERATOR_KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Enter|Backspace|Delete|Tab|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Esc|Insert|numadd|numsub|Plus|[-=[\];',./\\`])$/;

function cleanLabel(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL) : '';
}

function cleanAccelerator(value) {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const parts = value.split('+');
  const key = parts.pop();
  if (!key || !ACCELERATOR_KEY.test(key)) return undefined;
  if (!parts.every((part) => ACCELERATOR_MODIFIERS.has(part))) return undefined;
  return value;
}

/** 렌더러가 보낸 메뉴 모델을 네이티브 메뉴가 받을 수 있는 모양으로만 좁힌다. */
export function sanitizeAppMenuModel(raw) {
  if (!raw || !Array.isArray(raw.menus)) return null;
  let budget = MAX_ENTRIES;
  const entries = (list, depth) => {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return [];
    const out = [];
    for (const entry of list) {
      if (budget-- <= 0) break;
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type === 'separator' || entry.type === 'recent') {
        out.push({ type: entry.type });
        continue;
      }
      const label = cleanLabel(entry.label);
      if (!label) continue;
      if (Array.isArray(entry.submenu)) {
        const submenu = entries(entry.submenu, depth + 1);
        if (submenu.some((item) => item.id || item.submenu)) out.push({ label, submenu });
        continue;
      }
      if (typeof entry.id !== 'string' || !entry.id || entry.id.length > MAX_ID) continue;
      out.push({
        id: entry.id,
        label,
        enabled: entry.enabled !== false,
        checked: entry.checked === true,
        radio: entry.radio === true,
        accelerator: cleanAccelerator(entry.accelerator),
      });
    }
    return out;
  };
  const menus = [];
  for (const menu of raw.menus) {
    if (!menu || !TOP_LEVEL_KEYS.has(menu.key)) continue;
    const label = cleanLabel(menu.label);
    if (!label) continue;
    menus.push({ key: menu.key, label, items: entries(menu.items, 1) });
  }
  return { menus };
}

/** 구분선이 겹치거나 양 끝에 남지 않게 정리한다. */
function tidySeparators(items) {
  const out = [];
  for (const item of items) {
    if (item.type === 'separator' && (out.length === 0 || out.at(-1).type === 'separator')) continue;
    out.push(item);
  }
  while (out.at(-1)?.type === 'separator') out.pop();
  return out;
}

function sendToWindow(window, channel, payload) {
  if (!window || window.isDestroyed?.()) return;
  const contents = window.webContents;
  if (!contents || contents.isDestroyed?.()) return;
  contents.send(channel, payload);
}

function findEntry(items, id) {
  for (const item of items ?? []) {
    if (item.id === id) return item;
    if (item.submenu) {
      const found = findEntry(item.submenu, id);
      if (found) return found;
    }
  }
  return null;
}

function hasEnabledEntry(items) {
  return items.some((item) => (item.submenu ? hasEnabledEntry(item.submenu) : item.id && item.enabled));
}

/**
 * macOS 메뉴 막대와 Windows/Linux 창 메뉴를 설치한다.
 *
 * macOS: 렌더러의 HTML 메뉴 모델(창마다 최신 값)을 받아 네이티브 메뉴로 다시 짓는다.
 * 렌더러 명령은 단축키를 표시만 하고(registerAccelerator: false) 키 처리는 렌더러가 맡는다.
 * 새 윈도우·닫기·최근 문서·전체 화면·가리기·종료만 네이티브 단축키를 등록한다.
 */
export function installAppMenu({ checkForUpdates, openNewWindow, isTrustedSender }) {
  const pasteWithoutFormatting = (label) => ({
    id: 'edit-paste-without-formatting',
    label,
    accelerator: 'CmdOrCtrl+Shift+V',
    click: (_menuItem, browserWindow) => {
      deliverPlainTextPaste(
        browserWindow ?? BrowserWindow.getFocusedWindow(),
        () => clipboard.readText(),
      );
    },
  });
  // The stock window menu binds CmdOrCtrl+M to Minimize, which swallows the
  // editor's Cmd+M chord (equations, footnotes, text colors).
  const minimizeWindow = (label) => ({
    label,
    click: (_menuItem, browserWindow) => browserWindow?.minimize(),
  });
  // 배포본에는 새로 고침·개발자 도구를 두지 않는다.
  const developmentItems = app.isPackaged ? [] : [
    { type: 'separator' },
    { role: 'reload' },
    { role: 'forceReload' },
    { role: 'toggleDevTools' },
  ];

  if (!isMac) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: openNewWindow },
          { type: 'separator' },
          { label: 'Check for Updates…', click: checkForUpdates },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          documentEditMenuItem('undo', 'Undo', 'CmdOrCtrl+Z'),
          documentEditMenuItem('redo', 'Redo', 'Ctrl+Y'),
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          pasteWithoutFormatting('Paste Without Formatting'),
          documentEditMenuItem('delete', 'Delete'),
          { type: 'separator' },
          documentEditMenuItem('select-all', 'Select All', 'CmdOrCtrl+A'),
        ],
      },
      {
        label: 'View',
        submenu: tidySeparators([
          ...developmentItems,
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ]),
      },
      { label: 'Window', role: 'window', submenu: [minimizeWindow('Minimize'), { role: 'close' }] },
      { role: 'help', submenu: [{ role: 'about' }] },
    ]));
    return;
  }

  const appName = app.name;
  const models = new Map();
  let built = { ownerId: -1, model: undefined };

  const rendererEntry = (entry, owner) => {
    // 최근 문서 자리 표시는 파일 메뉴에서만 네이티브 항목으로 바뀐다.
    if (entry.type === 'separator' || entry.type === 'recent') return { type: 'separator' };
    if (entry.submenu) {
      return {
        label: entry.label,
        enabled: hasEnabledEntry(entry.submenu),
        submenu: tidySeparators(entry.submenu.map((child) => rendererEntry(child, owner))),
      };
    }
    return {
      label: entry.label,
      enabled: entry.enabled,
      ...(entry.checked ? { type: entry.radio ? 'radio' : 'checkbox', checked: true } : {}),
      ...(entry.accelerator ? { accelerator: entry.accelerator, registerAccelerator: false } : {}),
      click: (_menuItem, browserWindow) => {
        sendToWindow(browserWindow ?? owner, MENU_COMMAND_CHANNEL, { commandId: entry.id });
      },
    };
  };
  const agentItem = (label, accelerator, command) => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: (_menuItem, browserWindow) => {
      sendToWindow(browserWindow ?? BrowserWindow.getFocusedWindow(), AGENT_COMMAND_CHANNEL, { command });
    },
  });

  const build = (owner, model) => {
    const menus = new Map((model?.menus ?? []).map((menu) => [menu.key, menu]));
    const toNative = (entry) => rendererEntry(entry, owner);
    const fileMenu = menus.get('file');
    const editMenu = menus.get('edit');
    const viewMenu = menus.get('view');
    const labelOf = (items, id, fallback) => findEntry(items, id)?.label ?? fallback;

    const about = findEntry(fileMenu?.items, 'file:about');
    const newWindow = { label: '새 윈도우', accelerator: 'CmdOrCtrl+Shift+N', click: openNewWindow };
    const recentAndClose = [
      {
        role: 'recentDocuments',
        label: '최근 문서',
        submenu: [{ role: 'clearRecentDocuments', label: '메뉴 지우기' }],
      },
      { type: 'separator' },
      { role: 'close', label: '닫기', accelerator: 'Cmd+W' },
      { type: 'separator' },
    ];
    const fileItems = [];
    let placedNewWindow = false;
    let placedRecent = false;
    for (const entry of fileMenu?.items ?? []) {
      if (entry.id === 'file:about') continue;
      if (entry.type === 'recent') {
        fileItems.push(...recentAndClose);
        placedRecent = true;
        continue;
      }
      fileItems.push(toNative(entry));
      if (entry.id === 'file:new-doc') {
        fileItems.push(newWindow);
        placedNewWindow = true;
      }
    }
    if (!placedNewWindow) fileItems.unshift(newWindow, { type: 'separator' });
    if (!placedRecent) fileItems.push({ type: 'separator' }, ...recentAndClose);

    const editItems = editMenu?.items ?? [];
    const editExtras = editItems
      .filter((entry) => !NATIVE_EDIT_IDS.has(entry.id))
      .map(toNative);

    const rendererTopLevel = ['insert', 'format', 'page', 'table', 'tool']
      .map((key) => menus.get(key))
      .filter(Boolean)
      .map((menu) => ({
        label: menu.label,
        submenu: tidySeparators(menu.items.map(toNative)),
      }));

    return Menu.buildFromTemplate([
      {
        label: appName,
        submenu: [
          about
            ? { ...rendererEntry(about, owner), label: `${appName} 정보` }
            : { role: 'about', label: `${appName} 정보` },
          { type: 'separator' },
          { label: '업데이트 확인…', click: checkForUpdates },
          { type: 'separator' },
          { role: 'hide', label: `${appName} 가리기` },
          { role: 'hideOthers', label: '기타 가리기' },
          { role: 'unhide', label: '모두 보기' },
          { type: 'separator' },
          { role: 'quit', label: `${appName} 종료` },
        ],
      },
      { label: fileMenu?.label ?? '파일', submenu: tidySeparators(fileItems) },
      {
        label: editMenu?.label ?? '편집',
        submenu: tidySeparators([
          documentEditMenuItem('undo', labelOf(editItems, 'edit:undo', '되돌리기'), 'CmdOrCtrl+Z'),
          documentEditMenuItem('redo', labelOf(editItems, 'edit:redo', '다시 실행'), 'Cmd+Shift+Z'),
          { type: 'separator' },
          { role: 'cut', label: labelOf(editItems, 'edit:cut', '오려 두기') },
          { role: 'copy', label: labelOf(editItems, 'edit:copy', '복사하기') },
          { role: 'paste', label: labelOf(editItems, 'edit:paste', '붙이기') },
          pasteWithoutFormatting('서식 없이 붙이기'),
          documentEditMenuItem('delete', labelOf(editItems, 'edit:delete', '지우기')),
          { type: 'separator' },
          documentEditMenuItem('select-all', labelOf(editItems, 'edit:select-all', '모두 선택'), 'CmdOrCtrl+A'),
          { type: 'separator' },
          ...editExtras,
        ]),
      },
      {
        label: viewMenu?.label ?? '보기',
        submenu: tidySeparators([
          ...(viewMenu?.items ?? []).map(toNative),
          { type: 'separator' },
          agentItem('에이전트 사이드바 보기/숨기기', 'Ctrl+Cmd+S', 'toggle-sidebar'),
          agentItem('대화 집중 모드', 'Ctrl+Cmd+J', 'toggle-focus-chat'),
          { type: 'separator' },
          { role: 'togglefullscreen', label: '전체 화면' },
          ...developmentItems,
        ]),
      },
      ...rendererTopLevel,
      {
        label: '윈도우',
        role: 'window',
        submenu: [
          minimizeWindow('최소화'),
          { role: 'zoom', label: '확대/축소' },
          { type: 'separator' },
          { role: 'front', label: '모두 앞으로 가져오기' },
        ],
      },
    ]);
  };

  // 메뉴 막대는 앱 전체에 하나뿐이므로 초점을 가진 창의 최신 모델로 다시 짓는다.
  const rebuild = (window) => {
    const owner = window && !window.isDestroyed() ? window : null;
    const ownerId = owner ? owner.webContents.id : -1;
    const model = owner ? models.get(ownerId) ?? null : null;
    if (built.ownerId === ownerId && built.model === model) return;
    built = { ownerId, model };
    Menu.setApplicationMenu(build(owner, model));
  };

  ipcMain.on(APP_MENU_MODEL_CHANNEL, (event, raw) => {
    if (!isTrustedSender(event)) return;
    const sender = event.sender;
    if (!models.has(sender.id)) {
      sender.once('destroyed', () => {
        models.delete(sender.id);
        if (built.ownerId === sender.id) rebuild(BrowserWindow.getFocusedWindow());
      });
    }
    models.set(sender.id, sanitizeAppMenuModel(raw));
    const window = BrowserWindow.fromWebContents(sender);
    const focused = BrowserWindow.getFocusedWindow();
    if (window && (window === focused || (!focused && built.ownerId === sender.id))) rebuild(window);
  });
  app.on('browser-window-focus', (_event, window) => rebuild(window));
  rebuild(BrowserWindow.getFocusedWindow());
}


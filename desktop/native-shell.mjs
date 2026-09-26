import { readFile } from 'node:fs/promises';

import { SerializedStateWriter } from './serialized-state-writer.mjs';

/**
 * macOS 네이티브 셸 연동: 창 위치 복원, 문서 상태(프록시 아이콘·미저장 점),
 * 에이전트 알림과 Dock 배지, 네이티브 우클릭 메뉴, 저장 확인 시트.
 * Electron 모듈은 주입받아 main.mjs 밖에서도 읽기 쉽게 둔다.
 */

const MIN_VISIBLE_EDGE = 80;

function finiteInt(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function normalizeBounds(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bounds = {
    x: finiteInt(raw.x),
    y: finiteInt(raw.y),
    width: finiteInt(raw.width),
    height: finiteInt(raw.height),
  };
  if (Object.values(bounds).some((value) => value === null)) return null;
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return bounds;
}

/** 저장된 사각형을 보이는 디스플레이의 작업 영역 안으로 끌어온다. */
export function clampBoundsToDisplay(bounds, workArea, minimum = { width: 0, height: 0 }) {
  const width = Math.min(Math.max(bounds.width, minimum.width), workArea.width);
  const height = Math.min(Math.max(bounds.height, minimum.height), workArea.height);
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height);
  return { x, y, width, height };
}

function overlapsEnough(bounds, workArea) {
  const w = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
  const h = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
  return w >= MIN_VISIBLE_EDGE && h >= MIN_VISIBLE_EDGE;
}

/** 마지막으로 닫히거나 옮겨진 창의 프레임을 기억해 다음 실행의 첫 창에 돌려준다. */
export class WindowFrameStore {
  #filePath;
  #screen;
  #state = null;
  #restoredThisLaunch = false;
  #writer;

  constructor({ filePath, screen, writeAtomically }) {
    this.#filePath = filePath;
    this.#screen = screen;
    this.#writer = new SerializedStateWriter({
      write: (snapshot) => writeAtomically(filePath, Buffer.from(snapshot, 'utf8')),
      onError: (error) => console.warn('[rauhwpx] window frame persist failed:', error),
    });
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, 'utf8'));
      const bounds = normalizeBounds(parsed?.bounds);
      this.#state = bounds ? { bounds, zoomed: parsed.zoomed === true } : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[rauhwpx] window frame state unreadable:', error);
      this.#state = null;
    }
  }

  /** 첫 창이면 복원할 프레임을, 아니면 null 을 준다(추가 창은 기존 계단식 배치). */
  takeInitialFrame({ minWidth = 0, minHeight = 0 } = {}) {
    if (this.#restoredThisLaunch) return null;
    this.#restoredThisLaunch = true;
    if (!this.#state) return null;
    const { bounds, zoomed } = this.#state;
    const displays = this.#screen.getAllDisplays();
    const visible = displays.some((display) => overlapsEnough(bounds, display.workArea));
    const display = visible
      ? this.#screen.getDisplayMatching(bounds)
      : this.#screen.getPrimaryDisplay();
    const source = visible
      ? bounds
      : {
          ...bounds,
          x: display.workArea.x + Math.round((display.workArea.width - bounds.width) / 2),
          y: display.workArea.y + Math.round((display.workArea.height - bounds.height) / 2),
        };
    return {
      bounds: clampBoundsToDisplay(source, display.workArea, { width: minWidth, height: minHeight }),
      zoomed,
    };
  }

  track(window) {
    let timer = null;
    const capture = () => {
      if (window.isDestroyed() || window.isFullScreen() || window.isMinimized()) return;
      const bounds = normalizeBounds(window.getNormalBounds());
      if (!bounds) return;
      this.#state = { bounds, zoomed: window.isMaximized() };
      this.#writer.enqueue(JSON.stringify(this.#state));
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        capture();
      }, 400);
      timer.unref?.();
    };
    for (const eventName of ['moved', 'resized', 'maximize', 'unmaximize']) {
      window.on(eventName, schedule);
    }
    window.on('close', () => {
      if (timer) clearTimeout(timer);
      timer = null;
      capture();
    });
  }
}

/**
 * 창별 에이전트 상태: 미검토 변경 수를 모아 Dock 배지로, 백그라운드 턴 완료는 알림으로.
 */
export class AgentAttention {
  #app;
  #Notification;
  #counts = new Map();
  #notifications = new Set();

  constructor({ app, Notification }) {
    this.#app = app;
    this.#Notification = Notification;
  }

  setPendingCount(windowId, count) {
    const id = windowId;
    const next = Number.isSafeInteger(count) && count > 0 ? Math.min(count, 9999) : 0;
    if (next === 0) this.#counts.delete(id);
    else this.#counts.set(id, next);
    this.#syncBadge();
  }

  forget(windowId) {
    if (this.#counts.delete(windowId)) this.#syncBadge();
  }

  turnFinished(window, { title, body }) {
    if (process.platform !== 'darwin' || window.isDestroyed() || window.isFocused()) return;
    this.#app.dock?.bounce('informational');
    try {
      if (!this.#Notification.isSupported()) return;
      const notification = new this.#Notification({
        title: typeof title === 'string' && title ? title.slice(0, 200) : 'Rauhwpx',
        body: typeof body === 'string' ? body.slice(0, 200) : '',
        silent: false,
      });
      // 클릭 전에 GC 되지 않도록 붙잡아 둔다.
      this.#notifications.add(notification);
      const release = () => this.#notifications.delete(notification);
      notification.on('click', () => {
        release();
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      });
      notification.on('close', release);
      notification.show();
    } catch (error) {
      console.warn('[rauhwpx] agent notification failed:', error);
    }
  }

  #syncBadge() {
    if (process.platform !== 'darwin' || !this.#app.dock) return;
    let total = 0;
    for (const count of this.#counts.values()) total += count;
    this.#app.dock.setBadge(total > 0 ? String(total) : '');
  }
}

/** 렌더러가 넘긴 항목을 검증해 네이티브 메뉴로 띄우고 고른 id 를 돌려준다. */
export function popupContextMenu({ Menu, window, items }) {
  return new Promise((resolve) => {
    const template = [];
    for (const item of Array.isArray(items) ? items.slice(0, 64) : []) {
      if (item?.type === 'separator') {
        if (template.length && template.at(-1).type !== 'separator') template.push({ type: 'separator' });
        continue;
      }
      if (typeof item?.id !== 'string' || typeof item.label !== 'string') continue;
      const id = item.id.slice(0, 200);
      const entry = {
        label: item.label.slice(0, 200),
        enabled: item.enabled !== false,
        click: () => resolve(id),
      };
      if (typeof item.checked === 'boolean' && item.checked) {
        entry.type = 'checkbox';
        entry.checked = true;
      }
      template.push(entry);
    }
    while (template.at(-1)?.type === 'separator') template.pop();
    if (!template.length || window.isDestroyed()) {
      resolve(null);
      return;
    }
    // 닫힘 callback 이 click 보다 먼저 올 수 있어 null 은 조금 늦게 확정한다.
    Menu.buildFromTemplate(template).popup({
      window,
      callback: () => setTimeout(() => resolve(null), 50),
    });
  });
}

/** 입력 필드나 선택한 글자에만 네이티브 텍스트 메뉴를 띄운다. */
export function installTextContextMenu({ Menu, webContents, window, isMac }) {
  webContents.on('context-menu', (_event, params) => {
    const hasSelection = typeof params.selectionText === 'string' && params.selectionText.trim().length > 0;
    if (!params.isEditable && !hasSelection) return;
    const flags = params.editFlags ?? {};
    const template = [];
    if (params.isEditable && params.misspelledWord) {
      const suggestions = (params.dictionarySuggestions ?? []).slice(0, 5);
      for (const suggestion of suggestions) {
        template.push({
          label: suggestion,
          click: () => webContents.replaceMisspelling(suggestion),
        });
      }
      if (suggestions.length) template.push({ type: 'separator' });
    }
    if (isMac && hasSelection) {
      const word = params.selectionText.trim().replace(/\s+/g, ' ');
      const shown = word.length > 24 ? `${word.slice(0, 24)}…` : word;
      template.push({ label: `"${shown}" 찾아보기`, click: () => webContents.showDefinitionForSelection() });
      template.push({ type: 'separator' });
    }
    if (params.isEditable) {
      template.push({ role: 'cut', label: '오려두기', enabled: flags.canCut !== false });
    }
    template.push({ role: 'copy', label: '복사하기', enabled: flags.canCopy !== false });
    if (params.isEditable) {
      template.push({ role: 'paste', label: '붙여넣기', enabled: flags.canPaste !== false });
      template.push({ type: 'separator' });
      template.push({ role: 'selectAll', label: '모두 선택', enabled: flags.canSelectAll !== false });
    }
    Menu.buildFromTemplate(template).popup({ window });
  });
}

/** macOS 창에 붙는 저장 확인 시트. */
export async function showUnsavedChangesSheet({ dialog, window, fileName }) {
  const name = typeof fileName === 'string' && fileName.trim() ? fileName.trim().slice(0, 200) : '현재 문서';
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    message: `"${name}"의 변경 내용을 저장하시겠습니까?`,
    buttons: ['저장', '저장 안 함', '취소'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
}

/** 닫기 버튼의 미저장 점. */
export function applyDocumentState(window, { edited }) {
  if (process.platform !== 'darwin' || window.isDestroyed()) return;
  window.setDocumentEdited(edited === true);
}

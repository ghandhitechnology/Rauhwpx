/**
 * 사이드바·설정 공용 확인 시트.
 *
 * 사이드바 안에서 열면 아래에서 올라오고, 사이드바 밖(전체 화면·본문)에서는
 * 가운데 카드로 뜬다. Esc·배경 클릭·아래로 끌기로 닫으며, 닫히면 false 다.
 * window.confirm 을 대신하므로 결과는 Promise<boolean> 하나로 돌려준다.
 */
import './sheet.css';

export interface SheetOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 되돌릴 수 없는 동작이면 확인 버튼을 경고색으로 칠한다. */
  destructive?: boolean;
  /** 시트를 띄울 기준 요소. 가장 가까운 .ag-root 안에 뜬다. */
  anchor?: Element | null;
}

const DISMISS_DISTANCE_PX = 72;
const DISMISS_VELOCITY = 0.6; // px/ms

let openCount = 0;

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function resolveHost(anchor?: Element | null): { host: HTMLElement; docked: boolean } {
  const root = (anchor?.closest('.ag-root') ?? document.querySelector('.ag-root:not(.ag-collapsed)')) as HTMLElement | null;
  if (root && !root.classList.contains('ag-collapsed')) {
    const docked = !root.classList.contains('ag-fullscreen');
    return { host: root, docked };
  }
  return { host: document.body, docked: false };
}

function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => node.offsetParent !== null || node === document.activeElement);
}

export function showSheet(options: SheetOptions): Promise<boolean> {
  const { host, docked } = resolveHost(options.anchor);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  openCount += 1;
  const id = `ag-sheet-${openCount}`;

  const layer = document.createElement('div');
  layer.className = 'ag-sheet-layer';
  layer.dataset.placement = docked ? 'docked' : 'center';
  if (host === document.body) layer.dataset.host = 'body';

  const backdrop = document.createElement('div');
  backdrop.className = 'ag-sheet-backdrop';

  const sheet = document.createElement('section');
  sheet.className = 'ag-sheet';
  sheet.setAttribute('role', 'alertdialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', `${id}-title`);
  sheet.tabIndex = -1;

  const grabber = document.createElement('div');
  grabber.className = 'ag-sheet-grabber';
  grabber.setAttribute('aria-hidden', 'true');

  const title = document.createElement('h2');
  title.className = 'ag-sheet-title';
  title.id = `${id}-title`;
  title.textContent = options.title;
  sheet.append(grabber, title);

  if (options.message) {
    const message = document.createElement('p');
    message.className = 'ag-sheet-message';
    message.id = `${id}-message`;
    message.textContent = options.message;
    sheet.setAttribute('aria-describedby', message.id);
    sheet.append(message);
  }

  const actions = document.createElement('div');
  actions.className = 'ag-sheet-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ag-sheet-btn ag-sheet-cancel';
  cancel.textContent = options.cancelLabel ?? '취소';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'ag-sheet-btn ag-sheet-confirm';
  if (options.destructive) confirm.dataset.tone = 'destructive';
  confirm.textContent = options.confirmLabel ?? '확인';
  actions.append(cancel, confirm);
  sheet.append(actions);

  layer.append(backdrop, sheet);
  host.appendChild(layer);

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      layer.classList.remove('ag-sheet-open');
      layer.classList.add('ag-sheet-closing');
      sheet.style.removeProperty('transform');
      const remove = () => layer.remove();
      if (reducedMotion()) remove();
      else {
        sheet.addEventListener('transitionend', remove, { once: true });
        window.setTimeout(remove, 480);
      }
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(result);
    };

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables(sheet);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !sheet.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !sheet.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', () => finish(false));
    document.addEventListener('keydown', onKeyDown, true);

    // 아래로 끌어 닫기 — 도킹된 시트에서만.
    if (docked) {
      let startY = 0;
      let startT = 0;
      let dragging = false;
      let offset = 0;
      sheet.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || (event.target as Element).closest('button')) return;
        dragging = true;
        startY = event.clientY;
        startT = performance.now();
        offset = 0;
        sheet.setPointerCapture(event.pointerId);
        sheet.classList.add('ag-sheet-dragging');
      });
      sheet.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        offset = Math.max(0, event.clientY - startY);
        sheet.style.transform = `translateY(${offset}px)`;
      });
      const end = (event: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        sheet.classList.remove('ag-sheet-dragging');
        if (sheet.hasPointerCapture(event.pointerId)) sheet.releasePointerCapture(event.pointerId);
        const velocity = offset / Math.max(1, performance.now() - startT);
        if (offset > DISMISS_DISTANCE_PX || velocity > DISMISS_VELOCITY) finish(false);
        else sheet.style.removeProperty('transform');
      };
      sheet.addEventListener('pointerup', end);
      sheet.addEventListener('pointercancel', end);
    }

    requestAnimationFrame(() => {
      layer.classList.add('ag-sheet-open');
      (options.destructive ? cancel : confirm).focus({ preventScroll: true });
    });
  });
}

/** window.confirm 과 같은 모양으로 쓰는 짧은 확인. */
export function confirmSheet(
  anchor: Element | null | undefined,
  title: string,
  message?: string,
  extra: Omit<SheetOptions, 'title' | 'message' | 'anchor'> = {},
): Promise<boolean> {
  return showSheet({ ...extra, title, message, anchor });
}

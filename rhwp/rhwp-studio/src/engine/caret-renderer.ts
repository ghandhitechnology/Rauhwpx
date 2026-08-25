import type { CursorRect } from '@/core/types';
import { VirtualScroll } from '@/view/virtual-scroll';

/** 활자를 이어 치는 동안 깜박임을 멈춰 두는 시간(ms). */
const TYPING_IDLE_MS = 500;
/** 삭제 결과를 눈으로 따라갈 수 있게 하는 짧은 캐럿 이동 시간(ms). */
const ERASE_MOTION_MS = 50;

/**
 * Canvas 위에 캐럿을 렌더링한다.
 *
 * 위치는 transform 으로 즉시 옮긴다. 사용자 입력과 키보드 이동에 보간을
 * 두지 않아, 입력 결과와 캐럿이 같은 프레임에 도착하는 고전적인 동작을
 * 유지한다. 에이전트 편집의 typewriter reveal은 별도 렌더러가 담당한다.
 */
export class CaretRenderer {
  private caretEl: HTMLDivElement;
  private currentRect: CursorRect | null = null;

  // IME 조합 밑줄 — 글리프는 엔진 캔버스가 그린다. 같은 줄일 때만 1.5px 선을 얹는다.
  private underlineEl: HTMLDivElement;
  private isCompMode = false;

  private typingIdleTimer: number | null = null;
  private eraseMotionDepth = 0;
  private eraseMotionTimer: number | null = null;

  constructor(
    private container: HTMLElement,
    private virtualScroll: VirtualScroll,
  ) {
    this.caretEl = document.createElement('div');
    this.caretEl.className = 'caret';
    // 기하 정보만 인라인으로 둔다. 깜박임은 editor.css 가 갖는다.
    this.caretEl.style.cssText =
      'position:absolute;left:0;top:0;width:2px;background:var(--caret-color,#000);' +
      'pointer-events:none;z-index:10;display:none;transform-origin:0 0;';

    // IME 조합 밑줄. 글리프 캔버스가 아니라 div 라 #scroll-content canvas
    // 용지 규칙(중앙 정렬 transform + 배경/그림자)을 물려받지 않는다.
    this.underlineEl = document.createElement('div');
    this.underlineEl.className = 'caret-composition';
    this.underlineEl.style.cssText =
      'position:absolute;pointer-events:none;z-index:10;display:none;' +
      'height:1.5px;background:currentColor;color:#000;transform:none;' +
      'box-shadow:none;';

    // scroll-content 안에 배치 (스크롤과 함께 이동)
    const scrollContent = container.querySelector('#scroll-content');
    if (scrollContent) {
      scrollContent.appendChild(this.caretEl);
      scrollContent.appendChild(this.underlineEl);
    } else {
      container.appendChild(this.caretEl);
      container.appendChild(this.underlineEl);
    }
  }

  /** 캐럿을 표시한다 */
  show(rect: CursorRect, zoom: number): void {
    this.ensureAttached();
    this.currentRect = rect;
    this.updatePosition(zoom);
    this.caretEl.style.display = 'block';
    this.startBlink();
  }

  /** 캐럿을 숨긴다 */
  hide(): void {
    this.stopBlink();
    this.clearTypingIdle();
    this.clearEraseMotion();
    this.eraseMotionDepth = 0;
    this.caretEl.style.display = 'none';
    this.underlineEl.style.display = 'none';
    this.isCompMode = false;
    this.currentRect = null;
  }

  /** 줌/스크롤 변경 시 위치를 즉시 갱신한다. */
  updatePosition(zoom: number): void {
    this.applyRect(zoom);
  }

  /** 새 CursorRect로 갱신한다 (타자/커서 이동) */
  update(rect: CursorRect, zoom: number): void {
    this.ensureAttached();
    this.currentRect = rect;
    this.applyRect(zoom);
    this.caretEl.style.display = 'block';
    this.holdSolidWhileTyping();
  }

  /** 드래그 중 캐럿 위치를 갱신한다 — 포인터를 정확히 따라가야 하므로 즉시 반영 */
  updateLive(rect: CursorRect, zoom: number): void {
    this.ensureAttached();
    this.currentRect = rect;
    this.applyRect(zoom);
    this.caretEl.style.display = 'block';
    this.holdSolidWhileTyping();
  }

  /**
   * Backspace/Delete 처리 중에만 다음 캐럿 이동을 아주 짧게 완화한다.
   * 일반 입력과 탐색은 이 범위 밖이므로 계속 즉시 반영된다.
   */
  beginEraseMotion(): void {
    this.eraseMotionDepth += 1;
  }

  endEraseMotion(): void {
    this.eraseMotionDepth = Math.max(0, this.eraseMotionDepth - 1);
  }

  /**
   * 같은 줄의 조합 범위에만 1.5px 밑줄을 그린다. 줄바꿈이 일어나면 숨긴다 —
   * 글리프는 이미 엔진 캔버스에 있다.
   */
  showCompositionUnderline(startRect: CursorRect, endRect: CursorRect, zoom: number): void {
    this.ensureAttached();
    this.isCompMode = true;

    const sameLine = startRect.pageIndex === endRect.pageIndex
      && Math.abs(startRect.y - endRect.y) < Math.max(startRect.height, endRect.height, 1) * 0.5;
    const rawWidth = endRect.x - startRect.x;
    if (!sameLine || !(rawWidth > 0)) {
      this.underlineEl.style.display = 'none';
      return;
    }

    let x = startRect.x;
    let w = rawWidth;
    const bounds = startRect.cellBounds ?? endRect.cellBounds;
    if (bounds) {
      const maxX = bounds.x + bounds.w;
      x = Math.min(Math.max(x, bounds.x), maxX);
      w = Math.min(w, Math.max(0, maxX - x));
    }
    if (!(w > 0)) {
      this.underlineEl.style.display = 'none';
      return;
    }

    const pageLeft = this.calcPageLeft(startRect.pageIndex);
    const pageOffset = this.virtualScroll.getPageOffset(startRect.pageIndex);
    this.underlineEl.style.left = `${pageLeft + x * zoom}px`;
    this.underlineEl.style.top = `${pageOffset + (startRect.y + startRect.height) * zoom - 1.5}px`;
    this.underlineEl.style.width = `${w * zoom}px`;
    this.underlineEl.style.display = 'block';
  }

  /** IME 조합 밑줄을 숨긴다 */
  hideComposition(): void {
    if (!this.isCompMode) return;
    this.isCompMode = false;
    this.underlineEl.style.display = 'none';
  }

  /** 현재 rect 를 화면 좌표로 바꿔 적용한다. */
  private applyRect(zoom: number): void {
    if (!this.currentRect) return;
    const { pageIndex } = this.currentRect;
    const { x, y, height } = this.clampCaretRect(this.currentRect, zoom);
    const pageOffset = this.virtualScroll.getPageOffset(pageIndex);
    const pageLeft = this.calcPageLeft(pageIndex);

    const nextX = pageLeft + x * zoom;
    const nextY = pageOffset + y * zoom;
    const nextH = height * zoom;

    if (this.eraseMotionDepth > 0) {
      if (this.eraseMotionTimer !== null) clearTimeout(this.eraseMotionTimer);
      this.caretEl.classList.add('is-erasing');
    } else {
      // 삭제 직후 곧바로 입력/탐색하면 남은 transition을 즉시 끊는다.
      this.clearEraseMotion();
    }
    this.caretEl.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
    this.caretEl.style.height = `${nextH}px`;
    if (this.eraseMotionDepth > 0) {
      this.eraseMotionTimer = window.setTimeout(() => {
        this.eraseMotionTimer = null;
        this.caretEl.classList.remove('is-erasing');
      }, ERASE_MOTION_MS);
    }
  }

  /**
   * 타자를 치는 동안에는 깜박이지 않는다. 이동 중에 깜박임이 겹치면
   * 캐럿이 사라졌다 나타나며 흐름이 끊긴다. 손을 멈추면 다시 깜박인다.
   */
  private holdSolidWhileTyping(): void {
    this.stopBlink();
    this.caretEl.classList.remove('is-blinking');
    this.caretEl.style.opacity = '1';
    this.clearTypingIdle();
    this.typingIdleTimer = window.setTimeout(() => {
      this.typingIdleTimer = null;
      if (!this.isCompMode && this.currentRect) this.startBlink();
    }, TYPING_IDLE_MS);
  }

  private clearTypingIdle(): void {
    if (this.typingIdleTimer !== null) {
      clearTimeout(this.typingIdleTimer);
      this.typingIdleTimer = null;
    }
  }

  private clearEraseMotion(): void {
    if (this.eraseMotionTimer !== null) {
      clearTimeout(this.eraseMotionTimer);
      this.eraseMotionTimer = null;
    }
    this.caretEl.classList.remove('is-erasing');
  }

  /** 셀 bbox가 있는 캐럿은 DOM 선 폭까지 셀 안에 남도록 보정한다. */
  private clampCaretRect(rect: CursorRect, zoom: number): { x: number; y: number; height: number } {
    const bounds = rect.cellBounds;
    if (!bounds) return rect;

    const caretWidth = 2 / Math.max(zoom, 0.01);
    const height = Math.min(rect.height, Math.max(0, bounds.h));
    const maxX = Math.max(bounds.x, bounds.x + bounds.w - caretWidth);
    const maxY = Math.max(bounds.y, bounds.y + bounds.h - height);
    return {
      x: Math.min(Math.max(rect.x, bounds.x), maxX),
      y: Math.min(Math.max(rect.y, bounds.y), maxY),
      height,
    };
  }

  /** 페이지의 화면 X 좌표를 계산한다 (그리드/단일 열 공통) */
  private calcPageLeft(pageIndex: number): number {
    const gridLeft = this.virtualScroll.getPageLeft(pageIndex);
    if (gridLeft >= 0) return gridLeft;
    // 단일 열: CSS 중앙 정렬 보정
    const scrollContent = this.container.querySelector('#scroll-content');
    const contentWidth = scrollContent?.clientWidth ?? 0;
    const pageDisplayWidth = this.virtualScroll.getPageWidth(pageIndex);
    return (contentWidth - pageDisplayWidth) / 2;
  }

  /** 캐럿 엘리먼트가 DOM에 없으면 재부착한다 (loadDocument 후 컨테이너 교체 대응) */
  private ensureAttached(): void {
    const scrollContent = this.container.querySelector('#scroll-content');
    if (this.caretEl.parentElement && this.underlineEl.parentElement) return;
    if (scrollContent) {
      if (!this.caretEl.parentElement) scrollContent.appendChild(this.caretEl);
      if (!this.underlineEl.parentElement) scrollContent.appendChild(this.underlineEl);
    }
  }

  /** 고전적인 on/off 깜박임은 CSS의 step 애니메이션에 맡긴다. */
  private startBlink(): void {
    this.stopBlink();
    if (this.isCompMode) return;
    this.caretEl.style.opacity = '';
    this.caretEl.classList.add('is-blinking');
  }

  private stopBlink(): void {
    this.caretEl.classList.remove('is-blinking');
    this.underlineEl.classList.remove('is-blinking');
  }

  dispose(): void {
    this.stopBlink();
    this.clearTypingIdle();
    this.clearEraseMotion();
    this.caretEl.remove();
    this.underlineEl.remove();
  }
}

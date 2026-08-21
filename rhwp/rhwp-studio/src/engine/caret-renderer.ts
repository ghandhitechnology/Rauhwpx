import type { CursorRect } from '@/core/types';
import { VirtualScroll } from '@/view/virtual-scroll';

/** 캐럿 이동을 애니메이션할지 즉시 반영할지. */
type MoveMode = 'glide' | 'snap';

/** 활자를 이어 치는 동안 깜박임을 멈춰 두는 시간(ms). */
const TYPING_IDLE_MS = 620;

/**
 * '즉시 반영' 표시의 유효 기간(ms). pointerdown 뒤 캐럿 갱신은 한두
 * 프레임 안에 오므로 넉넉하고, 클릭 후 바로 타자를 쳐도 그 글자까지
 * 튀지 않을 만큼은 짧다.
 */
const SNAP_REQUEST_TTL_MS = 250;

/** 이 거리를 넘어가는 이동은 '흐르는' 것이 아니라 '뛰는' 것이다. */
const GLIDE_MAX_DISTANCE_PX = 600;

/** 세로로 이 배수(줄 높이 기준)를 넘으면 다른 문단으로 뛴 것으로 본다. */
const GLIDE_MAX_LINE_FACTOR = 2.2;

/**
 * 이동 거리에 따른 지속 시간 범위(ms). 타자 한 글자는 아래쪽 끝에 붙는다.
 *
 * 85ms 는 '즉각적인 피드백' 구간(100~150ms)의 아래쪽으로, 흐름이 눈에
 * 보이되 지연으로 읽히지는 않는 지점이다. 빠르게 쳐도(초당 10자, 100ms
 * 간격) 다음 글자 전에 끝난다.
 */
const GLIDE_MIN_MS = 70;
const GLIDE_MAX_MS = 150;

/**
 * Canvas 위에 캐럿을 렌더링한다.
 *
 * 위치는 left/top 이 아니라 transform 으로 옮긴다 — 합성만으로 처리되어
 * 레이아웃을 건드리지 않고, 타자 중에도 캔버스 렌더 루프와 경쟁하지 않는다.
 * 높이는 애니메이션하지 않는다(글자 크기가 바뀌는 순간은 드물고,
 * 높이를 트랜지션하면 레이아웃 속성을 움직이게 된다).
 */
export class CaretRenderer {
  private caretEl: HTMLDivElement;
  private blinkTimer: number | null = null;
  private visible = false;
  private currentRect: CursorRect | null = null;

  // IME 조합 오버레이
  private compEl: HTMLCanvasElement;
  /** preedit 폭만큼 현재 줄의 뒤쪽 픽셀을 밀어 주는 transient 복제 레이어. */
  private compFlowEl: HTMLCanvasElement;
  private isCompMode = false;

  // 부드러운 이동 상태
  private lastX: number | null = null;
  private lastY: number | null = null;
  private lastPageIndex: number | null = null;
  private typingIdleTimer: number | null = null;
  private reduceMotion: MediaQueryList | null = null;
  /**
   * 다음 이동 한 번을 즉시 반영해야 하는 시각(ms). 줌처럼 화면이 통째로
   * 다시 잡힌 직후, 그리고 포인터로 캐럿을 찍은 직후에 세운다.
   * 소비되지 않은 채 남지 않도록 짧은 유효 기간을 둔다.
   */
  private snapRequestedAt: number | null = null;
  private onPointerDown: (() => void) | null = null;

  constructor(
    private container: HTMLElement,
    private virtualScroll: VirtualScroll,
  ) {
    this.caretEl = document.createElement('div');
    this.caretEl.className = 'caret';
    // 기하 정보만 인라인으로 둔다. 움직임/깜박임은 editor.css 가 갖는다.
    this.caretEl.style.cssText =
      'position:absolute;left:0;top:0;width:2px;background:var(--caret-color,#000);' +
      'pointer-events:none;z-index:10;display:none;transform-origin:0 0;';

    // IME 조합 오버레이 (블랙박스 + 흰색 글자)
    this.compEl = document.createElement('canvas');
    this.compEl.className = 'caret-composition';
    // 조합 중 글자는 문서 글자와 같은 모습(흰 종이 위 검은 글자)으로 보여주고,
    // 조합 중임은 밑줄로만 표시한다. DOM 텍스트로 두면 line-box 수직 중앙정렬이
    // 글리프 위아래를 잘라(overflow:hidden) 확정 글자보다 작아 보이므로, 페이지와
    // 같은 캔버스 래스터로 엔진의 baseline 관례에 맞춰 직접 그린다.
    // #scroll-content canvas 규칙(중앙 정렬 transform + 용지 배경/그림자)이 이
    // 캔버스에도 걸리므로 compFlowEl 과 동일하게 인라인으로 전부 무효화한다.
    this.compEl.style.cssText =
      'position:absolute;pointer-events:none;z-index:10;display:none;' +
      'transform:none;background:transparent;box-shadow:none;';
    this.compFlowEl = document.createElement('canvas');
    this.compFlowEl.className = 'caret-composition-flow';
    // #scroll-content canvas 규칙(페이지 중앙 정렬 translateX(-50%) + 용지 배경/그림자)이
    // 이 캔버스에도 걸린다. 그대로 두면 조합 띠가 절반 폭만큼 왼쪽으로 밀린 흰 막대로
    // 보이므로, 인라인으로 전부 무효화한다.
    this.compFlowEl.style.cssText =
      'position:absolute;pointer-events:none;z-index:9;display:none;' +
      'transform:none;background:transparent;box-shadow:none;';

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    }

    // 클릭으로 찍은 자리는 '흘러가는' 곳이 아니라 '가리킨' 곳이다.
    // 포인터로 옮긴 캐럿은 그 자리에 바로 나타나야 한다.
    // update() 는 키보드와 마우스 양쪽에서 불리므로, 직전 pointerdown 을
    // 근거로 이번 한 번을 즉시 반영한다.
    this.onPointerDown = () => this.requestSnap();
    container.addEventListener('pointerdown', this.onPointerDown, { capture: true });

    // scroll-content 안에 배치 (스크롤과 함께 이동)
    const scrollContent = container.querySelector('#scroll-content');
    if (scrollContent) {
      scrollContent.appendChild(this.caretEl);
      scrollContent.appendChild(this.compFlowEl);
      scrollContent.appendChild(this.compEl);
    } else {
      container.appendChild(this.caretEl);
      container.appendChild(this.compFlowEl);
      container.appendChild(this.compEl);
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
    this.caretEl.style.display = 'none';
    this.compEl.style.display = 'none';
    this.compFlowEl.style.display = 'none';
    this.isCompMode = false;
    this.currentRect = null;
    this.forgetLastPosition();
  }

  /**
   * 줌/스크롤 변경 시 위치를 갱신한다.
   *
   * 줌은 화면 전체가 다시 잡히는 순간이라 캐럿만 뒤따라 흐르면 어긋나 보인다.
   * 이 호출 자체를 즉시 반영하는 것만으로는 부족하다 — 줌 뒤에 커서 갱신
   * 경로가 update() 를 한 번 더 부르기 때문에, 그 한 번도 흐르지 않게 막는다.
   */
  updatePosition(zoom: number): void {
    this.applyRect(zoom, 'snap');
    this.requestSnap();
  }

  /** 다음 이동 한 번을 즉시 반영하도록 표시한다. */
  private requestSnap(): void {
    this.snapRequestedAt = Date.now();
  }

  /**
   * 표시가 서 있고 아직 유효하면 소비한다.
   * 캐럿을 움직이지 않는 클릭(빈 곳 클릭 등) 뒤에 표시가 남아 다음
   * 타자를 튀게 만들지 않도록, 지나간 표시는 그냥 버린다.
   */
  private consumeSnapRequest(): boolean {
    if (this.snapRequestedAt === null) return false;
    const fresh = Date.now() - this.snapRequestedAt < SNAP_REQUEST_TTL_MS;
    this.snapRequestedAt = null;
    return fresh;
  }

  /** 새 CursorRect로 갱신한다 (타자/커서 이동) */
  update(rect: CursorRect, zoom: number): void {
    this.ensureAttached();
    this.currentRect = rect;
    this.applyRect(zoom, 'glide');
    // 조합 모드가 아닐 때만 일반 캐럿 표시
    if (!this.isCompMode) {
      this.caretEl.style.display = 'block';
      this.visible = true;
      this.holdSolidWhileTyping();
    }
  }

  /** 드래그 중 캐럿 위치를 갱신한다 — 포인터를 정확히 따라가야 하므로 즉시 반영 */
  updateLive(rect: CursorRect, zoom: number): void {
    this.ensureAttached();
    this.currentRect = rect;
    this.applyRect(zoom, 'snap');
    if (!this.isCompMode) {
      this.caretEl.style.display = 'block';
      this.visible = true;
      this.holdSolidWhileTyping();
    }
  }

  /** IME 조합 오버레이를 표시한다. fontSizePx 는 문서 글꼴의 실제 px 크기(줌 미적용). */
  showComposition(
    startRect: CursorRect,
    charWidth: number,
    zoom: number,
    text: string,
    fontFamily: string,
    fontSizePx = 0,
  ): void {
    this.ensureAttached();
    this.isCompMode = true;

    // 일반 캐럿 숨기기
    this.caretEl.style.display = 'none';
    // 조합이 끝나고 캐럿이 돌아올 때 엉뚱한 지점에서 흐르지 않도록 기준점을 버린다.
    this.forgetLastPosition();

    const { pageIndex } = startRect;
    const box = this.clampCompositionBox(startRect, charWidth);
    const pageOffset = this.virtualScroll.getPageOffset(pageIndex);
    const pageLeft = this.calcPageLeft(pageIndex);

    // 블랙박스 위치/크기
    const w = box.w * zoom;
    const h = box.h * zoom;
    const left = pageLeft + box.x * zoom;
    const top = pageOffset + box.y * zoom;

    // preedit은 문서에 넣지 않으므로 Canvas 원문은 그대로다. 현재 줄의
    // 오른쪽 부분만 복제해 preedit 폭만큼 밀어, 다음 글자가 검은 상자에
    // 가려지지 않게 한다.
    this.renderCompositionFlow(startRect, box, zoom, pageLeft, pageOffset);

    // 조합 중인 글자는 자모가 합쳐질 때마다 상자가 바뀐다. 이 상자는
    // 입력을 그대로 비추는 거울이라 절대 애니메이션하지 않는다.
    this.compEl.style.left = `${left}px`;
    this.compEl.style.top = `${top}px`;
    this.compEl.style.width = `${w}px`;
    this.compEl.style.height = `${h}px`;
    this.paintComposition(text, fontFamily, fontSizePx, box.h, zoom, w, h);
    this.compEl.style.display = 'block';
    this.visible = true;
    // 조합 상자는 입력을 그대로 비추는 거울이다 — 깜박이면 타자 리듬을 흩뜨린다.
    this.stopBlink();
    this.compEl.style.opacity = '';
  }

  /**
   * preedit 를 페이지와 같은 캔버스 래스터로 그린다.
   *
   * 글꼴 크기는 문서 글꼴의 실제 px(fontSizePx, 줌 미적용)를 그대로 쓰고,
   * baseline 은 엔진의 줄 관례(text_height × 0.85)에 맞춰 얹는다 — 확정 글자와
   * 같은 크기·같은 기준선으로 보인다. 조회 실패(fontSizePx=0) 시에만 기존
   * 근사(0.85 × 상자 높이)로 폴백한다.
   */
  private paintComposition(
    text: string,
    fontFamily: string,
    fontSizePx: number,
    boxDocHeight: number,
    zoom: number,
    w: number,
    h: number,
  ): void {
    const dpr = window.devicePixelRatio || 1;
    this.compEl.width = Math.max(1, Math.ceil(w * dpr));
    this.compEl.height = Math.max(1, Math.ceil(h * dpr));
    const ctx = this.compEl.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    // 배경은 불투명 흰색 — 뒤에는 밀리기 전의 원본 픽셀이 남아 있다.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    const glyphPx = fontSizePx > 0 ? fontSizePx * zoom : boxDocHeight * 0.85 * zoom;
    ctx.font = `${glyphPx}px ${fontFamily || 'sans-serif'}`;
    ctx.textBaseline = 'alphabetic';
    const textWidth = ctx.measureText(text).width;
    ctx.fillText(text, Math.max(0, (w - textWidth) / 2), h * 0.85);
    // 조합 중 표시 밑줄
    ctx.fillRect(0, Math.max(0, h - 1.5), w, 1.5);
  }

  /** IME 조합 오버레이를 숨기고 일반 캐럿으로 복귀한다 */
  hideComposition(): void {
    if (!this.isCompMode) return;
    this.isCompMode = false;
    this.compEl.style.display = 'none';
    this.compFlowEl.style.display = 'none';
    this.compEl.classList.remove('is-blinking');
  }

  /**
   * 원본 페이지의 현재 줄 꼬리를 복제해 조합창 뒤로 민다. 문서/WASM은
   * 건드리지 않으므로 compositionend 커밋과 Undo 계약은 그대로 유지된다.
   */
  private renderCompositionFlow(
    rect: CursorRect,
    box: { x: number; y: number; w: number; h: number },
    zoom: number,
    pageLeft: number,
    pageOffset: number,
  ): void {
    const scrollContent = this.container.querySelector('#scroll-content');
    const source = scrollContent?.querySelector<HTMLCanvasElement>(
      `canvas[data-rhwp-page-index="${rect.pageIndex}"]`,
    );
    const sourceDisplayWidth = source ? Number.parseFloat(source.style.width) : 0;
    const sourceDisplayHeight = source ? Number.parseFloat(source.style.height) : 0;
    if (!source || !(sourceDisplayWidth > 0) || !(sourceDisplayHeight > 0)) {
      this.compFlowEl.style.display = 'none';
      return;
    }

    const right = rect.cellBounds
      ? rect.cellBounds.x + rect.cellBounds.w
      : sourceDisplayWidth / Math.max(zoom, 0.01);
    const flowWidth = Math.max(0, (right - box.x) * zoom);
    const gapWidth = box.w * zoom;
    const copiedWidth = flowWidth - gapWidth;
    const flowHeight = box.h * zoom;
    if (!(copiedWidth > 0) || !(flowHeight > 0)) {
      this.compFlowEl.style.display = 'none';
      return;
    }

    const scaleX = source.width / sourceDisplayWidth;
    const scaleY = source.height / sourceDisplayHeight;
    this.compFlowEl.width = Math.max(1, Math.ceil(flowWidth * scaleX));
    this.compFlowEl.height = Math.max(1, Math.ceil(flowHeight * scaleY));
    this.compFlowEl.style.left = `${pageLeft + box.x * zoom}px`;
    this.compFlowEl.style.top = `${pageOffset + box.y * zoom}px`;
    this.compFlowEl.style.width = `${flowWidth}px`;
    this.compFlowEl.style.height = `${flowHeight}px`;

    const context = this.compFlowEl.getContext('2d');
    if (!context) {
      this.compFlowEl.style.display = 'none';
      return;
    }
    context.clearRect(0, 0, this.compFlowEl.width, this.compFlowEl.height);
    context.drawImage(
      source,
      box.x * zoom * scaleX,
      box.y * zoom * scaleY,
      copiedWidth * scaleX,
      flowHeight * scaleY,
      gapWidth * scaleX,
      0,
      copiedWidth * scaleX,
      flowHeight * scaleY,
    );
    this.compFlowEl.style.display = 'block';
  }

  /** 현재 rect 를 화면 좌표로 바꿔 적용한다. */
  private applyRect(zoom: number, mode: MoveMode): void {
    if (!this.currentRect) return;
    const { pageIndex } = this.currentRect;
    const { x, y, height } = this.clampCaretRect(this.currentRect, zoom);
    const pageOffset = this.virtualScroll.getPageOffset(pageIndex);
    const pageLeft = this.calcPageLeft(pageIndex);

    const nextX = pageLeft + x * zoom;
    const nextY = pageOffset + y * zoom;
    const nextH = height * zoom;

    const resolved = this.resolveMode(mode, nextX, nextY, nextH, pageIndex);
    if (resolved === 'glide') {
      const dist = Math.hypot(nextX - (this.lastX ?? nextX), nextY - (this.lastY ?? nextY));
      this.caretEl.style.transitionDuration = `${this.glideDuration(dist)}ms`;
      this.caretEl.classList.add('is-gliding');
    } else {
      this.caretEl.classList.remove('is-gliding');
    }

    this.caretEl.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
    this.caretEl.style.height = `${nextH}px`;

    this.lastX = nextX;
    this.lastY = nextY;
    this.lastPageIndex = pageIndex;
  }

  /**
   * 흐르게 할지 뛰게 할지 정한다.
   *
   * 흐르는 것은 '이어지는 동작'일 때만 뜻이 있다. 페이지를 건너뛰거나
   * 멀리 클릭한 이동까지 흐르면 느리게 반응하는 것처럼 느껴진다.
   */
  private resolveMode(
    requested: MoveMode,
    nextX: number,
    nextY: number,
    nextH: number,
    pageIndex: number,
  ): MoveMode {
    if (requested === 'snap') return 'snap';
    if (this.consumeSnapRequest()) return 'snap';
    if (this.reduceMotion?.matches) return 'snap';
    if (this.isCompMode) return 'snap';
    if (this.lastX === null || this.lastY === null) return 'snap';
    if (this.lastPageIndex !== pageIndex) return 'snap';

    const dx = Math.abs(nextX - this.lastX);
    const dy = Math.abs(nextY - this.lastY);
    if (dy > Math.max(nextH, 1) * GLIDE_MAX_LINE_FACTOR) return 'snap';
    if (Math.hypot(dx, dy) > GLIDE_MAX_DISTANCE_PX) return 'snap';
    return 'glide';
  }

  /** 짧은 이동은 거의 즉시, 줄바꿈처럼 먼 이동은 조금 더 길게. */
  private glideDuration(distance: number): number {
    const t = Math.min(1, distance / GLIDE_MAX_DISTANCE_PX);
    return Math.round(GLIDE_MIN_MS + (GLIDE_MAX_MS - GLIDE_MIN_MS) * t);
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

  private forgetLastPosition(): void {
    this.lastX = null;
    this.lastY = null;
    this.lastPageIndex = null;
    this.caretEl.classList.remove('is-gliding');
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

  /** IME 조합창은 Canvas clip을 받지 않으므로 셀 가시 bbox로 별도 제한한다. */
  private clampCompositionBox(
    rect: CursorRect,
    charWidth: number,
  ): { x: number; y: number; w: number; h: number } {
    let x = rect.x;
    let y = rect.y;
    let w = Math.max(charWidth, rect.height * 0.6);
    let h = rect.height;
    const bounds = rect.cellBounds;
    if (!bounds) return { x, y, w, h };

    w = Math.min(w, Math.max(0, bounds.w));
    h = Math.min(h, Math.max(0, bounds.h));
    const maxX = Math.max(bounds.x, bounds.x + bounds.w - w);
    const maxY = Math.max(bounds.y, bounds.y + bounds.h - h);
    x = Math.min(Math.max(x, bounds.x), maxX);
    y = Math.min(Math.max(y, bounds.y), maxY);
    return { x, y, w, h };
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
    if (this.caretEl.parentElement && this.compEl.parentElement && this.compFlowEl.parentElement) return;
    if (scrollContent) {
      if (!this.caretEl.parentElement) scrollContent.appendChild(this.caretEl);
      if (!this.compFlowEl.parentElement) scrollContent.appendChild(this.compFlowEl);
      if (!this.compEl.parentElement) scrollContent.appendChild(this.compEl);
    }
  }

  /**
   * 깜박임은 setInterval 로 opacity 를 끄고 켜는 대신 CSS 애니메이션에
   * 맡긴다 — 딱딱하게 잘리지 않고 부드럽게 사그라든다.
   */
  private startBlink(): void {
    this.stopBlink();
    this.visible = true;
    // 조합 상자는 깜박이지 않는다 — 깜박임은 일반 캐럿 전용.
    if (this.isCompMode) return;
    this.caretEl.style.opacity = '';
    this.caretEl.classList.add('is-blinking');
  }

  private stopBlink(): void {
    if (this.blinkTimer !== null) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    this.caretEl.classList.remove('is-blinking');
    this.compEl.classList.remove('is-blinking');
  }

  dispose(): void {
    this.stopBlink();
    this.clearTypingIdle();
    if (this.onPointerDown) {
      this.container.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
      this.onPointerDown = null;
    }
    this.caretEl.remove();
    this.compFlowEl.remove();
    this.compEl.remove();
  }
}

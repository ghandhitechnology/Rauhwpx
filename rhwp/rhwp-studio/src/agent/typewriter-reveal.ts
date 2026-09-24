import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { SelectionRect } from '../core/types.ts';
import type { AgentName, CellAddr, DocRange } from './types.ts';
import {
  computeExactTextDiff,
  pointAtNewScalarOffset,
  rangeForNewScalarOffsets,
} from './exact-text-diff.ts';

/** insertText/replaceText 가 emit 하는 이벤트 페이로드. range 는 op.range 의
 * 라이브 참조다 — 이후 op 들의 좌표 shift 가 그대로 반영된다. */
export interface AgentTextInsertedEvent {
  agent: AgentName;
  range: DocRange;
  text: string;
  /** 교체 원문. 있으면 공통 접두/접미는 건너뛰고 추가분으로만 캐럿을 움직인다. */
  oldText?: string;
}

/** 새 문자열 안에서의 공개 구간. start/end 는 Unicode 스칼라 오프셋. */
export interface RevealChunk {
  start: number;
  end: number;
  text: string;
}

/**
 * 캐럿이 이동할 구간. oldText 가 없으면 삽입 전체, 있으면 exact diff 의
 * 추가/교체 훙크만. 삭제만 있는 훙크는 새 글자가 없으므로 빠진다.
 */
export function revealChunksForInsertedText(text: string, oldText?: string): RevealChunk[] {
  if (oldText === undefined) {
    const end = scalarLen(text);
    return end === 0 ? [] : [{ start: 0, end, text }];
  }
  return computeExactTextDiff(oldText, text).hunks
    .filter((hunk) => hunk.newEnd > hunk.newStart)
    .map((hunk) => ({ start: hunk.newStart, end: hunk.newEnd, text: hunk.newText }));
}

/** 글자당 공개 시간(ms). 60~80cps 대역 — 사람 타자보다 빠르되 '타이핑'으로 읽힌다. */
const REVEAL_PER_CHAR_MS = 14;
/** 청크 하나의 공개 시간 범위. 큰 편집도 이 안에서 끝나 지연으로 읽히지 않는다. */
const REVEAL_MIN_MS = 160;
const REVEAL_MAX_MS = 900;
/** 커밋 직후 canvas repaint 가 자리잡을 여유. */
const REVEAL_START_DELAY_MS = 50;
/** 연속 op 사이의 숨 고르기. */
const REVEAL_GAP_MS = 70;
/** 이동이 끝난 뒤 에이전트 캐럿이 머무는 시간. */
const CARET_LINGER_MS = 260;
/** 대량 편집에서는 오래된 캐럿 이동을 완료하고 최근 항목만 애니메이션한다. */
const MAX_REVEAL_ITEMS = 8;
const MAX_REVEAL_AGE_MS = 2000;
/** 카메라 추적: 캐럿을 뷰포트의 이 밴드 안에 유지한다. */
const FOLLOW_BAND_TOP = 0.3;
const FOLLOW_BAND_BOTTOM = 0.72;
/** 카메라 지수 감쇠 시간 상수(ms) — 줌 스무딩과 같은 계열의 ease-out. */
const FOLLOW_TAU_MS = 150;

interface RevealItem {
  agent: AgentName;
  /** 라이브 참조 — pending-edits 의 shift 로직이 제자리 갱신한다. */
  range: DocRange;
  /** 교체/삽입 전체 문자열. hunkStart 와 함께 문서 좌표를 다시 계산한다. */
  text: string;
  textLen: number;
  /** 이 항목이 공개하는 구간이 전체 text 에서 시작하는 스칼라 오프셋. */
  hunkStart: number;
  enqueuedAt: number;
  revealStart: number | null;
  durationMs: number;
}

function scalarLen(s: string): number {
  return [...s].length;
}

function cellPathAt(cell: CellAddr, paraIdx: number): string {
  const path = cell.path ?? [];
  return JSON.stringify(path.map((entry, index) => index === path.length - 1
    ? { ...entry, cellParaIndex: paraIdx }
    : entry));
}

/**
 * 에이전트 텍스트의 타자기 공개(typewriter reveal).
 *
 * 편집은 이미 문서에 한 번에 커밋·레이아웃된 상태다(재레이아웃 없음). 이 컨트롤러는
 * 하나의 rAF 루프에서 에이전트 캐럿을 새 글자 위로 이동한다. 텍스트는 이미 문서에
 * 반영되어 있으므로 그대로 보여준다. 용지색 커버는 셀 배경·그림·수식을 지울 수 있어
 * 사용하지 않는다. 교체에서 원문과 같은 접두/접미는 건너뛴다.
 *
 * 좌표는 매 프레임 wasm 프로브로 다시 구한다 — 이동 중의 줌/스크롤/후속 편집 shift 에
 * 자동으로 따라간다. 프로브 실패(주소 드리프트)는 해당 공개를 즉시 완료 처리한다.
 */
export class AgentTypewriterReveal {
  private queue: RevealItem[] = [];
  private caretEl: HTMLDivElement;
  private caretAgent: AgentName | null = null;
  private rafId: number | null = null;
  private lastFrameTs: number | null = null;
  private enqueueGeneration = 0;
  private enqueueScheduled = false;
  private caretHideTimer: ReturnType<typeof setTimeout> | null = null;
  private followBroken = false;
  private scrollHost: HTMLElement | null = null;
  private reduceMotion: MediaQueryList | null = null;
  private unsubs: Array<() => void> = [];
  private deps: { canvasView: CanvasView; wasm: WasmBridge; eventBus: EventBus };

  constructor(deps: { canvasView: CanvasView; wasm: WasmBridge; eventBus: EventBus }) {
    this.deps = deps;
    this.caretEl = document.createElement('div');
    this.caretEl.className = 'ag-typewriter-caret';

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    }

    this.unsubs.push(deps.eventBus.on('agent-text-inserted', (payload) => {
      this.enqueue(payload as AgentTextInsertedEvent);
    }));
  }

  /** 사용자가 직접 스크롤하면 이번 이동 큐가 끝날 때까지 카메라 추적을 멈춘다. */
  private onUserScrollIntent = (): void => {
    if (this.queue.length > 0) this.followBroken = true;
  };

  private ensureAttached(): HTMLElement | null {
    const scrollContent = document.getElementById('scroll-content');
    if (!scrollContent) return null;
    if (this.caretEl.parentElement !== scrollContent) scrollContent.appendChild(this.caretEl);
    const host = document.getElementById('scroll-container');
    if (host && host !== this.scrollHost) {
      this.detachScrollHost();
      this.scrollHost = host;
      host.addEventListener('wheel', this.onUserScrollIntent, { passive: true });
      host.addEventListener('touchmove', this.onUserScrollIntent, { passive: true });
    }
    return scrollContent;
  }

  private detachScrollHost(): void {
    if (!this.scrollHost) return;
    this.scrollHost.removeEventListener('wheel', this.onUserScrollIntent);
    this.scrollHost.removeEventListener('touchmove', this.onUserScrollIntent);
    this.scrollHost = null;
  }

  private enqueue(e: AgentTextInsertedEvent): void {
    const chunks = revealChunksForInsertedText(e.text, e.oldText);
    if (chunks.length === 0) return;
    if (this.reduceMotion?.matches) {
      // 공개 애니메이션 없이 카메라만 한 번에 맞춘다.
      const first = chunks[0];
      this.jumpCameraTo(rangeForNewScalarOffsets(e.range, e.text, first.start, first.end));
      return;
    }
    const now = performance.now();
    for (const chunk of chunks) {
      const len = chunk.end - chunk.start;
      this.queue.push({
        agent: e.agent,
        range: e.range,
        text: e.text,
        textLen: len,
        hunkStart: chunk.start,
        enqueuedAt: now,
        revealStart: null,
        durationMs: Math.max(REVEAL_MIN_MS, Math.min(REVEAL_MAX_MS, len * REVEAL_PER_CHAR_MS)),
      });
    }
    if (this.queue.length > MAX_REVEAL_ITEMS) {
      this.queue.splice(0, this.queue.length - MAX_REVEAL_ITEMS);
    }
    // 배치의 최종 조판 이후, 브라우저 paint 이전에 캐럿을 배치한다.
    if (this.enqueueScheduled) return;
    this.enqueueScheduled = true;
    const generation = this.enqueueGeneration;
    queueMicrotask(() => {
      if (generation !== this.enqueueGeneration) return;
      this.enqueueScheduled = false;
      this.renderFrame(performance.now(), 0);
      if (this.queue.length > 0 && this.rafId === null) {
        this.lastFrameTs = null;
        this.rafId = requestAnimationFrame(this.onFrame);
      }
    });
  }

  /** 모든 캐럿 이동을 즉시 완료한다 (approve/reject/무효화/문서 교체). */
  finishAll(): void {
    this.enqueueGeneration++;
    this.enqueueScheduled = false;
    this.queue = [];
    this.hideCaretSoon(0);
    this.stopLoop();
    this.followBroken = false;
  }

  dispose(): void {
    for (const un of this.unsubs) un();
    this.unsubs = [];
    this.finishAll();
    if (this.caretHideTimer !== null) clearTimeout(this.caretHideTimer);
    this.detachScrollHost();
    this.caretEl.remove();
  }

  // ─── 프레임 루프 ────────────────────────────────────────

  private onFrame = (ts: number): void => {
    this.rafId = null;
    const dt = this.lastFrameTs === null ? 16 : Math.max(1, Math.min(ts - this.lastFrameTs, 50));
    this.lastFrameTs = ts;
    this.renderFrame(ts, dt);
    if (this.queue.length > 0) {
      this.rafId = requestAnimationFrame(this.onFrame);
    } else {
      this.lastFrameTs = null;
      this.hideCaretSoon(CARET_LINGER_MS);
      this.followBroken = false;
    }
  };

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastFrameTs = null;
  }

  private renderFrame(now: number, dt: number): void {
    const scrollContent = this.ensureAttached();
    if (!scrollContent) {
      this.queue = [];
      return;
    }

    // 백그라운드 탭 복귀 시 오래된 캐럿 이동을 다시 재생하지 않는다.
    while (this.queue.length > 0 && now - this.queue[0].enqueuedAt >= MAX_REVEAL_AGE_MS) {
      this.queue.shift();
    }
    // 현재 항목의 진행도를 계산하고, 완료된 항목은 큐에서 내린다.
    let current = this.queue[0];
    while (current) {
      if (current.revealStart === null) {
        const prevDone = current.enqueuedAt + REVEAL_START_DELAY_MS;
        current.revealStart = Math.max(now, prevDone);
      }
      const progress = (now - current.revealStart) / current.durationMs;
      if (progress >= 1) {
        this.queue.shift();
        const next = this.queue[0];
        if (next && next.revealStart === null) {
          next.revealStart = Math.max(now + REVEAL_GAP_MS, next.enqueuedAt + REVEAL_START_DELAY_MS);
        }
        current = this.queue[0];
        continue;
      }
      break;
    }

    if (!current) {
      return;
    }

    const zoom = this.deps.canvasView.getViewportManager().getZoom();
    const contentWidth = scrollContent.clientWidth;
    const progress = Math.max(0, (now - (current.revealStart ?? now)) / current.durationMs);
    const revealedChars = Math.min(current.textLen, Math.floor(current.textLen * progress));

    let caretPos: { left: number; top: number; height: number } | null = null;

    try {
      caretPos = this.caretPosition(current, revealedChars, contentWidth, zoom);
    } catch {
      // 주소 드리프트(사용자 편집/승인 경합) — 이 항목은 즉시 공개 완료 처리한다.
      this.queue.shift();
      return;
    }

    if (caretPos) {
      this.showCaret(current.agent, caretPos);
      if (!this.followBroken) this.followCamera(caretPos, dt);
    }
  }

  /** 현재 글자 위치의 캐럿 화면 좌표. 주소가 무효면 throw 해 항목을 완료 처리한다. */
  private caretPosition(
    item: RevealItem,
    revealedChars: number,
    contentWidth: number,
    zoom: number,
  ): { left: number; top: number; height: number } | null {
    const caretRect = this.probeCaret(item, revealedChars);
    const caretPos = this.pagePosition(caretRect, contentWidth, zoom);
    return caretPos
      ? { left: caretPos.left, top: caretPos.top, height: Math.max(caretPos.height, 12) }
      : null;
  }

  private showCaret(agent: AgentName, pos: { left: number; top: number; height: number }): void {
    if (this.caretHideTimer !== null) {
      clearTimeout(this.caretHideTimer);
      this.caretHideTimer = null;
    }
    if (this.caretAgent !== agent) {
      this.caretAgent = agent;
      this.caretEl.className = `ag-typewriter-caret ag-${agent}`;
    }
    this.caretEl.style.transform = `translate3d(${pos.left.toFixed(2)}px, ${pos.top.toFixed(2)}px, 0)`;
    this.caretEl.style.height = `${pos.height.toFixed(2)}px`;
    this.caretEl.classList.add('is-writing');
  }

  private hideCaretSoon(delayMs: number): void {
    if (this.caretHideTimer !== null) clearTimeout(this.caretHideTimer);
    this.caretHideTimer = setTimeout(() => {
      this.caretHideTimer = null;
      this.caretEl.classList.remove('is-writing');
    }, delayMs);
  }

  // ─── 카메라 ─────────────────────────────────────────────

  /** 캐럿이 뷰포트 밴드를 벗어나면 지수 감쇠로 스크롤을 따라 붙인다. */
  private followCamera(caret: { top: number; height: number }, dt: number): void {
    const vm = this.deps.canvasView.getViewportManager();
    const { height: viewHeight } = vm.getViewportSize();
    if (viewHeight <= 0) return;
    const scrollY = vm.getScrollY();
    const caretTop = caret.top - scrollY;
    const caretBottom = caretTop + caret.height;
    const bandTop = viewHeight * FOLLOW_BAND_TOP;
    const bandBottom = viewHeight * FOLLOW_BAND_BOTTOM;

    let target: number | null = null;
    if (caretBottom > bandBottom) target = scrollY + (caretBottom - bandBottom);
    else if (caretTop < bandTop) target = scrollY - (bandTop - caretTop);
    if (target === null) return;

    const blend = 1 - Math.exp(-dt / FOLLOW_TAU_MS);
    const next = scrollY + (target - scrollY) * blend;
    if (Math.abs(next - scrollY) < 0.5) return;
    vm.setScrollTop(next);
  }

  /** prefers-reduced-motion: 애니메이션 없이 삽입 지점으로 한 번에 이동. */
  private jumpCameraTo(range: DocRange): void {
    try {
      const scrollContent = document.getElementById('scroll-content');
      if (!scrollContent) return;
      const vm = this.deps.canvasView.getViewportManager();
      const zoom = vm.getZoom();
      const rect = this.probeCaret({ range, text: '', textLen: 0, hunkStart: 0 } as RevealItem, 0);
      const pos = this.pagePosition(rect, scrollContent.clientWidth, zoom);
      if (!pos) return;
      const { height: viewHeight } = vm.getViewportSize();
      const scrollY = vm.getScrollY();
      if (pos.top < scrollY || pos.top + pos.height > scrollY + viewHeight) {
        vm.setScrollTop(Math.max(0, pos.top - viewHeight * 0.4));
      }
    } catch { /* 주소 드리프트 — 이동 생략 */ }
  }

  // ─── wasm 프로브 / 좌표 ─────────────────────────────────

  private probeCaret(item: RevealItem, scalarOffset: number): SelectionRect {
    const r = item.range;
    // range 는 라이브 참조라 시작 좌표가 항상 현재 문서 기준이다. 공개 구간은
    // 전체 삽입 문자열의 hunkStart 부터이므로 그 오프셋으로 문서 좌표를 계산한다.
    const point = pointAtNewScalarOffset(
      r, item.text, item.hunkStart + Math.max(0, Math.min(scalarOffset, item.textLen)),
    );
    const cell = r.cell;
    const rect = cell?.path
      ? this.deps.wasm.getCursorRectByPath(
        r.sectionIdx, cell.paraIdx, cellPathAt(cell, point.paraIdx), point.charOffset,
      )
      : cell
      ? this.deps.wasm.getCursorRectInCell(
        r.sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, point.paraIdx, point.charOffset,
      )
      : this.deps.wasm.getCursorRect(r.sectionIdx, point.paraIdx, point.charOffset);
    return { pageIndex: rect.pageIndex, x: rect.x, y: rect.y, width: 0, height: rect.height };
  }

  /** 가상 스크롤이 아직 모르는 페이지(변이 직후 새로 생긴 페이지)는 null. */
  private pagePosition(
    rect: SelectionRect,
    contentWidth: number,
    zoom: number,
  ): { left: number; top: number; width: number; height: number } | null {
    const vs = this.deps.canvasView.getVirtualScroll();
    if (rect.pageIndex >= vs.pageCount) return null;
    const pl = vs.getPageLeft(rect.pageIndex);
    const pageLeft = pl >= 0 ? pl : (contentWidth - vs.getPageWidth(rect.pageIndex)) / 2;
    return {
      left: pageLeft + rect.x * zoom,
      top: vs.getPageOffset(rect.pageIndex) + rect.y * zoom,
      width: rect.width * zoom,
      height: rect.height * zoom,
    };
  }
}

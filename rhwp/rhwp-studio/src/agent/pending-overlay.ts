import './pending-overlay.css';
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { DocumentPosition, SelectionRect } from '../core/types.ts';
import type { AgentName, CellAddr, DocRange } from './types.ts';
import {
  computeExactTextDiff,
  pointAtNewScalarOffset,
  rangeForNewScalarOffsets,
  type ExactDiffHunk,
  type ExactDiffResult,
} from './exact-text-diff.ts';
import { measureInkRange } from './selection-ink.ts';

/** 객체 op 의 overlay 좌표 해석 참조 — 렌더 시점에 wasm 프로브로 rect 를 구한다 */
export type ObjectOverlayRef =
  | { sort: 'table'; sectionIdx: number; paraIdx: number; controlIdx: number }
  | {
      sort: 'cells'; sectionIdx: number; paraIdx: number; controlIdx: number;
      rowIdx?: number; colIdx?: number; cellIdx?: number;
      rect?: { startRow: number; startCol: number; endRow: number; endCol: number };
    }
  | { sort: 'control'; sectionIdx: number; paraIdx: number; controlIdx: number }
  | { sort: 'para'; sectionIdx: number; paraIdx: number; cell?: CellAddr };

interface LegacyOverlayOp {
  kind: 'insert' | 'delete' | 'format';
  agent: AgentName;
  range?: DocRange;
  objRef?: ObjectOverlayRef;
}

interface ReplaceOverlayOp {
  kind: 'replace';
  id: string;
  agent: AgentName;
  range: DocRange;
  oldText: string;
  newText: string;
}

export type OverlayOp = LegacyOverlayOp | ReplaceOverlayOp;

interface CachedDiff {
  oldText: string;
  newText: string;
  result: ExactDiffResult;
}

interface ExactVisual {
  key: string;
  nodeKey: string;
  op: ReplaceOverlayOp;
  hunk: ExactDiffHunk;
  range: DocRange;
  rect: SelectionRect;
  anchor: boolean;
}

interface HitRegion {
  key: string;
  oldText: string;
  range: DocRange;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 문단이 끝나 줄이 바뀌는 지점 — 텍스트 끝에 붙는 개행 표시. */
interface EnterMark {
  pageIndex: number;
  x: number;
  y: number;
  height: number;
  /** 잉크 색 소유자. exact diff 는 provenance 와 분리된 의미 색(초록)을 쓴다. */
  tone: AgentName | 'exact';
}

/** 한 범위의 화면 기하 — 텍스트 끝까지 잘린 rect 와 개행 표시. */
interface MeasuredRange {
  rects: SelectionRect[];
  enters: EnterMark[];
}

/** key 하나가 소유하는 DOM 쌍. 렌더 간에 재사용해 애니메이션/스타일 상태를 보존한다. */
interface PooledNode {
  ink: HTMLDivElement | null;
  marker: HTMLDivElement | null;
  inkClass: string;
  markerClass: string;
}

const HIT_SLOP_PX = 4;
const POPOVER_MAX_SCALARS = 320;
const EXACT_INK_GUTTER = 0.35;
/** 텍스트 끝과 개행 표시 사이의 간격(줄 높이 배수). */
const ENTER_GAP_FACTOR = 0.18;
/** 개행 표시의 크기(줄 높이 배수). */
const ENTER_SIZE_FACTOR = 0.62;

function comparePoint(
  a: { paraIdx: number; charOffset: number },
  b: { paraIdx: number; charOffset: number },
): number {
  return a.paraIdx - b.paraIdx || a.charOffset - b.charOffset;
}

function truncateScalars(text: string, max: number): string {
  const values = [...text];
  return values.length > max ? values.slice(0, max - 1).join('') + '…' : text;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 개행 표시 — 12 그리드, currentColor, 1.25 스트로크, 둥근 캡 (프로젝트 아이콘 규약).
 * 오른쪽 위에서 내려와 왼쪽으로 꺾이는 갈고리 + 화살촉.
 */
function createEnterGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M10 2.5V6a1.5 1.5 0 0 1-1.5 1.5H3M5 5 2.5 7.5 5 10');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.25');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function rangeKey(range: DocRange | undefined): string {
  if (!range) return '';
  const cell = range.cell ? `c${range.cell.paraIdx}/${range.cell.controlIdx}/${range.cell.cellIdx}` : '';
  return `s${range.sectionIdx}${cell}:${range.startParaIdx}.${range.startCharOffset}-${range.endParaIdx}.${range.endCharOffset}`;
}

/**
 * 에이전트 대기 편집(pending edit)을 표시하는 오버레이.
 * replace 는 view-only exact diff 로 쪼개고, 나머지 op 는 기존 범위 렌더링을 유지한다.
 *
 * 렌더는 두 단계로 나뉜다:
 *  - 기하 재계산(wasm rect 프로브): 문서가 실제로 바뀐 이벤트에서만 수행한다.
 *  - 배치(positioning): 줌/뷰포트/인셋 변경은 캐시된 페이지 좌표를 화면 좌표로만
 *    다시 사영한다 — 사이드바 전환 중에도 프레임마다 값싸게 따라붙는다.
 * DOM 은 key 로 재조정(reconcile)한다. 매 렌더마다 부수고 다시 만들지 않으므로
 * 진행 중인 CSS 애니메이션이 끊기지 않고, 노드 생성 비용도 최초 1회뿐이다.
 */
export class PendingOverlayRenderer {
  private markerLayer: HTMLDivElement;
  private popover: HTMLDivElement;
  private popoverText: HTMLDivElement;
  private liveRegion: HTMLDivElement;
  private ops: OverlayOp[] = [];
  private unsubs: Array<() => void> = [];
  private diffCache = new Map<string, CachedDiff>();
  private nodePool = new Map<string, PooledNode>();
  private cachedExact: ExactVisual[] | null = null;
  private cachedLegacy: Array<{ op: LegacyOverlayOp; rects: SelectionRect[] }> | null = null;
  private cachedEnters: EnterMark[] = [];
  private geometryDirty = true;
  private hitRegions: HitRegion[] = [];
  private interactionRoot: HTMLElement | null = null;
  private hoverKey: string | null = null;
  private pinnedKey: string | null = null;
  // 파라미터 프로퍼티 대신 명시적 할당 (node --test strip-only 모드 호환).
  private deps: { canvasView: CanvasView; wasm: WasmBridge; eventBus: EventBus };

  constructor(deps: { canvasView: CanvasView; wasm: WasmBridge; eventBus: EventBus }) {
    this.deps = deps;
    this.markerLayer = document.createElement('div');
    this.markerLayer.className = 'ag-pending-layer ag-pending-marker-layer';

    this.popover = document.createElement('div');
    this.popover.className = 'ag-exact-popover';
    this.popover.hidden = true;
    this.popover.setAttribute('role', 'tooltip');
    const label = document.createElement('div');
    label.className = 'ag-exact-popover-label';
    label.textContent = '삭제된 내용';
    this.popoverText = document.createElement('div');
    this.popoverText.className = 'ag-exact-popover-text';
    this.popover.append(label, this.popoverText);

    this.liveRegion = document.createElement('div');
    this.liveRegion.className = 'ag-pending-live-region';
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-atomic', 'true');
    this.markerLayer.append(this.popover, this.liveRegion);

    // 문서 내용이 바뀌는 이벤트 — rect 프로브부터 다시 한다.
    const geometryEvents = ['document-changed', 'document-page-invalidated', 'document-view-changed'];
    for (const name of geometryEvents) {
      this.unsubs.push(deps.eventBus.on(name, () => {
        this.geometryDirty = true;
        this.render();
      }));
    }
    // 화면 사영만 바뀌는 이벤트 — 캐시된 기하를 다시 배치만 한다.
    const projectionEvents = ['zoom-changed', 'viewport-resize', 'viewport-inset-changed'];
    for (const name of projectionEvents) {
      this.unsubs.push(deps.eventBus.on(name, () => this.render()));
    }
    this.unsubs.push(deps.eventBus.on('cursor-rect-updated', () => this.inspectCaret()));
    document.addEventListener('keydown', this.onKeyDown, true);
  }

  setOps(ops: OverlayOp[]): void {
    this.ops = ops;
    const liveReplaceIds = new Set(
      ops.filter((op): op is ReplaceOverlayOp => op.kind === 'replace').map((op) => op.id),
    );
    for (const id of this.diffCache.keys()) {
      if (!liveReplaceIds.has(id)) this.diffCache.delete(id);
    }
    if (this.pinnedKey && ![...liveReplaceIds].some((id) => this.pinnedKey!.startsWith(`${id}:`))) {
      this.pinnedKey = null;
    }
    this.geometryDirty = true;
    this.render();
  }

  clear(): void {
    this.ops = [];
    this.diffCache.clear();
    this.hoverKey = null;
    this.pinnedKey = null;
    this.geometryDirty = true;
    this.render();
  }

  dispose(): void {
    for (const un of this.unsubs) un();
    this.unsubs = [];
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.detachInteractionRoot();
    this.ops = [];
    this.diffCache.clear();
    this.cachedExact = null;
    this.cachedLegacy = null;
    this.hitRegions = [];
    this.dropAllNodes();
    this.markerLayer.remove();
  }

  /** loadDocument 가 #scroll-content 를 비우므로 매 렌더마다 재부착한다 */
  private ensureAttached(scrollContent: HTMLElement): void {
    if (this.markerLayer.parentElement !== scrollContent) {
      scrollContent.appendChild(this.markerLayer);
    }
    if (this.interactionRoot !== scrollContent) {
      this.detachInteractionRoot();
      this.interactionRoot = scrollContent;
      scrollContent.addEventListener('pointermove', this.onPointerMove, { passive: true });
      scrollContent.addEventListener('pointerleave', this.onPointerLeave, { passive: true });
    }
  }

  private detachInteractionRoot(): void {
    if (!this.interactionRoot) return;
    this.interactionRoot.removeEventListener('pointermove', this.onPointerMove);
    this.interactionRoot.removeEventListener('pointerleave', this.onPointerLeave);
    this.interactionRoot = null;
  }

  private dropAllNodes(): void {
    for (const node of this.nodePool.values()) {
      node.ink?.remove();
      node.marker?.remove();
    }
    this.nodePool.clear();
  }

  private pagePosition(
    rect: SelectionRect,
    contentWidth: number,
    zoom: number,
  ): { left: number; top: number; width: number; height: number } {
    const vs = this.deps.canvasView.getVirtualScroll();
    const pl = vs.getPageLeft(rect.pageIndex);
    const pageLeft = pl >= 0 ? pl : (contentWidth - vs.getPageWidth(rect.pageIndex)) / 2;
    return {
      left: pageLeft + rect.x * zoom,
      top: vs.getPageOffset(rect.pageIndex) + rect.y * zoom,
      width: rect.width * zoom,
      height: rect.height * zoom,
    };
  }

  private positionRect(div: HTMLDivElement, pos: { left: number; top: number; width: number; height: number }): void {
    div.style.left = `${pos.left.toFixed(2)}px`;
    div.style.top = `${pos.top.toFixed(2)}px`;
    div.style.width = `${pos.width.toFixed(2)}px`;
    div.style.height = `${pos.height.toFixed(2)}px`;
  }

  private diffFor(op: ReplaceOverlayOp): ExactDiffResult {
    const cached = this.diffCache.get(op.id);
    if (cached && cached.oldText === op.oldText && cached.newText === op.newText) return cached.result;
    const result = computeExactTextDiff(op.oldText, op.newText);
    this.diffCache.set(op.id, { oldText: op.oldText, newText: op.newText, result });
    return result;
  }

  private rangeRects(range: DocRange): SelectionRect[] {
    const cell = range.cell;
    return cell
      ? this.deps.wasm.getSelectionRectsInCell(
        range.sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx,
        range.startParaIdx, range.startCharOffset,
        range.endParaIdx, range.endCharOffset,
      )
      : this.deps.wasm.getSelectionRects(
        range.sectionIdx,
        range.startParaIdx, range.startCharOffset,
        range.endParaIdx, range.endCharOffset,
      );
  }

  private paragraphLength(range: DocRange, paraIdx: number): number {
    const cell = range.cell;
    return cell
      ? this.deps.wasm.getCellParagraphLength(
        range.sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx,
      )
      : this.deps.wasm.getParagraphLength(range.sectionIdx, paraIdx);
  }

  private caretRectAt(range: DocRange, paraIdx: number, charOffset: number): SelectionRect {
    const cell = range.cell;
    const rect = cell
      ? this.deps.wasm.getCursorRectInCell(
        range.sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx, charOffset,
      )
      : this.deps.wasm.getCursorRect(range.sectionIdx, paraIdx, charOffset);
    return { pageIndex: rect.pageIndex, x: rect.x, y: rect.y, width: 0, height: rect.height };
  }

  /**
   * 범위의 rect 를 실제 텍스트 끝까지로 자르고, 문단이 끝나는 자리에 개행 표시를 만든다.
   *
   * 엔진의 selection rect 는 강제 줄바꿈·문단 부호를 여백까지 밀어 반환한다.
   * 그대로 밑줄을 그으면 글자가 없는 곳까지 큰 공백이 튀어 나온다. 줄 끝 캐럿
   * x 로 잘라 내고, 문단이 바뀌는 자리에 개행 표시를 놓는다.
   */
  private measureRange(range: DocRange, tone: AgentName | 'exact'): MeasuredRange {
    const measured = measureInkRange(range, {
      rects: () => this.rangeRects(range),
      paragraphLength: (paraIdx) => this.paragraphLength(range, paraIdx),
      text: (paraIdx, start, count) => this.rangeText(range, paraIdx, start, count),
      caret: (paraIdx, offset) => this.caretRectAt(range, paraIdx, offset),
    });
    const enters: EnterMark[] = measured.paraEnds.map((end) => ({
      pageIndex: end.rect.pageIndex,
      x: end.rect.x,
      y: end.rect.y,
      height: end.rect.height,
      tone,
    }));
    return { rects: measured.rects, enters };
  }

  private rangeText(range: DocRange, paraIdx: number, start: number, count: number): string {
    if (count <= 0) return '';
    const cell = range.cell;
    return cell
      ? this.deps.wasm.getTextInCell(
        range.sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx,
        paraIdx, start, count,
      )
      : this.deps.wasm.getTextRange(range.sectionIdx, paraIdx, start, count);
  }

  private cursorRect(op: ReplaceOverlayOp, scalarOffset: number): SelectionRect {
    const point = pointAtNewScalarOffset(op.range, op.newText, scalarOffset);
    const cell = op.range.cell;
    const rect = cell
      ? this.deps.wasm.getCursorRectInCell(
        op.range.sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx,
        point.paraIdx, point.charOffset,
      )
      : this.deps.wasm.getCursorRect(op.range.sectionIdx, point.paraIdx, point.charOffset);
    return { pageIndex: rect.pageIndex, x: rect.x, y: rect.y, width: 0, height: rect.height };
  }

  private collectExactVisuals(op: ReplaceOverlayOp, enters: EnterMark[]): ExactVisual[] {
    const visuals: ExactVisual[] = [];
    const result = this.diffFor(op);
    result.hunks.forEach((hunk, index) => {
      const key = `${op.id}:${index}`;
      const range = rangeForNewScalarOffsets(op.range, op.newText, hunk.newStart, hunk.newEnd);
      try {
        if (hunk.newEnd > hunk.newStart) {
          const measured = this.measureRange(range, 'exact');
          enters.push(...measured.enters);
          for (const rect of measured.rects) {
            visuals.push({ key, nodeKey: '', op, hunk, range, rect, anchor: false });
          }
        } else {
          visuals.push({ key, nodeKey: '', op, hunk, range, rect: this.cursorRect(op, hunk.newStart), anchor: true });
        }
      } catch {
        // 문서 미로드 / stale 주소 → 해당 hunk 는 조용히 건너뛴다.
      }
    });
    return visuals;
  }

  /** Overlapping screen-blend inks mix colors, so reserve exact text pixels for green. */
  private excludeExactTextRects(
    sourceRects: readonly SelectionRect[],
    exactRects: readonly SelectionRect[],
  ): SelectionRect[] {
    let pieces = [...sourceRects];
    for (const exact of exactRects) {
      if (exact.width <= 0 || exact.height <= 0) continue;
      const cutLeft = exact.x - EXACT_INK_GUTTER;
      const cutRight = exact.x + exact.width + EXACT_INK_GUTTER;
      pieces = pieces.flatMap((piece) => {
        if (piece.pageIndex !== exact.pageIndex || piece.width <= 0 || piece.height <= 0) return [piece];
        const overlapY = Math.min(piece.y + piece.height, exact.y + exact.height) - Math.max(piece.y, exact.y);
        if (overlapY <= Math.min(piece.height, exact.height) * 0.5) return [piece];
        const pieceRight = piece.x + piece.width;
        if (cutRight <= piece.x || cutLeft >= pieceRight) return [piece];
        const result: SelectionRect[] = [];
        if (cutLeft > piece.x) {
          result.push({ ...piece, width: Math.max(0, cutLeft - piece.x) });
        }
        if (cutRight < pieceRight) {
          result.push({ ...piece, x: cutRight, width: Math.max(0, pieceRight - cutRight) });
        }
        return result.filter((candidate) => candidate.width > 0.05);
      });
    }
    return pieces;
  }

  /** 문서 기준 기하(페이지 좌표 rect 목록)를 다시 프로브한다. */
  private recomputeGeometry(): void {
    const exactVisuals: ExactVisual[] = [];
    const legacyOps: LegacyOverlayOp[] = [];
    const enters: EnterMark[] = [];
    for (const op of this.ops) {
      if (op.kind === 'replace') exactVisuals.push(...this.collectExactVisuals(op, enters));
      else legacyOps.push(op);
    }
    const exactTextRects = exactVisuals.filter((visual) => !visual.anchor).map((visual) => visual.rect);

    const legacy: Array<{ op: LegacyOverlayOp; rects: SelectionRect[] }> = [];
    for (const op of legacyOps) {
      let rects: SelectionRect[];
      try {
        if (op.objRef) {
          rects = this.resolveObjectRects(op.objRef);
        } else if (op.range) {
          const measured = this.measureRange(op.range, op.agent);
          rects = measured.rects;
          // 삭제 마크는 원문을 그대로 두므로 개행 표시를 붙이지 않는다.
          if (op.kind !== 'delete') enters.push(...measured.enters);
        } else continue;
      } catch {
        continue;
      }
      if (op.range && exactTextRects.length > 0) {
        rects = this.excludeExactTextRects(rects, exactTextRects);
      }
      legacy.push({ op, rects });
    }

    // 같은 hunk 가 여러 줄 rect 를 갖는다 — DOM key 는 등장 순번으로 안정화한다.
    const seen = new Map<string, number>();
    for (const visual of exactVisuals) {
      const n = seen.get(visual.key) ?? 0;
      seen.set(visual.key, n + 1);
      visual.nodeKey = `${visual.key}#${n}`;
    }

    this.cachedExact = exactVisuals;
    this.cachedLegacy = legacy;
    this.cachedEnters = enters;
    this.geometryDirty = false;
  }

  private legacyNodeKey(op: LegacyOverlayOp, rectIdx: number): string {
    const at = op.objRef ? JSON.stringify(op.objRef) : rangeKey(op.range);
    return `L:${op.kind}:${op.agent}:${at}#${rectIdx}`;
  }

  /**
   * key 의 DOM 쌍을 확보한다. 이미 있으면 그대로 재사용해 진행 중인 애니메이션과
   * 스타일 상태를 보존하고, 클래스가 달라졌을 때만 갱신한다.
   */
  private ensureNode(
    key: string,
    scrollContent: HTMLElement,
    inkClass: string | null,
    markerClass: string | null,
    onCreateMarker?: (marker: HTMLDivElement) => void,
  ): PooledNode {
    let node = this.nodePool.get(key);
    if (!node) {
      node = { ink: null, marker: null, inkClass: '', markerClass: '' };
      this.nodePool.set(key, node);
    }
    if (inkClass) {
      if (!node.ink) {
        node.ink = document.createElement('div');
        node.ink.dataset.agKey = key;
      }
      if (node.inkClass !== inkClass) {
        node.ink.className = inkClass;
        node.inkClass = inkClass;
      }
      if (node.ink.parentElement !== scrollContent) scrollContent.appendChild(node.ink);
    } else if (node.ink) {
      node.ink.remove();
      node.ink = null;
      node.inkClass = '';
    }
    if (markerClass) {
      const created = !node.marker;
      if (!node.marker) {
        node.marker = document.createElement('div');
        node.marker.dataset.agKey = key;
      }
      if (node.markerClass !== markerClass) {
        node.marker.className = markerClass;
        node.markerClass = markerClass;
      }
      if (node.marker.parentElement !== this.markerLayer) this.markerLayer.appendChild(node.marker);
      if (created && onCreateMarker) onCreateMarker(node.marker);
    } else if (node.marker) {
      node.marker.remove();
      node.marker = null;
      node.markerClass = '';
    }
    return node;
  }

  private render(): void {
    const scrollContent = document.getElementById('scroll-content');
    if (!scrollContent) return;
    this.ensureAttached(scrollContent);

    if (this.geometryDirty || !this.cachedExact || !this.cachedLegacy) {
      this.recomputeGeometry();
    }

    const zoom = this.deps.canvasView.getViewportManager().getZoom();
    const contentWidth = scrollContent.clientWidth;
    this.hitRegions = [];
    const desired = new Set<string>();

    for (const { op, rects } of this.cachedLegacy!) {
      rects.forEach((rect, rectIdx) => {
        const key = this.legacyNodeKey(op, rectIdx);
        desired.add(key);
        const pos = this.pagePosition(rect, contentWidth, zoom);
        const node = this.ensureNode(
          key,
          scrollContent,
          `ag-pending-rect ag-pending-ink ag-${op.agent}`,
          `ag-pending-rect ag-pending-marker ag-${op.agent} ag-${op.kind}`,
        );
        if (node.ink) this.positionRect(node.ink, pos);
        if (node.marker) this.positionRect(node.marker, pos);
      });
    }

    for (const visual of this.cachedExact!) {
      desired.add(visual.nodeKey);
      const pos = this.pagePosition(visual.rect, contentWidth, zoom);
      if (visual.anchor) {
        const isDeletion = visual.hunk.kind === 'delete';
        const node = this.ensureNode(
          visual.nodeKey,
          scrollContent,
          null,
          `ag-exact-anchor ${isDeletion ? 'ag-exact-anchor-delete' : 'ag-exact-anchor-insert'}`,
          (marker) => {
            // 생성 시 1회만 재생 — 노드가 렌더 간에 살아남으므로 중복 재생이 없다.
            marker.classList.add('ag-liquid-anchor-in');
            marker.addEventListener('animationend', () => marker.classList.remove('ag-liquid-anchor-in'), { once: true });
          },
        );
        const markerPos = { left: pos.left - 5, top: pos.top, width: 10, height: Math.max(pos.height, 12) };
        if (node.marker) {
          this.positionRect(node.marker, markerPos);
          node.marker.dataset.diffHunk = visual.key;
        }
        if (visual.hunk.oldText) {
          this.hitRegions.push({ ...markerPos, key: visual.key, oldText: visual.hunk.oldText, range: visual.range });
        }
        continue;
      }

      const node = this.ensureNode(
        visual.nodeKey,
        scrollContent,
        'ag-pending-rect ag-pending-ink ag-exact-ink',
        'ag-pending-rect ag-pending-marker ag-exact-change',
      );
      if (node.ink) {
        this.positionRect(node.ink, pos);
        node.ink.dataset.diffHunk = visual.key;
      }
      if (node.marker) {
        this.positionRect(node.marker, pos);
        node.marker.dataset.diffHunk = visual.key;
      }
      if (visual.hunk.oldText) {
        this.hitRegions.push({ ...pos, key: visual.key, oldText: visual.hunk.oldText, range: visual.range });
      }
    }

    this.cachedEnters.forEach((mark, index) => {
      const key = `E:${mark.pageIndex}:${index}`;
      desired.add(key);
      const pos = this.pagePosition(
        { pageIndex: mark.pageIndex, x: mark.x, y: mark.y, width: 0, height: mark.height },
        contentWidth,
        zoom,
      );
      const size = pos.height * ENTER_SIZE_FACTOR;
      const node = this.ensureNode(
        key, scrollContent, null,
        `ag-pending-enter ${mark.tone === 'exact' ? 'ag-enter-exact' : `ag-${mark.tone}`}`,
        (marker) => marker.appendChild(createEnterGlyph()),
      );
      if (node.marker) {
        this.positionRect(node.marker, {
          left: pos.left + pos.height * ENTER_GAP_FACTOR,
          top: pos.top + (pos.height - size) / 2,
          width: size,
          height: size,
        });
      }
    });

    // 더 이상 쓰이지 않는 노드 정리
    for (const [key, node] of this.nodePool) {
      if (desired.has(key)) continue;
      node.ink?.remove();
      node.marker?.remove();
      this.nodePool.delete(key);
    }

    this.restorePopoverAfterRender();
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.interactionRoot || this.pinnedKey) return;
    const bounds = this.interactionRoot.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const hit = this.hitRegions.find((region) => (
      x >= region.left - HIT_SLOP_PX
      && x <= region.left + region.width + HIT_SLOP_PX
      && y >= region.top - HIT_SLOP_PX
      && y <= region.top + region.height + HIT_SLOP_PX
    ));
    this.hoverKey = hit?.key ?? null;
    if (hit) this.showPopover(hit, false);
    else this.hidePopover();
  };

  private onPointerLeave = (): void => {
    this.hoverKey = null;
    if (!this.pinnedKey) this.hidePopover();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || (!this.pinnedKey && !this.hoverKey)) return;
    this.pinnedKey = null;
    this.hoverKey = null;
    this.hidePopover();
  };

  private caretInRange(position: DocumentPosition, range: DocRange): boolean {
    if (position.sectionIndex !== range.sectionIdx) return false;
    let paraIdx = position.paragraphIndex;
    if (range.cell) {
      if (position.parentParaIndex !== range.cell.paraIdx
        || position.controlIndex !== range.cell.controlIdx
        || position.cellIndex !== range.cell.cellIdx) return false;
      paraIdx = position.cellParaIndex ?? position.paragraphIndex;
    } else if (position.parentParaIndex !== undefined) {
      return false;
    }
    const point = { paraIdx, charOffset: position.charOffset };
    const start = { paraIdx: range.startParaIdx, charOffset: range.startCharOffset };
    const end = { paraIdx: range.endParaIdx, charOffset: range.endCharOffset };
    return comparePoint(point, start) >= 0 && comparePoint(point, end) <= 0;
  }

  private inspectCaret(): void {
    const position = this.deps.wasm.getCaretPosition();
    const hit = position ? this.hitRegions.find((region) => this.caretInRange(position, region.range)) : undefined;
    this.pinnedKey = hit?.key ?? null;
    if (hit) this.showPopover(hit, true);
    else if (this.hoverKey) {
      const hover = this.hitRegions.find((region) => region.key === this.hoverKey);
      if (hover) this.showPopover(hover, false);
      else this.hidePopover();
    } else {
      this.hidePopover();
    }
  }

  private showPopover(region: HitRegion, announce: boolean): void {
    const maxLeft = Math.max(8, (this.interactionRoot?.clientWidth ?? 320) - 292);
    this.popover.style.left = `${Math.max(8, Math.min(region.left, maxLeft)).toFixed(2)}px`;
    this.popover.style.top = `${(region.top + region.height + 7).toFixed(2)}px`;
    const text = truncateScalars(region.oldText, POPOVER_MAX_SCALARS);
    this.popoverText.textContent = text;
    this.popover.hidden = false;
    if (announce && this.liveRegion.textContent !== `삭제된 내용: ${text}`) {
      this.liveRegion.textContent = `삭제된 내용: ${text}`;
    }
  }

  private hidePopover(): void {
    this.popover.hidden = true;
  }

  private restorePopoverAfterRender(): void {
    const key = this.pinnedKey ?? this.hoverKey;
    if (!key) {
      this.hidePopover();
      return;
    }
    const region = this.hitRegions.find((candidate) => candidate.key === key);
    if (region) this.showPopover(region, false);
    else {
      this.pinnedKey = null;
      this.hoverKey = null;
      this.hidePopover();
    }
  }

  /** 객체 참조 → 페이지 rect 목록. 실패 시 throw (호출부가 op 을 건너뛴다). */
  private resolveObjectRects(ref: ObjectOverlayRef): SelectionRect[] {
    const wasm = this.deps.wasm;
    switch (ref.sort) {
      case 'table': {
        const b = wasm.getTableBBox(ref.sectionIdx, ref.paraIdx, ref.controlIdx);
        return [{ pageIndex: b.pageIndex, x: b.x, y: b.y, width: b.width, height: b.height }];
      }
      case 'control': {
        const b = wasm.getShapeBBox(ref.sectionIdx, ref.paraIdx, ref.controlIdx);
        return [{ pageIndex: b.pageIndex, x: b.x, y: b.y, width: b.width, height: b.height }];
      }
      case 'cells': {
        const boxes = wasm.getTableCellBboxes(ref.sectionIdx, ref.paraIdx, ref.controlIdx);
        return boxes
          .filter((c) => {
            if (ref.cellIdx !== undefined) return c.cellIdx === ref.cellIdx;
            if (ref.rowIdx !== undefined) return c.row <= ref.rowIdx && ref.rowIdx < c.row + c.rowSpan;
            if (ref.colIdx !== undefined) return c.col <= ref.colIdx && ref.colIdx < c.col + c.colSpan;
            if (ref.rect) {
              return c.row <= ref.rect.endRow && c.row + c.rowSpan > ref.rect.startRow
                && c.col <= ref.rect.endCol && c.col + c.colSpan > ref.rect.startCol;
            }
            return false;
          })
          .map((c) => ({ pageIndex: c.pageIndex, x: c.x, y: c.y, width: c.w, height: c.h }));
      }
      case 'para': {
        if (ref.cell) {
          const len = wasm.getCellParagraphLength(ref.sectionIdx, ref.cell.paraIdx, ref.cell.controlIdx, ref.cell.cellIdx, ref.paraIdx);
          return wasm.getSelectionRectsInCell(
            ref.sectionIdx, ref.cell.paraIdx, ref.cell.controlIdx, ref.cell.cellIdx,
            ref.paraIdx, 0, ref.paraIdx, len,
          );
        }
        const len = wasm.getParagraphLength(ref.sectionIdx, ref.paraIdx);
        return wasm.getSelectionRects(ref.sectionIdx, ref.paraIdx, 0, ref.paraIdx, len);
      }
    }
  }
}

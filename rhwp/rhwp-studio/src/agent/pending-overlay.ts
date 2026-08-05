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

const FLOW_STAGGER_MS = 45;
const FLOW_STAGGER_CAP_MS = 700;
const HIT_SLOP_PX = 4;
const POPOVER_MAX_SCALARS = 320;
const EXACT_INK_GUTTER = 0.35;

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

/**
 * 에이전트 대기 편집(pending edit)을 표시하는 오버레이.
 * replace 는 view-only exact diff 로 쪼개고, 나머지 op 는 기존 범위 렌더링을 유지한다.
 */
export class PendingOverlayRenderer {
  private markerLayer: HTMLDivElement;
  private popover: HTMLDivElement;
  private popoverText: HTMLDivElement;
  private liveRegion: HTMLDivElement;
  private inkRects: HTMLDivElement[] = [];
  private ops: OverlayOp[] = [];
  private unsubs: Array<() => void> = [];
  private diffCache = new Map<string, CachedDiff>();
  private animatedHunks = new Set<string>();
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

    const events = [
      'document-changed',
      'document-page-invalidated',
      'document-view-changed',
      'zoom-changed',
      'viewport-resize',
      'viewport-inset-changed',
    ];
    for (const name of events) {
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
    for (const key of this.animatedHunks) {
      const opId = key.slice(0, key.lastIndexOf(':'));
      if (!liveReplaceIds.has(opId)) this.animatedHunks.delete(key);
    }
    if (this.pinnedKey && ![...liveReplaceIds].some((id) => this.pinnedKey!.startsWith(`${id}:`))) {
      this.pinnedKey = null;
    }
    this.render();
  }

  clear(): void {
    this.ops = [];
    this.diffCache.clear();
    this.animatedHunks.clear();
    this.hoverKey = null;
    this.pinnedKey = null;
    this.render();
  }

  dispose(): void {
    for (const un of this.unsubs) un();
    this.unsubs = [];
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.detachInteractionRoot();
    this.ops = [];
    this.diffCache.clear();
    this.animatedHunks.clear();
    this.hitRegions = [];
    this.removeInkRects();
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

  private removeInkRects(): void {
    for (const rect of this.inkRects) rect.remove();
    this.inkRects = [];
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

  private collectExactVisuals(op: ReplaceOverlayOp): ExactVisual[] {
    const visuals: ExactVisual[] = [];
    const result = this.diffFor(op);
    result.hunks.forEach((hunk, index) => {
      const key = `${op.id}:${index}`;
      const range = rangeForNewScalarOffsets(op.range, op.newText, hunk.newStart, hunk.newEnd);
      try {
        if (hunk.newEnd > hunk.newStart) {
          for (const rect of this.rangeRects(range)) {
            visuals.push({ key, op, hunk, range, rect, anchor: false });
          }
        } else {
          visuals.push({ key, op, hunk, range, rect: this.cursorRect(op, hunk.newStart), anchor: true });
        }
      } catch {
        // 문서 미로드 / stale 주소 → 해당 hunk 는 조용히 건너뛴다.
      }
    });
    return visuals;
  }

  private renderLegacyOp(
    op: LegacyOverlayOp,
    scrollContent: HTMLElement,
    contentWidth: number,
    zoom: number,
    exactTextRects: readonly SelectionRect[],
  ): void {
    let rects: SelectionRect[];
    try {
      if (op.objRef) rects = this.resolveObjectRects(op.objRef);
      else if (op.range) rects = this.rangeRects(op.range);
      else return;
    } catch {
      return;
    }
    if (op.range && exactTextRects.length > 0) {
      rects = this.excludeExactTextRects(rects, exactTextRects);
    }
    for (const rect of rects) {
      const pos = this.pagePosition(rect, contentWidth, zoom);
      const ink = document.createElement('div');
      ink.className = `ag-pending-rect ag-pending-ink ag-${op.agent}`;
      this.positionRect(ink, pos);
      scrollContent.appendChild(ink);
      this.inkRects.push(ink);

      const marker = document.createElement('div');
      marker.className = `ag-pending-rect ag-pending-marker ag-${op.agent} ag-${op.kind}`;
      this.positionRect(marker, pos);
      this.markerLayer.appendChild(marker);
    }
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

  private renderExactVisual(
    visual: ExactVisual,
    scrollContent: HTMLElement,
    contentWidth: number,
    zoom: number,
    animate: boolean,
    delay: number,
  ): void {
    const pos = this.pagePosition(visual.rect, contentWidth, zoom);
    const isDeletion = visual.hunk.kind === 'delete';
    if (visual.anchor) {
      const marker = document.createElement('div');
      marker.className = `ag-exact-anchor ${isDeletion ? 'ag-exact-anchor-delete' : 'ag-exact-anchor-insert'}`;
      if (animate) {
        marker.classList.add('ag-liquid-anchor-in');
        marker.style.setProperty('--ag-flow-delay', `${delay}ms`);
        marker.addEventListener('animationend', () => marker.classList.remove('ag-liquid-anchor-in'), { once: true });
      }
      const markerPos = { left: pos.left - 5, top: pos.top, width: 10, height: Math.max(pos.height, 12) };
      this.positionRect(marker, markerPos);
      marker.dataset.diffHunk = visual.key;
      this.markerLayer.appendChild(marker);
      if (visual.hunk.oldText) this.hitRegions.push({ ...markerPos, key: visual.key, oldText: visual.hunk.oldText, range: visual.range });
      return;
    }

    const ink = document.createElement('div');
    ink.className = 'ag-pending-rect ag-pending-ink ag-exact-ink';
    if (animate) {
      ink.classList.add('ag-liquid-flow-in');
      ink.style.setProperty('--ag-flow-delay', `${delay}ms`);
      ink.addEventListener('animationend', () => ink.classList.remove('ag-liquid-flow-in'), { once: true });
    }
    this.positionRect(ink, pos);
    ink.dataset.diffHunk = visual.key;
    scrollContent.appendChild(ink);
    this.inkRects.push(ink);

    const marker = document.createElement('div');
    marker.className = 'ag-pending-rect ag-pending-marker ag-exact-change';
    if (animate) {
      marker.classList.add('ag-liquid-flow-in');
      marker.style.setProperty('--ag-flow-delay', `${delay}ms`);
      marker.addEventListener('animationend', () => marker.classList.remove('ag-liquid-flow-in'), { once: true });
    }
    this.positionRect(marker, pos);
    marker.dataset.diffHunk = visual.key;
    this.markerLayer.appendChild(marker);
    if (visual.hunk.oldText) this.hitRegions.push({ ...pos, key: visual.key, oldText: visual.hunk.oldText, range: visual.range });
  }

  private render(): void {
    const scrollContent = document.getElementById('scroll-content');
    if (!scrollContent) return;
    this.ensureAttached(scrollContent);
    this.removeInkRects();
    this.markerLayer.replaceChildren();
    this.hitRegions = [];

    const zoom = this.deps.canvasView.getViewportManager().getZoom();
    const contentWidth = scrollContent.clientWidth;
    const exactVisuals: ExactVisual[] = [];
    const legacyOps: LegacyOverlayOp[] = [];
    for (const op of this.ops) {
      if (op.kind === 'replace') exactVisuals.push(...this.collectExactVisuals(op));
      else legacyOps.push(op);
    }
    const exactTextRects = exactVisuals.filter((visual) => !visual.anchor).map((visual) => visual.rect);
    for (const op of legacyOps) {
      this.renderLegacyOp(op, scrollContent, contentWidth, zoom, exactTextRects);
    }

    exactVisuals.sort((a, b) => (
      a.rect.pageIndex - b.rect.pageIndex
      || a.rect.y - b.rect.y
      || a.rect.x - b.rect.x
      || a.hunk.newStart - b.hunk.newStart
    ));
    const unseenKeys = new Set(exactVisuals.map((visual) => visual.key).filter((key) => !this.animatedHunks.has(key)));
    const delays = new Map<string, number>();
    let flowIndex = 0;
    for (const visual of exactVisuals) {
      if (!delays.has(visual.key)) {
        if (unseenKeys.has(visual.key)) {
          delays.set(visual.key, Math.min(flowIndex * FLOW_STAGGER_MS, FLOW_STAGGER_CAP_MS));
          flowIndex++;
        } else {
          delays.set(visual.key, 0);
        }
      }
      this.renderExactVisual(
        visual,
        scrollContent,
        contentWidth,
        zoom,
        unseenKeys.has(visual.key),
        delays.get(visual.key)!,
      );
    }
    for (const key of unseenKeys) this.animatedHunks.add(key);

    this.markerLayer.append(this.popover, this.liveRegion);
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

import './pending-overlay.css';
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { SelectionRect } from '../core/types.ts';
import type { AgentName, CellAddr, DocRange } from './types.ts';

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

export interface OverlayOp {
  kind: 'insert' | 'delete' | 'format';
  agent: AgentName;
  range?: DocRange;
  objRef?: ObjectOverlayRef;
}

/**
 * 에이전트 대기 편집(pending edit)을 에이전트 색상 틴트/취소선으로 표시하는 오버레이.
 * SelectionRenderer 와 같은 방식: #scroll-content 안에 절대 배치 div 사각형을 그린다.
 */
export class PendingOverlayRenderer {
  private layer: HTMLDivElement;
  private ops: OverlayOp[] = [];
  private unsubs: Array<() => void> = [];
  // 파라미터 프로퍼티 대신 명시적 할당 (node --test strip-only 모드 호환).
  private deps: { canvasView: CanvasView; wasm: WasmBridge; eventBus: EventBus };

  constructor(deps: { canvasView: CanvasView; wasm: WasmBridge; eventBus: EventBus }) {
    this.deps = deps;
    this.layer = document.createElement('div');
    this.layer.className = 'ag-pending-layer';
    const events = ['document-changed', 'document-page-invalidated', 'document-view-changed', 'zoom-changed'];
    for (const name of events) {
      this.unsubs.push(deps.eventBus.on(name, () => this.render()));
    }
  }

  setOps(ops: OverlayOp[]): void {
    this.ops = ops;
    this.render();
  }

  clear(): void {
    this.ops = [];
    this.render();
  }

  dispose(): void {
    for (const un of this.unsubs) un();
    this.unsubs = [];
    this.ops = [];
    this.layer.remove();
  }

  /** loadDocument 가 #scroll-content 를 비우므로 매 렌더마다 재부착한다 */
  private ensureAttached(scrollContent: HTMLElement): void {
    if (this.layer.parentElement !== scrollContent) {
      scrollContent.appendChild(this.layer);
    }
  }

  private render(): void {
    const scrollContent = document.getElementById('scroll-content');
    if (!scrollContent) return;
    this.ensureAttached(scrollContent);
    this.layer.replaceChildren();
    if (this.ops.length === 0) return;

    const zoom = this.deps.canvasView.getViewportManager().getZoom();
    const vs = this.deps.canvasView.getVirtualScroll();
    const contentWidth = scrollContent.clientWidth;

    for (const op of this.ops) {
      let rects: SelectionRect[];
      try {
        if (op.objRef) {
          rects = this.resolveObjectRects(op.objRef);
        } else if (op.range) {
          const cell = op.range.cell;
          rects = cell
            ? this.deps.wasm.getSelectionRectsInCell(
              op.range.sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx,
              op.range.startParaIdx, op.range.startCharOffset,
              op.range.endParaIdx, op.range.endCharOffset,
            )
            : this.deps.wasm.getSelectionRects(
              op.range.sectionIdx,
              op.range.startParaIdx, op.range.startCharOffset,
              op.range.endParaIdx, op.range.endCharOffset,
            );
        } else {
          continue;
        }
      } catch {
        // 문서 미로드 / stale 주소 → 해당 op 는 조용히 건너뛴다
        continue;
      }
      for (const rect of rects) {
        const pl = vs.getPageLeft(rect.pageIndex);
        const pageLeft = pl >= 0 ? pl : (contentWidth - vs.getPageWidth(rect.pageIndex)) / 2;
        const div = document.createElement('div');
        div.className = `ag-pending-rect ag-${op.agent} ag-${op.kind}`;
        div.style.left = `${(pageLeft + rect.x * zoom).toFixed(2)}px`;
        div.style.top = `${(vs.getPageOffset(rect.pageIndex) + rect.y * zoom).toFixed(2)}px`;
        div.style.width = `${(rect.width * zoom).toFixed(2)}px`;
        div.style.height = `${(rect.height * zoom).toFixed(2)}px`;
        this.layer.appendChild(div);
      }
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

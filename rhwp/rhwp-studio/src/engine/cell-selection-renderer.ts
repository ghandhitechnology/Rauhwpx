import type { CellBbox } from '@/core/types';
import { cellSelectionRects, type CellRange } from './table-selection-rects';
import { VirtualScroll } from '@/view/virtual-scroll';

/** F5 셀 블록 선택 영역을 하이라이트 오버레이로 렌더링한다 */
export class CellSelectionRenderer {
  private layer: HTMLDivElement;
  private highlights: HTMLDivElement[] = [];

  constructor(
    private container: HTMLElement,
    private virtualScroll: VirtualScroll,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'cell-selection-layer';
    this.layer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:6;';
    const scrollContent = container.querySelector('#scroll-content');
    if (scrollContent) {
      scrollContent.appendChild(this.layer);
    }
  }

  /** 선택 범위 내 셀들을 하이라이트한다 */
  render(
    cellBboxes: CellBbox[],
    range: CellRange,
    zoom: number,
    excluded?: Set<string>,
  ): void {
    this.clear();
    this.ensureAttached();

    const scrollContent = this.container.querySelector('#scroll-content');
    const contentWidth = scrollContent?.clientWidth ?? 0;

    for (const rect of cellSelectionRects(cellBboxes, range, excluded)) {
      const div = document.createElement('div');
      const pageOffset = this.virtualScroll.getPageOffset(rect.pageIndex);
      // 그리드 배치·수평 팬 대응 — 중앙 정렬 가정 대신 확정된 pageLeft 사용.
      const pageLeft = this.virtualScroll.getPageLeftResolved(rect.pageIndex, contentWidth);

      div.className = 'cell-selection-highlight';
      div.style.cssText =
        `position:absolute;` +
        `left:${pageLeft + rect.x * zoom}px;` +
        `top:${pageOffset + rect.y * zoom}px;` +
        `width:${rect.width * zoom}px;` +
        `height:${rect.height * zoom}px;`;
      this.layer.appendChild(div);
      this.highlights.push(div);
    }
  }

  /** 모든 하이라이트를 제거한다 */
  clear(): void {
    for (const div of this.highlights) {
      div.remove();
    }
    this.highlights = [];
  }

  /** 레이어가 DOM에 없으면 재부착한다 */
  private ensureAttached(): void {
    if (this.layer.parentElement) return;
    const scrollContent = this.container.querySelector('#scroll-content');
    if (scrollContent) {
      scrollContent.appendChild(this.layer);
    }
  }

  dispose(): void {
    this.clear();
    this.layer.remove();
  }
}

import type { PageInfo } from '@/core/types';

/** 그리드 모드 전환 줌 임계값 */
const GRID_ZOOM_THRESHOLD = 0.5;

export interface PageWindow {
  visible: number[];
  prefetch: number[];
}

export type PageMovementDirection = 'vertical' | 'horizontal';

export class VirtualScroll {
  private pageOffsets: number[] = [];
  private pageHeights: number[] = [];
  private pageWidths: number[] = [];
  private pageLefts: number[] = [];
  private rowFirstPages: number[] = [];
  private rowOffsets: number[] = [];
  private rowHeights: number[] = [];
  private maxPageWidth = 0;
  private totalHeight = 0;
  private totalWidth = 0;
  private columns = 1;
  private gridMode = false;
  private horizontalMode = false;
  private readonly pageGap: number;

  constructor(pageGap = 10) {
    this.pageGap = pageGap;
  }

  /**
   * 페이지 크기 정보로 오프셋 배열을 구축한다.
   * `_arrangement`는 업스트림 쪽 배치 인자를 자리만 맞춘다. 맞쪽/여러 쪽 배치는
   * 아직 이식하지 않았고, `movement === 'horizontal'` 가로 줄만 이 경로에서 처리한다.
   */
  setPageDimensions(
    pages: PageInfo[],
    zoom = 1.0,
    viewportWidth = 0,
    _arrangement?: unknown,
    movement: PageMovementDirection = 'vertical',
    viewportHeight = 0,
  ): void {
    this.pageHeights = pages.map((p) => p.height * zoom);
    this.pageWidths = pages.map((p) => p.width * zoom);
    this.maxPageWidth = 0;
    for (const width of this.pageWidths) {
      this.maxPageWidth = Math.max(this.maxPageWidth, width);
    }

    this.horizontalMode = movement === 'horizontal';
    if (this.horizontalMode) {
      this.gridMode = false;
      this.layoutHorizontalRow(viewportWidth, viewportHeight);
      return;
    }

    // 그리드 모드 판정
    this.gridMode = zoom <= GRID_ZOOM_THRESHOLD && viewportWidth > 0 && pages.length > 1;

    if (this.gridMode) {
      this.layoutGrid(viewportWidth);
    } else {
      this.layoutSingleColumn();
    }
    this.applyHorizontalPanSpace(viewportWidth);
  }

  /** 한컴 가로 쪽 이동: 한 쪽 배치의 모든 페이지를 왼쪽에서 오른쪽으로 잇는다. */
  private layoutHorizontalRow(viewportWidth: number, viewportHeight: number): void {
    this.columns = 1;
    this.pageOffsets = new Array(this.pageHeights.length).fill(0);
    this.pageLefts = new Array(this.pageHeights.length).fill(0);
    this.rowFirstPages = this.pageHeights.length > 0 ? [0] : [];
    this.rowOffsets = [];
    this.rowHeights = [];

    const innerWidth = this.pageWidths.reduce((sum, width) => sum + width, 0)
      + this.pageGap * Math.max(0, this.pageWidths.length - 1);
    const marginLeft = Math.max(this.pageGap, (viewportWidth - innerWidth) / 2);
    const maxPageHeight = Math.max(...this.pageHeights, 0);
    this.totalHeight = Math.max(viewportHeight, maxPageHeight + this.pageGap * 2);

    let left = marginLeft;
    for (let pageIdx = 0; pageIdx < this.pageWidths.length; pageIdx++) {
      this.pageLefts[pageIdx] = left;
      this.pageOffsets[pageIdx] = Math.max(
        this.pageGap,
        (this.totalHeight - this.pageHeights[pageIdx]) / 2,
      );
      left += this.pageWidths[pageIdx] + this.pageGap;
    }
    this.totalWidth = Math.max(viewportWidth, innerWidth + marginLeft * 2);
    if (this.pageHeights.length > 0) {
      this.rowOffsets.push(Math.min(...this.pageOffsets));
      this.rowHeights.push(maxPageHeight);
    }
  }

  /** 단일 열 배치 (기존 동작) */
  private layoutSingleColumn(): void {
    this.columns = 1;
    this.pageOffsets = [];
    this.pageLefts = [];
    this.rowFirstPages = [];
    this.rowOffsets = [];
    this.rowHeights = [];
    let offset = this.pageGap;
    for (let i = 0; i < this.pageHeights.length; i++) {
      this.pageOffsets.push(offset);
      this.pageLefts.push(-1); // -1 = CSS 중앙 정렬 사용
      this.rowFirstPages.push(i);
      this.rowOffsets.push(offset);
      this.rowHeights.push(this.pageHeights[i]);
      offset += this.pageHeights[i] + this.pageGap;
    }
    this.totalHeight = offset;
    this.totalWidth = this.maxPageWidth + 40;
  }

  /** 그리드(다중 열) 배치 */
  private layoutGrid(viewportWidth: number): void {
    const gap = this.pageGap;
    const pw = this.maxPageWidth;

    // 열 수 계산: 뷰포트에 들어가는 최대 열 수
    this.columns = Math.max(1, Math.floor((viewportWidth + gap) / (pw + gap)));

    this.pageOffsets = [];
    this.pageLefts = [];
    this.rowFirstPages = [];
    this.rowOffsets = [];
    this.rowHeights = [];

    // 그리드 전체 너비 = columns * pageWidth + (columns-1) * gap
    const gridWidth = this.columns * pw + (this.columns - 1) * gap;
    const marginLeft = Math.max(gap, (viewportWidth - gridWidth) / 2);

    let rowTop = gap;
    for (let rowStart = 0; rowStart < this.pageHeights.length; rowStart += this.columns) {
      const rowEnd = Math.min(rowStart + this.columns, this.pageHeights.length);
      let rowHeight = 0;
      this.rowFirstPages.push(rowStart);
      this.rowOffsets.push(rowTop);
      for (let i = rowStart; i < rowEnd; i++) {
        const col = i - rowStart;
        rowHeight = Math.max(rowHeight, this.pageHeights[i]);
        this.pageOffsets.push(rowTop);
        this.pageLefts.push(marginLeft + col * (pw + gap));
      }
      this.rowHeights.push(rowHeight);
      rowTop += rowHeight + gap;
    }

    this.totalHeight = rowTop;
    this.totalWidth = Math.max(gridWidth + marginLeft * 2, viewportWidth);
  }

  /**
   * 가로 팬 여유 공간. 페이지가 뷰포트를 넘칠 때(확대 상태)만 좌우로 뷰포트
   * 너비만큼 여유를 준다 — 줌 앵커가 어떤 지점이든 표현 가능하려면 이만큼
   * 필요하다. 페이지가 뷰포트에 다 들어오는 보통 상태에서는 여유를 없애
   * 가로 스크롤 자체를 봉인한다. 여유를 두면 세로 스크롤 중 트랙패드의 가로
   * 성분에 문서가 옆으로 미끄러진다. 최종 폭은 항상 뷰포트 이상으로 유지해,
   * 가운데 스크롤 위치에서 페이지가 뷰포트 중앙에 오는 불변식
   * (pageLeft − centeredScrollLeft = (viewport − pageWidth) / 2)을 지킨다.
   */
  private applyHorizontalPanSpace(viewportWidth: number): void {
    if (viewportWidth <= 0) return;
    const baseWidth = this.totalWidth;
    // 판정 기준은 실제 페이지 폭이다. base 에 붙는 여백(+40) 때문에 '페이지는
    // 다 보이는데 몇십 px 슬쩍 밀리는' 상태로 넉넉한 팬 공간이 생기면 안 된다.
    const slack = this.maxPageWidth > viewportWidth ? viewportWidth : 0;
    // slack 이 없으면 최종 폭을 뷰포트에 정확히 맞춰 가로 스크롤을 봉인한다.
    // base 의 +40 여백이 뷰포트를 살짝 넘겨 수십 px 이 슬쩍 밀리는 상태를 막는다
    // (페이지 자체는 뷰포트보다 좁으므로 잘리는 건 장식 여백뿐이다).
    const total = slack > 0
      ? Math.max(baseWidth, viewportWidth) + slack * 2
      : viewportWidth;
    const shift = (total - baseWidth) / 2;
    this.pageLefts = this.pageLefts.map((left, pageIdx) => {
      const resolved = left >= 0
        ? left
        : (baseWidth - (this.pageWidths[pageIdx] ?? 0)) / 2;
      return resolved + shift;
    });
    this.totalWidth = total;
  }

  /** 뷰포트에 보이는 페이지 인덱스 목록을 반환한다 */
  getVisiblePages(
    scrollY: number,
    viewportHeight: number,
    scrollX = 0,
    viewportWidth = 0,
  ): number[] {
    return this.getPageWindow(scrollY, viewportHeight, scrollX, viewportWidth).visible;
  }

  /** visible 페이지와 인접 prefetch 행을 한 번의 행 탐색으로 계산한다. */
  getPageWindow(
    scrollY: number,
    viewportHeight: number,
    scrollX = 0,
    viewportWidth = 0,
  ): PageWindow {
    const vpTop = scrollY;
    const vpBottom = scrollY + viewportHeight;
    const vpLeft = scrollX;
    const vpRight = viewportWidth > 0 ? scrollX + viewportWidth : Infinity;
    const visible: number[] = [];
    let firstVisibleRow = -1;
    let lastVisibleRow = -1;

    for (
      let row = this.findFirstVisibleRow(vpTop);
      row < this.rowOffsets.length && this.rowOffsets[row] < vpBottom;
      row++
    ) {
      const rowFirst = this.rowFirstPages[row];
      const rowEnd = this.rowFirstPages[row + 1] ?? this.pageCount;
      let rowVisible = false;
      for (let page = rowFirst; page < rowEnd; page++) {
        const pageTop = this.pageOffsets[page];
        const pageLeft = this.getPageLeftResolved(page, this.totalWidth);
        const pageRight = pageLeft + this.pageWidths[page];
        if (
          pageTop < vpBottom
          && pageTop + this.pageHeights[page] > vpTop
          && pageLeft < vpRight
          && pageRight > vpLeft
        ) {
          visible.push(page);
          rowVisible = true;
        }
      }
      if (rowVisible) {
        if (firstVisibleRow < 0) firstVisibleRow = row;
        lastVisibleRow = row;
      }
    }

    if (firstVisibleRow < 0) return { visible, prefetch: [] };

    if (this.horizontalMode) {
      const prefetch = new Set(visible);
      if (visible.length > 0) {
        const first = visible[0];
        const last = visible[visible.length - 1];
        if (first > 0) prefetch.add(first - 1);
        if (last + 1 < this.pageCount) prefetch.add(last + 1);
      }
      return { visible, prefetch: Array.from(prefetch).sort((a, b) => a - b) };
    }

    const prefetch: number[] = [];
    this.appendRowPages(prefetch, firstVisibleRow - 1);
    prefetch.push(...visible);
    this.appendRowPages(prefetch, lastVisibleRow + 1);
    return { visible, prefetch };
  }

  /** 프리페치 대상 페이지 (visible 범위 ± 1행) */
  getPrefetchPages(
    scrollY: number,
    viewportHeight: number,
    scrollX = 0,
    viewportWidth = 0,
  ): number[] {
    return this.getPageWindow(scrollY, viewportHeight, scrollX, viewportWidth).prefetch;
  }

  private findFirstVisibleRow(vpTop: number): number {
    let low = 0;
    let high = this.rowOffsets.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (this.rowOffsets[mid] + this.rowHeights[mid] <= vpTop) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  private findRowAtY(docY: number): number {
    let low = 0;
    let high = this.rowOffsets.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (this.rowOffsets[mid] <= docY) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return Math.max(0, low - 1);
  }

  private appendRowPages(target: number[], row: number): void {
    if (row < 0 || row >= this.rowFirstPages.length) return;
    const first = this.rowFirstPages[row];
    const end = this.rowFirstPages[row + 1] ?? this.pageCount;
    for (let page = first; page < end; page++) target.push(page);
  }

  /** 특정 문서 Y 좌표가 속하는 페이지 인덱스를 반환한다 */
  /**
   * Y 가 속한 행의 **마지막** 쪽 인덱스.
   *
   * 그리드 모드에서 한 행의 모든 쪽은 같은 offset 을 가지므로(layoutGrid),
   * 뒤에서부터 스캔하는 이 함수는 그 행의 최대 인덱스를 돌려준다.
   * `getPageAtPoint` 가 X 로 좁히기 위한 스캔 끝점으로 쓴다.
   *
   * "현재 쪽" 이 필요하면 [`getRowFirstPageAtY`] 를 쓸 것 — [#2560].
   */
  getPageAtY(docY: number): number {
    if (this.pageCount === 0 || this.horizontalMode) return 0;
    const row = this.findRowAtY(docY);
    return (this.rowFirstPages[row + 1] ?? this.pageCount) - 1;
  }

  /**
   * Y 가 속한 행의 **첫** 쪽 인덱스 — 사람이 말하는 "현재 쪽".
   *
   * 단일 컬럼 모드에서는 `getPageAtY` 와 동치다.
   */
  getRowFirstPageAtY(docY: number): number {
    if (this.pageCount === 0 || this.horizontalMode) return 0;
    return this.rowFirstPages[this.findRowAtY(docY)] ?? 0;
  }

  /** 한 행에 놓이는 쪽 수. 단일 컬럼 모드는 1. */
  get pagesPerRow(): number {
    return this.gridMode ? this.columns : 1;
  }

  /**
   * 문서 좌표 (X, Y) 가 속하는 페이지 인덱스를 반환한다.
   * 단일 컬럼 모드: getPageAtY 와 동치 (X 무관).
   * 그리드 모드: row(Y) 결정 후 같은 row 안에서 X 가 속하는 페이지 반환.
   *              gap 영역(페이지 사이 빈 공간) click 은 가장 가까운 페이지로 fallback.
   */
  getPageAtPoint(docX: number, docY: number): number {
    if (this.horizontalMode) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let pageIdx = 0; pageIdx < this.pageLefts.length; pageIdx++) {
        const left = this.pageLefts[pageIdx] ?? 0;
        const right = left + (this.pageWidths[pageIdx] ?? 0);
        if (docX >= left && docX <= right) return pageIdx;
        const dist = docX < left ? left - docX : docX - right;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = pageIdx;
        }
      }
      return bestIdx;
    }

    if (!this.gridMode) return this.getPageAtY(docY);
    const row = this.findRowAtY(docY);
    const rowFirst = this.rowFirstPages[row] ?? 0;
    const rowLastIdx = (this.rowFirstPages[row + 1] ?? this.pageCount) - 1;

    // X 가 페이지 안에 속하는 첫 번째 페이지 반환
    for (let i = rowFirst; i <= rowLastIdx; i++) {
      const left = this.pageLefts[i] ?? 0;
      const right = left + (this.pageWidths[i] ?? 0);
      if (docX >= left && docX <= right) return i;
    }

    // gap / margin 영역 — 가장 가까운 페이지로 fallback
    let bestIdx = rowFirst;
    let bestDist = Infinity;
    for (let i = rowFirst; i <= rowLastIdx; i++) {
      const left = this.pageLefts[i] ?? 0;
      const right = left + (this.pageWidths[i] ?? 0);
      const dist = docX < left ? left - docX : (docX > right ? docX - right : 0);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    return bestIdx;
  }

  getPageOffset(pageIdx: number): number {
    return this.pageOffsets[pageIdx] ?? 0;
  }

  getPageHeight(pageIdx: number): number {
    return this.pageHeights[pageIdx] ?? 0;
  }

  getPageWidth(pageIdx: number): number {
    return this.pageWidths[pageIdx] ?? 0;
  }

  /** 페이지의 X 좌표를 반환한다 (-1이면 CSS 중앙 정렬 사용) */
  getPageLeft(pageIdx: number): number {
    return this.pageLefts[pageIdx] ?? -1;
  }

  /**
   * 페이지의 X 좌표를 그리드/단일 컬럼 모드 통합으로 반환.
   * 그리드 모드: pageLefts[i] 그대로.
   * 단일 컬럼 모드(sentinel −1): (containerWidth - pageWidth) / 2 fallback.
   */
  getPageLeftResolved(pageIdx: number, containerWidth: number): number {
    const pl = this.pageLefts[pageIdx] ?? -1;
    if (pl >= 0) return pl;
    const pw = this.pageWidths[pageIdx] ?? 0;
    return (containerWidth - pw) / 2;
  }

  getMaxPageWidth(): number {
    return this.maxPageWidth;
  }

  getTotalHeight(): number {
    return this.totalHeight;
  }

  getTotalWidth(): number {
    return this.totalWidth;
  }

  getCenteredScrollLeft(viewportWidth: number): number {
    if (this.horizontalMode) return 0;
    return Math.max(0, (this.totalWidth - viewportWidth) / 2);
  }

  isGridMode(): boolean {
    return this.gridMode;
  }

  isHorizontalMode(): boolean {
    return this.horizontalMode;
  }

  /** 위에서 아래 순서의 실제 행 시작 페이지. */
  getRowStartPages(): number[] {
    return [...this.rowFirstPages];
  }

  getColumns(): number {
    return this.columns;
  }

  get pageCount(): number {
    return this.pageOffsets.length;
  }

  get gap(): number {
    return this.pageGap;
  }
}

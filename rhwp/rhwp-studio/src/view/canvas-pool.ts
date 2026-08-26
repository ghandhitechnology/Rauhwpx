const DEFAULT_MAX_RETAINED_BACKING_PIXELS = 8_388_608;

export class CanvasPool {
  private available: HTMLCanvasElement[] = [];
  private inUse = new Map<number, HTMLCanvasElement>();
  private availableBackingPixels = 0;
  private readonly maxRetainedBackingPixels: number;

  constructor(maxRetainedBackingPixels = DEFAULT_MAX_RETAINED_BACKING_PIXELS) {
    this.maxRetainedBackingPixels = maxRetainedBackingPixels;
  }

  /** Canvas를 할당한다 (풀에서 꺼내거나 새로 생성) */
  acquire(pageIdx: number): HTMLCanvasElement {
    let canvas = this.available.pop();
    if (!canvas) {
      canvas = document.createElement('canvas');
    } else {
      this.availableBackingPixels -= canvas.width * canvas.height;
    }
    this.inUse.set(pageIdx, canvas);
    return canvas;
  }

  /** CanvasKit이 software fallback canvas로 교체한 경우 pool 소유권을 넘긴다. */
  replace(pageIdx: number, current: HTMLCanvasElement, replacement: HTMLCanvasElement): void {
    if (this.inUse.get(pageIdx) !== current) {
      throw new Error(`페이지 ${pageIdx} Canvas 교체 대상이 현재 pool 항목과 다릅니다`);
    }
    current.parentElement?.removeChild(current);
    current.width = 0;
    current.height = 0;
    this.inUse.set(pageIdx, replacement);
  }

  /** Canvas를 반환한다 (DOM에서 제거 후 풀에 반환) */
  release(pageIdx: number): void {
    const canvas = this.inUse.get(pageIdx);
    if (canvas) {
      canvas.parentElement?.removeChild(canvas);
      this.inUse.delete(pageIdx);
      const pixels = canvas.width * canvas.height;
      // 스크롤 중 방금 해제한 한 장은 즉시 재사용될 수 있으므로 크기와 무관하게 남긴다.
      // 그 뒤의 backing store만 예산 안에 더해 zoom/grid 고수위가 계속 남지 않게 한다.
      const exceedsBudget = this.availableBackingPixels > 0
        && pixels > this.maxRetainedBackingPixels - this.availableBackingPixels;
      if (exceedsBudget) {
        canvas.width = 0;
        canvas.height = 0;
        this.available.unshift(canvas);
      } else {
        this.availableBackingPixels += pixels;
        this.available.push(canvas);
      }
    }
  }

  /** 특정 페이지에 할당된 Canvas를 조회한다 */
  getCanvas(pageIdx: number): HTMLCanvasElement | undefined {
    return this.inUse.get(pageIdx);
  }

  /** 특정 페이지가 이미 할당되어 있는지 확인한다 */
  has(pageIdx: number): boolean {
    return this.inUse.has(pageIdx);
  }

  /** 모든 Canvas를 반환한다 */
  releaseAll(): void {
    const pages = Array.from(this.inUse.keys());
    for (const pageIdx of pages) {
      this.release(pageIdx);
    }
  }

  /** 현재 사용 중인 페이지 인덱스 목록 */
  get activePages(): number[] {
    return Array.from(this.inUse.keys());
  }

  /** 사용 중 + 풀 대기 Canvas 총 수 */
  get totalCount(): number {
    return this.inUse.size + this.available.length;
  }

  /** 풀 대기 canvas가 유지하는 RGBA backing-store 추정 바이트. */
  get retainedBackingBytes(): number {
    return this.availableBackingPixels * 4;
  }
}

export interface MutationRefreshBatch {
  full: boolean;
  pages: ReadonlyMap<number, boolean>;
}

interface FrameScheduler {
  request(callback: () => void): number;
  cancel(id: number): void;
}

/** 페이지 무효화를 renderer 선택 전에 합치고 비동기 선택 중에도 빠뜨리지 않는다. */
export class MutationRefreshQueue {
  private frame: number | null = null;
  private full = false;
  private pages = new Map<number, boolean>();
  private running = false;
  private generation = 0;

  private readonly refresh: (batch: MutationRefreshBatch, isCurrent: () => boolean) => Promise<void>;
  private readonly onError: (error: unknown) => void;
  private readonly scheduler: FrameScheduler;

  constructor(
    refresh: (batch: MutationRefreshBatch, isCurrent: () => boolean) => Promise<void>,
    onError: (error: unknown) => void,
    scheduler: FrameScheduler = {
      request: callback => requestAnimationFrame(callback),
      cancel: id => cancelAnimationFrame(id),
    },
  ) {
    this.refresh = refresh;
    this.onError = onError;
    this.scheduler = scheduler;
  }

  invalidateAll(): void {
    this.full = true;
    this.pages.clear();
    this.schedule();
  }

  invalidatePage(pageIndex: number, textOnly: boolean): void {
    if (!this.full) {
      // 같은 쪽에 개체/서식 변경도 있으면 정적 레이어를 재사용하지 않는다.
      this.pages.set(pageIndex, (this.pages.get(pageIndex) ?? true) && textOnly);
    }
    this.schedule();
  }

  cancel(): void {
    this.generation += 1;
    if (this.frame !== null) this.scheduler.cancel(this.frame);
    this.frame = null;
    this.full = false;
    this.pages.clear();
    this.running = false;
  }

  private schedule(): void {
    if (this.running || this.frame !== null || (!this.full && this.pages.size === 0)) return;
    this.frame = this.scheduler.request(() => {
      this.frame = null;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    const generation = this.generation;
    const isCurrent = () => generation === this.generation;
    const batch = { full: this.full, pages: this.pages };
    this.full = false;
    this.pages = new Map();
    this.running = true;
    try {
      await this.refresh(batch, isCurrent);
    } catch (error) {
      if (isCurrent()) this.onError(error);
    } finally {
      if (isCurrent()) {
        this.running = false;
        this.schedule();
      }
    }
  }
}

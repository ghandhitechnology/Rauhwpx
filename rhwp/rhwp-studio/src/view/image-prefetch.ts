interface PrefetchBatch {
  urls: readonly string[];
  next: number;
  active: Set<() => void>;
  finish: () => void;
  done: boolean;
}

/** 여러 페이지가 동시에 요청해도 임시 이미지 디코드 수를 제한한다. */
export class ImagePrefetcher {
  private readonly batches: PrefetchBatch[] = [];
  private activeCount = 0;
  private pumping = false;
  private readonly concurrency: number;
  private readonly createImage: () => HTMLImageElement;

  constructor(
    concurrency = 4,
    createImage: () => HTMLImageElement = () => new Image(),
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Image prefetch concurrency must be a positive integer');
    }
    this.concurrency = concurrency;
    this.createImage = createImage;
  }

  prefetch(urls: readonly string[], signal: AbortSignal): Promise<void> {
    if (signal.aborted || urls.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const batch: PrefetchBatch = {
        urls,
        next: 0,
        active: new Set(),
        done: false,
        finish: () => {
          if (batch.done) return;
          batch.done = true;
          signal.removeEventListener('abort', batch.finish);
          const index = this.batches.indexOf(batch);
          if (index !== -1) this.batches.splice(index, 1);
          batch.urls = [];
          for (const cancel of batch.active) cancel();
          resolve();
          this.pump();
        },
      };
      signal.addEventListener('abort', batch.finish, { once: true });
      this.batches.push(batch);
      this.pump();
    });
  }

  cancelAll(): void {
    const wasPumping = this.pumping;
    this.pumping = true;
    try {
      for (const batch of [...this.batches]) batch.finish();
    } finally {
      this.pumping = wasPumping;
    }
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.activeCount < this.concurrency) {
        const batch = this.batches.find(candidate => candidate.next < candidate.urls.length);
        if (!batch) break;
        this.start(batch, batch.urls[batch.next++]);
      }
    } finally {
      this.pumping = false;
    }
  }

  private start(batch: PrefetchBatch, url: string): void {
    let image: HTMLImageElement | null = null;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (image) {
        image.onload = null;
        image.onerror = null;
        image.removeAttribute('src');
        image = null;
      }
      batch.active.delete(settle);
      this.activeCount -= 1;
      if (!batch.done && batch.next === batch.urls.length && batch.active.size === 0) {
        batch.finish();
      }
      this.pump();
    };
    batch.active.add(settle);
    this.activeCount += 1;
    try {
      image = this.createImage();
      image.onload = settle;
      image.onerror = settle;
      image.src = url;
      if (image && typeof image.decode === 'function') {
        void image.decode().then(settle, settle);
      }
    } catch {
      settle();
    }
  }
}

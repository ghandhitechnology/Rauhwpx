import assert from 'node:assert/strict';
import test from 'node:test';
import { ImagePrefetcher } from '../src/view/image-prefetch.ts';

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  resolveDecode!: () => void;
  rejectDecode!: () => void;
  decodePromise = new Promise<void>((resolve, reject) => {
    this.resolveDecode = resolve;
    this.rejectDecode = () => reject(new Error('invalid image'));
  });

  decode(): Promise<void> { return this.decodePromise; }
  removeAttribute(name: string): void {
    assert.equal(name, 'src');
    this.src = '';
  }
}

function harness(concurrency = 4) {
  const images: FakeImage[] = [];
  const prefetcher = new ImagePrefetcher(concurrency, () => {
    const image = new FakeImage();
    images.push(image);
    return image as unknown as HTMLImageElement;
  });
  return { prefetcher, images };
}

test('concurrent pages share the decode limit and complete all queued images', async () => {
  const { prefetcher, images } = harness();
  const first = prefetcher.prefetch(Array.from({ length: 20 }, (_, i) => `first-${i}`), new AbortController().signal);
  const second = prefetcher.prefetch(Array.from({ length: 20 }, (_, i) => `second-${i}`), new AbortController().signal);
  assert.equal(images.length, 4);

  let peakActive = 0;
  for (let i = 0; i < 40; i++) {
    peakActive = Math.max(peakActive, images.filter(image => image.src).length);
    images[i].onload!();
  }
  await Promise.all([first, second]);
  assert.equal(peakActive, 4);
  assert.equal(images.length, 40);
  assert.ok(images.every(image => image.src === '' && image.onload === null && image.onerror === null));
});

test('cancelling an active page releases images and starts the current queued page', async () => {
  const { prefetcher, images } = harness(2);
  const stale = new AbortController();
  const oldBatch = prefetcher.prefetch(['old-1', 'old-2', 'old-3'], stale.signal);
  const newBatch = prefetcher.prefetch(['new-1'], new AbortController().signal);
  const lateOnLoad = images[0].onload!;
  stale.abort();
  await oldBatch;

  assert.deepEqual(images.map(image => image.src), ['', '', 'new-1']);
  // decode() can settle after removing src. It must not release another slot.
  lateOnLoad();
  images[0].resolveDecode();
  images[1].rejectDecode();
  await Promise.resolve();
  assert.equal(images.length, 3);
  images[2].resolveDecode();
  await newBatch;
  assert.equal(images[2].src, '');
});

test('cancelling all pages stops queued work without starting other stale decodes', async () => {
  const { prefetcher, images } = harness();
  const pending = Array.from({ length: 100 }, (_, page) => prefetcher.prefetch(
    Array.from({ length: 20 }, (_, image) => `${page}-${image}`),
    new AbortController().signal,
  ));
  assert.equal(images.length, 4, '2,000 pending images should allocate only four decoders');
  prefetcher.cancelAll();
  await Promise.all(pending);
  assert.equal(images.length, 4, 'cancellation must not pump any of the other 99 pages');
  assert.ok(images.every(image => !image.src && !image.onload && !image.onerror));

  const current = prefetcher.prefetch(['current'], new AbortController().signal);
  assert.equal(images.length, 5);
  images[4].onload!();
  await current;
});

test('aborted queued pages never allocate decoders, and decode errors free the slot', async () => {
  const { prefetcher, images } = harness(1);
  const first = prefetcher.prefetch(['first'], new AbortController().signal);
  const queued = new AbortController();
  const cancelled = prefetcher.prefetch(['cancelled'], queued.signal);
  queued.abort();
  await cancelled;
  await prefetcher.prefetch(['already-aborted'], queued.signal);
  const last = prefetcher.prefetch(['last'], new AbortController().signal);
  images[0].rejectDecode();
  await first;
  assert.deepEqual(images.map(image => image.src), ['', 'last']);
  images[1].onerror!();
  await last;
});

test('synchronous image failures and browsers without decode do not stall the queue', async () => {
  let attempts = 0;
  const prefetcher = new ImagePrefetcher(1, () => {
    attempts += 1;
    throw new Error('image allocation failed');
  });
  await prefetcher.prefetch(['one', 'two'], new AbortController().signal);
  assert.equal(attempts, 2);

  const image = new FakeImage();
  Object.defineProperty(image, 'decode', { value: undefined });
  const legacy = new ImagePrefetcher(1, () => image as unknown as HTMLImageElement);
  const done = legacy.prefetch(['legacy'], new AbortController().signal);
  image.onload!();
  await done;
  assert.equal(image.src, '');
});

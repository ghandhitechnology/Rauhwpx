import assert from 'node:assert/strict';
import test from 'node:test';
import { MutationRefreshQueue, type MutationRefreshBatch } from '../src/view/mutation-refresh-queue.ts';

function fixture(refresh?: (batch: MutationRefreshBatch, current: () => boolean) => Promise<void>) {
  const frames = new Map<number, () => void>();
  const batches: MutationRefreshBatch[] = [];
  const errors: unknown[] = [];
  let next = 0;
  const queue = new MutationRefreshQueue(async (batch, current) => {
    batches.push(batch);
    await refresh?.(batch, current);
  }, error => errors.push(error), {
    request(callback) { frames.set(++next, callback); return next; },
    cancel(id) { frames.delete(id); },
  });
  return { queue, frames, batches, errors, async frame() {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback());
    for (let i = 0; i < 5; i++) await Promise.resolve();
  } };
}

test('1,000 invalidations select one revision and retain every dirty page', async () => {
  const f = fixture();
  for (let i = 0; i < 1_000; i++) f.queue.invalidatePage(i % 8, true);
  assert.equal(f.frames.size, 1);
  await f.frame();
  assert.equal(f.batches.length, 1);
  assert.deepEqual([...f.batches[0].pages.keys()], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(f.frames.size, 0);
});

test('a non-text mutation prevents static reuse regardless of event order', async () => {
  const f = fixture();
  f.queue.invalidatePage(0, true);
  f.queue.invalidatePage(0, false);
  f.queue.invalidatePage(0, true);
  await f.frame();
  assert.equal(f.batches[0].pages.get(0), false);
});

test('a full refresh absorbs page invalidations on either side', async () => {
  const f = fixture();
  f.queue.invalidatePage(0, true);
  f.queue.invalidateAll();
  f.queue.invalidatePage(1, false);
  await f.frame();
  assert.equal(f.batches[0].full, true);
  assert.equal(f.batches[0].pages.size, 0);
});

test('edits arriving during asynchronous renderer selection wait for the next frame', async () => {
  let finish!: () => void;
  const f = fixture(() => new Promise<void>(resolve => { finish = resolve; }));
  f.queue.invalidatePage(0, true);
  await f.frame();
  f.queue.invalidatePage(1, true);
  f.queue.invalidatePage(2, true);
  assert.equal(f.frames.size, 0, 'selections must not overlap and supersede dirty pages');
  finish();
  await f.frame();
  assert.equal(f.frames.size, 1);
  await f.frame();
  assert.deepEqual([...f.batches[1].pages.keys()], [1, 2]);
  finish();
});

test('document replacement cancels both queued work and an old asynchronous continuation', async () => {
  const continuations: Array<() => void> = [];
  const painted: number[] = [];
  const f = fixture(async (batch, current) => {
    await new Promise<void>(resolve => continuations.push(resolve));
    if (current()) painted.push(...batch.pages.keys());
  });
  f.queue.invalidatePage(0, true);
  await f.frame();
  f.queue.invalidatePage(1, true);
  f.queue.cancel();
  f.queue.invalidatePage(2, true);
  await f.frame();
  continuations[0]();
  await f.frame();
  assert.deepEqual(painted, []);
  continuations[1]();
  await f.frame();
  assert.deepEqual(painted, [2]);
  f.queue.invalidatePage(3, true);
  f.queue.cancel();
  await f.frame();
  assert.equal(f.batches.length, 2);
});

test('a rejected refresh reports its error and does not strand subsequent edits', async () => {
  const error = new Error('renderer unavailable');
  const f = fixture(async () => { throw error; });
  f.queue.invalidateAll();
  await f.frame();
  assert.deepEqual(f.errors, [error]);
  f.queue.invalidatePage(0, true);
  await f.frame();
  assert.equal(f.batches.length, 2);
});

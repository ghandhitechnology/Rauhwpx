import assert from 'node:assert/strict';
import test from 'node:test';
import { withPaginationBatch } from '../src/core/pagination-batch.ts';

test('nested synchronous edits share one engine batch and return the inner result', () => {
  const calls: string[] = [];
  const doc = { beginBatch() { calls.push('begin'); }, endBatch() { calls.push('end'); } };
  assert.equal(withPaginationBatch(doc, () => withPaginationBatch(doc, () => {
    calls.push('edit');
    return 42;
  })), 42);
  assert.deepEqual(calls, ['begin', 'edit', 'end']);
});

test('failed edits close their batch before rollback and do not strand later edits', () => {
  const calls: string[] = [];
  const doc = { beginBatch() { calls.push('begin'); }, endBatch() { calls.push('end'); } };
  const failure = new Error('edit failed');
  assert.throws(() => {
    try {
      withPaginationBatch(doc, () => { throw failure; });
    } catch (error) {
      calls.push('rollback');
      throw error;
    }
  }, (error) => error === failure);
  withPaginationBatch(doc, () => calls.push('next'));
  assert.deepEqual(calls, ['begin', 'end', 'rollback', 'begin', 'next', 'end']);
});

test('older bundles without both batch methods use the original edit path', () => {
  for (const doc of [{}, { beginBatch() { assert.fail('must not open an uncloseable batch'); } },
    { endBatch() { assert.fail('must not close a batch that was never opened'); } }]) {
    assert.equal(withPaginationBatch(doc, () => 42), 42);
  }
});

test('failed begin does not run edits, and failed end does not retain nesting state', () => {
  const failure = new Error('engine failed');
  const doc = {
    beginBatch() { throw failure; },
    endBatch() { assert.fail('begin failed'); },
  };
  assert.throws(() => withPaginationBatch(doc, () => assert.fail('begin failed')), (error) => error === failure);
  let begins = 0;
  doc.beginBatch = () => { begins++; };
  doc.endBatch = () => { throw failure; };
  assert.throws(() => withPaginationBatch(doc, () => 1), (error) => error === failure);
  doc.endBatch = () => {};
  assert.equal(withPaginationBatch(doc, () => 2), 2);
  assert.equal(begins, 2);
});

test('body batching requires a positive current-engine single-column guard', async () => {
  const { withBodyTextPaginationBatch } = await import('../src/core/pagination-batch.ts');
  const calls: string[] = [];
  const doc = {
    beginBatch() { calls.push('begin'); }, endBatch() { calls.push('end'); },
    canBatchBodyText: undefined as ((sectionIdx: number) => boolean) | undefined,
  };
  withBodyTextPaginationBatch(doc, 2, () => calls.push('old-bundle'));
  doc.canBatchBodyText = (sectionIdx) => { assert.equal(sectionIdx, 2); return false; };
  withBodyTextPaginationBatch(doc, 2, () => calls.push('multicolumn'));
  doc.canBatchBodyText = () => true;
  withBodyTextPaginationBatch(doc, 2, () => calls.push('single-column'));
  assert.deepEqual(calls, ['old-bundle', 'multicolumn', 'begin', 'single-column', 'end']);
});

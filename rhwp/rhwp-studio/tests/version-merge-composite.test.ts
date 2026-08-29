import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commitCompositeMerge,
  reconcileCompositeEditor,
  reconcileCompositeHistoryTransition,
} from '../src/versioning/composite-merge.ts';

test('composite merge applies reversible editor state before committing refs', async () => {
  const calls: string[] = [];
  const result = await commitCompositeMerge({
    applyEditor: () => { calls.push('editor'); },
    commitRefs: async () => { calls.push('refs'); return 'committed'; },
    rollbackEditor: () => { calls.push('rollback'); },
  });
  assert.equal(result, 'committed');
  assert.deepEqual(calls, ['editor', 'refs']);
});

test('ref transaction failure restores editor before surfacing the failure', async () => {
  const calls: string[] = [];
  const failure = new Error('injected store failure');
  await assert.rejects(
    commitCompositeMerge({
      applyEditor: () => { calls.push('editor'); },
      commitRefs: async () => { calls.push('refs'); throw failure; },
      rollbackEditor: () => { calls.push('rollback'); },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ['editor', 'refs', 'rollback']);
});

test('editor apply failure never touches durable refs', async () => {
  let refsCalled = false;
  await assert.rejects(
    commitCompositeMerge({
      applyEditor: () => { throw new Error('injected editor failure'); },
      commitRefs: async () => { refsCalled = true; },
      rollbackEditor: () => undefined,
    }),
    /injected editor failure/,
  );
  assert.equal(refsCalled, false);
});

test('double failure is explicit and retains both causes', async () => {
  const storeFailure = new Error('store');
  const editorFailure = new Error('editor rollback');
  await assert.rejects(
    commitCompositeMerge({
      applyEditor: () => undefined,
      commitRefs: async () => { throw storeFailure; },
      rollbackEditor: () => { throw editorFailure; },
    }),
    (error) => error instanceof AggregateError
      && error.errors[0] === storeFailure
      && error.errors[1] === editorFailure,
  );
});

test('silent Undo mismatch uses exact fallback and makes it non-undoable', () => {
  let document = 'merged';
  const calls: string[] = [];
  reconcileCompositeEditor({
    undoAppliedMerge: () => { calls.push('undo-no-op'); },
    discardMergeRedo: () => { calls.push('discard-redo'); },
    matchesExpectedDocument: () => document === 'original',
    replaceWithExpectedDocument: () => { calls.push('replace'); document = 'original'; },
    discardFallbackUndo: () => { calls.push('discard-fallback-undo'); },
  });
  assert.equal(document, 'original');
  assert.deepEqual(calls, ['undo-no-op', 'discard-redo', 'replace', 'discard-fallback-undo']);
});

test('failed exact fallback is surfaced and never reported as reconciled', () => {
  assert.throws(
    () => reconcileCompositeEditor({
      undoAppliedMerge: () => { throw new Error('snapshot missing'); },
      discardMergeRedo: () => undefined,
      matchesExpectedDocument: () => false,
      replaceWithExpectedDocument: () => undefined,
      discardFallbackUndo: () => assert.fail('invalid fallback must not be accepted into history'),
    }),
    (error) => error instanceof AggregateError
      && (error.errors[0] as Error).message === 'snapshot missing'
      && (error.errors[1] as Error).message.includes('fallback replacement'),
  );
});

test('failed ref transition restores the document from history without fallback', () => {
  let document = 'pre-merge';
  const calls: string[] = [];
  reconcileCompositeHistoryTransition({
    restoreFromHistory: () => { calls.push('redo'); document = 'merged'; },
    matchesExpectedDocument: () => document === 'merged',
    replaceWithExpectedDocument: () => assert.fail('valid history compensation must be retained'),
    discardFallbackUndo: () => assert.fail('no fallback entry exists'),
  });
  assert.equal(document, 'merged');
  assert.deepEqual(calls, ['redo']);
});

test('failed history compensation falls back to exact bytes and drops its Undo entry', () => {
  let document = 'merged';
  const calls: string[] = [];
  reconcileCompositeHistoryTransition({
    restoreFromHistory: () => { throw new Error('redo snapshot missing'); },
    matchesExpectedDocument: () => document === 'pre-merge',
    replaceWithExpectedDocument: () => { calls.push('replace'); document = 'pre-merge'; },
    discardFallbackUndo: () => { calls.push('discard-fallback-undo'); },
  });
  assert.equal(document, 'pre-merge');
  assert.deepEqual(calls, ['replace', 'discard-fallback-undo']);
});

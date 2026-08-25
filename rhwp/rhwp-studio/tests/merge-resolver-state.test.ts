import assert from 'node:assert/strict';
import test from 'node:test';

import { MergeResolverState } from '../src/merge/resolver-state.ts';
import type { MergeConflict } from '../src/versioning/types.ts';

function conflict(id: string, supportsBoth = false): MergeConflict {
  return {
    id,
    kind: 'text',
    path: ['sections', '0', 'paragraphs', id, 'text'],
    reason: supportsBoth ? 'concurrent-insertion' : 'same-field-changed',
    base: 'base',
    current: 'current',
    incoming: 'incoming',
    supportsBoth,
    fingerprint: `fingerprint:${id}`,
  };
}

test('conflicts start unresolved and bulk resolution is one local undo step', () => {
  const state = new MergeResolverState([conflict('a'), conflict('b')]);
  assert.equal(state.unresolvedCount, 2);
  assert.equal(state.resolveMany(['a', 'b'], { kind: 'incoming' }), 2);
  assert.equal(state.unresolvedCount, 0);
  assert.deepEqual(state.undo()?.ids, ['a', 'b']);
  assert.equal(state.unresolvedCount, 2);
  assert.deepEqual(state.redo()?.ids, ['a', 'b']);
  assert.equal(state.unresolvedCount, 0);
});

test('keep both is rejected for structurally ineligible conflicts', () => {
  const state = new MergeResolverState([conflict('atomic'), conflict('insert', true)]);
  assert.equal(state.resolveMany(['atomic', 'insert'], { kind: 'both', order: 'current-first' }), 1);
  assert.equal(state.get('atomic'), undefined);
  assert.deepEqual(state.get('insert'), { kind: 'both', order: 'current-first' });
});

test('manual values are rejected and stale draft values dropped for atomic conflicts', () => {
  const atomic: MergeConflict = {
    ...conflict('atomic'),
    kind: 'unknown-control',
    supportsManual: false,
  };
  const state = new MergeResolverState([atomic], {
    atomic: { kind: 'manual', payload: { kind: 'hash', hash: 'stale' } },
  });
  assert.equal(state.unresolvedCount, 1);
  assert.equal(state.get('atomic'), undefined);
  assert.equal(state.resolve('atomic', { kind: 'manual', payload: { kind: 'hash', hash: 'new' } }), false);
  assert.equal(state.resolve('atomic', { kind: 'incoming' }), true);

  const staleHistory = new MergeResolverState([atomic], {}, [{
    groupId: 'stale-manual',
    conflictId: 'atomic',
    before: null,
    after: { kind: 'manual', payload: { kind: 'hash', hash: 'stale' } },
  }], 0);
  assert.equal(staleHistory.canRedo, false);
});

test('draft history and history cursor are resumable', () => {
  const conflicts = [conflict('a')];
  const first = new MergeResolverState(conflicts);
  first.resolve('a', { kind: 'manual', payload: { text: 'combined' } });
  const persisted = first.toPersistedHistory();
  const resumed = new MergeResolverState(conflicts, first.toRecord(), persisted.history, persisted.historyIndex);
  assert.equal(resumed.canUndo, true);
  resumed.undo();
  assert.equal(resumed.unresolvedCount, 1);
  resumed.redo();
  assert.deepEqual(resumed.get('a'), { kind: 'manual', payload: { text: 'combined' } });
});

test('resumed bulk resolution remains one grouped undo and redo step', () => {
  const conflicts = [conflict('a'), conflict('b'), conflict('c')];
  const first = new MergeResolverState(conflicts);
  first.resolveMany(['a', 'b', 'c'], { kind: 'current' });
  const persisted = first.toPersistedHistory();
  assert.equal(new Set(persisted.history.map((entry) => entry.groupId)).size, 1);

  const resumed = new MergeResolverState(conflicts, first.toRecord(), persisted.history, persisted.historyIndex);
  assert.deepEqual(resumed.undo()?.ids, ['a', 'b', 'c']);
  assert.equal(resumed.unresolvedCount, 3);
  assert.deepEqual(resumed.redo()?.ids, ['a', 'b', 'c']);
  assert.equal(resumed.unresolvedCount, 0);

  resumed.undo();
  const undone = resumed.toPersistedHistory();
  const resumedUndone = new MergeResolverState(conflicts, resumed.toRecord(), undone.history, undone.historyIndex);
  assert.equal(resumedUndone.unresolvedCount, 3);
  assert.deepEqual(resumedUndone.redo()?.ids, ['a', 'b', 'c']);
  assert.equal(resumedUndone.unresolvedCount, 0);
});

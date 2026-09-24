import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnChanges } from '../src/ui/agent-sidebar/turn-changes.ts';
import type { PendingChangeSet } from '../src/agent/types.ts';
function changeSet(id = 'turn'): PendingChangeSet {
  return { id, agent: 'codex', status: 'awaiting-review', createdAt: 1,
    ops: ['one', 'two'].map((id) => ({ id, kind: 'insert', agent: 'codex', text: id,
      range: { sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 3 } })) };
}
test('finalized operations survive immediate approval without retaining mutable pending state', () => {
  const turns = new TurnChanges();
  const set = changeSet();
  turns.capture({ type: 'set-finalized', changeSetId: set.id }, [set], 'thread', 'doc', null);
  set.ops[0].id = 'mutated';
  const entry = {};
  turns.capture({ type: 'approved', changeSetId: set.id }, [], 'thread', 'doc', entry);
  assert.deepEqual(turns.get('thread', 'doc')?.set.ops.map((op) => op.id), ['one', 'two']);
  assert.equal(turns.get('thread', 'doc')?.undoEntry, entry);
  assert.equal(turns.get('thread', 'other-doc'), undefined);
  assert.equal(turns.get('other-thread', 'doc'), undefined);
});
test('drift removes only affected operations from the owning set before approval', () => {
  const turns = new TurnChanges();
  turns.capture({ type: 'set-finalized', changeSetId: 'turn' }, [changeSet()], 'a', 'doc', null);
  turns.capture({ type: 'set-finalized', changeSetId: 'other' }, [changeSet('other')], 'b', 'doc', null);
  turns.capture({ type: 'invalidated', reason: 'text drift (1 ops skipped)', changeSetId: 'turn', droppedOpIds: ['one'] }, [], 'a', 'doc', null);
  turns.capture({ type: 'approved', changeSetId: 'turn' }, [], 'a', 'doc', {});
  assert.deepEqual(turns.get('a', 'doc')?.set.ops.map((op) => op.id), ['two']);
  assert.equal(turns.get('b', 'doc')?.set.ops.length, 2);
});
test('rejection, all-drift, and document replacement remove stale turn records', () => {
  const turns = new TurnChanges();
  const capture = () => turns.capture({ type: 'set-finalized', changeSetId: 'turn' }, [changeSet()], 'a', 'doc', null);
  capture();
  turns.capture({ type: 'rejected', changeSetId: 'turn' }, [], 'a', 'doc', null);
  assert.equal(turns.get('a', 'doc'), undefined);
  capture();
  turns.capture({ type: 'invalidated', reason: 'text drift (2 ops skipped)', changeSetId: 'turn', droppedOpIds: ['one', 'two'] }, [], 'a', 'doc', null);
  turns.capture({ type: 'approved', changeSetId: 'turn' }, [], 'a', 'doc', {});
  assert.equal(turns.get('a', 'doc'), undefined);
  capture(); turns.clear();
  assert.equal(turns.get('a', 'doc'), undefined);
});

test('a new turn clears only that thread, including a turn that makes no edits', () => {
  const turns = new TurnChanges();
  for (const owner of ['a', 'b']) {
    turns.capture({ type: 'set-finalized', changeSetId: owner }, [changeSet(owner)], owner, 'doc', null);
  }
  turns.begin('a');
  assert.equal(turns.get('a', 'doc'), undefined);
  assert.equal(turns.get('b', 'doc')?.set.id, 'b');
});

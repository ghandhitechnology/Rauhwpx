import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizePendingDiffs } from '../src/ui/agent-sidebar/pending-diff-summary.ts';
import type { PendingChangeSet, PendingOp } from '../src/agent/types.ts';

function changeSet(ops: PendingOp[]): PendingChangeSet {
  return { id: 'set-1', agent: 'claude', status: 'awaiting-review', createdAt: 1, ops };
}

const range = {
  sectionIdx: 0,
  startParaIdx: 0,
  startCharOffset: 0,
  endParaIdx: 0,
  endCharOffset: 0,
};

test('pending diff summary counts insertions, deletions, and replacement sides', () => {
  const summary = summarizePendingDiffs([changeSet([
    { kind: 'insert', id: 'i', agent: 'claude', range, text: '가😀' },
    {
      kind: 'replace', id: 'd', agent: 'claude', range,
      text: '', deletedText: '나다', charShapeId: null, paraShapeIds: [], snapshotId: null,
    },
    {
      kind: 'replace', id: 'r', agent: 'claude', range,
      text: '새 문장', deletedText: 'old', charShapeId: null,
      paraShapeIds: [], snapshotId: null,
    },
    { kind: 'field', id: 'f', agent: 'claude', name: 'name', oldValue: 'A', newValue: 'BC' },
  ])]);

  assert.deepEqual(summary, { additions: 8, deletions: 6, nonTextChanges: 0, opCount: 4 });
});

test('formatting and object edits remain visible as non-text changes', () => {
  const summary = summarizePendingDiffs([changeSet([
    { kind: 'format', id: 'f', agent: 'codex', range, format: {}, inverse: {} },
    {
      kind: 'object', id: 'o', agent: 'codex',
      obj: {
        type: 'createTable', sectionIdx: 0, paraIdx: 0, charOffset: 0,
        rows: 1, cols: 1, headerRow: false, headerBold: false,
      },
    },
  ])]);

  assert.equal(summary.opCount, 2);
  assert.equal(summary.nonTextChanges, 2);
  assert.equal(summary.additions, 0);
  assert.equal(summary.deletions, 0);
});

test('object removals count their captured text as deletions', () => {
  const summary = summarizePendingDiffs([changeSet([
    {
      kind: 'object', id: 'r', agent: 'codex',
      obj: {
        type: 'tableStructure', sectionIdx: 0, tableParaIdx: 1, controlIdx: 0,
        op: 'delete_row', rowIdx: 1, removedText: 'a | b',
      },
    },
    {
      kind: 'object', id: 'm', agent: 'codex',
      obj: {
        type: 'setCellProps', sectionIdx: 0, tableParaIdx: 1, controlIdx: 0,
        cellIdx: 0, props: {}, dims: { rowCount: 2, colCount: 2 },
      },
    },
  ])]);

  assert.equal(summary.opCount, 2);
  assert.equal(summary.nonTextChanges, 2);
  assert.equal(summary.deletions, 5);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PreparedSnapshotCommand } from '../src/engine/prepared-snapshot-command.ts';

const pendingSrc = readFileSync(new URL('../src/agent/pending-edits.ts', import.meta.url), 'utf8');

test('prepared snapshot command adopts current preview and round-trips snapshots', () => {
  let document = 'preview-with-original-formatting';
  let nextId = 1;
  const snapshots = new Map<number, string>([[1, 'before-agent-change']]);
  const wasm = {
    saveSnapshot: () => {
      const id = ++nextId;
      snapshots.set(id, document);
      return id;
    },
    restoreSnapshot: (id: number) => { document = snapshots.get(id)!; },
    discardSnapshot: (id: number) => { snapshots.delete(id); },
  };
  const pos = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
  const command = new PreparedSnapshotCommand(
    'agentApplyChangeSet', pos, pos, 1,
    () => { document += '+approval-only-delete'; return pos; },
  );

  command.execute(wasm as never);
  assert.equal(document, 'preview-with-original-formatting+approval-only-delete');
  command.undo(wasm as never);
  assert.equal(document, 'before-agent-change');
  command.execute(wasm as never);
  assert.equal(document, 'preview-with-original-formatting+approval-only-delete');
  assert.equal(command.snapshotResourceCount(), 2);
});

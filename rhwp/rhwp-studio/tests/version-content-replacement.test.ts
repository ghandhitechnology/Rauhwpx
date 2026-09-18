import test from 'node:test';
import assert from 'node:assert/strict';
import { CapturedSnapshotCommand } from '../src/engine/captured-snapshot-command.ts';
import type { WasmBridge } from '../src/core/wasm-bridge.ts';

test('captured snapshot callbacks run after their document restore', () => {
  const events: string[] = [];
  const wasm = {
    restoreSnapshot(id: number) { events.push(`restore:${id}`); },
  } as unknown as WasmBridge;
  const command = new CapturedSnapshotCommand(
    'version',
    { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 },
    { sectionIndex: 1, paragraphIndex: 2, charOffset: 3 },
    10,
    20,
    {
      afterUndo() { events.push('branch:old'); },
      afterRedo() { events.push('branch:new'); },
    },
  );

  assert.deepEqual(command.undo(wasm), { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
  assert.deepEqual(command.execute(wasm), { sectionIndex: 1, paragraphIndex: 2, charOffset: 3 });
  assert.deepEqual(events, ['restore:10', 'branch:old', 'restore:20', 'branch:new']);
});

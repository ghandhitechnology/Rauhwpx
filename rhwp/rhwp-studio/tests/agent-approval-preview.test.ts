import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PreparedSnapshotCommand } from '../src/engine/prepared-snapshot-command.ts';

const pendingSrc = readFileSync(new URL('../src/agent/pending-edits.ts', import.meta.url), 'utf8');
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test('agent approval records the rendered preview instead of replaying applied edits', () => {
  const approve = between(pendingSrc, '  approve(changeSetId: string): boolean {', '\n  /** reject');

  assert.match(approve, /previewId = wasm\.saveSnapshot\(\)/, 'capture the exact rendered preview');
  assert.match(approve, /this\.revertAppliedOps\(kept, keepPreviewsOf, userEditSeqNow\)[\s\S]*beforeId = wasm\.saveSnapshot\(\)/,
    'capture undo state after reverting applied pending ops');
  // 전부 드리프트된 경우엔 되돌리지 않는다 — 드리프트 미리보기는 사용자 소유라
  // 지워서 before 를 만들면 undo 가 사용자 글자를 잘라낸다.
  assert.match(approve, /if \(kept\.length > 0\) \{\s*\n\s*this\.revertAppliedOps\(/,
    'only revert when something survived drift detection');
  assert.match(approve, /wasm\.restoreSnapshot\(previewId\)[\s\S]*this\.restorePendingState\(previewState\)/,
    'restore both the document and pending ranges before approval');
  assert.match(approve, /prepareSnapshotCapacity\?\.\(3\)/,
    'reserve the three transient snapshot slots before capturing approval');
  assert.match(approve, /new PreparedSnapshotCommand\(/, 'adopt the prepared before snapshot');
  assert.match(approve, /kind: 'record'/, 'record the already-applied result without a second mutation pass');
  assert.doesNotMatch(approve, /performInsert|replayOps|reapplyOps/,
    'approval must not reconstruct text or formatting from lossy operation metadata');
});

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

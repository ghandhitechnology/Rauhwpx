import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PreparedSnapshotCommand } from '../src/engine/prepared-snapshot-command.ts';

const pendingSrc = readFileSync(new URL('../src/agent/pending-edits.ts', import.meta.url), 'utf8');
const commandSrc = readFileSync(new URL('../src/engine/prepared-snapshot-command.ts', import.meta.url), 'utf8');
const historySrc = readFileSync(new URL('../src/engine/history.ts', import.meta.url), 'utf8');
const overlaySrc = readFileSync(new URL('../src/agent/pending-overlay.ts', import.meta.url), 'utf8');
const overlayCss = readFileSync(new URL('../src/agent/pending-overlay.css', import.meta.url), 'utf8');

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test('agent approval records the rendered preview instead of replaying applied edits', () => {
  const approve = between(pendingSrc, '  approve(changeSetId: string): void {', '\n  /** reject');

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

test('prepared snapshot command restores exact before and after documents for undo/redo', () => {
  const prepared = between(commandSrc, 'export class PreparedSnapshotCommand', '\n}');

  assert.match(prepared, /wasm\.restoreSnapshot\(this\.afterId\)/, 'redo restores the committed document');
  assert.match(prepared, /this\.afterId = wasm\.saveSnapshot\(\)/, 'first execution captures committed output');
  assert.match(prepared, /wasm\.restoreSnapshot\(this\.beforeId\)/, 'undo restores the pre-agent document');
  assert.match(historySrc, /recordWithoutExecute[\s\S]*command\.snapshotResourceCount[\s\S]*enforceSnapshotBudget/,
    'recorded snapshots participate in the history resource budget');
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

test('pending additions and formatting recolor glyphs with model-specific ink', () => {
  assert.match(overlayCss, /\.ag-pending-rect\.ag-claude[\s\S]*--ag-pending-ink:/);
  assert.match(overlayCss, /\.ag-pending-rect\.ag-codex[\s\S]*--ag-pending-ink:/);
  assert.match(overlayCss, /\.ag-pending-ink[\s\S]*mix-blend-mode:\s*screen/,
    'canvas glyphs are recolored without tinting the white page');
  assert.match(overlayCss, /@supports not \(mix-blend-mode: screen\)[\s\S]*\.ag-pending-ink\s*\{\s*display:\s*none/,
    'unsupported blending hides the ink instead of obscuring the document');
  assert.match(overlayCss, /\.ag-pending-marker\.ag-insert[\s\S]*box-shadow:/,
    'inserted whitespace remains visibly marked');
  assert.match(overlayCss, /\.ag-pending-marker\.ag-format[\s\S]*box-shadow:/,
    'format-only edits remain identifiable even when glyph color is unchanged');
  assert.match(overlaySrc, /scrollContent\.appendChild\(node\.ink\)/,
    'ink rectangles must blend as direct canvas siblings, outside the marker stacking context');
  assert.match(overlaySrc, /markerLayer\.appendChild\(node\.marker\)/,
    'review markers render separately from the blended ink');
});

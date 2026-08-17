import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const pending = readFileSync(new URL('../src/agent/pending-edits.ts', import.meta.url), 'utf8');

test('successful turns auto-commit semantic edits and failed turns roll them back', () => {
  assert.match(pending, /endTurn\(outcome: 'review' \| 'commit' \| 'reject'/);
  assert.match(pending, /if \(!this\.approve\(set\.id\)\) this\.reject\(set\.id\)/);
  assert.match(pending, /else if \(outcome === 'reject'\) this\.reject\(set\.id\)/);
  assert.match(bridge, /this\.turnHadError = true/);
  assert.match(bridge, /event\.stopReason === 'completed'/);
  assert.match(bridge, /endPendingTurn\(succeeded \? 'commit' : 'reject'\)/);
});

test('raw engine edits reject mixed staged writes before mutation', () => {
  const executor = readFileSync(new URL('../src/agent/tool-executor.ts', import.meta.url), 'utf8');
  assert.match(executor, /if \(this\.deps\.pending\.hasPending\(\)\)/);
  assert.match(executor, /PENDING_SEMANTIC_EDITS/);
  assert.match(executor, /MIXED_ENGINE_WRITE_MODE/);
  assert.match(executor, /applyEngineEdits\(this\.deps\.inputHandler, operations\)/);
});

test('raw snapshot failures preserve history and post-commit refresh cannot trigger a retry', () => {
  const input = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
  assert.match(input, /if \(!this\.history\.hasSnapshotCapacity\(2\)\)/);
  assert.doesNotMatch(
    input.match(/executeAppliedSnapshot[\s\S]*?\n  \}/)?.[0] ?? '',
    /prepareSnapshotCapacity/,
  );
  assert.match(input, /History recording is the commit point/);
  assert.match(input, /committed autonomous edit refresh failed/);
});

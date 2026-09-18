import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const pending = readFileSync(new URL('../src/agent/pending-edits.ts', import.meta.url), 'utf8');

test('successful turns route by permission profile and failed turns roll back', () => {
  assert.match(pending, /endTurn\(outcome: 'review' \| 'commit' \| 'reject'/);
  assert.match(pending, /if \(!this\.approve\(set\.id\)\) this\.reject\(set\.id\)/);
  assert.match(pending, /else if \(outcome === 'reject'\) this\.reject\(set\.id\)/);
  assert.match(bridge, /this\.turnHadError = true/);
  assert.match(bridge, /event\.stopReason === 'completed'/);
  // 안전 = 검토 대기, 전체 = 자동 커밋; 실패는 양쪽 다 롤백.
  assert.match(bridge, /this\.permissionProfile === 'safe' \? 'review' : 'commit'/);
  assert.match(bridge, /endPendingTurn\(succeeded \? this\.successfulTurnOutcome\(\) : 'reject'\)/);
  // 결과 불명(재연결) 기본값: 안전은 검토 대기로 남긴다.
  assert.match(bridge, /this\.permissionProfile === 'safe' \? 'review' : 'reject'/);
});

test('raw engine edits reject mixed staged writes before mutation', () => {
  const executor = readFileSync(new URL('../src/agent/tool-executor.ts', import.meta.url), 'utf8');
  assert.match(executor, /if \(this\.deps\.pending\.hasPending\(\)\)/);
  assert.match(executor, /PENDING_SEMANTIC_EDITS/);
  assert.match(executor, /MIXED_ENGINE_WRITE_MODE/);
  assert.match(executor, /applyEngineEdits\(this\.deps\.inputHandler, operations\)/);
});

test('safe profile blocks raw engine writes and gates saving on pending review', () => {
  const executor = readFileSync(new URL('../src/agent/tool-executor.ts', import.meta.url), 'utf8');
  assert.match(executor, /SAFE_MODE_RAW_ENGINE/);
  assert.match(executor, /permissionProfile === 'safe' && RAW_ENGINE_WRITE_TOOLS\.has\(tool\)/);
  assert.match(bridge, /permissionProfile: this\.permissionProfile,\n\s+template: readDocumentTemplate/);
  const file = readFileSync(new URL('../src/command/commands/file.ts', import.meta.url), 'utf8');
  assert.match(file, /resolvePendingAgentEditsBeforeSave/);
  assert.match(file, /showPendingAgentEditsDialog/);
});

test('raw snapshot failures preserve history and post-commit refresh cannot trigger a retry', () => {
  const input = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
  assert.match(input, /if \(this\.editMode === 'form'\)[\s\S]*if \(!this\.history\.hasSnapshotCapacity\(2\)\)/);
  assert.doesNotMatch(
    input.match(/executeAppliedSnapshot[\s\S]*?\n  \}/)?.[0] ?? '',
    /prepareSnapshotCapacity/,
  );
  assert.match(input, /History recording is the commit point/);
  assert.match(input, /committed autonomous edit refresh failed/);
});

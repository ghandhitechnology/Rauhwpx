import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const pending = readFileSync(new URL('../src/agent/pending-edits.ts', import.meta.url), 'utf8');

test('successful turns route by permission profile and stopped turns hold edits for review', () => {
  assert.match(pending, /endTurn\(outcome: 'review' \| 'commit' = 'review', opts: \{ turnStopped\?: boolean \}/);
  assert.match(pending, /if \(opts\.turnStopped\) set\.turnStopped = true/);
  assert.match(pending, /if \(outcome === 'commit' && !this\.approve\(set\.id\)\) this\.reject\(set\.id\)/);
  // 비성공 종료로 가는 'reject' 경로는 없다 — 되돌림은 사용자의 reject() 뿐이다.
  assert.doesNotMatch(pending, /outcome === 'reject'/);
  assert.match(bridge, /this\.turnHadError = true/);
  // 안전 = 검토 대기, 전체 = 자동 커밋은 성공 턴뿐; 비성공은 양쪽 다 검토 대기.
  assert.match(bridge, /outcome: succeeded && permissionProfile === 'unrestricted' \? 'commit' : 'review'/);
  assert.match(bridge, /this\.endPendingTurn\(disposition\.outcome, !succeeded\)/);
  // 결과 불명(재연결·시작 실패) 기본값도 어느 모드에서나 검토 대기 + 중단 표시.
  assert.match(bridge, /outcome: 'commit' \| 'review' = 'review',/);
  assert.match(bridge, /turnStopped = true,/);
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

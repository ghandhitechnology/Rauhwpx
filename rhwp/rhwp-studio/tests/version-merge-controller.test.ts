import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const controller = readFileSync(join(root, 'src/versioning/controller.ts'), 'utf8');
const manager = readFileSync(join(root, 'src/ui/agent-sidebar/version-manager.ts'), 'utf8');
const sidebar = readFileSync(join(root, 'src/ui/agent-sidebar/index.ts'), 'utf8');

function method(start: string, end: string): string {
  const from = controller.indexOf(start);
  const to = controller.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `${start} must exist`);
  assert.notEqual(to, -1, `${end} must exist after ${start}`);
  return controller.slice(from, to);
}

test('merge entry checkpoints dirty current work before reading graph relation', () => {
  const start = method('async startMerge(', 'async resumeMerge(');
  assert.ok(start.indexOf("#checkpointDirty('pre-merge')") < start.indexOf('#openMergeResolver('));
  const open = method('async #openMergeResolver(', '#setMergeResolverLock(');
  assert.match(open, /getMergeRelation\(/);
  assert.match(open, /이미 병합된 브랜치입니다\./);
  assert.match(open, /synthesizeVirtualBaseDocument\(/);
  assert.match(open, /analyzeDocument\(/);
  assert.match(open, /materializeDocument\(/);
  assert.match(open, /ensureFullMergeManifest\(/);
});

test('stale draft recomputation carries only fingerprint-identical resolutions', () => {
  const open = method('async #openMergeResolver(', '#setMergeResolverLock(');
  assert.match(open, /priorByFingerprint/);
  assert.match(open, /conflict\.fingerprint/);
  assert.match(open, /analysis\.conflicts\.flatMap/);
  assert.match(open, /currentHead: targetBranch\.target/);
  assert.match(open, /sourceHead: sourceBranch\.target/);
});

test('resolver locks editing, agent turns, branch operations, and version mutations', () => {
  const lock = method('#setMergeResolverLock(', 'async #completeMerge(');
  assert.match(lock, /isReadOnly\(\)/);
  assert.match(lock, /setReadOnly\(true\)/);
  assert.match(lock, /setReadOnly\(this\.#mergePreviousReadOnly\)/);
  assert.match(lock, /merge-resolver-lock-changed/);
  const guard = method('async #guardMutation(', 'async #openMergeResolver(');
  assert.match(guard, /#mergeResolverActive/);
  assert.match(sidebar, /mergeResolverLocked/);
  assert.match(sidebar, /병합 검토 중에는 에이전트 작업을 시작할 수 없습니다/);
});

test('completion uses atomic store operations and composite ref compensation', () => {
  const complete = method('async #completeMerge(', 'async #validateMergeDocument(');
  assert.ok(
    complete.indexOf('putMergeDraft({') < complete.indexOf('completeFastForwardMerge({'),
    'resolver-local conflict resolutions must be persisted before store completion validates the draft',
  );
  assert.match(complete, /expectedUpdatedAt: persistedDraft\.updatedAt/);
  assert.match(complete, /completeFastForwardMerge\(/);
  assert.match(complete, /completeMergeCheckpoint\(/);
  assert.match(complete, /parents|baseCommitIds/);
  assert.match(complete, /afterUndo/);
  assert.match(complete, /afterRedo/);
  assert.match(complete, /restoreCompositeRefs\(/);
  assert.match(complete, /performRedo\((?:true)?\)/);
  assert.match(complete, /performUndo\((?:true)?\)/);
});

test('merged bytes must parse, export, reload and retain the canonical fingerprint', () => {
  const validate = method('async #validateMergeDocument(', 'async #flushDeferredSave(');
  assert.equal((validate.match(/loadDocument\(/g) ?? []).length, 2);
  assert.equal((validate.match(/captureVersionSnapshot\(/g) ?? []).length, 2);
  assert.match(validate, /captured\.fingerprint !== reloaded\.fingerprint/);
  assert.match(validate, /getValidationWarnings\(\)/);
});

test('both merge entry points always show source to current direction', () => {
  assert.match(manager, /merge\.dataset\.versionAction = 'merge'/);
  assert.match(manager, /controller\.startMerge\(branch\.name\)/);
  assert.match(manager, /mergeButton\.setAttribute\('aria-label', mergeDirection\)/);
  assert.match(manager, /mergeButton\.textContent = `… → \$\{targetBranch\}`/);
  assert.match(manager, /→ \$\{current\.activeBranch/);
  assert.match(manager, /const mergeDirection = `\$\{branch\.name\} → \$\{current\.activeBranch/);
});

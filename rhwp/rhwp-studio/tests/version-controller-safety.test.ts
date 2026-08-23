import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const controller = readFileSync(join(rootDir, 'src/versioning/controller.ts'), 'utf8');
const snapshots = readFileSync(join(rootDir, 'src/versioning/snapshot.ts'), 'utf8');

function method(start: string, end: string): string {
  const from = controller.indexOf(start);
  const to = controller.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `${start} must exist`);
  assert.notEqual(to, -1, `${end} must exist after ${start}`);
  return controller.slice(from, to);
}

test('one semantic analysis supplies both checkpoint stats and the AI title summary', () => {
  const analysisStart = snapshots.indexOf('export function analyzeVersionDiff(');
  const analysisEnd = snapshots.indexOf('export function calculateVersionStats(', analysisStart);
  const analysis = snapshots.slice(analysisStart, analysisEnd);
  assert.equal((analysis.match(/compareSnapshots\(/g) ?? []).length, 1);
  assert.match(analysis, /return \{ stats, titleSummary: \{ totals, items \} \}/);

  const checkpoint = method('async #createCheckpoint(', 'async #checkpointDirty(');
  assert.equal((checkpoint.match(/analyzeVersionDiff\(/g) ?? []).length, 1);
  assert.match(checkpoint, /stats: analysis\.stats/);
  assert.match(checkpoint, /analysis\.titleSummary/);
});

test('workspace tokens bind async content reads and compares to one document revision', () => {
  const token = method('#captureWorkspaceToken(): WorkspaceToken {', '#assertWorkspaceToken(');
  assert.match(token, /documentId: id/);
  assert.match(token, /editorRevision: this\.#editorRevision/);
  assert.match(token, /repositoryRevision: this\.#repository\?\.revision/);

  const compare = method('async compare(id: string)', 'async amendTitle(');
  assert.match(compare, /await this\.#enqueue\(async \(\) => \{/);
  assert.match(compare, /const workspace = this\.#captureWorkspaceToken\(\)/);
  assert.ok(compare.indexOf('#assertWorkspaceToken(workspace)') > compare.indexOf('Promise.all'));
  assert.ok(compare.lastIndexOf('#assertWorkspaceToken(workspace)') < compare.indexOf('#compareWindow.show'));
});

test('versioning cannot adopt an unsaved document as its disk baseline', () => {
  const enable = method('async enable(): Promise<void>', 'async checkpoint(');
  assert.match(enable, /if \(this\.#documentState\.isDirty\(\)\) \{/);
  assert.match(enable, /new VersionError\('SAVE_REQUIRED'/);
  assert.ok(enable.indexOf('documentState.isDirty()') < enable.indexOf('createRepository({'));
});

test('legacy and graph comparisons serialize through the localized controller queue', () => {
  const graph = method('async compare(id: string)', 'async amendTitle(');
  const legacy = method('async compareLegacy(id: string)', 'setAiTitlesEnabled(');
  assert.match(graph, /await this\.#enqueue\(/);
  assert.match(legacy, /await this\.#enqueue\(/);
});

test('restore and adopt roll back only failed, uncommitted replacements', () => {
  for (const [start, end] of [
    ['async restore(id: string)', 'async adopt(id: string)'],
    ['async adopt(id: string)', 'async compare(id: string)'],
  ] as const) {
    const source = method(start, end);
    assert.match(source, /const original = captureVersionSnapshot\(this\.#wasm\)/);
    assert.match(source, /let persisted = false/);
    assert.match(source, /onPersisted: \(\) => \{ persisted = true; \}/);
    assert.match(source, /if \(!persisted\) this\.#rollbackReplacement/);
  }

  const rollback = method('#rollbackReplacement(\n    handler:', '#setActiveBranch(');
  assert.match(rollback, /#assertWorkspaceToken\(replacementWorkspace, \{ repository: false \}\)/);
  assert.match(rollback, /handler\.performUndo\(\)/);
  assert.match(rollback, /handler\.replaceContentFromBytes\(original\.bytes\)/);
});

test('shelves use HEAD divergence and protect current work before applying', () => {
  const create = method('async createShelf(', 'async applyShelf(');
  assert.match(create, /capture\.fingerprint === head\.contentFingerprint/);
  assert.doesNotMatch(create, /documentState\.isDirty\(\)/);
  assert.match(create, /deleteShelf\(/);

  const apply = method('async applyShelf(', 'async deleteShelf(');
  assert.ok(apply.indexOf("#checkpointDirty('pre-restore')") < apply.indexOf('replaceContentFromBytes'));
  assert.match(apply, /if \(!persisted\) this\.#rollbackReplacement/);
});

test('branch transitions defer ref and dirty state callbacks until after history afterEdit', () => {
  const apply = method('#applyBranchContent(\n    handler:', '#rollbackReplacement(\n    handler:');
  assert.match(apply, /afterUndo: \(\) => \{\s*queueMicrotask/);
  assert.match(apply, /afterRedo: \(\) => \{\s*queueMicrotask/);
  assert.match(apply, /version-branch-undo/);
  assert.match(apply, /version-branch-redo/);
});

test('branch switching revalidates cross-controller repository and ref advances before content replacement', () => {
  const switchBranch = method('async switchBranch(name: string)', 'async renameBranch(');
  const validation = switchBranch.indexOf('const [freshRepository, freshNext, freshPrevious]');
  const replacement = switchBranch.indexOf('#applyBranchContent(');
  assert.ok(validation > switchBranch.indexOf('getBlob(target.blobId)'));
  assert.ok(validation < replacement);
  assert.match(switchBranch, /freshRepository\.revision !== repository\.revision/);
  assert.match(switchBranch, /freshNext\.revision !== next\.revision/);
  assert.match(switchBranch, /freshNext\.target !== next\.target/);
  assert.match(switchBranch, /freshPrevious\.revision !== previous\.revision/);
  assert.match(switchBranch, /new VersionError\('STALE_WORKSPACE'/);
});

test('loadMore always releases loading and saves defer safely across an active agent turn', () => {
  const loadMore = method('async loadMore()', 'async restore(');
  assert.match(loadMore, /try \{/);
  assert.match(loadMore, /finally \{/);
  assert.match(loadMore, /this\.#state\.loading = false/);

  const constructor = method('constructor(deps:', 'getState()');
  assert.match(constructor, /if \(this\.#agentBridge\.isTurnRunning\(\)\) \{/);
  assert.match(constructor, /this\.#deferredSavedSnapshot = \{/);
  assert.match(constructor, /workspace,\s*snapshot: captureVersionSnapshot\(this\.#wasm\)/);
  assert.match(constructor, /await this\.#flushDeferredSave\(\)/);

  const flush = method('async #flushDeferredSave()', 'async #refreshData(');
  assert.match(flush, /repository\.id !== deferred\.workspace\.repositoryId/);
  assert.match(flush, /#createCheckpoint\(\{ reason: 'save', lastSaved: true \}, deferred\.snapshot\)/);
});

test('active branch refresh keeps memory before falling back to the repository default', () => {
  const refresh = method('async #refreshData(', 'async #buildState(');
  assert.match(refresh, /const memoryBranch = this\.#activeBranches\.get\(id\)/);
  assert.match(refresh, /branch\.name === repository\.defaultBranch/);
  assert.doesNotMatch(refresh, /branch\.name === 'main'/);
  assert.ok(
    refresh.indexOf('branch.name === memoryBranch')
      < refresh.indexOf('branch.name === repository.defaultBranch'),
  );
});

test('sidebar dirty state is cached against HEAD and full repository usage is reported', () => {
  const semantic = method('async #refreshSemanticDirty(', '#isSemanticDirty(');
  assert.match(semantic, /fingerprintVersionContent\(this\.#wasm\)/);
  assert.match(semantic, /currentFingerprint !== head\.contentFingerprint/);

  const build = method('async #buildState(', '#syncTransientState(');
  assert.match(build, /getRepositoryStorageUsage\(this\.#repository\.id\)/);
  assert.match(build, /dirty: this\.#isSemanticDirty\(\)/);
  assert.match(build, /storageBytes: repositoryUsage\?\.totalBytes \?\? 0/);
});

test('only a controller-owned graph store is closed on dispose', () => {
  const constructor = method('constructor(deps:', 'getState()');
  const dispose = method('dispose(): void', 'async #enqueue');
  assert.match(constructor, /this\.#ownsStore = !deps\.store/);
  assert.match(dispose, /if \(this\.#ownsStore\) void this\.#store\.close\(\)/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { retainedMergeDraftLocalState } from '../src/versioning/merge-draft.ts';
import {
  blobId,
  branchGeneration,
  branchName,
  commitId,
  mergeDraftId,
  repositoryId,
  type BranchRef,
  type VersionMergeDraft,
} from '../src/versioning/types.ts';

const hash = (digit: string) => blobId(`blake3:${digit.repeat(64)}`);
const branch = (name: string, target: string, generation: string, revision = 1): BranchRef => ({
  repositoryId: repositoryId('repository'),
  kind: 'branch',
  name: branchName(name),
  target: commitId(target),
  generation: branchGeneration(generation),
  revision,
});

function draft(target: BranchRef, source: BranchRef): VersionMergeDraft {
  return {
    id: mergeDraftId('draft'),
    repositoryId: target.repositoryId,
    targetBranch: target.name,
    sourceBranch: source.name,
    baseCommitIds: [commitId('base')],
    currentHead: target.target,
    sourceHead: source.target,
    targetBranchRevision: target.revision,
    sourceBranchRevision: source.revision,
    targetBranchGeneration: target.generation,
    sourceBranchGeneration: source.generation,
    mode: 'diverged',
    analysisVersion: 1,
    conflicts: [],
    resolutions: {},
    automaticResult: null,
    manualAssetBlobIds: [hash('a'), hash('b')],
    history: [{ conflictId: 'obsolete', before: null, after: { kind: 'incoming' } }],
    historyIndex: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

test('unchanged draft heads retain resolver-local history and assets', () => {
  const target = branch('main', 'current', 'target-generation');
  const source = branch('source', 'incoming', 'source-generation');
  const previous = draft(target, source);
  assert.deepEqual(retainedMergeDraftLocalState(previous, target, source, {}), {
    manualAssetBlobIds: [hash('a'), hash('b')],
    history: previous.history,
    historyIndex: 1,
  });
});

test('changed heads discard obsolete history and retain only assets in carried resolutions', () => {
  const oldTarget = branch('main', 'old-current', 'target-generation');
  const target = branch('main', 'new-current', 'target-generation', 2);
  const source = branch('source', 'incoming', 'source-generation');
  const previous = draft(oldTarget, source);
  assert.deepEqual(retainedMergeDraftLocalState(previous, target, source, {
    carried: { kind: 'manual', payload: { assetBlobId: hash('b'), value: 'retained' } },
  }), {
    manualAssetBlobIds: [hash('b')],
    history: [],
    historyIndex: 0,
  });
});

test('same branch name/head with a new generation is stale and resets local state', () => {
  const target = branch('main', 'current', 'target-generation');
  const oldSource = branch('source', 'incoming', 'old-source-generation');
  const replacement = branch('source', 'incoming', 'new-source-generation');
  const previous = draft(target, oldSource);
  assert.deepEqual(retainedMergeDraftLocalState(previous, target, replacement, {}), {
    manualAssetBlobIds: [],
    history: [],
    historyIndex: 0,
  });
});

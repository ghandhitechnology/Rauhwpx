import assert from 'node:assert/strict';
import test from 'node:test';

import type { CompareDocumentSnapshot } from '../src/compare/types.ts';
import { fingerprintBytes, hashBytes } from '../src/versioning/hash.ts';
import { VersionGraphStore } from '../src/versioning/store.ts';
import {
  blobId,
  branchName,
  contentFingerprint,
  documentId,
  mergeDraftId,
  tagName,
  VersionError,
} from '../src/versioning/types.ts';
import type { BranchName, CommitId, VersionMergeDraft } from '../src/versioning/types.ts';

function bytes(value: number): Uint8Array {
  return new Uint8Array([value, value + 1, value + 2]);
}

function snapshot(label: string): CompareDocumentSnapshot {
  return {
    meta: { name: label, sectionCount: 1, pageCount: 1 },
    paragraphs: [{
      section: 0,
      paragraph: 0,
      sectionPage: 1,
      globalIndex: 0,
      stableId: `stable-${label}`,
      text: label,
      normalizedText: label,
      controlCount: 0,
      signature: `signature-${label}`,
      isAnchorCandidate: true,
    }],
    controls: [],
  };
}

function payload(value: number, label = `checkpoint-${value}`) {
  const data = bytes(value);
  return {
    bytes: data,
    compareSnapshot: snapshot(label),
    contentFingerprint: fingerprintBytes(data),
    title: label,
    titleRevision: 0,
    titleOrigin: 'manual' as const,
    author: { kind: 'user' as const, label: 'Tester' },
    stats: { added: 1, removed: 0, modified: 0 },
    createdAt: value,
  };
}

async function repository(store = new VersionGraphStore({ indexedDB: null })) {
  const initial = payload(1, 'Initial');
  const created = await store.createRepository({
    documentId: documentId('document-1'),
    lastSavedFingerprint: initial.contentFingerprint,
    enabledAt: 1,
    initial,
  });
  return { store, ...created };
}

function mergeDraft(
  created: Awaited<ReturnType<typeof repository>>,
  source: { name: BranchName; target: CommitId; revision: number },
): VersionMergeDraft {
  return {
    id: mergeDraftId('draft-1'),
    repositoryId: created.repository.id,
    targetBranch: created.branch.name,
    sourceBranch: source.name,
    baseCommitIds: [created.commit.id],
    currentHead: created.branch.target,
    sourceHead: source.target,
    targetBranchRevision: created.branch.revision,
    sourceBranchRevision: source.revision,
    mode: 'diverged',
    analysisVersion: 1,
    conflicts: [],
    resolutions: {},
    automaticResult: null,
    manualAssetBlobIds: [],
    history: [],
    historyIndex: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

test('repository creation atomically writes main, its initial commit, and copied payloads', async () => {
  const initialBytes = bytes(1);
  const initial = payload(1, 'Initial');
  initial.bytes = initialBytes;
  const store = new VersionGraphStore({ indexedDB: null });
  const created = await store.createRepository({
    documentId: documentId('document-copy'),
    lastSavedFingerprint: initial.contentFingerprint,
    initial,
  });
  initialBytes[0] = 99;

  assert.equal(created.repository.revision, 1);
  assert.equal(created.repository.nextOrdinal, 2);
  assert.equal(created.branch.name, 'main');
  assert.equal(created.branch.target, created.commit.id);
  assert.deepEqual((await store.listCommits(created.repository.id)).map((commit) => commit.id), [created.commit.id]);
  assert.deepEqual([...(await store.getBlob(created.commit.blobId))!.bytes], [1, 2, 3]);
  assert.equal((await store.getCompareSnapshot(created.commit.compareSnapshotId))?.snapshot.meta.name, 'Initial');
});

test('checkpoint CAS is atomic and payload hashes deduplicate immutable blobs', async () => {
  const { store, repository: initialRepository, branch: initialBranch, commit: initialCommit } = await repository();
  const duplicate = payload(1, 'Same bytes, new semantic snapshot');
  const created = await store.createCheckpoint({
    repositoryId: initialRepository.id,
    branch: initialBranch.name,
    expectedRepositoryRevision: initialRepository.revision,
    expectedBranchRevision: initialBranch.revision,
    expectedHead: initialCommit.id,
    reason: 'manual',
    ...duplicate,
  });

  assert.equal(created.commit.blobId, initialCommit.blobId);
  assert.notEqual(created.commit.compareSnapshotId, initialCommit.compareSnapshotId);
  assert.equal(created.commit.ordinal, 2);
  assert.deepEqual(created.commit.parents, [initialCommit.id]);

  await assert.rejects(
    store.createCheckpoint({
      repositoryId: initialRepository.id,
      branch: initialBranch.name,
      expectedRepositoryRevision: initialRepository.revision,
      expectedBranchRevision: initialBranch.revision,
      reason: 'manual',
      ...payload(3),
    }),
    (error) => error instanceof VersionError && error.code === 'STALE_WORKSPACE',
  );
  assert.equal((await store.listCommits(initialRepository.id)).length, 2);
});

test('markSaved updates file state without creating a commit and is idempotent', async () => {
  const { store, repository: repo } = await repository();
  const savedFingerprint = fingerprintBytes(bytes(5));
  const updated = await store.markSaved(repo.id, savedFingerprint, repo.revision);
  assert.equal(updated.lastSavedFingerprint, savedFingerprint);
  assert.equal(updated.revision, repo.revision + 1);
  assert.equal((await store.listCommits(repo.id)).length, 1);

  const unchanged = await store.markSaved(repo.id, savedFingerprint, updated.revision);
  assert.equal(unchanged.revision, updated.revision);
});

test('repository storage usage counts unique blobs and comparison snapshots with an explicit bound', async () => {
  const { store, repository: repo, branch } = await repository();
  const sameBytes = payload(1, 'Distinct comparison data');
  const checkpoint = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: branch.name,
    expectedRepositoryRevision: repo.revision,
    expectedBranchRevision: branch.revision,
    reason: 'manual',
    ...sameBytes,
  });
  const firstShelfPayload = payload(8, 'First shelf payload');
  const firstShelf = await store.createShelf({
    repositoryId: repo.id,
    baseCommitId: checkpoint.commit.id,
    branch: checkpoint.branch.name,
    title: 'First shelf',
    expectedRepositoryRevision: checkpoint.repository.revision,
    ...firstShelfPayload,
  });
  const secondShelfPayload = payload(9, 'Second shelf payload');
  await store.createShelf({
    repositoryId: repo.id,
    baseCommitId: checkpoint.commit.id,
    branch: checkpoint.branch.name,
    title: 'Second shelf',
    expectedRepositoryRevision: firstShelf.repository.revision,
    ...secondShelfPayload,
  });

  const exact = await store.getRepositoryStorageUsage(repo.id);
  assert.equal(exact.commitCount, 2);
  assert.equal(exact.shelfCount, 2);
  assert.equal(exact.blobCount, 3);
  assert.equal(exact.blobBytes, 9);
  assert.equal(exact.compareSnapshotCount, 4);
  assert.equal(exact.totalBytes, exact.blobBytes + exact.compareSnapshotBytes);
  assert.equal(exact.commitTruncated, false);
  assert.equal(exact.shelfTruncated, false);
  assert.equal(exact.truncated, false);

  const bounded = await store.getRepositoryStorageUsage(repo.id, { maxCommits: 1, maxShelves: 1 });
  assert.equal(bounded.commitCount, 1);
  assert.equal(bounded.shelfCount, 1);
  assert.equal(bounded.commitTruncated, true);
  assert.equal(bounded.shelfTruncated, true);
  assert.equal(bounded.truncated, true);
});

test('serialized concurrent writes let exactly one stale workspace advance a branch', async () => {
  const { store, repository: repo, branch } = await repository();
  const attempts = await Promise.allSettled([
    store.createCheckpoint({
      repositoryId: repo.id,
      branch: branch.name,
      expectedRepositoryRevision: repo.revision,
      expectedBranchRevision: branch.revision,
      reason: 'manual',
      ...payload(2, 'First contender'),
    }),
    store.createCheckpoint({
      repositoryId: repo.id,
      branch: branch.name,
      expectedRepositoryRevision: repo.revision,
      expectedBranchRevision: branch.revision,
      reason: 'manual',
      ...payload(3, 'Second contender'),
    }),
  ]);

  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  assert.equal((await store.listCommits(repo.id)).length, 2);
});

test('memory fallback preserves concurrent writes to independent repositories', async () => {
  const store = new VersionGraphStore({ indexedDB: null });
  const [first, second] = await Promise.all([
    store.createRepository({
      documentId: documentId('document-concurrent-a'),
      lastSavedFingerprint: payload(1).contentFingerprint,
      initial: payload(1),
    }),
    store.createRepository({
      documentId: documentId('document-concurrent-b'),
      lastSavedFingerprint: payload(2).contentFingerprint,
      initial: payload(2),
    }),
  ]);
  assert.ok(await store.getRepository(first.repository.id));
  assert.ok(await store.getRepository(second.repository.id));
});

test('commit listing pages by descending ordinal', async () => {
  const { store, repository: repo, branch } = await repository();
  const second = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: branch.name,
    expectedRepositoryRevision: repo.revision,
    expectedBranchRevision: branch.revision,
    reason: 'save',
    ...payload(2),
  });
  await store.createCheckpoint({
    repositoryId: repo.id,
    branch: branch.name,
    expectedRepositoryRevision: second.repository.revision,
    expectedBranchRevision: second.branch.revision,
    reason: 'agent',
    ...payload(3),
  });

  const firstPage = await store.listCommits(repo.id, { limit: 2 });
  const secondPage = await store.listCommits(repo.id, { limit: 2, beforeOrdinal: firstPage.at(-1)!.ordinal });
  assert.deepEqual(firstPage.map((commit) => commit.ordinal), [3, 2]);
  assert.deepEqual(secondPage.map((commit) => commit.ordinal), [1]);
  assert.deepEqual(await store.listCommits(repo.id, { beforeOrdinal: 1 }), []);
});

test('branch deletion keeps history until explicit garbage collection', async () => {
  const { store, repository: repo, branch: main, commit: root } = await repository();
  const branched = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('Experiment'),
    target: root.id,
    expectedRepositoryRevision: repo.revision,
  });
  const experimentCommit = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: branched.branch.name,
    expectedRepositoryRevision: branched.repository.revision,
    expectedBranchRevision: branched.branch.revision,
    reason: 'manual',
    ...payload(9, 'Experiment only'),
  });

  const deleted = await store.deleteBranch({
    repositoryId: repo.id,
    branch: branched.branch.name,
    currentBranch: main.name,
    expectedRepositoryRevision: experimentCommit.repository.revision,
    expectedBranchRevision: experimentCommit.branch.revision,
  });

  assert.ok(await store.getCommit(experimentCommit.commit.id));
  assert.ok(await store.getBlob(experimentCommit.commit.blobId));
  const collected = await store.collectGarbage(repo.id, deleted.revision);
  assert.deepEqual(collected.garbageCollected, { commits: 1, blobs: 1, compareSnapshots: 1 });
  assert.equal(await store.getCommit(experimentCommit.commit.id), null);
  assert.equal(await store.getBlob(experimentCommit.commit.blobId), null);
  assert.ok(await store.getCommit(root.id));
});

test('tags and shelves keep history reachable during permanent branch deletion', async () => {
  const { store, repository: repo, branch: main, commit: root } = await repository();
  const branch = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('Kept'),
    target: root.id,
    expectedRepositoryRevision: repo.revision,
  });
  const checkpoint = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: branch.branch.name,
    expectedRepositoryRevision: branch.repository.revision,
    expectedBranchRevision: branch.branch.revision,
    reason: 'manual',
    ...payload(8, 'Tagged version'),
  });
  const tagged = await store.createTag({
    repositoryId: repo.id,
    name: tagName('Milestone'),
    target: checkpoint.commit.id,
    expectedRepositoryRevision: checkpoint.repository.revision,
  });
  const shelfPayload = payload(7, 'Shelf');
  const shelved = await store.createShelf({
    repositoryId: repo.id,
    baseCommitId: checkpoint.commit.id,
    branch: checkpoint.branch.name,
    expectedRepositoryRevision: tagged.repository.revision,
    title: 'Work in progress',
    ...shelfPayload,
  });
  const deleted = await store.deleteBranch({
    repositoryId: repo.id,
    branch: checkpoint.branch.name,
    currentBranch: main.name,
    expectedRepositoryRevision: shelved.repository.revision,
    expectedBranchRevision: checkpoint.branch.revision,
  });

  const collected = await store.collectGarbage(repo.id, deleted.revision);
  assert.deepEqual(collected.garbageCollected, { commits: 0, blobs: 0, compareSnapshots: 0 });
  assert.ok(await store.getCommit(checkpoint.commit.id));
  assert.ok(await store.getShelf(shelved.shelf.id));
});

test('ref names are case-insensitively unique and title amendments use their own revision', async () => {
  const { store, repository: repo, branch, commit } = await repository();
  const created = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('검토 Branch'),
    target: commit.id,
    expectedRepositoryRevision: repo.revision,
  });
  await assert.rejects(
    store.createBranch({
      repositoryId: repo.id,
      name: branchName('검토 branch'),
      target: commit.id,
      expectedRepositoryRevision: created.repository.revision,
    }),
    (error) => error instanceof VersionError && error.code === 'BRANCH_EXISTS',
  );

  const titled = await store.updateCommitTitle({
    repositoryId: repo.id,
    commitId: commit.id,
    expectedTitleRevision: 0,
    title: 'Generated title',
    titleRevision: 0,
    titleOrigin: 'generated',
    generatedBy: { provider: 'codex', model: 'test' },
  });
  assert.equal(titled.titleRevision, 1);
  assert.equal((await store.getRepository(repo.id))?.revision, created.repository.revision);
  await assert.rejects(
    store.updateCommitTitle({
      repositoryId: repo.id,
      commitId: commit.id,
      expectedTitleRevision: 0,
      title: 'Stale title',
      titleRevision: 0,
      titleOrigin: 'manual',
    }),
    (error) => error instanceof VersionError && error.code === 'STALE_WORKSPACE',
  );
  assert.equal((await store.getBranch(repo.id, branch.name))?.target, commit.id);
});

test('branch rename, tag movement, and shelf deletion keep revisions guarded', async () => {
  const { store, repository: repo, branch: main, commit: root } = await repository();
  const branch = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('Draft'),
    target: root.id,
    expectedRepositoryRevision: repo.revision,
  });
  const renamed = await store.renameBranch({
    repositoryId: repo.id,
    branch: branch.branch.name,
    name: branchName('초안 검토'),
    expectedRepositoryRevision: branch.repository.revision,
    expectedBranchRevision: branch.branch.revision,
  });
  assert.equal(await store.getBranch(repo.id, branchName('Draft')), null);
  assert.equal((await store.getBranch(repo.id, renamed.branch.name))?.name, '초안 검토');

  const checkpoint = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: main.name,
    expectedRepositoryRevision: renamed.repository.revision,
    expectedBranchRevision: main.revision,
    reason: 'manual',
    ...payload(6, 'Main update'),
  });
  const tagged = await store.createTag({
    repositoryId: repo.id,
    name: tagName('Release'),
    target: root.id,
    expectedRepositoryRevision: checkpoint.repository.revision,
  });
  const moved = await store.moveTag({
    repositoryId: repo.id,
    tag: tagged.tag.name,
    target: checkpoint.commit.id,
    expectedRepositoryRevision: tagged.repository.revision,
    expectedTagRevision: tagged.tag.revision,
  });
  assert.equal(moved.tag.target, checkpoint.commit.id);
  const afterTagDelete = await store.deleteTag({
    repositoryId: repo.id,
    tag: moved.tag.name,
    expectedRepositoryRevision: moved.repository.revision,
    expectedTagRevision: moved.tag.revision,
  });

  const shelfPayload = payload(10, 'Disposable shelf');
  const shelved = await store.createShelf({
    repositoryId: repo.id,
    baseCommitId: checkpoint.commit.id,
    branch: main.name,
    title: 'Disposable shelf',
    expectedRepositoryRevision: afterTagDelete.revision,
    ...shelfPayload,
  });
  const afterShelfDelete = await store.deleteShelf({
    repositoryId: repo.id,
    shelfId: shelved.shelf.id,
    expectedRepositoryRevision: shelved.repository.revision,
  });
  assert.equal(await store.getShelf(shelved.shelf.id), null);
  assert.equal(afterShelfDelete.revision, shelved.repository.revision + 1);
});

test('the current branch and duplicate merge parents are rejected', async () => {
  const { store, repository: repo, branch, commit } = await repository();
  await assert.rejects(
    store.deleteBranch({
      repositoryId: repo.id,
      branch: branch.name,
      currentBranch: branch.name,
      expectedRepositoryRevision: repo.revision,
      expectedBranchRevision: branch.revision,
    }),
    (error) => error instanceof VersionError && error.code === 'CURRENT_BRANCH',
  );
  await assert.rejects(
    store.createCheckpoint({
      repositoryId: repo.id,
      branch: branch.name,
      expectedRepositoryRevision: repo.revision,
      expectedBranchRevision: branch.revision,
      parents: [commit.id, commit.id],
      reason: 'adopt',
      ...payload(4),
    }),
    (error) => error instanceof VersionError && error.code === 'VERSION_STORE_FAILED',
  );
});

test('caller-supplied hashes are verified before any rows are written', async () => {
  const store = new VersionGraphStore({ indexedDB: null });
  const invalidDigest = `blake3:${'0'.repeat(64)}`;
  await assert.rejects(
    store.createRepository({
      documentId: documentId('invalid-hash'),
      lastSavedFingerprint: contentFingerprint(invalidDigest),
      initial: {
        ...payload(1),
        blobId: blobId(invalidDigest),
      },
    }),
    (error) => error instanceof VersionError && error.code === 'CORRUPT_BLOB',
  );
  assert.equal(await store.findRepositoryByDocumentId(documentId('invalid-hash')), null);
});

test('merge manifests are generated for every checkpoint with parent identity lineage', async () => {
  const { store, repository: repo, branch, commit } = await repository();
  const rootManifest = await store.getMergeManifest(commit.mergeManifestId!);
  assert.ok(rootManifest);
  assert.deepEqual(rootManifest.parentManifestIds, []);

  const next = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: branch.name,
    expectedRepositoryRevision: repo.revision,
    expectedBranchRevision: branch.revision,
    reason: 'pre-merge',
    ...payload(2, 'Pre merge'),
  });
  const manifest = await store.ensureMergeManifest(repo.id, next.commit.id);
  assert.deepEqual(manifest.parentManifestIds, [rootManifest.id]);
  assert.equal((await store.getCommit(next.commit.id))?.mergeManifestId, manifest.id);
});

test('full structural manifests preserve edited identities across insertions and cover non-body nodes', async () => {
  const { store, repository: repo, branch, commit } = await repository();
  const digest = (value: string) => hashBytes(new TextEncoder().encode(value));
  const root = await store.putFullMergeManifest(repo.id, commit.id, [
    { kind: 'document', path: [], propertyHash: digest('document') },
    { kind: 'paragraph', path: ['sections', '0', 'paragraphs', '0'], propertyHash: digest('a'), identityHint: 'para-a' },
    { kind: 'paragraph', path: ['sections', '0', 'paragraphs', '1'], propertyHash: digest('b'), identityHint: 'para-b' },
    { kind: 'cell', path: ['sections', '0', 'paragraphs', '1', 'controls', '0', 'cells', '0'], propertyHash: digest('cell') },
    { kind: 'style', path: ['docInfo', 'styles', '0'], propertyHash: digest('style') },
    { kind: 'resource', path: ['docInfo', 'resources', '0'], propertyHash: digest('resource') },
    { kind: 'unknown-control', path: ['sections', '0', 'paragraphs', '1', 'controls', '0'], propertyHash: digest('unknown-a') },
    { kind: 'unknown-control', path: ['sections', '0', 'paragraphs', '1', 'controls', '1'], propertyHash: digest('unknown-b') },
  ]);
  assert.equal(root.coverage, 'full-document');

  const next = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: branch.name,
    expectedRepositoryRevision: repo.revision,
    expectedBranchRevision: branch.revision,
    reason: 'manual',
    mergeManifestEntries: [
      { kind: 'document', path: [], propertyHash: digest('document') },
      { kind: 'paragraph', path: ['sections', '0', 'paragraphs', '0'], propertyHash: digest('inserted') },
      { kind: 'paragraph', path: ['sections', '0', 'paragraphs', '1'], propertyHash: digest('a-edited'), identityHint: 'para-a' },
      { kind: 'paragraph', path: ['sections', '0', 'paragraphs', '2'], propertyHash: digest('b'), identityHint: 'para-b' },
      { kind: 'cell', path: ['sections', '0', 'paragraphs', '2', 'controls', '0', 'cells', '0'], propertyHash: digest('cell') },
      { kind: 'style', path: ['docInfo', 'styles', '0'], propertyHash: digest('style-edited') },
      { kind: 'resource', path: ['docInfo', 'resources', '0'], propertyHash: digest('resource') },
      { kind: 'unknown-control', path: ['sections', '0', 'paragraphs', '2', 'controls', '0'], propertyHash: digest('unknown-inserted') },
      { kind: 'unknown-control', path: ['sections', '0', 'paragraphs', '2', 'controls', '1'], propertyHash: digest('unknown-a-edited') },
      { kind: 'unknown-control', path: ['sections', '0', 'paragraphs', '2', 'controls', '2'], propertyHash: digest('unknown-b') },
    ],
    ...payload(2, 'Structural child'),
  });
  const manifest = await store.getMergeManifest(next.commit.mergeManifestId!);
  assert.ok(manifest);
  assert.equal(manifest.coverage, 'full-document');
  assert.deepEqual(manifest.parentManifestIds, [root.id]);
  const rootA = root.entries.find((entry) => entry.identity === 'para-a');
  const editedA = manifest.entries.find((entry) => entry.path.join('/') === 'sections/0/paragraphs/1');
  assert.ok(rootA);
  assert.equal(editedA?.identity, rootA.identity);
  assert.notEqual(
    manifest.entries.find((entry) => entry.path.join('/') === 'sections/0/paragraphs/0')?.identity,
    rootA.identity,
  );
  assert.ok(manifest.entries.some((entry) => entry.kind === 'cell'));
  assert.ok(manifest.entries.some((entry) => entry.kind === 'style'));
  assert.ok(manifest.entries.some((entry) => entry.kind === 'resource'));
  assert.equal(
    manifest.entries.find((entry) => entry.kind === 'style')?.identity,
    root.entries.find((entry) => entry.kind === 'style')?.identity,
    'an edited singleton sequence retains identity when membership cannot shift',
  );
  const rootUnknownA = root.entries.find((entry) => entry.propertyHash === digest('unknown-a'))!;
  const rootUnknownB = root.entries.find((entry) => entry.propertyHash === digest('unknown-b'))!;
  const insertedUnknown = manifest.entries.find((entry) => entry.propertyHash === digest('unknown-inserted'))!;
  const editedUnknown = manifest.entries.find((entry) => entry.propertyHash === digest('unknown-a-edited'))!;
  const shiftedUnknownB = manifest.entries.find((entry) => entry.propertyHash === digest('unknown-b'))!;
  assert.notEqual(insertedUnknown.identity, rootUnknownA.identity);
  assert.notEqual(editedUnknown.identity, rootUnknownA.identity);
  assert.equal(shiftedUnknownB.identity, rootUnknownB.identity);
});

test('merge relation and nearest-base discovery distinguish integrated, fast-forward, and diverged histories', async () => {
  const created = await repository();
  const { store, repository: repo, branch: main, commit: root } = created;
  const source = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('source'),
    target: root.id,
    expectedRepositoryRevision: repo.revision,
  });
  const current = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: main.name,
    expectedRepositoryRevision: source.repository.revision,
    expectedBranchRevision: main.revision,
    reason: 'manual',
    ...payload(2, 'Current'),
  });
  const incoming = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: source.branch.name,
    expectedRepositoryRevision: current.repository.revision,
    expectedBranchRevision: source.branch.revision,
    reason: 'manual',
    ...payload(3, 'Incoming'),
  });

  assert.deepEqual(await store.getMergeRelation(repo.id, root.id, incoming.commit.id), {
    relation: 'fast-forward',
    baseCommitIds: [root.id],
  });
  assert.deepEqual(await store.getMergeRelation(repo.id, incoming.commit.id, root.id), {
    relation: 'already-integrated',
    baseCommitIds: [root.id],
  });
  assert.deepEqual(await store.getMergeRelation(repo.id, current.commit.id, incoming.commit.id), {
    relation: 'diverged',
    baseCommitIds: [root.id],
  });
});

test('criss-cross history returns every nearest merge base in deterministic order', async () => {
  const { store, repository: repo, branch: main, commit: root } = await repository();
  const branchB = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('branch-b'),
    target: root.id,
    expectedRepositoryRevision: repo.revision,
  });
  const a1 = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: main.name,
    expectedRepositoryRevision: branchB.repository.revision,
    expectedBranchRevision: main.revision,
    reason: 'manual',
    ...payload(2, 'A1'),
  });
  const oldA = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('old-a'),
    target: a1.commit.id,
    expectedRepositoryRevision: a1.repository.revision,
  });
  const b1 = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: branchB.branch.name,
    expectedRepositoryRevision: oldA.repository.revision,
    expectedBranchRevision: branchB.branch.revision,
    reason: 'manual',
    ...payload(3, 'B1'),
  });
  const m1 = await store.completeMergeCheckpoint({
    repositoryId: repo.id,
    branch: a1.branch.name,
    expectedRepositoryRevision: b1.repository.revision,
    expectedBranchRevision: a1.branch.revision,
    expectedHead: a1.commit.id,
    sourceBranch: b1.branch.name,
    expectedSourceRevision: b1.branch.revision,
    deleteSource: false,
    merge: {
      sourceBranchAtMerge: b1.branch.name,
      targetBranchAtMerge: a1.branch.name,
      baseCommitIds: [root.id],
      conflictCount: 0,
    },
    ...payload(4, 'M1'),
  });
  const m2 = await store.completeMergeCheckpoint({
    repositoryId: repo.id,
    branch: b1.branch.name,
    expectedRepositoryRevision: m1.repository.revision,
    expectedBranchRevision: b1.branch.revision,
    expectedHead: b1.commit.id,
    sourceBranch: oldA.branch.name,
    expectedSourceRevision: oldA.branch.revision,
    deleteSource: false,
    merge: {
      sourceBranchAtMerge: oldA.branch.name,
      targetBranchAtMerge: b1.branch.name,
      baseCommitIds: [root.id],
      conflictCount: 0,
    },
    ...payload(5, 'M2'),
  });
  assert.deepEqual(
    await store.findMergeBases(repo.id, m1.commit.id, m2.commit.id),
    [b1.commit.id, a1.commit.id],
  );
});

test('merge draft CRUD uses updatedAt CAS and keeps draft heads and assets reachable', async () => {
  const created = await repository();
  const { store, repository: repo, branch: main, commit: root } = created;
  const source = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('draft-source'),
    target: root.id,
    expectedRepositoryRevision: repo.revision,
  });
  const incoming = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: source.branch.name,
    expectedRepositoryRevision: source.repository.revision,
    expectedBranchRevision: source.branch.revision,
    reason: 'manual',
    ...payload(7, 'Draft incoming'),
  });
  const assetBytes = new Uint8Array([99, 98, 97]);
  const assetId = hashBytes(assetBytes);
  const draft = mergeDraft(created, {
    ...incoming.branch,
    target: incoming.commit.id,
  });
  draft.sourceHead = incoming.commit.id;
  draft.sourceBranchRevision = incoming.branch.revision;
  draft.manualAssetBlobIds = [assetId];
  const saved = await store.putMergeDraft({
    draft,
    expectedUpdatedAt: null,
    assetBlobs: [{ id: assetId, byteLength: assetBytes.byteLength, bytes: assetBytes }],
  });
  assert.equal((await store.getMergeDraft(saved.id))?.updatedAt, saved.updatedAt);
  assert.deepEqual((await store.listMergeDrafts(repo.id)).map((item) => item.id), [saved.id]);
  await assert.rejects(
    store.putMergeDraft({ draft: { ...saved, updatedAt: saved.updatedAt + 1 }, expectedUpdatedAt: 1 }),
    (error) => error instanceof VersionError && error.code === 'STALE_WORKSPACE',
  );

  const deleted = await store.deleteBranch({
    repositoryId: repo.id,
    branch: incoming.branch.name,
    currentBranch: main.name,
    expectedRepositoryRevision: incoming.repository.revision,
    expectedBranchRevision: incoming.branch.revision,
  });
  const collected = await store.collectGarbage(repo.id, deleted.revision);
  assert.equal(collected.garbageCollected.commits, 0);
  assert.ok(await store.getCommit(incoming.commit.id));
  assert.ok(await store.getBlob(assetId));
  await store.deleteMergeDraft(repo.id, saved.id, saved.updatedAt);
});

test('merge completion rejects a source branch delete/recreate ABA with the same head and revision', async () => {
  const created = await repository();
  const { store, repository: repo, branch: main, commit: root } = created;
  const incoming = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: main.name,
    expectedRepositoryRevision: repo.revision,
    expectedBranchRevision: main.revision,
    expectedHead: root.id,
    reason: 'manual',
    ...payload(12, 'Incoming target'),
  });
  const source = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('aba-source'),
    target: incoming.commit.id,
    expectedRepositoryRevision: incoming.repository.revision,
  });
  const rewound = await store.moveBranchGuarded({
    repositoryId: repo.id,
    branch: incoming.branch.name,
    target: root.id,
    expectedRepositoryRevision: source.repository.revision,
    expectedBranchRevision: incoming.branch.revision,
    expectedHead: incoming.commit.id,
  });
  const draft = mergeDraft(
    { ...created, repository: rewound.repository, branch: rewound.branch },
    source.branch,
  );
  draft.mode = 'fast-forward';
  draft.targetBranchRevision = rewound.branch.revision;
  draft.targetBranchGeneration = rewound.branch.generation;
  draft.sourceBranchGeneration = source.branch.generation;
  await store.putMergeDraft({ draft, expectedUpdatedAt: null });

  const deleted = await store.deleteBranch({
    repositoryId: repo.id,
    branch: source.branch.name,
    currentBranch: rewound.branch.name,
    expectedRepositoryRevision: rewound.repository.revision,
    expectedBranchRevision: source.branch.revision,
  });
  const recreated = await store.createBranch({
    repositoryId: repo.id,
    name: source.branch.name,
    target: source.branch.target,
    expectedRepositoryRevision: deleted.revision,
  });
  assert.equal(recreated.branch.target, source.branch.target);
  assert.equal(recreated.branch.revision, source.branch.revision);
  assert.notEqual(recreated.branch.generation, source.branch.generation);
  await assert.rejects(
    store.completeFastForwardMerge({
      repositoryId: repo.id,
      branch: rewound.branch.name,
      target: recreated.branch.target,
      expectedRepositoryRevision: recreated.repository.revision,
      expectedBranchRevision: rewound.branch.revision,
      expectedHead: rewound.branch.target,
      sourceBranch: recreated.branch.name,
      expectedSourceRevision: recreated.branch.revision,
      deleteSource: false,
      draftId: draft.id,
    }),
    (error) => error instanceof VersionError && error.code === 'STALE_WORKSPACE',
  );
});

test('fast-forward completion and merge checkpoint completion update refs and drafts atomically', async () => {
  const first = await repository();
  const { store, repository: repo, branch: main, commit: root } = first;
  const source = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('ff-source'),
    target: root.id,
    expectedRepositoryRevision: repo.revision,
  });
  const incoming = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: source.branch.name,
    expectedRepositoryRevision: source.repository.revision,
    expectedBranchRevision: source.branch.revision,
    reason: 'manual',
    ...payload(3, 'Fast forward'),
  });
  const ff = await store.completeFastForwardMerge({
    repositoryId: repo.id,
    branch: main.name,
    target: incoming.commit.id,
    expectedRepositoryRevision: incoming.repository.revision,
    expectedBranchRevision: main.revision,
    expectedHead: root.id,
    sourceBranch: incoming.branch.name,
    expectedSourceRevision: incoming.branch.revision,
    deleteSource: true,
  });
  assert.equal(ff.branch.target, incoming.commit.id);
  assert.equal(ff.sourceBranch, null);
  assert.equal(await store.getBranch(repo.id, incoming.branch.name), null);

  const divergedSource = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('diverged-source'),
    target: ff.branch.target,
    expectedRepositoryRevision: ff.repository.revision,
  });
  const current = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: ff.branch.name,
    expectedRepositoryRevision: divergedSource.repository.revision,
    expectedBranchRevision: ff.branch.revision,
    reason: 'manual',
    ...payload(4, 'Current side'),
  });
  const incomingSide = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: divergedSource.branch.name,
    expectedRepositoryRevision: current.repository.revision,
    expectedBranchRevision: divergedSource.branch.revision,
    reason: 'manual',
    ...payload(5, 'Incoming side'),
  });
  const completed = await store.completeMergeCheckpoint({
    repositoryId: repo.id,
    branch: current.branch.name,
    expectedRepositoryRevision: incomingSide.repository.revision,
    expectedBranchRevision: current.branch.revision,
    expectedHead: current.commit.id,
    sourceBranch: incomingSide.branch.name,
    expectedSourceRevision: incomingSide.branch.revision,
    deleteSource: true,
    merge: {
      sourceBranchAtMerge: incomingSide.branch.name,
      targetBranchAtMerge: current.branch.name,
      baseCommitIds: [incoming.commit.id],
      conflictCount: 2,
    },
    ...payload(6, 'Merge result'),
  });
  assert.deepEqual(completed.commit.parents, [current.commit.id, incomingSide.commit.id]);
  assert.equal(completed.commit.reason, 'merge');
  assert.equal(completed.commit.merge?.conflictCount, 2);
  assert.equal(completed.sourceBranch, null);

  // A later ordinary checkpoint can be undone before the merge history entry.
  // Its ref movement leaves the merge head unchanged but advances the branch
  // revision twice (checkpoint, then rewind), so the merge Undo must CAS the
  // freshly-read revision rather than the revision captured at completion.
  const laterCheckpoint = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: completed.branch.name,
    expectedRepositoryRevision: completed.repository.revision,
    expectedBranchRevision: completed.branch.revision,
    expectedHead: completed.commit.id,
    reason: 'manual',
    ...payload(42, 'Later ordinary checkpoint'),
  });
  const rewound = await store.moveBranchGuarded({
    repositoryId: repo.id,
    branch: laterCheckpoint.branch.name,
    target: completed.commit.id,
    expectedRepositoryRevision: laterCheckpoint.repository.revision,
    expectedBranchRevision: laterCheckpoint.branch.revision,
    expectedHead: laterCheckpoint.commit.id,
  });
  assert.equal(rewound.branch.target, completed.commit.id);
  assert.ok(rewound.branch.revision > completed.branch.revision);
  const metadataAdvanced = await store.markSaved(
    repo.id,
    contentFingerprint(payload(43).contentFingerprint),
    rewound.repository.revision,
  );
  const undone = await store.restoreCompositeRefs({
    repositoryId: repo.id,
    expectedRepositoryRevision: completed.repository.revision,
    allowRepositoryRevisionAdvance: true,
    targetBranch: completed.branch.name,
    expectedTarget: {
      target: completed.commit.id,
      revision: rewound.branch.revision,
      generation: rewound.branch.generation,
    },
    restoreTarget: current.commit.id,
    sourceBranch: incomingSide.branch.name,
    expectedSource: null,
    restoreSource: { target: incomingSide.commit.id, generation: incomingSide.branch.generation },
  });
  assert.equal(undone.targetBranch.target, current.commit.id);
  assert.equal(undone.sourceBranch?.target, incomingSide.commit.id);
  assert.ok(undone.repository.revision > metadataAdvanced.revision);
  const redone = await store.restoreCompositeRefs({
    repositoryId: repo.id,
    expectedRepositoryRevision: undone.repository.revision,
    targetBranch: undone.targetBranch.name,
    expectedTarget: {
      target: undone.targetBranch.target,
      revision: undone.targetBranch.revision,
      generation: undone.targetBranch.generation,
    },
    restoreTarget: completed.commit.id,
    sourceBranch: undone.sourceBranch!.name,
    expectedSource: {
      target: undone.sourceBranch!.target,
      revision: undone.sourceBranch!.revision,
      generation: undone.sourceBranch!.generation,
    },
    restoreSource: null,
  });
  assert.equal(redone.targetBranch.target, completed.commit.id);
  assert.equal(redone.sourceBranch, null);
  await assert.rejects(
    store.restoreCompositeRefs({
      repositoryId: repo.id,
      expectedRepositoryRevision: completed.repository.revision,
      allowRepositoryRevisionAdvance: true,
      targetBranch: redone.targetBranch.name,
      expectedTarget: {
        target: current.commit.id,
        revision: redone.targetBranch.revision,
        generation: redone.targetBranch.generation,
      },
      restoreTarget: current.commit.id,
      sourceBranch: incomingSide.branch.name,
      expectedSource: null,
      restoreSource: { target: incomingSide.commit.id, generation: incomingSide.branch.generation },
    }),
    (error) => error instanceof VersionError && error.code === 'STALE_WORKSPACE',
  );
  const undoneAfterRevisionRoundTrip = await store.restoreCompositeRefs({
    repositoryId: repo.id,
    // The history entry's repository revision is old, but the exact current
    // ref heads/revisions were re-read immediately before this guarded CAS.
    expectedRepositoryRevision: completed.repository.revision,
    allowRepositoryRevisionAdvance: true,
    targetBranch: redone.targetBranch.name,
    expectedTarget: {
      target: redone.targetBranch.target,
      revision: redone.targetBranch.revision,
      generation: redone.targetBranch.generation,
    },
    restoreTarget: current.commit.id,
    sourceBranch: incomingSide.branch.name,
    expectedSource: null,
    restoreSource: { target: incomingSide.commit.id, generation: incomingSide.branch.generation },
  });
  assert.equal(undoneAfterRevisionRoundTrip.targetBranch.target, current.commit.id);
  assert.equal(undoneAfterRevisionRoundTrip.sourceBranch?.target, incomingSide.commit.id);

  // A branch name/head/revision can repeat after delete/recreate. Its stable
  // generation must prevent a composite history entry from accepting that ABA.
  const originalSource = undoneAfterRevisionRoundTrip.sourceBranch!;
  const afterDelete = await store.deleteBranch({
    repositoryId: repo.id,
    branch: originalSource.name,
    currentBranch: undoneAfterRevisionRoundTrip.targetBranch.name,
    expectedRepositoryRevision: undoneAfterRevisionRoundTrip.repository.revision,
    expectedBranchRevision: originalSource.revision,
  });
  const recreated = await store.createBranch({
    repositoryId: repo.id,
    name: originalSource.name,
    target: originalSource.target,
    expectedRepositoryRevision: afterDelete.revision,
  });
  assert.equal(recreated.branch.target, originalSource.target);
  assert.equal(recreated.branch.revision, 1);
  assert.notEqual(recreated.branch.generation, originalSource.generation);
  await assert.rejects(
    store.restoreCompositeRefs({
      repositoryId: repo.id,
      expectedRepositoryRevision: recreated.repository.revision,
      targetBranch: undoneAfterRevisionRoundTrip.targetBranch.name,
      expectedTarget: {
        target: undoneAfterRevisionRoundTrip.targetBranch.target,
        revision: undoneAfterRevisionRoundTrip.targetBranch.revision,
        generation: undoneAfterRevisionRoundTrip.targetBranch.generation,
      },
      restoreTarget: completed.commit.id,
      sourceBranch: recreated.branch.name,
      expectedSource: {
        target: recreated.branch.target,
        revision: recreated.branch.revision,
        generation: originalSource.generation,
      },
      restoreSource: null,
    }),
    (error) => error instanceof VersionError && error.code === 'STALE_WORKSPACE',
  );
});

test('default branch cannot be deleted directly or as a merge source', async () => {
  const { store, repository: repo, branch: main, commit: root } = await repository();
  const target = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('target'),
    target: root.id,
    expectedRepositoryRevision: repo.revision,
  });
  await assert.rejects(
    store.deleteBranch({
      repositoryId: repo.id,
      branch: main.name,
      currentBranch: target.branch.name,
      expectedRepositoryRevision: target.repository.revision,
      expectedBranchRevision: main.revision,
    }),
    (error) => error instanceof VersionError && error.code === 'DEFAULT_BRANCH',
  );
  const mainAdvanced = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: main.name,
    expectedRepositoryRevision: target.repository.revision,
    expectedBranchRevision: main.revision,
    reason: 'manual',
    ...payload(2, 'Default branch ahead'),
  });
  await assert.rejects(
    store.completeFastForwardMerge({
      repositoryId: repo.id,
      branch: target.branch.name,
      target: mainAdvanced.commit.id,
      expectedRepositoryRevision: mainAdvanced.repository.revision,
      expectedBranchRevision: target.branch.revision,
      expectedHead: root.id,
      sourceBranch: main.name,
      expectedSourceRevision: mainAdvanced.branch.revision,
      deleteSource: true,
    }),
    (error) => error instanceof VersionError && error.code === 'DEFAULT_BRANCH',
  );
});

test('fast-forward relation can be recorded as an explicit two-parent merge while keeping source', async () => {
  const { store, repository: repo, branch: main, commit: root } = await repository();
  const source = await store.createBranch({
    repositoryId: repo.id,
    name: branchName('explicit-source'),
    target: root.id,
    expectedRepositoryRevision: repo.revision,
  });
  const incoming = await store.createCheckpoint({
    repositoryId: repo.id,
    branch: source.branch.name,
    expectedRepositoryRevision: source.repository.revision,
    expectedBranchRevision: source.branch.revision,
    reason: 'manual',
    ...payload(17, 'Incoming explicit merge'),
  });
  assert.equal(
    (await store.getMergeRelation(repo.id, main.target, incoming.branch.target)).relation,
    'fast-forward',
  );
  const explicit = await store.completeMergeCheckpoint({
    repositoryId: repo.id,
    branch: main.name,
    expectedRepositoryRevision: incoming.repository.revision,
    expectedBranchRevision: main.revision,
    expectedHead: root.id,
    sourceBranch: incoming.branch.name,
    expectedSourceRevision: incoming.branch.revision,
    deleteSource: false,
    merge: {
      sourceBranchAtMerge: incoming.branch.name,
      targetBranchAtMerge: main.name,
      baseCommitIds: [root.id],
      conflictCount: 0,
    },
    ...payload(18, 'Explicit fast-forward merge'),
  });
  assert.deepEqual(explicit.commit.parents, [root.id, incoming.commit.id]);
  assert.equal(explicit.commit.reason, 'merge');
  assert.equal(explicit.sourceBranch?.target, incoming.commit.id);
  assert.equal((await store.getBranch(repo.id, incoming.branch.name))?.target, incoming.commit.id);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import type { CompareDocumentSnapshot } from '../src/compare/types.ts';
import { fingerprintBytes } from '../src/versioning/hash.ts';
import { VersionGraphStore } from '../src/versioning/store.ts';
import {
  blobId,
  branchName,
  contentFingerprint,
  documentId,
  tagName,
  VersionError,
} from '../src/versioning/types.ts';

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

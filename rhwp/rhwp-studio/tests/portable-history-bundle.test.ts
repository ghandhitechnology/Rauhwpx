import assert from 'node:assert/strict';
import test from 'node:test';

import type { CompareDocumentSnapshot } from '../src/compare/types.ts';
import {
  createPortableHistoryBundle,
  createPortableHistoryFolder,
  openPortableHistoryBundle,
  PORTABLE_HISTORY_FOLDER_HISTORY_NAME,
  PortableHistoryError,
} from '../src/versioning/portable-bundle.ts';
import { fingerprintBytes, hashBytes } from '../src/versioning/hash.ts';
import { VersionGraphStore } from '../src/versioning/store.ts';
import {
  branchName,
  documentId,
  mergeDraftId,
  tagName,
  VersionError,
} from '../src/versioning/types.ts';

function bytes(value: number): Uint8Array {
  return new Uint8Array([0x50, 0x4b, value, value + 1, value + 2]);
}

function compareSnapshot(label: string): CompareDocumentSnapshot {
  return {
    meta: { name: label, sectionCount: 1, pageCount: 1 },
    paragraphs: [{
      section: 0,
      paragraph: 0,
      sectionPage: 1,
      globalIndex: 0,
      stableId: `paragraph-${label}`,
      text: label,
      normalizedText: label,
      controlCount: 0,
      signature: `signature-${label}`,
      isAnchorCandidate: true,
    }],
    controls: [],
  };
}

function payload(value: number, title: string) {
  const content = bytes(value);
  return {
    bytes: content,
    compareSnapshot: compareSnapshot(title),
    contentFingerprint: fingerprintBytes(content),
    title,
    titleRevision: 0,
    titleOrigin: 'manual' as const,
    author: { kind: 'user' as const, label: 'Tester' },
    stats: { added: 1, removed: 0, modified: 0 },
    createdAt: value,
  };
}

async function historyFixture() {
  const store = new VersionGraphStore({ indexedDB: null });
  const initial = payload(1, 'Initial');
  const created = await store.createRepository({
    documentId: documentId('portable-document'),
    lastSavedFingerprint: initial.contentFingerprint,
    enabledAt: 1,
    initial,
  });
  const branch = await store.createBranch({
    repositoryId: created.repository.id,
    name: branchName('review'),
    target: created.commit.id,
    expectedRepositoryRevision: created.repository.revision,
  });
  const checkpoint = await store.createCheckpoint({
    repositoryId: created.repository.id,
    branch: branch.branch.name,
    expectedRepositoryRevision: branch.repository.revision,
    expectedBranchRevision: branch.branch.revision,
    expectedHead: branch.branch.target,
    reason: 'export',
    ...payload(8, 'Review head'),
  });
  const tagged = await store.createTag({
    repositoryId: created.repository.id,
    name: tagName('shared'),
    target: checkpoint.commit.id,
    expectedRepositoryRevision: checkpoint.repository.revision,
  });
  const shelf = await store.createShelf({
    repositoryId: created.repository.id,
    baseCommitId: checkpoint.commit.id,
    branch: checkpoint.branch.name,
    expectedRepositoryRevision: tagged.repository.revision,
    title: 'Unfinished alternative',
    ...payload(11, 'Shelf content'),
  });
  const assetBytes = new Uint8Array([23, 24, 25]);
  const assetId = hashBytes(assetBytes);
  const draft = await store.putMergeDraft({
    expectedUpdatedAt: null,
    draft: {
      id: mergeDraftId('portable-draft'),
      repositoryId: created.repository.id,
      targetBranch: checkpoint.branch.name,
      sourceBranch: created.branch.name,
      baseCommitIds: [created.commit.id],
      currentHead: checkpoint.commit.id,
      sourceHead: created.commit.id,
      targetBranchRevision: checkpoint.branch.revision,
      sourceBranchRevision: created.branch.revision,
      targetBranchGeneration: checkpoint.branch.generation,
      sourceBranchGeneration: created.branch.generation,
      mode: 'diverged',
      analysisVersion: 1,
      conflicts: [],
      resolutions: {},
      automaticResult: { kind: 'document', children: [] },
      manualAssetBlobIds: [assetId],
      history: [],
      historyIndex: 0,
      createdAt: 12,
      updatedAt: 12,
    },
    assetBlobs: [{ id: assetId, byteLength: assetBytes.byteLength, bytes: assetBytes }],
  });
  const snapshot = await store.exportRepositorySnapshot(created.repository.id);
  return { store, snapshot, head: checkpoint.commit, shelf: shelf.shelf, draft, assetId };
}

test('portable history round trip restores commits, refs, shelves, manifests, drafts, and assets', async () => {
  const fixture = await historyFixture();
  const bytes = createPortableHistoryBundle({
    documentFileName: 'report.hwpx',
    sourceFormat: 'hwpx',
    activeBranch: branchName('review'),
    currentBlobId: fixture.head.blobId,
    snapshot: fixture.snapshot,
    createdAt: 123,
  });
  const opened = openPortableHistoryBundle(bytes);
  assert.equal(opened.documentFileName, 'report.hwpx');
  assert.equal(opened.activeBranch, 'review');
  assert.equal(opened.currentBlobId, fixture.head.blobId);
  assert.deepEqual(opened.currentDocumentBytes, fixture.snapshot.blobs.find(
    (blob) => blob.id === fixture.head.blobId,
  )?.bytes);
  assert.equal(opened.snapshot.commits.length, 2);
  assert.equal(opened.snapshot.refs.filter((ref) => ref.kind === 'branch').length, 2);
  assert.equal(opened.snapshot.refs.filter((ref) => ref.kind === 'tag').length, 1);
  assert.equal(opened.snapshot.shelves[0]?.id, fixture.shelf.id);
  assert.equal(opened.snapshot.mergeManifests.length, 2);
  assert.equal(opened.snapshot.mergeDrafts[0]?.id, fixture.draft.id);
  assert.ok(opened.snapshot.blobs.some((blob) => blob.id === fixture.assetId));

  const folder = createPortableHistoryFolder({
    documentFileName: 'report.hwpx',
    sourceFormat: 'hwpx',
    activeBranch: branchName('review'),
    currentBlobId: fixture.head.blobId,
    snapshot: fixture.snapshot,
    createdAt: 123,
  });
  assert.equal(folder.folderName, 'report.rhwpx');
  assert.deepEqual(folder.files.map((file) => file.name), [
    PORTABLE_HISTORY_FOLDER_HISTORY_NAME,
    'report.hwpx',
  ]);
  assert.deepEqual(folder.files[0]?.bytes, bytes);
  assert.deepEqual(folder.files[1]?.bytes, opened.currentDocumentBytes);

  const destination = new VersionGraphStore({ indexedDB: null });
  const imported = await destination.importRepositorySnapshot(opened.snapshot);
  assert.equal(imported.imported, true);
  assert.equal((await destination.listCommits(imported.repository.id)).length, 2);
  assert.equal((await destination.listRefs(imported.repository.id)).length, 3);
  assert.equal((await destination.listShelves(imported.repository.id)).length, 1);
  assert.equal((await destination.listMergeDrafts(imported.repository.id)).length, 1);
  assert.deepEqual((await destination.getBlob(fixture.head.blobId))?.bytes, opened.currentDocumentBytes);

  const repeated = await destination.importRepositorySnapshot(opened.snapshot);
  assert.equal(repeated.imported, false, 'opening an identical local bundle must be idempotent');

  await destination.removeImportedRepository(
    imported.repository.id,
    imported.repository.documentId,
    imported.repository.revision,
  );
  assert.equal(await destination.getRepository(imported.repository.id), null);
  assert.equal(await destination.getBlob(fixture.assetId), null);
});

test('portable history detects payload tampering and truncation before import', async () => {
  const fixture = await historyFixture();
  const bundle = createPortableHistoryBundle({
    documentFileName: 'report.hwpx',
    sourceFormat: 'hwpx',
    activeBranch: branchName('review'),
    currentBlobId: fixture.head.blobId,
    snapshot: fixture.snapshot,
  });
  const tampered = new Uint8Array(bundle);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => openPortableHistoryBundle(tampered), PortableHistoryError);
  assert.throws(() => openPortableHistoryBundle(bundle.subarray(0, bundle.length - 1)), PortableHistoryError);
});

test('import rejects a same-ID repository whose local history has diverged', async () => {
  const fixture = await historyFixture();
  const destination = new VersionGraphStore({ indexedDB: null });
  await destination.importRepositorySnapshot(fixture.snapshot);
  await destination.updateCommitTitle({
    repositoryId: fixture.snapshot.repository.id,
    commitId: fixture.head.id,
    expectedTitleRevision: fixture.head.titleRevision,
    title: 'Local-only title',
    titleRevision: fixture.head.titleRevision,
    titleOrigin: 'manual',
  });
  await assert.rejects(
    destination.importRepositorySnapshot(fixture.snapshot),
    (error) => error instanceof VersionError && error.code === 'REPOSITORY_EXISTS',
  );
});

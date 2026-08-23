import type { CompareDocumentSnapshot } from '../compare/types.ts';
import { openIndexedDatabase } from '../core/idb-open.ts';
import { buildMergeManifest, MERGE_MANIFEST_VERSION } from '../merge/manifest.ts';
import { hashBytes, hashCompareSnapshot, serializeCompareSnapshot } from './hash.ts';
import {
  branchName,
  branchGeneration,
  commitId,
  compareSnapshotId,
  contentFingerprint,
  documentId,
  mergeDraftId,
  normalizedRefKey,
  repositoryId,
  shelfId,
  tagName,
  VersionError,
  type BlobId,
  type BranchName,
  type BranchGeneration,
  type BranchRef,
  type CommitId,
  type CommitParents,
  type CompareSnapshotId,
  type ContentFingerprint,
  type DocumentId,
  type MergeDraftId,
  type MergeManifestEntrySeed,
  type MergeRelation,
  type RepositoryId,
  type ShelfId,
  type TagName,
  type TagRef,
  type VersionAuthor,
  type VersionBlob,
  type VersionCommit,
  type VersionCompareSnapshot,
  type VersionMergeDraft,
  type VersionMergeManifest,
  type VersionMergeMetadata,
  type VersionRef,
  type VersionRepository,
  type VersionShelf,
  type VersionStats,
  type VersionTitle,
} from './types.ts';

export const VERSION_DATABASE_NAME = 'rhwpStudioVersionGraph';
export const VERSION_DATABASE_VERSION = 2;

const STORE_NAMES = [
  'repositories',
  'commits',
  'refs',
  'blobs',
  'compareSnapshots',
  'shelves',
  'mergeManifests',
  'mergeDrafts',
] as const;

type StoreName = typeof STORE_NAMES[number];
type RefRow = VersionRef & { key: string };

interface StoreRows {
  repositories: VersionRepository;
  commits: VersionCommit;
  refs: RefRow;
  blobs: VersionBlob;
  compareSnapshots: VersionCompareSnapshot;
  shelves: VersionShelf;
  mergeManifests: VersionMergeManifest;
  mergeDrafts: VersionMergeDraft;
}

interface GraphTransaction {
  get<Name extends StoreName>(store: Name, key: IDBValidKey): Promise<StoreRows[Name] | undefined>;
  getAll<Name extends StoreName>(store: Name): Promise<StoreRows[Name][]>;
  findRepositoryByDocumentId(documentId: DocumentId): Promise<VersionRepository | undefined>;
  listCommits(repositoryId: RepositoryId, beforeOrdinal: number, limit: number): Promise<VersionCommit[]>;
  listRefs(repositoryId: RepositoryId): Promise<RefRow[]>;
  listShelves(repositoryId: RepositoryId, limit?: number): Promise<VersionShelf[]>;
  listMergeDrafts(repositoryId: RepositoryId): Promise<VersionMergeDraft[]>;
  put<Name extends StoreName>(store: Name, row: StoreRows[Name]): Promise<void>;
  delete(store: StoreName, key: IDBValidKey): Promise<void>;
  clear(store: StoreName): Promise<void>;
}

type MemoryState = {
  [Name in StoreName]: Map<IDBValidKey, StoreRows[Name]>;
};

export interface VersionGraphStoreOptions {
  indexedDB?: IDBFactory | null;
}

export type CheckpointPayload = VersionTitle & {
  id?: CommitId;
  bytes: Uint8Array;
  blobId?: BlobId;
  compareSnapshot: CompareDocumentSnapshot;
  compareSnapshotId?: CompareSnapshotId;
  contentFingerprint: ContentFingerprint;
  author: VersionAuthor;
  stats?: VersionStats;
  createdAt?: number;
  /** Full parser-derived structural entries. Compare snapshots are only a legacy fallback. */
  mergeManifestEntries?: readonly import('./types.ts').MergeManifestEntrySeed[];
};

export interface CreateRepositoryInput {
  id?: RepositoryId;
  documentId: DocumentId;
  initialBranch?: BranchName;
  enabledAt?: number;
  lastSavedFingerprint: ContentFingerprint;
  initial: CheckpointPayload;
}

export type CreateCheckpointInput = CheckpointPayload & {
  repositoryId: RepositoryId;
  branch: BranchName;
  expectedRepositoryRevision: number;
  expectedBranchRevision: number;
  expectedHead?: CommitId;
  parents?: readonly [CommitId] | readonly [CommitId, CommitId];
  reason: Exclude<VersionCommit['reason'], 'initial'>;
  lastSavedFingerprint?: ContentFingerprint;
  merge?: VersionMergeMetadata;
};

export interface PutMergeDraftInput {
  draft: VersionMergeDraft;
  /** null means the draft must not exist; undefined performs an unconditional upsert. */
  expectedUpdatedAt?: number | null;
  assetBlobs?: readonly VersionBlob[];
}

export interface MoveBranchInput {
  repositoryId: RepositoryId;
  branch: BranchName;
  target: CommitId;
  expectedRepositoryRevision: number;
  expectedBranchRevision: number;
  expectedHead: CommitId;
}

export interface CompleteFastForwardMergeInput extends MoveBranchInput {
  sourceBranch: BranchName;
  expectedSourceRevision: number;
  deleteSource: boolean;
  draftId?: MergeDraftId;
}

export type CompleteMergeCheckpointInput = CheckpointPayload & {
  repositoryId: RepositoryId;
  branch: BranchName;
  expectedRepositoryRevision: number;
  expectedBranchRevision: number;
  expectedHead: CommitId;
  sourceBranch: BranchName;
  expectedSourceRevision: number;
  deleteSource: boolean;
  draftId?: MergeDraftId;
  lastSavedFingerprint?: ContentFingerprint;
  merge: VersionMergeMetadata;
};

export interface BranchRefExpectation {
  target: CommitId;
  revision: number;
  generation: BranchGeneration;
}

export interface RestoreCompositeRefsInput {
  repositoryId: RepositoryId;
  expectedRepositoryRevision: number;
  /**
   * Undo/Redo may run after unrelated repository metadata changed. Exact target
   * and source ref CAS checks remain mandatory, but those unrelated changes do
   * not invalidate the composite history entry.
   */
  allowRepositoryRevisionAdvance?: boolean;
  targetBranch: BranchName;
  expectedTarget: BranchRefExpectation;
  restoreTarget: CommitId;
  sourceBranch: BranchName;
  expectedSource: BranchRefExpectation | null;
  /** minimumRevision prevents a recreated ref from reusing a pre-delete CAS token. */
  restoreSource: { target: CommitId; minimumRevision?: number; generation: BranchGeneration } | null;
}

export interface MergeRelationResult {
  relation: MergeRelation;
  baseCommitIds: CommitId[];
}

export interface CommitPageOptions {
  beforeOrdinal?: number;
  limit?: number;
}

export interface RepositoryStorageUsageOptions {
  maxCommits?: number;
  maxShelves?: number;
}

export interface RepositoryStorageUsage {
  totalBytes: number;
  blobBytes: number;
  compareSnapshotBytes: number;
  blobCount: number;
  compareSnapshotCount: number;
  commitCount: number;
  shelfCount: number;
  commitTruncated: boolean;
  shelfTruncated: boolean;
  truncated: boolean;
}

export interface CreateBranchInput {
  repositoryId: RepositoryId;
  name: BranchName;
  target: CommitId;
  expectedRepositoryRevision: number;
}

export interface RenameBranchInput {
  repositoryId: RepositoryId;
  branch: BranchName;
  name: BranchName;
  expectedRepositoryRevision: number;
  expectedBranchRevision: number;
}

export interface DeleteBranchInput {
  repositoryId: RepositoryId;
  branch: BranchName;
  currentBranch: BranchName;
  expectedRepositoryRevision: number;
  expectedBranchRevision: number;
}

export interface CreateTagInput {
  repositoryId: RepositoryId;
  name: TagName;
  target: CommitId;
  expectedRepositoryRevision: number;
}

export interface MoveTagInput {
  repositoryId: RepositoryId;
  tag: TagName;
  target: CommitId;
  expectedRepositoryRevision: number;
  expectedTagRevision: number;
}

export interface DeleteTagInput {
  repositoryId: RepositoryId;
  tag: TagName;
  expectedRepositoryRevision: number;
  expectedTagRevision: number;
}

export interface CreateShelfInput {
  id?: ShelfId;
  repositoryId: RepositoryId;
  baseCommitId: CommitId;
  branch: BranchName;
  bytes: Uint8Array;
  blobId?: BlobId;
  compareSnapshot: CompareDocumentSnapshot;
  compareSnapshotId?: CompareSnapshotId;
  contentFingerprint: ContentFingerprint;
  title: string;
  createdAt?: number;
  expectedRepositoryRevision: number;
}

export interface DeleteShelfInput {
  repositoryId: RepositoryId;
  shelfId: ShelfId;
  expectedRepositoryRevision: number;
}

export type UpdateCommitTitleInput = VersionTitle & {
  repositoryId: RepositoryId;
  commitId: CommitId;
  expectedTitleRevision: number;
};

export interface GarbageCollectionResult {
  commits: number;
  blobs: number;
  compareSnapshots: number;
}

export interface CollectGarbageResult {
  repository: VersionRepository;
  garbageCollected: GarbageCollectionResult;
}

const EMPTY_STATS: VersionStats = { added: 0, removed: 0, modified: 0 };

function memoryState(): MemoryState {
  return {
    repositories: new Map(),
    commits: new Map(),
    refs: new Map(),
    blobs: new Map(),
    compareSnapshots: new Map(),
    shelves: new Map(),
    mergeManifests: new Map(),
    mergeDrafts: new Map(),
  };
}

function cloneValue<Value>(value: Value): Value {
  return structuredClone(value);
}

function cloneMemoryState(state: MemoryState): MemoryState {
  const cloneMap = <Value>(source: Map<IDBValidKey, Value>): Map<IDBValidKey, Value> => new Map(
    [...source].map(([key, value]) => [key, cloneValue(value)]),
  );
  return {
    repositories: cloneMap(state.repositories),
    commits: cloneMap(state.commits),
    refs: cloneMap(state.refs),
    blobs: cloneMap(state.blobs),
    compareSnapshots: cloneMap(state.compareSnapshots),
    shelves: cloneMap(state.shelves),
    mergeManifests: cloneMap(state.mergeManifests),
    mergeDrafts: cloneMap(state.mergeDrafts),
  };
}

function rowKey<Name extends StoreName>(store: Name, row: StoreRows[Name]): IDBValidKey {
  if (store === 'refs') return (row as RefRow).key;
  return (row as Exclude<StoreRows[Name], RefRow>).id;
}

function memoryTransaction(state: MemoryState): GraphTransaction {
  return {
    async get(store, key) {
      const row = state[store].get(key);
      return row === undefined ? undefined : cloneValue(row);
    },
    async getAll(store) {
      return [...state[store].values()].map(cloneValue);
    },
    async findRepositoryByDocumentId(documentId) {
      const repository = [...state.repositories.values()]
        .find((candidate) => candidate.documentId === documentId);
      return repository === undefined ? undefined : cloneValue(repository);
    },
    async listCommits(repositoryId, beforeOrdinal, limit) {
      return [...state.commits.values()]
        .filter((commit) => commit.repositoryId === repositoryId && commit.ordinal < beforeOrdinal)
        .sort((left, right) => right.ordinal - left.ordinal || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(cloneValue);
    },
    async listRefs(repositoryId) {
      return [...state.refs.values()]
        .filter((ref) => ref.repositoryId === repositoryId)
        .map(cloneValue);
    },
    async listShelves(repositoryId, limit) {
      const rows = [...state.shelves.values()]
        .filter((shelf) => shelf.repositoryId === repositoryId);
      return (limit === undefined ? rows : rows.slice(0, limit)).map(cloneValue);
    },
    async listMergeDrafts(repositoryId) {
      return [...state.mergeDrafts.values()]
        .filter((draft) => draft.repositoryId === repositoryId)
        .map(cloneValue);
    },
    async put(store, row) {
      const target = state[store] as Map<IDBValidKey, typeof row>;
      target.set(rowKey(store, row), cloneValue(row));
    },
    async delete(store, key) {
      state[store].delete(key);
    },
    async clear(store) {
      state[store].clear();
    },
  } as GraphTransaction;
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

function indexedDbTransaction(transaction: IDBTransaction): GraphTransaction {
  return {
    async get(store, key) {
      return requestResult(transaction.objectStore(store).get(key)) as Promise<never>;
    },
    async getAll(store) {
      return requestResult(transaction.objectStore(store).getAll()) as Promise<never>;
    },
    async findRepositoryByDocumentId(documentId) {
      const index = transaction.objectStore('repositories').index('documentId');
      return requestResult(index.get(documentId)) as Promise<VersionRepository | undefined>;
    },
    async listCommits(repositoryId, beforeOrdinal, limit) {
      const index = transaction.objectStore('commits').index('repositoryOrdinal');
      const range = IDBKeyRange.bound(
        [repositoryId, 0],
        [repositoryId, beforeOrdinal],
        false,
        true,
      );
      return new Promise((resolve, reject) => {
        const rows: VersionCommit[] = [];
        const request = index.openCursor(range, 'prev');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || rows.length >= limit) {
            resolve(rows);
            return;
          }
          rows.push(cursor.value as VersionCommit);
          cursor.continue();
        };
      });
    },
    async listRefs(repositoryId) {
      const index = transaction.objectStore('refs').index('repositoryId');
      return requestResult(index.getAll(IDBKeyRange.only(repositoryId))) as Promise<RefRow[]>;
    },
    async listShelves(repositoryId, limit) {
      const index = transaction.objectStore('shelves').index('repositoryId');
      const range = IDBKeyRange.only(repositoryId);
      return requestResult(
        limit === undefined ? index.getAll(range) : index.getAll(range, limit),
      ) as Promise<VersionShelf[]>;
    },
    async listMergeDrafts(repositoryId) {
      const index = transaction.objectStore('mergeDrafts').index('repositoryId');
      return requestResult(index.getAll(IDBKeyRange.only(repositoryId))) as Promise<VersionMergeDraft[]>;
    },
    async put(store, row) {
      await requestResult(transaction.objectStore(store).put(row));
    },
    async delete(store, key) {
      await requestResult(transaction.objectStore(store).delete(key));
    },
    async clear(store) {
      await requestResult(transaction.objectStore(store).clear());
    },
  };
}

function refKey(repository: RepositoryId, kind: VersionRef['kind'], name: BranchName | TagName): string {
  return `${repository}\u0000${kind}\u0000${normalizedRefKey(name)}`;
}

function createId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function newBranchGeneration(): BranchGeneration {
  return branchGeneration(createId('branch-ref'));
}

function legacyBranchGeneration(repository: RepositoryId, name: BranchName): BranchGeneration {
  return branchGeneration(`legacy-v2:${repository}:${normalizedRefKey(name)}`);
}

function stale(message: string): never {
  throw new VersionError('STALE_WORKSPACE', message);
}

function missing(
  code: 'REPOSITORY_NOT_FOUND' | 'COMMIT_NOT_FOUND' | 'REF_NOT_FOUND' | 'SHELF_NOT_FOUND' | 'MERGE_DRAFT_NOT_FOUND',
  message: string,
): never {
  throw new VersionError(code, message);
}

function assertRepositoryRevision(repository: VersionRepository, expected: number): void {
  if (repository.revision !== expected) {
    stale(`Repository revision ${expected} is stale; current revision is ${repository.revision}`);
  }
}

function assertRefRevision(ref: VersionRef, expected: number): void {
  if (ref.revision !== expected) {
    stale(`${ref.kind} revision ${expected} is stale; current revision is ${ref.revision}`);
  }
}

function nextRepositoryRevision(repository: VersionRepository, changes: Partial<VersionRepository> = {}): VersionRepository {
  return { ...repository, ...changes, revision: repository.revision + 1 };
}

function toRefRow(ref: VersionRef): RefRow {
  return { ...ref, key: refKey(ref.repositoryId, ref.kind, ref.name) };
}

function fromRefRow(row: RefRow): VersionRef {
  const { key: _key, ...ref } = row;
  if (ref.kind === 'branch' && !ref.generation) {
    return { ...ref, generation: legacyBranchGeneration(ref.repositoryId, ref.name) };
  }
  return ref;
}

function normalizeLimit(limit = 100): number {
  if (!Number.isInteger(limit) || limit < 1) return 100;
  return Math.min(limit, 500);
}

function normalizeBeforeOrdinal(ordinal: number | undefined): number {
  if (ordinal === undefined || !Number.isFinite(ordinal)) return Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(Math.floor(ordinal), 1), Number.MAX_SAFE_INTEGER);
}

function normalizeAccountingLimit(limit = 10_000): number {
  if (!Number.isInteger(limit) || limit < 1) return 10_000;
  return Math.min(limit, 100_000);
}

function storageError(error: unknown): VersionError {
  if (error instanceof VersionError) return error;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new VersionError('STORAGE_QUOTA', 'Version storage quota was exceeded', { cause: error });
  }
  return new VersionError('VERSION_STORE_FAILED', 'Version storage operation failed', {
    cause: error instanceof Error ? error : undefined,
  });
}

function assertPayloadId(actual: string, supplied: string | undefined, label: string): void {
  if (supplied !== undefined && actual !== supplied) {
    throw new VersionError('CORRUPT_BLOB', `${label} does not match its payload`);
  }
}

function preparePayload(payload: Pick<CheckpointPayload, 'bytes' | 'blobId' | 'compareSnapshot' | 'compareSnapshotId'>): {
  blob: VersionBlob;
  compareSnapshot: VersionCompareSnapshot;
} {
  const computedBlobId = hashBytes(payload.bytes);
  const computedSnapshotId = hashCompareSnapshot(payload.compareSnapshot);
  assertPayloadId(computedBlobId, payload.blobId, 'Blob ID');
  assertPayloadId(computedSnapshotId, payload.compareSnapshotId, 'Compare snapshot ID');
  return {
    blob: {
      id: computedBlobId,
      byteLength: payload.bytes.byteLength,
      bytes: new Uint8Array(payload.bytes),
    },
    compareSnapshot: {
      id: computedSnapshotId,
      byteLength: serializeCompareSnapshot(payload.compareSnapshot).byteLength,
      snapshot: cloneValue(payload.compareSnapshot),
    },
  };
}

function commitTitle(title: VersionTitle): VersionTitle {
  const normalizedTitle = title.title.trim();
  if (title.titleOrigin === 'generated') {
    return { ...title, title: normalizedTitle };
  }
  return {
    title: normalizedTitle,
    titleRevision: title.titleRevision,
    titleOrigin: title.titleOrigin,
  };
}

function assertStoredBlob(blob: VersionBlob): VersionBlob {
  const bytes = new Uint8Array(blob.bytes);
  if (hashBytes(bytes) !== blob.id || blob.byteLength !== bytes.byteLength) {
    throw new VersionError('CORRUPT_BLOB', 'Merge draft asset failed verification');
  }
  return { id: blob.id, byteLength: bytes.byteLength, bytes };
}

function isAncestor(
  ancestor: CommitId,
  descendant: CommitId,
  commits: ReadonlyMap<CommitId, VersionCommit>,
): boolean {
  const frontier = [descendant];
  const visited = new Set<CommitId>();
  while (frontier.length > 0) {
    const id = frontier.pop();
    if (!id || visited.has(id)) continue;
    if (id === ancestor) return true;
    visited.add(id);
    frontier.push(...(commits.get(id)?.parents ?? []));
  }
  return false;
}

function nearestCommonAncestors(
  left: CommitId,
  right: CommitId,
  commits: ReadonlyMap<CommitId, VersionCommit>,
): CommitId[] {
  const ancestors = (head: CommitId): Set<CommitId> => {
    const result = new Set<CommitId>();
    const frontier = [head];
    while (frontier.length > 0) {
      const id = frontier.pop();
      if (!id || result.has(id)) continue;
      const commit = commits.get(id);
      if (!commit) continue;
      result.add(id);
      frontier.push(...commit.parents);
    }
    return result;
  };
  const rightAncestors = ancestors(right);
  const common = [...ancestors(left)].filter((id) => rightAncestors.has(id));
  return common
    .filter((candidate) => !common.some((other) => (
      candidate !== other && isAncestor(candidate, other, commits)
    )))
    .sort((a, b) => (
      (commits.get(b)?.ordinal ?? 0) - (commits.get(a)?.ordinal ?? 0)
      || a.localeCompare(b)
    ));
}

function assertCommitInRepository(
  commit: VersionCommit | undefined,
  repositoryId: RepositoryId,
  message = 'Commit was not found in this repository',
): asserts commit is VersionCommit {
  if (!commit || commit.repositoryId !== repositoryId) missing('COMMIT_NOT_FOUND', message);
}

function isDefaultBranch(repository: VersionRepository, name: BranchName): boolean {
  return normalizedRefKey(repository.defaultBranch ?? branchName('main')) === normalizedRefKey(name);
}

function assertDraftMatchesRefs(
  draft: VersionMergeDraft,
  target: BranchRef,
  source: BranchRef,
): void {
  if (
    normalizedRefKey(draft.targetBranch) !== normalizedRefKey(target.name)
    || normalizedRefKey(draft.sourceBranch) !== normalizedRefKey(source.name)
    || draft.currentHead !== target.target
    || draft.sourceHead !== source.target
    || draft.targetBranchRevision !== target.revision
    || draft.sourceBranchRevision !== source.revision
    || (draft.targetBranchGeneration !== undefined && draft.targetBranchGeneration !== target.generation)
    || (draft.sourceBranchGeneration !== undefined && draft.sourceBranchGeneration !== source.generation)
  ) {
    stale('The merge draft no longer matches the branch refs');
  }
  if (draft.conflicts.some((conflict) => !draft.resolutions[conflict.id])) {
    throw new VersionError('MERGE_UNRESOLVED', 'Every merge conflict must be resolved');
  }
}

export class VersionGraphStore {
  readonly #factory: IDBFactory | null;
  #database: Promise<IDBDatabase> | null = null;
  #memory = memoryState();
  #memoryWriteTail: Promise<void> = Promise.resolve();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: VersionGraphStoreOptions = {}) {
    this.#factory = options.indexedDB === null
      ? null
      : options.indexedDB ?? (typeof indexedDB === 'undefined' ? null : indexedDB);
  }

  #openDatabase(): Promise<IDBDatabase> {
    if (!this.#factory) {
      return Promise.reject(new VersionError('VERSION_STORE_FAILED', 'Version database is unavailable'));
    }
    if (this.#database) return this.#database;

    const opening = openIndexedDatabase(
      VERSION_DATABASE_NAME,
      VERSION_DATABASE_VERSION,
      (database, event) => {
        if (!database.objectStoreNames.contains('repositories')) {
          const store = database.createObjectStore('repositories', { keyPath: 'id' });
          store.createIndex('documentId', 'documentId', { unique: true });
        }
        if (!database.objectStoreNames.contains('commits')) {
          const store = database.createObjectStore('commits', { keyPath: 'id' });
          store.createIndex('repositoryId', 'repositoryId');
          store.createIndex('repositoryOrdinal', ['repositoryId', 'ordinal'], { unique: true });
        }
        if (!database.objectStoreNames.contains('refs')) {
          const store = database.createObjectStore('refs', { keyPath: 'key' });
          store.createIndex('repositoryId', 'repositoryId');
        }
        if (!database.objectStoreNames.contains('blobs')) {
          database.createObjectStore('blobs', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('compareSnapshots')) {
          database.createObjectStore('compareSnapshots', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('shelves')) {
          const store = database.createObjectStore('shelves', { keyPath: 'id' });
          store.createIndex('repositoryId', 'repositoryId');
        }
        if (!database.objectStoreNames.contains('mergeManifests')) {
          const store = database.createObjectStore('mergeManifests', { keyPath: 'id' });
          store.createIndex('repositoryId', 'repositoryId');
          store.createIndex('commitId', 'commitId', { unique: true });
        }
        if (!database.objectStoreNames.contains('mergeDrafts')) {
          const store = database.createObjectStore('mergeDrafts', { keyPath: 'id' });
          store.createIndex('repositoryId', 'repositoryId');
          store.createIndex('repositoryUpdatedAt', ['repositoryId', 'updatedAt']);
        }
        if (event.oldVersion > 0 && event.oldVersion < 2) {
          const upgrade = (event.target as IDBOpenDBRequest).transaction;
          const refsCursor = upgrade?.objectStore('refs').openCursor();
          if (refsCursor) refsCursor.onsuccess = () => {
            const cursor = refsCursor.result;
            if (!cursor) return;
            const ref = cursor.value as RefRow;
            if (ref.kind === 'branch' && !ref.generation) {
              cursor.update({
                ...ref,
                generation: legacyBranchGeneration(ref.repositoryId, ref.name),
              });
            }
            cursor.continue();
          };
          const request = upgrade?.objectStore('repositories').openCursor();
          if (request) request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            const repository = cursor.value as VersionRepository;
            const refsRequest = upgrade!
              .objectStore('refs')
              .index('repositoryId')
              .getAll(IDBKeyRange.only(repository.id));
            refsRequest.onsuccess = () => {
              const branches = (refsRequest.result as RefRow[])
                .filter((ref) => ref.kind === 'branch')
                .sort((left, right) => left.name.localeCompare(right.name));
              const main = branches.find((ref) => normalizedRefKey(ref.name) === 'main');
              cursor.update({
                ...repository,
                schemaVersion: 2,
                defaultBranch: branchName(main?.name ?? branches[0]?.name ?? 'main'),
              });
              cursor.continue();
            };
          };
        }
      },
      { indexedDB: this.#factory },
    ).then((database) => {
      if (!database) throw new VersionError('VERSION_STORE_FAILED', 'Version database is unavailable');
      const invalidate = () => {
        if (this.#database === opening) this.#database = null;
      };
      database.onversionchange = () => {
        database.close();
        invalidate();
      };
      database.onclose = invalidate;
      return database;
    });
    this.#database = opening;
    void opening.catch(() => {
      if (this.#database === opening) this.#database = null;
    });
    return opening;
  }

  async close(): Promise<void> {
    const database = this.#database;
    this.#database = null;
    if (!database) return;
    const opened = await database.catch(() => null);
    opened?.close();
  }

  async #transaction<Result>(mode: IDBTransactionMode, operation: (transaction: GraphTransaction) => Promise<Result>): Promise<Result> {
    if (!this.#factory) {
      if (mode === 'readonly') return operation(memoryTransaction(this.#memory));
      const result = this.#memoryWriteTail.catch(() => undefined).then(async () => {
        const working = cloneMemoryState(this.#memory);
        const value = await operation(memoryTransaction(working));
        this.#memory = working;
        return cloneValue(value);
      });
      this.#memoryWriteTail = result.then(() => undefined, () => undefined);
      return result;
    }

    const db = await this.#openDatabase();
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(STORE_NAMES, mode);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'InvalidStateError') {
        if (this.#database) this.#database = null;
        db.close();
      }
      throw storageError(error);
    }
    const done = transactionComplete(transaction);
    try {
      const result = await operation(indexedDbTransaction(transaction));
      await done;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted.
      }
      await done.catch(() => undefined);
      throw storageError(error);
    }
  }

  #serialize<Result>(key: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.#queues.set(key, settled);
    void settled.finally(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return result;
  }

  async createRepository(input: CreateRepositoryInput): Promise<{
    repository: VersionRepository;
    branch: BranchRef;
    commit: VersionCommit;
  }> {
    const id = input.id ?? repositoryId(createId('repository'));
    const initialBranch = branchName(input.initialBranch ?? 'main');
    const payload = preparePayload(input.initial);
    return this.#serialize(`document:${input.documentId}`, () => this.#transaction('readwrite', async (tx) => {
      if (
        await tx.get('repositories', id)
        || await tx.findRepositoryByDocumentId(input.documentId)
      ) {
        throw new VersionError('REPOSITORY_EXISTS', 'This document already has a version repository');
      }

      const initialCommitId = input.initial.id ?? commitId(createId('commit'));
      if (await tx.get('commits', initialCommitId)) {
        throw new VersionError('VERSION_STORE_FAILED', 'Commit ID already exists');
      }

      const createdAt = input.initial.createdAt ?? Date.now();
      const manifest = buildMergeManifest(
        id,
        initialCommitId,
        input.initial.compareSnapshot,
        createdAt,
        [],
        input.initial.mergeManifestEntries,
      );
      const repository: VersionRepository = {
        schemaVersion: 2,
        id,
        documentId: documentId(input.documentId),
        defaultBranch: initialBranch,
        revision: 1,
        nextOrdinal: 2,
        enabledAt: input.enabledAt ?? Date.now(),
        lastSavedFingerprint: contentFingerprint(input.lastSavedFingerprint),
      };
      const commit: VersionCommit = {
        id: initialCommitId,
        repositoryId: id,
        parents: [],
        ordinal: 1,
        blobId: payload.blob.id,
        compareSnapshotId: payload.compareSnapshot.id,
        mergeManifestId: manifest.id,
        contentFingerprint: contentFingerprint(input.initial.contentFingerprint),
        ...commitTitle(input.initial),
        author: cloneValue(input.initial.author),
        reason: 'initial',
        stats: cloneValue(input.initial.stats ?? EMPTY_STATS),
        createdAt,
      };
      const branch: BranchRef = {
        repositoryId: id,
        kind: 'branch',
        name: initialBranch,
        generation: newBranchGeneration(),
        target: commit.id,
        revision: 1,
      };

      await tx.put('blobs', payload.blob);
      await tx.put('compareSnapshots', payload.compareSnapshot);
      await tx.put('mergeManifests', manifest);
      await tx.put('commits', commit);
      await tx.put('repositories', repository);
      await tx.put('refs', toRefRow(branch));
      return { repository, branch, commit };
    }));
  }

  async getRepository(id: RepositoryId): Promise<VersionRepository | null> {
    return this.#transaction('readonly', async (tx) => await tx.get('repositories', id) ?? null);
  }

  async findRepositoryByDocumentId(id: DocumentId): Promise<VersionRepository | null> {
    return this.#transaction('readonly', async (tx) => await tx.findRepositoryByDocumentId(id) ?? null);
  }

  async markSaved(
    repositoryId: RepositoryId,
    fingerprint: ContentFingerprint,
    expectedRepositoryRevision: number,
  ): Promise<VersionRepository> {
    return this.#serialize(repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, expectedRepositoryRevision);
      const normalizedFingerprint = contentFingerprint(fingerprint);
      if (repository.lastSavedFingerprint === normalizedFingerprint) return repository;
      const updated = nextRepositoryRevision(repository, {
        lastSavedFingerprint: normalizedFingerprint,
      });
      await tx.put('repositories', updated);
      return updated;
    }));
  }

  async createCheckpoint(input: CreateCheckpointInput): Promise<{
    repository: VersionRepository;
    branch: BranchRef;
    commit: VersionCommit;
  }> {
    const payload = preparePayload(input);
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, input.expectedRepositoryRevision);

      const branchRow = await tx.get('refs', refKey(input.repositoryId, 'branch', input.branch));
      if (!branchRow || branchRow.kind !== 'branch') missing('REF_NOT_FOUND', 'Branch was not found');
      const branch = fromRefRow(branchRow) as BranchRef;
      assertRefRevision(branch, input.expectedBranchRevision);
      if (input.expectedHead !== undefined && branch.target !== input.expectedHead) {
        stale('The branch head changed');
      }

      const parents: CommitParents = input.parents ?? [branch.target];
      if (parents[0] !== branch.target) stale('The first parent must be the current branch head');
      if (parents.length === 2 && parents[0] === parents[1]) {
        throw new VersionError('VERSION_STORE_FAILED', 'Merge parents must be distinct');
      }
      const parentCommits: VersionCommit[] = [];
      for (const parent of parents) {
        const parentCommit = await tx.get('commits', parent);
        if (!parentCommit || parentCommit.repositoryId !== input.repositoryId) {
          missing('COMMIT_NOT_FOUND', `Parent commit ${parent} was not found in this repository`);
        }
        parentCommits.push(parentCommit);
      }

      const id = input.id ?? commitId(createId('commit'));
      if (await tx.get('commits', id)) {
        throw new VersionError('VERSION_STORE_FAILED', 'Commit ID already exists');
      }
      const createdAt = input.createdAt ?? Date.now();
      const parentManifests = (await Promise.all(parentCommits.map(async (parent) => (
        parent.mergeManifestId ? await tx.get('mergeManifests', parent.mergeManifestId) : undefined
      )))).filter((manifest): manifest is VersionMergeManifest => Boolean(manifest));
      const manifest = buildMergeManifest(
        input.repositoryId,
        id,
        input.compareSnapshot,
        createdAt,
        parentManifests,
        input.mergeManifestEntries,
      );
      const commit: VersionCommit = {
        id,
        repositoryId: input.repositoryId,
        parents,
        ordinal: repository.nextOrdinal,
        blobId: payload.blob.id,
        compareSnapshotId: payload.compareSnapshot.id,
        mergeManifestId: manifest.id,
        contentFingerprint: contentFingerprint(input.contentFingerprint),
        ...commitTitle(input),
        author: cloneValue(input.author),
        reason: input.reason,
        stats: cloneValue(input.stats ?? EMPTY_STATS),
        createdAt,
        ...(input.merge ? { merge: cloneValue(input.merge) } : {}),
      };
      const updatedRepository = nextRepositoryRevision(repository, {
        nextOrdinal: repository.nextOrdinal + 1,
        lastSavedFingerprint: input.lastSavedFingerprint ?? repository.lastSavedFingerprint,
      });
      const updatedBranch: BranchRef = {
        ...branch,
        target: id,
        revision: branch.revision + 1,
      };

      if (!await tx.get('blobs', payload.blob.id)) await tx.put('blobs', payload.blob);
      if (!await tx.get('compareSnapshots', payload.compareSnapshot.id)) {
        await tx.put('compareSnapshots', payload.compareSnapshot);
      }
      if (!await tx.get('mergeManifests', manifest.id)) await tx.put('mergeManifests', manifest);
      await tx.put('commits', commit);
      await tx.put('repositories', updatedRepository);
      await tx.put('refs', toRefRow(updatedBranch));
      return { repository: updatedRepository, branch: updatedBranch, commit };
    }));
  }

  async getCommit(id: CommitId): Promise<VersionCommit | null> {
    return this.#transaction('readonly', async (tx) => await tx.get('commits', id) ?? null);
  }

  async listCommits(id: RepositoryId, options: CommitPageOptions = {}): Promise<VersionCommit[]> {
    const before = normalizeBeforeOrdinal(options.beforeOrdinal);
    if (before <= 1) return [];
    return this.#transaction('readonly', (tx) => tx.listCommits(
      id,
      before,
      normalizeLimit(options.limit),
    ));
  }

  async findMergeBases(
    repositoryId: RepositoryId,
    currentHead: CommitId,
    incomingHead: CommitId,
  ): Promise<CommitId[]> {
    return this.#transaction('readonly', async (tx) => {
      if (!await tx.get('repositories', repositoryId)) {
        missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      }
      const commits = (await tx.getAll('commits'))
        .filter((commit) => commit.repositoryId === repositoryId);
      const byId = new Map(commits.map((commit) => [commit.id, commit]));
      assertCommitInRepository(byId.get(currentHead), repositoryId, 'Current merge head was not found');
      assertCommitInRepository(byId.get(incomingHead), repositoryId, 'Incoming merge head was not found');
      return nearestCommonAncestors(currentHead, incomingHead, byId);
    });
  }

  async getMergeRelation(
    repositoryId: RepositoryId,
    currentHead: CommitId,
    incomingHead: CommitId,
  ): Promise<MergeRelationResult> {
    return this.#transaction('readonly', async (tx) => {
      if (!await tx.get('repositories', repositoryId)) {
        missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      }
      const commits = (await tx.getAll('commits'))
        .filter((commit) => commit.repositoryId === repositoryId);
      const byId = new Map(commits.map((commit) => [commit.id, commit]));
      assertCommitInRepository(byId.get(currentHead), repositoryId, 'Current merge head was not found');
      assertCommitInRepository(byId.get(incomingHead), repositoryId, 'Incoming merge head was not found');
      const relation: MergeRelation = isAncestor(incomingHead, currentHead, byId)
        ? 'already-integrated'
        : isAncestor(currentHead, incomingHead, byId)
          ? 'fast-forward'
          : 'diverged';
      return {
        relation,
        baseCommitIds: nearestCommonAncestors(currentHead, incomingHead, byId),
      };
    });
  }

  async getMergeManifest(id: VersionMergeManifest['id']): Promise<VersionMergeManifest | null> {
    return this.#transaction('readonly', async (tx) => await tx.get('mergeManifests', id) ?? null);
  }

  /**
   * Persists a parser-derived full-document manifest and atomically attaches it
   * to its commit. Parents must already have full manifests, which makes a
   * caller's oldest-to-newest legacy walk deterministic.
   */
  async putFullMergeManifest(
    repositoryId: RepositoryId,
    targetCommitId: CommitId,
    entries: readonly MergeManifestEntrySeed[],
  ): Promise<VersionMergeManifest> {
    return this.#serialize(repositoryId, () => this.#transaction('readwrite', async (tx) => {
      if (!await tx.get('repositories', repositoryId)) {
        missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      }
      const commit = await tx.get('commits', targetCommitId);
      assertCommitInRepository(commit, repositoryId);
      const parentManifests: VersionMergeManifest[] = [];
      for (const parentId of commit.parents) {
        const parent = await tx.get('commits', parentId);
        assertCommitInRepository(parent, repositoryId, 'Manifest parent was not found');
        const parentManifest = parent.mergeManifestId
          ? await tx.get('mergeManifests', parent.mergeManifestId)
          : undefined;
        if (
          !parentManifest
          || parentManifest.analysisVersion !== MERGE_MANIFEST_VERSION
          || parentManifest.coverage !== 'full-document'
        ) {
          throw new VersionError(
            'VERSION_STORE_FAILED',
            `Full merge manifest parent ${parentId} must be generated first`,
          );
        }
        parentManifests.push(parentManifest);
      }
      const snapshot = await tx.get('compareSnapshots', commit.compareSnapshotId);
      if (!snapshot || hashCompareSnapshot(snapshot.snapshot) !== snapshot.id) {
        throw new VersionError('CORRUPT_BLOB', `Comparison snapshot for commit ${targetCommitId} is missing or corrupt`);
      }
      const manifest = buildMergeManifest(
        repositoryId,
        targetCommitId,
        snapshot.snapshot,
        commit.createdAt,
        parentManifests,
        entries,
      );
      if (!await tx.get('mergeManifests', manifest.id)) await tx.put('mergeManifests', manifest);
      if (commit.mergeManifestId !== manifest.id) {
        await tx.put('commits', { ...commit, mergeManifestId: manifest.id });
      }
      return manifest;
    }));
  }

  async ensureMergeManifest(
    repositoryId: RepositoryId,
    commitId: CommitId,
  ): Promise<VersionMergeManifest> {
    return this.#serialize(repositoryId, () => this.#transaction('readwrite', async (tx) => {
      if (!await tx.get('repositories', repositoryId)) {
        missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      }
      const repositoryCommits = (await tx.getAll('commits'))
        .filter((commit) => commit.repositoryId === repositoryId);
      const byId = new Map(repositoryCommits.map((commit) => [commit.id, commit]));
      assertCommitInRepository(byId.get(commitId), repositoryId);
      const storedManifests = (await tx.getAll('mergeManifests'))
        .filter((manifest) => manifest.repositoryId === repositoryId);
      const manifestByCommit = new Map(storedManifests.map((manifest) => [manifest.commitId, manifest]));
      const visiting = new Set<CommitId>();
      const ensure = async (id: CommitId): Promise<VersionMergeManifest> => {
        const commit = byId.get(id);
        assertCommitInRepository(commit, repositoryId);
        if (visiting.has(id)) {
          throw new VersionError('VERSION_STORE_FAILED', 'Commit graph contains a parent cycle');
        }
        visiting.add(id);
        const parentManifests: VersionMergeManifest[] = [];
        for (const parent of commit.parents) parentManifests.push(await ensure(parent));
        const existing = manifestByCommit.get(id);
        const parentManifestIds = parentManifests.map((manifest) => manifest.id);
        if (
          existing
          && existing.analysisVersion === MERGE_MANIFEST_VERSION
          && JSON.stringify(existing.parentManifestIds ?? []) === JSON.stringify(parentManifestIds)
        ) {
          if (commit.mergeManifestId !== existing.id) {
            const updated = { ...commit, mergeManifestId: existing.id };
            byId.set(id, updated);
            await tx.put('commits', updated);
          }
          visiting.delete(id);
          return existing;
        }
        const snapshot = await tx.get('compareSnapshots', commit.compareSnapshotId);
        if (!snapshot || hashCompareSnapshot(snapshot.snapshot) !== snapshot.id) {
          throw new VersionError('CORRUPT_BLOB', `Comparison snapshot for commit ${id} is missing or corrupt`);
        }
        const manifest = buildMergeManifest(
          repositoryId,
          id,
          snapshot.snapshot,
          commit.createdAt,
          parentManifests,
        );
        const updated = { ...commit, mergeManifestId: manifest.id };
        if (existing && existing.id !== manifest.id) await tx.delete('mergeManifests', existing.id);
        await tx.put('mergeManifests', manifest);
        await tx.put('commits', updated);
        byId.set(id, updated);
        manifestByCommit.set(id, manifest);
        visiting.delete(id);
        return manifest;
      };
      return ensure(commitId);
    }));
  }

  async getMergeDraft(id: MergeDraftId): Promise<VersionMergeDraft | null> {
    return this.#transaction('readonly', async (tx) => await tx.get('mergeDrafts', id) ?? null);
  }

  async listMergeDrafts(repositoryId: RepositoryId): Promise<VersionMergeDraft[]> {
    return this.#transaction('readonly', async (tx) => (
      (await tx.listMergeDrafts(repositoryId))
        .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    ));
  }

  async putMergeDraft(input: PutMergeDraftInput): Promise<VersionMergeDraft> {
    return this.#serialize(input.draft.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.draft.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      const id = mergeDraftId(input.draft.id);
      const existing = await tx.get('mergeDrafts', id);
      if (input.expectedUpdatedAt === null && existing) stale('The merge draft already exists');
      if (typeof input.expectedUpdatedAt === 'number' && !existing) {
        missing('MERGE_DRAFT_NOT_FOUND', 'Merge draft was not found');
      }
      if (typeof input.expectedUpdatedAt === 'number' && existing?.updatedAt !== input.expectedUpdatedAt) {
        stale('The merge draft changed');
      }
      for (const head of [
        ...input.draft.baseCommitIds,
        input.draft.currentHead,
        input.draft.sourceHead,
      ]) {
        assertCommitInRepository(await tx.get('commits', head), input.draft.repositoryId);
      }
      for (const branch of [input.draft.targetBranch, input.draft.sourceBranch]) {
        const row = await tx.get('refs', refKey(input.draft.repositoryId, 'branch', branch));
        if (!row || row.kind !== 'branch') missing('REF_NOT_FOUND', `Merge branch ${branch} was not found`);
      }
      const assets = new Map((input.assetBlobs ?? []).map((blob) => {
        const verified = assertStoredBlob(blob);
        return [verified.id, verified];
      }));
      for (const assetId of input.draft.manualAssetBlobIds) {
        if (!assets.has(assetId) && !await tx.get('blobs', assetId)) {
          throw new VersionError('CORRUPT_BLOB', `Merge draft asset ${assetId} was not found`);
        }
      }
      for (const asset of assets.values()) {
        if (!await tx.get('blobs', asset.id)) await tx.put('blobs', asset);
      }
      const now = Date.now();
      const draft: VersionMergeDraft = {
        ...cloneValue(input.draft),
        id,
        repositoryId: repository.id,
        targetBranch: branchName(input.draft.targetBranch),
        sourceBranch: branchName(input.draft.sourceBranch),
        createdAt: existing?.createdAt ?? input.draft.createdAt,
        updatedAt: Math.max(input.draft.updatedAt, now, (existing?.updatedAt ?? 0) + 1),
      };
      if (draft.historyIndex < 0 || draft.historyIndex > draft.history.length) {
        throw new VersionError('VERSION_STORE_FAILED', 'Merge draft history index is invalid');
      }
      await tx.put('mergeDrafts', draft);
      return draft;
    }));
  }

  async deleteMergeDraft(
    repositoryId: RepositoryId,
    id: MergeDraftId,
    expectedUpdatedAt?: number,
  ): Promise<void> {
    await this.#serialize(repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const draft = await tx.get('mergeDrafts', id);
      if (!draft || draft.repositoryId !== repositoryId) {
        missing('MERGE_DRAFT_NOT_FOUND', 'Merge draft was not found');
      }
      if (expectedUpdatedAt !== undefined && draft.updatedAt !== expectedUpdatedAt) {
        stale('The merge draft changed');
      }
      await tx.delete('mergeDrafts', id);
    }));
  }

  async getRepositoryStorageUsage(
    id: RepositoryId,
    options: RepositoryStorageUsageOptions = {},
  ): Promise<RepositoryStorageUsage> {
    const maxCommits = normalizeAccountingLimit(options.maxCommits);
    const maxShelves = normalizeAccountingLimit(options.maxShelves);
    return this.#transaction('readonly', async (tx) => {
      if (!await tx.get('repositories', id)) {
        missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      }
      const commitRows = await tx.listCommits(id, Number.MAX_SAFE_INTEGER, maxCommits + 1);
      const commitTruncated = commitRows.length > maxCommits;
      const commits = commitTruncated ? commitRows.slice(0, maxCommits) : commitRows;
      const shelfRows = await tx.listShelves(id, maxShelves + 1);
      const shelfTruncated = shelfRows.length > maxShelves;
      const shelves = shelfTruncated ? shelfRows.slice(0, maxShelves) : shelfRows;
      const drafts = await tx.listMergeDrafts(id);
      const blobIds = new Set([
        ...commits.map((commit) => commit.blobId),
        ...shelves.map((shelf) => shelf.blobId),
        ...drafts.flatMap((draft) => draft.manualAssetBlobIds),
      ]);
      const compareSnapshotIds = new Set([
        ...commits.map((commit) => commit.compareSnapshotId),
        ...shelves.map((shelf) => shelf.compareSnapshotId),
      ]);
      const [blobs, snapshots] = await Promise.all([
        Promise.all([...blobIds].map((blob) => tx.get('blobs', blob))),
        Promise.all([...compareSnapshotIds].map((snapshot) => tx.get('compareSnapshots', snapshot))),
      ]);
      const blobBytes = blobs.reduce((total, blob) => total + (blob?.byteLength ?? 0), 0);
      const compareSnapshotBytes = snapshots.reduce(
        (total, snapshot) => total + (snapshot?.byteLength ?? 0),
        0,
      );
      return {
        totalBytes: blobBytes + compareSnapshotBytes,
        blobBytes,
        compareSnapshotBytes,
        blobCount: blobs.filter(Boolean).length,
        compareSnapshotCount: snapshots.filter(Boolean).length,
        commitCount: commits.length,
        shelfCount: shelves.length,
        commitTruncated,
        shelfTruncated,
        truncated: commitTruncated || shelfTruncated,
      };
    });
  }

  async getBlob(id: BlobId): Promise<VersionBlob | null> {
    return this.#transaction('readonly', async (tx) => {
      const blob = await tx.get('blobs', id);
      if (!blob) return null;
      if (hashBytes(blob.bytes) !== blob.id || blob.byteLength !== blob.bytes.byteLength) {
        throw new VersionError('CORRUPT_BLOB', 'Stored version bytes failed verification');
      }
      return blob;
    });
  }

  async getCompareSnapshot(id: CompareSnapshotId): Promise<VersionCompareSnapshot | null> {
    return this.#transaction('readonly', async (tx) => {
      const snapshot = await tx.get('compareSnapshots', id);
      if (!snapshot) return null;
      if (hashCompareSnapshot(snapshot.snapshot) !== compareSnapshotId(snapshot.id)) {
        throw new VersionError('CORRUPT_BLOB', 'Stored comparison snapshot failed verification');
      }
      return snapshot;
    });
  }

  async listRefs(id: RepositoryId): Promise<VersionRef[]> {
    return this.#transaction('readonly', async (tx) => (
      (await tx.listRefs(id))
        .map(fromRefRow)
        .sort((left, right) => (
          left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)
        ))
    ));
  }

  async getBranch(id: RepositoryId, name: BranchName): Promise<BranchRef | null> {
    return this.#transaction('readonly', async (tx) => {
      const row = await tx.get('refs', refKey(id, 'branch', name));
      return row?.kind === 'branch' ? fromRefRow(row) as BranchRef : null;
    });
  }

  async moveBranchGuarded(input: MoveBranchInput): Promise<{
    repository: VersionRepository;
    branch: BranchRef;
  }> {
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, input.expectedRepositoryRevision);
      const key = refKey(input.repositoryId, 'branch', input.branch);
      const row = await tx.get('refs', key);
      if (!row || row.kind !== 'branch') missing('REF_NOT_FOUND', 'Branch was not found');
      const branch = fromRefRow(row) as BranchRef;
      assertRefRevision(branch, input.expectedBranchRevision);
      if (branch.target !== input.expectedHead) stale('The branch head changed');
      assertCommitInRepository(await tx.get('commits', input.target), input.repositoryId);
      if (branch.target === input.target) return { repository, branch };
      const updatedBranch: BranchRef = {
        ...branch,
        target: input.target,
        revision: branch.revision + 1,
      };
      const updatedRepository = nextRepositoryRevision(repository);
      await tx.put('refs', toRefRow(updatedBranch));
      await tx.put('repositories', updatedRepository);
      return { repository: updatedRepository, branch: updatedBranch };
    }));
  }

  /** Atomically advances the target ref, optionally removes the source ref, and consumes its draft. */
  async completeFastForwardMerge(input: CompleteFastForwardMergeInput): Promise<{
    repository: VersionRepository;
    branch: BranchRef;
    sourceBranch: BranchRef | null;
  }> {
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, input.expectedRepositoryRevision);
      if (normalizedRefKey(input.branch) === normalizedRefKey(input.sourceBranch)) {
        throw new VersionError('VERSION_STORE_FAILED', 'Merge source and target branches must be distinct');
      }
      const targetKey = refKey(input.repositoryId, 'branch', input.branch);
      const targetRow = await tx.get('refs', targetKey);
      if (!targetRow || targetRow.kind !== 'branch') missing('REF_NOT_FOUND', 'Merge target branch was not found');
      const targetBranch = fromRefRow(targetRow) as BranchRef;
      assertRefRevision(targetBranch, input.expectedBranchRevision);
      if (targetBranch.target !== input.expectedHead) stale('The merge target head changed');
      const sourceKey = refKey(input.repositoryId, 'branch', input.sourceBranch);
      const sourceRow = await tx.get('refs', sourceKey);
      if (!sourceRow || sourceRow.kind !== 'branch') missing('REF_NOT_FOUND', 'Merge source branch was not found');
      const sourceBranch = fromRefRow(sourceRow) as BranchRef;
      assertRefRevision(sourceBranch, input.expectedSourceRevision);
      if (sourceBranch.target !== input.target) stale('The merge source head changed');
      const commits = (await tx.getAll('commits'))
        .filter((commit) => commit.repositoryId === input.repositoryId);
      const byId = new Map(commits.map((commit) => [commit.id, commit]));
      assertCommitInRepository(byId.get(input.target), input.repositoryId);
      if (!isAncestor(targetBranch.target, sourceBranch.target, byId) || targetBranch.target === sourceBranch.target) {
        throw new VersionError('STALE_WORKSPACE', 'The branches no longer have a fast-forward relationship');
      }
      if (input.deleteSource && isDefaultBranch(repository, sourceBranch.name)) {
        throw new VersionError('DEFAULT_BRANCH', 'The default branch cannot be deleted');
      }
      if (input.draftId) {
        const draft = await tx.get('mergeDrafts', input.draftId);
        if (!draft || draft.repositoryId !== input.repositoryId) {
          missing('MERGE_DRAFT_NOT_FOUND', 'Merge draft was not found');
        }
        assertDraftMatchesRefs(draft, targetBranch, sourceBranch);
      }
      const updatedBranch: BranchRef = {
        ...targetBranch,
        target: sourceBranch.target,
        revision: targetBranch.revision + 1,
      };
      const updatedRepository = nextRepositoryRevision(repository);
      await tx.put('refs', toRefRow(updatedBranch));
      if (input.deleteSource) await tx.delete('refs', sourceKey);
      if (input.draftId) await tx.delete('mergeDrafts', input.draftId);
      await tx.put('repositories', updatedRepository);
      return {
        repository: updatedRepository,
        branch: updatedBranch,
        sourceBranch: input.deleteSource ? null : sourceBranch,
      };
    }));
  }

  /** Creates a two-parent merge checkpoint and updates all related refs in one IDB transaction. */
  async completeMergeCheckpoint(input: CompleteMergeCheckpointInput): Promise<{
    repository: VersionRepository;
    branch: BranchRef;
    sourceBranch: BranchRef | null;
    commit: VersionCommit;
  }> {
    const payload = preparePayload(input);
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, input.expectedRepositoryRevision);
      if (normalizedRefKey(input.branch) === normalizedRefKey(input.sourceBranch)) {
        throw new VersionError('VERSION_STORE_FAILED', 'Merge source and target branches must be distinct');
      }
      const targetKey = refKey(input.repositoryId, 'branch', input.branch);
      const targetRow = await tx.get('refs', targetKey);
      if (!targetRow || targetRow.kind !== 'branch') missing('REF_NOT_FOUND', 'Merge target branch was not found');
      const targetBranch = fromRefRow(targetRow) as BranchRef;
      assertRefRevision(targetBranch, input.expectedBranchRevision);
      if (targetBranch.target !== input.expectedHead) stale('The merge target head changed');
      const sourceKey = refKey(input.repositoryId, 'branch', input.sourceBranch);
      const sourceRow = await tx.get('refs', sourceKey);
      if (!sourceRow || sourceRow.kind !== 'branch') missing('REF_NOT_FOUND', 'Merge source branch was not found');
      const sourceBranch = fromRefRow(sourceRow) as BranchRef;
      assertRefRevision(sourceBranch, input.expectedSourceRevision);
      if (targetBranch.target === sourceBranch.target) {
        throw new VersionError('VERSION_STORE_FAILED', 'Merge parents must be distinct');
      }
      if (input.deleteSource && isDefaultBranch(repository, sourceBranch.name)) {
        throw new VersionError('DEFAULT_BRANCH', 'The default branch cannot be deleted');
      }
      if (
        input.merge.sourceBranchAtMerge !== sourceBranch.name
        || input.merge.targetBranchAtMerge !== targetBranch.name
      ) {
        throw new VersionError('VERSION_STORE_FAILED', 'Merge metadata does not match the branch refs');
      }
      for (const base of input.merge.baseCommitIds) {
        assertCommitInRepository(await tx.get('commits', base), input.repositoryId, 'Merge base was not found');
      }
      const parents: CommitParents = [targetBranch.target, sourceBranch.target];
      const parentCommits = await Promise.all(parents.map(async (parent) => {
        const commit = await tx.get('commits', parent);
        assertCommitInRepository(commit, input.repositoryId, 'Merge parent was not found');
        return commit;
      }));
      if (input.draftId) {
        const draft = await tx.get('mergeDrafts', input.draftId);
        if (!draft || draft.repositoryId !== input.repositoryId) {
          missing('MERGE_DRAFT_NOT_FOUND', 'Merge draft was not found');
        }
        assertDraftMatchesRefs(draft, targetBranch, sourceBranch);
      }
      const id = input.id ?? commitId(createId('commit'));
      if (await tx.get('commits', id)) {
        throw new VersionError('VERSION_STORE_FAILED', 'Commit ID already exists');
      }
      const createdAt = input.createdAt ?? Date.now();
      const parentManifests = (await Promise.all(parentCommits.map(async (parent) => (
        parent.mergeManifestId ? await tx.get('mergeManifests', parent.mergeManifestId) : undefined
      )))).filter((manifest): manifest is VersionMergeManifest => Boolean(manifest));
      const manifest = buildMergeManifest(
        input.repositoryId,
        id,
        input.compareSnapshot,
        createdAt,
        parentManifests,
        input.mergeManifestEntries,
      );
      const commit: VersionCommit = {
        id,
        repositoryId: input.repositoryId,
        parents,
        ordinal: repository.nextOrdinal,
        blobId: payload.blob.id,
        compareSnapshotId: payload.compareSnapshot.id,
        mergeManifestId: manifest.id,
        contentFingerprint: contentFingerprint(input.contentFingerprint),
        ...commitTitle(input),
        author: cloneValue(input.author),
        reason: 'merge',
        stats: cloneValue(input.stats ?? EMPTY_STATS),
        createdAt,
        merge: cloneValue(input.merge),
      };
      const updatedBranch: BranchRef = {
        ...targetBranch,
        target: commit.id,
        revision: targetBranch.revision + 1,
      };
      const updatedRepository = nextRepositoryRevision(repository, {
        nextOrdinal: repository.nextOrdinal + 1,
        lastSavedFingerprint: input.lastSavedFingerprint ?? repository.lastSavedFingerprint,
      });
      if (!await tx.get('blobs', payload.blob.id)) await tx.put('blobs', payload.blob);
      if (!await tx.get('compareSnapshots', payload.compareSnapshot.id)) {
        await tx.put('compareSnapshots', payload.compareSnapshot);
      }
      await tx.put('mergeManifests', manifest);
      await tx.put('commits', commit);
      await tx.put('refs', toRefRow(updatedBranch));
      if (input.deleteSource) await tx.delete('refs', sourceKey);
      if (input.draftId) await tx.delete('mergeDrafts', input.draftId);
      await tx.put('repositories', updatedRepository);
      return {
        repository: updatedRepository,
        branch: updatedBranch,
        sourceBranch: input.deleteSource ? null : sourceBranch,
        commit,
      };
    }));
  }

  /**
   * Atomically restores target/source branch state for merge Undo/Redo. Refs that
   * remain present advance their revisions; recreated refs start at revision 1.
   */
  async restoreCompositeRefs(input: RestoreCompositeRefsInput): Promise<{
    repository: VersionRepository;
    targetBranch: BranchRef;
    sourceBranch: BranchRef | null;
  }> {
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      if (!input.allowRepositoryRevisionAdvance) {
        assertRepositoryRevision(repository, input.expectedRepositoryRevision);
      } else if (repository.revision < input.expectedRepositoryRevision) {
        stale(`Repository revision ${input.expectedRepositoryRevision} is ahead of current revision ${repository.revision}`);
      }
      if (normalizedRefKey(input.targetBranch) === normalizedRefKey(input.sourceBranch)) {
        throw new VersionError('VERSION_STORE_FAILED', 'Composite refs must name distinct branches');
      }
      const targetKey = refKey(input.repositoryId, 'branch', input.targetBranch);
      const targetRow = await tx.get('refs', targetKey);
      if (!targetRow || targetRow.kind !== 'branch') missing('REF_NOT_FOUND', 'Composite target branch was not found');
      const currentTarget = fromRefRow(targetRow) as BranchRef;
      assertRefRevision(currentTarget, input.expectedTarget.revision);
      if (currentTarget.target !== input.expectedTarget.target) stale('The composite target head changed');
      const sourceKey = refKey(input.repositoryId, 'branch', input.sourceBranch);
      const sourceRow = await tx.get('refs', sourceKey);
      const currentSource = sourceRow?.kind === 'branch' ? fromRefRow(sourceRow) as BranchRef : null;
      if (input.expectedSource === null) {
        if (currentSource) stale('The composite source branch was recreated');
      } else {
        if (!currentSource) stale('The composite source branch was deleted');
        assertRefRevision(currentSource, input.expectedSource.revision);
        if (currentSource.generation !== input.expectedSource.generation) stale('The composite source branch was replaced');
        if (currentSource.target !== input.expectedSource.target) stale('The composite source head changed');
      }
      if (currentTarget.generation !== input.expectedTarget.generation) stale('The composite target branch was replaced');
      assertCommitInRepository(await tx.get('commits', input.restoreTarget), input.repositoryId);
      if (input.restoreSource) {
        assertCommitInRepository(await tx.get('commits', input.restoreSource.target), input.repositoryId);
      }
      if (currentSource && !input.restoreSource && isDefaultBranch(repository, currentSource.name)) {
        throw new VersionError('DEFAULT_BRANCH', 'The default branch cannot be deleted');
      }
      const targetBranch: BranchRef = currentTarget.target === input.restoreTarget
        ? currentTarget
        : { ...currentTarget, target: input.restoreTarget, revision: currentTarget.revision + 1 };
      let sourceBranch: BranchRef | null = null;
      if (input.restoreSource) {
        sourceBranch = currentSource
          ? currentSource.target === input.restoreSource.target
            ? currentSource
            : { ...currentSource, target: input.restoreSource.target, revision: currentSource.revision + 1 }
          : {
              repositoryId: input.repositoryId,
              kind: 'branch',
              name: branchName(input.sourceBranch),
              generation: input.restoreSource.generation,
              target: input.restoreSource.target,
              revision: Math.max(0, input.restoreSource.minimumRevision ?? 0) + 1,
            };
      }
      const sourceChanged = currentSource?.target !== sourceBranch?.target || Boolean(currentSource) !== Boolean(sourceBranch);
      const changed = targetBranch.target !== currentTarget.target || sourceChanged;
      if (!changed) return { repository, targetBranch, sourceBranch };
      await tx.put('refs', toRefRow(targetBranch));
      if (sourceBranch) await tx.put('refs', toRefRow(sourceBranch));
      else await tx.delete('refs', sourceKey);
      const updatedRepository = nextRepositoryRevision(repository);
      await tx.put('repositories', updatedRepository);
      return { repository: updatedRepository, targetBranch, sourceBranch };
    }));
  }

  async createBranch(input: CreateBranchInput): Promise<{ repository: VersionRepository; branch: BranchRef }> {
    const name = branchName(input.name);
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, input.expectedRepositoryRevision);
      if (await tx.get('refs', refKey(input.repositoryId, 'branch', name))) {
        throw new VersionError('BRANCH_EXISTS', `Branch ${name} already exists`);
      }
      const target = await tx.get('commits', input.target);
      if (!target || target.repositoryId !== input.repositoryId) {
        missing('COMMIT_NOT_FOUND', 'Branch target was not found in this repository');
      }
      const branch: BranchRef = {
        repositoryId: input.repositoryId,
        kind: 'branch',
        name,
        generation: newBranchGeneration(),
        target: input.target,
        revision: 1,
      };
      const updatedRepository = nextRepositoryRevision(repository);
      await tx.put('refs', toRefRow(branch));
      await tx.put('repositories', updatedRepository);
      return { repository: updatedRepository, branch };
    }));
  }

  async renameBranch(input: RenameBranchInput): Promise<{ repository: VersionRepository; branch: BranchRef }> {
    const name = branchName(input.name);
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, input.expectedRepositoryRevision);
      const oldKey = refKey(input.repositoryId, 'branch', input.branch);
      const row = await tx.get('refs', oldKey);
      if (!row || row.kind !== 'branch') missing('REF_NOT_FOUND', 'Branch was not found');
      const current = fromRefRow(row) as BranchRef;
      assertRefRevision(current, input.expectedBranchRevision);
      const newKey = refKey(input.repositoryId, 'branch', name);
      if (newKey !== oldKey && await tx.get('refs', newKey)) {
        throw new VersionError('BRANCH_EXISTS', `Branch ${name} already exists`);
      }
      const branch: BranchRef = { ...current, name, revision: current.revision + 1 };
      const updatedRepository = nextRepositoryRevision(repository, isDefaultBranch(repository, current.name)
        ? { defaultBranch: name }
        : {});
      await tx.delete('refs', oldKey);
      await tx.put('refs', toRefRow(branch));
      await tx.put('repositories', updatedRepository);
      return { repository: updatedRepository, branch };
    }));
  }

  async deleteBranch(input: DeleteBranchInput): Promise<VersionRepository> {
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, input.expectedRepositoryRevision);
      if (normalizedRefKey(input.branch) === normalizedRefKey(input.currentBranch)) {
        throw new VersionError('CURRENT_BRANCH', 'The current branch cannot be deleted');
      }
      if (isDefaultBranch(repository, input.branch)) {
        throw new VersionError('DEFAULT_BRANCH', 'The default branch cannot be deleted');
      }
      const key = refKey(input.repositoryId, 'branch', input.branch);
      const row = await tx.get('refs', key);
      if (!row || row.kind !== 'branch') missing('REF_NOT_FOUND', 'Branch was not found');
      assertRefRevision(fromRefRow(row), input.expectedBranchRevision);

      const refs = (await tx.getAll('refs')).filter((ref) => ref.repositoryId === input.repositoryId);
      if (refs.filter((ref) => ref.kind === 'branch').length <= 1) {
        throw new VersionError('LAST_BRANCH', 'The final branch cannot be deleted');
      }
      await tx.delete('refs', key);
      const updatedRepository = nextRepositoryRevision(repository);
      await tx.put('repositories', updatedRepository);
      return updatedRepository;
    }));
  }

  async collectGarbage(
    repositoryId: RepositoryId,
    expectedRepositoryRevision: number,
  ): Promise<CollectGarbageResult> {
    return this.#serialize(repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, expectedRepositoryRevision);

      const refs = (await tx.getAll('refs')).filter((ref) => ref.repositoryId === repositoryId);
      const allCommits = await tx.getAll('commits');
      const repositoryCommits = allCommits.filter((commit) => commit.repositoryId === repositoryId);
      const commitById = new Map(repositoryCommits.map((commit) => [commit.id, commit]));
      const shelves = await tx.getAll('shelves');
      const repositoryShelves = shelves.filter((shelf) => shelf.repositoryId === repositoryId);
      const drafts = await tx.getAll('mergeDrafts');
      const repositoryDrafts = drafts.filter((draft) => draft.repositoryId === repositoryId);
      const reachable = new Set<CommitId>();
      const frontier = [
        ...refs.map((ref) => ref.target),
        ...repositoryShelves.map((shelf) => shelf.baseCommitId),
        ...repositoryDrafts.flatMap((draft) => [
          draft.currentHead,
          draft.sourceHead,
          ...draft.baseCommitIds,
        ]),
      ];
      while (frontier.length > 0) {
        const id = frontier.pop();
        if (!id || reachable.has(id)) continue;
        const commit = commitById.get(id);
        if (!commit) continue;
        reachable.add(id);
        frontier.push(...commit.parents);
      }

      const removedCommits = repositoryCommits.filter((commit) => !reachable.has(commit.id));
      const removedIds = new Set(removedCommits.map((commit) => commit.id));
      const remainingCommits = allCommits.filter((commit) => !removedIds.has(commit.id));
      const referencedBlobs = new Set([
        ...remainingCommits.map((commit) => commit.blobId),
        ...shelves.map((shelf) => shelf.blobId),
        ...drafts.flatMap((draft) => draft.manualAssetBlobIds),
      ]);
      const referencedSnapshots = new Set([
        ...remainingCommits.map((commit) => commit.compareSnapshotId),
        ...shelves.map((shelf) => shelf.compareSnapshotId),
      ]);
      const blobsToDelete = new Set(
        (await tx.getAll('blobs')).map((blob) => blob.id).filter((id) => !referencedBlobs.has(id)),
      );
      const snapshotsToDelete = new Set(
        (await tx.getAll('compareSnapshots'))
          .map((snapshot) => snapshot.id)
          .filter((id) => !referencedSnapshots.has(id)),
      );
      const referencedManifestIds = new Set(
        remainingCommits.flatMap((commit) => commit.mergeManifestId ? [commit.mergeManifestId] : []),
      );
      const manifestsToDelete = (await tx.getAll('mergeManifests'))
        .filter((manifest) => !referencedManifestIds.has(manifest.id));

      for (const commit of removedCommits) await tx.delete('commits', commit.id);
      for (const id of blobsToDelete) await tx.delete('blobs', id);
      for (const id of snapshotsToDelete) await tx.delete('compareSnapshots', id);
      for (const manifest of manifestsToDelete) await tx.delete('mergeManifests', manifest.id);

      const garbageCollected = {
        commits: removedCommits.length,
        blobs: blobsToDelete.size,
        compareSnapshots: snapshotsToDelete.size,
      };
      const changed = manifestsToDelete.length > 0
        || Object.values(garbageCollected).some((count) => count > 0);
      const updatedRepository = changed ? nextRepositoryRevision(repository) : repository;
      if (changed) await tx.put('repositories', updatedRepository);
      return { repository: updatedRepository, garbageCollected };
    }));
  }

  async createTag(input: CreateTagInput): Promise<{ repository: VersionRepository; tag: TagRef }> {
    const name = tagName(input.name);
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, input.expectedRepositoryRevision);
      if (await tx.get('refs', refKey(input.repositoryId, 'tag', name))) {
        throw new VersionError('TAG_EXISTS', `Tag ${name} already exists`);
      }
      const target = await tx.get('commits', input.target);
      if (!target || target.repositoryId !== input.repositoryId) {
        missing('COMMIT_NOT_FOUND', 'Tag target was not found in this repository');
      }
      const tag: TagRef = {
        repositoryId: input.repositoryId,
        kind: 'tag',
        name,
        target: input.target,
        revision: 1,
      };
      const updatedRepository = nextRepositoryRevision(repository);
      await tx.put('refs', toRefRow(tag));
      await tx.put('repositories', updatedRepository);
      return { repository: updatedRepository, tag };
    }));
  }

  async moveTag(input: MoveTagInput): Promise<{ repository: VersionRepository; tag: TagRef }> {
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, input.expectedRepositoryRevision);
      const key = refKey(input.repositoryId, 'tag', input.tag);
      const row = await tx.get('refs', key);
      if (!row || row.kind !== 'tag') missing('REF_NOT_FOUND', 'Tag was not found');
      const current = fromRefRow(row) as TagRef;
      assertRefRevision(current, input.expectedTagRevision);
      const target = await tx.get('commits', input.target);
      if (!target || target.repositoryId !== input.repositoryId) {
        missing('COMMIT_NOT_FOUND', 'Tag target was not found in this repository');
      }
      const tag: TagRef = { ...current, target: input.target, revision: current.revision + 1 };
      const updatedRepository = nextRepositoryRevision(repository);
      await tx.put('refs', toRefRow(tag));
      await tx.put('repositories', updatedRepository);
      return { repository: updatedRepository, tag };
    }));
  }

  async deleteTag(input: DeleteTagInput): Promise<VersionRepository> {
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, input.expectedRepositoryRevision);
      const key = refKey(input.repositoryId, 'tag', input.tag);
      const row = await tx.get('refs', key);
      if (!row || row.kind !== 'tag') missing('REF_NOT_FOUND', 'Tag was not found');
      assertRefRevision(fromRefRow(row), input.expectedTagRevision);
      const updatedRepository = nextRepositoryRevision(repository);
      await tx.delete('refs', key);
      await tx.put('repositories', updatedRepository);
      return updatedRepository;
    }));
  }

  async createShelf(input: CreateShelfInput): Promise<{ repository: VersionRepository; shelf: VersionShelf }> {
    const payload = preparePayload(input);
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, input.expectedRepositoryRevision);
      const base = await tx.get('commits', input.baseCommitId);
      if (!base || base.repositoryId !== input.repositoryId) {
        missing('COMMIT_NOT_FOUND', 'Shelf base commit was not found in this repository');
      }
      const branch = await tx.get('refs', refKey(input.repositoryId, 'branch', input.branch));
      if (!branch || branch.kind !== 'branch') missing('REF_NOT_FOUND', 'Shelf branch was not found');
      const id = input.id ?? shelfId(createId('shelf'));
      if (await tx.get('shelves', id)) {
        throw new VersionError('VERSION_STORE_FAILED', 'Shelf ID already exists');
      }
      const shelf: VersionShelf = {
        id,
        repositoryId: input.repositoryId,
        baseCommitId: input.baseCommitId,
        branch: input.branch,
        blobId: payload.blob.id,
        compareSnapshotId: payload.compareSnapshot.id,
        contentFingerprint: contentFingerprint(input.contentFingerprint),
        title: input.title.trim(),
        createdAt: input.createdAt ?? Date.now(),
      };
      const updatedRepository = nextRepositoryRevision(repository);
      if (!await tx.get('blobs', payload.blob.id)) await tx.put('blobs', payload.blob);
      if (!await tx.get('compareSnapshots', payload.compareSnapshot.id)) {
        await tx.put('compareSnapshots', payload.compareSnapshot);
      }
      await tx.put('shelves', shelf);
      await tx.put('repositories', updatedRepository);
      return { repository: updatedRepository, shelf };
    }));
  }

  async getShelf(id: ShelfId): Promise<VersionShelf | null> {
    return this.#transaction('readonly', async (tx) => await tx.get('shelves', id) ?? null);
  }

  async listShelves(id: RepositoryId): Promise<VersionShelf[]> {
    return this.#transaction('readonly', async (tx) => (
      (await tx.listShelves(id))
        .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    ));
  }

  async deleteShelf(input: DeleteShelfInput): Promise<VersionRepository> {
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const repository = await tx.get('repositories', input.repositoryId);
      if (!repository) missing('REPOSITORY_NOT_FOUND', 'Version repository was not found');
      assertRepositoryRevision(repository, input.expectedRepositoryRevision);
      const shelf = await tx.get('shelves', input.shelfId);
      if (!shelf || shelf.repositoryId !== input.repositoryId) missing('SHELF_NOT_FOUND', 'Shelf was not found');
      await tx.delete('shelves', input.shelfId);

      const commits = await tx.getAll('commits');
      const remainingShelves = (await tx.getAll('shelves')).filter((candidate) => candidate.id !== input.shelfId);
      const draftAssetIds = new Set(
        (await tx.getAll('mergeDrafts')).flatMap((draft) => draft.manualAssetBlobIds),
      );
      if (
        !commits.some((commit) => commit.blobId === shelf.blobId)
        && !remainingShelves.some((candidate) => candidate.blobId === shelf.blobId)
        && !draftAssetIds.has(shelf.blobId)
      ) {
        await tx.delete('blobs', shelf.blobId);
      }
      if (
        !commits.some((commit) => commit.compareSnapshotId === shelf.compareSnapshotId)
        && !remainingShelves.some((candidate) => candidate.compareSnapshotId === shelf.compareSnapshotId)
      ) {
        await tx.delete('compareSnapshots', shelf.compareSnapshotId);
      }
      const updatedRepository = nextRepositoryRevision(repository);
      await tx.put('repositories', updatedRepository);
      return updatedRepository;
    }));
  }

  async updateCommitTitle(input: UpdateCommitTitleInput): Promise<VersionCommit> {
    return this.#serialize(input.repositoryId, () => this.#transaction('readwrite', async (tx) => {
      const commit = await tx.get('commits', input.commitId);
      if (!commit || commit.repositoryId !== input.repositoryId) {
        missing('COMMIT_NOT_FOUND', 'Commit was not found in this repository');
      }
      if (commit.titleRevision !== input.expectedTitleRevision) stale('The commit title changed');
      const { generatedBy: _oldGenerator, ...base } = commit;
      const title = commitTitle(input);
      const updated: VersionCommit = title.titleOrigin === 'generated'
        ? { ...base, ...title, titleRevision: commit.titleRevision + 1 }
        : { ...base, ...title, titleRevision: commit.titleRevision + 1 };
      await tx.put('commits', updated);
      return updated;
    }));
  }

  async clearForTests(): Promise<void> {
    await this.#serialize('clear', () => this.#transaction('readwrite', async (tx) => {
      for (const store of STORE_NAMES) await tx.clear(store);
    }));
  }
}

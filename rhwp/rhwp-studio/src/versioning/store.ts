import type { CompareDocumentSnapshot } from '../compare/types.ts';
import { openIndexedDatabase } from '../core/idb-open.ts';
import { hashBytes, hashCompareSnapshot, serializeCompareSnapshot } from './hash.ts';
import {
  branchName,
  commitId,
  compareSnapshotId,
  contentFingerprint,
  documentId,
  normalizedRefKey,
  repositoryId,
  shelfId,
  tagName,
  VersionError,
  type BlobId,
  type BranchName,
  type BranchRef,
  type CommitId,
  type CommitParents,
  type CompareSnapshotId,
  type ContentFingerprint,
  type DocumentId,
  type RepositoryId,
  type ShelfId,
  type TagName,
  type TagRef,
  type VersionAuthor,
  type VersionBlob,
  type VersionCommit,
  type VersionCompareSnapshot,
  type VersionRef,
  type VersionRepository,
  type VersionShelf,
  type VersionStats,
  type VersionTitle,
} from './types.ts';

export const VERSION_DATABASE_NAME = 'rhwpStudioVersionGraph';
export const VERSION_DATABASE_VERSION = 1;

const STORE_NAMES = [
  'repositories',
  'commits',
  'refs',
  'blobs',
  'compareSnapshots',
  'shelves',
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
}

interface GraphTransaction {
  get<Name extends StoreName>(store: Name, key: IDBValidKey): Promise<StoreRows[Name] | undefined>;
  getAll<Name extends StoreName>(store: Name): Promise<StoreRows[Name][]>;
  findRepositoryByDocumentId(documentId: DocumentId): Promise<VersionRepository | undefined>;
  listCommits(repositoryId: RepositoryId, beforeOrdinal: number, limit: number): Promise<VersionCommit[]>;
  listRefs(repositoryId: RepositoryId): Promise<RefRow[]>;
  listShelves(repositoryId: RepositoryId, limit?: number): Promise<VersionShelf[]>;
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
};

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

function stale(message: string): never {
  throw new VersionError('STALE_WORKSPACE', message);
}

function missing(code: 'REPOSITORY_NOT_FOUND' | 'COMMIT_NOT_FOUND' | 'REF_NOT_FOUND' | 'SHELF_NOT_FOUND', message: string): never {
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
      (database) => {
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

      const repository: VersionRepository = {
        schemaVersion: 1,
        id,
        documentId: documentId(input.documentId),
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
        contentFingerprint: contentFingerprint(input.initial.contentFingerprint),
        ...commitTitle(input.initial),
        author: cloneValue(input.initial.author),
        reason: 'initial',
        stats: cloneValue(input.initial.stats ?? EMPTY_STATS),
        createdAt: input.initial.createdAt ?? Date.now(),
      };
      const branch: BranchRef = {
        repositoryId: id,
        kind: 'branch',
        name: initialBranch,
        target: commit.id,
        revision: 1,
      };

      await tx.put('blobs', payload.blob);
      await tx.put('compareSnapshots', payload.compareSnapshot);
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
      for (const parent of parents) {
        const parentCommit = await tx.get('commits', parent);
        if (!parentCommit || parentCommit.repositoryId !== input.repositoryId) {
          missing('COMMIT_NOT_FOUND', `Parent commit ${parent} was not found in this repository`);
        }
      }

      const id = input.id ?? commitId(createId('commit'));
      if (await tx.get('commits', id)) {
        throw new VersionError('VERSION_STORE_FAILED', 'Commit ID already exists');
      }
      const commit: VersionCommit = {
        id,
        repositoryId: input.repositoryId,
        parents,
        ordinal: repository.nextOrdinal,
        blobId: payload.blob.id,
        compareSnapshotId: payload.compareSnapshot.id,
        contentFingerprint: contentFingerprint(input.contentFingerprint),
        ...commitTitle(input),
        author: cloneValue(input.author),
        reason: input.reason,
        stats: cloneValue(input.stats ?? EMPTY_STATS),
        createdAt: input.createdAt ?? Date.now(),
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
      const blobIds = new Set([
        ...commits.map((commit) => commit.blobId),
        ...shelves.map((shelf) => shelf.blobId),
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
      const updatedRepository = nextRepositoryRevision(repository);
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
      const reachable = new Set<CommitId>();
      const frontier = [
        ...refs.map((ref) => ref.target),
        ...repositoryShelves.map((shelf) => shelf.baseCommitId),
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
      ]);
      const referencedSnapshots = new Set([
        ...remainingCommits.map((commit) => commit.compareSnapshotId),
        ...shelves.map((shelf) => shelf.compareSnapshotId),
      ]);
      const blobsToDelete = new Set(
        removedCommits.map((commit) => commit.blobId).filter((id) => !referencedBlobs.has(id)),
      );
      const snapshotsToDelete = new Set(
        removedCommits
          .map((commit) => commit.compareSnapshotId)
          .filter((id) => !referencedSnapshots.has(id)),
      );

      for (const commit of removedCommits) await tx.delete('commits', commit.id);
      for (const id of blobsToDelete) await tx.delete('blobs', id);
      for (const id of snapshotsToDelete) await tx.delete('compareSnapshots', id);

      const garbageCollected = {
        commits: removedCommits.length,
        blobs: blobsToDelete.size,
        compareSnapshots: snapshotsToDelete.size,
      };
      const changed = Object.values(garbageCollected).some((count) => count > 0);
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
      if (
        !commits.some((commit) => commit.blobId === shelf.blobId)
        && !remainingShelves.some((candidate) => candidate.blobId === shelf.blobId)
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

import type { CompareDocumentSnapshot } from '../compare/types.ts';

declare const versionBrand: unique symbol;

type Brand<Value, Name extends string> = Value & {
  readonly [versionBrand]: Name;
};

export type RepositoryId = Brand<string, 'RepositoryId'>;
export type CommitId = Brand<string, 'CommitId'>;
export type BlobId = Brand<`blake3:${string}`, 'BlobId'>;
export type CompareSnapshotId = Brand<`blake3:${string}`, 'CompareSnapshotId'>;
export type ContentFingerprint = Brand<`blake3:${string}`, 'ContentFingerprint'>;
export type ShelfId = Brand<string, 'ShelfId'>;
export type DocumentId = Brand<string, 'DocumentId'>;
export type BranchName = Brand<string, 'BranchName'>;
export type TagName = Brand<string, 'TagName'>;

export type CommitReason =
  | 'initial'
  | 'manual'
  | 'save'
  | 'agent'
  | 'pre-restore'
  | 'pre-switch'
  | 'restore'
  | 'adopt';

export type VersionAuthor =
  | { kind: 'user'; label: string }
  | { kind: 'system'; label: string }
  | { kind: 'agent'; label: string; threadId?: string };

export interface VersionStats {
  added: number;
  removed: number;
  modified: number;
}

export type CommitParents =
  | readonly []
  | readonly [CommitId]
  | readonly [CommitId, CommitId];

export interface VersionRepository {
  schemaVersion: 1;
  id: RepositoryId;
  documentId: DocumentId;
  revision: number;
  nextOrdinal: number;
  enabledAt: number;
  lastSavedFingerprint: ContentFingerprint;
}

interface VersionCommitBase {
  id: CommitId;
  repositoryId: RepositoryId;
  parents: CommitParents;
  ordinal: number;
  blobId: BlobId;
  compareSnapshotId: CompareSnapshotId;
  contentFingerprint: ContentFingerprint;
  author: VersionAuthor;
  reason: CommitReason;
  stats: VersionStats;
  createdAt: number;
}

export type VersionTitle =
  | { title: string; titleRevision: number; titleOrigin: 'manual' | 'timestamp'; generatedBy?: never }
  | {
      title: string;
      titleRevision: number;
      titleOrigin: 'generated';
      generatedBy: { provider: string; model: string };
    };

export type VersionCommit = VersionCommitBase & VersionTitle;

interface VersionRefBase {
  repositoryId: RepositoryId;
  target: CommitId;
  revision: number;
}

export type BranchRef = VersionRefBase & {
  kind: 'branch';
  name: BranchName;
};

export type TagRef = VersionRefBase & {
  kind: 'tag';
  name: TagName;
};

export type VersionRef = BranchRef | TagRef;

export interface VersionBlob {
  id: BlobId;
  byteLength: number;
  bytes: Uint8Array;
}

export interface VersionCompareSnapshot {
  id: CompareSnapshotId;
  byteLength: number;
  snapshot: CompareDocumentSnapshot;
}

export interface VersionShelf {
  id: ShelfId;
  repositoryId: RepositoryId;
  baseCommitId: CommitId;
  branch: BranchName;
  blobId: BlobId;
  compareSnapshotId: CompareSnapshotId;
  contentFingerprint: ContentFingerprint;
  title: string;
  createdAt: number;
}

export interface WorkspaceToken {
  repositoryId: RepositoryId;
  repositoryRevision: number;
  activeBranch: BranchName;
  branchRevision: number;
  head: CommitId;
  editorRevision: number;
  contentFingerprint: ContentFingerprint;
  agentState: 'idle' | 'running' | 'review';
}

export type VersionErrorCode =
  | 'SAVE_REQUIRED'
  | 'VERSIONING_DISABLED'
  | 'ACTIVE_AGENT_TURN'
  | 'PENDING_AGENT_REVIEW'
  | 'STALE_WORKSPACE'
  | 'REPOSITORY_EXISTS'
  | 'REPOSITORY_NOT_FOUND'
  | 'COMMIT_NOT_FOUND'
  | 'REF_NOT_FOUND'
  | 'BRANCH_EXISTS'
  | 'TAG_EXISTS'
  | 'INVALID_REF_NAME'
  | 'CURRENT_BRANCH'
  | 'LAST_BRANCH'
  | 'SHELF_NOT_FOUND'
  | 'NO_CHANGES'
  | 'SNAPSHOT_CAPACITY'
  | 'STORAGE_QUOTA'
  | 'CORRUPT_BLOB'
  | 'RESTORE_PARSE_FAILED'
  | 'VERSION_STORE_FAILED';

export class VersionError extends Error {
  readonly code: VersionErrorCode;

  constructor(code: VersionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VersionError';
    this.code = code;
  }
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new VersionError('VERSION_STORE_FAILED', `${label} must not be empty`);
  return normalized;
}

function hashValue(value: string, label: string): `blake3:${string}` {
  const normalized = value.trim().toLowerCase();
  if (!/^blake3:[0-9a-f]{64}$/.test(normalized)) {
    throw new VersionError('VERSION_STORE_FAILED', `${label} must be a BLAKE3 digest`);
  }
  return normalized as `blake3:${string}`;
}

function refName(value: string): string {
  const normalized = value.normalize('NFC').trim();
  if (
    normalized.length < 1
    || normalized.length > 64
    || /[\u0000-\u001f\u007f/\\]/u.test(normalized)
  ) {
    throw new VersionError('INVALID_REF_NAME', 'Reference names must be 1-64 safe characters');
  }
  return normalized;
}

export const repositoryId = (value: string): RepositoryId => nonEmpty(value, 'Repository ID') as RepositoryId;
export const commitId = (value: string): CommitId => nonEmpty(value, 'Commit ID') as CommitId;
export const shelfId = (value: string): ShelfId => nonEmpty(value, 'Shelf ID') as ShelfId;
export const documentId = (value: string): DocumentId => nonEmpty(value, 'Document ID') as DocumentId;
export const blobId = (value: string): BlobId => hashValue(value, 'Blob ID') as BlobId;
export const compareSnapshotId = (value: string): CompareSnapshotId => hashValue(value, 'Compare snapshot ID') as CompareSnapshotId;
export const contentFingerprint = (value: string): ContentFingerprint => hashValue(value, 'Content fingerprint') as ContentFingerprint;
export const branchName = (value: string): BranchName => refName(value) as BranchName;
export const tagName = (value: string): TagName => refName(value) as TagName;

export function normalizedRefKey(name: BranchName | TagName): string {
  return name.normalize('NFC').toLowerCase();
}

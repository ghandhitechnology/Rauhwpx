import type { CompareDocumentSnapshot } from '../compare/types.ts';

declare const versionBrand: unique symbol;

type Brand<Value, Name extends string> = Value & {
  readonly [versionBrand]: Name;
};

export type RepositoryId = Brand<string, 'RepositoryId'>;
export type CommitId = Brand<string, 'CommitId'>;
export type BlobId = Brand<`blake3:${string}`, 'BlobId'>;
export type CompareSnapshotId = Brand<`blake3:${string}`, 'CompareSnapshotId'>;
export type MergeManifestId = Brand<`blake3:${string}`, 'MergeManifestId'>;
export type MergeDraftId = Brand<string, 'MergeDraftId'>;
export type ContentFingerprint = Brand<`blake3:${string}`, 'ContentFingerprint'>;
export type ShelfId = Brand<string, 'ShelfId'>;
export type DocumentId = Brand<string, 'DocumentId'>;
export type BranchName = Brand<string, 'BranchName'>;
export type BranchGeneration = Brand<string, 'BranchGeneration'>;
export type TagName = Brand<string, 'TagName'>;

export type CommitReason =
  | 'initial'
  | 'manual'
  | 'save'
  | 'agent'
  | 'pre-restore'
  | 'pre-switch'
  | 'pre-merge'
  | 'merge'
  | 'restore'
  | 'adopt';

export interface VersionMergeMetadata {
  sourceBranchAtMerge: string;
  targetBranchAtMerge: string;
  baseCommitIds: CommitId[];
  conflictCount: number;
}

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
  schemaVersion: 1 | 2;
  id: RepositoryId;
  documentId: DocumentId;
  /** Added in schema v2. Legacy in-memory rows may omit it until opened/migrated. */
  defaultBranch?: BranchName;
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
  /** Optional for database-v1 commits; generated lazily on first merge. */
  mergeManifestId?: MergeManifestId;
  contentFingerprint: ContentFingerprint;
  author: VersionAuthor;
  reason: CommitReason;
  stats: VersionStats;
  createdAt: number;
  merge?: VersionMergeMetadata;
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
  /** Stable identity of this branch incarnation. A delete/recreate gets a new token. */
  generation: BranchGeneration;
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

export type MergeNodeKind =
  | 'document'
  | 'section'
  | 'paragraph'
  | 'text'
  | 'table'
  | 'cell'
  | 'shape'
  | 'image'
  | 'chart'
  | 'style'
  | 'resource'
  | 'unknown-control'
  | string;

export type MergeDocumentPath = readonly string[];
export type MergeValue = unknown;
export type TypedMergeValue = unknown;

export type MergeRelation = 'already-integrated' | 'fast-forward' | 'diverged';

export type MergeResolution =
  | { kind: 'current' }
  | { kind: 'incoming' }
  | { kind: 'both'; order: 'current-first' | 'incoming-first' }
  | { kind: 'manual'; payload: TypedMergeValue };

export type MergeConflictReason =
  | 'same-field-changed'
  | 'delete-versus-edit'
  | 'incompatible-move'
  | 'concurrent-insertion'
  | 'unknown-control-modified'
  | 'low-confidence-match'
  | 'budget-exceeded';

export interface MergeConflict {
  id: string;
  kind: MergeNodeKind;
  path: MergeDocumentPath;
  reason: MergeConflictReason;
  base: MergeValue;
  current: MergeValue;
  incoming: MergeValue;
  supportsBoth: boolean;
  /** False for opaque/atomic values that can only choose one complete side. */
  supportsManual?: boolean;
  fingerprint: string;
}

export interface MergeManifestEntry {
  identity: string;
  kind: MergeNodeKind;
  path: MergeDocumentPath;
  propertyHash: `blake3:${string}`;
}

/** Parser-derived structural seed before parent manifests propagate identities. */
export interface MergeManifestEntrySeed {
  kind: MergeNodeKind;
  path: MergeDocumentPath;
  propertyHash: `blake3:${string}`;
  identityHint?: string;
}

export interface VersionMergeManifest {
  id: MergeManifestId;
  repositoryId: RepositoryId;
  commitId: CommitId;
  analysisVersion: number;
  parentManifestIds: MergeManifestId[];
  /** Compare-only is a legacy/store fallback and must be upgraded before analysis. */
  coverage: 'compare-fallback' | 'full-document';
  entries: MergeManifestEntry[];
  createdAt: number;
}

export interface MergeDraftHistoryEntry {
  /** Entries sharing this ID are one resolver-local bulk Undo/Redo step. */
  groupId?: string;
  conflictId: string;
  before: MergeResolution | null;
  after: MergeResolution | null;
}

export interface VersionMergeDraft {
  id: MergeDraftId;
  repositoryId: RepositoryId;
  targetBranch: BranchName;
  sourceBranch: BranchName;
  baseCommitIds: CommitId[];
  currentHead: CommitId;
  sourceHead: CommitId;
  targetBranchRevision: number;
  sourceBranchRevision: number;
  /** Optional only for drafts written before persistent branch generations. */
  targetBranchGeneration?: BranchGeneration;
  sourceBranchGeneration?: BranchGeneration;
  mode: 'fast-forward' | 'explicit-checkpoint' | 'diverged';
  analysisVersion: number;
  conflicts: MergeConflict[];
  resolutions: Record<string, MergeResolution>;
  automaticResult: MergeValue;
  manualAssetBlobIds: BlobId[];
  history: MergeDraftHistoryEntry[];
  historyIndex: number;
  createdAt: number;
  updatedAt: number;
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
  | 'DEFAULT_BRANCH'
  | 'MERGE_IN_PROGRESS'
  | 'MERGE_DRAFT_NOT_FOUND'
  | 'MERGE_UNRESOLVED'
  | 'MERGE_VALIDATION_FAILED'
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
export const mergeManifestId = (value: string): MergeManifestId => hashValue(value, 'Merge manifest ID') as MergeManifestId;
export const mergeDraftId = (value: string): MergeDraftId => nonEmpty(value, 'Merge draft ID') as MergeDraftId;
export const contentFingerprint = (value: string): ContentFingerprint => hashValue(value, 'Content fingerprint') as ContentFingerprint;
export const branchName = (value: string): BranchName => refName(value) as BranchName;
export const branchGeneration = (value: string): BranchGeneration => nonEmpty(value, 'Branch generation') as BranchGeneration;
export const tagName = (value: string): TagName => refName(value) as TagName;

export function normalizedRefKey(name: BranchName | TagName): string {
  return name.normalize('NFC').toLowerCase();
}

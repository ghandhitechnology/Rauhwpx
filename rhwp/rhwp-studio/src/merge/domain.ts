import type {
  MergeConflict,
  MergeResolution,
  VersionMergeDraft,
} from '../versioning/types.ts';

export type MergeMode = 'fast-forward' | 'explicit-checkpoint' | 'diverged';
export type MergePreviewRole = 'base' | 'current' | 'incoming' | 'result';

export interface MergeAnalysis {
  analysisVersion: number;
  result: unknown;
  conflicts: MergeConflict[];
  automaticOperationCount: number;
}

export interface MergeDocumentSource {
  bytes: Uint8Array;
  fileName: string;
  label?: string;
}

export interface MergeValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
  checks?: {
    parsed: boolean;
    exported: boolean;
    reloaded: boolean;
    structurallyValid: boolean;
    format?: 'hwp' | 'hwpx' | 'unknown';
  };
}

export interface MaterializedMergeResult {
  tree: unknown;
  document?: MergeDocumentSource;
  validation: MergeValidationResult;
}

export interface MergeMaterializeRequest {
  analysis: MergeAnalysis;
  resolutions: Readonly<Record<string, MergeResolution>>;
  signal: AbortSignal;
}

export interface MergeCompletionRequest {
  draft: VersionMergeDraft;
  title: string;
  mode: MergeMode;
  sourceDisposition: 'keep' | 'delete';
  resolutions: Readonly<Record<string, MergeResolution>>;
  materialized: MaterializedMergeResult;
}

export type MergeApplicationRequest = Omit<MergeCompletionRequest, 'sourceDisposition'>;

declare const mergeAppliedReceiptBrand: unique symbol;
/** Opaque controller-owned handle for an applied, not-yet-finalized composite merge. */
export interface MergeAppliedReceipt {
  readonly [mergeAppliedReceiptBrand]: true;
}

export interface MergeResolverOpenOptions {
  draft: VersionMergeDraft;
  analysis: MergeAnalysis;
  sourceBranch: string;
  currentBranch: string;
  mode: MergeMode;
  title?: string;
  documents: {
    base: MergeDocumentSource;
    current: MergeDocumentSource;
    incoming: MergeDocumentSource;
    result?: MergeDocumentSource;
  };
  canDeleteSource?: boolean;
  materialize(request: MergeMaterializeRequest): Promise<MaterializedMergeResult>;
  saveDraft(draft: VersionMergeDraft): Promise<void>;
  discardDraft(draftId: VersionMergeDraft['id']): Promise<void>;
  complete(request: MergeApplicationRequest): Promise<MergeAppliedReceipt>;
  finalizeSourceDisposition(
    receipt: MergeAppliedReceipt,
    disposition: MergeCompletionRequest['sourceDisposition'],
  ): Promise<void>;
  uploadAsset?(file: File, conflict: MergeConflict): Promise<unknown>;
  onClosed?(reason: 'saved' | 'discarded' | 'completed'): void;
}

export interface MergeResolverCloseOptions {
  discard?: boolean;
}

export interface MergeResolverSnapshot {
  resolutions: Readonly<Record<string, MergeResolution>>;
  unresolvedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  validation: MergeValidationResult | null;
  materialized: MaterializedMergeResult | null;
}

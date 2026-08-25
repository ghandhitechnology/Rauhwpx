import type {
  BlobId,
  BranchRef,
  MergeResolution,
  VersionMergeDraft,
} from './types.ts';

function resolutionAssetIds(resolutions: Readonly<Record<string, MergeResolution>>): BlobId[] {
  const ids = new Set<BlobId>();
  for (const resolution of Object.values(resolutions)) {
    if (resolution.kind !== 'manual' || !resolution.payload || typeof resolution.payload !== 'object') continue;
    const id = (resolution.payload as Record<string, unknown>).assetBlobId;
    if (typeof id === 'string') ids.add(id as BlobId);
  }
  return [...ids];
}

/**
 * Resolver-local Undo history is meaningful only for the exact analyzed heads.
 * On recomputation, keep fingerprint-carried resolutions and only their assets;
 * obsolete history entries must not address conflicts from the previous run.
 */
export function retainedMergeDraftLocalState(
  previous: VersionMergeDraft | undefined,
  target: BranchRef,
  source: BranchRef,
  carriedResolutions: Readonly<Record<string, MergeResolution>>,
): Pick<VersionMergeDraft, 'manualAssetBlobIds' | 'history' | 'historyIndex'> {
  const headsChanged = Boolean(previous && (
    previous.currentHead !== target.target
    || previous.sourceHead !== source.target
    || previous.targetBranchGeneration !== target.generation
    || previous.sourceBranchGeneration !== source.generation
  ));
  if (!previous) return { manualAssetBlobIds: [], history: [], historyIndex: 0 };
  if (!headsChanged) {
    return {
      manualAssetBlobIds: [...previous.manualAssetBlobIds],
      history: structuredClone(previous.history),
      historyIndex: previous.historyIndex,
    };
  }
  return {
    manualAssetBlobIds: resolutionAssetIds(carriedResolutions),
    history: [],
    historyIndex: 0,
  };
}

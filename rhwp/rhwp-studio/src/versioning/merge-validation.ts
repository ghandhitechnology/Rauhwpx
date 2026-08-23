export interface ExternalMergeResourceReference {
  key?: string;
  binDataId?: number;
  originalPath?: string;
  basename?: string;
  loaded?: boolean;
}

/** Missing external image bytes are dangling merge dependencies, not warnings. */
export function mergeResourceDependencyErrors(
  references: readonly ExternalMergeResourceReference[],
): string[] {
  return references
    .filter((reference) => reference.loaded !== true)
    .map((reference) => {
      const identity = reference.basename
        || reference.originalPath
        || reference.key
        || (reference.binDataId === undefined ? 'unknown resource' : `BinData ${reference.binDataId}`);
      return `Missing referenced image resource: ${identity}`;
    });
}

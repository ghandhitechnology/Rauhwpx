export interface CompositeMergeCommitSteps<Result> {
  applyEditor(): void;
  commitRefs(): Promise<Result>;
  rollbackEditor(): void | Promise<void>;
}

export interface CompositeEditorReconciliation {
  undoAppliedMerge(): void;
  discardMergeRedo(): void;
  matchesExpectedDocument(): boolean;
  replaceWithExpectedDocument(): void;
  discardFallbackUndo(): void;
}

export type CompositeHistoryReconciliation = Omit<
  CompositeEditorReconciliation,
  'undoAppliedMerge' | 'discardMergeRedo'
> & {
  restoreFromHistory(): void;
};

/** Reconciles an Undo/Redo whose matching asynchronous ref CAS failed. */
export function reconcileCompositeHistoryTransition(steps: CompositeHistoryReconciliation): void {
  let historyFailure: unknown;
  try {
    steps.restoreFromHistory();
    if (!steps.matchesExpectedDocument()) {
      throw new Error('The history compensation did not restore the expected document');
    }
    return;
  } catch (error) {
    historyFailure = error;
  }
  try {
    steps.replaceWithExpectedDocument();
    if (!steps.matchesExpectedDocument()) {
      throw new Error('The fallback replacement did not restore the expected document');
    }
    steps.discardFallbackUndo();
  } catch (fallbackFailure) {
    throw new AggregateError(
      [historyFailure, fallbackFailure],
      'The editor could not be reconciled after its merge ref transition failed',
    );
  }
}

/**
 * Restores the pre-merge document after the durable ref transaction failed.
 * A silent/no-op Undo is detected by fingerprint verification. The exact-byte
 * fallback is removed from history after application so a later user Undo
 * cannot return to bytes which were never committed by the store.
 */
export function reconcileCompositeEditor(steps: CompositeEditorReconciliation): void {
  reconcileCompositeHistoryTransition({
    restoreFromHistory: () => {
      steps.undoAppliedMerge();
      steps.discardMergeRedo();
    },
    matchesExpectedDocument: steps.matchesExpectedDocument,
    replaceWithExpectedDocument: steps.replaceWithExpectedDocument,
    discardFallbackUndo: steps.discardFallbackUndo,
  });
}

/**
 * Coordinates the editor snapshot and durable ref transaction. The editor is
 * the reversible first phase; refs are the commit point. Store failure must
 * restore the editor before the failure is exposed to a caller.
 */
export async function commitCompositeMerge<Result>(
  steps: CompositeMergeCommitSteps<Result>,
): Promise<Result> {
  steps.applyEditor();
  try {
    return await steps.commitRefs();
  } catch (commitError) {
    try {
      await steps.rollbackEditor();
    } catch (rollbackError) {
      throw new AggregateError(
        [commitError, rollbackError],
        'Merge ref commit failed and the editor rollback also failed',
      );
    }
    throw commitError;
  }
}

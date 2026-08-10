import type { PendingChangeSet } from '../../agent/types.ts';

export interface PendingDiffSummary {
  additions: number;
  deletions: number;
  nonTextChanges: number;
  opCount: number;
}

function characterCount(text: string): number {
  return Array.from(text).length;
}

/** Summarizes only the pending operations that the Changes workspace can review. */
export function summarizePendingDiffs(changeSets: readonly PendingChangeSet[]): PendingDiffSummary {
  const summary: PendingDiffSummary = {
    additions: 0,
    deletions: 0,
    nonTextChanges: 0,
    opCount: 0,
  };

  for (const set of changeSets) {
    for (const op of set.ops) {
      summary.opCount += 1;
      switch (op.kind) {
        case 'insert':
          summary.additions += characterCount(op.text);
          break;
        case 'delete':
          summary.deletions += characterCount(op.text);
          break;
        case 'replace':
          summary.additions += characterCount(op.text);
          summary.deletions += characterCount(op.deletedText);
          break;
        case 'field':
          summary.additions += characterCount(op.newValue);
          summary.deletions += characterCount(op.oldValue);
          break;
        case 'format':
        case 'object':
          summary.nonTextChanges += 1;
          break;
      }
    }
  }

  return summary;
}

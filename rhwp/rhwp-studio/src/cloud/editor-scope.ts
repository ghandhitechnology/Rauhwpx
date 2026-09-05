import type { CloudSessionScope, CloudSnapshot } from './types.ts';

export type CloudEditorScope = Pick<CloudSessionScope, 'threadId' | 'documentId'>;

/** A separate local chat edits the retained local copy, while Cloud keeps its lease. */
export function cloudLeaseBlocksLocal(snapshot: CloudSnapshot, scope: CloudEditorScope | null): boolean {
  if (snapshot.lease.owner === 'local') return false;
  const lease = snapshot.lease;
  const owner = snapshot.sessions.find((session) => session.sessionId === lease.sessionId);
  const ownerThreadId = lease.threadId ?? owner?.threadId;
  // Older servers without conversation identity retain the document lock.
  return !scope?.threadId || !ownerThreadId || ownerThreadId === scope.threadId;
}

export function createCloudEditorScope(initial: CloudEditorScope) {
  let scope = { ...initial };
  return {
    current(): CloudEditorScope {
      return { ...scope };
    },
    bind(next: CloudEditorScope): boolean {
      if (scope.threadId === next.threadId && scope.documentId === next.documentId) return false;
      scope = { ...next };
      return true;
    },
  };
}

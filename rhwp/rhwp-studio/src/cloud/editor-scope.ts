import type { CloudSessionScope } from './types.ts';

export type CloudEditorScope = Pick<CloudSessionScope, 'threadId' | 'documentId'>;

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

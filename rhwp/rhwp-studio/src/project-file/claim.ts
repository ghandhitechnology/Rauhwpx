import type { RecentDoc } from '../recent/recent-store.ts';
import type { DocumentDigest, ProjectFileClaim } from './identity.ts';

function knownDigestOf(value: string): DocumentDigest | null {
  return value.startsWith('blake3:') ? value as DocumentDigest : null;
}

export function claimForRecentDoc(row: RecentDoc): ProjectFileClaim {
  return {
    documentId: row.documentId,
    displayName: row.fileName,
    knownDigest: knownDigestOf(row.sourceDigest),
    liveHandle: row.handle ?? null,
    recentId: row.id,
  };
}

export function claimForExplorerGroup(
  group: { readonly documentId: string | null; readonly displayName: string | null },
  recents: readonly RecentDoc[],
): ProjectFileClaim | null {
  if (!group.documentId) return null;
  const row = recents.find((recent) => recent.documentId === group.documentId);
  return {
    documentId: group.documentId,
    displayName: group.displayName || row?.fileName || 'document.hwp',
    knownDigest: row ? knownDigestOf(row.sourceDigest) : null,
    liveHandle: row?.handle ?? null,
    recentId: row?.id ?? null,
  };
}

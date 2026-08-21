import type { FileSystemFileHandleLike } from '../command/file-system-access.ts';

export type DocumentDigest = `blake3:${string}`;

export interface ProjectFileClaim {
  readonly documentId: string;
  readonly displayName: string;
  readonly knownDigest: DocumentDigest | null;
  readonly liveHandle: FileSystemFileHandleLike | null;
  readonly recentId: string | null;
}

export interface CandidateFacts {
  readonly digest: DocumentDigest;
  readonly entry: 'same' | 'different' | 'uncomparable';
  readonly location: 'remembered' | 'not-remembered' | 'unknown';
}

export type IdentityVerdict =
  | { readonly kind: 'confirmed'; readonly evidence: 'same-entry' | 'same-location' | 'same-bytes' }
  | { readonly kind: 'refuted'; readonly by: 'handle-comparison' }
  | { readonly kind: 'inconclusive'; readonly why: 'no-known-digest' | 'bytes-differ' };

export function judgeCandidate(
  claim: ProjectFileClaim,
  facts: CandidateFacts,
): IdentityVerdict {
  if (facts.entry === 'same') return { kind: 'confirmed', evidence: 'same-entry' };
  if (facts.entry === 'different') return { kind: 'refuted', by: 'handle-comparison' };
  if (facts.location === 'remembered') return { kind: 'confirmed', evidence: 'same-location' };
  if (claim.knownDigest !== null && claim.knownDigest === facts.digest) {
    return { kind: 'confirmed', evidence: 'same-bytes' };
  }
  return {
    kind: 'inconclusive',
    why: claim.knownDigest === null ? 'no-known-digest' : 'bytes-differ',
  };
}

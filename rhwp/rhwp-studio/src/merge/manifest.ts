import type { CompareDocumentSnapshot } from '../compare/types.ts';
import { hashBytes } from '../versioning/hash.ts';
import {
  mergeManifestId,
  type CommitId,
  type MergeManifestEntry,
  type MergeManifestEntrySeed,
  type RepositoryId,
  type VersionMergeManifest,
} from '../versioning/types.ts';

export const MERGE_ANALYSIS_VERSION = 1;
export const MERGE_MANIFEST_VERSION = 2;

function propertyHash(value: unknown): `blake3:${string}` {
  return hashBytes(new TextEncoder().encode(JSON.stringify(value))) as `blake3:${string}`;
}

export function buildMergeManifest(
  repositoryId: RepositoryId,
  commitId: CommitId,
  snapshot: CompareDocumentSnapshot,
  createdAt = Date.now(),
  parentManifests: readonly VersionMergeManifest[] = [],
  structuralEntries?: readonly MergeManifestEntrySeed[],
): VersionMergeManifest {
  const fullCoverage = structuralEntries !== undefined
    && parentManifests.every((manifest) => manifest.coverage === 'full-document');
  const inherited = parentManifests.flatMap((manifest) => manifest.entries);
  const inheritedByIdentity = new Map(inherited.map((entry) => [entry.identity, entry]));
  const inheritedByPath = new Map(inherited.map((entry) => [
    `${entry.kind}\u0000${entry.path.join('\u0000')}`,
    entry,
  ]));
  const inheritedByHash = new Map<string, MergeManifestEntry | null>();
  for (const entry of inherited) {
    const key = `${entry.kind}\u0000${entry.propertyHash}`;
    const existing = inheritedByHash.get(key);
    inheritedByHash.set(key, existing === undefined || existing?.identity === entry.identity ? entry : null);
  }
  const usedInherited = new Set<string>();
  const assignedIdentities = new Set<string>();
  const safePositionedIdentities = new Set<string>();
  const identity = (
    candidate: string | undefined,
    kind: string,
    path: readonly string[],
    hash: `blake3:${string}`,
  ): string => {
    const hinted = candidate ? inheritedByIdentity.get(candidate) : undefined;
    const hashed = inheritedByHash.get(`${kind}\u0000${hash}`) ?? undefined;
    const positioned = inheritedByPath.get(`${kind}\u0000${path.join('\u0000')}`);
    // A path is identity evidence only when the whole sibling sequence kept
    // its size and at least one unchanged anchor proves it did not shift.
    const safePositioned = positioned && safePositionedIdentities.has(positioned.identity)
      ? positioned
      : undefined;
    const inheritedEntry = [hinted, hashed, safePositioned]
      .find((entry) => entry && !usedInherited.has(entry.identity));
    if (inheritedEntry) {
      usedInherited.add(inheritedEntry.identity);
      assignedIdentities.add(inheritedEntry.identity);
      return inheritedEntry.identity;
    }
    const proposed = candidate ?? `node:${commitId}:${kind}:${path.join('/')}`;
    const unique = assignedIdentities.has(proposed)
      ? `node:${commitId}:${kind}:${path.join('/')}`
      : proposed;
    assignedIdentities.add(unique);
    return unique;
  };
  const entries: MergeManifestEntry[] = [];
  const seeds: MergeManifestEntrySeed[] = structuralEntries
    ? structuralEntries.map((entry) => ({ ...entry, path: [...entry.path] }))
    : [
      ...snapshot.paragraphs.map((paragraph): MergeManifestEntrySeed => ({
        path: ['sections', String(paragraph.section), 'paragraphs', String(paragraph.paragraph)],
        propertyHash: propertyHash({
          text: paragraph.text,
          signature: paragraph.signature,
          controlCount: paragraph.controlCount,
        }),
        identityHint: paragraph.stableId || undefined,
        kind: 'paragraph',
      })),
      ...snapshot.controls.map((control): MergeManifestEntrySeed => ({
        path: ['sections', String(control.section), 'paragraphs', String(control.paragraph), 'controls', control.key],
        propertyHash: propertyHash({ type: control.type, summary: control.summary }),
        identityHint: control.key,
        kind: control.kind,
      })),
    ];

  const groupKey = (kind: string, path: readonly string[]): string | null => (
    path.length > 0 && /^\d+$/.test(path[path.length - 1] ?? '')
      ? `${kind}\u0000${path.slice(0, -1).join('\u0000')}`
      : null
  );
  const parentGroups = new Map<string, MergeManifestEntry[]>();
  const seedGroups = new Map<string, MergeManifestEntrySeed[]>();
  for (const entry of inherited) {
    const key = groupKey(entry.kind, entry.path);
    if (key) parentGroups.set(key, [...(parentGroups.get(key) ?? []), entry]);
  }
  for (const seed of seeds) {
    const key = groupKey(seed.kind, seed.path);
    if (key) seedGroups.set(key, [...(seedGroups.get(key) ?? []), seed]);
  }
  for (const [key, children] of seedGroups) {
    const parents = parentGroups.get(key);
    if (!parents || parents.length !== children.length) continue;
    let anchoredInPlace = children.length === 1;
    let reordered = false;
    for (const child of children) {
      const hashMatch = inheritedByHash.get(`${child.kind}\u0000${child.propertyHash}`);
      if (!hashMatch) continue;
      if (hashMatch.path.join('\u0000') === child.path.join('\u0000')) anchoredInPlace = true;
      else reordered = true;
    }
    if (anchoredInPlace && !reordered) {
      for (const parent of parents) safePositionedIdentities.add(parent.identity);
    }
  }

  // Resolve unchanged or embedded-identity nodes first. This prevents an
  // insertion at an old path from stealing the identity of a shifted node.
  seeds.sort((left, right) => {
    const leftInherited = Boolean(
      (left.identityHint && inheritedByIdentity.has(left.identityHint))
      || inheritedByHash.get(`${left.kind}\u0000${left.propertyHash}`),
    );
    const rightInherited = Boolean(
      (right.identityHint && inheritedByIdentity.has(right.identityHint))
      || inheritedByHash.get(`${right.kind}\u0000${right.propertyHash}`),
    );
    return Number(rightInherited) - Number(leftInherited)
      || left.path.join('\u0000').localeCompare(right.path.join('\u0000'));
  });
  for (const seed of seeds) {
    entries.push({
      identity: identity(seed.identityHint, seed.kind, seed.path, seed.propertyHash),
      kind: seed.kind,
      path: [...seed.path],
      propertyHash: seed.propertyHash,
    });
  }
  entries.sort((left, right) => (
    left.path.join('\u0000').localeCompare(right.path.join('\u0000'))
    || left.identity.localeCompare(right.identity)
  ));
  const digestPayload = new TextEncoder().encode(JSON.stringify({
    repositoryId,
    commitId,
    analysisVersion: MERGE_MANIFEST_VERSION,
    parentManifestIds: parentManifests.map((manifest) => manifest.id),
    coverage: fullCoverage ? 'full-document' : 'compare-fallback',
    entries,
  }));
  return {
    id: mergeManifestId(hashBytes(digestPayload)),
    repositoryId,
    commitId,
    analysisVersion: MERGE_MANIFEST_VERSION,
    parentManifestIds: parentManifests.map((manifest) => manifest.id),
    entries,
    coverage: fullCoverage ? 'full-document' : 'compare-fallback',
    createdAt,
  };
}

export function snapshotToMergeTree(snapshot: CompareDocumentSnapshot): unknown {
  const sections = Array.from({ length: snapshot.meta.sectionCount }, (_, section) => ({
    stableId: `section:${section}`,
    kind: 'section',
    paragraphs: snapshot.paragraphs
      .filter((paragraph) => paragraph.section === section)
      .map((paragraph) => ({
        stableId: paragraph.stableId || `paragraph:${section}:${paragraph.paragraph}`,
        kind: 'paragraph',
        text: paragraph.text,
        signature: paragraph.signature,
        controls: snapshot.controls
          .filter((control) => control.section === section && control.paragraph === paragraph.paragraph)
          .map((control) => ({
            stableId: control.key,
            kind: control.kind,
            type: control.type,
            summary: control.summary,
          })),
      })),
  }));
  return {
    kind: 'document',
    meta: snapshot.meta,
    sections,
  };
}

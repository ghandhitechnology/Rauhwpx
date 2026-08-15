import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { FileSystemFileHandleLike } from '../command/file-system-access.ts';
import type { RecentDoc } from './recent-store.ts';

const SAME_ENTRY_TIMEOUT_MS = 200;

export interface DocumentPreflightIdentity {
  documentId: string;
  sourceDigest: string;
  /** Digest participates in cross-window identity only when no handle comparison was authoritative. */
  useSourceDigest: boolean;
}

function createDocumentId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `document_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('isSameEntry timed out')), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function documentSourceDigest(bytes: Uint8Array) {
  return `blake3:${bytesToHex(blake3(bytes))}`;
}

/** Resolve stable identity before WASM receives bytes, using the recent-store rules. */
export async function resolveDocumentPreflight(
  bytes: Uint8Array,
  handle: FileSystemFileHandleLike | null,
  recents: readonly RecentDoc[],
  createId = createDocumentId,
): Promise<DocumentPreflightIdentity> {
  const sourceDigest = documentSourceDigest(bytes);
  let handleComparisonSucceeded = false;

  if (handle && typeof handle.isSameEntry === 'function') {
    for (const recent of [...recents].sort((a, b) => b.openedAt - a.openedAt)) {
      if (!recent.handle) continue;
      try {
        const same = await withTimeout(handle.isSameEntry(recent.handle), SAME_ENTRY_TIMEOUT_MS);
        handleComparisonSucceeded = true;
        if (same) return { documentId: recent.documentId, sourceDigest, useSourceDigest: false };
      } catch {
        // If comparison is unavailable, digest remains the identity fallback.
      }
    }
  }

  const hasNativePathIdentity = handle?.identityKind === 'native-path';
  if (!handleComparisonSucceeded && !hasNativePathIdentity) {
    const digestMatch = [...recents]
      .sort((a, b) => b.openedAt - a.openedAt)
      .find((recent) => recent.sourceDigest === sourceDigest);
    if (digestMatch) return { documentId: digestMatch.documentId, sourceDigest, useSourceDigest: true };
  }

  return {
    documentId: createId(),
    sourceDigest,
    useSourceDigest: !handleComparisonSucceeded && !hasNativePathIdentity,
  };
}

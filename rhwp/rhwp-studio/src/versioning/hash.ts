import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { CompareDocumentSnapshot } from '../compare/types.ts';
import {
  blobId,
  compareSnapshotId,
  contentFingerprint,
  type BlobId,
  type CompareSnapshotId,
  type ContentFingerprint,
} from './types.ts';

const encoder = new TextEncoder();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(',')}}`;
}

export function hashBytes(bytes: Uint8Array): BlobId {
  return blobId(`blake3:${bytesToHex(blake3(bytes))}`);
}

export function fingerprintBytes(bytes: Uint8Array): ContentFingerprint {
  return contentFingerprint(hashBytes(bytes));
}

export function serializeCompareSnapshot(snapshot: CompareDocumentSnapshot): Uint8Array {
  return encoder.encode(canonicalJson(snapshot));
}

export function hashCompareSnapshot(snapshot: CompareDocumentSnapshot): CompareSnapshotId {
  return compareSnapshotId(hashBytes(serializeCompareSnapshot(snapshot)));
}

import type { CompareDocumentSnapshot } from '../compare/types.ts';
import { PORTABLE_HISTORY_MAX_BYTES } from '../core/document-input-limits.ts';
import { hashBytes, serializeCompareSnapshot } from './hash.ts';
import {
  blobId,
  branchName,
  compareSnapshotId,
  type BlobId,
  type BranchName,
  type VersionBlob,
  type VersionCompareSnapshot,
} from './types.ts';
import type { VersionRepositorySnapshot } from './store.ts';

export const PORTABLE_HISTORY_EXTENSION = '.rhwpx';
export const PORTABLE_HISTORY_MIME_TYPE = 'application/vnd.rauhwpx.history';
export const PORTABLE_HISTORY_FORMAT = 'rauhwpx-history';
export const PORTABLE_HISTORY_VERSION = 1;
export { PORTABLE_HISTORY_MAX_BYTES };
export const PORTABLE_HISTORY_MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
export const PORTABLE_HISTORY_MAX_OBJECTS = 50_000;
export const PORTABLE_HISTORY_MAX_REPOSITORY_RECORDS = 50_000;
export const PORTABLE_HISTORY_MAX_COMPARE_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const PORTABLE_HISTORY_MAX_COMPARE_SNAPSHOT_TOTAL_BYTES = 32 * 1024 * 1024;
export const PORTABLE_HISTORY_MAX_COMPARE_SNAPSHOT_ENTRIES = 50_000;
const PORTABLE_HISTORY_MAX_MANIFEST_TOKENS = 1_000_000;
const PORTABLE_HISTORY_MAX_MANIFEST_DEPTH = 64;
const PORTABLE_HISTORY_MAX_SNAPSHOT_TOKENS = 500_000;
/** Payload name used by legacy `.rhwpx` folder bundles. New exports are single files. */
export const PORTABLE_HISTORY_FOLDER_HISTORY_NAME = 'history';

const MAGIC = new TextEncoder().encode('RAUHWPX-HISTORY\0');
const PREFIX_LENGTH = MAGIC.byteLength + 4;

type PortableSourceFormat = 'hwp' | 'hwpx' | 'hml';

interface PortableObjectDescriptor {
  kind: 'blob' | 'compare-snapshot';
  id: string;
  offset: number;
  byteLength: number;
}

interface PortableHistoryManifest {
  format: typeof PORTABLE_HISTORY_FORMAT;
  version: typeof PORTABLE_HISTORY_VERSION;
  createdAt: number;
  activeBranch: string;
  document: {
    fileName: string;
    sourceFormat: PortableSourceFormat;
    currentBlobId: string;
  };
  repository: Omit<VersionRepositorySnapshot, 'blobs' | 'compareSnapshots'>;
  objects: PortableObjectDescriptor[];
}

export interface CreatePortableHistoryBundleInput {
  documentFileName: string;
  sourceFormat: PortableSourceFormat;
  activeBranch: BranchName;
  currentBlobId: BlobId;
  snapshot: VersionRepositorySnapshot;
  createdAt?: number;
}

export interface OpenedPortableHistoryBundle {
  documentFileName: string;
  sourceFormat: PortableSourceFormat;
  activeBranch: BranchName;
  currentBlobId: BlobId;
  currentDocumentBytes: Uint8Array;
  snapshot: VersionRepositorySnapshot;
  createdAt: number;
}

export interface PortableHistoryArchive {
  fileName: string;
  bytes: Uint8Array;
}

export class PortableHistoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PortableHistoryError';
  }
}

function checkedFileName(fileName: string, sourceFormat: PortableSourceFormat): string {
  const normalized = fileName.normalize('NFC').trim();
  if (
    !normalized
    || normalized.length > 255
    || normalized.includes('\0')
    || normalized.includes('/')
    || normalized.includes('\\')
  ) return `document.${sourceFormat}`;
  if (normalized.toLowerCase().endsWith(`.${sourceFormat}`)) return normalized;
  const base = normalized.replace(/\.(hwp|hwpx|hml|rhwpx)$/i, '') || 'document';
  return `${base}.${sourceFormat}`;
}

function checkedSourceFormat(value: unknown): PortableSourceFormat {
  if (value === 'hwp' || value === 'hwpx' || value === 'hml') return value;
  throw new PortableHistoryError('The history bundle has an unsupported document format');
}

function checkedInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new PortableHistoryError(`${label} is invalid`);
  }
  return value as number;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function concatBytes(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function manifestBytes(manifest: PortableHistoryManifest): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (bytes.byteLength > PORTABLE_HISTORY_MAX_MANIFEST_BYTES) {
    throw new PortableHistoryError('The history bundle manifest is too large');
  }
  return bytes;
}

function repositoryRecordCount(repository: Partial<VersionRepositorySnapshot>): number {
  const collections = [
    repository.commits,
    repository.refs,
    repository.shelves,
    repository.mergeManifests,
    repository.mergeDrafts,
  ];
  let total = 0;
  for (const collection of collections) {
    if (!Array.isArray(collection) || collection.length > PORTABLE_HISTORY_MAX_REPOSITORY_RECORDS) {
      throw new PortableHistoryError('The history bundle contains too many repository records');
    }
    total += collection.length;
    if (!Number.isSafeInteger(total) || total > PORTABLE_HISTORY_MAX_REPOSITORY_RECORDS) {
      throw new PortableHistoryError('The history bundle contains too many repository records');
    }
  }
  return total;
}

/** Bound JSON object/array amplification before `JSON.parse` materializes it. */
function preflightJsonStructure(
  text: string,
  label: string,
  maxTokens: number,
): void {
  let depth = 0;
  let tokens = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      depth += 1;
      tokens += 1;
      if (depth > PORTABLE_HISTORY_MAX_MANIFEST_DEPTH) {
        throw new PortableHistoryError(`${label} is nested too deeply`);
      }
    } else if (character === '}' || character === ']') {
      depth -= 1;
      if (depth < 0) throw new PortableHistoryError(`${label} is invalid`);
    } else if (character === ',' || character === ':') {
      tokens += 1;
    }
    if (tokens > maxTokens) {
      throw new PortableHistoryError(`${label} is too complex`);
    }
  }
  if (inString || depth !== 0) throw new PortableHistoryError(`${label} is invalid`);
}

export function portableHistoryFileName(fileName: string): string {
  const base = fileName.trim().replace(/\.(hwp|hwpx|hml|rhwpx)$/i, '') || 'document';
  return `${base}${PORTABLE_HISTORY_EXTENSION}`;
}

export function isPortableHistoryFileName(fileName: string): boolean {
  return fileName.trim().toLowerCase().endsWith(PORTABLE_HISTORY_EXTENSION);
}

export function isPortableHistoryBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= MAGIC.byteLength && bytesEqual(bytes.subarray(0, MAGIC.byteLength), MAGIC);
}

export function createPortableHistoryArchive(
  input: CreatePortableHistoryBundleInput,
): PortableHistoryArchive {
  return {
    fileName: portableHistoryFileName(input.documentFileName),
    bytes: createPortableHistoryBundle(input),
  };
}

export function detectPortableDocumentFormat(bytes: Uint8Array): PortableSourceFormat {
  const cfb = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.byteLength >= cfb.length && cfb.every((value, index) => bytes[index] === value)) return 'hwp';
  if (bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'hwpx';
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 256))).trimStart();
  if (prefix.startsWith('<?xml') || prefix.startsWith('<HwpML') || prefix.startsWith('<hml')) return 'hml';
  throw new PortableHistoryError('The bundled current document format is invalid');
}

export function createPortableHistoryBundle(input: CreatePortableHistoryBundleInput): Uint8Array {
  const objectCount = input.snapshot.blobs.length + input.snapshot.compareSnapshots.length;
  if (!Number.isSafeInteger(objectCount) || objectCount > PORTABLE_HISTORY_MAX_OBJECTS) {
    throw new PortableHistoryError('The history bundle contains too many objects');
  }
  repositoryRecordCount(input.snapshot);
  let preflightPayloadBytes = 0;
  const reservePayloadBytes = (byteLength: number) => {
    if (
      !Number.isSafeInteger(byteLength)
      || byteLength < 0
      || byteLength > PORTABLE_HISTORY_MAX_BYTES - PREFIX_LENGTH - preflightPayloadBytes
    ) throw new PortableHistoryError('The history bundle exceeds the 128 MiB limit');
    preflightPayloadBytes += byteLength;
  };
  for (const blob of input.snapshot.blobs) reservePayloadBytes(blob.bytes.byteLength);
  let declaredCompareSnapshotBytes = 0;
  for (const stored of input.snapshot.compareSnapshots) {
    if (stored.byteLength > PORTABLE_HISTORY_MAX_COMPARE_SNAPSHOT_BYTES) {
      throw new PortableHistoryError('A comparison snapshot exceeds its 16 MiB limit');
    }
    declaredCompareSnapshotBytes += stored.byteLength;
    if (
      !Number.isSafeInteger(declaredCompareSnapshotBytes)
      || declaredCompareSnapshotBytes > PORTABLE_HISTORY_MAX_COMPARE_SNAPSHOT_TOTAL_BYTES
    ) throw new PortableHistoryError('Comparison snapshots exceed their 32 MiB aggregate limit');
    if (
      !Array.isArray(stored.snapshot?.paragraphs)
      || !Array.isArray(stored.snapshot?.controls)
      || stored.snapshot.paragraphs.length + stored.snapshot.controls.length
        > PORTABLE_HISTORY_MAX_COMPARE_SNAPSHOT_ENTRIES
    ) throw new PortableHistoryError('A comparison snapshot contains too many structural entries');
    reservePayloadBytes(stored.byteLength);
  }

  const active = input.snapshot.refs.find((ref) => (
    ref.kind === 'branch' && ref.name === input.activeBranch
  ));
  const head = active
    ? input.snapshot.commits.find((commit) => commit.id === active.target)
    : undefined;
  if (!active || !head || head.blobId !== input.currentBlobId) {
    throw new PortableHistoryError('The current document does not match the active branch head');
  }
  const currentBlob = input.snapshot.blobs.find((blob) => blob.id === input.currentBlobId);
  if (!currentBlob || hashBytes(currentBlob.bytes) !== currentBlob.id) {
    throw new PortableHistoryError('The current document snapshot is missing or corrupt');
  }
  const sourceFormat = detectPortableDocumentFormat(currentBlob.bytes);

  const chunks: Uint8Array[] = [];
  const objects: PortableObjectDescriptor[] = [];
  let offset = 0;
  let appendedCompareSnapshotBytes = 0;
  const append = (kind: PortableObjectDescriptor['kind'], id: string, bytes: Uint8Array) => {
    if (kind === 'compare-snapshot') {
      if (bytes.byteLength > PORTABLE_HISTORY_MAX_COMPARE_SNAPSHOT_BYTES) {
        throw new PortableHistoryError('A comparison snapshot exceeds its 16 MiB limit');
      }
      appendedCompareSnapshotBytes += bytes.byteLength;
      if (
        !Number.isSafeInteger(appendedCompareSnapshotBytes)
        || appendedCompareSnapshotBytes > PORTABLE_HISTORY_MAX_COMPARE_SNAPSHOT_TOTAL_BYTES
      ) throw new PortableHistoryError('Comparison snapshots exceed their 32 MiB aggregate limit');
    }
    if (bytes.byteLength > PORTABLE_HISTORY_MAX_BYTES - PREFIX_LENGTH - offset) {
      throw new PortableHistoryError('The history bundle exceeds the 128 MiB limit');
    }
    if (hashBytes(bytes) !== id) throw new PortableHistoryError(`Portable object ${id} is corrupt`);
    objects.push({ kind, id, offset, byteLength: bytes.byteLength });
    chunks.push(bytes);
    offset += bytes.byteLength;
  };
  for (const blob of [...input.snapshot.blobs].sort((left, right) => left.id.localeCompare(right.id))) {
    append('blob', blob.id, blob.bytes);
  }
  for (const stored of [...input.snapshot.compareSnapshots].sort((left, right) => left.id.localeCompare(right.id))) {
    append('compare-snapshot', stored.id, serializeCompareSnapshot(stored.snapshot));
  }
  const { blobs: _blobs, compareSnapshots: _compareSnapshots, ...repository } = input.snapshot;
  const manifest: PortableHistoryManifest = {
    format: PORTABLE_HISTORY_FORMAT,
    version: PORTABLE_HISTORY_VERSION,
    createdAt: input.createdAt ?? Date.now(),
    activeBranch: input.activeBranch,
    document: {
      fileName: checkedFileName(input.documentFileName, sourceFormat),
      sourceFormat,
      currentBlobId: input.currentBlobId,
    },
    repository,
    objects,
  };
  const encodedManifest = manifestBytes(manifest);
  const totalLength = PREFIX_LENGTH + encodedManifest.byteLength + offset;
  if (totalLength > PORTABLE_HISTORY_MAX_BYTES) {
    throw new PortableHistoryError('The history bundle exceeds the 128 MiB limit');
  }
  const prefix = new Uint8Array(PREFIX_LENGTH);
  prefix.set(MAGIC, 0);
  new DataView(prefix.buffer).setUint32(MAGIC.byteLength, encodedManifest.byteLength, true);
  return concatBytes([prefix, encodedManifest, ...chunks], totalLength);
}

function parseManifest(bytes: Uint8Array): { manifest: PortableHistoryManifest; payloadOffset: number } {
  if (bytes.byteLength < PREFIX_LENGTH || bytes.byteLength > PORTABLE_HISTORY_MAX_BYTES) {
    throw new PortableHistoryError('The history bundle is empty or exceeds the 128 MiB limit');
  }
  if (!bytesEqual(bytes.subarray(0, MAGIC.byteLength), MAGIC)) {
    throw new PortableHistoryError('This is not a RauHWPX history bundle');
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(MAGIC.byteLength, true);
  if (
    length === 0
    || length > PORTABLE_HISTORY_MAX_MANIFEST_BYTES
    || PREFIX_LENGTH + length > bytes.byteLength
  ) {
    throw new PortableHistoryError('The history bundle manifest length is invalid');
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(PREFIX_LENGTH, PREFIX_LENGTH + length),
    );
    preflightJsonStructure(
      text,
      'The history bundle manifest',
      PORTABLE_HISTORY_MAX_MANIFEST_TOKENS,
    );
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PortableHistoryError('The history bundle manifest is invalid', {
      cause: error instanceof Error ? error : undefined,
    });
  }
  const manifest = parsed as Partial<PortableHistoryManifest>;
  if (
    manifest.format !== PORTABLE_HISTORY_FORMAT
    || manifest.version !== PORTABLE_HISTORY_VERSION
    || !manifest.document
    || !manifest.repository
    || !Array.isArray(manifest.objects)
  ) throw new PortableHistoryError('The history bundle schema is unsupported');
  return { manifest: manifest as PortableHistoryManifest, payloadOffset: PREFIX_LENGTH + length };
}

export function openPortableHistoryBundle(bytes: Uint8Array): OpenedPortableHistoryBundle {
  const { manifest, payloadOffset } = parseManifest(bytes);
  if (manifest.objects.length > PORTABLE_HISTORY_MAX_OBJECTS) {
    throw new PortableHistoryError('The history bundle contains too many objects');
  }
  const repository = manifest.repository as Partial<VersionRepositorySnapshot>;
  if (
    repository.schemaVersion !== 1
    || !repository.repository
    || !Array.isArray(repository.commits)
    || !Array.isArray(repository.refs)
    || !Array.isArray(repository.shelves)
    || !Array.isArray(repository.mergeManifests)
    || !Array.isArray(repository.mergeDrafts)
  ) throw new PortableHistoryError('The history bundle repository schema is invalid');
  repositoryRecordCount(repository);

  type CheckedDescriptor = PortableObjectDescriptor & { offset: number; byteLength: number };
  const descriptors: CheckedDescriptor[] = [];
  const ids = new Set<string>();
  let compareSnapshotBytes = 0;
  for (const candidate of manifest.objects) {
    if (!candidate || typeof candidate !== 'object') {
      throw new PortableHistoryError('The history bundle object table is invalid');
    }
    const descriptor = candidate as PortableObjectDescriptor;
    if (
      (descriptor.kind !== 'blob' && descriptor.kind !== 'compare-snapshot')
      || typeof descriptor.id !== 'string'
      || ids.has(`${descriptor.kind}:${descriptor.id}`)
    ) throw new PortableHistoryError('The history bundle object table is invalid');
    ids.add(`${descriptor.kind}:${descriptor.id}`);
    const offset = checkedInteger(descriptor.offset, 'Portable object offset', bytes.byteLength);
    const byteLength = checkedInteger(descriptor.byteLength, 'Portable object length', bytes.byteLength);
    if (descriptor.kind === 'compare-snapshot') {
      if (byteLength > PORTABLE_HISTORY_MAX_COMPARE_SNAPSHOT_BYTES) {
        throw new PortableHistoryError('A comparison snapshot exceeds its 16 MiB limit');
      }
      compareSnapshotBytes += byteLength;
      if (
        !Number.isSafeInteger(compareSnapshotBytes)
        || compareSnapshotBytes > PORTABLE_HISTORY_MAX_COMPARE_SNAPSHOT_TOTAL_BYTES
      ) throw new PortableHistoryError('Comparison snapshots exceed their 32 MiB aggregate limit');
    }
    descriptors.push({ ...descriptor, offset, byteLength });
  }
  descriptors.sort((left, right) => left.offset - right.offset);

  let expectedOffset = 0;
  for (const descriptor of descriptors) {
    const { offset, byteLength } = descriptor;
    if (offset !== expectedOffset || payloadOffset + offset + byteLength > bytes.byteLength) {
      throw new PortableHistoryError('The history bundle object boundaries are invalid');
    }
    expectedOffset += byteLength;
  }
  if (payloadOffset + expectedOffset !== bytes.byteLength) {
    throw new PortableHistoryError('The history bundle contains unindexed trailing data');
  }

  for (const descriptor of descriptors) {
    const payload = bytes.subarray(
      payloadOffset + descriptor.offset,
      payloadOffset + descriptor.offset + descriptor.byteLength,
    );
    if (hashBytes(payload) !== descriptor.id) {
      throw new PortableHistoryError(`Portable object ${descriptor.id} failed integrity verification`);
    }
  }

  const compareSnapshots: VersionCompareSnapshot[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.kind === 'compare-snapshot') {
      const payload = bytes.subarray(
        payloadOffset + descriptor.offset,
        payloadOffset + descriptor.offset + descriptor.byteLength,
      );
      let snapshot: CompareDocumentSnapshot;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
        preflightJsonStructure(
          text,
          `Comparison snapshot ${descriptor.id}`,
          PORTABLE_HISTORY_MAX_SNAPSHOT_TOKENS,
        );
        snapshot = JSON.parse(text) as CompareDocumentSnapshot;
      } catch (error) {
        throw new PortableHistoryError(`Comparison snapshot ${descriptor.id} is invalid`, {
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (
        !snapshot
        || typeof snapshot !== 'object'
        || !snapshot.meta
        || !Array.isArray(snapshot.paragraphs)
        || !Array.isArray(snapshot.controls)
        || snapshot.paragraphs.length + snapshot.controls.length
          > PORTABLE_HISTORY_MAX_COMPARE_SNAPSHOT_ENTRIES
      ) throw new PortableHistoryError(`Comparison snapshot ${descriptor.id} has an invalid schema`);
      compareSnapshots.push({
        id: compareSnapshotId(descriptor.id),
        byteLength: descriptor.byteLength,
        snapshot,
      });
    }
  }
  const blobs: VersionBlob[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'blob') continue;
    const payload = bytes.subarray(
      payloadOffset + descriptor.offset,
      payloadOffset + descriptor.offset + descriptor.byteLength,
    );
    blobs.push({
      id: blobId(descriptor.id),
      byteLength: descriptor.byteLength,
      // Keep a view into the already-resident archive. Import copies one exact
      // blob at a time at the storage boundary; copying every payload here
      // would temporarily retain a second full archive.
      bytes: payload,
    });
  }

  const sourceFormat = checkedSourceFormat(manifest.document.sourceFormat);
  const currentBlobId = blobId(manifest.document.currentBlobId);
  const current = blobs.find((blob) => blob.id === currentBlobId);
  if (!current) throw new PortableHistoryError('The bundled current document is missing');
  const snapshot: VersionRepositorySnapshot = {
    ...(manifest.repository as Omit<VersionRepositorySnapshot, 'blobs' | 'compareSnapshots'>),
    blobs,
    compareSnapshots,
  };
  const active = snapshot.refs.find((ref) => ref.kind === 'branch' && ref.name === manifest.activeBranch);
  const activeHead = active && snapshot.commits.find((commit) => commit.id === active.target);
  if (!active || !activeHead || activeHead.blobId !== currentBlobId) {
    throw new PortableHistoryError('The bundled current document does not match the active branch head');
  }
  if (detectPortableDocumentFormat(current.bytes) !== sourceFormat) {
    throw new PortableHistoryError('The bundled current document format does not match its manifest');
  }
  return {
    documentFileName: checkedFileName(manifest.document.fileName, sourceFormat),
    sourceFormat,
    activeBranch: branchName(manifest.activeBranch),
    currentBlobId,
    currentDocumentBytes: current.bytes,
    snapshot,
    createdAt: checkedInteger(manifest.createdAt, 'History bundle creation time'),
  };
}

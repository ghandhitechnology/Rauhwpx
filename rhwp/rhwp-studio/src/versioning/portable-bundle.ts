import type { CompareDocumentSnapshot } from '../compare/types.ts';
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
/** Filename of the history payload inside a `.rhwpx` folder bundle. */
export const PORTABLE_HISTORY_FOLDER_HISTORY_NAME = 'history';

const MAGIC = new TextEncoder().encode('RAUHWPX-HISTORY\0');
const PREFIX_LENGTH = MAGIC.byteLength + 4;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_OBJECTS = 50_000;

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

export interface PortableHistoryFolderFile {
  name: string;
  bytes: Uint8Array;
}

export interface PortableHistoryFolder {
  folderName: string;
  files: PortableHistoryFolderFile[];
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
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new PortableHistoryError('The history bundle manifest is too large');
  }
  return bytes;
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

export function createPortableHistoryFolder(input: CreatePortableHistoryBundleInput): PortableHistoryFolder {
  const historyBytes = createPortableHistoryBundle(input);
  const currentBlob = input.snapshot.blobs.find((blob) => blob.id === input.currentBlobId);
  if (!currentBlob) throw new PortableHistoryError('The current document snapshot is missing or corrupt');
  const sourceFormat = detectPortableDocumentFormat(currentBlob.bytes);
  const documentFileName = checkedFileName(input.documentFileName, sourceFormat);
  return {
    folderName: portableHistoryFileName(input.documentFileName),
    files: [
      { name: PORTABLE_HISTORY_FOLDER_HISTORY_NAME, bytes: historyBytes },
      { name: documentFileName, bytes: new Uint8Array(currentBlob.bytes) },
    ],
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
  const append = (kind: PortableObjectDescriptor['kind'], id: string, bytes: Uint8Array) => {
    if (hashBytes(bytes) !== id) throw new PortableHistoryError(`Portable object ${id} is corrupt`);
    objects.push({ kind, id, offset, byteLength: bytes.byteLength });
    chunks.push(bytes);
    offset += bytes.byteLength;
  };
  for (const blob of [...input.snapshot.blobs].sort((left, right) => left.id.localeCompare(right.id))) {
    append('blob', blob.id, new Uint8Array(blob.bytes));
  }
  for (const stored of [...input.snapshot.compareSnapshots].sort((left, right) => left.id.localeCompare(right.id))) {
    append('compare-snapshot', stored.id, serializeCompareSnapshot(stored.snapshot));
  }
  if (objects.length > MAX_OBJECTS) throw new PortableHistoryError('The history bundle contains too many objects');

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
  if (totalLength > MAX_BUNDLE_BYTES) throw new PortableHistoryError('The history bundle exceeds the 512 MiB limit');
  const prefix = new Uint8Array(PREFIX_LENGTH);
  prefix.set(MAGIC, 0);
  new DataView(prefix.buffer).setUint32(MAGIC.byteLength, encodedManifest.byteLength, true);
  return concatBytes([prefix, encodedManifest, ...chunks], totalLength);
}

function parseManifest(bytes: Uint8Array): { manifest: PortableHistoryManifest; payloadOffset: number } {
  if (bytes.byteLength < PREFIX_LENGTH || bytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new PortableHistoryError('The history bundle is empty or exceeds the 512 MiB limit');
  }
  if (!bytesEqual(bytes.subarray(0, MAGIC.byteLength), MAGIC)) {
    throw new PortableHistoryError('This is not a RauHWPX history bundle');
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(MAGIC.byteLength, true);
  if (length === 0 || length > MAX_MANIFEST_BYTES || PREFIX_LENGTH + length > bytes.byteLength) {
    throw new PortableHistoryError('The history bundle manifest length is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(PREFIX_LENGTH, PREFIX_LENGTH + length),
    ));
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
  if (manifest.objects.length > MAX_OBJECTS) {
    throw new PortableHistoryError('The history bundle contains too many objects');
  }
  const descriptors = [...manifest.objects].sort((left, right) => left.offset - right.offset);
  const ids = new Set<string>();
  let expectedOffset = 0;
  const blobs: VersionBlob[] = [];
  const compareSnapshots: VersionCompareSnapshot[] = [];
  for (const descriptor of descriptors) {
    if (
      (descriptor.kind !== 'blob' && descriptor.kind !== 'compare-snapshot')
      || typeof descriptor.id !== 'string'
      || ids.has(`${descriptor.kind}:${descriptor.id}`)
    ) throw new PortableHistoryError('The history bundle object table is invalid');
    ids.add(`${descriptor.kind}:${descriptor.id}`);
    const offset = checkedInteger(descriptor.offset, 'Portable object offset', bytes.byteLength);
    const byteLength = checkedInteger(descriptor.byteLength, 'Portable object length', bytes.byteLength);
    if (offset !== expectedOffset || payloadOffset + offset + byteLength > bytes.byteLength) {
      throw new PortableHistoryError('The history bundle object boundaries are invalid');
    }
    const payload = new Uint8Array(bytes.subarray(
      payloadOffset + offset,
      payloadOffset + offset + byteLength,
    ));
    if (hashBytes(payload) !== descriptor.id) {
      throw new PortableHistoryError(`Portable object ${descriptor.id} failed integrity verification`);
    }
    if (descriptor.kind === 'blob') {
      blobs.push({ id: blobId(descriptor.id), byteLength, bytes: payload });
    } else {
      let snapshot: CompareDocumentSnapshot;
      try {
        snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) as CompareDocumentSnapshot;
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
      ) throw new PortableHistoryError(`Comparison snapshot ${descriptor.id} has an invalid schema`);
      compareSnapshots.push({ id: compareSnapshotId(descriptor.id), byteLength, snapshot });
    }
    expectedOffset += byteLength;
  }
  if (payloadOffset + expectedOffset !== bytes.byteLength) {
    throw new PortableHistoryError('The history bundle contains unindexed trailing data');
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
    currentDocumentBytes: new Uint8Array(current.bytes),
    snapshot,
    createdAt: checkedInteger(manifest.createdAt, 'History bundle creation time'),
  };
}

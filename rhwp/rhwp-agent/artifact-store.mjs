import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { crc32, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

import { sanitizeFilename } from './download-manager.mjs';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS = 20;
const MAX_SNAPSHOTTED_BYTES = 128 * 1024 * 1024;
const MAX_PENDING_INSPECTIONS = 20;
const MAX_HWPX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_HWPX_ENTRIES = 4096;
const MAX_HWPX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_HWPX_CONTENT_HPF_BYTES = 8 * 1024 * 1024;
const HWPX_MIMETYPE = 'application/hwp+zip';
const HWPX_MIMETYPE_BYTES = Buffer.byteLength(HWPX_MIMETYPE);
const inflateRawAsync = promisify(inflateRaw);
const HWPX_REQUIRED_ENTRIES = Object.freeze([
  'mimetype',
  'version.xml',
  'Contents/header.xml',
  'Contents/content.hpf',
  'Contents/section0.xml',
  'Preview/PrvText.txt',
  'Preview/PrvImage.png',
  'settings.xml',
  'META-INF/container.xml',
  'META-INF/container.rdf',
  'META-INF/manifest.xml',
]);
const FORMATS = Object.freeze({
  '.hwp': {
    mime: 'application/x-hwp',
    signature: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  },
  '.hwpx': {
    mime: 'application/vnd.hancom.hwpx+zip',
    signature: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  },
});

function artifactError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function formatFor(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  const format = FORMATS[extension];
  if (!format) {
    throw artifactError('ARTIFACT_FORMAT_UNSUPPORTED', 'Only generated HWP and HWPX files can be published');
  }
  return { extension, ...format };
}

function validateSignature(bytes, signature, extension) {
  if (bytes.length < signature.length || !bytes.subarray(0, signature.length).equals(signature)) {
    throw artifactError(
      'ARTIFACT_FORMAT_MISMATCH',
      `Generated ${extension.slice(1).toUpperCase()} file does not have the expected signature`,
    );
  }
}

function validateHwpCfb(bytes) {
  if (bytes.length < 1536 || bytes.readUInt16LE(28) !== 0xfffe) {
    throw artifactError('ARTIFACT_HWP_INVALID', 'HWP CFB header is missing or truncated');
  }
  const majorVersion = bytes.readUInt16LE(26);
  const sectorShift = bytes.readUInt16LE(30);
  const sectorSize = 2 ** sectorShift;
  if (!((majorVersion === 3 && sectorShift === 9) || (majorVersion === 4 && sectorShift === 12))
    || bytes.readUInt16LE(32) !== 6
    || bytes.length % sectorSize !== 0) {
    throw artifactError('ARTIFACT_HWP_INVALID', 'HWP CFB sector layout is invalid');
  }
  const sectorCount = (bytes.length / sectorSize) - 1;
  const fatSectorCount = bytes.readUInt32LE(44);
  const firstDirectorySector = bytes.readUInt32LE(48);
  const miniStreamCutoff = bytes.readUInt32LE(56);
  if (fatSectorCount === 0 || fatSectorCount > sectorCount
    || firstDirectorySector >= sectorCount || miniStreamCutoff !== 4096) {
    throw artifactError('ARTIFACT_HWP_INVALID', 'HWP CFB allocation table is invalid');
  }
  const directoryOffset = (firstDirectorySector + 1) * sectorSize;
  if (directoryOffset + 128 > bytes.length || bytes[directoryOffset + 66] !== 5) {
    throw artifactError('ARTIFACT_HWP_INVALID', 'HWP CFB root directory is missing');
  }
  const rootNameLength = bytes.readUInt16LE(directoryOffset + 64);
  const rootName = bytes.subarray(directoryOffset, directoryOffset + Math.max(0, rootNameLength - 2))
    .toString('utf16le');
  if (rootName !== 'Root Entry') {
    throw artifactError('ARTIFACT_HWP_INVALID', 'HWP CFB root directory is malformed');
  }
}

async function readExactFile(fileHandle, expectedSize, maxBytes) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maxBytes) {
    throw artifactError('ARTIFACT_TOO_LARGE', `Generated artifact exceeds the ${maxBytes}-byte limit`);
  }
  const bytes = Buffer.allocUnsafe(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const { bytesRead } = await fileHandle.read(bytes, offset, expectedSize - offset, offset);
    if (bytesRead === 0) throw artifactError('ARTIFACT_CHANGED', 'Generated artifact changed while it was being published');
    offset += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await fileHandle.read(extra, 0, 1, expectedSize)).bytesRead !== 0) {
    throw artifactError('ARTIFACT_CHANGED', 'Generated artifact changed while it was being published');
  }
  return bytes;
}

function findZipEnd(bytes) {
  if (bytes.length < 22) {
    throw artifactError('ARTIFACT_HWPX_INVALID', 'HWPX ZIP directory is missing or truncated');
  }
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    if (offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) return offset;
  }
  throw artifactError('ARTIFACT_HWPX_INVALID', 'HWPX ZIP directory is missing or truncated');
}

function safeZipEntryName(name) {
  return name.length > 0
    && !name.includes('\0')
    && !name.includes('\\')
    && !name.startsWith('/')
    && !name.split('/').includes('..');
}

function bufferView(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return Buffer.from(input);
}

function maxExpandedBytesForEntry(name) {
  return name === 'Contents/content.hpf'
    ? MAX_HWPX_CONTENT_HPF_BYTES
    : MAX_HWPX_ENTRY_BYTES;
}

/** Parse and checksum every ZIP member instead of accepting a four-byte PK signature. */
export async function validateHwpxPackage(input) {
  const bytes = bufferView(input);
  if (bytes.length > DEFAULT_MAX_BYTES) {
    throw artifactError('ARTIFACT_TOO_LARGE', `Generated artifact exceeds the ${DEFAULT_MAX_BYTES}-byte limit`);
  }
  const endOffset = findZipEnd(bytes);
  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const directoryDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntries = bytes.readUInt16LE(endOffset + 8);
  const totalEntries = bytes.readUInt16LE(endOffset + 10);
  const directorySize = bytes.readUInt32LE(endOffset + 12);
  const directoryOffset = bytes.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || directoryDisk !== 0 || totalEntries === 0 || diskEntries !== totalEntries) {
    throw artifactError('ARTIFACT_HWPX_INVALID', 'HWPX must be a complete single-disk ZIP package');
  }
  if (totalEntries > MAX_HWPX_ENTRIES) {
    throw artifactError(
      'ARTIFACT_HWPX_INVALID',
      `HWPX contains more than ${MAX_HWPX_ENTRIES} entries`,
    );
  }
  if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw artifactError('ARTIFACT_HWPX_INVALID', 'ZIP64 HWPX packages are not supported for chat artifacts');
  }
  if (directoryOffset + directorySize !== endOffset) {
    throw artifactError('ARTIFACT_HWPX_INVALID', 'HWPX ZIP directory offsets are inconsistent');
  }

  const entries = new Map();
  const localRanges = [];
  let expandedBytes = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw artifactError('ARTIFACT_HWPX_INVALID', 'HWPX ZIP central directory is malformed');
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
    if (nextCursor > endOffset || (flags & 0x1) !== 0 || (method !== 0 && method !== 8)) {
      throw artifactError('ARTIFACT_HWPX_INVALID', 'HWPX contains an unreadable or encrypted ZIP entry');
    }
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (!safeZipEntryName(name) || entries.has(name)) {
      throw artifactError('ARTIFACT_HWPX_INVALID', 'HWPX contains an unsafe or duplicate ZIP entry');
    }
    if (localOffset + 30 > directoryOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw artifactError('ARTIFACT_HWPX_INVALID', `HWPX entry has an invalid local header: ${name}`);
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    if (localName !== name || dataOffset + compressedSize > directoryOffset) {
      throw artifactError('ARTIFACT_HWPX_INVALID', `HWPX entry is truncated or mismatched: ${name}`);
    }
    const maxEntryBytes = maxExpandedBytesForEntry(name);
    if (uncompressedSize > maxEntryBytes) {
      throw artifactError(
        'ARTIFACT_HWPX_INVALID',
        `HWPX entry expands beyond the ${maxEntryBytes}-byte member limit: ${name}`,
      );
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_HWPX_EXPANDED_BYTES) {
      throw artifactError('ARTIFACT_HWPX_INVALID', 'HWPX expands beyond the 256 MiB safety limit');
    }
    entries.set(name, {
      method,
      localOffset,
      dataOffset,
      compressedSize,
      uncompressedSize,
      expectedCrc,
      content: null,
    });
    localRanges.push([localOffset, dataOffset + compressedSize, name]);
    cursor = nextCursor;
  }
  if (cursor !== endOffset) {
    throw artifactError('ARTIFACT_HWPX_INVALID', 'HWPX ZIP directory has unexpected trailing data');
  }
  localRanges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index][0] < localRanges[index - 1][1]) {
      throw artifactError('ARTIFACT_HWPX_INVALID', `HWPX entries overlap: ${localRanges[index][2]}`);
    }
  }

  for (const required of HWPX_REQUIRED_ENTRIES) {
    if (!entries.has(required)) {
      throw artifactError('ARTIFACT_HWPX_INVALID', `HWPX package is missing required entry: ${required}`);
    }
  }
  const first = entries.get('mimetype');
  if (first.localOffset !== 0 || first.method !== 0 || first.uncompressedSize !== HWPX_MIMETYPE_BYTES) {
    throw artifactError(
      'ARTIFACT_HWPX_INVALID',
      `HWPX mimetype must be the first uncompressed entry and equal ${HWPX_MIMETYPE}`,
    );
  }
  const sections = [...entries.keys()]
    .flatMap((name) => name.match(/^Contents\/section(\d+)\.xml$/)?.[1] ?? [])
    .map(Number)
    .sort((a, b) => a - b);
  if (sections.some((section, index) => section !== index)) {
    throw artifactError('ARTIFACT_HWPX_INVALID', 'HWPX section entries must be consecutively numbered from section0.xml');
  }

  // Inflate one member at a time on libuv's worker pool. Keep only the two
  // bounded members needed below; all other expanded buffers can be released
  // before the next member is processed. Node's native crc32 avoids a
  // JavaScript loop over as much as 256 MiB of expanded content.
  for (const [name, entry] of entries) {
    const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    let content;
    try {
      content = entry.method === 0
        ? compressed
        : await inflateRawAsync(compressed, {
          maxOutputLength: Math.max(1, entry.uncompressedSize),
        });
    } catch {
      throw artifactError('ARTIFACT_HWPX_INVALID', `HWPX entry cannot be decompressed: ${name}`);
    }
    if (content.length !== entry.uncompressedSize || crc32(content) !== entry.expectedCrc) {
      throw artifactError('ARTIFACT_HWPX_INVALID', `HWPX entry checksum or size is invalid: ${name}`);
    }
    if (name === 'mimetype' || name === 'Contents/content.hpf') entry.content = content;
  }

  if (first.content.toString('utf8') !== HWPX_MIMETYPE) {
    throw artifactError(
      'ARTIFACT_HWPX_INVALID',
      `HWPX mimetype must be the first uncompressed entry and equal ${HWPX_MIMETYPE}`,
    );
  }

  const manifest = entries.get('Contents/content.hpf').content.toString('utf8');
  for (const match of manifest.matchAll(/<(?:[\w.-]+:)?item\b[^>]*\bhref\s*=\s*["']([^"']+)["']/giu)) {
    const href = match[1].split(/[?#]/, 1)[0];
    let decoded;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      throw artifactError('ARTIFACT_HWPX_INVALID', `HWPX manifest contains an invalid href: ${href}`);
    }
    const resolved = entries.has(decoded) ? decoded : path.posix.join('Contents', decoded);
    if (!safeZipEntryName(resolved) || !entries.has(resolved)) {
      throw artifactError('ARTIFACT_HWPX_INVALID', `HWPX manifest references a missing entry: ${href}`);
    }
  }
  return { entryCount: entries.size, sectionCount: sections.length };
}

export class ArtifactStore {
  constructor({
    rootDir,
    trustedReadRoots = [],
    maxBytes = DEFAULT_MAX_BYTES,
    createId = () => `artifact_${crypto.randomBytes(24).toString('base64url')}`,
    readExactFileImpl = readExactFile,
  } = {}) {
    if (!rootDir) throw new Error('ArtifactStore requires rootDir');
    this.rootDir = path.resolve(rootDir);
    this.trustedReadRoots = [...new Set(
      (Array.isArray(trustedReadRoots) ? trustedReadRoots : [])
        .map((root) => path.resolve(String(root))),
    )].filter((root) => root !== this.rootDir);
    this.maxBytes = maxBytes;
    this.createId = createId;
    this.readExactFile = readExactFileImpl;
    this.records = new Map();
    this.snapshottedBytes = 0;
    this.inspectionActive = false;
    this.inspectionWaiters = [];
  }

  async runWithInspectionMemory(task) {
    if (this.inspectionActive) {
      if (this.inspectionWaiters.length >= MAX_PENDING_INSPECTIONS) {
        throw artifactError(
          'ARTIFACT_BUSY',
          'Too many generated artifacts are already waiting to be inspected',
        );
      }
      await new Promise((resolve) => this.inspectionWaiters.push(resolve));
    } else {
      this.inspectionActive = true;
    }
    try {
      return await task();
    } finally {
      const next = this.inspectionWaiters.shift();
      if (next) next();
      else this.inspectionActive = false;
    }
  }

  async inspectFileUnchecked(filePath, requestedName) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw artifactError('ARTIFACT_PATH_INVALID', 'Published artifact path must be absolute');
    }
    const resolved = path.resolve(filePath);
    const stat = await fs.lstat(resolved).catch((error) => {
      if (error?.code === 'ENOENT') throw artifactError('ARTIFACT_NOT_FOUND', 'Generated artifact file does not exist');
      throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw artifactError('ARTIFACT_PATH_INVALID', 'Published artifact must be a regular file, not a link or directory');
    }
    if (stat.size === 0) throw artifactError('ARTIFACT_EMPTY', 'Generated artifact file is empty');
    if (stat.size > this.maxBytes) {
      throw artifactError('ARTIFACT_TOO_LARGE', `Generated artifact exceeds the ${this.maxBytes}-byte limit`);
    }
    const canonical = await fs.realpath(resolved);
    // macOS commonly canonicalizes /var to /private/var. Compare canonical paths
    // on both sides so that alias does not look like a workspace escape.
    const canonicalRoots = await Promise.all(
      [this.rootDir, ...this.trustedReadRoots].map((root) => fs.realpath(root).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      })),
    );
    if (!canonicalRoots.some((root) => root && isInside(root, canonical))) {
      throw artifactError('ARTIFACT_PATH_OUTSIDE_WORKSPACE', 'Generated artifact resolves outside this chat workspace');
    }
    const requested = sanitizeFilename(requestedName ?? path.basename(canonical), path.basename(canonical));
    const canonicalFormat = formatFor(canonical);
    const requestedStem = path.basename(requested, path.extname(requested)) || 'document';
    const fileName = `${requestedStem}${canonicalFormat.extension}`;
    const fileHandle = await fs.open(canonical, fsConstants.O_RDONLY);
    let bytes;
    try {
      const openedStat = await fileHandle.stat();
      if (!openedStat.isFile() || openedStat.size !== stat.size
        || (stat.ino && openedStat.ino && stat.ino !== openedStat.ino)
        || (stat.dev && openedStat.dev && stat.dev !== openedStat.dev)) {
        throw artifactError('ARTIFACT_CHANGED', 'Generated artifact changed while it was being published');
      }
      bytes = await this.readExactFile(fileHandle, openedStat.size, this.maxBytes);
    } finally {
      await fileHandle.close();
    }
    validateSignature(bytes, canonicalFormat.signature, canonicalFormat.extension);
    if (canonicalFormat.extension === '.hwp') validateHwpCfb(bytes);
    else if (canonicalFormat.extension === '.hwpx') await validateHwpxPackage(bytes);
    return { canonical, bytes, fileName, mime: canonicalFormat.mime };
  }

  async inspectFile(filePath, requestedName) {
    // A HWPX inspection can hold the compressed source and one expanded ZIP
    // member at once. Serialize inspections before either allocation so a
    // burst of publish_artifact calls has a fixed per-chat memory ceiling.
    return this.runWithInspectionMemory(
      () => this.inspectFileUnchecked(filePath, requestedName),
    );
  }

  async publish({ filePath, fileName }) {
    return this.runWithInspectionMemory(async () => {
      const inspected = await this.inspectFileUnchecked(filePath, fileName);
      const artifactId = String(this.createId());
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(artifactId)) {
        throw artifactError('ARTIFACT_ID_INVALID', 'Artifact id generator returned an invalid id');
      }
      if (this.records.has(artifactId)) {
        throw artifactError('ARTIFACT_ID_INVALID', 'Artifact id generator returned a duplicate id');
      }
      // readExactFile created this buffer for the store. Keeping that owned
      // snapshot avoids a second allocation as large as the artifact while
      // remaining independent from later workspace-file writes.
      const snapshot = inspected.bytes;
      this.records.set(artifactId, Object.freeze({
        fileName: inspected.fileName,
        mime: inspected.mime,
        size: snapshot.length,
        checksum: `sha256:${crypto.createHash('sha256').update(snapshot).digest('hex')}`,
        bytes: snapshot,
      }));
      this.snapshottedBytes += snapshot.length;
      while (this.records.size > MAX_ARTIFACTS || this.snapshottedBytes > MAX_SNAPSHOTTED_BYTES) {
        const oldestId = this.records.keys().next().value;
        const oldest = this.records.get(oldestId);
        this.snapshottedBytes -= oldest?.size ?? 0;
        this.records.delete(oldestId);
      }
      const { bytes: _bytes, ...published } = this.records.get(artifactId);
      return { artifactId, ...published };
    });
  }

  async read(artifactId) {
    const record = this.records.get(String(artifactId ?? ''));
    if (!record) throw artifactError('ARTIFACT_NOT_FOUND', 'Generated artifact is unavailable or expired');
    // Callers borrow the store-owned snapshot and pass it directly to the HTTP
    // or template sink. They must not mutate it. Copying here doubled peak
    // memory for every 64 MiB download without adding source-file isolation.
    return record;
  }
}

import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

import { sanitizeFilename } from './download-manager.mjs';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS = 20;
const MAX_SNAPSHOTTED_BYTES = 128 * 1024 * 1024;
const MAX_HWPX_EXPANDED_BYTES = 256 * 1024 * 1024;
const HWPX_MIMETYPE = 'application/hwp+zip';
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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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

/** Parse and checksum every ZIP member instead of accepting a four-byte PK signature. */
export function validateHwpxPackage(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
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
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_HWPX_EXPANDED_BYTES) {
      throw artifactError('ARTIFACT_HWPX_INVALID', 'HWPX expands beyond the 256 MiB safety limit');
    }
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    let content;
    try {
      content = method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) });
    } catch {
      throw artifactError('ARTIFACT_HWPX_INVALID', `HWPX entry cannot be decompressed: ${name}`);
    }
    if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) {
      throw artifactError('ARTIFACT_HWPX_INVALID', `HWPX entry checksum or size is invalid: ${name}`);
    }
    entries.set(name, { content, method, localOffset });
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
  if (first.localOffset !== 0 || first.method !== 0 || first.content.toString('utf8') !== HWPX_MIMETYPE) {
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
  constructor({ rootDir, maxBytes = DEFAULT_MAX_BYTES, createId = () => crypto.randomBytes(24).toString('base64url') } = {}) {
    if (!rootDir) throw new Error('ArtifactStore requires rootDir');
    this.rootDir = path.resolve(rootDir);
    this.maxBytes = maxBytes;
    this.createId = createId;
    this.records = new Map();
    this.snapshottedBytes = 0;
  }

  async inspectFile(filePath, requestedName) {
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
    const canonicalRoot = await fs.realpath(this.rootDir);
    if (!isInside(canonicalRoot, canonical)) {
      throw artifactError('ARTIFACT_PATH_OUTSIDE_WORKSPACE', 'Generated artifact resolves outside this chat workspace');
    }
    const requested = sanitizeFilename(requestedName ?? path.basename(canonical), path.basename(canonical));
    const canonicalFormat = formatFor(canonical);
    const requestedStem = path.basename(requested, path.extname(requested)) || 'document';
    const fileName = `${requestedStem}${canonicalFormat.extension}`;
    const bytes = await fs.readFile(canonical);
    if (bytes.length !== stat.size) {
      throw artifactError('ARTIFACT_CHANGED', 'Generated artifact changed while it was being published');
    }
    validateSignature(bytes, canonicalFormat.signature, canonicalFormat.extension);
    if (canonicalFormat.extension === '.hwp') validateHwpCfb(bytes);
    else if (canonicalFormat.extension === '.hwpx') validateHwpxPackage(bytes);
    return { canonical, bytes, fileName, mime: canonicalFormat.mime };
  }

  async publish({ filePath, fileName }) {
    const inspected = await this.inspectFile(filePath, fileName);
    const artifactId = String(this.createId());
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(artifactId)) {
      throw artifactError('ARTIFACT_ID_INVALID', 'Artifact id generator returned an invalid id');
    }
    if (this.records.has(artifactId)) {
      throw artifactError('ARTIFACT_ID_INVALID', 'Artifact id generator returned a duplicate id');
    }
    const snapshot = Buffer.from(inspected.bytes);
    this.records.set(artifactId, {
      fileName: inspected.fileName,
      mime: inspected.mime,
      size: snapshot.length,
      checksum: `sha256:${crypto.createHash('sha256').update(snapshot).digest('hex')}`,
      bytes: snapshot,
    });
    this.snapshottedBytes += snapshot.length;
    while (this.records.size > MAX_ARTIFACTS || this.snapshottedBytes > MAX_SNAPSHOTTED_BYTES) {
      const oldestId = this.records.keys().next().value;
      const oldest = this.records.get(oldestId);
      this.snapshottedBytes -= oldest?.size ?? 0;
      this.records.delete(oldestId);
    }
    const { bytes: _bytes, ...published } = this.records.get(artifactId);
    return { artifactId, ...published };
  }

  async read(artifactId) {
    const record = this.records.get(String(artifactId ?? ''));
    if (!record) throw artifactError('ARTIFACT_NOT_FOUND', 'Generated artifact is unavailable or expired');
    return { ...record, bytes: Buffer.from(record.bytes) };
  }
}

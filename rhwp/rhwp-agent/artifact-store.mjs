import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { sanitizeFilename } from './download-manager.mjs';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS = 20;
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

export class ArtifactStore {
  constructor({ rootDir, maxBytes = DEFAULT_MAX_BYTES, createId = () => crypto.randomBytes(24).toString('base64url') } = {}) {
    if (!rootDir) throw new Error('ArtifactStore requires rootDir');
    this.rootDir = path.resolve(rootDir);
    this.maxBytes = maxBytes;
    this.createId = createId;
    this.records = new Map();
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
    return { canonical, bytes, fileName, mime: canonicalFormat.mime };
  }

  async publish({ filePath, fileName }) {
    const inspected = await this.inspectFile(filePath, fileName);
    const artifactId = String(this.createId());
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(artifactId)) {
      throw artifactError('ARTIFACT_ID_INVALID', 'Artifact id generator returned an invalid id');
    }
    this.records.set(artifactId, {
      path: inspected.canonical,
      fileName: inspected.fileName,
      mime: inspected.mime,
      size: inspected.bytes.length,
      checksum: `sha256:${crypto.createHash('sha256').update(inspected.bytes).digest('hex')}`,
    });
    while (this.records.size > MAX_ARTIFACTS) this.records.delete(this.records.keys().next().value);
    return { artifactId, ...this.records.get(artifactId) };
  }

  async read(artifactId) {
    const record = this.records.get(String(artifactId ?? ''));
    if (!record) throw artifactError('ARTIFACT_NOT_FOUND', 'Generated artifact is unavailable or expired');
    const inspected = await this.inspectFile(record.path, record.fileName);
    return { ...record, bytes: inspected.bytes };
  }
}

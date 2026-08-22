import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { sanitizeFilename } from './download-manager.mjs';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function snapshotError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function directoryKey(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 32);
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function ensurePlainDirectory(directory) {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw snapshotError('SNAPSHOT_PATH_UNSAFE', `Snapshot directory is not a plain directory: ${directory}`);
  }
}

function decodeSnapshot(dataBase64, declaredBytes, maxBytes) {
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
    throw snapshotError('SNAPSHOT_INVALID', 'Studio returned no document snapshot data');
  }
  // Reject before allocating. The small allowance covers base64 padding.
  if (dataBase64.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw snapshotError('SNAPSHOT_TOO_LARGE', `Document snapshot exceeds the ${maxBytes}-byte limit`);
  }
  if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw snapshotError('SNAPSHOT_INVALID', 'Studio returned malformed base64 snapshot data');
  }
  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.length === 0) throw snapshotError('SNAPSHOT_EMPTY', 'Studio returned an empty document snapshot');
  if (bytes.length > maxBytes) {
    throw snapshotError('SNAPSHOT_TOO_LARGE', `Document snapshot exceeds the ${maxBytes}-byte limit`);
  }
  if (Number.isSafeInteger(declaredBytes) && declaredBytes !== bytes.length) {
    throw snapshotError(
      'SNAPSHOT_SIZE_MISMATCH',
      `Studio declared ${declaredBytes} snapshot bytes but sent ${bytes.length}`,
    );
  }
  return bytes;
}

function validateSignature(format, bytes) {
  const expected = format === 'hwp' ? CFB_SIGNATURE : ZIP_SIGNATURE;
  if (bytes.length < expected.length || !bytes.subarray(0, expected.length).equals(expected)) {
    throw snapshotError(
      'SNAPSHOT_FORMAT_MISMATCH',
      `Studio's ${format.toUpperCase()} snapshot does not have the expected file signature`,
    );
  }
}

function snapshotFilename(documentName, format) {
  const safe = sanitizeFilename(documentName, `document.${format}`);
  const oldExtension = path.extname(safe);
  const stem = path.basename(safe, oldExtension) || 'document';
  return `${stem}.${format}`;
}

export class DocumentSnapshotManager {
  constructor({ rootDir, maxBytes = DEFAULT_MAX_BYTES, createId = crypto.randomUUID } = {}) {
    if (!rootDir) throw new Error('DocumentSnapshotManager requires rootDir');
    this.agentDir = path.resolve(rootDir, '.rhwp-agent');
    this.baseDir = path.resolve(this.agentDir, 'document-snapshots');
    this.maxBytes = maxBytes;
    this.createId = createId;
  }

  async materialize({ chatId, documentIdentity, snapshot }) {
    const documentId = documentIdentity?.documentId;
    if (typeof documentId !== 'string' || !documentId) {
      throw snapshotError('SNAPSHOT_SCOPE_MISSING', 'The active document identity is unavailable');
    }
    const format = String(snapshot?.sourceFormat ?? '').toLowerCase();
    if (format !== 'hwp' && format !== 'hwpx') {
      throw snapshotError('SNAPSHOT_FORMAT_UNSUPPORTED', `Unsupported document snapshot format: ${format || 'unknown'}`);
    }
    const bytes = decodeSnapshot(snapshot?.dataBase64, snapshot?.byteLength, this.maxBytes);
    validateSignature(format, bytes);

    const chatDirectory = path.resolve(this.baseDir, directoryKey(chatId));
    const allocation = String(this.createId());
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(allocation)) {
      throw snapshotError('SNAPSHOT_PATH_UNSAFE', 'Snapshot allocation id is invalid');
    }
    const snapshotDirectory = path.resolve(chatDirectory, allocation);
    if (!isInside(this.baseDir, chatDirectory) || !isInside(chatDirectory, snapshotDirectory)) {
      throw snapshotError('SNAPSHOT_PATH_UNSAFE', 'Resolved snapshot path escaped its chat directory');
    }
    await ensurePlainDirectory(this.agentDir);
    await ensurePlainDirectory(this.baseDir);
    await ensurePlainDirectory(chatDirectory);
    await ensurePlainDirectory(snapshotDirectory);

    const fileName = snapshotFilename(documentIdentity?.documentName, format);
    const destination = path.resolve(snapshotDirectory, fileName);
    if (!isInside(snapshotDirectory, destination)) {
      throw snapshotError('SNAPSHOT_PATH_UNSAFE', 'Resolved snapshot file escaped its allocation directory');
    }
    let handle;
    try {
      handle = await fs.open(destination, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await fs.unlink(destination).catch(() => {});
      if (error?.code) throw error;
      throw snapshotError('SNAPSHOT_WRITE_FAILED', String(error?.message ?? error));
    } finally {
      await handle?.close().catch(() => {});
    }

    return {
      path: destination,
      fileName,
      sourceFormat: format,
      size: bytes.length,
      checksum: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      revision: snapshot?.revision,
      digest: snapshot?.digest ?? null,
      dirty: snapshot?.dirty === true,
      documentId,
      documentName: documentIdentity?.documentName ?? null,
      source: 'live-document-snapshot',
    };
  }
}

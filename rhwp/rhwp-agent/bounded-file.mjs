import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  promises as fs,
  readSync,
} from 'node:fs';

/**
 * @typedef {{ maxBytes: number, label?: string, platform?: NodeJS.Platform }} BoundedFileOptions
 */

/** @returns {Error & { code: string }} */
function boundedFileError(code, label, detail) {
  return Object.assign(new Error(`${label} ${detail}`), { code });
}

/** @param {number} maxBytes */
function validateLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }
}

/**
 * @param {import('node:fs').Stats} pathStat
 * @param {import('node:fs').Stats} descriptorStat
 * @param {number} maxBytes
 * @param {string} label
 */
function validatePlainFile(pathStat, descriptorStat, maxBytes, label) {
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || !descriptorStat.isFile()) {
    throw boundedFileError('BOUNDED_FILE_UNSAFE', label, 'must be a plain file');
  }
  if (pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
    throw boundedFileError('BOUNDED_FILE_CHANGED', label, 'changed before it could be opened');
  }
  if (!Number.isSafeInteger(descriptorStat.size) || descriptorStat.size < 1
    || descriptorStat.size > maxBytes) {
    throw boundedFileError(
      'BOUNDED_FILE_TOO_LARGE',
      label,
      `must contain between 1 and ${maxBytes} bytes`,
    );
  }
}

/** @param {import('node:fs').Stats} pathStat @param {string} label */
function rejectNonPlainPath(pathStat, label) {
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw boundedFileError('BOUNDED_FILE_UNSAFE', label, 'must be a plain file');
  }
}

/** @param {Buffer} bytes @param {string} label */
function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw boundedFileError('BOUNDED_FILE_ENCODING', label, 'is not valid UTF-8');
  }
}

/** Read a small persistent UTF-8 file through one no-follow descriptor. */
/** @param {string} file @param {BoundedFileOptions} options */
export async function readUtf8FileBounded(file, {
  maxBytes,
  label = 'File',
  platform = process.platform,
}) {
  validateLimit(maxBytes);
  /** @type {import('node:fs/promises').FileHandle | null} */
  let handle = null;
  try {
    const pathStat = await fs.lstat(file);
    rejectNonPlainPath(pathStat, label);
    const noFollow = platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
    const descriptorStat = await handle.stat();
    validatePlainFile(pathStat, descriptorStat, maxBytes, label);

    const bytes = Buffer.allocUnsafe(descriptorStat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        throw boundedFileError('BOUNDED_FILE_CHANGED', label, 'changed while it was being read');
      }
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      throw boundedFileError('BOUNDED_FILE_CHANGED', label, 'grew while it was being read');
    }
    return decodeUtf8(bytes, label);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Synchronous counterpart for provider setup that must finish before spawning. */
/** @param {string} file @param {BoundedFileOptions} options */
export function readUtf8FileBoundedSync(file, {
  maxBytes,
  label = 'File',
  platform = process.platform,
}) {
  validateLimit(maxBytes);
  /** @type {number | null} */
  let descriptor = null;
  try {
    const pathStat = lstatSync(file);
    rejectNonPlainPath(pathStat, label);
    const noFollow = platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    descriptor = openSync(file, fsConstants.O_RDONLY | noFollow);
    const descriptorStat = fstatSync(descriptor);
    validatePlainFile(pathStat, descriptorStat, maxBytes, label);

    const bytes = Buffer.allocUnsafe(descriptorStat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        throw boundedFileError('BOUNDED_FILE_CHANGED', label, 'changed while it was being read');
      }
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, offset) !== 0) {
      throw boundedFileError('BOUNDED_FILE_CHANGED', label, 'grew while it was being read');
    }
    return decodeUtf8(bytes, label);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

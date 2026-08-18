import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, win32 } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.hwp', '.hwpx', '.hml']);
const CFB_SIGNATURE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const WINDOWS_RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function startsWithBytes(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

function hasValidZipDirectory(bytes) {
  if (bytes.byteLength < 22) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.byteLength) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) return false;

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const directoryDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const directorySize = view.getUint32(eocdOffset + 12, true);
  const directoryOffset = view.getUint32(eocdOffset + 16, true);
  if (diskNumber !== 0 || directoryDisk !== 0 || totalEntries === 0 || diskEntries !== totalEntries) {
    return false;
  }
  if (directoryOffset + directorySize !== eocdOffset || directorySize < 46) return false;
  return directoryOffset + 4 <= bytes.byteLength
    && view.getUint32(directoryOffset, true) === 0x02014b50;
}

/** Reject obviously truncated or format-mismatched output before replacing a real document. */
export function validateNativeDocumentBytes(filePath, bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Native file writes require byte data');
  const extension = extname(filePath).toLowerCase();
  if (extension === '.hwp') {
    // The in-process writer always emits CFB v3: a 512-byte header followed by
    // whole 512-byte sectors. This catches empty/truncated/wrong-format IPC
    // payloads before they can replace the previous document.
    const valid = bytes.byteLength >= 1536
      && (bytes.byteLength - 512) % 512 === 0
      && startsWithBytes(bytes, CFB_SIGNATURE)
      && bytes[28] === 0xfe && bytes[29] === 0xff
      && bytes[30] === 9 && bytes[31] === 0;
    if (!valid) throw new Error('Refusing to replace an HWP file with an invalid or truncated CFB package');
  } else if (extension === '.hwpx') {
    if (!startsWithBytes(bytes, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
      || !hasValidZipDirectory(bytes)) {
      throw new Error('Refusing to replace an HWPX file with an invalid or truncated ZIP package');
    }
  }
}

async function retryWindowsRename(operation, platform) {
  const delays = [40, 80, 160, 320, 640];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (platform !== 'win32'
        || !WINDOWS_RENAME_RETRY_CODES.has(error?.code)
        || attempt >= delays.length) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function syncParentDirectory(filePath, platform) {
  // Directory fsync makes the rename durable on POSIX. Windows does not allow
  // opening directories this way; the temporary file itself is still fsynced.
  if (platform === 'win32') return;
  let directory;
  try {
    directory = await open(dirname(filePath), 'r');
    await directory.sync();
  } catch {
    // A completed rename must not be reported as failed merely because a
    // particular filesystem does not implement directory fsync.
  } finally {
    await directory?.close().catch(() => {});
  }
}

export function nativePathOwnershipKey(filePath, { platform = process.platform } = {}) {
  const normalized = String(filePath).normalize('NFC');
  return platform === 'win32' || platform === 'darwin'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

export async function writeNativeFileAtomically(
  filePath,
  bytes,
  {
    platform = process.platform,
    openImpl = open,
    renameImpl = rename,
    rmImpl = rm,
  } = {},
) {
  const temporaryPath = `${filePath}.rauhwpx-${process.pid}-${randomUUID()}.tmp`;
  let temporaryFile;
  try {
    temporaryFile = await openImpl(temporaryPath, 'wx');
    await temporaryFile.writeFile(bytes);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await retryWindowsRename(() => renameImpl(temporaryPath, filePath), platform);
    await syncParentDirectory(filePath, platform);
  } catch (error) {
    await temporaryFile?.close().catch(() => {});
    await rmImpl(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function validateNativeDocumentPath(filePath, { platform = process.platform } = {}) {
  const absolute = typeof filePath === 'string'
    && (platform === 'win32' ? win32.isAbsolute(filePath) : isAbsolute(filePath));
  if (!absolute) {
    throw new Error('Native document paths must be absolute');
  }
  if (!SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new Error('Only HWP, HWPX, and HML files can be opened');
  }
  return filePath;
}

export async function canonicalNativePath(
  filePath,
  {
    platform = process.platform,
    resolveRealPath = realpath,
    allowMissing = false,
  } = {},
) {
  validateNativeDocumentPath(filePath, { platform });
  let resolved;
  try {
    resolved = await resolveRealPath(filePath);
  } catch (error) {
    if (!allowMissing || error?.code !== 'ENOENT') throw error;
    const parent = await resolveRealPath(dirname(filePath));
    resolved = join(parent, basename(filePath));
  }
  validateNativeDocumentPath(resolved, { platform });
  return platform === 'win32' ? win32.normalize(resolved) : normalize(resolved);
}

export class NativeFileHandleRegistry {
  #byId = new Map();
  #byPath = new Map();
  #bookmarks = new Map();
  #canonicalize;
  #ownershipKey;
  #createId;
  #readFile;
  #writeFile;

  constructor({
    canonicalize = canonicalNativePath,
    ownershipKey = nativePathOwnershipKey,
    createId = randomUUID,
    readFileImpl = readFile,
    writeFileImpl = writeNativeFileAtomically,
  } = {}) {
    this.#canonicalize = canonicalize;
    this.#ownershipKey = ownershipKey;
    this.#createId = createId;
    this.#readFile = readFileImpl;
    this.#writeFile = writeFileImpl;
  }

  async create(sessionId, filePath, { allowMissing = false } = {}) {
    const canonicalPath = await this.#canonicalize(filePath, { allowMissing });
    const ownershipPath = this.#ownershipKey(canonicalPath);
    const existing = this.#byPath.get(ownershipPath);
    if (existing && existing.sessionId !== sessionId) {
      return { ok: false, ownerSessionId: existing.sessionId };
    }
    if (existing) {
      // Re-acquiring a handle cancels a pending release; otherwise the handle
      // would silently vanish once the in-flight write that pinned it finishes.
      existing.releaseRequested = false;
      return { ok: true, descriptor: this.#descriptor(existing), created: false };
    }

    const entry = {
      handleId: this.#createId(),
      sessionId,
      canonicalPath,
      ownershipPath,
      name: filePath.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1),
      activeWrites: 0,
      writeChain: Promise.resolve(),
      releaseRequested: false,
    };
    this.#byId.set(entry.handleId, entry);
    this.#byPath.set(ownershipPath, entry);
    return { ok: true, descriptor: this.#descriptor(entry), created: true };
  }

  async createSaveTarget(sessionId, filePath) {
    return this.create(sessionId, filePath, { allowMissing: true });
  }

  async ownerForPath(filePath) {
    const canonicalPath = await this.#canonicalize(filePath);
    return this.#byPath.get(this.#ownershipKey(canonicalPath))?.sessionId ?? null;
  }

  pathForSender(senderSessionId, handleId) {
    return this.#entryForSender(senderSessionId, handleId).ownershipPath;
  }

  async read(senderSessionId, handleId) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    return {
      name: entry.name,
      bytes: new Uint8Array(await this.#readFile(entry.canonicalPath)),
    };
  }

  validateSave(senderSessionId, handleId, identity, leases) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    return leases.validateSaveTarget(senderSessionId, identity, entry.ownershipPath);
  }

  async write(senderSessionId, handleId, bytes, identity, leases) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    entry.activeWrites += 1;
    try {
      this.validateSave(senderSessionId, handleId, identity, leases);
      validateNativeDocumentBytes(entry.canonicalPath, bytes);
      const write = entry.writeChain.then(async () => {
        // Revalidate after earlier queued writes. A stale window/document must
        // never reach the filesystem merely because it entered the queue first.
        this.validateSave(senderSessionId, handleId, identity, leases);
        await this.#writeFile(entry.canonicalPath, bytes);
      });
      // A failed write must not poison later saves to the same handle.
      entry.writeChain = write.catch(() => {});
      await write;
      return { name: entry.name, byteLength: bytes.byteLength };
    } finally {
      entry.activeWrites -= 1;
      if (entry.activeWrites === 0 && entry.releaseRequested) this.#deleteEntry(entry);
    }
  }

  async isSameEntry(senderSessionId, firstHandleId, secondHandleId) {
    const first = this.#entryForSender(senderSessionId, firstHandleId);
    const second = this.#entryForSender(senderSessionId, secondHandleId);
    return first.ownershipPath === second.ownershipPath;
  }

  rememberDocument(documentId, senderSessionId, handleId) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    if (this.#bookmarks.has(documentId)) this.#bookmarks.delete(documentId);
    this.#bookmarks.set(documentId, entry.canonicalPath);
    while (this.#bookmarks.size > 200) {
      const oldest = this.#bookmarks.keys().next().value;
      this.#bookmarks.delete(oldest);
    }
    return entry.canonicalPath;
  }

  async reopenDocument(sessionId, documentId) {
    const filePath = this.#bookmarks.get(documentId);
    if (!filePath) return null;
    return this.create(sessionId, filePath);
  }

  bookmarkPathFor(documentId) {
    return this.#bookmarks.get(documentId) ?? null;
  }

  loadBookmarks(entries) {
    this.#bookmarks.clear();
    for (const [documentId, filePath] of entries ?? []) {
      if (typeof documentId === 'string' && documentId && typeof filePath === 'string' && filePath) {
        this.#bookmarks.set(documentId, filePath);
      }
    }
  }

  dumpBookmarks() {
    return [...this.#bookmarks.entries()];
  }

  descriptorsForSession(sessionId) {
    return [...this.#byId.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => this.#descriptor(entry));
  }

  releaseHandle(sessionId, handleId) {
    const entry = this.#entryForSender(sessionId, handleId);
    if (entry.activeWrites > 0) {
      entry.releaseRequested = true;
      return;
    }
    this.#deleteEntry(entry);
  }

  releaseSession(sessionId) {
    for (const [handleId, entry] of this.#byId) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.activeWrites > 0) {
        entry.releaseRequested = true;
        continue;
      }
      this.#deleteEntry(entry);
    }
  }

  #deleteEntry(entry) {
    this.#byId.delete(entry.handleId);
    if (this.#byPath.get(entry.ownershipPath) === entry) this.#byPath.delete(entry.ownershipPath);
  }

  #entryForSender(senderSessionId, handleId) {
    const entry = this.#byId.get(handleId);
    if (!entry || entry.sessionId !== senderSessionId) {
      throw new Error('Native file handle does not belong to this window');
    }
    return entry;
  }

  #descriptor(entry) {
    return Object.freeze({ kind: 'file', handleId: entry.handleId, name: entry.name });
  }
}

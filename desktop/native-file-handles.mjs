import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, win32 } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.hwp', '.hwpx', '.hml']);

export function nativePathOwnershipKey(filePath, { platform = process.platform } = {}) {
  const normalized = String(filePath).normalize('NFC');
  return platform === 'win32' || platform === 'darwin'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

export async function writeNativeFileAtomically(filePath, bytes) {
  const temporaryPath = `${filePath}.rauhwpx-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
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
      if (!(bytes instanceof Uint8Array)) throw new Error('Native file writes require byte data');
      await this.#writeFile(entry.canonicalPath, bytes);
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

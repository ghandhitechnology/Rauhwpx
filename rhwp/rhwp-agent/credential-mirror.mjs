import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { uptime as systemUptime } from 'node:os';
import path from 'node:path';

const COPY_FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP']);
const JOURNAL_VERSION = 1;
const JOURNAL_ID_PATTERN = /^[0-9a-f]{16}$/;
const OWNER_FILE = '.rauhwpx-owner.json';
export const CREDENTIAL_ROOT_FILE = '.rauhwpx-credential-root';
export const CREDENTIAL_RETENTION_DIR = '.rauhwpx-credential-copybacks';
export const LAUNCH_CLEANUP_RETENTION_FILE = '.rauhwpx-legacy-cleanup.json';
export const MAX_CREDENTIAL_MIRROR_BYTES = 1024 * 1024;
export const MAX_CREDENTIAL_JOURNAL_BYTES = 64 * 1024;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function mirrorId(target) {
  return createHash('sha256').update(path.resolve(target)).digest('hex').slice(0, 16);
}

/** One bounded recovery file per credential source, always outside launch roots. */
export function credentialConflictPath(source) {
  const resolved = path.resolve(source);
  const id = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return path.join(path.dirname(resolved), `.rauhwpx-credential-conflict-${id}.copy`);
}

function journalPrefix(source) {
  return `.${path.basename(source)}.rauhwpx-copyback-`;
}

function journalPathFor(source, target) {
  return path.join(path.dirname(source), `${journalPrefix(source)}${mirrorId(target)}.json`);
}

function retentionMarkerFor(target, id) {
  let directory = path.dirname(path.resolve(target));
  for (let depth = 0; depth < 32; depth += 1) {
    if (plainFile(path.join(directory, OWNER_FILE))
      || plainFile(path.join(directory, CREDENTIAL_ROOT_FILE))) {
      return path.join(directory, CREDENTIAL_RETENTION_DIR, `${id}.pending`);
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function durableWrite(file, bytes, mode = 0o600, flags = 'w') {
  const fd = openSync(file, flags, mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Mark the exact root that must survive while a copyback journal is pending. */
export function ensureCredentialRetentionRootSync(directory) {
  const resolved = path.resolve(directory);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const marker = path.join(resolved, CREDENTIAL_ROOT_FILE);
  try {
    durableWrite(marker, 'v1\n', 0o600, 'wx');
  } catch (error) {
    if (error?.code !== 'EEXIST' || !plainFile(marker)) throw error;
  }
  return marker;
}

/** Fail closed when a root's pending-copyback directory is unreadable. */
export function hasPendingCredentialCopybackSync(directory) {
  try {
    return readdirSync(path.join(path.resolve(directory), CREDENTIAL_RETENTION_DIR), {
      withFileTypes: true,
    }).some((entry) => /^[0-9a-f]{16}\.pending$/.test(entry.name));
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

/** Retain a launch root when an owned process tree could not be proved dead. */
export function retainLaunchRootForProcessCleanupSync(directory, {
  launchId = path.basename(path.resolve(directory)),
  observedAtMs = Date.now(),
  observedUptimeSeconds = systemUptime(),
} = {}) {
  const resolved = path.resolve(directory);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const marker = path.join(resolved, LAUNCH_CLEANUP_RETENTION_FILE);
  try {
    const directoryStat = statSync(resolved);
    durableWrite(marker, `${JSON.stringify({
      version: 1,
      launchId: String(launchId),
      observedUptimeSeconds: Number(observedUptimeSeconds),
      observedAtMs: Number(observedAtMs),
      directoryMtimeMs: directoryStat.mtimeMs,
    })}\n`, 0o600, 'wx');
  } catch (error) {
    // Reuse the first observation. Its uptime watermark is what lets desktop
    // cleanup prove a later reboot made every old descendant non-live.
    if (error?.code !== 'EEXIST' || !plainFile(marker)) throw error;
  }
  return marker;
}

/** Cleanup owners must retain roots with either credentials or live-tree uncertainty. */
export function hasPendingLaunchCleanupSync(directory) {
  return hasPendingCredentialCopybackSync(directory)
    || pathStillExists(path.join(path.resolve(directory), LAUNCH_CLEANUP_RETENTION_FILE));
}

function pathStillExists(pathname) {
  try {
    lstatSync(pathname);
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

/** Whether a failed flush still owns recoverable state that callers must retain. */
export function credentialMirrorHasPendingCopybackSync(handle) {
  if (!handle || handle.mode !== 'copy') return false;
  if (handle.retentionMarker && pathStillExists(handle.retentionMarker)) return true;
  return pathStillExists(handle.journalPath)
    && [handle.target, handle.nextPath, handle.previousPath].some(pathStillExists);
}

function writeNewAtomically(target, bytes) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.rauhwpx-new-${process.pid}-${randomUUID()}`;
  try {
    durableWrite(temporary, bytes);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function preserveConflictCopy(handle, bytes) {
  if (!bytes || bytes.byteLength > MAX_CREDENTIAL_MIRROR_BYTES) return null;
  const target = credentialConflictPath(handle.source);
  if (handle.retentionMarker) {
    const launchRoot = path.dirname(path.dirname(handle.retentionMarker));
    const relative = path.relative(launchRoot, target);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)) return null;
  }
  const temporary = `${target}.new-${process.pid}-${randomUUID()}`;
  try {
    durableWrite(temporary, bytes, 0o600);
    // A single fixed path puts a hard 1 MiB ceiling on retained conflict data
    // for each source. The latest unresolved provider refresh wins.
    rmSync(target, { force: true });
    renameSync(temporary, target);
    return target;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function processAlive(pid, killImpl = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function mirrorError(code, message) {
  return Object.assign(new Error(message), { code });
}

function boundedPlainFileRead(file, maximumBytes, label) {
  let fd;
  try {
    fd = openSync(
      file,
      fsConstants.O_RDONLY
        | (fsConstants.O_NOFOLLOW ?? 0)
        | (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP') {
      throw mirrorError('CREDENTIAL_MIRROR_UNSAFE_FILE', `${label} is not a plain file: ${file}`);
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw mirrorError('CREDENTIAL_MIRROR_UNSAFE_FILE', `${label} is not a plain file: ${file}`);
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximumBytes) {
      throw mirrorError(
        'CREDENTIAL_MIRROR_TOO_LARGE',
        `${label} exceeds its ${maximumBytes}-byte limit: ${file}`,
      );
    }

    // Read at most one sentinel byte beyond the limit. This catches a file that
    // grows after fstat without allowing an unbounded read or allocation.
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(fd, buffer, offset, buffer.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maximumBytes) {
      throw mirrorError(
        'CREDENTIAL_MIRROR_TOO_LARGE',
        `${label} exceeded its ${maximumBytes}-byte limit while being read: ${file}`,
      );
    }
    return Buffer.from(buffer.subarray(0, offset));
  } finally {
    closeSync(fd);
  }
}

function readCredential(file) {
  return boundedPlainFileRead(file, MAX_CREDENTIAL_MIRROR_BYTES, 'Credential');
}

function plainFile(pathname) {
  try {
    const stat = lstatSync(pathname);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function readJournal(journalPath) {
  let raw;
  try {
    const bytes = boundedPlainFileRead(
      journalPath,
      MAX_CREDENTIAL_JOURNAL_BYTES,
      'Credential mirror journal',
    );
    if (bytes === null) return null;
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error?.code === 'CREDENTIAL_MIRROR_TOO_LARGE'
      || error?.code === 'CREDENTIAL_MIRROR_UNSAFE_FILE') throw error;
    return null;
  }
  if (!raw || raw.version !== JOURNAL_VERSION || !JOURNAL_ID_PATTERN.test(String(raw.id))) return null;
  if (!Number.isSafeInteger(raw.pid) || raw.pid <= 0) return null;
  if (!Number.isSafeInteger(raw.createdAtMs) || raw.createdAtMs <= 0) return null;
  if (!/^[0-9a-f]{64}$/.test(String(raw.initialSourceDigest))) return null;
  if (typeof raw.source !== 'string' || typeof raw.target !== 'string') return null;
  if (raw.source.length > 4096 || raw.target.length > 4096) return null;
  const source = path.resolve(raw.source);
  const target = path.resolve(raw.target);
  if (journalPathFor(source, target) !== path.resolve(journalPath)) return null;
  if (raw.id !== mirrorId(target)) return null;
  /** @type {string | null} */
  let retentionMarker = null;
  if (raw.retentionMarker !== null && raw.retentionMarker !== undefined) {
    if (typeof raw.retentionMarker !== 'string') return null;
    retentionMarker = path.resolve(raw.retentionMarker);
    if (path.basename(retentionMarker) !== `${raw.id}.pending`
      || path.basename(path.dirname(retentionMarker)) !== CREDENTIAL_RETENTION_DIR) return null;
    const launchRoot = path.dirname(path.dirname(retentionMarker));
    const relativeTarget = path.relative(launchRoot, target);
    if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeTarget)) return null;
  }
  return Object.freeze({
    ...raw,
    source,
    target,
    journalPath: path.resolve(journalPath),
    nextPath: `${source}.rauhwpx-copyback-${raw.id}.next`,
    previousPath: `${source}.rauhwpx-copyback-${raw.id}.previous`,
    retentionMarker,
    mode: 'copy',
  });
}

function removeMirrorArtifacts(handle) {
  rmSync(handle.nextPath, { force: true });
  rmSync(handle.previousPath, { force: true });
  rmSync(handle.journalPath, { force: true });
  if (handle.retentionMarker) {
    rmSync(handle.retentionMarker, { force: true });
    try { rmdirSync(path.dirname(handle.retentionMarker)); } catch {}
  }
}

function finishTerminalConflict(handle, targetBytes) {
  /** @type {string | null} */
  let conflictPath = null;
  if (targetBytes && digest(targetBytes) !== handle.initialSourceDigest) {
    try {
      conflictPath = preserveConflictCopy(handle, targetBytes);
      if (!conflictPath) throw new Error('No recovery path exists outside the launch root');
    } catch (error) {
      const preservationMessage = error instanceof Error ? error.message : String(error);
      // The target and its retention marker are still the only durable copy.
      // Leave both in place so every cleanup layer fails closed and a later
      // process can retry or recover the provider refresh.
      throw mirrorError(
        'CREDENTIAL_MIRROR_CONFLICT_PRESERVE_FAILED',
        `Credential conflict copy could not be preserved: ${preservationMessage}`,
      );
    }
  }
  rmSync(handle.target, { force: true });
  removeMirrorArtifacts(handle);
  return { copied: false, conflict: true, conflictPath };
}

function recoverInterruptedReplacement(handle, { renameFile = renameSync } = {}) {
  if (plainFile(handle.source)) return;
  if (plainFile(handle.nextPath)) {
    readCredential(handle.nextPath);
    renameFile(handle.nextPath, handle.source);
    rmSync(handle.previousPath, { force: true });
    return;
  }
  if (plainFile(handle.previousPath)) {
    readCredential(handle.previousPath);
    renameFile(handle.previousPath, handle.source);
  }
}

function replaceSource(handle, bytes, platform, { renameFile = renameSync } = {}) {
  rmSync(handle.nextPath, { force: true });
  durableWrite(handle.nextPath, bytes);
  if (platform !== 'win32') {
    renameFile(handle.nextPath, handle.source);
    return;
  }

  rmSync(handle.previousPath, { force: true });
  let moved = false;
  try {
    renameFile(handle.source, handle.previousPath);
    moved = true;
    renameFile(handle.nextPath, handle.source);
  } catch (error) {
    if (moved && !plainFile(handle.source) && plainFile(handle.previousPath)) {
      try { renameFile(handle.previousPath, handle.source); } catch {}
    }
    throw error;
  }
  rmSync(handle.previousPath, { force: true });
}

/**
 * Copy a refreshed credential back only when its source still matches the bytes
 * that were seeded. A concurrent login wins instead of being overwritten.
 */
export function flushCredentialMirrorSync(handle, {
  platform = process.platform,
  renameFile = renameSync,
} = {}) {
  if (!handle || handle.mode !== 'copy') return { copied: false, conflict: false };
  const verified = readJournal(handle.journalPath);
  if (!verified || verified.source !== path.resolve(handle.source)
    || verified.target !== path.resolve(handle.target)) {
    return { copied: false, conflict: false };
  }

  recoverInterruptedReplacement(verified, { renameFile });
  if (!plainFile(verified.target)) {
    if (!plainFile(verified.source)) return finishTerminalConflict(verified, null);
    removeMirrorArtifacts(verified);
    return { copied: false, conflict: false };
  }

  let targetBytes;
  try {
    targetBytes = readCredential(verified.target);
  } catch (error) {
    // Unsafe or oversized launch data cannot be copied or retained. Clear its
    // journal marker so startup cleanup is not blocked forever, then report it.
    rmSync(verified.target, { force: true });
    removeMirrorArtifacts(verified);
    throw error;
  }
  if (targetBytes === null) {
    if (!plainFile(verified.source)) return finishTerminalConflict(verified, null);
    removeMirrorArtifacts(verified);
    return { copied: false, conflict: false };
  }
  const targetDigest = digest(targetBytes);
  if (!plainFile(verified.source)) return finishTerminalConflict(verified, targetBytes);
  let sourceBytes;
  try {
    sourceBytes = readCredential(verified.source);
  } catch (error) {
    if (error?.code !== 'CREDENTIAL_MIRROR_TOO_LARGE'
      && error?.code !== 'CREDENTIAL_MIRROR_UNSAFE_FILE') throw error;
    return finishTerminalConflict(verified, targetBytes);
  }
  if (sourceBytes === null) return finishTerminalConflict(verified, targetBytes);
  const sourceDigest = digest(sourceBytes);

  if (targetDigest === verified.initialSourceDigest || sourceDigest === targetDigest) {
    removeMirrorArtifacts(verified);
    return { copied: false, conflict: false };
  }
  if (sourceDigest !== verified.initialSourceDigest) {
    return finishTerminalConflict(verified, targetBytes);
  }

  try {
    replaceSource(verified, targetBytes, platform, { renameFile });
    const installed = readCredential(verified.source);
    if (installed === null || digest(installed) !== targetDigest) {
      throw new Error(`Credential copyback verification failed: ${verified.source}`);
    }
  } catch (error) {
    // `replaceSource` writes and fsyncs nextPath before touching the source.
    // Keep that file, the provider target, journal, and root marker together.
    // Callers must retain the launch root and can retry the same handle.
    return {
      copied: false,
      conflict: false,
      pending: true,
      errorCode: typeof error?.code === 'string' ? error.code : 'CREDENTIAL_COPYBACK_FAILED',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  removeMirrorArtifacts(verified);
  return { copied: true, conflict: false };
}

/** Finish copyback journals left by dead app processes before creating a mirror. */
export function recoverCredentialMirrorsSync(source, {
  currentPid = process.pid,
  isAlive = processAlive,
  platform = process.platform,
} = {}) {
  const resolvedSource = path.resolve(source);
  let names;
  try {
    names = readdirSync(path.dirname(resolvedSource));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const prefix = journalPrefix(resolvedSource);
  const results = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const handle = readJournal(path.join(path.dirname(resolvedSource), name));
    if (!handle || handle.source !== resolvedSource) continue;
    if (handle.pid === currentPid || isAlive(handle.pid)) continue;
    results.push(flushCredentialMirrorSync(handle, { platform }));
  }
  return results;
}

/**
 * Prefer a symlink. On Windows without symlink privilege, seed a private copy
 * and write an adjacent recovery journal before a provider can start.
 */
export function prepareCredentialMirrorSync(source, target, {
  platform = process.platform,
  pid = process.pid,
  now = Date.now,
  symlink = symlinkSync,
  copyOnly = false,
} = {}) {
  if (!source) return null;
  const resolvedSource = path.resolve(source);
  const resolvedTarget = path.resolve(target);
  recoverCredentialMirrorsSync(resolvedSource, { currentPid: pid, platform });
  if (!plainFile(resolvedSource)) return null;

  const journalPath = journalPathFor(resolvedSource, resolvedTarget);
  const existing = readJournal(journalPath);
  if (existing?.pid === pid) return existing;

  mkdirSync(path.dirname(resolvedTarget), { recursive: true, mode: 0o700 });
  try {
    const targetStat = lstatSync(resolvedTarget);
    if (targetStat.isSymbolicLink()) {
      const linkedTarget = path.resolve(path.dirname(resolvedTarget), readlinkSync(resolvedTarget));
      if (linkedTarget === resolvedSource) {
        if (!copyOnly) {
          return Object.freeze({ mode: 'link', source: resolvedSource, target: resolvedTarget });
        }
        rmSync(resolvedTarget, { force: true });
      } else {
        return null;
      }
    } else {
      return null;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (!copyOnly) {
    try {
      symlink(resolvedSource, resolvedTarget);
      return Object.freeze({ mode: 'link', source: resolvedSource, target: resolvedTarget });
    } catch (error) {
      if (platform !== 'win32' || !COPY_FALLBACK_CODES.has(error?.code)) throw error;
    }
  }

  const sourceBytes = readCredential(resolvedSource);
  if (sourceBytes === null) return null;
  const id = mirrorId(resolvedTarget);
  const retentionMarker = retentionMarkerFor(resolvedTarget, id);
  const journal = {
    version: JOURNAL_VERSION,
    id,
    source: resolvedSource,
    target: resolvedTarget,
    initialSourceDigest: digest(sourceBytes),
    pid,
    createdAtMs: Number(now()),
    retentionMarker,
  };
  const temporaryJournal = `${journalPath}.new-${pid}-${randomUUID()}`;
  try {
    durableWrite(temporaryJournal, `${JSON.stringify(journal)}\n`);
    renameSync(temporaryJournal, journalPath);
    if (retentionMarker) {
      mkdirSync(path.dirname(retentionMarker), { recursive: true, mode: 0o700 });
      durableWrite(retentionMarker, `${journalPath}\n`);
    }
    writeNewAtomically(resolvedTarget, sourceBytes);
  } catch (error) {
    rmSync(temporaryJournal, { force: true });
    rmSync(journalPath, { force: true });
    if (retentionMarker) rmSync(retentionMarker, { force: true });
    rmSync(resolvedTarget, { force: true });
    throw error;
  }
  const handle = readJournal(journalPath);
  if (!handle) throw new Error(`Credential mirror journal did not verify: ${journalPath}`);
  return handle;
}

export function flushCredentialMirrorsSync(handles, options = {}) {
  return (Array.isArray(handles) ? handles : [handles])
    .filter(Boolean)
    .map((handle) => flushCredentialMirrorSync(handle, options));
}

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, open, opendir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, win32 } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.hwp', '.hwpx', '.hml', '.rhwpx']);
const PORTABLE_HISTORY_INNER_FILE = 'history';
const PORTABLE_HISTORY_MAGIC = new TextEncoder().encode('RAUHWPX-HISTORY\0');
const PORTABLE_HISTORY_PREFIX_LENGTH = PORTABLE_HISTORY_MAGIC.byteLength + 4;
export const MAX_NATIVE_DOCUMENT_BYTES = 512 * 1024 * 1024;
export const MAX_PORTABLE_HISTORY_BYTES = 128 * 1024 * 1024;
const MAX_PORTABLE_HISTORY_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_PORTABLE_HISTORY_OBJECTS = 50_000;
const NEARBY_DIRECTORY_CAP = 12;
const NEARBY_FILE_CAP = 8;
const NEARBY_DIR_ENTRY_CAP = 256;
const CFB_SIGNATURE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const WINDOWS_RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);
export const NATIVE_FILE_CONFLICT_CODE = 'NATIVE_FILE_CONFLICT';
export const NATIVE_FILE_CONFLICT_MESSAGE = 'This document changed on disk after it was opened. Reopen it before saving.';
export const NATIVE_FILE_ATOMIC_UNSUPPORTED_CODE = 'NATIVE_FILE_ATOMIC_UNSUPPORTED';
export const NATIVE_FILE_ATOMIC_UNSUPPORTED_MESSAGE = 'This filesystem cannot safely publish an atomic document save.';
export const NATIVE_FILE_RECOVERY_REQUIRED_CODE = 'NATIVE_FILE_RECOVERY_REQUIRED';
export const NATIVE_FILE_WRITE_BUSY_CODE = 'NATIVE_FILE_WRITE_BUSY';

const WINDOWS_DACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$sections = [System.Security.AccessControl.AccessControlSections]::Access',
  '$sourceAcl = Get-Acl -LiteralPath $env:RAUHWPX_METADATA_SOURCE',
  '$targetAcl = Get-Acl -LiteralPath $env:RAUHWPX_METADATA_TARGET',
  '$sourceDacl = $sourceAcl.GetSecurityDescriptorSddlForm($sections)',
  '$targetAcl.SetSecurityDescriptorSddlForm($sourceDacl, $sections)',
  'Set-Acl -LiteralPath $env:RAUHWPX_METADATA_TARGET -AclObject $targetAcl',
].join('\n');
const WINDOWS_DACL_ENCODED_COMMAND = Buffer.from(WINDOWS_DACL_SCRIPT, 'utf16le').toString('base64');

function startsWithBytes(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

function byteView(value) {
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('Native file reads require byte data');
}

function nativeFileConflictError() {
  const error = new Error(NATIVE_FILE_CONFLICT_MESSAGE);
  error.code = NATIVE_FILE_CONFLICT_CODE;
  return error;
}

function nativeFileAtomicUnsupportedError(cause = null) {
  const error = new Error(NATIVE_FILE_ATOMIC_UNSUPPORTED_MESSAGE, cause ? { cause } : undefined);
  error.code = NATIVE_FILE_ATOMIC_UNSUPPORTED_CODE;
  return error;
}

function nativeFileRecoveryRequiredError(original, backupPath, restoreErrors) {
  const error = new AggregateError(
    [original, ...restoreErrors],
    `The original document could not be restored automatically. A recovery copy was retained at ${backupPath}`,
    { cause: original },
  );
  error.code = NATIVE_FILE_RECOVERY_REQUIRED_CODE;
  error.recoveryFile = backupPath;
  return error;
}

function nativeRecoveryPath(filePath) {
  const extension = extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  return `${stem}.rauhwpx-recovery-${process.pid}-${randomUUID()}${extension}`;
}

function statValue(info, key, fallbackKey = null) {
  const value = info?.[key] ?? (fallbackKey ? info?.[fallbackKey] : undefined);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function nativeFileGeneration(info) {
  return JSON.stringify([
    statValue(info, 'dev'),
    statValue(info, 'ino'),
    statValue(info, 'mode'),
    statValue(info, 'nlink'),
    statValue(info, 'uid'),
    statValue(info, 'gid'),
    statValue(info, 'size'),
    statValue(info, 'mtimeNs', 'mtimeMs'),
    statValue(info, 'birthtimeNs', 'birthtimeMs'),
  ]);
}

function nativeFileChangeTime(info) {
  return statValue(info, 'ctimeNs', 'ctimeMs');
}

function contentDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function nativeFileFingerprint(info, digest) {
  return Object.freeze({
    state: 'file',
    generation: nativeFileGeneration(info),
    changeTime: nativeFileChangeTime(info),
    digest,
  });
}

const MISSING_NATIVE_FILE_FINGERPRINT = Object.freeze({ state: 'missing' });

function isNativeFileFingerprint(value) {
  return value?.state === 'missing'
    || (value?.state === 'file'
      && typeof value.generation === 'string'
      && (value.changeTime === null || typeof value.changeTime === 'string')
      && /^sha256:[0-9a-f]{64}$/.test(value.digest));
}

function sameNativeFileFingerprint(left, right) {
  if (!isNativeFileFingerprint(left) || !isNativeFileFingerprint(right)) return false;
  if (left.state !== right.state) return false;
  return left.state === 'missing'
    || (left.generation === right.generation
      && left.changeTime === right.changeTime
      && left.digest === right.digest);
}

function sameMovedNativeFileFingerprint(left, right) {
  return isNativeFileFingerprint(left)
    && isNativeFileFingerprint(right)
    && left.state === 'file'
    && right.state === 'file'
    && left.generation === right.generation
    && left.digest === right.digest;
}

function waitForCommandExit(child, timeoutMs, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      child.off?.('exit', onExit);
      child.off?.('close', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimer(() => finish(false), timeoutMs);
    child.once?.('exit', onExit);
    child.once?.('close', onExit);
  });
}

async function terminateMetadataCommand(child, {
  platform,
  env,
  spawnImpl,
  finalGraceMs = 5_000,
}) {
  if (child.exitCode != null || child.signalCode != null) return true;
  const pid = Number(child.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot ?? env.WINDIR;
    if (typeof systemRoot !== 'string' || !win32.isAbsolute(systemRoot)) return false;
    let killer;
    try {
      killer = spawnImpl(
        win32.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        { env, shell: false, stdio: 'ignore', windowsHide: true },
      );
    } catch {
      return false;
    }
    const [taskkillExited, childExited] = await Promise.all([
      waitForCommandExit(killer, finalGraceMs),
      waitForCommandExit(child, finalGraceMs),
    ]);
    if (!taskkillExited) {
      try { killer.kill?.('SIGKILL'); } catch {}
    }
    return taskkillExited && killer.exitCode === 0 && childExited;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') return false;
  }
  const childExited = await waitForCommandExit(child, finalGraceMs);
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return childExited && error?.code === 'ESRCH';
  }
}

export function runNativeMetadataCommand(command, args, {
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  timeoutMs = platform === 'win32' ? 15_000 : 120_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        detached: platform !== 'win32',
        env,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      child.off?.('error', onError);
      child.off?.('exit', onExit);
      child.off?.('close', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => {
      if (timedOut) return;
      if (code === 0) {
        finish();
        return;
      }
      const error = new Error(`Metadata copy command failed (${command}, code=${code ?? 'none'}, signal=${signal ?? 'none'})`);
      error.code = 'NATIVE_FILE_METADATA_COPY_FAILED';
      finish(error);
    };
    child.once?.('error', onError);
    child.once?.('exit', onExit);
    child.once?.('close', onExit);
    timer = setTimer(() => {
      timedOut = true;
      void terminateMetadataCommand(child, { platform, env, spawnImpl })
        .then((cleaned) => {
          const error = new Error(`Metadata copy command timed out (${command})`);
          error.code = 'NATIVE_FILE_METADATA_COPY_TIMEOUT';
          if (!cleaned) error.processCleanupUncertain = true;
          finish(error);
        }, (cause) => {
          const error = new Error(`Metadata copy command cleanup failed (${command})`, { cause });
          error.code = 'NATIVE_FILE_METADATA_COPY_TIMEOUT';
          error.processCleanupUncertain = true;
          finish(error);
        });
    }, timeoutMs);
  });
}

async function copyWindowsDacl(
  sourcePath,
  temporaryPath,
  runCommandImpl,
  systemRoot = process.env.SystemRoot ?? process.env.WINDIR,
) {
  if (typeof systemRoot !== 'string' || !win32.isAbsolute(systemRoot)) {
    const error = new Error('Windows system root is unavailable for DACL preservation');
    error.code = 'NATIVE_FILE_METADATA_COPY_FAILED';
    throw error;
  }
  const options = {
    platform: 'win32',
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      RAUHWPX_METADATA_SOURCE: sourcePath,
      RAUHWPX_METADATA_TARGET: temporaryPath,
    },
  };
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    WINDOWS_DACL_ENCODED_COMMAND,
  ];
  await runCommandImpl(
    win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args,
    options,
  );
}

/**
 * Capture a bounded content hash and file-generation token from one opened
 * file. A path swap or in-place mutation during the read is a conflict.
 */
export async function fingerprintNativeFile(
  filePath,
  {
    openImpl = open,
    statImpl = stat,
  } = {},
) {
  let handle;
  try {
    try {
      handle = await openImpl(filePath, 'r');
    } catch (error) {
      if (error?.code === 'ENOENT') return MISSING_NATIVE_FILE_FINGERPRINT;
      throw error;
    }
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw nativeFileConflictError();
    const size = Number(before.size);
    const maxBytes = nativeDocumentMaxBytes(filePath);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw nativeDocumentSizeError(maxBytes);
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(Math.max(size, 1), 1024 * 1024));
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, size - offset),
        offset,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
    const after = await handle.stat({ bigint: true });
    const pathInfo = await statImpl(filePath, { bigint: true });
    if (
      offset !== size
      || extraBytes !== 0
      || !after.isFile()
      || !pathInfo.isFile()
      || nativeFileGeneration(before) !== nativeFileGeneration(after)
      || nativeFileGeneration(after) !== nativeFileGeneration(pathInfo)
      || nativeFileChangeTime(before) !== nativeFileChangeTime(after)
      || nativeFileChangeTime(after) !== nativeFileChangeTime(pathInfo)
    ) {
      throw nativeFileConflictError();
    }
    return nativeFileFingerprint(after, `sha256:${hash.digest('hex')}`);
  } catch (error) {
    if (error?.code === 'ENOENT') throw nativeFileConflictError();
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function hasValidHmlPreamble(bytes) {
  if (bytes.byteLength < 16) return false;
  const prefixLength = Math.min(bytes.byteLength, 64 * 1024);
  const evenPrefixLength = prefixLength - (prefixLength % 2);
  let text;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = new TextDecoder('utf-16le').decode(bytes.subarray(2, evenPrefixLength));
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      text = new TextDecoder('utf-16be').decode(bytes.subarray(2, evenPrefixLength));
    } else {
      text = new TextDecoder('utf-8').decode(bytes.subarray(0, prefixLength));
    }
  } catch {
    return false;
  }
  return /^\s*(?:<\?xml[\s\S]{0,2048}?\?>\s*)?<HWPML(?:\s|>)/i.test(text);
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

function hasValidPortableHistoryLayout(bytes, manifestLength) {
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(
        PORTABLE_HISTORY_PREFIX_LENGTH,
        PORTABLE_HISTORY_PREFIX_LENGTH + manifestLength,
      ),
    ));
  } catch {
    return false;
  }
  if (
    !manifest
    || typeof manifest !== 'object'
    || manifest.format !== 'rauhwpx-history'
    || manifest.version !== 1
    || !manifest.document
    || typeof manifest.document !== 'object'
    || !manifest.repository
    || typeof manifest.repository !== 'object'
    || !Array.isArray(manifest.objects)
    || manifest.objects.length === 0
    || manifest.objects.length > MAX_PORTABLE_HISTORY_OBJECTS
  ) return false;

  const payloadOffset = PORTABLE_HISTORY_PREFIX_LENGTH + manifestLength;
  const descriptors = [...manifest.objects].sort((left, right) => left?.offset - right?.offset);
  let expectedOffset = 0;
  for (const descriptor of descriptors) {
    if (
      !descriptor
      || (descriptor.kind !== 'blob' && descriptor.kind !== 'compare-snapshot')
      || typeof descriptor.id !== 'string'
      || descriptor.id.length === 0
      || !Number.isSafeInteger(descriptor.offset)
      || descriptor.offset < 0
      || !Number.isSafeInteger(descriptor.byteLength)
      || descriptor.byteLength < 0
      || descriptor.offset !== expectedOffset
      || payloadOffset + descriptor.offset + descriptor.byteLength > bytes.byteLength
    ) return false;
    expectedOffset += descriptor.byteLength;
  }
  return payloadOffset + expectedOffset === bytes.byteLength;
}

/** Reject obviously truncated or format-mismatched output before replacing a real document. */
export function validateNativeDocumentBytes(filePath, bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Native file writes require byte data');
  const extension = extname(filePath).toLowerCase();
  const maxBytes = extension === '.rhwpx'
    ? MAX_PORTABLE_HISTORY_BYTES
    : MAX_NATIVE_DOCUMENT_BYTES;
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error('Refusing to replace a document with empty or oversized data');
  }
  if (extension === '.rhwpx') {
    const manifestLength = bytes.byteLength >= PORTABLE_HISTORY_PREFIX_LENGTH
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .getUint32(PORTABLE_HISTORY_MAGIC.byteLength, true)
      : 0;
    if (
      !startsWithBytes(bytes, PORTABLE_HISTORY_MAGIC)
      || manifestLength === 0
      || manifestLength > MAX_PORTABLE_HISTORY_MANIFEST_BYTES
      || PORTABLE_HISTORY_PREFIX_LENGTH + manifestLength > bytes.byteLength
      || !hasValidPortableHistoryLayout(bytes, manifestLength)
    ) {
      throw new Error('Refusing to replace an RHWPX file with an invalid or truncated history archive');
    }
  } else if (extension === '.hwp') {
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
  } else if (extension === '.hml') {
    if (!hasValidHmlPreamble(bytes)) {
      throw new Error('Refusing to replace an HML file with invalid or truncated XML');
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
  } catch (error) {
    // Some filesystems do not implement directory fsync. Real storage errors
    // still make the write fail because the rename may not be durable.
    if (!UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code)) throw error;
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
    copyFileImpl = copyFile,
    linkImpl = link,
    renameImpl = rename,
    rmImpl = rm,
    statImpl = stat,
    syncParentImpl = syncParentDirectory,
    fingerprintImpl = fingerprintNativeFile,
    runCommandImpl = runNativeMetadataCommand,
    windowsSystemRoot = process.env.SystemRoot ?? process.env.WINDIR,
    expectedFingerprint,
  } = {},
) {
  const temporaryPath = `${filePath}.rauhwpx-${process.pid}-${randomUUID()}.tmp`;
  // Keep the real document extension so a recovery copy left by a power loss
  // remains visible and openable in the platform file picker.
  const backupPath = nativeRecoveryPath(filePath);
  const linkProbePath = `${filePath}.rauhwpx-${process.pid}-${randomUUID()}.link-probe`;
  let temporaryFile;
  let backupMoved = false;
  let published = false;
  let linkProbeCreated = false;
  try {
    let sourceInfo = null;
    try {
      sourceInfo = await statImpl(filePath, { bigint: true });
      if (!sourceInfo.isFile()) throw nativeFileConflictError();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const effectiveExpectedFingerprint = expectedFingerprint
      ?? await fingerprintImpl(filePath);
    if (!isNativeFileFingerprint(effectiveExpectedFingerprint)) {
      throw new Error('Native file write received an invalid expected fingerprint');
    }

    if ((platform === 'darwin' || platform === 'win32') && sourceInfo) {
      if (platform === 'darwin') {
        // macOS cp -p preserves ACLs, extended attributes, resource forks,
        // flags, and POSIX metadata. clonefile mode omits ACLs on some APFS
        // releases, so do not use cp -c here.
        await runCommandImpl('/bin/cp', ['-p', filePath, temporaryPath]);
      } else {
        // libuv uses the Windows CopyFile API. It retains EFS, compression,
        // alternate streams, extended attributes, and file attributes.
        await copyFileImpl(filePath, temporaryPath, constants.COPYFILE_EXCL);
      }
      temporaryFile = await openImpl(temporaryPath, 'r+');
      await temporaryFile.truncate(0);
    } else {
      temporaryFile = await openImpl(temporaryPath, 'wx');
    }
    await temporaryFile.writeFile(bytes);

    if (sourceInfo && platform !== 'win32') {
      await temporaryFile.chmod(Number(sourceInfo.mode) & 0o7777);
    }
    if (sourceInfo && platform === 'win32') {
      // Copy only the DACL. Keeping the temp file's owner and audit sections
      // avoids privilege escalation while preserving the destination rules.
      await copyWindowsDacl(filePath, temporaryPath, runCommandImpl, windowsSystemRoot);
    }

    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;

    try {
      await linkImpl(temporaryPath, linkProbePath);
      linkProbeCreated = true;
      await rmImpl(linkProbePath, { force: true });
      linkProbeCreated = false;
    } catch (error) {
      throw nativeFileAtomicUnsupportedError(error);
    }

    if (effectiveExpectedFingerprint.state === 'file') {
      try {
        await retryWindowsRename(() => renameImpl(filePath, backupPath), platform);
      } catch (error) {
        if (error?.code === 'ENOENT') throw nativeFileConflictError();
        throw error;
      }
      backupMoved = true;
      const movedFingerprint = await fingerprintImpl(backupPath);
      // Renaming the target changes ctime on POSIX. The stable file id,
      // mode, size, mtime, birth time, and content digest must still match.
      if (!sameMovedNativeFileFingerprint(effectiveExpectedFingerprint, movedFingerprint)) {
        throw nativeFileConflictError();
      }
    }
    try {
      // A hard link publishes the prepared inode only while the destination
      // is absent. If an editor or sync client creates a new path after the
      // rename-aside compare, EEXIST turns the save into a conflict.
      await linkImpl(temporaryPath, filePath);
    } catch (error) {
      if (error?.code === 'EEXIST') throw nativeFileConflictError();
      throw nativeFileAtomicUnsupportedError(error);
    }
    published = true;
    await rmImpl(temporaryPath, { force: true });

    await syncParentImpl(filePath, platform);
    if (backupMoved) {
      await rmImpl(backupPath, { force: true });
      backupMoved = false;
      await syncParentImpl(filePath, platform);
    }
    const savedInfo = await statImpl(filePath, { bigint: true });
    if (!savedInfo.isFile()) throw nativeFileConflictError();
    return nativeFileFingerprint(savedInfo, contentDigest(bytes));
  } catch (error) {
    const restoreErrors = [];
    await temporaryFile?.close().catch(() => {});
    if (linkProbeCreated) {
      await rmImpl(linkProbePath, { force: true }).catch(() => {});
    }
    if (backupMoved && !published) {
      try {
        await linkImpl(backupPath, filePath);
        await rmImpl(backupPath, { force: true });
        backupMoved = false;
      } catch (restoreError) {
        try {
          // COPYFILE_EXCL is the non-overwriting rollback for filesystems
          // whose hard-link support changed after the probe. It is also worth
          // retrying after EEXIST because a sync client may remove its
          // conflicting path between these two exclusive operations.
          await copyFileImpl(backupPath, filePath, constants.COPYFILE_EXCL);
          await rmImpl(backupPath, { force: true });
          backupMoved = false;
        } catch (copyError) {
          // Never infer that an unrelated file which appeared at the target
          // supersedes the generation we moved aside. If neither exclusive
          // restore can publish it, retain that last known-good document and
          // surface its exact recovery path.
          restoreErrors.push(restoreError, copyError);
        }
        // Other restore failures retain the moved file for manual recovery.
      }
    }
    if (!error?.processCleanupUncertain) {
      await rmImpl(temporaryPath, { force: true }).catch(() => {});
    }
    if (backupMoved && !published) {
      throw nativeFileRecoveryRequiredError(error, backupPath, restoreErrors);
    }
    throw error;
  }
}

function isPortableHistoryBundleName(filePath) {
  return extname(filePath).toLowerCase() === '.rhwpx';
}

function nativeDocumentMaxBytes(filePath) {
  return isPortableHistoryBundleName(filePath)
    ? MAX_PORTABLE_HISTORY_BYTES
    : MAX_NATIVE_DOCUMENT_BYTES;
}

function nativeDocumentSizeError(maxBytes) {
  return new Error(`The selected document is empty or exceeds the ${maxBytes / 1024 / 1024} MiB limit`);
}

export async function readPortableHistoryBytes(
  targetPath,
  {
    readFileImpl = readFile,
    statImpl = stat,
    openImpl = readFileImpl === readFile && statImpl === stat ? open : null,
  } = {},
) {
  const maxBytes = nativeDocumentMaxBytes(targetPath);
  let targetInfo;
  try {
    targetInfo = await statImpl(targetPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!openImpl) {
      const bytes = byteView(await readFileImpl(targetPath));
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
        throw nativeDocumentSizeError(maxBytes);
      }
      return byteView(bytes);
    }
    targetInfo = null;
  }
  let sourcePath = targetPath;
  let sourceInfo = targetInfo;
  if (targetInfo?.isDirectory()) {
    if (!isPortableHistoryBundleName(targetPath)) {
      throw new Error('Only RHWPX folders can be imported as legacy history bundles');
    }
    sourcePath = join(targetPath, PORTABLE_HISTORY_INNER_FILE);
    sourceInfo = await statImpl(sourcePath);
  }
  if (sourceInfo && !sourceInfo.isFile()) {
    throw new Error('The selected document is not a regular file');
  }
  if (sourceInfo && (
    !Number.isSafeInteger(sourceInfo.size)
    || sourceInfo.size <= 0
    || sourceInfo.size > maxBytes
  )) {
    throw nativeDocumentSizeError(maxBytes);
  }
  if (openImpl) {
    let handle;
    try {
      handle = await openImpl(sourcePath, 'r');
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile()) throw new Error('The selected document is not a regular file');
      if (
        !Number.isSafeInteger(openedInfo.size)
        || openedInfo.size <= 0
        || openedInfo.size > maxBytes
      ) {
        throw nativeDocumentSizeError(maxBytes);
      }
      const bytes = Buffer.allocUnsafe(openedInfo.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const extra = Buffer.allocUnsafe(1);
      const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
      if (offset !== bytes.byteLength || extraBytes !== 0) {
        throw new Error('The selected document changed while it was being read');
      }
      return byteView(bytes);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  const bytes = byteView(await readFileImpl(sourcePath));
  if (bytes.byteLength !== sourceInfo.size || bytes.byteLength > maxBytes) {
    throw new Error('The selected document changed while it was being read');
  }
  return bytes;
}

export function validateNativeDocumentPath(filePath, { platform = process.platform } = {}) {
  const absolute = typeof filePath === 'string'
    && (platform === 'win32' ? win32.isAbsolute(filePath) : isAbsolute(filePath));
  if (!absolute) {
    throw new Error('Native document paths must be absolute');
  }
  if (!SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new Error('Only HWP, HWPX, HML, and RHWPX files can be opened');
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
  #probes = new Map();
  #canonicalize;
  #ownershipKey;
  #createId;
  #readFile;
  #writeFile;
  #openDir;
  #stat;
  #digest;
  #fingerprint;

  constructor({
    canonicalize = canonicalNativePath,
    ownershipKey = nativePathOwnershipKey,
    createId = randomUUID,
    readFileImpl = readFile,
    writeFileImpl = writeNativeFileAtomically,
    openDirImpl = opendir,
    statImpl = stat,
    digestImpl = null,
    fingerprintImpl = fingerprintNativeFile,
  } = {}) {
    this.#canonicalize = canonicalize;
    this.#ownershipKey = ownershipKey;
    this.#createId = createId;
    this.#readFile = readFileImpl;
    this.#writeFile = writeFileImpl;
    this.#openDir = openDirImpl;
    this.#stat = statImpl;
    this.#digest = digestImpl;
    this.#fingerprint = fingerprintImpl;
  }

  async create(sessionId, filePath, { allowMissing = false } = {}) {
    const canonicalPath = await this.#canonicalize(filePath, { allowMissing });
    let legacyPortableHistoryFolder = false;
    if (isPortableHistoryBundleName(canonicalPath)) {
      try {
        const info = await this.#stat(canonicalPath);
        if (info.isDirectory()) {
          if (allowMissing) {
            throw new Error('Legacy RHWPX folders are import-only; choose a file destination');
          }
          legacyPortableHistoryFolder = true;
        } else if (!info.isFile()) {
          throw new Error('The selected document is not a regular file');
        }
      } catch (error) {
        if (!allowMissing || error?.code !== 'ENOENT') throw error;
      }
    }
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

    const diskFingerprint = legacyPortableHistoryFolder
      ? null
      : await this.#fingerprint(canonicalPath);
    if (!allowMissing && diskFingerprint?.state === 'missing') {
      throw nativeFileConflictError();
    }
    if (!legacyPortableHistoryFolder && !isNativeFileFingerprint(diskFingerprint)) {
      throw new Error('Native file fingerprint provider returned an invalid result');
    }

    // Fingerprinting yields to I/O. Another window can claim the path while
    // it is in progress, so repeat the ownership check before publishing.
    const concurrent = this.#byPath.get(ownershipPath);
    if (concurrent && concurrent.sessionId !== sessionId) {
      return { ok: false, ownerSessionId: concurrent.sessionId };
    }
    if (concurrent) {
      concurrent.releaseRequested = false;
      return { ok: true, descriptor: this.#descriptor(concurrent), created: false };
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
      legacyPortableHistoryFolder,
      diskFingerprint,
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

  /** Exact canonical source path for an explicitly sender-owned live handle. */
  sourcePathForSender(senderSessionId, handleId) {
    return this.#entryForSender(senderSessionId, handleId).canonicalPath;
  }

  async read(senderSessionId, handleId) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    return {
      name: entry.name,
      bytes: await readPortableHistoryBytes(entry.canonicalPath, {
        readFileImpl: this.#readFile,
        statImpl: this.#stat,
      }),
    };
  }

  validateSave(senderSessionId, handleId, identity, leases) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    return leases.validateSaveTarget(senderSessionId, identity, entry.ownershipPath);
  }

  async write(senderSessionId, handleId, bytes, identity, leases) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    if (entry.legacyPortableHistoryFolder) {
      throw new Error('Legacy RHWPX folders are import-only; save to an RHWPX file instead');
    }
    if (entry.activeWrites > 0) {
      const error = new Error('A native save is already in progress for this document');
      error.code = NATIVE_FILE_WRITE_BUSY_CODE;
      throw error;
    }
    entry.activeWrites += 1;
    try {
      this.validateSave(senderSessionId, handleId, identity, leases);
      validateNativeDocumentBytes(entry.canonicalPath, bytes);
      const write = entry.writeChain.then(async () => {
        // Revalidate after earlier queued writes. A stale window/document must
        // never reach the filesystem merely because it entered the queue first.
        this.validateSave(senderSessionId, handleId, identity, leases);
        const savedFingerprint = await this.#writeFile(entry.canonicalPath, bytes, {
          expectedFingerprint: entry.diskFingerprint,
        });
        entry.diskFingerprint = isNativeFileFingerprint(savedFingerprint)
          ? savedFingerprint
          : await this.#fingerprint(entry.canonicalPath);
        if (!isNativeFileFingerprint(entry.diskFingerprint)
          || entry.diskFingerprint.state !== 'file') {
          throw new Error('Native file write did not produce a durable fingerprint');
        }
        this.#refreshBookmarkDigest(identity, entry, bytes);
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

  rememberDocument(documentId, senderSessionId, handleId, digest) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    const previous = this.#bookmarks.get(documentId);
    if (
      previous
      && digest === undefined
      && this.#ownershipKey(previous.path) !== entry.ownershipPath
    ) {
      return previous.path;
    }
    let nextDigest = previous?.digest ?? null;
    if (digest !== undefined) nextDigest = parseStoredDigest(digest);
    // A canonical path has one logical owner. Old builds could accumulate
    // duplicate owners after every broken reopen; the first loaded owner is
    // used until a successful remember cleans the ambiguity up.
    for (const [otherDocumentId, bookmark] of this.#bookmarks) {
      if (
        otherDocumentId !== documentId
        && this.#ownershipKey(bookmark.path) === entry.ownershipPath
      ) {
        this.#bookmarks.delete(otherDocumentId);
      }
    }
    if (this.#bookmarks.has(documentId)) this.#bookmarks.delete(documentId);
    this.#bookmarks.set(documentId, { path: entry.canonicalPath, digest: nextDigest });
    while (this.#bookmarks.size > 200) {
      const oldest = this.#bookmarks.keys().next().value;
      this.#bookmarks.delete(oldest);
    }
    return entry.canonicalPath;
  }

  async reopenDocument(sessionId, documentId) {
    const bookmark = this.#bookmarks.get(documentId);
    if (!bookmark) return null;
    return this.create(sessionId, bookmark.path);
  }

  bookmarkPathFor(documentId) {
    return this.#bookmarks.get(documentId)?.path ?? null;
  }

  async searchNearby(sessionId, documentId, { basenameHint = '' } = {}) {
    this.#forgetSessionProbes(sessionId);
    const probes = [];
    for (const filePath of await this.#collectNearbyFiles(sessionId, documentId, basenameHint)) {
      const probeId = this.#createId();
      const name = basename(filePath);
      this.#probes.set(probeId, { sessionId, path: filePath, name });
      probes.push(Object.freeze({ probeId, fileName: name }));
    }
    return probes;
  }

  async readProbe(sessionId, probeId) {
    const probe = this.#probeForSender(sessionId, probeId);
    const canonicalPath = await this.#canonicalize(probe.path);
    const owner = this.#byPath.get(this.#ownershipKey(canonicalPath));
    if (owner && owner.sessionId !== sessionId) {
      throw new Error('Native file probe does not belong to this window');
    }
    return {
      name: probe.name,
      bytes: await readPortableHistoryBytes(canonicalPath, {
        readFileImpl: this.#readFile,
        statImpl: this.#stat,
      }),
    };
  }

  async claimProbe(sessionId, probeId) {
    const probe = this.#probeForSender(sessionId, probeId);
    this.#probes.delete(probeId);
    return this.create(sessionId, probe.path);
  }

  async verifyPick(sessionId, documentId, handleId) {
    const entry = this.#entryForSender(sessionId, handleId);
    const bookmark = this.#bookmarks.get(documentId);
    if (!bookmark) return false;
    return entry.ownershipPath === this.#ownershipKey(bookmark.path);
  }

  loadBookmarks(entries, { strict = false } = {}) {
    if (!Array.isArray(entries)) throw new Error('Native bookmark store must be an array');
    const next = new Map();
    for (const item of entries ?? []) {
      const parsed = parseBookmarkEntry(item);
      if (!parsed) {
        if (strict) throw new Error('Native bookmark store contains an invalid entry');
        continue;
      }
      if (strict && next.has(parsed.documentId)) {
        throw new Error('Native bookmark store contains a duplicate document id');
      }
      next.set(parsed.documentId, { path: parsed.path, digest: parsed.digest });
    }
    if (strict && next.size > 200) throw new Error('Native bookmark store contains too many entries');
    this.#bookmarks = next;
  }

  dumpBookmarks() {
    return [...this.#bookmarks.entries()].map(([documentId, bookmark]) => [
      documentId,
      { path: bookmark.path, digest: bookmark.digest },
    ]);
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
    this.#forgetSessionProbes(sessionId);
  }

  #forgetSessionProbes(sessionId) {
    for (const [probeId, probe] of this.#probes) {
      if (probe.sessionId === sessionId) this.#probes.delete(probeId);
    }
  }

  #refreshBookmarkDigest(identity, entry, bytes) {
    const documentId = identity?.documentId;
    if (!documentId || !this.#digest) return;
    const bookmark = this.#bookmarks.get(documentId);
    if (!bookmark || this.#ownershipKey(bookmark.path) !== entry.ownershipPath) return;
    bookmark.digest = parseStoredDigest(this.#digest(bytes));
  }

  async #collectNearbyFiles(sessionId, documentId, basenameHint) {
    const wanted = basename(String(basenameHint || this.#bookmarks.get(documentId)?.path || ''));
    const dirs = [];
    const seenDirs = new Set();
    const addDir = (dir) => {
      if (!dir || dir === '.' || dir === '/' ) return;
      const key = this.#ownershipKey(dir);
      if (seenDirs.has(key) || dirs.length >= NEARBY_DIRECTORY_CAP) return;
      seenDirs.add(key);
      dirs.push(dir);
    };

    const bookmark = this.#bookmarks.get(documentId);
    if (bookmark) {
      addDir(dirname(bookmark.path));
      addDir(dirname(dirname(bookmark.path)));
    }
    for (const other of [...this.#bookmarks.values()].reverse()) {
      addDir(dirname(other.path));
      if (dirs.length >= NEARBY_DIRECTORY_CAP) break;
    }

    const preferred = [];
    const rest = [];
    for (const dir of dirs) {
      const wantedKey = wanted ? this.#ownershipKey(join(dir, wanted)) : null;
      for (const filePath of await this.#listDocumentFiles(dir)) {
        if (wantedKey && this.#ownershipKey(filePath) === wantedKey) preferred.push(filePath);
        else rest.push(filePath);
      }
    }

    const unique = [];
    const seenFiles = new Set();
    for (const filePath of [...preferred, ...rest]) {
      let canonicalPath;
      try {
        canonicalPath = await this.#canonicalize(filePath);
      } catch {
        continue;
      }
      const key = this.#ownershipKey(canonicalPath);
      if (seenFiles.has(key)) continue;
      const owner = this.#byPath.get(key);
      if (owner && owner.sessionId !== sessionId) continue;
      seenFiles.add(key);
      unique.push(canonicalPath);
      if (unique.length >= NEARBY_FILE_CAP) break;
    }
    return unique;
  }

  async #listDocumentFiles(dir) {
    let directory;
    try {
      directory = await this.#openDir(dir);
    } catch {
      return [];
    }
    const files = [];
    let seen = 0;
    try {
      for await (const entry of directory) {
        seen += 1;
        if (seen > NEARBY_DIR_ENTRY_CAP) break;
        const name = typeof entry === 'string' ? entry : entry.name;
        const isDirectory = typeof entry !== 'string'
          && typeof entry.isDirectory === 'function'
          && entry.isDirectory();
        const supported = SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase());
        if (!supported) continue;
        if (isDirectory && extname(name).toLowerCase() !== '.rhwpx') continue;
        files.push(join(dir, name));
      }
    } catch {
      return files;
    } finally {
      await directory.close?.().catch(() => {});
    }
    return files;
  }

  #probeForSender(sessionId, probeId) {
    const probe = this.#probes.get(probeId);
    if (!probe || probe.sessionId !== sessionId) {
      throw new Error('Native file probe does not belong to this window');
    }
    return probe;
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
    const verifiedDocumentId = this.#documentIdForOwnershipPath(entry.ownershipPath);
    return Object.freeze({
      kind: 'file',
      handleId: entry.handleId,
      name: entry.name,
      ...(entry.legacyPortableHistoryFolder ? { legacyPortableHistoryFolder: true } : {}),
      ...(verifiedDocumentId ? { verifiedDocumentId } : {}),
    });
  }

  #documentIdForOwnershipPath(ownershipPath) {
    for (const [documentId, bookmark] of this.#bookmarks) {
      if (this.#ownershipKey(bookmark.path) === ownershipPath) return documentId;
    }
    return null;
  }
}

function parseStoredDigest(value) {
  return typeof value === 'string' && /^blake3:[0-9a-f]{64}$/.test(value) ? value : null;
}

function parseBookmarkEntry(item) {
  if (!Array.isArray(item) || item.length < 2) return null;
  const documentId = item[0];
  if (typeof documentId !== 'string' || !documentId) return null;
  const value = item[1];
  if (typeof value === 'string' && value) {
    return { documentId, path: value, digest: null };
  }
  if (value && typeof value === 'object' && typeof value.path === 'string' && value.path) {
    return { documentId, path: value.path, digest: parseStoredDigest(value.digest) };
  }
  return null;
}

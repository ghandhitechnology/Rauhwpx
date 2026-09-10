import { promises as fs } from 'node:fs';
import path from 'node:path';

const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

function backupPath(targetPath) {
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.previous-write`);
}

async function retryWindows(operation, platform, sleep) {
  const delays = [50, 100, 200, 400, 800];
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (platform !== 'win32' || !LOCK_CODES.has(error?.code) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}

async function exists(fsImpl, filePath) {
  try {
    await fsImpl.stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function isDirectory(fsImpl, filePath) {
  try {
    return (await fsImpl.lstat(filePath)).isDirectory();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function directoryReplaceError(targetPath) {
  const error = new Error(`Refusing to replace directory ${targetPath}`);
  error.code = 'EISDIR';
  return error;
}

function rollbackFailedError(error, rollbackError, previous, tempPath) {
  const failure = new AggregateError(
    [error, rollbackError],
    `Windows file replacement failed; the previous value remains at ${previous}`,
  );
  failure.code = 'FILE_REPLACE_ROLLBACK_FAILED';
  failure.backupPath = previous;
  failure.tempPath = tempPath;
  return failure;
}

async function removeReplacementBackup(fsImpl, filePath, platform, sleep) {
  if (await isDirectory(fsImpl, filePath)) {
    throw directoryReplaceError(filePath);
  }
  await retryWindows(() => fsImpl.rm(filePath, { force: true }), platform, sleep);
}

function dependencies(options = {}) {
  return {
    fsImpl: options.fsImpl ?? fs,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/** Restore the last complete file after an interrupted Windows replacement. */
export async function recoverReplacedFile(targetPath, platform = process.platform, options = {}) {
  if (platform !== 'win32') return false;
  const { fsImpl, sleep } = dependencies(options);
  const previous = backupPath(targetPath);
  if (!await exists(fsImpl, previous)) return false;
  if (await exists(fsImpl, targetPath)) {
    await removeReplacementBackup(fsImpl, previous, platform, sleep).catch(() => {});
    return false;
  }
  await retryWindows(() => fsImpl.rename(previous, targetPath), platform, sleep);
  return true;
}

/**
 * Windows cannot rename over an existing file and may briefly lock files for
 * antivirus or indexing. Keep one deterministic backup so startup can restore
 * the last complete value if both the commit and its immediate rollback fail.
 */
export async function replaceFile(tempPath, targetPath, platform = process.platform, options = {}) {
  const { fsImpl, sleep } = dependencies(options);
  if (platform !== 'win32') return fsImpl.rename(tempPath, targetPath);
  if (await isDirectory(fsImpl, targetPath)) {
    throw directoryReplaceError(targetPath);
  }
  const previous = backupPath(targetPath);

  try {
    await recoverReplacedFile(targetPath, platform, { fsImpl, sleep });
    if (await exists(fsImpl, previous)) {
      const error = new Error(`Previous Windows file backup is still locked: ${previous}`);
      error.code = 'FILE_BACKUP_LOCKED';
      throw error;
    }
  } catch (error) {
    await fsImpl.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  if (await isDirectory(fsImpl, targetPath)) {
    throw directoryReplaceError(targetPath);
  }

  let moved = false;
  try {
    await retryWindows(() => fsImpl.rename(targetPath, previous), platform, sleep);
    moved = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      await fsImpl.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  if (moved && await isDirectory(fsImpl, previous)) {
    try {
      await retryWindows(() => fsImpl.rename(previous, targetPath), platform, sleep);
    } catch (restoreError) {
      throw rollbackFailedError(
        directoryReplaceError(targetPath),
        restoreError,
        previous,
        tempPath,
      );
    }
    throw directoryReplaceError(targetPath);
  }

  try {
    await retryWindows(() => fsImpl.rename(tempPath, targetPath), platform, sleep);
  } catch (error) {
    let rollbackError = null;
    if (moved) {
      try {
        await retryWindows(() => fsImpl.rename(previous, targetPath), platform, sleep);
      } catch (caught) {
        rollbackError = caught;
      }
    }
    if (!rollbackError) await fsImpl.rm(tempPath, { force: true }).catch(() => {});
    if (rollbackError) throw rollbackFailedError(error, rollbackError, previous, tempPath);
    throw error;
  }

  if (moved) {
    await removeReplacementBackup(fsImpl, previous, platform, sleep).catch(() => {});
  }
}

export const __test = { backupPath };

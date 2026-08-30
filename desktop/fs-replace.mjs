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
    await retryWindows(() => fsImpl.rm(previous, { force: true }), platform, sleep).catch(() => {});
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
    if (rollbackError) {
      const failure = new AggregateError(
        [error, rollbackError],
        `Windows file replacement failed; the previous value remains at ${previous}`,
      );
      failure.code = 'FILE_REPLACE_ROLLBACK_FAILED';
      failure.backupPath = previous;
      failure.tempPath = tempPath;
      throw failure;
    }
    throw error;
  }

  if (moved) {
    await retryWindows(() => fsImpl.rm(previous, { force: true }), platform, sleep).catch(() => {});
  }
}

export const __test = { backupPath };

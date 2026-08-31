import { promises as fs } from 'node:fs';

import { cancelResponseBody, readResponseJsonBounded } from './response-bounds.mjs';

const REGISTRY_BASE = 'https://registry.npmjs.org';
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);
const RETRY_DELAYS_MS = [80, 160, 320, 640, 1_000, 1_500];
const REGISTRY_METADATA_LIMIT_BYTES = 64 * 1024;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Defender/npm can briefly retain Windows handles after a process exits. */
export async function retryLockedOperation(operation, {
  platform = process.platform,
  delays = RETRY_DELAYS_MS,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (platform !== 'win32' || !LOCK_CODES.has(error?.code) || attempt === delays.length) break;
      await delay(delays[attempt]);
    }
  }
  if (platform === 'win32' && LOCK_CODES.has(lastError?.code)) {
    lastError.code = 'HARNESS_FILES_LOCKED';
    lastError.message = '설치 파일이 사용 중이라 업데이트하지 못했어요. 실행 중인 harness와 바이러스 검사를 확인한 뒤 다시 시도하세요.';
  }
  throw lastError;
}

/** Replace a file without relying on Windows rename-over-existing behavior. */
export async function replaceFileAtomically(
  tempPath,
  targetPath,
  { platform = process.platform, fsApi = fs } = {},
) {
  if (platform !== 'win32') return fsApi.rename(tempPath, targetPath);
  const previousPath = `${targetPath}.previous-write`;
  await recoverInterruptedFileReplacement(targetPath, { platform, fsApi });
  await retryLockedOperation(() => fsApi.rm(previousPath, { force: true }), { platform });
  let moved = false;
  try {
    await retryLockedOperation(() => fsApi.rename(targetPath, previousPath), { platform });
    moved = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await retryLockedOperation(() => fsApi.rename(tempPath, targetPath), { platform });
  } catch (error) {
    let restoreError = null;
    if (moved) {
      try {
        await retryLockedOperation(() => fsApi.rename(previousPath, targetPath), { platform });
      } catch (candidate) {
        restoreError = candidate;
      }
    }
    if (restoreError) {
      const recoveryError = new Error('File replacement failed and the previous file could not be restored');
      recoveryError.code = 'FILE_REPLACE_RECOVERY_FAILED';
      recoveryError.cause = new AggregateError([error, restoreError]);
      throw recoveryError;
    }
    throw error;
  }
  // The commit boundary is the temp -> target rename. A locked stale backup is
  // safe to clean up on the next write/startup and must not turn a committed
  // state change into a reported failure.
  if (moved) {
    await retryLockedOperation(() => fsApi.rm(previousPath, { force: true }), { platform })
      .catch(() => {});
  }
}

/** Restore the old target after a process died between the two Windows renames. */
export async function recoverInterruptedFileReplacement(
  targetPath,
  { platform = process.platform, fsApi = fs } = {},
) {
  if (platform !== 'win32') return false;
  const previousPath = `${targetPath}.previous-write`;
  const exists = async (filePath) => {
    try {
      await fsApi.access(filePath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };
  if (!await exists(previousPath)) return false;
  if (await exists(targetPath)) {
    await retryLockedOperation(() => fsApi.rm(previousPath, { force: true }), { platform })
      .catch(() => {});
    return false;
  }
  await retryLockedOperation(() => fsApi.rename(previousPath, targetPath), { platform });
  return true;
}

/** Delete a Windows-replaced file without leaving an old backup to resurrect. */
export async function removeFileAndReplacementBackup(
  targetPath,
  { platform = process.platform, fsApi = fs, delays } = {},
) {
  if (platform === 'win32') {
    // Removing the backup first makes a crash conservative: before the target
    // removal the old live value remains, and after it no recovery copy exists.
    await retryLockedOperation(
      () => fsApi.rm(`${targetPath}.previous-write`, { force: true }),
      { platform, ...(delays ? { delays } : {}) },
    );
  }
  await retryLockedOperation(
    () => fsApi.rm(targetPath, { force: true }),
    { platform, ...(delays ? { delays } : {}) },
  );
}

/** registry 가 준 version 문자열이 npm 인자로 안전한 semver 인지 확인한다. */
export function isSafeSemverVersion(value) {
  return typeof value === 'string'
    && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
    && value.length <= 64;
}

export async function fetchLatestPackage(fetchImpl, packageName, timeoutMs = 10_000) {
  const encoded = packageName.replace('/', '%2F');
  const response = await fetchImpl(`${REGISTRY_BASE}/${encoded}/latest`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await cancelResponseBody(response, new Error(`registry HTTP ${response.status}`));
    throw new Error(`registry HTTP ${response.status}`);
  }
  const metadata = await readResponseJsonBounded(response, {
    maxBytes: REGISTRY_METADATA_LIMIT_BYTES,
    label: `${packageName} registry metadata`,
  });
  // 버전은 npm argv 에 보간된다 — semver 형태가 아니면 설치 플래그 주입으로 이어질 수
  // 있으니 비정형 메타데이터는 업데이트 실패로 간주한다.
  if (!isSafeSemverVersion(metadata?.version)) {
    throw new Error('registry version is missing or malformed');
  }
  return {
    version: metadata.version.replace(/^v/, ''),
    tarball: typeof metadata?.dist?.tarball === 'string' ? metadata.dist.tarball : null,
    integrity: typeof metadata?.dist?.integrity === 'string' ? metadata.dist.integrity : null,
  };
}

/** 활성 npm prefix 옆에서 갱신본을 검증한 뒤 교체한다. 직전 prefix 는 롤백용으로 남긴다. */
export async function updatePrefixAtomically({
  prefixDir,
  label,
  install,
  verify,
  canActivate = () => true,
  platform = process.platform,
}) {
  const suffix = `${process.pid}-${Date.now()}`;
  const stagingDir = `${prefixDir}.update-${label}-${suffix}`;
  const previousDir = `${prefixDir}.previous`;
  let activeMoved = false;
  let cleanupUncertain = false;

  try {
    try {
      await fs.cp(prefixDir, stagingDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await fs.mkdir(stagingDir, { recursive: true });
    }

    await install(stagingDir);
    await verify(stagingDir);
    if (!canActivate()) throw new Error('harness became busy before activation');

    await retryLockedOperation(
      () => fs.rm(previousDir, { recursive: true, force: true }),
      { platform },
    );
    try {
      await retryLockedOperation(() => fs.rename(prefixDir, previousDir), { platform });
      activeMoved = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    try {
      await retryLockedOperation(() => fs.rename(stagingDir, prefixDir), { platform });
    } catch (error) {
      if (activeMoved) {
        await retryLockedOperation(() => fs.rename(previousDir, prefixDir), { platform }).catch(() => {});
      }
      throw error;
    }
  } catch (error) {
    cleanupUncertain = error?.processCleanupUncertain === true;
    throw error;
  } finally {
    if (!cleanupUncertain) {
      await retryLockedOperation(
        () => fs.rm(stagingDir, { recursive: true, force: true }),
        { platform },
      ).catch(() => {});
    }
  }
}

import { promises as fs } from 'node:fs';

const REGISTRY_BASE = 'https://registry.npmjs.org';
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);
const RETRY_DELAYS_MS = [80, 160, 320, 640, 1_000, 1_500];

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
export async function replaceFileAtomically(tempPath, targetPath, { platform = process.platform } = {}) {
  if (platform !== 'win32') return fs.rename(tempPath, targetPath);
  const previousPath = `${targetPath}.previous-write`;
  await retryLockedOperation(() => fs.rm(previousPath, { force: true }), { platform });
  let moved = false;
  try {
    await retryLockedOperation(() => fs.rename(targetPath, previousPath), { platform });
    moved = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await retryLockedOperation(() => fs.rename(tempPath, targetPath), { platform });
  } catch (error) {
    if (moved) await retryLockedOperation(() => fs.rename(previousPath, targetPath), { platform }).catch(() => {});
    throw error;
  }
  if (moved) await retryLockedOperation(() => fs.rm(previousPath, { force: true }), { platform });
}

export async function fetchLatestPackage(fetchImpl, packageName, timeoutMs = 10_000) {
  const encoded = packageName.replace('/', '%2F');
  const response = await fetchImpl(`${REGISTRY_BASE}/${encoded}/latest`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
  const metadata = await response.json();
  if (typeof metadata?.version !== 'string' || !metadata.version) {
    throw new Error('registry version is missing');
  }
  return {
    version: metadata.version,
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
  } finally {
    await retryLockedOperation(
      () => fs.rm(stagingDir, { recursive: true, force: true }),
      { platform },
    ).catch(() => {});
  }
}

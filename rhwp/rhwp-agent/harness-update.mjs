import { promises as fs } from 'node:fs';

const REGISTRY_BASE = 'https://registry.npmjs.org';

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
export async function updatePrefixAtomically({ prefixDir, label, install, verify, canActivate = () => true }) {
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

    await fs.rm(previousDir, { recursive: true, force: true });
    try {
      await fs.rename(prefixDir, previousDir);
      activeMoved = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    try {
      await fs.rename(stagingDir, prefixDir);
    } catch (error) {
      if (activeMoved) await fs.rename(previousDir, prefixDir).catch(() => {});
      throw error;
    }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

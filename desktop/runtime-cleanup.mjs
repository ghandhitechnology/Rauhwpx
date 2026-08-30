import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const LAUNCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function removeStaleLaunchDirectories(
  parentDir,
  activeLaunchId,
  { readdirImpl = readdir, rmImpl = rm } = {},
) {
  let entries;
  try {
    entries = await readdirImpl(parentDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const stale = entries.filter((entry) => (
    entry.isDirectory()
    && entry.name !== activeLaunchId
    && LAUNCH_ID_PATTERN.test(entry.name)
  ));
  await Promise.all(stale.map((entry) => (
    rmImpl(join(parentDir, entry.name), { recursive: true, force: true })
  )));
  return stale.map((entry) => entry.name);
}

export async function prepareDevelopmentCaches(browserSession, codeCachePath) {
  await browserSession.clearCache();
  if (typeof browserSession.clearCodeCaches === 'function') {
    await browserSession.clearCodeCaches({});
  }
  browserSession.setCodeCachePath(codeCachePath);
}

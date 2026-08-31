import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rm, writeFile } from 'node:fs/promises';
import { uptime as systemUptime } from 'node:os';
import path from 'node:path';

const LAUNCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID_PATTERN = /^[0-9a-f]{20}$/;

export const LAUNCH_OWNER_FILE = '.rauhwpx-owner.json';
export const LEGACY_CLEANUP_MARKER_FILE = '.rauhwpx-legacy-cleanup.json';
export const CREDENTIAL_RETENTION_DIR = '.rauhwpx-credential-copybacks';
export const STALE_LAUNCH_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const LEGACY_LAUNCH_MIN_AGE_MS = 7 * STALE_LAUNCH_MIN_AGE_MS;
export const LEGACY_REBOOT_UPTIME_TOLERANCE_SECONDS = 60;
export const MAX_LAUNCH_DIRECTORY_ENTRIES = 4096;
const MAX_CREDENTIAL_RETENTION_ENTRIES = 256;
const MAX_CLEANUP_METADATA_BYTES = 4096;

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Resolve the profile path through symlinks before hashing it. Electron normally
 * creates userData before this runs. The resolved-path fallback covers a fresh
 * profile whose last component does not exist yet.
 */
export function canonicalUserDataPath(userDataDir, {
  platform = process.platform,
  realpathImpl = realpathSync.native,
} = {}) {
  const api = pathApi(platform);
  const absolute = api.resolve(String(userDataDir));
  let candidate = absolute;
  const missingParts = [];
  let canonical = absolute;
  for (;;) {
    try {
      canonical = api.join(String(realpathImpl(candidate)), ...missingParts);
      break;
    } catch {
      const parent = api.dirname(candidate);
      if (parent === candidate) break;
      missingParts.unshift(api.basename(candidate));
      candidate = parent;
    }
  }
  canonical = api.normalize(String(canonical));
  return platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
}

/** A stable, non-identifying namespace for one exact Electron userData path. */
export function userDataProfileId(userDataDir, options = {}) {
  const canonical = canonicalUserDataPath(userDataDir, options);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 20);
}

export function launchStoragePaths({
  tempDir,
  userDataDir,
  launchId,
  platform = process.platform,
  realpathImpl = realpathSync.native,
}) {
  if (!LAUNCH_ID_PATTERN.test(String(launchId))) throw new Error('Invalid launch id');
  const api = pathApi(platform);
  const profileId = userDataProfileId(userDataDir, { platform, realpathImpl });
  const legacyRuntimeRoot = api.join(String(tempDir), 'rauhwpx', 'runtime');
  const legacyWorkRoot = api.join(String(userDataDir), 'launch-work');
  const runtimeRoot = api.join(String(tempDir), 'rauhwpx', 'profiles', profileId, 'runtime');
  const workRoot = api.join(String(userDataDir), 'launch-work', profileId);
  return Object.freeze({
    profileId,
    runtimeRoot,
    workRoot,
    runtimeDir: api.join(runtimeRoot, launchId),
    workDir: api.join(workRoot, launchId),
    legacyRuntimeRoot,
    legacyWorkRoot,
  });
}

export async function writeLaunchOwnerMetadata(directory, {
  launchId,
  profileId,
  pid = process.pid,
  createdAtMs = Date.now(),
}, {
  mkdirImpl = mkdir,
  renameImpl = rename,
  writeFileImpl = writeFile,
} = {}) {
  if (!LAUNCH_ID_PATTERN.test(String(launchId))) throw new Error('Invalid launch owner id');
  if (!PROFILE_ID_PATTERN.test(String(profileId))) throw new Error('Invalid launch profile id');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid launch owner pid');
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0) throw new Error('Invalid launch creation time');

  await mkdirImpl(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, LAUNCH_OWNER_FILE);
  const temporary = path.join(directory, `.${LAUNCH_OWNER_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const metadata = {
    version: 1,
    launchId,
    profileId,
    pid,
    createdAtMs,
  };
  await writeFileImpl(temporary, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await renameImpl(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return metadata;
}

export function isProcessAlive(pid, { killImpl = process.kill } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function validOwnerMetadata(raw, directoryName, expectedProfileId) {
  if (!raw || raw.version !== 1) return null;
  if (raw.launchId !== directoryName || !LAUNCH_ID_PATTERN.test(raw.launchId)) return null;
  if (!PROFILE_ID_PATTERN.test(String(raw.profileId))) return null;
  if (expectedProfileId && raw.profileId !== expectedProfileId) return null;
  if (!Number.isSafeInteger(raw.pid) || raw.pid <= 0) return null;
  if (!Number.isSafeInteger(raw.createdAtMs) || raw.createdAtMs <= 0) return null;
  return raw;
}

async function readBoundedDirectory(directory, {
  maxEntries,
  opendirImpl,
  readdirImpl,
}) {
  if (typeof readdirImpl === 'function') {
    const entries = await readdirImpl(directory, { withFileTypes: true });
    return {
      entries: entries.slice(0, maxEntries),
      truncated: entries.length > maxEntries,
    };
  }

  const handle = await opendirImpl(directory);
  const entries = [];
  let truncated = false;
  try {
    for await (const entry of handle) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } finally {
    await handle.close().catch((error) => {
      if (error?.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  return { entries, truncated };
}

async function readBoundedJson(filePath, {
  lstatImpl,
  openImpl,
  readFileImpl,
}) {
  // Dependency-injected readers keep unit tests lightweight. Production uses
  // a descriptor and a fixed buffer, so an agent-written marker cannot cause
  // an unbounded startup allocation or a symlink swap.
  if (typeof readFileImpl === 'function') {
    const raw = await readFileImpl(filePath, 'utf8');
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_CLEANUP_METADATA_BYTES) {
      throw new Error('Cleanup metadata exceeds its safety limit');
    }
    return JSON.parse(raw);
  }

  const before = await lstatImpl(filePath);
  if (!before.isFile() || before.isSymbolicLink()
    || before.size < 1 || before.size > MAX_CLEANUP_METADATA_BYTES) {
    throw new Error('Cleanup metadata is not a bounded regular file');
  }
  const handle = await openImpl(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size < 1 || opened.size > MAX_CLEANUP_METADATA_BYTES
      || (before.dev && opened.dev && before.dev !== opened.dev)
      || (before.ino && opened.ino && before.ino !== opened.ino)) {
      throw new Error('Cleanup metadata changed while it was opened');
    }
    const buffer = Buffer.allocUnsafe(MAX_CLEANUP_METADATA_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CLEANUP_METADATA_BYTES) {
      throw new Error('Cleanup metadata exceeds its safety limit');
    }
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } finally {
    await handle.close();
  }
}

async function hasPendingCredentialCopyback(directory, directoryOptions) {
  try {
    const { entries, truncated } = await readBoundedDirectory(
      path.join(directory, CREDENTIAL_RETENTION_DIR),
      {
        ...directoryOptions,
        maxEntries: MAX_CREDENTIAL_RETENTION_ENTRIES,
      },
    );
    // A truncated or corrupted retention directory is not proof that deletion
    // is safe. Keep the launch root for a later recovery pass.
    return truncated
      || entries.some((entry) => /^[0-9a-f]{16}\.pending$/.test(entry.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return true;
  }
}

async function readCleanupRetentionMarker(directory, directoryName, fileOptions) {
  try {
    const raw = await readBoundedJson(
      path.join(directory, LEGACY_CLEANUP_MARKER_FILE),
      fileOptions,
    );
    return { exists: true, marker: validLegacyCleanupMarker(raw, directoryName) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, marker: null };
    // A malformed, oversized, or unreadable marker cannot authorize deletion.
    return { exists: true, marker: null };
  }
}

async function readOwnerMetadata(directory, directoryName, expectedProfileId, fileOptions) {
  try {
    const owner = validOwnerMetadata(await readBoundedJson(
      path.join(directory, LAUNCH_OWNER_FILE),
      fileOptions,
    ), directoryName, expectedProfileId);
    return { exists: true, owner };
  } catch (error) {
    return { exists: error?.code !== 'ENOENT', owner: null };
  }
}

/**
 * Remove only launch directories whose owner record is old enough and whose
 * PID is confirmed dead. A missing record is never permission to delete. That
 * protects pre-namespace builds running from another worktree.
 */
export async function removeStaleLaunchDirectories(
  parentDir,
  activeLaunchId,
  {
    expectedProfileId = null,
    minimumAgeMs = STALE_LAUNCH_MIN_AGE_MS,
    now = Date.now,
    isAlive = isProcessAlive,
    uptimeSeconds = systemUptime,
    lstatImpl = lstat,
    openImpl = open,
    opendirImpl = opendir,
    readFileImpl,
    readdirImpl,
    rmImpl = rm,
  } = {},
) {
  let entries;
  try {
    ({ entries } = await readBoundedDirectory(parentDir, {
      maxEntries: MAX_LAUNCH_DIRECTORY_ENTRIES,
      opendirImpl,
      readdirImpl,
    }));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()
      || entry.name === activeLaunchId
      || !LAUNCH_ID_PATTERN.test(entry.name)) continue;

    const directory = path.join(parentDir, entry.name);
    const fileOptions = { lstatImpl, openImpl, readFileImpl };
    const directoryOptions = { opendirImpl, readdirImpl };
    const { owner } = await readOwnerMetadata(
      directory,
      entry.name,
      expectedProfileId,
      fileOptions,
    );
    if (!owner) continue;

    const currentTime = Number(now());
    if (!Number.isFinite(currentTime)
      || currentTime < owner.createdAtMs
      || currentTime - owner.createdAtMs < minimumAgeMs) continue;
    if (isAlive(owner.pid)) continue;
    if (await hasPendingCredentialCopyback(directory, directoryOptions)) continue;

    const cleanupRetention = await readCleanupRetentionMarker(
      directory,
      entry.name,
      fileOptions,
    );
    if (cleanupRetention.exists) {
      const currentUptime = Number(uptimeSeconds());
      const marker = cleanupRetention.marker;
      if (!marker || !Number.isFinite(currentUptime) || currentUptime < 0) continue;
      if (!(currentUptime + LEGACY_REBOOT_UPTIME_TOLERANCE_SECONDS
        < marker.observedUptimeSeconds)) {
        // Never replace a process-safety marker in place. Windows replacement
        // has an unavoidable unlink/rename gap; a crash in that gap could make
        // the next startup treat an uncertain root as unmarked.
        continue;
      }
    }

    await rmImpl(directory, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

export function removeLegacyLaunchDirectories(parentDir, activeLaunchId, options = {}) {
  return removeLegacyLaunchDirectoriesAfterReboot(parentDir, activeLaunchId, options);
}

function validLegacyCleanupMarker(raw, directoryName) {
  if (!raw || raw.version !== 1 || raw.launchId !== directoryName) return null;
  if (!LAUNCH_ID_PATTERN.test(raw.launchId)) return null;
  if (!Number.isFinite(raw.observedUptimeSeconds) || raw.observedUptimeSeconds < 0) return null;
  if (!Number.isSafeInteger(raw.observedAtMs) || raw.observedAtMs <= 0) return null;
  if (!Number.isFinite(raw.directoryMtimeMs) || raw.directoryMtimeMs < 0) return null;
  return raw;
}

async function writeLegacyCleanupMarker(directory, marker, {
  renameImpl,
  rmImpl,
  writeFileImpl,
}) {
  const target = path.join(directory, LEGACY_CLEANUP_MARKER_FILE);
  const temporary = path.join(
    directory,
    `.${LEGACY_CLEANUP_MARKER_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFileImpl(temporary, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await renameImpl(temporary, target);
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') {
      await rmImpl(temporary, { force: true }).catch(() => {});
      throw error;
    }
    await rmImpl(target, { force: true });
    try {
      await renameImpl(temporary, target);
    } catch (replacementError) {
      await rmImpl(temporary, { force: true }).catch(() => {});
      throw replacementError;
    }
  }
}

/**
 * Migrate pre-owner-metadata launch directories without guessing whether an
 * old desktop process is alive. The first old-enough observation writes a
 * marker. Cleanup only deletes after system uptime has reset below the value
 * in that marker, which proves the earlier process cannot still be running.
 */
async function removeLegacyLaunchDirectoriesAfterReboot(
  parentDir,
  activeLaunchId,
  {
    minimumAgeMs = LEGACY_LAUNCH_MIN_AGE_MS,
    now = Date.now,
    uptimeSeconds = systemUptime,
    isAlive = isProcessAlive,
    lstatImpl = lstat,
    openImpl = open,
    opendirImpl = opendir,
    readFileImpl,
    readdirImpl,
    renameImpl = rename,
    rmImpl = rm,
    writeFileImpl = writeFile,
  } = {},
) {
  let entries;
  try {
    ({ entries } = await readBoundedDirectory(parentDir, {
      maxEntries: MAX_LAUNCH_DIRECTORY_ENTRIES,
      opendirImpl,
      readdirImpl,
    }));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const currentTime = Number(now());
  const currentUptime = Number(uptimeSeconds());
  if (!Number.isFinite(currentTime) || !Number.isFinite(currentUptime) || currentUptime < 0) return [];

  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()
      || entry.name === activeLaunchId
      || !LAUNCH_ID_PATTERN.test(entry.name)) continue;
    const directory = path.join(parentDir, entry.name);
    const fileOptions = { lstatImpl, openImpl, readFileImpl };
    const directoryOptions = { opendirImpl, readdirImpl };

    const ownerResult = await readOwnerMetadata(directory, entry.name, null, fileOptions);
    const owner = ownerResult.owner;
    if (owner) {
      if (currentTime < owner.createdAtMs
        || currentTime - owner.createdAtMs < minimumAgeMs
        || isAlive(owner.pid)
        || await hasPendingCredentialCopyback(directory, directoryOptions)) continue;
      await rmImpl(directory, { recursive: true, force: true });
      removed.push(entry.name);
      continue;
    }
    if (ownerResult.exists) continue;

    if (await hasPendingCredentialCopyback(directory, directoryOptions)) continue;
    const cleanupRetention = await readCleanupRetentionMarker(
      directory,
      entry.name,
      fileOptions,
    );
    if (cleanupRetention.exists && !cleanupRetention.marker) continue;
    const marker = cleanupRetention.marker;

    if (marker) {
      if (currentUptime + LEGACY_REBOOT_UPTIME_TOLERANCE_SECONDS
        < marker.observedUptimeSeconds) {
        await rmImpl(directory, { recursive: true, force: true });
        removed.push(entry.name);
        continue;
      }
      // Raise the watermark while the same boot continues. If an earlier reboot
      // went unnoticed because the machine had already been up longer than the
      // first watermark, a later reboot can still prove liveness ended.
      if (currentUptime > marker.observedUptimeSeconds
        + LEGACY_REBOOT_UPTIME_TOLERANCE_SECONDS) {
        await writeLegacyCleanupMarker(directory, {
          ...marker,
          observedUptimeSeconds: currentUptime,
          observedAtMs: currentTime,
        }, { renameImpl, rmImpl, writeFileImpl });
      }
      continue;
    }

    let directoryStat;
    try {
      directoryStat = await lstatImpl(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!directoryStat.isDirectory?.()
      || !Number.isFinite(directoryStat.mtimeMs)
      || currentTime < directoryStat.mtimeMs
      || currentTime - directoryStat.mtimeMs < minimumAgeMs) continue;

    await writeLegacyCleanupMarker(directory, {
      version: 1,
      launchId: entry.name,
      observedUptimeSeconds: currentUptime,
      observedAtMs: currentTime,
      directoryMtimeMs: directoryStat.mtimeMs,
    }, { renameImpl, rmImpl, writeFileImpl });
  }
  return removed;
}

export async function prepareDevelopmentCaches(browserSession, codeCachePath) {
  await browserSession.clearCache();
  if (typeof browserSession.clearCodeCaches === 'function') {
    await browserSession.clearCodeCaches({});
  }
  browserSession.setCodeCachePath(codeCachePath);
}

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { uptime as systemUptime } from 'node:os';
import path from 'node:path';

import { retryLockedOperation } from './harness-update.mjs';

export const OAUTH_CREDENTIAL_MAX_BYTES = 1024 * 1024;
export const OAUTH_STAGING_STALE_AFTER_MS = 60 * 60 * 1000;
export const OAUTH_STAGING_OWNER_FILE = '.rauhwpx-oauth-owner.json';
export const OAUTH_STAGING_OWNER_MAX_BYTES = 1024;
const OAUTH_STAGING_SCAN_LIMIT = 256;
const OAUTH_STAGING_NAME = /^run-(\d{13})-(\d+)-/;
const REBOOT_UPTIME_TOLERANCE_SECONDS = 60;
const HARD_LINK_UNSUPPORTED_CODES = new Set([
  'EACCES',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
]);

function transactionError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function readStagingOwner(file) {
  let handle = null;
  try {
    const pathStat = await fs.lstat(file);
    if (pathStat.isSymbolicLink()) {
      throw transactionError('AGENT_AUTH_CREDENTIAL_UNSAFE', 'Unsafe OAuth owner metadata.');
    }
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0
      || stat.size > OAUTH_STAGING_OWNER_MAX_BYTES) {
      throw transactionError('AGENT_AUTH_CREDENTIAL_UNSAFE', 'Unsafe OAuth owner metadata.');
    }
    const bytes = Buffer.allocUnsafe(OAUTH_STAGING_OWNER_MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > OAUTH_STAGING_OWNER_MAX_BYTES) {
      throw transactionError('AGENT_AUTH_CREDENTIAL_UNSAFE', 'Unsafe OAuth owner metadata.');
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    } catch {
      throw transactionError('AGENT_AUTH_CREDENTIAL_UNSAFE', 'Unsafe OAuth owner metadata.');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw transactionError('AGENT_AUTH_CREDENTIAL_UNSAFE', 'Unsafe OAuth owner metadata.');
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Remove private OAuth profiles left by a crashed app, but only after their
 * bounded login lifetime and only when the recorded owner PID is no longer
 * alive. PID reuse therefore delays cleanup instead of risking an active run.
 */
export async function cleanupStaleOAuthCredentialStaging(stagingParent, {
  now = Date.now,
  staleAfterMs = OAUTH_STAGING_STALE_AFTER_MS,
  isProcessAlive = processIsAlive,
  uptimeSeconds = systemUptime,
} = {}) {
  if (typeof stagingParent !== 'string' || !stagingParent) return 0;
  let directory;
  try {
    directory = await fs.opendir(stagingParent);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }

  let removed = 0;
  let scanned = 0;
  try {
    for await (const entry of directory) {
      scanned += 1;
      if (scanned > OAUTH_STAGING_SCAN_LIMIT) break;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const match = OAUTH_STAGING_NAME.exec(entry.name);
      if (!match) continue;
      const createdAt = Number(match[1]);
      const ownerPid = Number(match[2]);
      if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) continue;
      if (now() - createdAt < staleAfterMs) continue;
      if (isProcessAlive(ownerPid)) continue;
      const candidate = path.join(stagingParent, entry.name);
      const ownerFile = path.join(candidate, OAUTH_STAGING_OWNER_FILE);
      let owner = null;
      try {
        owner = await readStagingOwner(ownerFile);
      } catch (error) {
        if (error?.code !== 'ENOENT') continue;
        // A legacy/crash window without metadata is observed but never deleted
        // in the same boot. A later uptime reset can prove every old descendant
        // is gone before cleanup.
        const observedUptimeSeconds = Number(uptimeSeconds());
        if (!Number.isFinite(observedUptimeSeconds) || observedUptimeSeconds < 0) continue;
        await fs.writeFile(ownerFile, `${JSON.stringify({
          version: 1,
          createdAt,
          ownerPid,
          observedUptimeSeconds,
        })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }).catch(() => {});
        continue;
      }
      if (
        owner?.version !== 1
        || owner.createdAt !== createdAt
        || owner.ownerPid !== ownerPid
        || !Number.isFinite(owner.observedUptimeSeconds)
        || owner.observedUptimeSeconds < 0
      ) continue;
      const currentUptime = Number(uptimeSeconds());
      if (!Number.isFinite(currentUptime) || currentUptime < 0) continue;
      if (currentUptime + REBOOT_UPTIME_TOLERANCE_SECONDS >= owner.observedUptimeSeconds) continue;
      await fs.rm(candidate, { recursive: true, force: true });
      removed += 1;
    }
  } finally {
    await directory.close().catch(() => {});
  }
  return removed;
}

async function readCredentialSnapshot(file, { allowAbsent = true } = {}) {
  let handle = null;
  try {
    const pathStat = await fs.lstat(file);
    if (pathStat.isSymbolicLink()) {
      throw transactionError(
        'AGENT_AUTH_CREDENTIAL_UNSAFE',
        `OAuth credential is not a plain file: ${file}`,
      );
    }
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0
      || stat.size > OAUTH_CREDENTIAL_MAX_BYTES) {
      throw transactionError(
        'AGENT_AUTH_CREDENTIAL_UNSAFE',
        `OAuth credential exceeds its ${OAUTH_CREDENTIAL_MAX_BYTES}-byte plain-file limit: ${file}`,
      );
    }

    const buffer = Buffer.allocUnsafe(OAUTH_CREDENTIAL_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > OAUTH_CREDENTIAL_MAX_BYTES) {
      throw transactionError(
        'AGENT_AUTH_CREDENTIAL_UNSAFE',
        `OAuth credential grew beyond ${OAUTH_CREDENTIAL_MAX_BYTES} bytes: ${file}`,
      );
    }
    const bytes = Buffer.from(buffer.subarray(0, offset));
    return Object.freeze({
      state: 'file',
      bytes,
      digest: digest(bytes),
      mode: stat.mode & 0o777,
    });
  } catch (error) {
    if (error?.code === 'ENOENT' && allowAbsent) {
      return Object.freeze({ state: 'absent', bytes: null, digest: null, mode: 0o600 });
    }
    if (error?.code?.startsWith?.('AGENT_AUTH_')) throw error;
    throw transactionError(
      'AGENT_AUTH_CREDENTIAL_UNSAFE',
      `OAuth credential could not be read safely: ${file}`,
      error,
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

function snapshotsMatch(left, right) {
  return left.state === right.state
    && (left.state === 'absent' || left.digest === right.digest);
}

function concurrentCredentialError(file) {
  return transactionError(
    'AGENT_AUTH_CREDENTIAL_CONFLICT',
    `OAuth credential changed concurrently and was not overwritten: ${file}`,
  );
}

async function writeTemporary(target, bytes, mode) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.oauth-${process.pid}-${randomUUID()}.new`;
  let handle = null;
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    return temporary;
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function removeLocked(file, platform) {
  await retryLockedOperation(() => fs.rm(file, { force: true }), { platform });
}

async function restoreHeldSourceIfAbsent(heldFile, source, platform, publishExclusive) {
  try {
    await publishExclusive(heldFile, source);
    await removeLocked(heldFile, platform);
    return;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      // A concurrent writer recreated the credential after it was moved aside.
      // Its value wins; the superseded held value must not replace it.
      await removeLocked(heldFile, platform);
      return;
    }
    const recoveryError = transactionError(
      'AGENT_AUTH_CREDENTIAL_RECOVERY_REQUIRED',
      `OAuth credential could not be restored safely; recovery copy retained at ${heldFile}`,
      error,
    );
    recoveryError.recoveryFile = heldFile;
    throw recoveryError;
  }
}

/**
 * Atomically removes an expected file from the publication name and verifies
 * the exact inode contents after the rename. Publication can then use a hard
 * link as create-if-absent CAS, so a concurrent creator is never overwritten.
 */
async function takeExpectedSource(source, expected, platform, publishExclusive, retainedFile = null) {
  const heldFile = retainedFile ?? `${source}.oauth-${process.pid}-${randomUUID()}.held`;
  try {
    await retryLockedOperation(() => fs.rename(source, heldFile), { platform });
  } catch (error) {
    if (error?.code === 'ENOENT') throw concurrentCredentialError(source);
    throw error;
  }

  try {
    const held = await readCredentialSnapshot(heldFile, { allowAbsent: false });
    if (!snapshotsMatch(held, expected)) {
      await restoreHeldSourceIfAbsent(heldFile, source, platform, publishExclusive);
      throw concurrentCredentialError(source);
    }
    return heldFile;
  } catch (error) {
    if (error?.code === 'AGENT_AUTH_CREDENTIAL_CONFLICT') throw error;
    try {
      await restoreHeldSourceIfAbsent(heldFile, source, platform, publishExclusive);
    } catch (restoreError) {
      throw transactionError(
        'AGENT_AUTH_CREDENTIAL_RECOVERY_REQUIRED',
        `OAuth credential verification failed and its recovery copy could not be restored: ${heldFile}`,
        new AggregateError([error, restoreError]),
      );
    }
    throw error;
  }
}

const OAUTH_RECOVERY_BACKUP_SUFFIX = /^\.oauth-[1-9]\d*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.held$/i;

/** Recovery may only touch the exact sibling name generated by this module. */
export function isValidOAuthRecoveryBackupPath(
  sourceFile,
  backupFile,
  platform = process.platform,
) {
  if (typeof sourceFile !== 'string' || !sourceFile
    || typeof backupFile !== 'string' || !backupFile) return false;
  const pathApi = platform === 'win32' ? path.win32 : path;
  if (!pathApi.isAbsolute(sourceFile) || !pathApi.isAbsolute(backupFile)) return false;
  const source = pathApi.resolve(sourceFile);
  const backup = pathApi.resolve(backupFile);
  const comparable = (value) => platform === 'win32' ? value.toLowerCase() : value;
  if (comparable(pathApi.dirname(source)) !== comparable(pathApi.dirname(backup))) return false;
  const sourceName = pathApi.basename(source);
  const backupName = pathApi.basename(backup);
  if (!comparable(backupName).startsWith(comparable(sourceName))) return false;
  return OAUTH_RECOVERY_BACKUP_SUFFIX.test(backupName.slice(sourceName.length));
}

function validateRecoveryRecord(record, platform) {
  const digestPattern = /^[0-9a-f]{64}$/;
  const pathApi = platform === 'win32' ? path.win32 : path;
  if (
    !record
    || record.version !== 1
    || typeof record.sourceFile !== 'string'
    || !record.sourceFile
    || !pathApi.isAbsolute(record.sourceFile)
    || (record.initialState !== 'absent' && record.initialState !== 'file')
    || (record.initialState === 'file' && !digestPattern.test(record.initialDigest))
    || (record.initialState === 'absent' && record.initialDigest !== null)
    || !digestPattern.test(record.publishedDigest)
    || (record.initialState === 'file'
      && !isValidOAuthRecoveryBackupPath(record.sourceFile, record.backupFile, platform))
    || (record.initialState === 'absent' && record.backupFile !== null)
  ) {
    throw transactionError('AGENT_AUTH_CREDENTIAL_RECOVERY_REQUIRED', 'OAuth credential recovery metadata is invalid.');
  }
  return record;
}

/**
 * Finish or roll back a publication described only by digests and a retained
 * credential file. The record contains paths and hashes, never credential bytes.
 */
export async function recoverOAuthCredentialPublication(record, {
  commit = false,
  platform = process.platform,
  linkImpl = fs.link,
  copyFileImpl = fs.copyFile,
} = {}) {
  const recovery = validateRecoveryRecord(record, platform);
  const current = await readCredentialSnapshot(recovery.sourceFile);
  const currentIsPublished = current.state === 'file' && current.digest === recovery.publishedDigest;
  const currentIsInitial = recovery.initialState === 'absent'
    ? current.state === 'absent'
    : current.state === 'file' && current.digest === recovery.initialDigest;

  if (commit) {
    if (!currentIsPublished) throw concurrentCredentialError(recovery.sourceFile);
    if (recovery.backupFile) {
      const backup = await readCredentialSnapshot(recovery.backupFile);
      if (backup.state === 'file') {
        await removeLocked(recovery.backupFile, platform);
      }
    }
    return 'committed';
  }

  if (currentIsInitial) {
    if (recovery.backupFile) {
      const backup = await readCredentialSnapshot(recovery.backupFile);
      if (backup.state === 'file') {
        await removeLocked(recovery.backupFile, platform);
      }
    }
    return 'rolled-back';
  }

  if (recovery.initialState === 'file') {
    const backup = await readCredentialSnapshot(recovery.backupFile, { allowAbsent: false });
    if (backup.digest !== recovery.initialDigest) {
      throw transactionError(
        'AGENT_AUTH_CREDENTIAL_RECOVERY_REQUIRED',
        'OAuth credential recovery copy does not match its recorded hash.',
      );
    }
    if (current.state === 'absent') {
      const publishExclusive = await createExclusivePublisher(
        recovery.backupFile,
        recovery.sourceFile,
        platform,
        { linkImpl, copyFileImpl },
      );
      await publishExclusive(recovery.backupFile, recovery.sourceFile);
      const restored = await readCredentialSnapshot(recovery.sourceFile, { allowAbsent: false });
      if (restored.digest !== recovery.initialDigest) {
        throw transactionError(
          'AGENT_AUTH_CREDENTIAL_ROLLBACK_FAILED',
          `OAuth credential rollback did not verify: ${recovery.sourceFile}`,
        );
      }
      await removeLocked(recovery.backupFile, platform);
      return 'rolled-back';
    }
  }
  if (!currentIsPublished) throw concurrentCredentialError(recovery.sourceFile);

  if (recovery.initialState === 'absent') {
    const publishExclusive = await createExclusivePublisher(
      recovery.sourceFile,
      recovery.sourceFile,
      platform,
      { linkImpl, copyFileImpl },
    );
    const publishedCopy = await takeExpectedSource(
      recovery.sourceFile,
      current,
      platform,
      publishExclusive,
    );
    await removeLocked(publishedCopy, platform);
  } else {
    const publishExclusive = await createExclusivePublisher(
      recovery.backupFile,
      recovery.sourceFile,
      platform,
      { linkImpl, copyFileImpl },
    );
    const publishedCopy = await takeExpectedSource(
      recovery.sourceFile,
      current,
      platform,
      publishExclusive,
    );
    try {
      await publishExclusive(recovery.backupFile, recovery.sourceFile);
      const restored = await readCredentialSnapshot(recovery.sourceFile, { allowAbsent: false });
      if (restored.digest !== recovery.initialDigest) {
        throw transactionError(
          'AGENT_AUTH_CREDENTIAL_ROLLBACK_FAILED',
          `OAuth credential rollback did not verify: ${recovery.sourceFile}`,
        );
      }
      await removeLocked(publishedCopy, platform);
      await removeLocked(recovery.backupFile, platform);
    } catch (error) {
      await restoreHeldSourceIfAbsent(publishedCopy, recovery.sourceFile, platform, publishExclusive)
        .catch(() => {});
      throw error;
    }
  }
  return 'rolled-back';
}

async function createExclusivePublisher(
  candidate,
  source,
  platform,
  {
    linkImpl = fs.link,
    copyFileImpl = fs.copyFile,
  } = {},
) {
  const probe = `${source}.oauth-${process.pid}-${randomUUID()}.probe`;
  let preferHardLink = true;
  try {
    try {
      await linkImpl(candidate, probe);
    } catch (error) {
      if (!HARD_LINK_UNSUPPORTED_CODES.has(error?.code)) throw error;
      preferHardLink = false;
      await retryLockedOperation(
        () => copyFileImpl(candidate, probe, fsConstants.COPYFILE_EXCL),
        { platform },
      );
      const [candidateSnapshot, probeSnapshot] = await Promise.all([
        readCredentialSnapshot(candidate, { allowAbsent: false }),
        readCredentialSnapshot(probe, { allowAbsent: false }),
      ]);
      if (!snapshotsMatch(candidateSnapshot, probeSnapshot)) {
        throw transactionError(
          'AGENT_AUTH_CREDENTIAL_UNSAFE',
          `OAuth credential filesystem copy probe did not verify: ${source}`,
        );
      }
    }
  } finally {
    await removeLocked(probe, platform);
  }

  return async (from, target) => {
    try {
      if (preferHardLink) {
        try {
          await linkImpl(from, target);
          return;
        } catch (error) {
          if (!HARD_LINK_UNSUPPORTED_CODES.has(error?.code)) throw error;
        }
      }
      await retryLockedOperation(
        () => copyFileImpl(from, target, fsConstants.COPYFILE_EXCL),
        { platform },
      );
      const [fromSnapshot, targetSnapshot] = await Promise.all([
        readCredentialSnapshot(from, { allowAbsent: false }),
        readCredentialSnapshot(target, { allowAbsent: false }),
      ]);
      if (!snapshotsMatch(fromSnapshot, targetSnapshot)) {
        throw transactionError(
          'AGENT_AUTH_CREDENTIAL_UNSAFE',
          `OAuth credential publication copy did not verify: ${target}`,
        );
      }
    } catch (error) {
      if (error?.code === 'EEXIST') throw concurrentCredentialError(target);
      throw error;
    }
  };
}

function assertCredentialJson(snapshot, file) {
  let parsed;
  try {
    parsed = JSON.parse(snapshot.bytes.toString('utf8'));
  } catch {
    // Recent JSON.parse errors can quote the invalid source. Credential bytes
    // must never enter an error cause or diagnostic chain.
    throw transactionError(
      'AGENT_AUTH_CREDENTIAL_INVALID',
      `OAuth login produced an invalid credential file: ${file}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw transactionError(
      'AGENT_AUTH_CREDENTIAL_INVALID',
      `OAuth login produced an invalid credential object: ${file}`,
    );
  }
}

/**
 * Creates a private profile for an OAuth child and a compare-and-swap
 * transaction for its one authored credential. The source may explicitly be
 * absent; a concurrent creator/change always wins instead of being overwritten.
 */
export async function prepareStagedOAuthCredential({
  sourceFile,
  stagingParent,
  relativeCredentialPath = path.join('.cursor', 'cli-config.json'),
  platform = process.platform,
  linkImpl = fs.link,
  copyFileImpl = fs.copyFile,
} = {}) {
  if (typeof sourceFile !== 'string' || !sourceFile) throw new TypeError('sourceFile is required.');
  if (typeof stagingParent !== 'string' || !stagingParent) throw new TypeError('stagingParent is required.');

  const source = path.resolve(sourceFile);
  const initial = await readCredentialSnapshot(source);
  await fs.mkdir(stagingParent, { recursive: true, mode: 0o700 });
  await cleanupStaleOAuthCredentialStaging(stagingParent).catch(() => {});
  const homeDir = await fs.mkdtemp(
    path.join(stagingParent, `run-${Date.now()}-${process.pid}-`),
  );
  await fs.chmod(homeDir, 0o700).catch(() => {});
  try {
    await fs.writeFile(path.join(homeDir, OAUTH_STAGING_OWNER_FILE), `${JSON.stringify({
      version: 1,
      createdAt: Number(OAUTH_STAGING_NAME.exec(path.basename(homeDir))?.[1]),
      ownerPid: process.pid,
      observedUptimeSeconds: systemUptime(),
    })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const credentialFile = path.join(homeDir, relativeCredentialPath);
  const configDir = path.dirname(credentialFile);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  if (initial.state === 'file') {
    await fs.writeFile(credentialFile, initial.bytes, { mode: 0o600 });
  }

  let published = null;
  let prepared = null;
  const retainedInitialFile = initial.state === 'file'
    ? `${source}.oauth-${process.pid}-${randomUUID()}.held`
    : null;
  let committed = false;
  let cleaned = false;

  async function assertSourceUnchanged(expected) {
    const current = await readCredentialSnapshot(source);
    if (!snapshotsMatch(current, expected)) throw concurrentCredentialError(source);
    return current;
  }

  async function cleanup() {
    if (cleaned) return;
    await fs.rm(homeDir, { recursive: true, force: true });
    cleaned = true;
  }

  async function prepareRecovery() {
    if (prepared) return prepared;
    const staged = await readCredentialSnapshot(credentialFile, { allowAbsent: false });
    assertCredentialJson(staged, credentialFile);
    prepared = Object.freeze({
      version: 1,
      sourceFile: source,
      initialState: initial.state,
      initialDigest: initial.digest,
      publishedDigest: staged.digest,
      backupFile: retainedInitialFile,
    });
    return prepared;
  }

  return Object.freeze({
    sourceFile: source,
    homeDir,
    configDir,
    credentialFile,
    initialState: initial.state,

    async prepareRecovery() {
      return prepareRecovery();
    },

    async publish() {
      if (committed) throw transactionError('AGENT_AUTH_CREDENTIAL_STATE', 'Credential is already committed.');
      if (published) return;
      const recovery = await prepareRecovery();
      const staged = await readCredentialSnapshot(credentialFile, { allowAbsent: false });
      assertCredentialJson(staged, credentialFile);
      if (staged.digest !== recovery.publishedDigest) {
        throw transactionError(
          'AGENT_AUTH_CREDENTIAL_CONFLICT',
          'Staged OAuth credential changed after recovery was prepared.',
        );
      }
      await assertSourceUnchanged(initial);
      const temporary = await writeTemporary(source, staged.bytes, 0o600);
      let heldFile = null;
      try {
        // Prove that this filesystem supports at least one create-if-absent
        // publication primitive before an existing credential is moved aside.
        // FAT/exFAT, redirected profiles, and some network filesystems reject
        // hard links, so a verified exclusive copy is the bounded fallback.
        const publishExclusive = await createExclusivePublisher(temporary, source, platform, {
          linkImpl,
          copyFileImpl,
        });
        // Existing credentials are first moved to a unique name and verified
        // there. Publication is create-if-absent for both initially absent and
        // existing sources; it never replaces a path another process created.
        if (initial.state === 'file') {
          heldFile = await takeExpectedSource(
            source,
            initial,
            platform,
            publishExclusive,
            retainedInitialFile,
          );
        }
        await publishExclusive(temporary, source);
        const installed = await readCredentialSnapshot(source, { allowAbsent: false });
        if (!snapshotsMatch(installed, staged)) {
          throw transactionError(
            'AGENT_AUTH_CREDENTIAL_PUBLISH_FAILED',
            `Published OAuth credential did not verify: ${source}`,
          );
        }
        published = staged;
        heldFile = null;
      } catch (error) {
        if (heldFile) {
          try {
            const publishExclusive = await createExclusivePublisher(heldFile, source, platform, {
              linkImpl,
              copyFileImpl,
            });
            await restoreHeldSourceIfAbsent(heldFile, source, platform, publishExclusive);
          } catch (restoreError) {
            throw transactionError(
              'AGENT_AUTH_CREDENTIAL_RECOVERY_REQUIRED',
              `OAuth credential publication failed and the previous credential requires recovery: ${heldFile}`,
              new AggregateError([error, restoreError]),
            );
          }
        }
        throw error;
      } finally {
        await removeLocked(temporary, platform).catch(() => {});
      }
    },

    async rollback() {
      if (committed) return;
      if (!published) {
        await cleanup();
        return;
      }
      await assertSourceUnchanged(published);
      await recoverOAuthCredentialPublication(await prepareRecovery(), {
        commit: false,
        platform,
        linkImpl,
        copyFileImpl,
      });
      published = null;
      await cleanup();
    },

    async cleanup() {
      await cleanup();
    },

    markCommitted() {
      committed = true;
    },

    async finalizeCommit() {
      if (!published) {
        throw transactionError('AGENT_AUTH_CREDENTIAL_STATE', 'Credential has not been published.');
      }
      await recoverOAuthCredentialPublication(await prepareRecovery(), {
        commit: true,
        platform,
        linkImpl,
        copyFileImpl,
      });
      committed = true;
    },
  });
}

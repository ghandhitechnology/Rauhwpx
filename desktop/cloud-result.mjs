import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { cloudConflictPath } from './cloud-handoff.mjs';
import { replaceFile as replaceFileWindowsSafe } from './fs-replace.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exclusiveCopy(bytes, requestedPath) {
  const parsed = path.parse(requestedPath);
  const digest = sha256(bytes);
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0
      ? requestedPath
      : path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
    try {
      await fs.writeFile(candidate, bytes, { flag: 'wx', mode: 0o600 });
      const verified = await fs.readFile(candidate);
      if (verified.length !== bytes.length || sha256(verified) !== sha256(bytes)) {
        await fs.rm(candidate, { force: true });
        throw new Error('Preserved cloud result failed verification');
      }
      return candidate;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await fs.readFile(candidate).catch((readError) => {
        if (readError?.code === 'ENOENT') return null;
        throw readError;
      });
      if (existing && existing.length === bytes.length && sha256(existing) === digest) return candidate;
    }
  }
  throw new Error('Could not find an unused name for the cloud result');
}

async function replaceFile(targetPath, bytes, platform) {
  const temp = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.cloud-${randomUUID()}.tmp`);
  const originalMode = await fs.stat(targetPath).then((details) => details.mode & 0o777, () => null);
  await fs.writeFile(temp, bytes, { mode: 0o600 });
  const verified = await fs.readFile(temp);
  if (verified.length !== bytes.length || sha256(verified) !== sha256(bytes)) {
    await fs.rm(temp, { force: true });
    throw new Error('Replacement file failed verification');
  }
  if (platform !== 'win32') {
    await fs.rename(temp, targetPath);
    if (originalMode !== null) await fs.chmod(targetPath, originalMode);
    return;
  }
  await replaceFileWindowsSafe(temp, targetPath, platform);
}

export async function applyCloudRecovery({
  recoveryPath,
  resultDigest,
  originalPath,
  originalDigest,
  action,
  resolutionId = null,
  platform = process.platform,
  now = new Date(),
}) {
  if (!['replace', 'keep-both', 'discard'].includes(action)) throw new Error('Invalid cloud result action');
  if (action === 'discard') {
    return { action: 'discard', path: null, bytes: null, conflict: false };
  }
  const bytes = await fs.readFile(recoveryPath);
  if (!bytes.length || sha256(bytes) !== resultDigest) throw new Error('Cloud recovery file is missing or corrupt');
  if (!originalPath) throw new Error('Open the origin document before resolving this cloud result');

  let effectiveAction = action;
  let conflict = false;
  let alreadyApplied = false;
  if (action === 'replace') {
    const original = await fs.readFile(originalPath).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    const currentDigest = original ? sha256(original) : null;
    if (currentDigest === resultDigest) {
      alreadyApplied = true;
    } else if (!original || currentDigest !== originalDigest) {
      effectiveAction = 'keep-both';
      conflict = true;
    }
  }

  let destination;
  if (effectiveAction === 'replace') {
    if (!alreadyApplied) await replaceFile(originalPath, bytes, platform);
    destination = originalPath;
  } else {
    let requestedPath = cloudConflictPath(originalPath, now);
    if (typeof resolutionId === 'string' && resolutionId) {
      const parsed = path.parse(originalPath);
      const stableSuffix = sha256(Buffer.from(resolutionId)).slice(0, 16);
      requestedPath = path.join(parsed.dir, `${parsed.name}.cloud-${stableSuffix}${parsed.ext}`);
    }
    destination = await exclusiveCopy(bytes, requestedPath);
  }
  const written = await fs.readFile(destination);
  if (written.length !== bytes.length || sha256(written) !== resultDigest) {
    throw new Error('Resolved cloud result failed final verification');
  }
  return {
    action: effectiveAction,
    path: destination,
    bytes: new Uint8Array(written),
    conflict,
  };
}

export const __test = { exclusiveCopy, replaceFile, sha256, fsConstants };

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { rauCreditsUrl } from '../rhwp/rhwp-agent/rau-credits-client.mjs';

export const UNIQUE_INSTALL_FILE = 'unique-install.json';
export const UNIQUE_INSTALLS_JSON_PATH = '/v1/unique-installs';
export const UNIQUE_INSTALLS_PAGE_PATH = '/unique-installs';
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_TIMEOUT_MS = 8_000;

export function uniqueInstallStatePath(userDataDir) {
  return join(String(userDataDir), UNIQUE_INSTALL_FILE);
}

export function uniqueInstallsPublicUrl(baseUrl = rauCreditsUrl()) {
  return `${String(baseUrl).replace(/\/$/, '')}${UNIQUE_INSTALLS_PAGE_PATH}`;
}

export function uniqueInstallsJsonUrl(baseUrl = rauCreditsUrl()) {
  return `${String(baseUrl).replace(/\/$/, '')}${UNIQUE_INSTALLS_JSON_PATH}`;
}

export function shouldPingUniqueInstall({ packaged = false, devUrl = null } = {}) {
  return packaged === true && !devUrl;
}

function emptySnapshot(baseUrl) {
  return {
    uniqueInstalls: null,
    publicUrl: uniqueInstallsPublicUrl(baseUrl),
    recorded: false,
  };
}

function parsedState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const installId = typeof raw.installId === 'string' ? raw.installId.trim().toLowerCase() : '';
  if (!INSTALL_ID_RE.test(installId)) return null;
  return {
    installId,
    recorded: raw.recorded === true,
    recordedAt: typeof raw.recordedAt === 'string' ? raw.recordedAt : null,
  };
}

export async function loadOrCreateUniqueInstallState(filePath, {
  readFileImpl = readFile,
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  renameImpl = rename,
  rmImpl = rm,
  randomUUIDImpl = randomUUID,
} = {}) {
  try {
    const parsed = parsedState(JSON.parse(await readFileImpl(filePath, 'utf8')));
    if (parsed) return parsed;
    throw Object.assign(new Error('unique install state is unreadable'), {
      code: 'UNIQUE_INSTALL_STATE_UNREADABLE',
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // A missing file is the first launch on this userData path.
    } else if (error?.code === 'UNIQUE_INSTALL_STATE_UNREADABLE') {
      throw error;
    } else {
      throw Object.assign(new Error('unique install state is unreadable'), {
        code: 'UNIQUE_INSTALL_STATE_UNREADABLE',
        cause: error,
      });
    }
  }
  const created = {
    installId: randomUUIDImpl(),
    recorded: false,
    recordedAt: null,
  };
  await writeUniqueInstallState(filePath, created, {
    mkdirImpl,
    writeFileImpl,
    renameImpl,
    rmImpl,
  });
  return created;
}

export async function writeUniqueInstallState(filePath, state, {
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  renameImpl = rename,
  rmImpl = rm,
} = {}) {
  const directory = dirname(filePath);
  await mkdirImpl(directory, { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFileImpl(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await renameImpl(temp, filePath);
  } catch (error) {
    await rmImpl(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function snapshotFromBody(body, baseUrl, recorded) {
  const uniqueInstalls = Number.isSafeInteger(body?.uniqueInstalls) && body.uniqueInstalls >= 0
    ? body.uniqueInstalls
    : null;
  return {
    uniqueInstalls,
    publicUrl: uniqueInstallsPublicUrl(baseUrl),
    recorded,
  };
}

/**
 * First successful packaged launch pings once per machine. Fail closed: the
 * caller must ignore rejection and still finish launching the app.
 */
export async function reportUniqueInstall({
  userDataDir,
  packaged = false,
  devUrl = null,
  appVersion,
  os,
  arch,
  baseUrl = rauCreditsUrl(),
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  readFileImpl = readFile,
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  renameImpl = rename,
  rmImpl = rm,
  randomUUIDImpl = randomUUID,
  now = Date.now,
} = {}) {
  const origin = String(baseUrl).replace(/\/$/, '');
  const snapshot = emptySnapshot(origin);
  try {
    return await reportUniqueInstallInner({
      userDataDir,
      packaged,
      devUrl,
      appVersion,
      os,
      arch,
      origin,
      snapshot,
      fetchImpl,
      timeoutMs,
      readFileImpl,
      mkdirImpl,
      writeFileImpl,
      renameImpl,
      rmImpl,
      randomUUIDImpl,
      now,
    });
  } catch {
    return snapshot;
  }
}

async function reportUniqueInstallInner({
  userDataDir,
  packaged,
  devUrl,
  appVersion,
  os,
  arch,
  origin,
  snapshot,
  fetchImpl,
  timeoutMs,
  readFileImpl,
  mkdirImpl,
  writeFileImpl,
  renameImpl,
  rmImpl,
  randomUUIDImpl,
  now,
}) {
  if (!shouldPingUniqueInstall({ packaged, devUrl })) return snapshot;

  let state = null;
  try {
    state = await loadOrCreateUniqueInstallState(uniqueInstallStatePath(userDataDir), {
      readFileImpl,
      mkdirImpl,
      writeFileImpl,
      renameImpl,
      rmImpl,
      randomUUIDImpl,
    });
  } catch (error) {
    if (error?.code !== 'UNIQUE_INSTALL_STATE_UNREADABLE') throw error;
  }

  try {
    const read = await readJson(
      fetchImpl,
      uniqueInstallsJsonUrl(origin),
      { method: 'GET', headers: { Accept: 'application/json' } },
      timeoutMs,
    );
    if (read.ok) Object.assign(snapshot, snapshotFromBody(read.body, origin, state?.recorded === true));
  } catch {
    // Display is best-effort. Launch must not wait on a healthy counter.
  }

  if (!state || state.recorded) {
    snapshot.recorded = state?.recorded === true;
    return snapshot;
  }

  try {
    const posted = await readJson(
      fetchImpl,
      uniqueInstallsJsonUrl(origin),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          installId: state.installId,
          appVersion,
          os,
          arch,
        }),
      },
      timeoutMs,
    );
    if (!posted.ok) return snapshot;
    const recorded = {
      installId: state.installId,
      recorded: true,
      recordedAt: new Date(now()).toISOString(),
    };
    await writeUniqueInstallState(uniqueInstallStatePath(userDataDir), recorded, {
      mkdirImpl,
      writeFileImpl,
      renameImpl,
      rmImpl,
    });
    return snapshotFromBody(posted.body, origin, true);
  } catch {
    return snapshot;
  }
}

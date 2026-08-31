import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { createMemoryStore } from './store.mjs';

/** Shared with the packaged desktop client. Railway may override via RAU_UNIQUE_INSTALL_PING_KEY. */
export const DEFAULT_UNIQUE_INSTALL_PING_KEY = 'rau.unique-install.v1.desktop-first-launch';

const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_APP_VERSION_BYTES = 32;
const MAX_OS_BYTES = 32;
const MAX_ARCH_BYTES = 16;
const ALLOWED_OS = new Set(['darwin', 'win32', 'linux']);
const ALLOWED_ARCH = new Set(['arm64', 'x64', 'ia32', 'arm']);

function uniqueInstallsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedToken(value, maxBytes) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxBytes
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

export function emptyUniqueInstallsState() {
  return { installs: {} };
}

export function uniqueInstallDigest(installId) {
  return createHash('sha256').update(String(installId), 'utf8').digest('hex');
}

export function createUniqueInstallProof(ping, key = DEFAULT_UNIQUE_INSTALL_PING_KEY) {
  return createHmac('sha256', String(key)).update(
    `${ping.installId}\n${ping.appVersion}\n${ping.os}\n${ping.arch}`,
    'utf8',
  ).digest('hex');
}

function uniqueInstallProofMatches(proof, ping, key) {
  const expected = createUniqueInstallProof(ping, key);
  try {
    const left = Buffer.from(String(proof), 'hex');
    const right = Buffer.from(expected, 'hex');
    return left.length === 32 && left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function isOfficialDesktopPlatform(os, arch) {
  return (os === 'darwin' && arch === 'arm64') || (os === 'win32' && arch === 'x64');
}

export function countOfficialUniqueInstalls(state) {
  const installs = state?.installs && typeof state.installs === 'object' ? state.installs : {};
  let count = 0;
  for (const entry of Object.values(installs)) {
    if (entry?.official === true) count += 1;
  }
  return count;
}

export function parseUniqueInstallPing(body, pingKey = DEFAULT_UNIQUE_INSTALL_PING_KEY) {
  const installId = typeof body?.installId === 'string' ? body.installId.trim().toLowerCase() : '';
  if (!INSTALL_ID_RE.test(installId)) {
    throw uniqueInstallsError('UNIQUE_INSTALL_ID_INVALID', '설치 식별자가 올바르지 않아요');
  }
  const appVersion = typeof body?.appVersion === 'string' ? body.appVersion.trim() : '';
  const os = typeof body?.os === 'string' ? body.os.trim() : '';
  const arch = typeof body?.arch === 'string' ? body.arch.trim() : '';
  if (!boundedToken(appVersion, MAX_APP_VERSION_BYTES) || !/^[A-Za-z0-9._+-]+$/.test(appVersion)) {
    throw uniqueInstallsError('UNIQUE_INSTALL_PAYLOAD_INVALID', '앱 버전 정보가 올바르지 않아요');
  }
  if (!boundedToken(os, MAX_OS_BYTES) || !ALLOWED_OS.has(os)) {
    throw uniqueInstallsError('UNIQUE_INSTALL_PAYLOAD_INVALID', 'OS 정보가 올바르지 않아요');
  }
  if (!boundedToken(arch, MAX_ARCH_BYTES) || !ALLOWED_ARCH.has(arch)) {
    throw uniqueInstallsError('UNIQUE_INSTALL_PAYLOAD_INVALID', '아키텍처 정보가 올바르지 않아요');
  }
  const ping = { installId, appVersion, os, arch };
  const proof = typeof body?.proof === 'string' ? body.proof.trim().toLowerCase() : '';
  if (!uniqueInstallProofMatches(proof, ping, pingKey)) {
    throw uniqueInstallsError('UNIQUE_INSTALL_PROOF_INVALID', '설치 확인 값이 올바르지 않아요');
  }
  return ping;
}

export function createUniqueInstallsService({
  store = createMemoryStore(emptyUniqueInstallsState()),
  now = Date.now,
  pingKey = DEFAULT_UNIQUE_INSTALL_PING_KEY,
} = {}) {
  let mutation = Promise.resolve();

  function withLock(fn) {
    const result = mutation.then(fn, fn);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  async function summary() {
    const state = await store.load();
    return { uniqueInstalls: countOfficialUniqueInstalls(state) };
  }

  async function record(body) {
    const ping = parseUniqueInstallPing(body, pingKey);
    return withLock(async () => {
      const state = await store.load();
      if (!state.installs || typeof state.installs !== 'object' || Array.isArray(state.installs)) {
        state.installs = {};
      }
      const digest = uniqueInstallDigest(ping.installId);
      const existing = state.installs[digest];
      if (existing) {
        return {
          uniqueInstalls: countOfficialUniqueInstalls(state),
          created: false,
          official: existing.official === true,
        };
      }
      state.installs[digest] = {
        official: isOfficialDesktopPlatform(ping.os, ping.arch),
        firstSeenAt: new Date(now()).toISOString(),
        appVersion: ping.appVersion,
        os: ping.os,
        arch: ping.arch,
      };
      try {
        await store.save(state);
      } catch (error) {
        if (error?.code === 'RAU_CREDITS_STORE_TOO_LARGE') {
          throw uniqueInstallsError(
            'UNIQUE_INSTALLS_CAPACITY_EXCEEDED',
            '고유 설치 저장 공간이 가득 찼어요',
          );
        }
        throw error;
      }
      return {
        uniqueInstalls: countOfficialUniqueInstalls(state),
        created: true,
        official: state.installs[digest].official,
      };
    });
  }

  return { summary, record };
}

import type {
  CloudCommandRequest,
  CloudFollowupAttachment,
  CloudDisplayInputEvent,
  CloudProfileDraft,
  CloudSessionScope,
  CloudTransferReference,
  CloudTransferRequest,
} from './types.ts';
import { createBrowserDisplayManager } from './browser-display.ts';
import type { CloudDisplayConnectionOptions } from './display-connection.ts';
import {
  base64Url,
  boundedResponseBytes,
  parseSse,
  sha256,
  utf8,
  verifyResponseProof,
  verifySseFrame,
} from './browser-protocol.ts';

const PROFILE_KEY = 'rauhwpx.cloud.browser.profile.v1';
const TOKENS_KEY = 'rauhwpx.cloud.browser.tokens.v1';
const CREDENTIALS_KEY = 'rauhwpx.cloud.browser.credentials.v2';
const CREDENTIALS_LOCK = 'rauhwpx.cloud.browser.credentials';
const MODE_KEY = 'rauhwpx.cloud.browser.mode.v1';
const ORIGIN_SYNC_KEY_PREFIX = 'rauhwpx.cloud.browser.origin-sync.v1.';
const TAKEOVER_COMPLETE_KEY_PREFIX = 'rauhwpx.cloud.browser.takeover-complete.v1.';
const ARCHIVE_DATABASE = 'rauhwpx-cloud-browser-archives';
const SSE_PROTOCOL = 'rauhwpx-sse-v1';
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_TIMELINE_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const COMMAND_TYPES: Record<CloudCommandRequest['command'], string> = {
  pause: 'session.pause',
  resume: 'session.resume',
  takeover: 'session.takeover',
  cancel: 'session.cancel',
  end: 'session.end',
  retry: 'session.resume',
  'resolve-wait': 'wait.resolve',
  redirect: 'turn.redirect',
  workflow: 'conversation.workflow',
  'queue-message': 'message.queue',
};

type BrowserProfile = CloudProfileDraft & { serverPublicKey: string; endpoint: string };
type TokenBundle = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string | number;
  device?: { id?: string; name?: string } | null;
};
type BrowserCredentials = { profile: BrowserProfile; tokens: TokenBundle | null };
type BrowserHealth = { profile: BrowserProfile; serviceVersion: string | null };
type BrowserLockManager = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};
type BrowserStorageEvent = { key?: string | null; storageArea?: Storage | null };
type BrowserStorageEventTarget = {
  addEventListener(type: 'storage', listener: (event: BrowserStorageEvent) => void): void;
};

type BrowserArchive = {
  id: string;
  sessionId: string;
  operationId: string;
  kind: 'baseline' | 'turn' | 'result';
  fileName: string;
  sha256: string;
  revision: number;
  turn: number;
  bytes: Uint8Array;
  timeline?: unknown;
  session?: Record<string, unknown>;
  createdAt: string;
};

type BrowserCloudOptions = {
  readReference?: (reference: Pick<CloudTransferReference, 'id' | 'scope' | 'scopeId'>) => Promise<Uint8Array>;
  fetchImpl?: typeof fetch;
  storage?: Storage;
  lockManager?: BrowserLockManager;
  storageEvents?: BrowserStorageEventTarget;
  display?: CloudDisplayConnectionOptions;
};

type BrowserCloudError = Error & { status?: number; code?: string; retryable?: boolean };
type BrowserRefreshState = {
  profile: BrowserProfile;
  generation: number;
  refreshToken: string;
  promise: Promise<TokenBundle>;
};
type PendingCredentialsCommit = {
  credentials: BrowserCredentials;
  previousRefreshToken: string;
  generation: number;
};

type BrowserTakeoverState = {
  profile: BrowserProfile;
  generation: number;
  receipt: Record<string, unknown>;
  boundary: Record<string, unknown>;
  session: Record<string, unknown> | null;
  document?: {
    bytes: Uint8Array;
    fileName: string;
    sha256: string;
    byteLength: number;
    revision: number;
    turn: number;
    operationId: string;
  };
  timeline?: unknown;
};

function cloudError(message: string, code: string, retryable = false, status = 0): BrowserCloudError {
  return Object.assign(new Error(message), { code, retryable, status });
}

function sameProfileIdentity(left: BrowserProfile | null, right: BrowserProfile | null): boolean {
  return Boolean(left && right
    && left.endpoint === right.endpoint
    && left.serverPublicKey === right.serverPublicKey);
}

function abortableWait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeStorage(candidate?: Storage): Storage | null {
  try {
    const selected = candidate ?? globalThis.localStorage;
    const probe = '__rauhwpx_cloud_probe__';
    selected.setItem(probe, '1');
    selected.removeItem(probe);
    return selected;
  } catch {
    return null;
  }
}

function randomId(prefix = ''): string {
  const id = globalThis.crypto.randomUUID();
  return prefix ? `${prefix}${id.replaceAll('-', '_')}` : id;
}


function exactEndpoint(profile: CloudProfileDraft): string {
  const raw = profile.transport.kind === 'https'
    ? profile.transport.endpoint
    : profile.transport.kind === 'tailscale'
      ? `https://${profile.host}${(profile.tailscaleHttpsPort ?? 443) === 443 ? '' : `:${profile.tailscaleHttpsPort}`}/rauhwpx-cloud`
      : '';
  if (!raw) throw new Error('브라우저 PWA는 HTTPS 또는 Tailscale HTTPS Cloud 주소가 필요합니다.');
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error('브라우저 Cloud 주소는 정확한 HTTPS URL이어야 합니다.');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function iso(value: unknown, fallback = new Date().toISOString()): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  if (Number.isFinite(Number(value)) && Number(value) > 0) return new Date(Number(value)).toISOString();
  return fallback;
}

function openArchiveDatabase(): Promise<IDBDatabase | null> {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARCHIVE_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('archives')) database.createObjectStore('archives', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putArchive(archive: BrowserArchive): Promise<void> {
  const database = await openArchiveDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('archives', 'readwrite');
    transaction.objectStore('archives').put(archive);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => database.close());
}

async function getArchive(id: string): Promise<BrowserArchive | null> {
  const database = await openArchiveDatabase();
  if (!database) return null;
  return new Promise<BrowserArchive | null>((resolve, reject) => {
    const transaction = database.transaction('archives', 'readonly');
    const request = transaction.objectStore('archives').get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  }).finally(() => database.close());
}

function serverNamespace(profile: Pick<BrowserProfile, 'endpoint' | 'serverPublicKey'>): string {
  return encodeURIComponent(`${profile.endpoint}\n${profile.serverPublicKey}`);
}

function archiveId(profile: BrowserProfile, sessionId: string, operationId: string): string {
  return `${serverNamespace(profile)}:${sessionId}:${operationId}`;
}

function originSyncKey(profile: BrowserProfile, sessionId: string): string {
  return `${ORIGIN_SYNC_KEY_PREFIX}${serverNamespace(profile)}.${sessionId}`;
}

function takeoverCompletionId(sessionId: string, operationId: string): string {
  return `${sessionId}\n${operationId}`;
}

function takeoverCompleteKey(profile: BrowserProfile, sessionId: string, operationId: string): string {
  return `${TAKEOVER_COMPLETE_KEY_PREFIX}${serverNamespace(profile)}.${encodeURIComponent(sessionId)}.${encodeURIComponent(operationId)}`;
}

function validServerPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^ed25519:[A-Za-z0-9_-]{59}$/.test(value)) return false;
  try {
    const encoded = value.slice('ed25519:'.length);
    const padded = encoded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - encoded.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const prefix = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
    return bytes.byteLength === 44 && prefix.every((byte, index) => bytes[index] === byte);
  } catch {
    return false;
  }
}

function parsedProfile(value: unknown): BrowserProfile | null {
  const parsed = record(value);
  const auth = record(parsed?.auth);
  const transport = record(parsed?.transport);
  if (!parsed || typeof parsed.name !== 'string' || !parsed.name.trim() || parsed.name.length > 80
    || typeof parsed.host !== 'string' || !parsed.host.trim() || parsed.host.length > 253
    || typeof parsed.sshUser !== 'string' || !parsed.sshUser.trim() || parsed.sshUser.length > 128
    || !Number.isInteger(parsed.sshPort) || Number(parsed.sshPort) < 1 || Number(parsed.sshPort) > 65_535
    || (parsed.tailscaleHttpsPort !== undefined
      && (!Number.isInteger(parsed.tailscaleHttpsPort)
        || Number(parsed.tailscaleHttpsPort) < 1 || Number(parsed.tailscaleHttpsPort) > 65_535))
    || !auth || (auth.kind !== 'ssh-agent' && auth.kind !== 'key-file')
    || (auth.kind === 'key-file' && (typeof auth.keyPath !== 'string' || !auth.keyPath || auth.keyPath.includes('\0')))
    || !transport || (transport.kind !== 'https' && transport.kind !== 'tailscale')
    || !validServerPublicKey(parsed.serverPublicKey)
    || typeof parsed.endpoint !== 'string') return null;
  const draft = {
    name: parsed.name.trim(),
    host: parsed.host.trim(),
    sshUser: parsed.sshUser.trim(),
    sshPort: Number(parsed.sshPort),
    ...(parsed.tailscaleHttpsPort === undefined ? {} : { tailscaleHttpsPort: Number(parsed.tailscaleHttpsPort) }),
    auth: auth.kind === 'key-file'
      ? { kind: 'key-file' as const, keyPath: String(auth.keyPath) }
      : { kind: 'ssh-agent' as const },
    transport: transport.kind === 'https'
      ? { kind: 'https' as const, endpoint: typeof transport.endpoint === 'string' ? transport.endpoint : '' }
      : { kind: 'tailscale' as const },
    serverPublicKey: parsed.serverPublicKey,
  };
  try {
    const endpoint = exactEndpoint(draft);
    return endpoint === parsed.endpoint ? { ...draft, endpoint } : null;
  } catch {
    return null;
  }
}

function parsedTokens(value: unknown): TokenBundle | null {
  const parsed = record(value);
  const device = parsed?.device === undefined || parsed.device === null ? null : record(parsed.device);
  const expiry = typeof parsed?.accessExpiresAt === 'number'
    ? parsed.accessExpiresAt : Date.parse(String(parsed?.accessExpiresAt ?? ''));
  if (!parsed || typeof parsed.accessToken !== 'string' || !parsed.accessToken || parsed.accessToken.length > 65_536
    || parsed.accessToken.includes('\0')
    || typeof parsed.refreshToken !== 'string' || !parsed.refreshToken || parsed.refreshToken.length > 65_536
    || parsed.refreshToken.includes('\0')
    || !Number.isFinite(expiry) || expiry <= 0
    || (parsed.device !== undefined && parsed.device !== null && !device)
    || (device?.id !== undefined && (typeof device.id !== 'string' || !device.id || device.id.length > 256))
    || (device?.name !== undefined && (typeof device.name !== 'string' || device.name.length > 256))) return null;
  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    accessExpiresAt: parsed.accessExpiresAt as string | number,
    ...(device ? { device: {
      ...(typeof device.id === 'string' ? { id: device.id } : {}),
      ...(typeof device.name === 'string' ? { name: device.name } : {}),
    } } : {}),
  };
}

function parsedJson(storage: Storage, key: string): unknown {
  try {
    const value = storage.getItem(key);
    return value === null ? null : JSON.parse(value);
  } catch {
    return null;
  }
}

function storedCredentials(storage: Storage): { credentials: BrowserCredentials | null; legacy: boolean } {
  let authoritativeValue: string | null;
  try {
    authoritativeValue = storage.getItem(CREDENTIALS_KEY);
  } catch {
    return { credentials: null, legacy: false };
  }
  if (authoritativeValue !== null) {
    const parsed = record(parsedJson(storage, CREDENTIALS_KEY));
    const profile = parsedProfile(parsed?.profile);
    const tokens = parsed?.tokens === null ? null : parsedTokens(parsed?.tokens);
    return {
      credentials: profile && (parsed?.tokens === null || tokens) ? { profile, tokens } : null,
      legacy: false,
    };
  }
  const profile = parsedProfile(parsedJson(storage, PROFILE_KEY));
  return {
    // The two legacy keys have no shared server identity or transaction marker.
    // Preserve a valid pinned profile, but never send an independently stored
    // bearer token to it during migration.
    credentials: profile ? { profile, tokens: null } : null,
    legacy: Boolean(profile),
  };
}

function persistCredentials(storage: Storage, credentials: BrowserCredentials): void {
  storage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
}

function removeLegacyCredentials(storage: Storage): void {
  try { storage.removeItem(PROFILE_KEY); } catch {}
  try { storage.removeItem(TOKENS_KEY); } catch {}
}

function storedProfile(storage: Storage): BrowserProfile | null {
  return storedCredentials(storage).credentials?.profile ?? null;
}

export function browserOriginSyncDigest(sessionId: string): string | null {
  const storage = safeStorage();
  const profile = storage ? storedProfile(storage) : null;
  const value = storage && profile ? storage.getItem(originSyncKey(profile, sessionId)) : null;
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function setBrowserOriginSyncDigest(sessionId: string, digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) return;
  const storage = safeStorage();
  const profile = storage ? storedProfile(storage) : null;
  if (storage && profile) storage.setItem(originSyncKey(profile, sessionId), digest);
}

export const __test = { serverNamespace, archiveId, originSyncKey, takeoverCompleteKey };

function phase(value: unknown): string {
  if (value === 'idle' || value === 'waiting' || value === 'sleeping') return 'waiting';
  if (value === 'redirecting' || value === 'awaiting-plan-approval'
    || value === 'awaiting-question-answer' || value === 'awaiting-external-effect-approval') return value;
  return 'working';
}

function publicSession(session: Record<string, unknown>, ownDeviceId: string | null) {
  const context = record(session.clientContext);
  const origin = record(session.originDocument);
  const limits = record(session.limits);
  const result = record(session.result);
  const reason = record(session.suspendedReason);
  const wait = record(session.currentWait);
  const base = {
    sessionId: String(session.id ?? ''),
    version: Math.max(0, Number(session.stateVersion) || 0),
    threadId: String(context?.threadId ?? 'cloud-thread'),
    documentId: typeof context?.documentId === 'string' ? context.documentId : null,
    documentName: String(origin?.name ?? 'Cloud document'),
  };
  if (session.takeoverReady === true || session.takeoverRequested === true) {
    return { ...base, kind: 'taking-over', message: session.takeoverReady ? '안전한 클라우드 경계가 준비됐습니다.' : '안전한 경계를 기다리는 중입니다.' };
  }
  if (session.status === 'staged' || session.status === 'queued') {
    return { ...base, kind: 'queued', position: 1, message: '클라우드 실행 자리를 기다리고 있습니다.' };
  }
  if (session.status === 'running' && session.pauseRequested === true) {
    return { ...base, kind: 'pausing', message: '다음 안전한 경계에서 멈추는 중입니다.' };
  }
  if (session.status === 'running') {
    const startedAt = iso(session.startedAt);
    return {
      ...base,
      kind: 'running',
      startedAt,
      turn: Math.max(0, Number(session.turnsUsed) || 0),
      turnLimit: Math.max(1, Number(limits?.maxTurns) || 100),
      elapsedMs: Math.max(0, Date.now() - Date.parse(startedAt)),
      timeLimitMs: Math.max(1, Number(limits?.maxDurationSeconds) || 28_800) * 1_000,
      currentActivity: '클라우드 에이전트가 문서에서 작업 중입니다.',
      phase: phase(session.executionPhase),
      wait: wait ? { id: String(wait.id), kind: wait.kind, payload: record(wait.payload) ?? {} } : null,
    };
  }
  if (session.status === 'suspended') {
    return {
      ...base,
      kind: 'suspended',
      reason: String(reason?.message ?? '클라우드 에이전트에 확인이 필요합니다.'),
      resumable: !['TURN_LIMIT', 'DURATION_LIMIT'].includes(String(reason?.code ?? '')),
    };
  }
  if (session.status === 'completed') {
    return {
      ...base,
      kind: 'completed',
      completedAt: iso(session.completedAt),
      result: {
        fileName: base.documentName,
        byteLength: Math.max(0, Number(result?.size) || 0),
        sha256: String(result?.sha256 ?? 'pending'),
        downloaded: session.browserArchived === true,
        availableOnThisDevice: String(session.originDeviceId ?? '') === ownDeviceId,
        expiresAt: null,
        conflict: 'none',
        preservedCopyName: null,
      },
    };
  }
  if (session.status === 'cancelled' || session.status === 'purged') {
    return { ...base, kind: 'cancelled', cancelledAt: iso(session.updatedAt) };
  }
  return {
    ...base,
    kind: 'failed',
    code: String(reason?.code ?? 'CLOUD_ERROR'),
    message: String(reason?.message ?? '클라우드 세션이 실패했습니다.'),
    retryable: session.status === 'failed',
  };
}

export function browserCloudSupported(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && typeof globalThis.fetch === 'function'
    && Boolean(globalThis.crypto?.subtle)
    && Boolean(safeStorage());
}

export function createBrowserCloudApi(options: BrowserCloudOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const storage = safeStorage(options.storage);
  if (!storage || !globalThis.crypto?.subtle) return undefined;
  const lockManager = options.lockManager
    ?? (globalThis.navigator?.locks as unknown as BrowserLockManager | undefined);
  const withCredentialLock = <T>(operation: () => Promise<T>): Promise<T> => (
    lockManager ? lockManager.request(CREDENTIALS_LOCK, operation) : operation()
  );
  let profile: BrowserProfile | null = null;
  let tokens: TokenBundle | null = null;
  let scope: CloudSessionScope = { threadId: '', documentId: null };
  let revision = 0;
  let serviceVersion: string | null = null;
  let connection: 'unknown' | 'testing' | 'ready' | 'error' = 'unknown';
  let connectionMessage: string | null = null;
  let remoteSessions: Record<string, unknown>[] = [];
  const timelines = new Map<string, unknown>();
  let eventListener: ((event: unknown) => void) | null = null;
  const watchers = new Map<string, AbortController>();
  const eventSequences = new Map<string, number>();
  const queuedMessages = new Map<string, { id: string; text: string; queuedAt: string; state: 'queued' | 'accepted' }>();
  const dismissed = new Set<string>();
  const archivedSessions = new Map<string, Record<string, unknown>>();
  const completedTakeovers = new Set<string>();
  const takeoverStates = new Map<string, BrowserTakeoverState>();
  let profileGeneration = 0;
  let refreshState: BrowserRefreshState | null = null;
  let pendingCredentials: PendingCredentialsCommit | null = null;
  let initialization = Promise.resolve();
  let activeProfileReaders = 0;
  let profileWriterActive = false;
  const pendingProfileReaders: Array<(release: () => void) => void> = [];
  const pendingProfileWriters: Array<(release: () => void) => void> = [];
  const profileWritePending = () => profileWriterActive || pendingProfileWriters.length > 0;
  const stopWatchers = () => {
    for (const watcher of watchers.values()) watcher.abort();
    watchers.clear();
  };
  let resumeActiveWatchers = () => {};

  const advanceProfileGate = () => {
    if (profileWriterActive || activeProfileReaders > 0) return;
    const writer = pendingProfileWriters.shift();
    if (writer) {
      profileWriterActive = true;
      writer(() => {
        profileWriterActive = false;
        advanceProfileGate();
      });
      return;
    }
    const readers = pendingProfileReaders.splice(0);
    activeProfileReaders += readers.length;
    for (const reader of readers) {
      reader(() => {
        activeProfileReaders -= 1;
        advanceProfileGate();
      });
    }
  };
  const acquireProfileReader = (): Promise<() => void> => {
    if (!profileWriterActive && pendingProfileWriters.length === 0) {
      activeProfileReaders += 1;
      return Promise.resolve(() => {
        activeProfileReaders -= 1;
        advanceProfileGate();
      });
    }
    return new Promise((resolve) => {
      pendingProfileReaders.push(resolve);
    });
  };
  const acquireProfileWriter = (): Promise<() => void> => {
    stopWatchers();
    return new Promise((resolve) => {
      pendingProfileWriters.push(resolve);
      advanceProfileGate();
    });
  };
  const readProfile = async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = await acquireProfileReader();
    try {
      await initialization;
      return await operation();
    } finally {
      release();
    }
  };

  const initial = storedCredentials(storage).credentials;
  if (initial) {
    profile = initial.profile;
    tokens = initial.tokens;
  }
  initialization = withCredentialLock(async () => {
    const current = storedCredentials(storage);
    if (current.legacy && current.credentials) persistCredentials(storage, current.credentials);
    if (current.credentials) removeLegacyCredentials(storage);
    profile = current.credentials?.profile ?? null;
    tokens = current.credentials?.tokens ?? null;
  });

  const ownDeviceId = () => typeof tokens?.device?.id === 'string' ? tokens.device.id : null;
  const requireCurrentProfile = (selectedProfile: BrowserProfile, generation: number) => {
    if (generation !== profileGeneration || !sameProfileIdentity(selectedProfile, profile)) {
      throw cloudError('Cloud 프로필이 작업 중 변경됐습니다.', 'PROFILE_CHANGED');
    }
  };
  const requireCurrentWatcher = (
    controller: AbortController,
    selectedProfile: BrowserProfile,
    generation: number,
  ) => {
    if (controller.signal.aborted || profileWritePending()) {
      throw controller.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    }
    requireCurrentProfile(selectedProfile, generation);
  };
  const matchesScope = (session: Record<string, unknown>) => {
    const context = record(session.clientContext);
    return scope.documentId
      ? context?.documentId === scope.documentId
      : Boolean(scope.threadId && context?.threadId === scope.threadId);
  };
  const selectedSessions = () => remoteSessions.filter((session) => {
    if (dismissed.has(String(session.id ?? ''))) return false;
    return matchesScope(session) || scope.selectedSessionId === session.id;
  });
  const snapshot = (extra: Record<string, unknown> = {}) => {
    const candidates = selectedSessions().map((session) => publicSession(session, ownDeviceId()));
    const selected = scope.selectedSessionId
      ? candidates.find((session) => session.sessionId === scope.selectedSessionId)
      : candidates.find((session) => !['completed', 'failed', 'cancelled'].includes(session.kind)) ?? candidates[0];
    const scoped = Boolean(scope.threadId || scope.documentId);
    const scopedActive = remoteSessions
      .filter((session) => !dismissed.has(String(session.id ?? '')) && matchesScope(session))
      .map((session) => publicSession(session, ownDeviceId()))
      .find((session) => !['completed', 'failed', 'cancelled'].includes(session.kind));
    const unscopedActive = selected && !['completed', 'failed', 'cancelled'].includes(selected.kind)
      ? selected
      : candidates.find((session) => !['completed', 'failed', 'cancelled'].includes(session.kind));
    const leaseSession = scoped ? scopedActive : unscopedActive;
    let preferredMode = 'self-hosted';
    try { preferredMode = storage.getItem(MODE_KEY) === 'app-hosted' ? 'app-hosted' : 'self-hosted'; } catch {}
    return {
      revision: ++revision,
      profileEpoch: profileGeneration,
      available: true,
      profile: profile ? {
        kind: 'configured', mode: 'self-hosted', connection, serviceVersion, message: connectionMessage,
        profile,
      } : { kind: 'unconfigured' },
      server: {
        mode: profile ? 'self-hosted' : null,
        preferredMode,
        providers: [],
        lifecycle: 'idle',
        message: null,
      },
      lease: leaseSession
        ? {
          owner: 'cloud',
          sessionId: leaseSession.sessionId,
          acquiredAt: 'startedAt' in leaseSession ? String(leaseSession.startedAt) : new Date().toISOString(),
        }
        : { owner: 'local' },
      session: selected ?? { kind: 'idle' },
      sessions: candidates,
      queuedMessages: [...queuedMessages.values()],
      timeline: selected ? timelines.get(selected.sessionId) ?? null : null,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
  };

  const emit = (event: Record<string, unknown>, eventProfileEpoch = profileGeneration) => (
    eventListener?.({ ...event, profileEpoch: eventProfileEpoch, snapshot: snapshot() })
  );

  const tokenIsUsable = (candidate: TokenBundle | null): candidate is TokenBundle => {
    const expiry = typeof candidate?.accessExpiresAt === 'number'
      ? candidate.accessExpiresAt : Date.parse(String(candidate?.accessExpiresAt ?? ''));
    return Boolean(candidate?.accessToken && Number.isFinite(expiry) && expiry > Date.now() + 15_000);
  };

  const ensureAccessToken = async (
    selectedProfile: BrowserProfile,
    generation: number,
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<TokenBundle> => {
    if (generation !== profileGeneration || !sameProfileIdentity(selectedProfile, profile)) {
      throw cloudError('Cloud 프로필이 요청 인증 중 변경됐습니다.', 'PROFILE_CHANGED');
    }
    if (!pendingCredentials && !forceRefresh && tokenIsUsable(tokens)) return tokens;
    const capturedTokens = tokens ? { ...tokens } : null;
    const refreshToken = capturedTokens?.refreshToken ?? '';
    if (!refreshToken) throw cloudError('Cloud 페어링이 필요합니다.', 'PAIRING_REQUIRED');
    let state = refreshState;
    if (!state || state.generation !== generation
      || state.refreshToken !== refreshToken
      || !sameProfileIdentity(state.profile, selectedProfile)) {
      const promise = withCredentialLock(async (): Promise<TokenBundle> => {
        let authoritative = storedCredentials(storage).credentials;
        if (!authoritative || !sameProfileIdentity(authoritative.profile, selectedProfile)) {
          pendingCredentials = null;
          throw cloudError('Cloud 프로필이 토큰 갱신 중 변경됐습니다.', 'PROFILE_CHANGED');
        }
        if (pendingCredentials && pendingCredentials.generation === generation
          && sameProfileIdentity(pendingCredentials.credentials.profile, selectedProfile)) {
          const pendingTokens = pendingCredentials.credentials.tokens;
          const authoritativeRefresh = authoritative.tokens?.refreshToken ?? '';
          if (pendingTokens && authoritativeRefresh === pendingTokens.refreshToken) {
            tokens = authoritative.tokens;
            pendingCredentials = null;
            return authoritative.tokens!;
          }
          if (pendingTokens && authoritativeRefresh === pendingCredentials.previousRefreshToken) {
            persistCredentials(storage, pendingCredentials.credentials);
            removeLegacyCredentials(storage);
            tokens = pendingTokens;
            pendingCredentials = null;
            return pendingTokens;
          }
          pendingCredentials = null;
          tokens = authoritative.tokens;
        }
        authoritative = storedCredentials(storage).credentials;
        if (!authoritative || !sameProfileIdentity(authoritative.profile, selectedProfile)) {
          throw cloudError('Cloud 프로필이 토큰 갱신 중 변경됐습니다.', 'PROFILE_CHANGED');
        }
        const currentTokens = authoritative.tokens;
        if (!currentTokens?.refreshToken) throw cloudError('Cloud 페어링이 필요합니다.', 'PAIRING_REQUIRED');
        const changedInAnotherTab = currentTokens.refreshToken !== refreshToken
          || currentTokens.accessToken !== capturedTokens?.accessToken;
        tokens = currentTokens;
        if (tokenIsUsable(currentTokens) && (!forceRefresh || changedInAnotherTab)) return currentTokens;
        const refreshed = await requestJson('/v1/token/refresh', {
          method: 'POST',
          auth: false,
          body: { refreshToken: currentTokens.refreshToken },
          selectedProfile,
        });
        const next = parsedTokens({ ...currentTokens, ...refreshed });
        if (!next) throw cloudError('Cloud 토큰 응답이 잘못됐습니다.', 'TOKEN_RESPONSE_INVALID');
        if (generation !== profileGeneration || !sameProfileIdentity(selectedProfile, profile)) {
          throw cloudError('Cloud 프로필이 토큰 갱신 중 변경됐습니다.', 'PROFILE_CHANGED');
        }
        const nextCredentials = { profile: selectedProfile, tokens: next };
        try {
          persistCredentials(storage, nextCredentials);
          removeLegacyCredentials(storage);
        } catch (error) {
          tokens = next;
          pendingCredentials = {
            credentials: nextCredentials,
            previousRefreshToken: currentTokens.refreshToken,
            generation,
          };
          throw error;
        }
        tokens = next;
        pendingCredentials = null;
        return next;
      });
      state = { profile: selectedProfile, generation, refreshToken, promise };
      refreshState = state;
      const clear = () => {
        if (refreshState === state) refreshState = null;
      };
      promise.then(clear, clear);
      void promise.catch(() => {});
    }
    return abortableWait(state.promise, signal);
  };

  const request = async (pathname: string, {
    method = 'GET',
    body,
    rawBody,
    headers: inputHeaders,
    auth = true,
    selectedProfile = profile,
    stream = false,
    maxBytes = MAX_JSON_BYTES,
    retried = false,
    signal,
  }: {
    method?: string;
    body?: unknown;
    rawBody?: Uint8Array;
    headers?: HeadersInit;
    auth?: boolean;
    selectedProfile?: BrowserProfile | null;
    stream?: boolean;
    maxBytes?: number;
    retried?: boolean;
    signal?: AbortSignal;
  } = {}) => {
    if (!selectedProfile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
    const generation = profileGeneration;
    const authenticated = auth
      ? await ensureAccessToken(selectedProfile, generation, signal)
      : null;
    const url = new URL(`${selectedProfile.endpoint}${pathname}`);
    const nonce = base64Url(globalThis.crypto.getRandomValues(new Uint8Array(24)));
    const headers = new Headers(inputHeaders);
    headers.set('X-Rauhwpx-Request-Nonce', nonce);
    if (authenticated) headers.set('Authorization', `Bearer ${authenticated.accessToken}`);
    let requestBody: BodyInit | undefined;
    if (rawBody) requestBody = rawBody as BodyInit;
    else if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      requestBody = JSON.stringify(body);
    }
    const response = await fetchImpl(url, { method, headers, body: requestBody, signal, cache: 'no-store' });
    const context = { nonce, method, pathAndQuery: `${url.pathname}${url.search}` };
    const eventStream = stream && response.ok
      && response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream');
    if (eventStream) {
      const digest = await sha256(utf8(SSE_PROTOCOL));
      await verifyResponseProof(response, selectedProfile, context, digest);
      if (auth && (generation !== profileGeneration || !sameProfileIdentity(selectedProfile, profile))) {
        throw cloudError('Cloud 프로필이 요청 중 변경됐습니다.', 'PROFILE_CHANGED');
      }
      if (!response.ok) throw new Error(`Cloud 요청이 실패했습니다 (${response.status}).`);
      return { response, bytes: null, context };
    }
    const responseLimit = stream ? Math.min(maxBytes, 2 * 1024 * 1024) : maxBytes;
    const bytes = await boundedResponseBytes(response, responseLimit);
    await verifyResponseProof(response, selectedProfile, context, await sha256(bytes));
    if (auth && (generation !== profileGeneration || !sameProfileIdentity(selectedProfile, profile))) {
      throw cloudError('Cloud 프로필이 요청 중 변경됐습니다.', 'PROFILE_CHANGED');
    }
    let parsed: unknown = {};
    if (bytes.byteLength) {
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { parsed = null; }
    }
    if (!response.ok) {
      const error = record(record(parsed)?.error);
      const failure = new Error(String(error?.message ?? `Cloud 요청이 실패했습니다 (${response.status}).`));
      Object.assign(failure, {
        status: response.status,
        code: error?.code,
        details: error?.details,
        retryable: typeof error?.retryable === 'boolean'
          ? error.retryable
          : response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
      });
      if (auth && response.status === 401 && !retried && authenticated) {
        if (generation !== profileGeneration || !sameProfileIdentity(selectedProfile, profile)) {
          throw cloudError('Cloud 프로필이 요청 인증 후 변경됐습니다.', 'PROFILE_CHANGED');
        }
        if (tokens?.accessToken === authenticated.accessToken) {
          await ensureAccessToken(selectedProfile, generation, signal, true);
        }
        return request(pathname, {
          method, body, rawBody, headers: inputHeaders, auth, selectedProfile, stream, maxBytes, retried: true, signal,
        });
      }
      throw failure;
    }
    if (stream) throw cloudError('Cloud 스트림 응답 형식이 잘못됐습니다.', 'SSE_PROOF_INVALID');
    return { response, bytes, parsed, context };
  };

  const requestJson = async (pathname: string, options: Parameters<typeof request>[1] = {}) => (
    (await request(pathname, options)).parsed as Record<string, unknown>
  );

  const health = async (draft: CloudProfileDraft): Promise<BrowserHealth> => {
    const endpoint = exactEndpoint(draft);
    const url = new URL(`${endpoint}/v1/health`);
    const response = await fetchImpl(url, { cache: 'no-store' });
    const raw = await response.json() as Record<string, unknown>;
    if (!response.ok || raw.protocolVersion !== 1 || !validServerPublicKey(raw.serverPublicKey)) {
      throw new Error('지원하는 Rauhwpx Cloud 서버가 아닙니다.');
    }
    if (draft.serverPublicKey && draft.serverPublicKey !== raw.serverPublicKey) {
      throw new Error('Cloud 서버 키가 저장된 신원과 다릅니다.');
    }
    const candidate = parsedProfile({ ...draft, endpoint, serverPublicKey: raw.serverPublicKey });
    if (!candidate) throw new Error('Cloud 프로필이 잘못됐습니다.');
    return {
      profile: candidate,
      serviceVersion: typeof raw.version === 'string' ? raw.version : null,
    };
  };

  const fetchRemoteSessions = async (watcher?: AbortController): Promise<void> => {
    if (!profile || !tokens?.refreshToken) return;
    const selectedProfile = profile;
    const generation = profileGeneration;
    const assertCurrent = () => watcher
      ? requireCurrentWatcher(watcher, selectedProfile, generation)
      : requireCurrentProfile(selectedProfile, generation);
    const payload = await requestJson('/v1/sessions', { selectedProfile, signal: watcher?.signal });
    assertCurrent();
    const fetched = Array.isArray(payload.sessions)
      ? payload.sessions.filter((entry): entry is Record<string, unknown> => Boolean(record(entry)))
      : [];
    const nextSessions = await Promise.all(fetched.map(async (listedSession) => {
      const sessionId = String(listedSession.id ?? '');
      let session = listedSession;
      if (session.takeoverReady === true) {
        const takeover = await requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}/takeover`, {
          selectedProfile,
          signal: watcher?.signal,
        });
        assertCurrent();
        const boundary = record(takeover.boundary);
        if (takeover.status !== 'ready' || !boundary || typeof boundary.operationId !== 'string'
          || !boundary.operationId) {
          throw cloudError('Cloud 이어받기 영수증이 잘못됐습니다.', 'TAKEOVER_RECEIPT_INVALID');
        }
        session = { ...session, takeoverBoundary: boundary };
      }
      const operationId = String(record(session.takeoverBoundary)?.operationId ?? '');
      const completionId = operationId ? takeoverCompletionId(sessionId, operationId) : '';
      if (completionId && (completedTakeovers.has(completionId)
        || storage.getItem(takeoverCompleteKey(selectedProfile, sessionId, operationId)) === '1')) {
        completedTakeovers.add(completionId);
        return { ...session, takeoverReady: false, takeoverRequested: false };
      }
      if (session.status !== 'purged') return session;
      const memory = archivedSessions.get(sessionId);
      if (memory) return memory;
      const archive = await getArchive(archiveId(selectedProfile, sessionId, 'result'));
      assertCurrent();
      if (!archive?.session) return session;
      const restored = { ...archive.session, browserArchived: true };
      archivedSessions.set(sessionId, restored);
      return restored;
    }));
    assertCurrent();
    for (const session of nextSessions) {
      const current = record(session);
      const sessionId = String(current?.id ?? '');
      const operationId = String(record(current?.takeoverBoundary)?.operationId ?? '');
      const state = takeoverStates.get(sessionId);
      if (operationId && state && String(state.boundary.operationId ?? '') !== operationId) {
        takeoverStates.delete(sessionId);
      }
    }
    assertCurrent();
    remoteSessions = nextSessions;
    connection = 'ready';
    connectionMessage = null;
  };

  const upload = async (
    bytes: Uint8Array,
    name: string,
    kind: string,
    sessionId: string,
    selectedProfile = profile,
  ) => {
    const digest = await sha256(bytes);
    let state = await requestJson('/v1/uploads/init', {
      method: 'POST', body: { sha256: digest, size: bytes.byteLength, name, kind, sessionId }, selectedProfile,
    });
    while (state.blobExists !== true && state.status !== 'complete') {
      const uploadId = String(state.uploadId ?? '');
      const offset = Number(state.offset);
      const chunkSize = Math.min(Math.max(1, Number(state.chunkSize) || 1024 * 1024), 8 * 1024 * 1024);
      if (!uploadId || !Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.byteLength) {
        throw new Error('Cloud 업로드 상태가 잘못됐습니다.');
      }
      state = await requestJson(`/v1/uploads/${encodeURIComponent(uploadId)}/chunks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset) },
        rawBody: bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)),
        selectedProfile,
      });
    }
    return { blobId: String(record(state.blob)?.id ?? digest), sha256: digest, size: bytes.byteLength };
  };

  const downloadTimelineArtifact = async (
    sessionId: string,
    selectedProfile = profile,
    signal?: AbortSignal,
    assertCurrent?: () => void,
  ) => {
    if (!selectedProfile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
    const generation = profileGeneration;
    const result = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/timeline`, {
      maxBytes: MAX_TIMELINE_BYTES,
      selectedProfile,
      signal,
    });
    if (!result.bytes || result.bytes.byteLength > MAX_TIMELINE_BYTES) throw new Error('Cloud 타임라인이 잘못됐습니다.');
    const expected = result.response.headers.get('x-content-sha256');
    if (!expected || expected !== await sha256(result.bytes)) throw new Error('Cloud 타임라인 무결성 검증에 실패했습니다.');
    const timeline = JSON.parse(new TextDecoder().decode(result.bytes));
    requireCurrentProfile(selectedProfile, generation);
    assertCurrent?.();
    return {
      timeline,
      sha256: expected,
      size: result.bytes.byteLength,
      boundaryOperation: result.response.headers.get('x-boundary-operation') ?? '',
      boundaryRevision: Number(result.response.headers.get('x-boundary-revision')) || 0,
      boundaryTurn: Number(result.response.headers.get('x-boundary-turn')) || 0,
    };
  };
  const downloadTimeline = async (
    sessionId: string,
    selectedProfile = profile,
    signal?: AbortSignal,
    assertCurrent?: () => void,
  ) => (
    (await downloadTimelineArtifact(sessionId, selectedProfile, signal, assertCurrent)).timeline
  );

  const downloadCheckpoint = async (
    sessionId: string,
    operationId?: string,
    selectedProfile = profile,
    signal?: AbortSignal,
    assertCurrent?: () => void,
  ) => {
    if (!selectedProfile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
    const generation = profileGeneration;
    const query = operationId ? `?operationId=${encodeURIComponent(operationId)}` : '';
    const result = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/checkpoint${query}`, {
      maxBytes: MAX_DOCUMENT_BYTES,
      selectedProfile,
      signal,
    });
    if (!result.bytes || !result.bytes.byteLength || result.bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error('Cloud 체크포인트 크기가 잘못됐습니다.');
    }
    const expected = result.response.headers.get('x-content-sha256') ?? '';
    if (expected !== await sha256(result.bytes)) throw new Error('Cloud 체크포인트 무결성 검증에 실패했습니다.');
    requireCurrentProfile(selectedProfile, generation);
    assertCurrent?.();
    const boundaryOperation = result.response.headers.get('x-boundary-operation') ?? '';
    const boundaryKind = result.response.headers.get('x-boundary-kind');
    if (boundaryKind !== 'handoff' && boundaryKind !== 'operation' && boundaryKind !== 'turn') {
      throw new Error('Cloud 체크포인트 경계 종류가 잘못됐습니다.');
    }
    const encodedName = result.response.headers.get('x-document-name') ?? 'cloud-document.hwpx';
    let fileName = encodedName;
    try { fileName = decodeURIComponent(encodedName); } catch {}
    const remote = remoteSessions.find((session) => session.id === sessionId);
    const context = record(remote?.clientContext);
    const checkpoint = {
      sessionId,
      documentId: typeof context?.documentId === 'string' && context.documentId ? context.documentId : null,
      fileName,
      bytes: result.bytes,
      byteLength: result.bytes.byteLength,
      sha256: expected,
      revision: Number(result.response.headers.get('x-checkpoint-revision')) || 0,
      turn: Number(result.response.headers.get('x-checkpoint-turn')) || 0,
      operationId: boundaryOperation,
      kind: boundaryKind,
      originOnThisDevice: String(remote?.originDeviceId ?? '') === ownDeviceId(),
      expectedOriginSha256: storage.getItem(originSyncKey(selectedProfile, sessionId)) ?? undefined,
    };
    if (boundaryKind === 'turn') {
      await putArchive({
        id: archiveId(selectedProfile, sessionId, boundaryOperation),
        sessionId,
        operationId: boundaryOperation,
        kind: 'turn',
        fileName,
        sha256: expected,
        revision: checkpoint.revision,
        turn: checkpoint.turn,
        bytes: result.bytes,
        createdAt: new Date().toISOString(),
      });
      assertCurrent?.();
    }
    requireCurrentProfile(selectedProfile, generation);
    assertCurrent?.();
    return checkpoint;
  };

  const archiveResult = async (
    sessionId: string,
    selectedProfile = profile,
    generation = profileGeneration,
    watcher?: AbortController,
  ) => {
    if (!selectedProfile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
    const assertCurrent = () => watcher
      ? requireCurrentWatcher(watcher, selectedProfile, generation)
      : requireCurrentProfile(selectedProfile, generation);
    const result = await request(`/v1/results/${encodeURIComponent(sessionId)}`, {
      maxBytes: MAX_DOCUMENT_BYTES,
      selectedProfile,
      signal: watcher?.signal,
    });
    if (!result.bytes?.byteLength) throw new Error('Cloud 결과가 비어 있습니다.');
    const digest = result.response.headers.get('x-content-sha256') ?? '';
    if (digest !== await sha256(result.bytes)) throw new Error('Cloud 결과 무결성 검증에 실패했습니다.');
    assertCurrent();
    const remote = remoteSessions.find((session) => session.id === sessionId);
    const name = String(record(remote?.originDocument)?.name ?? 'cloud-result.hwpx');
    const downloadedTimeline = await downloadTimeline(
      sessionId,
      selectedProfile,
      watcher?.signal,
      assertCurrent,
    );
    const archive: BrowserArchive = {
      id: archiveId(selectedProfile, sessionId, 'result'), sessionId, operationId: 'result', kind: 'result',
      fileName: name, sha256: digest, revision: 0, turn: Number(remote?.turnsUsed) || 0,
      bytes: result.bytes,
      timeline: downloadedTimeline,
      ...(remote ? { session: { ...remote, browserArchived: true } } : {}),
      createdAt: new Date().toISOString(),
    };
    await putArchive(archive);
    assertCurrent();
    if (remote) {
      const local = { ...remote, browserArchived: true };
      archivedSessions.set(sessionId, local);
      remoteSessions = [local, ...remoteSessions.filter((session) => session.id !== sessionId)];
    }
    await requestJson(`/v1/results/${encodeURIComponent(sessionId)}/download-confirmed`, {
      method: 'POST', body: { sha256: digest, size: result.bytes.byteLength }, selectedProfile,
      signal: watcher?.signal,
    });
    assertCurrent();
    timelines.set(sessionId, downloadedTimeline);
    return { archive, timeline: downloadedTimeline };
  };

  const displayManager = createBrowserDisplayManager({
    request,
    profile: () => profile,
    verifySse: verifySseFrame,
    sha256,
    randomId,
    options: options.display,
  });

  const resetServerState = () => {
    stopWatchers();
    remoteSessions = [];
    timelines.clear();
    eventSequences.clear();
    queuedMessages.clear();
    dismissed.clear();
    archivedSessions.clear();
    completedTakeovers.clear();
    takeoverStates.clear();
    pendingCredentials = null;
    scope = { threadId: '', documentId: null };
    refreshState = null;
    connection = 'unknown';
    connectionMessage = null;
  };
  const changeProfile = async (
    prepare: () => Promise<BrowserHealth & { tokens: TokenBundle | null; preserveTokens?: boolean }>,
  ) => {
    const writer = acquireProfileWriter();
    const displayClosed = displayManager.closeActive();
    const release = await writer;
    try {
      await initialization;
      await displayClosed;
      const prepared = await prepare();
      const nextCredentials = await withCredentialLock(async () => {
        const authoritative = storedCredentials(storage).credentials;
        const credentials = {
          profile: prepared.profile,
          tokens: prepared.preserveTokens && sameProfileIdentity(authoritative?.profile ?? null, prepared.profile)
            ? authoritative?.tokens ?? null
            : prepared.tokens,
        };
        persistCredentials(storage, credentials);
        removeLegacyCredentials(storage);
        return credentials;
      });
      profileGeneration += 1;
      resetServerState();
      profile = nextCredentials.profile;
      tokens = nextCredentials.tokens;
      serviceVersion = prepared.serviceVersion;
      connection = tokens ? 'ready' : 'unknown';
      return await refresh();
    } finally {
      release();
      if (!profileWritePending()) resumeActiveWatchers();
    }
  };

  const synchronizeCredentialsFromStorage = async () => {
    const writer = acquireProfileWriter();
    const displayClosed = displayManager.closeActive();
    const release = await writer;
    try {
      await initialization;
      await displayClosed;
      const current = await withCredentialLock(async () => storedCredentials(storage).credentials);
      profileGeneration += 1;
      resetServerState();
      profile = current?.profile ?? null;
      tokens = current?.tokens ?? null;
      serviceVersion = null;
      connection = tokens ? 'ready' : 'unknown';
      return await refresh();
    } finally {
      release();
      if (!profileWritePending()) resumeActiveWatchers();
    }
  };
  const storageEvents = options.storageEvents
    ?? (typeof globalThis.addEventListener === 'function'
      ? globalThis as unknown as BrowserStorageEventTarget
      : undefined);
  storageEvents?.addEventListener('storage', (event) => {
    if (event.key !== CREDENTIALS_KEY || (event.storageArea && event.storageArea !== storage)) return;
    void synchronizeCredentialsFromStorage().catch((error) => {
      connection = 'error';
      connectionMessage = error instanceof Error ? error.message : String(error);
      emit({ type: 'profile-storage-sync-error', error: connectionMessage });
    });
  });

  const watch = (sessionId: string) => {
    if (watchers.has(sessionId) || !profile || profileWritePending()) return;
    const controller = new AbortController();
    const generation = profileGeneration;
    const selectedProfile = profile;
    watchers.set(sessionId, controller);
    void (async () => {
      let failures = 0;
      while (!controller.signal.aborted && generation === profileGeneration
        && sameProfileIdentity(selectedProfile, profile) && !profileWritePending()) {
        try {
          requireCurrentWatcher(controller, selectedProfile, generation);
          const after = eventSequences.get(sessionId) ?? 0;
          const stream = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`, {
            headers: { Accept: 'text/event-stream' }, stream: true, signal: controller.signal, selectedProfile,
          });
          requireCurrentWatcher(controller, selectedProfile, generation);
          if (!stream.response.body || !stream.context) throw new Error('Cloud 이벤트 스트림을 열지 못했습니다.');
          const reader = stream.response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            requireCurrentWatcher(controller, selectedProfile, generation);
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSse(buffer);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
              const sequence = await verifySseFrame(frame, stream.context, selectedProfile);
              requireCurrentWatcher(controller, selectedProfile, generation);
              if (sequence <= (eventSequences.get(sessionId) ?? 0)) continue;
              const event = JSON.parse(frame.data) as Record<string, unknown>;
              const messageId = String(record(event.payload)?.messageId ?? '');
              if (event.type === 'message.accepted' && messageId && queuedMessages.has(messageId)) {
                queuedMessages.set(messageId, { ...queuedMessages.get(messageId)!, state: 'accepted' });
              }
              if (event.type !== 'agent.event') await fetchRemoteSessions(controller);
              requireCurrentWatcher(controller, selectedProfile, generation);
              emit({ type: 'remote-session-event', sessionId, event }, generation);
              if (event.type === 'boundary.committed') {
                const operationId = String(record(event.payload)?.operationId ?? '');
                if (operationId) await downloadCheckpoint(
                  sessionId,
                  operationId,
                  selectedProfile,
                  controller.signal,
                  () => requireCurrentWatcher(controller, selectedProfile, generation),
                );
              }
              if (event.type === 'timeline.updated') {
                let downloaded = null;
                try {
                  downloaded = await downloadTimeline(
                    sessionId,
                    selectedProfile,
                    controller.signal,
                    () => requireCurrentWatcher(controller, selectedProfile, generation),
                  );
                } catch (error) {
                  if ((error as BrowserCloudError).code === 'PROFILE_CHANGED') throw error;
                }
                requireCurrentWatcher(controller, selectedProfile, generation);
                if (downloaded) timelines.set(sessionId, downloaded);
              }
              if (event.type === 'session.completed') {
                const completed = remoteSessions.find((session) => session.id === sessionId);
                if (completed && String(completed.originDeviceId ?? '') === ownDeviceId()) {
                  await archiveResult(sessionId, selectedProfile, generation, controller);
                  requireCurrentWatcher(controller, selectedProfile, generation);
                  emit({ type: 'conversation-result-archived', sessionId }, generation);
                }
              }
              requireCurrentWatcher(controller, selectedProfile, generation);
              eventSequences.set(sessionId, sequence);
            }
          }
          failures = 0;
        } catch (error) {
          if (controller.signal.aborted) break;
          if ((error as BrowserCloudError).code === 'PROFILE_CHANGED') break;
          failures += 1;
          if (failures >= 20) {
            emit({ type: 'remote-session-stream-error', sessionId, error: error instanceof Error ? error.message : String(error) });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 250 * 2 ** failures)));
        }
      }
    })().finally(() => {
      if (watchers.get(sessionId) === controller) watchers.delete(sessionId);
    });
  };
  resumeActiveWatchers = () => {
    for (const session of selectedSessions()) {
      if (session.status === 'queued' || session.status === 'running') watch(String(session.id));
    }
  };

  const refresh = async (nextScope = scope) => {
    const selectedProfile = profile;
    const generation = profileGeneration;
    scope = nextScope;
    if (selectedProfile && tokens?.refreshToken) {
      try {
        await fetchRemoteSessions();
        const selected = scope.selectedSessionId
          ? remoteSessions.find((session) => session.id === scope.selectedSessionId)
          : remoteSessions.find((session) => matchesScope(session));
        const selectedId = typeof selected?.id === 'string' ? selected.id : '';
        if (selectedId && !timelines.has(selectedId)) {
          let downloaded = null;
          try {
            downloaded = await downloadTimeline(selectedId, selectedProfile);
          } catch (error) {
            if ((error as BrowserCloudError).code === 'PROFILE_CHANGED') throw error;
          }
          requireCurrentProfile(selectedProfile, generation);
          if (downloaded) timelines.set(selectedId, downloaded);
        }
        for (const session of selectedSessions()) {
          if (session.status === 'queued' || session.status === 'running') watch(String(session.id));
        }
      } catch (error) {
        requireCurrentProfile(selectedProfile, generation);
        connection = 'error';
        connectionMessage = error instanceof Error ? error.message : String(error);
      }
    }
    return snapshot();
  };

  return {
    cloudGetState: (payload: CloudSessionScope) => readProfile(() => refresh(payload)),
    cloudTestProfile: (payload: { profile?: CloudProfileDraft }) => readProfile(async () => {
      const generation = profileGeneration;
      connection = 'testing';
      const candidate = await health(payload.profile ?? profile!);
      if (generation !== profileGeneration) throw cloudError('Cloud 프로필이 작업 중 변경됐습니다.', 'PROFILE_CHANGED');
      connection = 'ready';
      serviceVersion = candidate.serviceVersion;
      return snapshot({ testedServerPublicKey: candidate.profile.serverPublicKey });
    }),
    cloudSaveProfile: (payload: { profile: CloudProfileDraft }) => changeProfile(async () => {
      const candidate = await health(payload.profile);
      return {
        ...candidate,
        tokens: null,
        preserveTokens: true,
      };
    }),
    cloudPair: (payload: { code: string; profile?: CloudProfileDraft }) => changeProfile(async () => {
      const candidate = await health(payload.profile ?? profile!);
      const paired = await requestJson('/v1/pairing/redeem', {
        method: 'POST',
        auth: false,
        selectedProfile: candidate.profile,
        body: {
          code: payload.code.trim().toUpperCase(),
          deviceName: navigator.userAgent.includes('Mobile') ? 'Rauhwpx PWA mobile' : 'Rauhwpx PWA browser',
          requestId: randomId('pair_'),
        },
      });
      const pairedTokens = parsedTokens(paired);
      if (!pairedTokens) throw cloudError('Cloud 토큰 응답이 잘못됐습니다.', 'TOKEN_RESPONSE_INVALID');
      return {
        ...candidate,
        tokens: pairedTokens,
      };
    }),
    cloudSelectServerMode: (payload: { mode: string }) => readProfile(async () => {
      storage.setItem(MODE_KEY, payload.mode === 'app-hosted' ? 'app-hosted' : 'self-hosted');
      return snapshot();
    }),
    cloudProvision: () => readProfile(async () => { throw new Error('브라우저에서는 Cloud 서버를 설치할 수 없습니다. 기존 HTTPS 서버와 페어링해 주세요.'); }),
    cloudSpawnSandbox: () => readProfile(async () => { throw new Error('브라우저 PWA에서는 Raucloud를 만들 수 없습니다.'); }),
    cloudSandboxStatus: () => readProfile(() => refresh()),
    cloudTeardownSandbox: () => readProfile(async () => ({ snapshot: snapshot(), removed: false, unmanaged: true })),
    cloudSetTransferIntent: () => readProfile(async () => snapshot()),
    async cloudReadReference(reference: Pick<CloudTransferReference, 'id' | 'scope' | 'scopeId'>) {
      if (!options.readReference) throw new Error('브라우저 참고자료를 읽을 수 없습니다.');
      return { bytes: await options.readReference(reference) };
    },
    cloudTransfer: (input: CloudTransferRequest) => readProfile(async () => {
      if (!profile || !tokens) throw new Error('Cloud 페어링이 필요합니다.');
      const selectedProfile = profile;
      const generation = profileGeneration;
      const startId = typeof input.startId === 'string' ? input.startId.trim() : '';
      const sessionId = /^[A-Za-z0-9_-]{8,128}$/.test(startId) ? startId : randomId('pwa_');
      const existing = remoteSessions.find((session) => session.id === sessionId);
      if (existing) {
        scope = { threadId: input.threadId, documentId: input.documentId, selectedSessionId: sessionId };
        watch(sessionId);
        return snapshot();
      }
      const document = await upload(input.document.bytes, input.document.fileName, 'document', sessionId, selectedProfile);
      const resources = [];
      for (const reference of input.references) {
        const stored = await upload(reference.bytes, reference.name, 'reference', sessionId, selectedProfile);
        resources.push({ name: reference.name, blobId: stored.blobId, size: stored.size, kind: 'reference' });
      }
      const timelineBytes = utf8(JSON.stringify(input.timeline));
      const timelineUpload = await upload(timelineBytes, 'timeline.json', 'timeline', sessionId, selectedProfile);
      const goal = typeof input.initialMessage?.text === 'string' ? input.initialMessage.text.trim() : '';
      if (!goal) throw new Error('Cloud start requires an initial message');
      const created = await requestJson('/v1/sessions', {
        method: 'POST',
        selectedProfile,
        body: {
          sessionId,
          provider: input.agent,
          persistent: true,
          executionConfig: {
            model: input.model,
            effort: input.effort,
            workflow: input.workflow === 'plan' ? 'plan' : 'direct',
            permissionProfile: 'unrestricted',
          },
          goal,
          clientContext: { threadId: input.threadId, documentId: input.documentId },
          originDocument: { name: input.document.fileName, blobId: document.blobId, size: document.size },
          resources,
          timeline: { blobId: timelineUpload.blobId, size: timelineUpload.size },
          limits: { maxDurationSeconds: Math.ceil(input.limits.maxDurationMs / 1_000), maxTurns: input.limits.maxTurns },
        },
      });
      await putArchive({
        id: archiveId(selectedProfile, sessionId, 'baseline'), sessionId, operationId: 'baseline', kind: 'baseline',
        fileName: input.document.fileName, sha256: input.document.sha256, revision: 0, turn: 0,
        bytes: input.document.bytes, timeline: input.timeline, createdAt: new Date().toISOString(),
      });
      requireCurrentProfile(selectedProfile, generation);
      storage.setItem(originSyncKey(selectedProfile, sessionId), input.document.sha256);
      const activated = await requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}/commands`, {
        method: 'POST',
        selectedProfile,
        body: {
          commandId: `activate_${sessionId}`,
          type: 'session.activate',
          payload: { expectedVersion: Number(created.stateVersion) || 1 },
        },
      });
      const active = record(activated.session) ?? created;
      remoteSessions = [active, ...remoteSessions.filter((session) => session.id !== sessionId)];
      timelines.set(sessionId, input.timeline);
      scope = { threadId: input.threadId, documentId: input.documentId, selectedSessionId: sessionId };
      watch(sessionId);
      return snapshot();
    }),
    cloudCommand: (input: CloudCommandRequest) => readProfile(async () => {
      const selectedProfile = profile;
      if (!selectedProfile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
      const generation = profileGeneration;
      const serverType = COMMAND_TYPES[input.command];
      const attachments = [];
      for (const attachment of input.attachments ?? []) {
        const stored = await upload(
          attachment.bytes,
          attachment.name,
          'reference',
          input.sessionId,
          selectedProfile,
        );
        attachments.push({
          attachmentId: attachment.id, blobId: stored.blobId, size: stored.size,
          name: attachment.name, mimeType: attachment.mimeType,
        });
      }
      const messageId = input.messageId ?? randomId('message_');
      const payload = {
        ...(input.payload ?? {}),
        ...(input.command === 'queue-message' || input.command === 'redirect'
          ? {
            content: input.message,
            messageId,
            ...(input.command === 'redirect' ? { expectedVersion: input.expectedVersion } : {}),
            ...(attachments.length ? { attachments } : {}),
          }
          : { expectedVersion: input.expectedVersion }),
      };
      if (input.command === 'queue-message' && input.message) {
        queuedMessages.set(messageId, { id: messageId, text: input.message, queuedAt: new Date().toISOString(), state: 'queued' });
      }
      const commandId = input.command === 'queue-message'
        ? `message_${await sha256(utf8(`${input.sessionId}\0${messageId}`))}`
        : randomId('command_');
      let result: Record<string, unknown>;
      try {
        if (input.command === 'takeover') {
          let takeoverState = takeoverStates.get(input.sessionId);
          if (takeoverState && (takeoverState.generation !== profileGeneration
            || !sameProfileIdentity(takeoverState.profile, selectedProfile))) {
            takeoverStates.delete(input.sessionId);
            takeoverState = undefined;
          }
          if (!takeoverState) {
            let commandResult: Record<string, unknown> | null = null;
            let takeover: Record<string, unknown> | null = null;
            try {
              takeover = await requestJson(`/v1/sessions/${encodeURIComponent(input.sessionId)}/takeover`, {
                selectedProfile,
              });
            } catch (error) {
              const failure = error as BrowserCloudError;
              if (failure.status !== 404 && failure.code !== 'TAKEOVER_NOT_REQUESTED') throw error;
            }
            if (!takeover) {
              commandResult = await requestJson(`/v1/sessions/${encodeURIComponent(input.sessionId)}/commands`, {
                method: 'POST', body: { commandId, type: serverType, payload }, selectedProfile,
              });
              takeover = record(commandResult.takeover);
            }
            const deadline = Date.now() + 5 * 60_000;
            while (takeover?.status !== 'ready' && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 250));
              takeover = await requestJson(`/v1/sessions/${encodeURIComponent(input.sessionId)}/takeover`, {
                selectedProfile,
              });
            }
            const boundary = record(takeover?.boundary);
            const operationId = String(boundary?.operationId ?? '');
            if (!takeover || takeover.status !== 'ready' || !boundary || !operationId) {
              throw new Error('클라우드 이어받기 경계를 준비하지 못했습니다.');
            }
            requireCurrentProfile(selectedProfile, generation);
            takeoverState = {
              profile: selectedProfile,
              generation,
              receipt: takeover,
              boundary,
              session: record(commandResult?.session)
                ?? remoteSessions.find((session) => session.id === input.sessionId)
                ?? null,
            };
            takeoverStates.set(input.sessionId, takeoverState);
          }
          const operationId = String(takeoverState.boundary.operationId);
          if (!takeoverState.document) {
            const document = await downloadCheckpoint(input.sessionId, operationId, selectedProfile);
            const checkpointReceipt = record(takeoverState.boundary.checkpoint);
            if (document.operationId !== operationId
              || document.revision !== Number(takeoverState.boundary.revision)
              || document.turn !== Number(takeoverState.boundary.turnNumber)
              || document.sha256 !== checkpointReceipt?.blobId
              || document.byteLength !== Number(checkpointReceipt?.size)) {
              throw new Error('다운로드한 이어받기 문서가 고정된 Cloud 경계와 다릅니다.');
            }
            takeoverState.document = document;
          }
          if (takeoverState.timeline === undefined) {
            const timeline = await downloadTimelineArtifact(input.sessionId, selectedProfile);
            const timelineReceipt = record(takeoverState.boundary.timeline);
            if (timeline.boundaryOperation !== operationId
              || timeline.boundaryRevision !== Number(takeoverState.boundary.revision)
              || timeline.boundaryTurn !== Number(takeoverState.boundary.turnNumber)
              || timeline.sha256 !== timelineReceipt?.blobId
              || timeline.size !== Number(timelineReceipt?.size)) {
              throw new Error('다운로드한 이어받기 대화가 고정된 Cloud 경계와 다릅니다.');
            }
            takeoverState.timeline = timeline.timeline;
          }
          requireCurrentProfile(selectedProfile, takeoverState.generation);
          if (takeoverState.session) {
            remoteSessions = [
              { ...takeoverState.session, takeoverRequested: false, takeoverReady: true },
              ...remoteSessions.filter((session) => session.id !== input.sessionId),
            ];
          }
          const document = takeoverState.document;
          result = {
            takeover: takeoverState.receipt,
            ...(takeoverState.session ? { session: takeoverState.session } : {}),
          };
          return snapshot({
            takeover: {
              operationId,
              document: {
                bytes: document.bytes,
                fileName: document.fileName,
                sha256: document.sha256,
                byteLength: document.byteLength,
                recoveryPath: `indexeddb://${ARCHIVE_DATABASE}/${archiveId(selectedProfile, input.sessionId, operationId)}`,
                revision: document.revision,
                turn: document.turn,
              },
              timeline: takeoverState.timeline,
            },
          });
        }
        result = await requestJson(`/v1/sessions/${encodeURIComponent(input.sessionId)}/commands`, {
          method: 'POST', body: { commandId, type: serverType, payload }, selectedProfile,
        });
      } catch (error) {
        if (input.command === 'queue-message') queuedMessages.delete(messageId);
        throw error;
      }
      const updated = record(result.session);
      if (updated) remoteSessions = [updated, ...remoteSessions.filter((session) => session.id !== input.sessionId)];
      return snapshot();
    }),
    cloudDownloadCheckpoint: (payload: { sessionId: string; operationId?: string }) => readProfile(
      () => downloadCheckpoint(payload.sessionId, payload.operationId),
    ),
    cloudOpenDisplay: (payload: { sessionId: string }) => readProfile(() => displayManager.open(payload)),
    cloudCloseDisplay: (payload: { connectionId: string }) => readProfile(() => displayManager.close(payload)),
    cloudDisplayInput: (payload: { connectionId: string; event: CloudDisplayInputEvent }) => (
      readProfile(() => displayManager.sendInput(payload))
    ),
    cloudDownloadResult: (payload: { sessionId: string }) => readProfile(async () => {
      const selectedProfile = profile;
      if (!selectedProfile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
      const generation = profileGeneration;
      const existing = await getArchive(archiveId(selectedProfile, payload.sessionId, 'result'));
      const stored = existing
        ? { archive: existing, timeline: existing.timeline }
        : await archiveResult(payload.sessionId, selectedProfile, generation);
      requireCurrentProfile(selectedProfile, generation);
      return {
        sessionId: payload.sessionId,
        fileName: stored.archive.fileName,
        bytes: stored.archive.bytes,
        byteLength: stored.archive.bytes.byteLength,
        sha256: stored.archive.sha256,
        recoveryPath: `indexeddb://${ARCHIVE_DATABASE}/${archiveId(selectedProfile, payload.sessionId, 'result')}`,
        previewOpened: false,
        conflict: 'none',
        preservedCopyName: null,
        timeline: stored.timeline,
      };
    }),
    cloudResolveResult: (payload: { sessionId: string; action: string }) => readProfile(async () => {
      const selectedProfile = profile;
      if (!selectedProfile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
      const generation = profileGeneration;
      const archive = await getArchive(archiveId(selectedProfile, payload.sessionId, 'result'));
      requireCurrentProfile(selectedProfile, generation);
      if (!archive) throw new Error('로컬 Cloud 결과 보관본을 찾지 못했습니다.');
      const keepBoth = payload.action === 'keep-both';
      return {
        action: payload.action,
        path: payload.action === 'discard' ? null : `indexeddb://${ARCHIVE_DATABASE}/${archive.id}`,
        bytes: payload.action === 'discard' ? null : archive.bytes,
        conflict: 'none',
        preservedCopyName: keepBoth ? `${archive.fileName.replace(/(\.[^.]+)?$/, '')} (cloud copy)$1` : null,
        snapshot: snapshot(),
      };
    }),
    cloudDismissSession: (payload: { sessionId: string }) => readProfile(async () => {
      dismissed.add(payload.sessionId);
      return snapshot();
    }),
    cloudCompleteTakeover: (payload: { sessionId: string; operationId: string }) => readProfile(async () => {
      const selectedProfile = profile;
      if (!selectedProfile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
      const operationId = String(payload.operationId ?? '').trim();
      if (!operationId) throw new Error('이어받기 완료 영수증에 고정된 작업 경계가 없습니다.');
      const state = takeoverStates.get(payload.sessionId);
      const session = remoteSessions.find((candidate) => candidate.id === payload.sessionId);
      const currentOperationId = String(record(session?.takeoverBoundary)?.operationId
        ?? state?.boundary.operationId
        ?? '');
      storage.setItem(takeoverCompleteKey(selectedProfile, payload.sessionId, operationId), '1');
      completedTakeovers.add(takeoverCompletionId(payload.sessionId, operationId));
      if (String(state?.boundary.operationId ?? '') === operationId) takeoverStates.delete(payload.sessionId);
      if (currentOperationId === operationId) {
        remoteSessions = remoteSessions.map((candidate) => candidate.id === payload.sessionId
          ? { ...candidate, takeoverRequested: false, takeoverReady: false }
          : candidate);
      }
      return snapshot();
    }),
    onCloudEvent(callback: (event: unknown) => void) {
      eventListener = callback;
      return () => {
        if (eventListener === callback) eventListener = null;
        for (const watcher of watchers.values()) watcher.abort();
      };
    },
    onCloudDisplayEvent: (callback: (event: unknown) => void) => displayManager.subscribe(callback),
  };
}

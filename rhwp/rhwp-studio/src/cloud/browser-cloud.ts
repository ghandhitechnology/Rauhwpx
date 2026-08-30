import type {
  CloudCommandRequest,
  CloudFollowupAttachment,
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
  display?: CloudDisplayConnectionOptions;
};

type BrowserCloudError = Error & { status?: number; code?: string; retryable?: boolean };
type BrowserRefreshState = {
  profile: BrowserProfile;
  generation: number;
  refreshToken: string;
  promise: Promise<TokenBundle>;
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

function storedProfile(storage: Storage): BrowserProfile | null {
  try {
    const parsed = record(JSON.parse(storage.getItem(PROFILE_KEY) ?? 'null'));
    return typeof parsed?.endpoint === 'string' && typeof parsed.serverPublicKey === 'string'
      ? parsed as unknown as BrowserProfile
      : null;
  } catch {
    return null;
  }
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

  try {
    const rawProfile = storage.getItem(PROFILE_KEY);
    const rawTokens = storage.getItem(TOKENS_KEY);
    profile = rawProfile ? JSON.parse(rawProfile) : null;
    tokens = rawTokens ? JSON.parse(rawTokens) : null;
  } catch {
    profile = null;
    tokens = null;
  }

  const ownDeviceId = () => typeof tokens?.device?.id === 'string' ? tokens.device.id : null;
  const requireCurrentProfile = (selectedProfile: BrowserProfile, generation: number) => {
    if (generation !== profileGeneration || !sameProfileIdentity(selectedProfile, profile)) {
      throw cloudError('Cloud 프로필이 작업 중 변경됐습니다.', 'PROFILE_CHANGED');
    }
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
    const preferredMode = storage.getItem(MODE_KEY) === 'app-hosted' ? 'app-hosted' : 'self-hosted';
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

  const ensureAccessToken = async (
    selectedProfile: BrowserProfile,
    generation: number,
    signal?: AbortSignal,
  ): Promise<TokenBundle> => {
    if (generation !== profileGeneration || !sameProfileIdentity(selectedProfile, profile)) {
      throw cloudError('Cloud 프로필이 요청 인증 중 변경됐습니다.', 'PROFILE_CHANGED');
    }
    const expiry = typeof tokens?.accessExpiresAt === 'number'
      ? tokens.accessExpiresAt : Date.parse(String(tokens?.accessExpiresAt ?? ''));
    if (tokens?.accessToken && Number.isFinite(expiry) && expiry > Date.now() + 15_000) return tokens;
    const capturedTokens = tokens ? { ...tokens } : null;
    const refreshToken = capturedTokens?.refreshToken ?? '';
    if (!refreshToken) throw cloudError('Cloud 페어링이 필요합니다.', 'PAIRING_REQUIRED');
    let state = refreshState;
    if (!state || state.generation !== generation
      || state.refreshToken !== refreshToken
      || !sameProfileIdentity(state.profile, selectedProfile)) {
      const promise = (async (): Promise<TokenBundle> => {
        const refreshed = await requestJson('/v1/token/refresh', {
          method: 'POST',
          auth: false,
          body: { refreshToken },
          selectedProfile,
        });
        const accessToken = String(refreshed.accessToken ?? '');
        const nextRefreshToken = String(refreshed.refreshToken ?? '');
        const nextExpiry = typeof refreshed.accessExpiresAt === 'number'
          ? refreshed.accessExpiresAt : Date.parse(String(refreshed.accessExpiresAt ?? ''));
        if (!accessToken || !nextRefreshToken || !Number.isFinite(nextExpiry)) {
          throw cloudError('Cloud 토큰 응답이 잘못됐습니다.', 'TOKEN_RESPONSE_INVALID');
        }
        if (generation !== profileGeneration || !sameProfileIdentity(selectedProfile, profile)
          || tokens?.refreshToken !== refreshToken) {
          throw cloudError('Cloud 프로필이 토큰 갱신 중 변경됐습니다.', 'PROFILE_CHANGED');
        }
        const next = { ...capturedTokens, ...refreshed } as TokenBundle;
        tokens = next;
        storage.setItem(TOKENS_KEY, JSON.stringify(next));
        return next;
      })();
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
          tokens = { ...tokens, accessExpiresAt: 0 };
          await ensureAccessToken(selectedProfile, generation, signal);
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

  const health = async (draft: CloudProfileDraft): Promise<BrowserProfile> => {
    const endpoint = exactEndpoint(draft);
    const url = new URL(`${endpoint}/v1/health`);
    const response = await fetchImpl(url, { cache: 'no-store' });
    const raw = await response.json() as Record<string, unknown>;
    if (!response.ok || raw.protocolVersion !== 1 || typeof raw.serverPublicKey !== 'string') {
      throw new Error('지원하는 Rauhwpx Cloud 서버가 아닙니다.');
    }
    if (draft.serverPublicKey && draft.serverPublicKey !== raw.serverPublicKey) {
      throw new Error('Cloud 서버 키가 저장된 신원과 다릅니다.');
    }
    serviceVersion = typeof raw.version === 'string' ? raw.version : null;
    return { ...draft, endpoint, serverPublicKey: raw.serverPublicKey };
  };

  const fetchRemoteSessions = async (): Promise<void> => {
    if (!profile || !tokens?.refreshToken) return;
    const selectedProfile = profile;
    const generation = profileGeneration;
    const payload = await requestJson('/v1/sessions', { selectedProfile });
    const fetched = Array.isArray(payload.sessions)
      ? payload.sessions.filter((entry): entry is Record<string, unknown> => Boolean(record(entry)))
      : [];
    const nextSessions = await Promise.all(fetched.map(async (session) => {
      const sessionId = String(session.id ?? '');
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
      if (!archive?.session) return session;
      const restored = { ...archive.session, browserArchived: true };
      archivedSessions.set(sessionId, restored);
      return restored;
    }));
    requireCurrentProfile(selectedProfile, generation);
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

  const downloadTimelineArtifact = async (sessionId: string, selectedProfile = profile) => {
    if (!selectedProfile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
    const generation = profileGeneration;
    const result = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/timeline`, {
      maxBytes: MAX_TIMELINE_BYTES,
      selectedProfile,
    });
    if (!result.bytes || result.bytes.byteLength > MAX_TIMELINE_BYTES) throw new Error('Cloud 타임라인이 잘못됐습니다.');
    const expected = result.response.headers.get('x-content-sha256');
    if (!expected || expected !== await sha256(result.bytes)) throw new Error('Cloud 타임라인 무결성 검증에 실패했습니다.');
    const timeline = JSON.parse(new TextDecoder().decode(result.bytes));
    requireCurrentProfile(selectedProfile, generation);
    return {
      timeline,
      sha256: expected,
      size: result.bytes.byteLength,
      boundaryOperation: result.response.headers.get('x-boundary-operation') ?? '',
      boundaryRevision: Number(result.response.headers.get('x-boundary-revision')) || 0,
      boundaryTurn: Number(result.response.headers.get('x-boundary-turn')) || 0,
    };
  };
  const downloadTimeline = async (sessionId: string, selectedProfile = profile) => (
    (await downloadTimelineArtifact(sessionId, selectedProfile)).timeline
  );

  const downloadCheckpoint = async (
    sessionId: string,
    operationId?: string,
    selectedProfile = profile,
  ) => {
    if (!selectedProfile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
    const generation = profileGeneration;
    const query = operationId ? `?operationId=${encodeURIComponent(operationId)}` : '';
    const result = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/checkpoint${query}`, {
      maxBytes: MAX_DOCUMENT_BYTES,
      selectedProfile,
    });
    if (!result.bytes || !result.bytes.byteLength || result.bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error('Cloud 체크포인트 크기가 잘못됐습니다.');
    }
    const expected = result.response.headers.get('x-content-sha256') ?? '';
    if (expected !== await sha256(result.bytes)) throw new Error('Cloud 체크포인트 무결성 검증에 실패했습니다.');
    requireCurrentProfile(selectedProfile, generation);
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
    }
    requireCurrentProfile(selectedProfile, generation);
    return checkpoint;
  };

  const archiveResult = async (
    sessionId: string,
    selectedProfile = profile,
    generation = profileGeneration,
  ) => {
    if (!selectedProfile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
    const result = await request(`/v1/results/${encodeURIComponent(sessionId)}`, {
      maxBytes: MAX_DOCUMENT_BYTES,
      selectedProfile,
    });
    if (!result.bytes?.byteLength) throw new Error('Cloud 결과가 비어 있습니다.');
    const digest = result.response.headers.get('x-content-sha256') ?? '';
    if (digest !== await sha256(result.bytes)) throw new Error('Cloud 결과 무결성 검증에 실패했습니다.');
    requireCurrentProfile(selectedProfile, generation);
    const remote = remoteSessions.find((session) => session.id === sessionId);
    const name = String(record(remote?.originDocument)?.name ?? 'cloud-result.hwpx');
    const downloadedTimeline = await downloadTimeline(sessionId, selectedProfile);
    const archive: BrowserArchive = {
      id: archiveId(selectedProfile, sessionId, 'result'), sessionId, operationId: 'result', kind: 'result',
      fileName: name, sha256: digest, revision: 0, turn: Number(remote?.turnsUsed) || 0,
      bytes: result.bytes,
      timeline: downloadedTimeline,
      ...(remote ? { session: { ...remote, browserArchived: true } } : {}),
      createdAt: new Date().toISOString(),
    };
    await putArchive(archive);
    requireCurrentProfile(selectedProfile, generation);
    if (remote) {
      const local = { ...remote, browserArchived: true };
      archivedSessions.set(sessionId, local);
      remoteSessions = [local, ...remoteSessions.filter((session) => session.id !== sessionId)];
    }
    await requestJson(`/v1/results/${encodeURIComponent(sessionId)}/download-confirmed`, {
      method: 'POST', body: { sha256: digest, size: result.bytes.byteLength }, selectedProfile,
    });
    requireCurrentProfile(selectedProfile, generation);
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

  let profileChangeChain = Promise.resolve();
  const resetServerState = () => {
    for (const watcher of watchers.values()) watcher.abort();
    watchers.clear();
    remoteSessions = [];
    timelines.clear();
    eventSequences.clear();
    queuedMessages.clear();
    dismissed.clear();
    archivedSessions.clear();
    completedTakeovers.clear();
    takeoverStates.clear();
    scope = { threadId: '', documentId: null };
    refreshState = null;
    connection = 'unknown';
    connectionMessage = null;
  };
  const changeProfile = <T>(operation: () => Promise<T>): Promise<T> => {
    const change = profileChangeChain.then(async () => {
      for (const watcher of watchers.values()) watcher.abort();
      await displayManager.closeActive();
      profileGeneration += 1;
      resetServerState();
      return operation();
    }, async () => {
      for (const watcher of watchers.values()) watcher.abort();
      await displayManager.closeActive();
      profileGeneration += 1;
      resetServerState();
      return operation();
    });
    profileChangeChain = change.then(() => {}, () => {});
    return change;
  };

  const watch = (sessionId: string) => {
    if (watchers.has(sessionId) || !profile) return;
    const controller = new AbortController();
    const generation = profileGeneration;
    const selectedProfile = profile;
    watchers.set(sessionId, controller);
    void (async () => {
      let failures = 0;
      while (!controller.signal.aborted && generation === profileGeneration
        && sameProfileIdentity(selectedProfile, profile)) {
        try {
          const after = eventSequences.get(sessionId) ?? 0;
          const stream = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`, {
            headers: { Accept: 'text/event-stream' }, stream: true, signal: controller.signal, selectedProfile,
          });
          requireCurrentProfile(selectedProfile, generation);
          if (!stream.response.body || !stream.context) throw new Error('Cloud 이벤트 스트림을 열지 못했습니다.');
          const reader = stream.response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            requireCurrentProfile(selectedProfile, generation);
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSse(buffer);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
              const sequence = await verifySseFrame(frame, stream.context, selectedProfile);
              requireCurrentProfile(selectedProfile, generation);
              if (sequence <= (eventSequences.get(sessionId) ?? 0)) continue;
              const event = JSON.parse(frame.data) as Record<string, unknown>;
              const messageId = String(record(event.payload)?.messageId ?? '');
              if (event.type === 'message.accepted' && messageId && queuedMessages.has(messageId)) {
                queuedMessages.set(messageId, { ...queuedMessages.get(messageId)!, state: 'accepted' });
              }
              if (event.type !== 'agent.event') await fetchRemoteSessions();
              requireCurrentProfile(selectedProfile, generation);
              emit({ type: 'remote-session-event', sessionId, event }, generation);
              if (event.type === 'boundary.committed') {
                const operationId = String(record(event.payload)?.operationId ?? '');
                if (operationId) await downloadCheckpoint(sessionId, operationId, selectedProfile);
              }
              if (event.type === 'timeline.updated') {
                let downloaded = null;
                try {
                  downloaded = await downloadTimeline(sessionId, selectedProfile);
                } catch (error) {
                  if ((error as BrowserCloudError).code === 'PROFILE_CHANGED') throw error;
                }
                requireCurrentProfile(selectedProfile, generation);
                if (downloaded) timelines.set(sessionId, downloaded);
              }
              if (event.type === 'session.completed') {
                const completed = remoteSessions.find((session) => session.id === sessionId);
                if (completed && String(completed.originDeviceId ?? '') === ownDeviceId()) {
                  await archiveResult(sessionId, selectedProfile, generation);
                  requireCurrentProfile(selectedProfile, generation);
                  emit({ type: 'conversation-result-archived', sessionId }, generation);
                }
              }
              requireCurrentProfile(selectedProfile, generation);
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
    cloudGetState: (payload: CloudSessionScope) => refresh(payload),
    async cloudTestProfile(payload: { profile?: CloudProfileDraft }) {
      const generation = profileGeneration;
      connection = 'testing';
      const candidate = await health(payload.profile ?? profile!);
      if (generation !== profileGeneration) throw cloudError('Cloud 프로필이 작업 중 변경됐습니다.', 'PROFILE_CHANGED');
      connection = 'ready';
      serviceVersion ||= null;
      return snapshot({ testedServerPublicKey: candidate.serverPublicKey });
    },
    async cloudSaveProfile(payload: { profile: CloudProfileDraft }) {
      const candidate = await health(payload.profile);
      return changeProfile(async () => {
        if (profile?.serverPublicKey !== candidate.serverPublicKey) {
          tokens = null;
          storage.removeItem(TOKENS_KEY);
        }
        profile = candidate;
        storage.setItem(PROFILE_KEY, JSON.stringify(profile));
        connection = tokens ? 'ready' : 'unknown';
        return refresh();
      });
    },
    async cloudPair(payload: { code: string; profile?: CloudProfileDraft }) {
      const candidate = await health(payload.profile ?? profile!);
      return changeProfile(async () => {
        const paired = await requestJson('/v1/pairing/redeem', {
          method: 'POST',
          auth: false,
          selectedProfile: candidate,
          body: {
            code: payload.code.trim().toUpperCase(),
            deviceName: navigator.userAgent.includes('Mobile') ? 'Rauhwpx PWA mobile' : 'Rauhwpx PWA browser',
            requestId: randomId('pair_'),
          },
        });
        profile = candidate;
        tokens = paired as TokenBundle;
        storage.setItem(PROFILE_KEY, JSON.stringify(profile));
        storage.setItem(TOKENS_KEY, JSON.stringify(tokens));
        connection = 'ready';
        return refresh();
      });
    },
    async cloudSelectServerMode(payload: { mode: string }) {
      storage.setItem(MODE_KEY, payload.mode === 'app-hosted' ? 'app-hosted' : 'self-hosted');
      return snapshot();
    },
    cloudProvision: async () => { throw new Error('브라우저에서는 Cloud 서버를 설치할 수 없습니다. 기존 HTTPS 서버와 페어링해 주세요.'); },
    cloudSpawnSandbox: async () => { throw new Error('브라우저 PWA에서는 앱 제공 서버를 만들 수 없습니다.'); },
    cloudSandboxStatus: () => refresh(),
    cloudTeardownSandbox: async () => ({ snapshot: snapshot(), removed: false, unmanaged: true }),
    cloudSetTransferIntent: () => Promise.resolve(snapshot()),
    async cloudReadReference(reference: Pick<CloudTransferReference, 'id' | 'scope' | 'scopeId'>) {
      if (!options.readReference) throw new Error('브라우저 참고자료를 읽을 수 없습니다.');
      return { bytes: await options.readReference(reference) };
    },
    async cloudTransfer(input: CloudTransferRequest) {
      if (!profile || !tokens) throw new Error('Cloud 페어링이 필요합니다.');
      const selectedProfile = profile;
      const generation = profileGeneration;
      const sessionId = randomId('pwa_');
      const document = await upload(input.document.bytes, input.document.fileName, 'document', sessionId, selectedProfile);
      const resources = [];
      for (const reference of input.references) {
        const stored = await upload(reference.bytes, reference.name, 'reference', sessionId, selectedProfile);
        resources.push({ name: reference.name, blobId: stored.blobId, size: stored.size, kind: 'reference' });
      }
      const timelineBytes = utf8(JSON.stringify(input.timeline));
      const timelineUpload = await upload(timelineBytes, 'timeline.json', 'timeline', sessionId, selectedProfile);
      const latestUser = [...input.timeline.thread.messages].reverse()
        .find((message) => message.role === 'user' && message.text.trim());
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
          goal: latestUser?.text ?? 'Continue the document task.',
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
    },
    async cloudCommand(input: CloudCommandRequest) {
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
    },
    async cloudDownloadCheckpoint(payload: { sessionId: string; operationId?: string }) {
      return downloadCheckpoint(payload.sessionId, payload.operationId);
    },
    cloudOpenDisplay: async (payload: { sessionId: string }) => {
      await profileChangeChain;
      return displayManager.open(payload);
    },
    cloudCloseDisplay: (payload: { connectionId: string }) => displayManager.close(payload),
    async cloudDownloadResult(payload: { sessionId: string }) {
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
    },
    async cloudResolveResult(payload: { sessionId: string; action: string }) {
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
    },
    async cloudDismissSession(payload: { sessionId: string }) {
      dismissed.add(payload.sessionId);
      return snapshot();
    },
    cloudCompleteTakeover: (payload: { sessionId: string }) => {
      if (!profile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
      const state = takeoverStates.get(payload.sessionId);
      const session = remoteSessions.find((candidate) => candidate.id === payload.sessionId);
      const operationId = String(state?.boundary.operationId
        ?? record(session?.takeoverBoundary)?.operationId
        ?? '');
      if (!operationId) throw new Error('이어받기 완료 영수증에 고정된 작업 경계가 없습니다.');
      storage.setItem(takeoverCompleteKey(profile, payload.sessionId, operationId), '1');
      completedTakeovers.add(takeoverCompletionId(payload.sessionId, operationId));
      takeoverStates.delete(payload.sessionId);
      remoteSessions = remoteSessions.map((session) => session.id === payload.sessionId
        ? { ...session, takeoverRequested: false, takeoverReady: false }
        : session);
      return Promise.resolve(snapshot());
    },
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

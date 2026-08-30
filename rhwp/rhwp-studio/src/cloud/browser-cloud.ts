import type {
  CloudCommandRequest,
  CloudFollowupAttachment,
  CloudProfileDraft,
  CloudSessionScope,
  CloudTransferReference,
  CloudTransferRequest,
} from './types.ts';

const PROFILE_KEY = 'rauhwpx.cloud.browser.profile.v1';
const TOKENS_KEY = 'rauhwpx.cloud.browser.tokens.v1';
const MODE_KEY = 'rauhwpx.cloud.browser.mode.v1';
const ORIGIN_SYNC_KEY_PREFIX = 'rauhwpx.cloud.browser.origin-sync.v1.';
const ARCHIVE_DATABASE = 'rauhwpx-cloud-browser-archives';
const RESPONSE_VERSION = 'RAUHWpx-response-v1';
const SSE_VERSION = 'RAUHWpx-sse-event-v1';
const SSE_PROTOCOL = 'rauhwpx-sse-v1';
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_TIMELINE_BYTES = 100 * 1024 * 1024;
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
};

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

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
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

function archiveId(sessionId: string, operationId: string): string {
  return `${sessionId}:${operationId}`;
}

function originSyncKey(sessionId: string): string {
  return `${ORIGIN_SYNC_KEY_PREFIX}${sessionId}`;
}

export function browserOriginSyncDigest(sessionId: string): string | null {
  const value = safeStorage()?.getItem(originSyncKey(sessionId)) ?? null;
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function setBrowserOriginSyncDigest(sessionId: string, digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) return;
  safeStorage()?.setItem(originSyncKey(sessionId), digest);
}

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
  let timeline: unknown = null;
  let eventListener: ((event: unknown) => void) | null = null;
  const watchers = new Map<string, AbortController>();
  const eventSequences = new Map<string, number>();
  const queuedMessages = new Map<string, { id: string; text: string; queuedAt: string; state: 'queued' | 'accepted' }>();
  const dismissed = new Set<string>();
  const archivedSessions = new Map<string, Record<string, unknown>>();
  let refreshPromise: Promise<void> | null = null;

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
  const selectedSessions = () => remoteSessions.filter((session) => {
    if (dismissed.has(String(session.id ?? ''))) return false;
    const context = record(session.clientContext);
    return (scope.threadId && context?.threadId === scope.threadId)
      || (scope.documentId && context?.documentId === scope.documentId)
      || scope.selectedSessionId === session.id;
  });
  const snapshot = (extra: Record<string, unknown> = {}) => {
    const candidates = selectedSessions().map((session) => publicSession(session, ownDeviceId()));
    const selected = scope.selectedSessionId
      ? candidates.find((session) => session.sessionId === scope.selectedSessionId)
      : candidates.find((session) => !['completed', 'failed', 'cancelled'].includes(session.kind)) ?? candidates[0];
    const active = selected && !['completed', 'failed', 'cancelled'].includes(selected.kind) ? selected : null;
    const preferredMode = storage.getItem(MODE_KEY) === 'app-hosted' ? 'app-hosted' : 'self-hosted';
    return {
      revision: ++revision,
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
      lease: active
        ? {
          owner: 'cloud',
          sessionId: active.sessionId,
          acquiredAt: 'startedAt' in active ? String(active.startedAt) : new Date().toISOString(),
        }
        : { owner: 'local' },
      session: selected ?? { kind: 'idle' },
      sessions: candidates,
      queuedMessages: [...queuedMessages.values()],
      timeline,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
  };

  const emit = (event: Record<string, unknown>) => eventListener?.({ ...event, snapshot: snapshot() });

  const publicKey = async (serverPublicKey: string): Promise<CryptoKey> => {
    const encoded = serverPublicKey.replace(/^ed25519:/, '');
    return globalThis.crypto.subtle.importKey(
      'spki', exactBuffer(fromBase64Url(encoded)), { name: 'Ed25519' }, false, ['verify'],
    );
  };

  const verifyProof = async (
    response: Response,
    selectedProfile: BrowserProfile,
    nonce: string,
    method: string,
    pathAndQuery: string,
    digest: string,
  ) => {
    if (response.headers.get('x-rauhwpx-server-key') !== selectedProfile.serverPublicKey) {
      throw new Error('Cloud 서버 신원이 페어링한 서버와 다릅니다.');
    }
    if (response.headers.get('x-rauhwpx-content-sha256') !== digest) {
      throw new Error('Cloud 응답 무결성 증명이 일치하지 않습니다.');
    }
    const signature = response.headers.get('x-rauhwpx-response-signature') ?? '';
    const canonical = `${RESPONSE_VERSION}\n${nonce}\n${method}\n${pathAndQuery}\n${response.status}\n${digest}`;
    const valid = await globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      await publicKey(selectedProfile.serverPublicKey),
      exactBuffer(fromBase64Url(signature)),
      exactBuffer(utf8(canonical)),
    );
    if (!valid) throw new Error('Cloud 응답 서명이 잘못됐습니다.');
  };

  const refreshTokens = async (): Promise<void> => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      if (!profile || !tokens?.refreshToken) throw new Error('Cloud 페어링이 필요합니다.');
      const refreshed = await requestJson('/v1/token/refresh', {
        method: 'POST', auth: false, body: { refreshToken: tokens.refreshToken }, selectedProfile: profile,
      });
      tokens = { ...tokens, ...refreshed } as TokenBundle;
      storage.setItem(TOKENS_KEY, JSON.stringify(tokens));
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  };

  const request = async (pathname: string, {
    method = 'GET',
    body,
    rawBody,
    headers: inputHeaders,
    auth = true,
    selectedProfile = profile,
    stream = false,
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
    retried?: boolean;
    signal?: AbortSignal;
  } = {}) => {
    if (!selectedProfile) throw new Error('Cloud 서버를 먼저 연결해 주세요.');
    if (auth) {
      const expiry = typeof tokens?.accessExpiresAt === 'number'
        ? tokens.accessExpiresAt : Date.parse(String(tokens?.accessExpiresAt ?? ''));
      if (!tokens?.accessToken || !Number.isFinite(expiry) || expiry <= Date.now() + 15_000) await refreshTokens();
    }
    const url = new URL(`${selectedProfile.endpoint}${pathname}`);
    const nonce = base64Url(globalThis.crypto.getRandomValues(new Uint8Array(24)));
    const headers = new Headers(inputHeaders);
    headers.set('X-Rauhwpx-Request-Nonce', nonce);
    if (auth && tokens?.accessToken) headers.set('Authorization', `Bearer ${tokens.accessToken}`);
    let requestBody: BodyInit | undefined;
    if (rawBody) requestBody = rawBody as BodyInit;
    else if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      requestBody = JSON.stringify(body);
    }
    const response = await fetchImpl(url, { method, headers, body: requestBody, signal, cache: 'no-store' });
    if (auth && response.status === 401 && !retried) {
      await refreshTokens();
      return request(pathname, {
        method, body, rawBody, headers: inputHeaders, auth, selectedProfile, stream, retried: true, signal,
      });
    }
    const context = { nonce, method, pathAndQuery: `${url.pathname}${url.search}` };
    if (stream) {
      const digest = await sha256(utf8(SSE_PROTOCOL));
      await verifyProof(response, selectedProfile, nonce, method, context.pathAndQuery, digest);
      if (!response.ok) throw new Error(`Cloud 요청이 실패했습니다 (${response.status}).`);
      return { response, bytes: null, context };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await verifyProof(response, selectedProfile, nonce, method, context.pathAndQuery, await sha256(bytes));
    let parsed: unknown = {};
    if (bytes.byteLength) {
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { parsed = null; }
    }
    if (!response.ok) {
      const error = record(record(parsed)?.error);
      const failure = new Error(String(error?.message ?? `Cloud 요청이 실패했습니다 (${response.status}).`));
      Object.assign(failure, { status: response.status, code: error?.code, details: error?.details });
      throw failure;
    }
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
    const payload = await requestJson('/v1/sessions');
    const fetched = Array.isArray(payload.sessions)
      ? payload.sessions.filter((entry): entry is Record<string, unknown> => Boolean(record(entry)))
      : [];
    remoteSessions = await Promise.all(fetched.map(async (session) => {
      if (session.status !== 'purged') return session;
      const sessionId = String(session.id);
      const memory = archivedSessions.get(sessionId);
      if (memory) return memory;
      const archive = await getArchive(archiveId(sessionId, 'result'));
      if (!archive?.session) return session;
      const restored = { ...archive.session, browserArchived: true };
      archivedSessions.set(sessionId, restored);
      return restored;
    }));
    connection = 'ready';
    connectionMessage = null;
  };

  const upload = async (bytes: Uint8Array, name: string, kind: string, sessionId: string) => {
    const digest = await sha256(bytes);
    let state = await requestJson('/v1/uploads/init', {
      method: 'POST', body: { sha256: digest, size: bytes.byteLength, name, kind, sessionId },
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
      });
    }
    return { blobId: String(record(state.blob)?.id ?? digest), sha256: digest, size: bytes.byteLength };
  };

  const downloadTimeline = async (sessionId: string) => {
    const result = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/timeline`);
    if (!result.bytes || result.bytes.byteLength > MAX_TIMELINE_BYTES) throw new Error('Cloud 타임라인이 잘못됐습니다.');
    const expected = result.response.headers.get('x-content-sha256');
    if (!expected || expected !== await sha256(result.bytes)) throw new Error('Cloud 타임라인 무결성 검증에 실패했습니다.');
    return JSON.parse(new TextDecoder().decode(result.bytes));
  };

  const downloadCheckpoint = async (sessionId: string, operationId?: string) => {
    const query = operationId ? `?operationId=${encodeURIComponent(operationId)}` : '';
    const result = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/checkpoint${query}`);
    if (!result.bytes || !result.bytes.byteLength || result.bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error('Cloud 체크포인트 크기가 잘못됐습니다.');
    }
    const expected = result.response.headers.get('x-content-sha256') ?? '';
    if (expected !== await sha256(result.bytes)) throw new Error('Cloud 체크포인트 무결성 검증에 실패했습니다.');
    const boundaryOperation = result.response.headers.get('x-boundary-operation') ?? '';
    const boundaryKind = result.response.headers.get('x-boundary-kind');
    if (boundaryKind !== 'handoff' && boundaryKind !== 'operation' && boundaryKind !== 'turn') {
      throw new Error('Cloud 체크포인트 경계 종류가 잘못됐습니다.');
    }
    const encodedName = result.response.headers.get('x-document-name') ?? 'cloud-document.hwpx';
    let fileName = encodedName;
    try { fileName = decodeURIComponent(encodedName); } catch {}
    const checkpoint = {
      sessionId,
      fileName,
      bytes: result.bytes,
      byteLength: result.bytes.byteLength,
      sha256: expected,
      revision: Number(result.response.headers.get('x-checkpoint-revision')) || 0,
      turn: Number(result.response.headers.get('x-checkpoint-turn')) || 0,
      operationId: boundaryOperation,
      kind: boundaryKind,
      originOnThisDevice: String(remoteSessions.find((session) => session.id === sessionId)?.originDeviceId ?? '') === ownDeviceId(),
      expectedOriginSha256: storage.getItem(originSyncKey(sessionId)) ?? undefined,
    };
    if (boundaryKind === 'turn') {
      await putArchive({
        id: archiveId(sessionId, boundaryOperation),
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
    return checkpoint;
  };

  const archiveResult = async (sessionId: string) => {
    const result = await request(`/v1/results/${encodeURIComponent(sessionId)}`);
    if (!result.bytes?.byteLength) throw new Error('Cloud 결과가 비어 있습니다.');
    const digest = result.response.headers.get('x-content-sha256') ?? '';
    if (digest !== await sha256(result.bytes)) throw new Error('Cloud 결과 무결성 검증에 실패했습니다.');
    const remote = remoteSessions.find((session) => session.id === sessionId);
    const name = String(record(remote?.originDocument)?.name ?? 'cloud-result.hwpx');
    const downloadedTimeline = await downloadTimeline(sessionId);
    const archive: BrowserArchive = {
      id: archiveId(sessionId, 'result'), sessionId, operationId: 'result', kind: 'result',
      fileName: name, sha256: digest, revision: 0, turn: Number(remote?.turnsUsed) || 0,
      bytes: result.bytes,
      timeline: downloadedTimeline,
      ...(remote ? { session: { ...remote, browserArchived: true } } : {}),
      createdAt: new Date().toISOString(),
    };
    await putArchive(archive);
    if (remote) {
      const local = { ...remote, browserArchived: true };
      archivedSessions.set(sessionId, local);
      remoteSessions = [local, ...remoteSessions.filter((session) => session.id !== sessionId)];
    }
    await requestJson(`/v1/results/${encodeURIComponent(sessionId)}/download-confirmed`, {
      method: 'POST', body: { sha256: digest, size: result.bytes.byteLength },
    });
    timeline = downloadedTimeline;
    return { archive, timeline: downloadedTimeline };
  };

  const parseSse = (buffer: string) => {
    const frames: Array<{ id: string; event: string; digest: string; signature: string; data: string }> = [];
    let rest = buffer.replace(/\r\n/g, '\n');
    let boundary = rest.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = rest.slice(0, boundary);
      rest = rest.slice(boundary + 2);
      const fields = { id: '', event: 'message', digest: '', signature: '', data: [] as string[] };
      for (const line of raw.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const key = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
        if (key === 'id') fields.id = value;
        else if (key === 'event') fields.event = value;
        else if (key === 'rauhwpx-sha256') fields.digest = value;
        else if (key === 'rauhwpx-signature') fields.signature = value;
        else if (key === 'data') fields.data.push(value);
      }
      if (fields.data.length) frames.push({ ...fields, data: fields.data.join('\n') });
      boundary = rest.indexOf('\n\n');
    }
    return { frames, rest };
  };

  const watch = (sessionId: string) => {
    if (watchers.has(sessionId) || !profile) return;
    const controller = new AbortController();
    watchers.set(sessionId, controller);
    void (async () => {
      let failures = 0;
      while (!controller.signal.aborted && profile) {
        try {
          const after = eventSequences.get(sessionId) ?? 0;
          const stream = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`, {
            headers: { Accept: 'text/event-stream' }, stream: true, signal: controller.signal,
          });
          if (!stream.response.body || !stream.context) throw new Error('Cloud 이벤트 스트림을 열지 못했습니다.');
          const reader = stream.response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSse(buffer);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
              const sequence = Number(frame.id);
              const digest = await sha256(utf8(frame.data));
              const canonical = `${SSE_VERSION}\n${stream.context.nonce}\nGET\n${stream.context.pathAndQuery}\n200\n${sequence}\n${frame.event}\n${digest}`;
              const valid = digest === frame.digest && await globalThis.crypto.subtle.verify(
                { name: 'Ed25519' }, await publicKey(profile.serverPublicKey),
                exactBuffer(fromBase64Url(frame.signature)), exactBuffer(utf8(canonical)),
              );
              if (!valid || !Number.isSafeInteger(sequence)) throw new Error('Cloud 스트림 서명이 잘못됐습니다.');
              if (sequence <= (eventSequences.get(sessionId) ?? 0)) continue;
              eventSequences.set(sessionId, sequence);
              const event = JSON.parse(frame.data) as Record<string, unknown>;
              const messageId = String(record(event.payload)?.messageId ?? '');
              if (event.type === 'message.accepted' && messageId && queuedMessages.has(messageId)) {
                queuedMessages.set(messageId, { ...queuedMessages.get(messageId)!, state: 'accepted' });
              }
              if (event.type !== 'agent.event') await fetchRemoteSessions();
              emit({ type: 'remote-session-event', sessionId, event });
              if (event.type === 'boundary.committed') {
                const operationId = String(record(event.payload)?.operationId ?? '');
                if (operationId) void downloadCheckpoint(sessionId, operationId).catch(() => {});
              }
              if (event.type === 'timeline.updated') {
                timeline = await downloadTimeline(sessionId).catch(() => timeline);
              }
              if (event.type === 'session.completed') {
                const completed = remoteSessions.find((session) => session.id === sessionId);
                if (completed && String(completed.originDeviceId ?? '') === ownDeviceId()) {
                  await archiveResult(sessionId);
                  emit({ type: 'conversation-result-archived', sessionId });
                }
              }
            }
          }
          failures = 0;
        } catch (error) {
          if (controller.signal.aborted) break;
          failures += 1;
          if (failures >= 20) {
            emit({ type: 'remote-session-stream-error', sessionId, error: error instanceof Error ? error.message : String(error) });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 250 * 2 ** failures)));
        }
      }
    })().finally(() => watchers.delete(sessionId));
  };

  const refresh = async (nextScope = scope) => {
    scope = nextScope;
    if (profile && tokens?.refreshToken) {
      try {
        await fetchRemoteSessions();
        for (const session of selectedSessions()) {
          if (session.status === 'queued' || session.status === 'running') watch(String(session.id));
        }
      } catch (error) {
        connection = 'error';
        connectionMessage = error instanceof Error ? error.message : String(error);
      }
    }
    return snapshot();
  };

  return {
    cloudGetState: (payload: CloudSessionScope) => refresh(payload),
    async cloudTestProfile(payload: { profile?: CloudProfileDraft }) {
      connection = 'testing';
      const candidate = await health(payload.profile ?? profile!);
      connection = 'ready';
      serviceVersion ||= null;
      return snapshot({ testedServerPublicKey: candidate.serverPublicKey });
    },
    async cloudSaveProfile(payload: { profile: CloudProfileDraft }) {
      const candidate = await health(payload.profile);
      if (profile?.serverPublicKey !== candidate.serverPublicKey) {
        tokens = null;
        storage.removeItem(TOKENS_KEY);
      }
      profile = candidate;
      storage.setItem(PROFILE_KEY, JSON.stringify(profile));
      connection = tokens ? 'ready' : 'unknown';
      return refresh();
    },
    async cloudPair(payload: { code: string; profile?: CloudProfileDraft }) {
      const candidate = await health(payload.profile ?? profile!);
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
      const sessionId = randomId('pwa_');
      const document = await upload(input.document.bytes, input.document.fileName, 'document', sessionId);
      const resources = [];
      for (const reference of input.references) {
        const stored = await upload(reference.bytes, reference.name, 'reference', sessionId);
        resources.push({ name: reference.name, blobId: stored.blobId, size: stored.size, kind: 'reference' });
      }
      const timelineBytes = utf8(JSON.stringify(input.timeline));
      const timelineUpload = await upload(timelineBytes, 'timeline.json', 'timeline', sessionId);
      const latestUser = [...input.timeline.thread.messages].reverse()
        .find((message) => message.role === 'user' && message.text.trim());
      const created = await requestJson('/v1/sessions', {
        method: 'POST',
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
        id: archiveId(sessionId, 'baseline'), sessionId, operationId: 'baseline', kind: 'baseline',
        fileName: input.document.fileName, sha256: input.document.sha256, revision: 0, turn: 0,
        bytes: input.document.bytes, timeline: input.timeline, createdAt: new Date().toISOString(),
      });
      storage.setItem(originSyncKey(sessionId), input.document.sha256);
      const activated = await requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}/commands`, {
        method: 'POST',
        body: {
          commandId: `activate_${sessionId}`,
          type: 'session.activate',
          payload: { expectedVersion: Number(created.stateVersion) || 1 },
        },
      });
      const active = record(activated.session) ?? created;
      remoteSessions = [active, ...remoteSessions.filter((session) => session.id !== sessionId)];
      scope = { threadId: input.threadId, documentId: input.documentId, selectedSessionId: sessionId };
      watch(sessionId);
      return snapshot();
    },
    async cloudCommand(input: CloudCommandRequest) {
      const serverType = COMMAND_TYPES[input.command];
      const attachments = [];
      for (const attachment of input.attachments ?? []) {
        const stored = await upload(attachment.bytes, attachment.name, 'reference', input.sessionId);
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
      const result = await requestJson(`/v1/sessions/${encodeURIComponent(input.sessionId)}/commands`, {
        method: 'POST', body: { commandId, type: serverType, payload },
      });
      const updated = record(result.session);
      if (updated) remoteSessions = [updated, ...remoteSessions.filter((session) => session.id !== input.sessionId)];
      if (input.command !== 'takeover') return snapshot();
      let takeover = record(result.takeover);
      const deadline = Date.now() + 5 * 60_000;
      while (takeover?.status !== 'ready' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        takeover = await requestJson(`/v1/sessions/${encodeURIComponent(input.sessionId)}/takeover`);
      }
      const boundary = record(takeover?.boundary);
      const operationId = String(boundary?.operationId ?? '');
      if (!operationId) throw new Error('클라우드 이어받기 경계를 준비하지 못했습니다.');
      const document = await downloadCheckpoint(input.sessionId, operationId);
      const takeoverTimeline = await downloadTimeline(input.sessionId);
      return snapshot({
        takeover: {
          document: {
            bytes: document.bytes,
            fileName: document.fileName,
            sha256: document.sha256,
            byteLength: document.byteLength,
            recoveryPath: `indexeddb://${ARCHIVE_DATABASE}/${archiveId(input.sessionId, operationId)}`,
            revision: document.revision,
            turn: document.turn,
          },
          timeline: takeoverTimeline,
        },
      });
    },
    async cloudDownloadCheckpoint(payload: { sessionId: string; operationId?: string }) {
      return downloadCheckpoint(payload.sessionId, payload.operationId);
    },
    async cloudDownloadResult(payload: { sessionId: string }) {
      const existing = await getArchive(archiveId(payload.sessionId, 'result'));
      const stored = existing ? { archive: existing, timeline: existing.timeline } : await archiveResult(payload.sessionId);
      return {
        sessionId: payload.sessionId,
        fileName: stored.archive.fileName,
        bytes: stored.archive.bytes,
        byteLength: stored.archive.bytes.byteLength,
        sha256: stored.archive.sha256,
        recoveryPath: `indexeddb://${ARCHIVE_DATABASE}/${archiveId(payload.sessionId, 'result')}`,
        previewOpened: false,
        conflict: 'none',
        preservedCopyName: null,
        timeline: stored.timeline,
      };
    },
    async cloudResolveResult(payload: { sessionId: string; action: string }) {
      const archive = await getArchive(archiveId(payload.sessionId, 'result'));
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
    cloudCompleteTakeover: () => Promise.resolve(snapshot()),
    onCloudEvent(callback: (event: unknown) => void) {
      eventListener = callback;
      return () => {
        if (eventListener === callback) eventListener = null;
        for (const watcher of watchers.values()) watcher.abort();
      };
    },
  };
}

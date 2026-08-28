import type { RhwpDesktopApi } from '../desktop-integration.ts';
import { parseCloudTimeline } from './timeline.ts';
import type {
  CloudCommandRequest,
  CloudDownloadResult,
  CloudConnectionState,
  CloudProfileDraft,
  CloudProfileState,
  CloudSandboxSummary,
  CloudServerMode,
  CloudServerState,
  CloudSessionBase,
  CloudSessionState,
  CloudSnapshot,
  CloudTransferRequest,
  CloudSessionScope,
  CloudTransferIntentRequest,
  CloudTransferReference,
  CloudTakeoverPayload,
  CloudResultAction,
  CloudResultResolution,
} from './types.ts';

const SANDBOX_LIFECYCLES = ['idle', 'provisioning', 'ready', 'error', 'tearing-down'] as const;

export interface CloudDesktopApi {
  cloudGetState?: (payload: CloudSessionScope) => Promise<unknown>;
  cloudSaveProfile?: (payload: { profile: CloudProfileDraft }) => Promise<unknown>;
  cloudTestProfile?: (payload: { profile?: CloudProfileDraft }) => Promise<unknown>;
  cloudProvision?: (payload: {
    installChannel: 'stable' | 'prerelease';
    profile?: CloudProfileDraft;
  }) => Promise<unknown>;
  cloudPair?: (payload: { code: string; profile?: CloudProfileDraft }) => Promise<unknown>;
  cloudSelectServerMode?: (payload: { mode: CloudServerMode }) => Promise<unknown>;
  cloudSpawnSandbox?: (payload: { providerId?: string }) => Promise<unknown>;
  cloudSandboxStatus?: () => Promise<unknown>;
  cloudTeardownSandbox?: (payload: { force?: boolean }) => Promise<unknown>;
  cloudTransfer?: (payload: CloudTransferRequest) => Promise<unknown>;
  cloudSetTransferIntent?: (payload: CloudTransferIntentRequest) => Promise<unknown>;
  cloudReadReference?: (payload: Pick<CloudTransferReference, 'id' | 'scope' | 'scopeId'>) => Promise<unknown>;
  cloudCommand?: (payload: CloudCommandRequest) => Promise<unknown>;
  cloudDismissSession?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudCompleteTakeover?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudDownloadResult?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudResolveResult?: (payload: { sessionId: string; action: CloudResultAction }) => Promise<unknown>;
  onCloudEvent?: (callback: (event: unknown) => void) => (() => void) | void;
}

export type CloudAwareDesktopApi = RhwpDesktopApi & CloudDesktopApi;

export interface CloudController {
  getSnapshot(): CloudSnapshot;
  refresh(scope: CloudSessionScope): Promise<CloudSnapshot>;
  saveProfile(profile: CloudProfileDraft): Promise<CloudSnapshot>;
  testProfile(profile?: CloudProfileDraft): Promise<CloudSnapshot>;
  provision(installChannel?: 'stable' | 'prerelease', profile?: CloudProfileDraft): Promise<CloudSnapshot>;
  pair(code: string, profile?: CloudProfileDraft): Promise<CloudSnapshot>;
  selectServerMode(mode: CloudServerMode): Promise<CloudSnapshot>;
  spawnSandbox(providerId?: string): Promise<CloudSnapshot>;
  sandboxStatus(): Promise<CloudSnapshot>;
  teardownSandbox(options?: { force?: boolean }): Promise<CloudSnapshot>;
  transfer(request: CloudTransferRequest): Promise<CloudSnapshot>;
  setTransferIntent(request: CloudTransferIntentRequest): Promise<CloudSnapshot>;
  readReference(reference: Pick<CloudTransferReference, 'id' | 'scope' | 'scopeId'>): Promise<Uint8Array>;
  command(request: CloudCommandRequest): Promise<CloudSnapshot>;
  dismissSession(sessionId: string): Promise<CloudSnapshot>;
  completeTakeover(sessionId: string): Promise<CloudSnapshot>;
  downloadResult(sessionId: string): Promise<CloudDownloadResult>;
  resolveResult(sessionId: string, action: CloudResultAction): Promise<CloudResultResolution>;
  subscribe(listener: (snapshot: CloudSnapshot) => void): () => void;
  dispose(): void;
}

const ISO_FALLBACK = '1970-01-01T00:00:00.000Z';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nonNegative(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = nonNegative(value, fallback);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function strictInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function strictIso(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function iso(value: unknown, fallback = ISO_FALLBACK): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function parseProfileDraft(value: unknown): CloudProfileDraft | null {
  const profile = record(value);
  const auth = record(profile?.auth);
  const transport = record(profile?.transport);
  if (!profile || !auth || !transport) return null;
  const host = string(profile.host).trim();
  const sshUser = string(profile.sshUser).trim();
  const name = string(profile.name).trim();
  const sshPort = integer(profile.sshPort, 22);
  const tailscaleHttpsPort = profile.tailscaleHttpsPort === undefined
    ? 443
    : strictInteger(profile.tailscaleHttpsPort);
  if (!name || !host || !sshUser || sshPort < 1 || sshPort > 65535
    || tailscaleHttpsPort === null || tailscaleHttpsPort < 1 || tailscaleHttpsPort > 65535) return null;
  const parsedAuth = auth.kind === 'ssh-agent'
    ? { kind: 'ssh-agent' as const }
    : auth.kind === 'key-file' && string(auth.keyPath).trim()
      ? { kind: 'key-file' as const, keyPath: string(auth.keyPath).trim() }
      : null;
  const parsedTransport = transport.kind === 'tailscale'
    ? { kind: 'tailscale' as const }
    : transport.kind === 'https' && string(transport.endpoint).trim()
      ? { kind: 'https' as const, endpoint: string(transport.endpoint).trim() }
      : null;
  if (!parsedAuth || !parsedTransport) return null;
  const serverPublicKey = string(profile.serverPublicKey).trim();
  if (serverPublicKey && !/^ed25519:[A-Za-z0-9_-]{59}$/.test(serverPublicKey)) return null;
  return {
    name, host, sshUser, sshPort, tailscaleHttpsPort, auth: parsedAuth, transport: parsedTransport,
    ...(serverPublicKey ? { serverPublicKey } : {}),
  };
}

function parseSandboxSummary(value: unknown): CloudSandboxSummary | null {
  const sandbox = record(value);
  if (!sandbox) return null;
  const providerId = string(sandbox.providerId).trim();
  const sandboxId = string(sandbox.sandboxId).trim();
  const createdAt = strictIso(sandbox.createdAt);
  if (!providerId || !sandboxId || !createdAt) return null;
  return {
    providerId,
    sandboxId,
    displayName: string(sandbox.displayName).trim() || providerId,
    region: string(sandbox.region).trim(),
    host: string(sandbox.host).trim(),
    createdAt,
  };
}

function parseServerMode(value: unknown): CloudServerMode | null {
  return value === 'self-hosted' || value === 'app-hosted' ? value : null;
}

function parseProfile(value: unknown): CloudProfileState | null {
  const state = record(value);
  if (!state) return null;
  if (state.kind === 'unconfigured') return { kind: 'unconfigured' };
  if (state.kind !== 'configured') return null;
  const connection: CloudConnectionState | null = state.connection === 'testing' || state.connection === 'ready'
    || state.connection === 'error' || state.connection === 'unknown'
    ? state.connection
    : null;
  if (!connection
    || (state.serviceVersion !== null && typeof state.serviceVersion !== 'string')
    || (state.message !== null && typeof state.message !== 'string')) return null;
  const shared = {
    kind: 'configured' as const,
    connection,
    serviceVersion: typeof state.serviceVersion === 'string' ? state.serviceVersion : null,
    message: typeof state.message === 'string' ? state.message : null,
  };
  if (state.mode === 'app-hosted') {
    const sandbox = parseSandboxSummary(state.sandbox);
    const name = string(state.name).trim();
    return sandbox && name ? { ...shared, mode: 'app-hosted', name, sandbox } : null;
  }
  const profile = parseProfileDraft(state.profile);
  if (!profile || (state.mode !== undefined && state.mode !== 'self-hosted')) return null;
  return { ...shared, mode: 'self-hosted', profile };
}

function parseServer(value: unknown, profile: CloudProfileState): CloudServerState | null {
  const fallbackMode = profile.kind === 'configured' ? profile.mode : null;
  if (value === undefined) {
    return { mode: fallbackMode, preferredMode: null, providers: [], lifecycle: 'idle', message: null };
  }
  const server = record(value);
  if (!server || !Array.isArray(server.providers)) return null;
  const lifecycle = SANDBOX_LIFECYCLES.find((entry) => entry === server.lifecycle);
  if (!lifecycle || (server.message !== null && typeof server.message !== 'string')) return null;
  const providers = server.providers.flatMap((entry) => {
    const provider = record(entry);
    const providerId = string(provider?.providerId).trim();
    if (!provider || !providerId || typeof provider.configured !== 'boolean'
      || !Array.isArray(provider.missingConfig)) return [];
    return [{
      providerId,
      displayName: string(provider.displayName).trim() || providerId,
      configured: provider.configured,
      missingConfig: provider.missingConfig.filter((item): item is string => typeof item === 'string'),
    }];
  });
  if (providers.length !== server.providers.length) return null;
  return {
    mode: parseServerMode(server.mode) ?? fallbackMode,
    preferredMode: parseServerMode(server.preferredMode),
    providers,
    lifecycle,
    message: typeof server.message === 'string' ? server.message : null,
  };
}

function parseSessionBase(state: Record<string, unknown>): CloudSessionBase | null {
  const sessionId = string(state.sessionId).trim();
  const threadId = string(state.threadId).trim();
  const documentName = string(state.documentName).trim();
  const version = strictInteger(state.version);
  const documentId = state.documentId === null
    ? null
    : typeof state.documentId === 'string' && state.documentId.trim()
      ? state.documentId
      : undefined;
  if (!sessionId || !threadId || !documentName || version === null || documentId === undefined) return null;
  return {
    sessionId,
    version,
    threadId,
    documentId,
    documentName,
  };
}

function parseResultSummary(value: unknown) {
  const result = record(value);
  if (!result) return null;
  const fileName = string(result.fileName).trim();
  const sha256 = string(result.sha256).trim();
  const byteLength = strictInteger(result.byteLength);
  const expiresAt = result.expiresAt === null ? null : strictIso(result.expiresAt);
  if (!fileName || !sha256 || byteLength === null || expiresAt === null && result.expiresAt !== null
    || typeof result.downloaded !== 'boolean'
    || typeof result.availableOnThisDevice !== 'boolean'
    || (result.conflict !== 'none' && result.conflict !== 'external-change')
    || (result.preservedCopyName !== null && typeof result.preservedCopyName !== 'string')) return null;
  return {
    fileName,
    byteLength,
    sha256,
    downloaded: result.downloaded,
    availableOnThisDevice: result.availableOnThisDevice,
    expiresAt,
    conflict: result.conflict === 'external-change' ? 'external-change' as const : 'none' as const,
    preservedCopyName: typeof result.preservedCopyName === 'string' ? result.preservedCopyName : null,
  };
}

function parseSession(value: unknown): CloudSessionState | null {
  const state = record(value);
  if (!state) return null;
  if (state.kind === 'idle') return { kind: 'idle' };
  const base = parseSessionBase(state);
  if (!base) return null;
  switch (state.kind) {
    case 'waiting-local-turn':
      return typeof state.message === 'string' ? { ...base, kind: state.kind, message: state.message } : null;
    case 'transferring': {
      const stage = state.stage === 'preparing' || state.stage === 'uploading'
        || state.stage === 'committing' || state.stage === 'starting' ? state.stage : null;
      const completedBytes = strictInteger(state.completedBytes);
      const totalBytes = strictInteger(state.totalBytes);
      if (!stage || completedBytes === null || totalBytes === null || typeof state.message !== 'string') return null;
      return {
        ...base,
        kind: state.kind,
        stage,
        completedBytes,
        totalBytes,
        message: state.message,
      };
    }
    case 'queued': {
      const position = strictInteger(state.position);
      return position !== null && typeof state.message === 'string'
        ? { ...base, kind: state.kind, position, message: state.message }
        : null;
    }
    case 'running': {
      const startedAt = strictIso(state.startedAt);
      const turn = strictInteger(state.turn);
      const turnLimit = strictInteger(state.turnLimit);
      const elapsedMs = strictInteger(state.elapsedMs);
      const timeLimitMs = strictInteger(state.timeLimitMs);
      if (!startedAt || turn === null || turnLimit === null || elapsedMs === null || timeLimitMs === null
        || typeof state.currentActivity !== 'string') return null;
      return {
        ...base,
        kind: state.kind,
        startedAt,
        turn,
        turnLimit,
        elapsedMs,
        timeLimitMs,
        currentActivity: state.currentActivity,
      };
    }
    case 'pausing':
      return typeof state.message === 'string' ? { ...base, kind: state.kind, message: state.message } : null;
    case 'suspended':
      return typeof state.reason === 'string' && typeof state.resumable === 'boolean'
        ? { ...base, kind: state.kind, reason: state.reason, resumable: state.resumable }
        : null;
    case 'taking-over':
      return typeof state.message === 'string' ? { ...base, kind: state.kind, message: state.message } : null;
    case 'completed': {
      const result = parseResultSummary(state.result);
      const completedAt = strictIso(state.completedAt);
      return result && completedAt ? { ...base, kind: state.kind, completedAt, result } : null;
    }
    case 'failed':
      return typeof state.code === 'string' && typeof state.message === 'string' && typeof state.retryable === 'boolean' ? {
        ...base,
        kind: state.kind,
        code: state.code,
        message: state.message,
        retryable: state.retryable,
      } : null;
    case 'cancelled': {
      const cancelledAt = strictIso(state.cancelledAt);
      return cancelledAt ? { ...base, kind: state.kind, cancelledAt } : null;
    }
    default:
      return null;
  }
}

function parseTakeover(value: unknown): CloudTakeoverPayload | null {
  const raw = record(value);
  if (!raw) return null;
  const timeline = parseCloudTimeline(raw.timeline);
  if (!timeline) return null;
  if (raw.document === null) return { document: null, timeline };
  const document = record(raw.document);
  if (!document || !(document.bytes instanceof Uint8Array)) return null;
  const fileName = string(document.fileName).trim();
  const sha256 = string(document.sha256).trim();
  const recoveryPath = string(document.recoveryPath).trim();
  const byteLength = strictInteger(document.byteLength);
  const revision = strictInteger(document.revision);
  const turn = strictInteger(document.turn);
  if (!fileName || !sha256 || !recoveryPath || byteLength === null || revision === null || turn === null
    || document.bytes.byteLength !== byteLength) return null;
  return {
    document: { bytes: document.bytes, fileName, sha256, byteLength, recoveryPath, revision, turn },
    timeline,
  };
}

export function parseCloudSnapshot(value: unknown): CloudSnapshot | null {
  const raw = record(value);
  if (!raw) return null;
  const profile = parseProfile(raw.profile);
  const session = parseSession(raw.session);
  const leaseRaw = record(raw.lease);
  const revision = strictInteger(raw.revision);
  const updatedAt = strictIso(raw.updatedAt);
  if (revision === null || typeof raw.available !== 'boolean' || !profile || !session || !leaseRaw || !updatedAt) return null;
  const lease = leaseRaw.owner === 'cloud' && string(leaseRaw.sessionId).trim() && strictIso(leaseRaw.acquiredAt)
    ? {
        owner: 'cloud' as const,
        sessionId: string(leaseRaw.sessionId),
        acquiredAt: strictIso(leaseRaw.acquiredAt)!,
      }
    : leaseRaw.owner === 'local'
      ? { owner: 'local' as const }
      : null;
  if (!lease || !Array.isArray(raw.queuedMessages)) return null;
  const sessionValues = raw.sessions === undefined
    ? (session.kind === 'idle' ? [] : [session])
    : raw.sessions;
  if (!Array.isArray(sessionValues)) return null;
  const sessions = sessionValues.map(parseSession);
  if (sessions.some((entry) => !entry || entry.kind === 'idle')) return null;
  const sessionIds = sessions.map((entry) => (entry as CloudSessionBase).sessionId);
  if (new Set(sessionIds).size !== sessionIds.length) return null;
  const queuedMessages = raw.queuedMessages.flatMap((value) => {
        const message = record(value);
        const queuedAt = strictIso(message?.queuedAt);
        if (!message || !string(message.id).trim() || !string(message.text).trim() || !queuedAt
          || (message.state !== 'queued' && message.state !== 'accepted')) return [];
        return [{
          id: string(message.id),
          text: string(message.text),
          queuedAt,
          state: message.state === 'accepted' ? 'accepted' as const : 'queued' as const,
        }];
      });
  if (queuedMessages.length !== raw.queuedMessages.length) return null;
  const timeline = raw.timeline === null ? null : parseCloudTimeline(raw.timeline);
  if (raw.timeline !== null && !timeline) return null;
  const takeover = raw.takeover === undefined ? undefined : parseTakeover(raw.takeover);
  if (raw.takeover !== undefined && !takeover) return null;
  const server = parseServer(raw.server, profile);
  if (!server) return null;
  const sandboxOutcome = record(raw.sandbox);
  const sandbox = sandboxOutcome
    ? { removed: sandboxOutcome.removed === true, unmanaged: sandboxOutcome.unmanaged === true }
    : undefined;
  return {
    revision,
    available: raw.available,
    profile,
    server,
    ...(sandbox ? { sandbox } : {}),
    lease,
    session,
    sessions: sessions as Exclude<CloudSessionState, { kind: 'idle' }>[],
    queuedMessages,
    timeline,
    updatedAt,
    ...(takeover ? { takeover } : {}),
  };
}

function unavailableSnapshot(): CloudSnapshot {
  return {
    revision: 0,
    available: false,
    profile: { kind: 'unconfigured' },
    server: {
      mode: null,
      preferredMode: null,
      providers: [],
      lifecycle: 'idle',
      message: null,
    },
    lease: { owner: 'local' },
    session: { kind: 'idle' },
    sessions: [],
    queuedMessages: [],
    timeline: null,
    updatedAt: new Date().toISOString(),
  };
}

function parseDownloadResult(value: unknown): CloudDownloadResult | null {
  const result = record(value);
  if (!result) return null;
  const sessionId = string(result.sessionId).trim();
  const fileName = string(result.fileName).trim();
  const sha256 = string(result.sha256).trim();
  const recoveryPath = string(result.recoveryPath).trim();
  if (!sessionId || !fileName || !sha256 || !recoveryPath || !(result.bytes instanceof Uint8Array)) return null;
  return {
    sessionId,
    fileName,
    bytes: result.bytes,
    byteLength: integer(result.byteLength),
    sha256,
    recoveryPath,
    previewOpened: result.previewOpened === true,
    conflict: result.conflict === 'external-change' ? 'external-change' : 'none',
    preservedCopyName: typeof result.preservedCopyName === 'string' ? result.preservedCopyName : null,
    timeline: parseCloudTimeline(result.timeline),
  };
}

export function parseCloudResultResolution(value: unknown): CloudResultResolution | null {
  const result = record(value);
  if (!result) return null;
  const action = result.action === 'replace' || result.action === 'keep-both' || result.action === 'discard'
    ? result.action
    : null;
  const conflict = result.conflict === 'external-change'
    ? 'external-change' as const
    : result.conflict === 'none'
      ? 'none' as const
      : null;
  const snapshot = parseCloudSnapshot(result.snapshot);
  if (!action || !conflict || !snapshot) return null;
  const path = typeof result.path === 'string' && result.path.trim() ? result.path : null;
  const bytes = result.bytes instanceof Uint8Array ? result.bytes : null;
  const preservedCopyName = typeof result.preservedCopyName === 'string' && result.preservedCopyName.trim()
    ? result.preservedCopyName
    : null;
  if (action === 'discard') {
    if (path !== null || bytes !== null || conflict !== 'none') return null;
  } else if (!path || !bytes?.byteLength) {
    return null;
  }
  if (conflict === 'external-change' && action !== 'keep-both') return null;
  if (action === 'keep-both' && !preservedCopyName) return null;
  return { action, path, bytes, conflict, preservedCopyName, snapshot };
}

function unwrapSnapshot(value: unknown): CloudSnapshot | null {
  const wrapper = record(value);
  return parseCloudSnapshot(wrapper?.snapshot ?? value);
}

export function createCloudController(
  api: CloudAwareDesktopApi | undefined = (globalThis as { rhwpDesktop?: CloudAwareDesktopApi }).rhwpDesktop,
): CloudController {
  let snapshot = unavailableSnapshot();
  let disposed = false;
  const listeners = new Set<(state: CloudSnapshot) => void>();

  const publish = (next: CloudSnapshot): CloudSnapshot => {
    if (next.revision < snapshot.revision) return snapshot;
    snapshot = next;
    if (!disposed) for (const listener of listeners) listener(snapshot);
    return snapshot;
  };

  const accept = (value: unknown): CloudSnapshot => {
    const parsed = unwrapSnapshot(value);
    if (!parsed) throw new Error('클라우드 서비스가 올바르지 않은 상태를 반환했습니다.');
    return publish(parsed);
  };

  const call = async (method: keyof CloudDesktopApi, payload?: unknown): Promise<CloudSnapshot> => {
    const fn = api?.[method];
    if (typeof fn !== 'function') throw new Error('이 앱 빌드는 클라우드 에이전트를 지원하지 않습니다.');
    return accept(await (fn as (arg?: unknown) => Promise<unknown>)(payload));
  };

  const unsubscribeHost = api?.onCloudEvent?.((event) => {
    if (disposed) return;
    const next = unwrapSnapshot(event);
    if (!next) return;
    publish(next);
  });

  return {
    getSnapshot: () => snapshot,
    refresh: (scope) => call('cloudGetState', scope),
    saveProfile: (profile) => call('cloudSaveProfile', { profile }),
    testProfile: (profile) => call('cloudTestProfile', profile ? { profile } : {}),
    provision: (installChannel = 'stable', profile) => call('cloudProvision', {
      installChannel,
      ...(profile ? { profile } : {}),
    }),
    pair: (code, profile) => call('cloudPair', { code, ...(profile ? { profile } : {}) }),
    selectServerMode: (mode) => call('cloudSelectServerMode', { mode }),
    spawnSandbox: (providerId) => call('cloudSpawnSandbox', providerId ? { providerId } : {}),
    sandboxStatus: () => call('cloudSandboxStatus'),
    teardownSandbox: (options = {}) => call('cloudTeardownSandbox', { force: options.force === true }),
    transfer: (request) => call('cloudTransfer', request),
    setTransferIntent: (request) => call('cloudSetTransferIntent', request),
    async readReference(reference) {
      const fn = api?.cloudReadReference;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 참고자료 전송을 지원하지 않습니다.');
      const raw = record(await fn(reference));
      if (!(raw?.bytes instanceof Uint8Array)) throw new Error(`${reference.id} 참고자료를 읽지 못했습니다.`);
      return raw.bytes;
    },
    command: (request) => call('cloudCommand', request),
    dismissSession: (sessionId) => call('cloudDismissSession', { sessionId }),
    completeTakeover: (sessionId) => call('cloudCompleteTakeover', { sessionId }),
    async downloadResult(sessionId) {
      const fn = api?.cloudDownloadResult;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 클라우드 결과 다운로드를 지원하지 않습니다.');
      const result = parseDownloadResult(await fn({ sessionId }));
      if (!result) throw new Error('다운로드한 클라우드 결과가 올바르지 않습니다.');
      return result;
    },
    async resolveResult(sessionId, action) {
      const fn = api?.cloudResolveResult;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 클라우드 결과 반영을 지원하지 않습니다.');
      const resolution = parseCloudResultResolution(await fn({ sessionId, action }));
      if (!resolution) throw new Error('클라우드 결과 반영 정보가 올바르지 않습니다.');
      publish(resolution.snapshot);
      return resolution;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      listeners.clear();
      if (typeof unsubscribeHost === 'function') unsubscribeHost();
    },
  };
}

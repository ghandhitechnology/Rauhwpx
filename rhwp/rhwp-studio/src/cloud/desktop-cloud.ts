import type { RhwpDesktopApi } from '../desktop-integration.ts';
import { browserCloudSupported, createBrowserCloudApi } from './browser-cloud.ts';
import {
  clientUnsupportedDisplay,
  parseCloudDisplayCapability,
  parseCloudDisplayEvent,
} from './display.ts';
import { parseCloudTimeline } from './timeline.ts';
import type {
  CloudCommandRequest,
  CloudConversationWait,
  CloudCheckpointPayload,
  CloudDownloadResult,
  CloudConnectionState,
  CloudDisplayCapability,
  CloudDisplayConnection,
  CloudDisplayEvent,
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
  cloudCompleteTakeover?: (payload: { sessionId: string; operationId: string }) => Promise<unknown>;
  cloudDownloadResult?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudDownloadCheckpoint?: (payload: { sessionId: string; operationId?: string }) => Promise<unknown>;
  cloudOpenDisplay?: (payload: { sessionId: string }) => Promise<unknown>;
  cloudCloseDisplay?: (payload: { connectionId: string }) => Promise<unknown>;
  cloudResolveResult?: (payload: { sessionId: string; action: CloudResultAction }) => Promise<unknown>;
  onCloudEvent?: (callback: (event: unknown) => void) => (() => void) | void;
  onCloudDisplayEvent?: (callback: (event: unknown) => void) => (() => void) | void;
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
  completeTakeover(sessionId: string, operationId: string): Promise<CloudSnapshot>;
  downloadResult(sessionId: string): Promise<CloudDownloadResult>;
  downloadCheckpoint(sessionId: string, operationId?: string): Promise<CloudCheckpointPayload>;
  openDisplay(sessionId: string, listener: (event: CloudDisplayEvent) => void): Promise<CloudDisplayConnection>;
  resolveResult(sessionId: string, action: CloudResultAction): Promise<CloudResultResolution>;
  subscribe(listener: (snapshot: CloudSnapshot) => void): () => void;
  subscribeEvents(listener: (event: unknown) => void): () => void;
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
    : transport.kind === 'ssh-tunnel'
      ? { kind: 'ssh-tunnel' as const }
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

function parseConversationWait(value: unknown) {
  if (value === null || value === undefined) return null;
  const wait = record(value);
  const id = string(wait?.id).trim();
  const kind = wait?.kind;
  const payload = record(wait?.payload);
  if (!wait || !id || !payload
    || (kind !== 'plan-approval' && kind !== 'question'
      && kind !== 'external-side-effect' && kind !== 'destructive-external')) return undefined;
  return {
    id,
    kind: kind as CloudConversationWait['kind'],
    payload,
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
      const phase = state.phase === 'waiting' || state.phase === 'redirecting'
        || state.phase === 'awaiting-plan-approval'
        || state.phase === 'awaiting-question-answer'
        || state.phase === 'awaiting-external-effect-approval'
        ? state.phase
        : 'working';
      const wait = parseConversationWait(state.wait);
      if (!startedAt || turn === null || turnLimit === null || elapsedMs === null || timeLimitMs === null
        || typeof state.currentActivity !== 'string' || wait === undefined) return null;
      return {
        ...base,
        kind: state.kind,
        startedAt,
        turn,
        turnLimit,
        elapsedMs,
        timeLimitMs,
        currentActivity: state.currentActivity,
        phase,
        wait,
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
  const operationId = string(raw.operationId).trim();
  const timeline = parseCloudTimeline(raw.timeline);
  if (!operationId || !timeline) return null;
  if (raw.document === null) return { operationId, document: null, timeline };
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
    operationId,
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
  const profileEpoch = strictInteger(raw.profileEpoch);
  const updatedAt = strictIso(raw.updatedAt);
  if (revision === null || profileEpoch === null || typeof raw.available !== 'boolean'
    || !profile || !session || !leaseRaw || !updatedAt) return null;
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
    profileEpoch,
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
    profileEpoch: 0,
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

export function parseCloudCheckpoint(value: unknown): CloudCheckpointPayload | null {
  const result = record(value);
  if (!result || !(result.bytes instanceof Uint8Array)) return null;
  const sessionId = string(result.sessionId).trim();
  const fileName = string(result.fileName).trim();
  const sha256 = string(result.sha256).trim();
  const operationId = string(result.operationId).trim();
  const kind = result.kind === 'handoff' || result.kind === 'operation' || result.kind === 'turn'
    ? result.kind
    : null;
  const documentId = result.documentId === null
    ? null
    : typeof result.documentId === 'string'
      && result.documentId.trim()
      && result.documentId === result.documentId.trim()
      ? result.documentId
      : undefined;
  const originOnThisDevice = result.originOnThisDevice === true;
  const expectedOriginCandidate = string(result.expectedOriginSha256).trim();
  const expectedOriginSha256 = /^[a-f0-9]{64}$/.test(expectedOriginCandidate)
    ? expectedOriginCandidate
    : '';
  const byteLength = strictInteger(result.byteLength);
  const revision = strictInteger(result.revision);
  const turn = strictInteger(result.turn);
  if (!sessionId || !fileName || !sha256 || !operationId || !kind || documentId === undefined
    || byteLength === null || revision === null || turn === null
    || result.bytes.byteLength !== byteLength) return null;
  return {
    sessionId, documentId, kind, fileName, sha256, operationId, byteLength, revision, turn, bytes: result.bytes,
    ...(originOnThisDevice ? { originOnThisDevice: true } : {}),
    ...(expectedOriginSha256 ? { expectedOriginSha256 } : {}),
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
  browser: { readReference?: (reference: Pick<CloudTransferReference, 'id' | 'scope' | 'scopeId'>) => Promise<Uint8Array> } = {},
): CloudController {
  const resolvedApi = api ?? (browserCloudSupported() ? createBrowserCloudApi(browser) : undefined);
  let snapshot = unavailableSnapshot();
  let disposed = false;
  const listeners = new Set<(state: CloudSnapshot) => void>();
  const eventListeners = new Set<(event: unknown) => void>();
  type ActiveDisplay = {
    connectionId: string;
    capability: CloudDisplayCapability;
    listener: (event: CloudDisplayEvent) => void;
    closePromise: Promise<void> | null;
  };
  let displayGeneration = 0;
  let activeDisplay: ActiveDisplay | null = null;
  let openingDisplays = 0;
  const pendingDisplayEvents = new Map<string, unknown[]>();

  const publish = (next: CloudSnapshot): CloudSnapshot => {
    if (next.profileEpoch < snapshot.profileEpoch) return snapshot;
    if (next.profileEpoch === snapshot.profileEpoch && next.revision < snapshot.revision) return snapshot;
    if (next.profileEpoch > snapshot.profileEpoch) {
      displayGeneration += 1;
      if (activeDisplay) void closeDisplay(activeDisplay);
      pendingDisplayEvents.clear();
    }
    snapshot = next;
    if (!disposed) for (const listener of listeners) listener(snapshot);
    return snapshot;
  };

  const accept = (value: unknown): CloudSnapshot => {
    const parsed = unwrapSnapshot(value);
    if (!parsed) throw new Error('클라우드 서비스가 올바르지 않은 상태를 반환했습니다.');
    if (parsed.profileEpoch < snapshot.profileEpoch) {
      throw Object.assign(new Error('Cloud 프로필이 작업 중 변경됐습니다.'), { code: 'PROFILE_CHANGED' });
    }
    return publish(parsed);
  };

  const call = async (method: keyof CloudDesktopApi, payload?: unknown): Promise<CloudSnapshot> => {
    const fn = resolvedApi?.[method];
    if (typeof fn !== 'function') throw new Error('이 앱 빌드는 클라우드 에이전트를 지원하지 않습니다.');
    return accept(await (fn as (arg?: unknown) => Promise<unknown>)(payload));
  };

  const unsubscribeHost = resolvedApi?.onCloudEvent?.((event) => {
    if (disposed) return;
    const next = unwrapSnapshot(event);
    if (next && next.profileEpoch < snapshot.profileEpoch) return;
    if (next) publish(next);
    const envelope = record(event);
    const eventEpoch = strictInteger(envelope?.profileEpoch);
    if (eventEpoch !== null && eventEpoch !== snapshot.profileEpoch) return;
    const batched = envelope?.type === 'cloud-event-batch' && Array.isArray(envelope.events);
    const events: unknown[] = batched ? envelope.events as unknown[] : [event];
    for (const item of events) {
      if (batched && strictInteger(record(item)?.profileEpoch) !== snapshot.profileEpoch) continue;
      for (const listener of eventListeners) listener(item);
    }
  });

  const closeDisplay = (entry: ActiveDisplay): Promise<void> => {
    if (entry.closePromise) return entry.closePromise;
    if (activeDisplay === entry) activeDisplay = null;
    pendingDisplayEvents.delete(entry.connectionId);
    entry.closePromise = Promise.resolve(resolvedApi?.cloudCloseDisplay?.({
      connectionId: entry.connectionId,
    })).then(() => {});
    return entry.closePromise;
  };

  const acceptDisplayHostEvent = (value: unknown): CloudDisplayEvent | null => {
    if (disposed) return null;
    const envelope = record(value);
    if (!envelope || typeof envelope.connectionId !== 'string' || !envelope.connectionId) return null;
    const connectionId = envelope.connectionId;
    if (!activeDisplay || connectionId !== activeDisplay.connectionId) {
      if (openingDisplays > 0) {
        const queued = pendingDisplayEvents.get(connectionId) ?? [];
        queued.push(value);
        pendingDisplayEvents.set(connectionId, queued.slice(-8));
        while (pendingDisplayEvents.size > 4) {
          const oldest = pendingDisplayEvents.keys().next().value;
          if (oldest === undefined) break;
          pendingDisplayEvents.delete(oldest);
        }
      }
      return null;
    }
    const expectedStream = activeDisplay.capability.kind === 'available'
      ? activeDisplay.capability.streamId
      : undefined;
    const event = parseCloudDisplayEvent(envelope.event, {
      sessionId: activeDisplay.capability.sessionId,
      streamId: record(envelope.event)?.state === 'connected' ? undefined : expectedStream,
    });
    if (!event) return null;
    if (event.kind === 'connection' && event.state === 'connected') {
      activeDisplay.capability = event.capability;
    } else if (event.kind === 'unavailable') {
      activeDisplay.capability = event;
    }
    try { activeDisplay.listener(event); } catch { /* Display listeners are isolated. */ }
    return event;
  };

  const unsubscribeDisplayHost = resolvedApi?.onCloudDisplayEvent?.((value) => {
    acceptDisplayHostEvent(value);
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
      const profileEpoch = snapshot.profileEpoch;
      const fn = resolvedApi?.cloudReadReference;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 참고자료 전송을 지원하지 않습니다.');
      const raw = record(await fn(reference));
      if (profileEpoch !== snapshot.profileEpoch) {
        throw Object.assign(new Error('Cloud 프로필이 작업 중 변경됐습니다.'), { code: 'PROFILE_CHANGED' });
      }
      if (!(raw?.bytes instanceof Uint8Array)) throw new Error(`${reference.id} 참고자료를 읽지 못했습니다.`);
      return raw.bytes;
    },
    command: (request) => call('cloudCommand', request),
    dismissSession: (sessionId) => call('cloudDismissSession', { sessionId }),
    completeTakeover: (sessionId, operationId) => call('cloudCompleteTakeover', { sessionId, operationId }),
    async downloadResult(sessionId) {
      const profileEpoch = snapshot.profileEpoch;
      const fn = resolvedApi?.cloudDownloadResult;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 클라우드 결과 다운로드를 지원하지 않습니다.');
      const result = parseDownloadResult(await fn({ sessionId }));
      if (profileEpoch !== snapshot.profileEpoch) {
        throw Object.assign(new Error('Cloud 프로필이 작업 중 변경됐습니다.'), { code: 'PROFILE_CHANGED' });
      }
      if (!result) throw new Error('다운로드한 클라우드 결과가 올바르지 않습니다.');
      return result;
    },
    async downloadCheckpoint(sessionId, operationId) {
      const profileEpoch = snapshot.profileEpoch;
      const fn = resolvedApi?.cloudDownloadCheckpoint;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 클라우드 문서 미러를 지원하지 않습니다.');
      const result = parseCloudCheckpoint(await fn({ sessionId, ...(operationId ? { operationId } : {}) }));
      if (profileEpoch !== snapshot.profileEpoch) {
        throw Object.assign(new Error('Cloud 프로필이 작업 중 변경됐습니다.'), { code: 'PROFILE_CHANGED' });
      }
      if (!result) throw new Error('다운로드한 클라우드 체크포인트가 올바르지 않습니다.');
      return result;
    },
    async openDisplay(sessionId, listener) {
      const generation = ++displayGeneration;
      const profileEpoch = snapshot.profileEpoch;
      const previous = activeDisplay;
      activeDisplay = null;
      if (previous) await closeDisplay(previous);
      if (disposed || generation !== displayGeneration || profileEpoch !== snapshot.profileEpoch) {
        throw new DOMException('Cloud display connection was replaced', 'AbortError');
      }
      if (typeof resolvedApi?.cloudOpenDisplay !== 'function'
        || typeof resolvedApi?.cloudCloseDisplay !== 'function'
        || typeof resolvedApi?.onCloudDisplayEvent !== 'function') {
        const capability = clientUnsupportedDisplay(sessionId);
        try { listener(capability); } catch { /* Display listeners are isolated. */ }
        return { capability, async close() {} };
      }
      openingDisplays += 1;
      let opened: Record<string, unknown> | null;
      try {
        opened = record(await resolvedApi.cloudOpenDisplay({ sessionId }));
      } finally {
        openingDisplays -= 1;
      }
      const connectionId = typeof opened?.connectionId === 'string' && opened.connectionId
        ? opened.connectionId
        : null;
      const capability = parseCloudDisplayCapability(opened?.capability);
      if (!connectionId || !capability || capability.sessionId !== sessionId) {
        if (connectionId) pendingDisplayEvents.delete(connectionId);
        if (connectionId) await resolvedApi.cloudCloseDisplay({ connectionId }).catch(() => {});
        throw new Error('클라우드 디스플레이 연결 정보가 올바르지 않습니다.');
      }
      if (disposed || generation !== displayGeneration || profileEpoch !== snapshot.profileEpoch) {
        pendingDisplayEvents.delete(connectionId);
        await resolvedApi.cloudCloseDisplay({ connectionId }).catch(() => {});
        throw new DOMException('Cloud display connection was replaced', 'AbortError');
      }
      const entry: ActiveDisplay = {
        connectionId,
        capability,
        listener,
        closePromise: null,
      };
      activeDisplay = entry;
      const pending = pendingDisplayEvents.get(connectionId) ?? [];
      pendingDisplayEvents.delete(connectionId);
      const replayedUnavailable = pending
        .map((value) => acceptDisplayHostEvent(value))
        .some((event) => event?.kind === 'unavailable');
      if (capability.kind === 'unavailable' && !replayedUnavailable) {
        try { listener(capability); } catch { /* Display listeners are isolated. */ }
      }
      return {
        get capability() { return entry.capability; },
        close: () => closeDisplay(entry),
      };
    },
    async resolveResult(sessionId, action) {
      const profileEpoch = snapshot.profileEpoch;
      const fn = resolvedApi?.cloudResolveResult;
      if (typeof fn !== 'function') throw new Error('이 앱 빌드는 클라우드 결과 반영을 지원하지 않습니다.');
      const resolution = parseCloudResultResolution(await fn({ sessionId, action }));
      if (!resolution) throw new Error('클라우드 결과 반영 정보가 올바르지 않습니다.');
      if (profileEpoch !== snapshot.profileEpoch || resolution.snapshot.profileEpoch !== profileEpoch) {
        throw Object.assign(new Error('Cloud 프로필이 작업 중 변경됐습니다.'), { code: 'PROFILE_CHANGED' });
      }
      publish(resolution.snapshot);
      return resolution;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      displayGeneration += 1;
      if (activeDisplay) void closeDisplay(activeDisplay);
      listeners.clear();
      eventListeners.clear();
      pendingDisplayEvents.clear();
      if (typeof unsubscribeHost === 'function') unsubscribeHost();
      if (typeof unsubscribeDisplayHost === 'function') unsubscribeDisplayHost();
    },
  };
}

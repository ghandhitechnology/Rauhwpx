import { EventEmitter } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerError, createAppServerRegistry } from './cloud-app-server.mjs';
import {
  DESKTOP_PROVIDER_AUTH,
  isPermanentTransferError,
  PERMANENT_TRANSFER_CODES,
} from './cloud-provider-auth.mjs';
import { normalizeCloudProfile, normalizeTailscaleHttpsPort } from './cloud-profile.mjs';
import { sha256Hex, writeVerifiedRecoveryFile } from './cloud-handoff.mjs';
import { hasProviderAuth } from './provider-auth.mjs';

/** 샌드박스를 철거하면 사라지는 작업 상태. 사용자가 먼저 정리해야 한다. */
const LIVE_HANDOFF_STATES = Object.freeze([
  'preparing',
  'uploading',
  'committing',
  'queued',
  'running',
  'suspended',
  'completed',
  'downloading',
]);

/** Deterministic failures must not retry a full re-upload forever. */
const MAX_TRANSFER_RECOVERY_ATTEMPTS = 5;
const NON_RETRYABLE_TRANSFER_CODES = new Set([
  ...PERMANENT_TRANSFER_CODES,
  'PROVIDER_KEY_REQUIRED',
  'SANDBOX_AUTH_UNSUPPORTED',
  'CLOUD_NOT_CONFIGURED',
  'CLOUD_PROFILE_UNREADABLE',
  'CLOUD_CREDENTIALS_UNAVAILABLE',
  'CLOUD_PROTOCOL_INCOMPATIBLE',
  'PAIRING_REQUIRED',
  'SERVER_IDENTITY_INVALID',
  'SERVER_IDENTITY_MISMATCH',
  'TRANSFER_ALREADY_ACTIVE',
  'TRANSFER_DESTINATION_CHANGED',
  'TRANSFER_DESTINATION_UNKNOWN',
]);

function nonRetryableTransferError(error) {
  if (typeof error?.retryable === 'boolean') return !error.retryable;
  if (NON_RETRYABLE_TRANSFER_CODES.has(String(error?.code ?? '').toUpperCase())) return true;
  if (isPermanentTransferError(error)) return true;
  const status = Number(error?.status);
  if (Number.isFinite(status) && status > 0) {
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase();
  const transientSystemCodes = new Set([
    'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETDOWN',
    'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
  ]);
  const fetchTransportFailure = error?.name === 'TypeError'
    && /^(?:fetch failed|failed to fetch|networkerror|terminated|socket hang up)/i
      .test(String(error?.message ?? '').trim());
  return !transientSystemCodes.has(code) && !fetchTransportFailure;
}

function destinationFromReadiness(readiness) {
  const profile = readiness?.profile ?? readiness;
  if (!profile?.endpoint) return null;
  return {
    endpoint: profile.endpoint,
    serverPublicKey: profile.serverPublicKey || null,
    mode: profile.mode ?? null,
    sandboxId: profile.sandbox?.sandboxId ?? null,
    sandboxProvider: profile.sandbox?.providerId ?? null,
    protocolVersion: readiness?.health?.protocolVersion ?? 1,
    runtimeVersion: readiness?.health?.version ?? null,
  };
}

function sameDestination(left, right) {
  if (!left || !right) return false;
  return ['endpoint', 'serverPublicKey', 'mode', 'sandboxId', 'sandboxProvider', 'protocolVersion']
    .every((field) => (left[field] ?? null) === (right[field] ?? null));
}

function transferError(message, code) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function importedAuthFromCollected(auth) {
  if (!auth || typeof auth !== 'object') return null;
  if (auth.secrets && typeof auth.secrets === 'object' && !Array.isArray(auth.secrets)) {
    const files = auth.files && typeof auth.files === 'object' && !Array.isArray(auth.files)
      ? auth.files
      : {};
    if (!Object.keys(auth.secrets).length && !Object.keys(files).length) return null;
    return { secrets: auth.secrets, files };
  }
  const spec = DESKTOP_PROVIDER_AUTH[auth.provider];
  const secrets = {};
  if (auth.apiKey && spec?.secretName) secrets[spec.secretName] = auth.apiKey;
  const files = {};
  for (const file of Array.isArray(auth.files) ? auth.files : []) {
    if (file?.path && file.content) files[file.path] = file.content;
  }
  if (!Object.keys(secrets).length && !Object.keys(files).length) return null;
  return { secrets, files };
}

function uiProfileToStored(input, current = null) {
  const source = input?.profile ?? input ?? {};
  const host = String(source.host ?? source.ssh?.host ?? current?.ssh?.host ?? '').trim();
  const transport = source.transport?.kind ?? current?.transport ?? 'tailscale';
  const tailscaleHttpsPort = normalizeTailscaleHttpsPort(
    source.tailscaleHttpsPort ?? source.transport?.httpsPort ?? current?.tailscaleHttpsPort,
  );
  const explicitEndpoint = source.transport?.endpoint ?? source.endpoint;
  const tailscalePortSuffix = tailscaleHttpsPort === 443 ? '' : `:${tailscaleHttpsPort}`;
  const canReuseEndpoint = current?.ssh?.host === host
    && (transport !== 'tailscale' || current?.tailscaleHttpsPort === tailscaleHttpsPort);
  const endpoint = explicitEndpoint
    || (canReuseEndpoint ? current.endpoint : '')
    || `https://${host}${transport === 'tailscale' ? tailscalePortSuffix : ''}/rauhwpx-cloud`;
  const api = transport === 'ssh-tunnel'
    ? { kind: 'ssh-tunnel', remoteHost: '127.0.0.1', remotePort: 7740, basePath: '/rauhwpx-cloud' }
    : transport === 'tailscale'
      ? { kind: 'tailscale-https', endpoint, httpsPort: tailscaleHttpsPort }
      : { kind: 'public-https', endpoint };
  const auth = source.auth ?? {};
  const sshUser = source.sshUser ?? source.ssh?.user ?? current?.ssh?.user;
  const sshPort = source.sshPort ?? source.ssh?.port ?? current?.ssh?.port;
  const canReuseIdentity = current?.transport === transport
    && current?.ssh?.host === host
    && current?.ssh?.user === sshUser
    && current?.ssh?.port === sshPort;
  return normalizeCloudProfile({
    name: source.name ?? current?.name,
    endpoint,
    api,
    provider: source.provider ?? current?.provider ?? 'codex',
    transport: transport === 'tailscale' ? 'tailscale' : transport === 'ssh-tunnel' ? 'ssh-tunnel' : 'public-https',
    serverPublicKey: source.serverPublicKey
      ?? (canReuseIdentity && current?.endpoint === endpoint ? current.serverPublicKey : ''),
    tailscaleHttpsPort,
    limits: source.limits ?? current?.limits,
    ssh: {
      host,
      user: sshUser,
      port: sshPort,
      keyPath: auth.kind === 'key-file'
        ? auth.keyPath
        : source.ssh?.keyPath ?? current?.ssh?.keyPath ?? '',
      useTailscaleSsh: transport === 'tailscale',
    },
  });
}

const SERVER_TO_LOCAL_STATE = Object.freeze({
  created: 'queued',
  pending: 'queued',
  queued: 'queued',
  starting: 'queued',
  active: 'running',
  running: 'running',
  paused: 'suspended',
  blocked: 'suspended',
  suspended: 'suspended',
  completed: 'completed',
  complete: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  expired: 'expired',
  failed: 'failed',
});

function unmanagedSandboxMessage(sandbox) {
  const where = sandbox?.host ? ` at ${sandbox.host}` : '';
  return `This app cannot manage the ${sandbox?.providerId || 'app-provided'} sandbox${where}.`
    + ' Release it here, then delete the server in the provider console.';
}

function cloudState(value, fallback = 'queued') {
  return SERVER_TO_LOCAL_STATE[String(value ?? '').toLowerCase()] ?? fallback;
}

function asIso(value, fallback = null) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  if (Number.isFinite(Number(value)) && Number(value) > 0) return new Date(Number(value)).toISOString();
  return fallback;
}

function goalFromTransfer(payload) {
  const messages = payload?.timeline?.thread?.messages;
  if (Array.isArray(messages)) {
    const latest = messages.findLast((message) => message?.role === 'user' && typeof message.text === 'string' && message.text.trim());
    if (latest) return latest.text.trim().slice(0, 64 * 1024);
  }
  const title = payload?.timeline?.thread?.title;
  if (typeof title === 'string' && title.trim()) return title.trim().slice(0, 64 * 1024);
  return 'Continue the active Rauhwpx task autonomously.';
}

const CLIENT_TO_SERVER_COMMAND = Object.freeze({
  pause: 'session.pause',
  resume: 'session.resume',
  takeover: 'session.takeover',
  cancel: 'session.cancel',
  retry: 'session.resume',
  'queue-message': 'message.queue',
});

export class CloudCoordinator extends EventEmitter {
  #client;
  #store;
  #provisioner;
  #recoveryDir;
  #watchers = new Map();
  #recoveryTimers = new Map();
  #resultRecoveryTimers = new Map();
  #transferControllers = new Map();
  #transferPromises = new Map();
  #transferOperations = new Set();
  #transferRemoteSessions = new Map();
  #transferCancelPromises = new Map();
  #takeoverControllers = new Map();
  #takeoverPromises = new Map();
  #remoteSessions = new Map();
  #remoteWatchSequence = new Map();
  #timelinePending = new Map();
  #transferAdmissionChain = Promise.resolve();
  #snapshotChain = Promise.resolve();
  #revision = 0;
  #appServers;
  #sandboxLifecycle = 'idle';
  #sandboxMessage = null;
  #spawnPromise = null;
  #spawnController = null;
  #statusPromise = null;
  #teardownPromise = null;
  #provisionPromise = null;
  #preferredMode = null;
  #stopped = false;
  #collectProviderAuth;
  #collectImportedAuth;

  constructor({
    client,
    store,
    provisioner,
    recoveryDir,
    appServers = [],
    collectProviderAuth = null,
    collectImportedAuth = null,
  } = {}) {
    super();
    this.#client = client;
    this.#store = store;
    this.#provisioner = provisioner;
    this.#recoveryDir = recoveryDir;
    this.#appServers = Array.isArray(appServers) ? createAppServerRegistry(appServers) : appServers;
    this.#collectProviderAuth = typeof collectProviderAuth === 'function' ? collectProviderAuth : null;
    this.#collectImportedAuth = typeof collectImportedAuth === 'function' ? collectImportedAuth : null;
  }

  async #providerAuthFor(provider) {
    if (!provider) return null;
    if (typeof this.#collectImportedAuth === 'function') {
      try {
        const imported = await this.#collectImportedAuth(provider);
        if (imported) return imported;
      } catch {
        // The shared seed collector below covers older desktop auth locations
        // and keeps transfer compatible when the import-specific collector is stale.
      }
    }
    return importedAuthFromCollected(await this.#providerAuth(provider));
  }

  async start() {
    this.#stopped = false;
    this.#preferredMode = await this.#client.loadServerMode?.().catch(() => null) ?? null;
    const profile = await this.#client.loadProfile().catch(() => null);
    const pendingSandboxBlocked = await this.#recoverPendingAppSandbox(profile);
    if (!pendingSandboxBlocked && profile?.mode === 'app-hosted') {
      const unmanaged = this.#sandboxProvider(profile.sandbox) ? null : unmanagedSandboxMessage(profile.sandbox);
      if (unmanaged) this.#setSandboxLifecycle('error', unmanaged);
      else {
        const paired = await this.#client.isPaired().catch(() => false);
        if (!paired) {
          this.#setSandboxLifecycle('error', 'This app sandbox is not paired with this device. Reconnect or shut it down before creating another one.');
        } else {
          try {
            await this.#waitForProfileHealth(profile, { attempts: 2 });
            this.#setSandboxLifecycle('ready');
          } catch (error) {
            this.#setSandboxLifecycle('error', `The saved app sandbox is not reachable: ${error.message}`);
          }
        }
      }
    }
    const records = await this.#store.load();
    for (const record of records) {
      if (record.resolvedAt && record.recoveryCleanupPath) {
        await this.#cleanupResolvedRecovery(record);
        continue;
      }
      if (['preparing', 'uploading', 'committing'].includes(record.state) && record.documentStagingPath) {
        this.#scheduleTransferRecovery(record.id, 0);
        continue;
      }
      if (record.cloudSessionId && record.documentStagingPath) {
        void this.#store.clearPayload(record.id).catch((error) => {
          this.#emit({ type: 'payload-cleanup-failed', handoffId: record.id, error: error.message });
        });
      }
      if (record.state === 'downloading' && record.recoveryPath && record.resultDigest) {
        this.#scheduleResultRecovery(record.id, 0);
        continue;
      }
      if (record.cloudSessionId && ['queued', 'running', 'suspended', 'completed'].includes(record.state)) {
        this.#watch(record.id, record.cloudSessionId, record.lastEventSequence);
      }
    }
    return this.snapshot();
  }

  async stop() {
    this.#stopped = true;
    const pending = [
      ...this.#transferOperations,
      ...this.#transferPromises.values(),
      ...this.#takeoverPromises.values(),
      this.#transferAdmissionChain,
      this.#spawnPromise,
      this.#teardownPromise,
      this.#provisionPromise,
    ].filter(Boolean);
    for (const controller of this.#watchers.values()) controller.abort();
    this.#watchers.clear();
    for (const timer of this.#recoveryTimers.values()) clearTimeout(timer);
    this.#recoveryTimers.clear();
    for (const timer of this.#resultRecoveryTimers.values()) clearTimeout(timer);
    this.#resultRecoveryTimers.clear();
    for (const controller of this.#transferControllers.values()) controller.abort();
    this.#transferControllers.clear();
    for (const controller of this.#takeoverControllers.values()) controller.abort();
    this.#takeoverControllers.clear();
    // An in-flight spawn can hold a billable provider sandbox for minutes;
    // aborting lets its cleanup path run instead of orphaning the service.
    this.#spawnController?.abort(new Error('Cloud coordinator stopped'));
    this.#spawnController = null;
    await Promise.allSettled(pending);
    await this.#store.flush?.();
  }

  snapshot(options = {}) {
    const operation = this.#snapshotChain.then(() => this.#buildSnapshot(options));
    this.#snapshotChain = operation.catch(() => {});
    return operation;
  }

  async #buildSnapshot({
    selectedSessionId = null,
    originSessionId = null,
    documentId = null,
    profileConnection = null,
    profileMessage = null,
    extra = {},
  } = {}) {
    const profile = await this.#client.loadProfile().catch(() => null);
    const paired = profile ? await this.#client.isPaired().catch(() => false) : false;
    const records = await this.#store.list();
    const visibleRecords = records.filter((record) => !record.resolvedAt);
    const byCreation = (left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''));
    const scoped = Boolean(originSessionId || documentId);
    const scopedRecords = visibleRecords.filter((record) => (
      (originSessionId && record.originSessionId === originSessionId)
      || (documentId && record.originDocumentId === documentId)
    )).sort(byCreation);
    const localMatch = scopedRecords.find((record) => LIVE_HANDOFF_STATES.includes(record.state))
      ?? scopedRecords[0]
      ?? null;
    const selected = visibleRecords.find((record) => record.cloudSessionId === selectedSessionId)
      ?? localMatch
      ?? (!scoped ? visibleRecords.filter((record) => LIVE_HANDOFF_STATES.includes(record.state)).sort(byCreation)[0] : null)
      ?? (!scoped ? [...visibleRecords].sort(byCreation)[0] : null)
      ?? null;
    const remoteMatch = [...this.#remoteSessions.values()].find((session) => (
      documentId && session.clientContext?.documentId === documentId
    ));
    const remote = this.#remoteSessions.get(selectedSessionId)
      ?? remoteMatch
      ?? (!selected ? [...this.#remoteSessions.values()].find((session) => !['purged', 'cancelled', 'failed'].includes(session.status)) : null)
      ?? (!selected ? [...this.#remoteSessions.values()][0] : null)
      ?? null;
    const now = new Date().toISOString();
    const publicSessionsById = new Map();
    for (const session of this.#remoteSessions.values()) {
      const publicSession = this.#publicRemoteSession(session);
      if (publicSession.kind !== 'idle') publicSessionsById.set(publicSession.sessionId, publicSession);
    }
    for (const record of visibleRecords) {
      const publicSession = this.#publicSession(record);
      if (publicSession.kind !== 'idle') publicSessionsById.set(publicSession.sessionId, publicSession);
    }
    const connection = profileConnection ?? (paired ? 'ready' : 'unknown');
    const profileState = !profile
      ? { kind: 'unconfigured' }
      : profile.mode === 'app-hosted'
        ? {
            kind: 'configured',
            mode: 'app-hosted',
            name: profile.name,
            sandbox: this.#publicSandbox(profile.sandbox),
            connection,
            serviceVersion: null,
            message: profileMessage,
          }
        : {
            kind: 'configured',
            mode: 'self-hosted',
            profile: {
              name: profile.name,
              host: profile.ssh.host,
              sshUser: profile.ssh.user,
              sshPort: profile.ssh.port,
              tailscaleHttpsPort: profile.tailscaleHttpsPort,
              auth: profile.ssh.keyPath
                ? { kind: 'key-file', keyPath: profile.ssh.keyPath }
                : { kind: 'ssh-agent' },
              transport: profile.transport === 'tailscale'
                ? { kind: 'tailscale' }
                : profile.transport === 'ssh-tunnel'
                  ? { kind: 'ssh-tunnel' }
                  : { kind: 'https', endpoint: profile.endpoint },
              serverPublicKey: profile.serverPublicKey || undefined,
            },
            connection,
            serviceVersion: null,
            message: profileMessage,
          };
    return {
      revision: ++this.#revision,
      available: true,
      profile: profileState,
      server: {
        mode: profile?.mode ?? null,
        preferredMode: this.#preferredMode,
        providers: this.#appServers.list(),
        lifecycle: this.#sandboxLifecycle,
        message: this.#sandboxMessage,
      },
      lease: selected && !selected.resolvedAt && (selected === localMatch || !scoped) && !['failed', 'cancelled', 'expired'].includes(selected.state)
        ? { owner: 'cloud', sessionId: selected.cloudSessionId ?? selected.id, acquiredAt: selected.createdAt }
        : { owner: 'local' },
      session: selected ? this.#publicSession(selected) : this.#publicRemoteSession(remote),
      sessions: [...publicSessionsById.values()],
      queuedMessages: selected?.queuedMessages ?? [],
      timeline: selected?.timeline ?? remote?.timeline ?? null,
      updatedAt: now,
      ...extra,
    };
  }

  async refresh(options = {}) {
    const profile = await this.#client.loadProfile().catch(() => null);
    if (profile && await this.#client.isPaired().catch(() => false)) {
      try {
        const sessions = await this.#client.sessions();
        const deviceId = await this.#client.deviceId();
        const hydratedSessions = await Promise.all(sessions.map(async (session) => this.#hydrateRemoteTakeover({
          ...session,
          originOnThisDevice: Boolean(deviceId && session.originDeviceId === deviceId),
        })));
        this.#remoteSessions = new Map(hydratedSessions.map((session) => [
          session.id ?? session.sessionId,
          session,
        ]));
        const localIds = new Set((await this.#store.list()).map((record) => record.cloudSessionId).filter(Boolean));
        for (const session of sessions) {
          const sessionId = session.id ?? session.sessionId;
          if (sessionId && !localIds.has(sessionId) && ['staged', 'queued', 'running', 'suspended', 'completed'].includes(session.status)) {
            this.#watchRemote(sessionId);
          }
        }
        const remote = this.#remoteSessions.get(options.selectedSessionId)
          ?? [...this.#remoteSessions.values()].find((session) => (
            options.documentId && session.clientContext?.documentId === options.documentId
          ));
        if (remote) await this.#syncRemoteTimeline(remote.id ?? remote.sessionId).catch(() => {});
      } catch (error) {
        return this.snapshot({ ...options, profileConnection: 'error', profileMessage: error.message });
      }
    }
    return this.snapshot(options);
  }

  /** 앱 샌드박스를 먼저 철거하지 않으면 유료 자원이 주인 없이 남는다. */
  #assertNotReplacingSandbox(current, next) {
    if (current?.mode === 'app-hosted' && next.mode !== 'app-hosted') {
      throw new AppServerError(
        'Shut down the app-provided sandbox before connecting your own server.',
        { code: 'SANDBOX_STILL_ACTIVE', retryable: false },
      );
    }
  }

  async #adoptSelfHostedMode() {
    this.#preferredMode = await this.#client.saveServerMode('self-hosted').catch((error) => {
      this.#emit({ type: 'server-mode-persist-failed', mode: 'self-hosted', error: error.message });
      return this.#preferredMode;
    });
    this.#setSandboxLifecycle('idle');
  }

  async #waitForProfileHealth(profile, { attempts = 12, signal } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const health = await this.#client.health(profile, {
          signal,
          timeoutMs: 10_000,
          retryAttempts: 1,
        });
        if (health?.ok !== true) {
          throw transferError('Cloud health response failed identity verification', 'SERVER_IDENTITY_MISMATCH');
        }
        if (profile.serverPublicKey && health.serverPublicKey !== profile.serverPublicKey) {
          throw transferError('Cloud server identity changed during readiness checks', 'SERVER_IDENTITY_MISMATCH');
        }
        return health;
      } catch (error) {
        lastError = error;
        if (signal?.aborted || nonRetryableTransferError(error) || attempt === attempts - 1) throw error;
        await delay(
          Math.min(5_000, 500 * (2 ** Math.min(attempt, 4))),
          undefined,
          signal ? { signal } : undefined,
        );
      }
    }
    throw lastError ?? new Error('Cloud server did not become healthy');
  }

  async saveProfile(input) {
    const current = await this.#client.loadProfile().catch(() => null);
    const profile = uiProfileToStored(input, current);
    this.#assertNotReplacingSandbox(current, profile);
    await this.#client.saveProfile(profile);
    await this.#adoptSelfHostedMode();
    return this.snapshot();
  }

  async testProfile(input = {}) {
    const current = await this.#client.loadProfile().catch(() => null);
    const profile = input?.profile ? uiProfileToStored(input, current) : current;
    if (!profile) throw new Error('Cloud VPS is not configured');
    if (profile.mode !== 'self-hosted') {
      throw new Error('This connection uses an app-provided sandbox, which has no SSH check');
    }
    const preflight = await this.#provisioner.preflight(profile.ssh, {
      onLine: (line) => this.#emit({ type: 'provision-log', line }),
    });
    let health = null;
    if (current && profile.endpoint === current.endpoint) {
      health = await this.#client.health(profile).catch((error) => ({ ok: false, error: error.message }));
    }
    return this.snapshot({
      profileConnection: health == null ? 'unknown' : (health.ok === false ? 'error' : 'ready'),
      profileMessage: health?.error ?? null,
      extra: { test: { ok: true, preflight, health } },
    });
  }

  provision(options = {}) {
    if (this.#provisionPromise) return this.#provisionPromise;
    const operation = this.#provision(options);
    this.#provisionPromise = operation;
    return operation.finally(() => {
      if (this.#provisionPromise === operation) this.#provisionPromise = null;
    });
  }

  async #provision({ installChannel = 'stable', profile: profileDraft } = {}) {
    const current = await this.#client.loadProfile().catch(() => null);
    const profile = profileDraft ? uiProfileToStored(profileDraft, current) : current;
    if (!profile) throw new Error('Provide a VPS profile before provisioning');
    if (profile.mode !== 'self-hosted') {
      throw new Error('App-provided sandboxes are created by the app, not installed over SSH');
    }
    this.#assertNotReplacingSandbox(current, profile);
    this.#emit({ type: 'provision-started' });
    const receipt = await this.#provisioner.provision(profile.ssh, {
      channel: installChannel,
      transport: profile.transport,
      tailscaleHttpsPort: profile.tailscaleHttpsPort,
      publicHost: profile.transport === 'public-https' ? new URL(profile.endpoint).hostname : '',
      onLine: (line) => this.#emit({ type: 'provision-log', line }),
    });
    const updated = normalizeCloudProfile({
      ...profile,
      endpoint: receipt.endpoint,
      serverPublicKey: receipt.serverPublicKey,
      tailscaleHttpsPort: receipt.tailscaleHttpsPort ?? profile.tailscaleHttpsPort,
    });
    let credentials = null;
    let preserveCredentials = false;
    // The installer receipt can arrive before fresh DNS, TLS, Tailscale Serve,
    // or an SSH forward is usable. Wait for the pinned API before consuming the
    // one-time pairing code so a warm-up race cannot strand the installation.
    const health = await this.#waitForProfileHealth(updated);
    if (receipt.pairingCode) {
      const pairing = await this.#client.redeemPairingCode(receipt.pairingCode, hostname(), {
        profile: updated,
        persist: false,
      });
      credentials = pairing.credentials;
    } else {
      preserveCredentials = Boolean(
        current
        && current.serverPublicKey === updated.serverPublicKey
        && await this.#client.isPaired(),
      );
      if (!preserveCredentials) {
        throw new Error('VPS installer did not return the initial pairing code');
      }
    }
    await this.#client.activateProfile(updated, credentials ? {
      tokens: credentials,
      device: credentials.device,
    } : { preserveCredentials });
    await this.#adoptSelfHostedMode();
    const snapshot = await this.snapshot({ extra: { provision: { ok: true, receipt, health } } });
    this.#emit({ type: 'provision-completed', snapshot });
    return snapshot;
  }

  #publicSandbox(sandbox) {
    const descriptor = sandbox && this.#appServers.has(sandbox.providerId)
      ? this.#appServers.describe(sandbox.providerId)
      : null;
    return {
      providerId: sandbox.providerId,
      sandboxId: sandbox.sandboxId,
      displayName: descriptor?.displayName ?? sandbox.providerId,
      region: sandbox.region,
      host: sandbox.host,
      createdAt: sandbox.createdAt,
    };
  }

  #setSandboxLifecycle(lifecycle, message = null) {
    this.#sandboxLifecycle = lifecycle;
    this.#sandboxMessage = message;
  }

  /** 저장된 샌드박스의 공급자가 이 빌드에 없을 수 있다. 그때도 사용자는 연결을 놓을 수 있어야 한다. */
  #sandboxProvider(sandbox) {
    const providerId = sandbox?.providerId;
    return providerId && this.#appServers.has(providerId) ? this.#appServers.get(providerId) : null;
  }

  async #recoverPendingAppSandbox(profile) {
    if (typeof this.#client.loadPendingAppSandbox !== 'function') return false;
    let pending;
    try {
      pending = await this.#client.loadPendingAppSandbox();
    } catch (error) {
      this.#setSandboxLifecycle('error', `The pending sandbox journal could not be read: ${error.message}`);
      return true;
    }
    if (!pending) return false;
    if (profile?.mode === 'app-hosted'
      && profile.sandbox?.providerId === pending.providerId
      && profile.sandbox?.sandboxId === pending.sandbox.sandboxId) {
      try {
        await this.#client.clearPendingAppSandbox();
      } catch (error) {
        this.#emit({ type: 'sandbox-journal-clear-failed', error: error.message });
        this.#setSandboxLifecycle('error', `The completed sandbox journal could not be cleared: ${error.message}`);
        return true;
      }
      return false;
    }
    const provider = this.#sandboxProvider(pending.sandbox);
    if (!provider) {
      this.#setSandboxLifecycle('error', unmanagedSandboxMessage(pending.sandbox));
      return true;
    }
    this.#setSandboxLifecycle('tearing-down', 'Cleaning up an interrupted app sandbox creation.');
    try {
      await provider.teardown(pending.sandbox);
      await this.#client.clearPendingAppSandbox();
      this.#setSandboxLifecycle('idle');
      this.#emit({
        type: 'sandbox-interrupted-spawn-cleaned',
        providerId: pending.providerId,
        sandboxId: pending.sandbox.sandboxId,
      });
      return false;
    } catch (error) {
      this.#setSandboxLifecycle('error', `Interrupted sandbox cleanup failed: ${error.message}`);
      this.#emit({ type: 'sandbox-cleanup-failed', providerId: pending.providerId, error: error.message });
      return true;
    }
  }

  async selectServerMode(mode) {
    this.#preferredMode = await this.#client.saveServerMode(mode);
    return this.snapshot();
  }

  async #providerAuth(provider) {
    if (!provider || typeof this.#collectProviderAuth !== 'function') return null;
    try {
      return await this.#collectProviderAuth(provider);
    } catch {
      return null;
    }
  }

  async #seedRemoteProvider(provider) {
    if (!provider || typeof this.#client.seedProviderCredentials !== 'function') return;
    const auth = await this.#providerAuth(provider);
    if (!hasProviderAuth(auth)) return;
    try {
      await this.#client.seedProviderCredentials(auth);
    } catch (error) {
      if (error?.status !== 404) throw error;
      // Some sandboxes import auth during transfer through PUT /auth but do not
      // expose this newer seed route. Let transfer negotiate that fallback.
    }
  }

  #appServerFor(providerId) {
    if (!this.#appServers.size) {
      throw new AppServerError('This build does not include app-provided servers', {
        code: 'PROVIDER_UNAVAILABLE',
        retryable: false,
      });
    }
    const provider = providerId ? this.#appServers.get(providerId) : this.#appServers.preferred();
    const configuration = provider.configuration();
    if (configuration.configured !== true) {
      throw new AppServerError(
        `App-provided servers are not configured on this build: ${(configuration.missing ?? []).join(', ')}`,
        { code: 'PROVIDER_NOT_CONFIGURED', retryable: false },
      );
    }
    return provider;
  }

  /** 동시 요청은 진행 중인 생성 작업을 공유해 유료 샌드박스를 중복 생성하지 않는다. */
  spawnAppServer(options = {}) {
    if (this.#spawnPromise) return this.#spawnPromise;
    if (this.#teardownPromise) {
      return Promise.reject(new AppServerError('An app sandbox is being torn down. Try again once it finishes.', {
        code: 'SANDBOX_BUSY',
      }));
    }
    const operation = this.#spawnAppServer(options);
    this.#spawnPromise = operation;
    return operation.finally(() => {
      if (this.#spawnPromise === operation) this.#spawnPromise = null;
    });
  }

  async #spawnAppServer({ providerId = null, deviceName = hostname() } = {}) {
    const pending = await this.#client.loadPendingAppSandbox?.();
    if (pending) {
      throw new AppServerError(
        'An interrupted app sandbox still needs cleanup before another one can be created.',
        { code: 'SANDBOX_RECOVERY_REQUIRED', retryable: true },
      );
    }
    const current = await this.#client.loadProfile().catch(() => null);
    if (current?.mode === 'app-hosted') {
      if (!await this.#client.isPaired().catch(() => false)) {
        this.#setSandboxLifecycle('error', 'This app sandbox is not paired with this device.');
        throw new AppServerError(
          'An existing app sandbox needs to be reconnected or shut down before a new one can be created.',
          { code: 'SANDBOX_PAIRING_REQUIRED', retryable: false },
        );
      }
      const provider = this.#sandboxProvider(current.sandbox);
      if (!provider) {
        throw new AppServerError(unmanagedSandboxMessage(current.sandbox), {
          code: 'SANDBOX_PROVIDER_UNAVAILABLE', retryable: false,
        });
      }
      let status;
      try {
        status = await provider.status(current.sandbox);
      } catch (error) {
        this.#setSandboxLifecycle('error', error.message);
        throw new AppServerError(`Could not verify the existing app sandbox: ${error.message}`, {
          code: 'SANDBOX_STATUS_UNAVAILABLE', cause: error,
        });
      }
      if (status?.lifecycle === 'provisioning') {
        throw new AppServerError('The app sandbox is still starting. Try again once it finishes.', {
          code: 'SANDBOX_BUSY',
        });
      }
      if (status?.lifecycle === 'error') {
        this.#setSandboxLifecycle('error', status.message ?? null);
        throw new AppServerError(status.message ?? 'The app sandbox is in a failed state. Shut it down and start a new one.', {
          code: 'SANDBOX_DEPLOY_FAILED',
        });
      }
      if (status.lifecycle === 'ready') {
        try {
          await this.#waitForProfileHealth(current, { attempts: 3 });
        } catch (error) {
          this.#setSandboxLifecycle('error', error.message);
          throw new AppServerError(`The existing app sandbox is deployed but unreachable: ${error.message}`, {
            code: 'SANDBOX_UNHEALTHY', cause: error,
          });
        }
        this.#setSandboxLifecycle('ready');
        this.#preferredMode = await this.#client.saveServerMode('app-hosted').catch((error) => {
          this.#emit({ type: 'server-mode-persist-failed', mode: 'app-hosted', error: error.message });
          return 'app-hosted';
        });
        return this.snapshot({ extra: { sandbox: { ok: true, reused: true } } });
      }
      // lifecycle 'idle': the deployment was deleted out-of-band, so a fresh
      // sandbox is provisioned instead of reusing one that no longer exists.
      this.#emit({ type: 'provision-log', line: status.message ?? 'The previous app sandbox no longer exists.' });
    }
    const provider = this.#appServerFor(providerId);
    this.#setSandboxLifecycle('provisioning', 'Starting an app-provided sandbox.');
    this.#emit({ type: 'sandbox-provision-started', providerId: provider.id });
    let spawned = null;
    const controller = new AbortController();
    this.#spawnController = controller;
    try {
      spawned = await provider.spawn({
        deviceName,
        limits: current?.limits,
        selectedProvider: current?.provider ?? 'codex',
        credentials: await this.#providerAuth(current?.provider ?? 'codex'),
        signal: controller.signal,
        onLine: (line) => this.#emit({ type: 'provision-log', line }),
        onSandboxCreated: async (sandbox) => {
          await this.#client.savePendingAppSandbox?.({ providerId: provider.id, sandbox });
        },
        onSandboxRemoved: async () => {
          await this.#client.clearPendingAppSandbox?.();
        },
      });
      const profile = normalizeCloudProfile({
        mode: 'app-hosted',
        name: provider.displayName,
        endpoint: spawned.receipt.endpoint,
        serverPublicKey: spawned.receipt.serverPublicKey,
        sandbox: spawned.sandbox,
        provider: current?.provider ?? 'codex',
        limits: current?.limits,
      });
      const pairing = await this.#client.redeemPairingCode(spawned.receipt.pairingCode, deviceName, {
        profile,
        persist: false,
      });
      const health = await this.#client.health(profile);
      if (health.ok !== true || health.serverPublicKey !== spawned.receipt.serverPublicKey) {
        throw new AppServerError('App sandbox failed identity verification', {
          code: 'SANDBOX_IDENTITY_MISMATCH',
          retryable: false,
        });
      }
      await this.#client.activateProfile(profile, {
        tokens: pairing.credentials,
        device: pairing.credentials.device,
      });
      await this.#client.clearPendingAppSandbox?.().catch((error) => {
        this.#emit({ type: 'sandbox-journal-clear-failed', error: error.message });
      });
      this.#preferredMode = await this.#client.saveServerMode('app-hosted').catch((error) => {
        this.#emit({ type: 'server-mode-persist-failed', mode: 'app-hosted', error: error.message });
        return 'app-hosted';
      });
      this.#setSandboxLifecycle('ready');
      const snapshot = await this.snapshot({ extra: { sandbox: { ok: true, reused: false } } });
      this.#emit({ type: 'sandbox-ready', providerId: provider.id, snapshot });
      return snapshot;
    } catch (error) {
      if (error?.cleanupFailed) {
        this.#emit({ type: 'sandbox-cleanup-failed', providerId: provider.id, error: error.cleanupFailed });
      }
      if (spawned?.sandbox) {
        try {
          await provider.teardown(spawned.sandbox);
          await this.#client.clearPendingAppSandbox?.();
        } catch (cleanupError) {
          this.#emit({ type: 'sandbox-cleanup-failed', providerId: provider.id, error: cleanupError.message });
        }
      }
      this.#setSandboxLifecycle('error', error.message);
      this.#emit({
        type: 'sandbox-provision-failed',
        providerId: provider.id,
        error: error.message,
        snapshot: await this.snapshot(),
      });
      throw error;
    } finally {
      if (this.#spawnController === controller) this.#spawnController = null;
    }
  }

  /** Concurrent polls share one provider request instead of stacking duplicates. */
  appServerStatus(options = {}) {
    if (!this.#statusPromise) {
      this.#statusPromise = this.#appServerStatus(options).finally(() => {
        this.#statusPromise = null;
      });
    }
    return this.#statusPromise;
  }

  async #appServerStatus() {
    const profile = await this.#client.loadProfile().catch(() => null);
    if (profile?.mode !== 'app-hosted') {
      if (this.#sandboxLifecycle !== 'provisioning' && this.#sandboxLifecycle !== 'tearing-down') {
        this.#setSandboxLifecycle('idle');
      }
      return this.snapshot();
    }
    const provider = this.#sandboxProvider(profile.sandbox);
    if (!provider) {
      const message = unmanagedSandboxMessage(profile.sandbox);
      this.#setSandboxLifecycle('error', message);
      return this.snapshot({ profileConnection: 'error', profileMessage: message });
    }
    try {
      const status = await provider.status(profile.sandbox);
      this.#setSandboxLifecycle(status.lifecycle, status.message ?? null);
      return this.snapshot({ extra: { sandbox: { ok: true, status: status.status ?? null } } });
    } catch (error) {
      // A transport failure says nothing about the sandbox itself; keep the
      // last known lifecycle and surface the connection problem instead.
      return this.snapshot({ profileConnection: 'error', profileMessage: error.message });
    }
  }

  /** 이미 사라진 샌드박스도 같은 결과를 돌려준다. */
  teardownAppServer(options = {}) {
    if (this.#teardownPromise) return this.#teardownPromise;
    if (this.#spawnPromise) {
      return Promise.reject(new AppServerError('An app sandbox is still being created. Try again once it finishes.', {
        code: 'SANDBOX_BUSY',
      }));
    }
    const operation = this.#teardownAppServer(options);
    this.#teardownPromise = operation;
    return operation.finally(() => {
      if (this.#teardownPromise === operation) this.#teardownPromise = null;
    });
  }

  async #teardownAppServer({ force = false } = {}) {
    const profile = await this.#client.loadProfile().catch(() => null);
    if (profile?.mode !== 'app-hosted') {
      this.#setSandboxLifecycle('idle');
      return this.snapshot({ extra: { sandbox: { ok: true, removed: false } } });
    }
    if (!force) {
      const live = (await this.#store.list()).filter((record) => (
        !record.resolvedAt && LIVE_HANDOFF_STATES.includes(record.state)
      ));
      if (live.length) {
        throw new AppServerError(
          'Finish or cancel the cloud work on this sandbox before shutting it down.',
          { code: 'SANDBOX_HAS_WORK', retryable: false },
        );
      }
    }
    const provider = this.#sandboxProvider(profile.sandbox);
    if (!provider) {
      await this.#client.forgetProfile();
      this.#setSandboxLifecycle('idle');
      this.#emit({ type: 'sandbox-abandoned', providerId: profile.sandbox.providerId, sandboxId: profile.sandbox.sandboxId });
      return this.snapshot({ extra: { sandbox: { ok: true, removed: false, unmanaged: true } } });
    }
    this.#setSandboxLifecycle('tearing-down', 'Shutting down the app sandbox.');
    this.#emit({ type: 'sandbox-teardown-started', providerId: provider.id });
    try {
      const result = await provider.teardown(profile.sandbox);
      await this.#client.forgetProfile();
      this.#setSandboxLifecycle('idle');
      const snapshot = await this.snapshot({ extra: { sandbox: { ok: true, removed: result.removed === true } } });
      this.#emit({ type: 'sandbox-torn-down', providerId: provider.id, snapshot });
      return snapshot;
    } catch (error) {
      this.#setSandboxLifecycle('error', error.message);
      this.#emit({ type: 'sandbox-teardown-failed', providerId: provider.id, error: error.message });
      throw error;
    }
  }

  async pair({ code, profile: profileDraft } = {}) {
    const current = await this.#client.loadProfile().catch(() => null);
    const profile = profileDraft ? uiProfileToStored(profileDraft, current) : current;
    if (!profile?.serverPublicKey) {
      throw new Error('Enter the VPS server identity key before pairing this device');
    }
    this.#assertNotReplacingSandbox(current, profile);
    const pairing = await this.#client.redeemPairingCode(code, hostname(), {
      profile,
      persist: false,
    });
    const health = await this.#client.health(profile);
    if (health.ok !== true || health.serverPublicKey !== profile.serverPublicKey) {
      throw new Error('Paired cloud service failed identity verification');
    }
    await this.#client.activateProfile(profile, {
      tokens: pairing.credentials,
      device: pairing.credentials.device,
    });
    if (profile.mode === 'self-hosted') await this.#adoptSelfHostedMode();
    else this.#setSandboxLifecycle('ready');
    const snapshot = await this.snapshot();
    this.#emit({ type: 'paired', snapshot });
    return snapshot;
  }

  async #admitTransfer(input) {
    const operation = this.#transferAdmissionChain.then(async () => {
      if (this.#stopped) throw transferError('Cloud coordinator is stopped', 'COORDINATOR_STOPPED');
      if (this.#teardownPromise || this.#sandboxLifecycle === 'tearing-down') {
        throw transferError('Cloud sandbox is shutting down', 'SANDBOX_TEARDOWN_IN_PROGRESS');
      }
      if (this.#spawnPromise) await this.#spawnPromise;
      const readiness = typeof this.#client.assertTransferReady === 'function'
        ? await this.#client.assertTransferReady()
        : null;
      if (this.#stopped) throw transferError('Cloud coordinator is stopped', 'COORDINATOR_STOPPED');
      if (this.#teardownPromise || this.#sandboxLifecycle === 'tearing-down') {
        throw transferError('Cloud sandbox is shutting down', 'SANDBOX_TEARDOWN_IN_PROGRESS');
      }
      const duplicate = (await this.#store.list({ activeOnly: true })).find((record) => (
        (input.sessionId && record.originSessionId === input.sessionId)
        || (input.documentId && record.originDocumentId === input.documentId)
      ));
      if (duplicate) {
        throw transferError('This document already has an active cloud transfer', 'TRANSFER_ALREADY_ACTIVE');
      }
      return this.#store.create({
        ...input,
        destination: destinationFromReadiness(readiness),
      });
    });
    this.#transferAdmissionChain = operation.catch(() => {});
    return operation;
  }

  transfer(payload, options) {
    if (this.#stopped) {
      return Promise.reject(transferError('Cloud coordinator is stopped', 'COORDINATOR_STOPPED'));
    }
    const operation = this.#transfer(payload, options);
    this.#transferOperations.add(operation);
    return operation.finally(() => this.#transferOperations.delete(operation));
  }

  async #transfer(payload, { originSessionId, originPath = null } = {}) {
    const bytes = Buffer.from(payload?.document?.bytes ?? []);
    const goal = goalFromTransfer(payload);
    const record = await this.#admitTransfer({
      sessionId: originSessionId,
      threadId: payload?.threadId,
      documentId: payload?.documentId,
      originPath,
      documentName: payload?.document?.fileName ?? payload?.documentName,
      documentBytes: bytes,
      timeline: payload?.timeline,
      provider: payload?.agent,
      executionConfig: {
        model: payload?.model,
        effort: payload?.effort,
        workflow: payload?.workflow,
        permissionProfile: 'unrestricted',
      },
      goal,
      limits: {
        maxDurationMinutes: Math.max(15, Math.ceil(Number(payload?.limits?.maxDurationMs) / 60_000) || 480),
        maxTurns: payload?.limits?.maxTurns ?? 100,
      },
      resources: payload?.references,
    });
    await this.#store.transition(record.id, 'uploading');
    let committed = false;
    const controller = new AbortController();
    this.#transferControllers.set(record.id, controller);
    try {
      this.#emit({
        type: 'session-transfer',
        handoffId: record.id,
        state: 'uploading',
        snapshot: await this.snapshot(),
      });
      if (this.#stopped) throw transferError('Cloud coordinator is stopped', 'COORDINATOR_STOPPED');
      await this.#seedRemoteProvider(record.provider);
      const transferPromise = this.#client.transfer({
        sessionId: record.id,
        threadId: record.threadId,
        documentId: record.originDocumentId,
        provider: payload?.agent,
        executionConfig: record.executionConfig,
        goal,
        documentName: payload?.document?.fileName ?? payload?.documentName,
        documentBytes: bytes,
        timeline: payload?.timeline,
        resources: payload?.references ?? [],
        limits: record.limits,
        providerAuth: await this.#providerAuthFor(payload?.agent),
        signal: controller.signal,
        onSessionCreated: async ({ sessionId, stateVersion }) => {
          this.#transferRemoteSessions.set(record.id, { sessionId, stateVersion });
          await this.#store.patch(record.id, {
            cloudSessionId: sessionId,
            serverVersion: stateVersion,
          });
        },
        onSessionActivated: async ({ sessionId, stateVersion, eventSeq }) => {
          this.#transferRemoteSessions.set(record.id, { sessionId, stateVersion, eventSeq });
          await this.#store.patch(record.id, {
            cloudSessionId: sessionId,
            serverVersion: stateVersion,
            ...(Number.isSafeInteger(eventSeq) && eventSeq > 0 ? { lastEventSequence: eventSeq } : {}),
          });
        },
        onProgress: async (progress) => {
          if (progress.phase === 'committing' && !committed) {
            committed = true;
            await this.#store.transition(record.id, 'committing');
          }
          // The per-window broadcast snapshot is built by the main process;
          // blocking the upload on a full snapshot per chunk stalls it.
          this.#emit({
            type: 'session-transfer-progress',
            handoffId: record.id,
            progress,
          });
        },
      });
      this.#transferPromises.set(record.id, transferPromise);
      const session = await transferPromise;
      const beforeCommit = await this.#store.get(record.id);
      if (beforeCommit?.cancelRequested) {
        await this.#finalizeTransferCancellation(beforeCommit);
        return this.snapshot({ selectedSessionId: beforeCommit.id });
      }
      if (!committed) await this.#store.transition(record.id, 'committing');
      const state = cloudState(session.state ?? session.status);
      const updated = await this.#store.transition(record.id, state, {
        cloudSessionId: session.id ?? session.sessionId,
        serverVersion: session.stateVersion ?? session.version ?? 1,
      });
      await this.#store.clearPayload(record.id).catch((error) => {
        this.#emit({ type: 'payload-cleanup-failed', handoffId: record.id, error: error.message });
      });
      this.#watch(updated.id, updated.cloudSessionId, updated.lastEventSequence);
      const snapshot = await this.snapshot({ selectedSessionId: updated.cloudSessionId });
      this.#emit({ type: 'session-transferred', snapshot, handoff: updated });
      return snapshot;
    } catch (error) {
      const current = await this.#store.get(record.id);
      // Shutdown deliberately interrupts in-flight work. Keep the staged
      // record durable for the next start, but do not report that a retry was
      // scheduled after all retry timers have been disabled.
      if (this.#stopped) throw error;
      if (current?.cancelRequested) {
        try {
          await this.#finalizeTransferCancellation(current);
          return this.snapshot({ selectedSessionId: current.id });
        } catch (cancelError) {
          const attempt = Number(current.recoveryAttempt ?? 0) + 1;
          await this.#store.patch(record.id, { recoveryAttempt: attempt, error: cancelError.message }).catch(() => {});
          this.#scheduleTransferRecovery(record.id, attempt);
          this.#emit({ type: 'session-cancel-deferred', handoffId: record.id, error: cancelError.message });
          throw cancelError;
        }
      }
      if (current && ['preparing', 'uploading', 'committing'].includes(current.state)) {
        const retryable = !nonRetryableTransferError(error);
        const failure = {
          error: error.message,
          errorCode: String(error?.code ?? '') || null,
          retryable,
          failurePhase: current.state,
          recoveryAttempt: 1,
        };
        if (!retryable) {
          await this.#store.transition(record.id, 'failed', failure);
        } else {
          await this.#store.patch(record.id, {
            ...failure,
            statusMessage: 'Connection interrupted. Retrying the transfer automatically…',
          });
          this.#scheduleTransferRecovery(record.id, 1);
          const snapshot = await this.snapshot({ selectedSessionId: current.cloudSessionId ?? current.id });
          this.#emit({
            type: 'session-transfer-retrying',
            handoffId: record.id,
            error: error.message,
            snapshot,
          });
          return snapshot;
        }
      }
      this.#emit({ type: 'session-transfer-failed', handoffId: record.id, error: error.message });
      throw error;
    } finally {
      this.#transferPromises.delete(record.id);
      this.#transferControllers.delete(record.id);
    }
  }

  async command({ sessionId, command, expectedVersion, payload = {}, message, messageId }) {
    const queuedMessageId = command === 'queue-message' && message
      ? String(messageId ?? `message-${Date.now()}`)
      : null;
    const body = {
      ...payload,
      ...(queuedMessageId ? { content: message, messageId: queuedMessageId } : {}),
      ...(expectedVersion == null ? {} : { expectedVersion }),
    };
    const serverCommand = CLIENT_TO_SERVER_COMMAND[command];
    if (!serverCommand) throw new Error('Unsupported cloud command');
    const localHandoff = await this.handoffForSession(sessionId);
    if (command === 'cancel' && localHandoff
      && ['preparing', 'uploading', 'committing'].includes(localHandoff.state)) {
      await this.#store.patch(localHandoff.id, { cancelRequested: true, error: null });
      const timer = this.#recoveryTimers.get(localHandoff.id);
      if (timer) clearTimeout(timer);
      this.#recoveryTimers.delete(localHandoff.id);
      this.#transferControllers.get(localHandoff.id)?.abort(new Error('Cloud transfer cancelled'));
      const cancelled = await this.#finalizeTransferCancellation(await this.#store.get(localHandoff.id));
      const snapshot = await this.snapshot({ selectedSessionId: cancelled.id });
      this.#emit({ type: 'command-completed', command, snapshot });
      return snapshot;
    }
    let takeover = null;
    if (localHandoff && queuedMessageId) {
      const latest = await this.#store.get(localHandoff.id);
      if (!(latest.queuedMessages ?? []).some((entry) => entry.id === queuedMessageId)) {
        await this.#store.patch(localHandoff.id, {
          queuedMessages: [
            ...(latest.queuedMessages ?? []),
            {
              id: queuedMessageId,
              text: message,
              queuedAt: new Date().toISOString(),
              state: 'queued',
            },
          ],
        });
      }
    }
    let result;
    try {
      if (command === 'takeover') {
        ({ result, takeover } = await this.#requestTakeover(sessionId, body, localHandoff));
      } else {
        const commandId = queuedMessageId
          ? `message_${sha256Hex(Buffer.from(`${sessionId}\0${queuedMessageId}`))}`
          : undefined;
        result = await this.#client.command(sessionId, serverCommand, body, commandId);
      }
    } catch (error) {
      if (localHandoff && queuedMessageId && Number(error?.status) >= 400 && Number(error?.status) < 500) {
        const latest = await this.#store.get(localHandoff.id);
        await this.#store.patch(localHandoff.id, {
          queuedMessages: (latest.queuedMessages ?? []).filter((entry) => entry.id !== queuedMessageId),
        });
      }
      throw error;
    }
    const handoff = localHandoff;
    if (takeover?.document && result.session?.originDocument?.name) {
      takeover.document.fileName = result.session.originDocument.name;
    }
    if (result.session) {
      if (!handoff) this.#remoteSessions.set(sessionId, result.session);
      if (handoff) {
        const nextState = cloudState(result.session.status ?? result.session.state, handoff.state);
        const patch = {
          serverVersion: result.session.stateVersion ?? result.session.version ?? handoff.serverVersion,
          statusMessage: result.session.suspendedReason?.message ?? null,
          pauseRequested: result.session.pauseRequested === true,
          ...(typeof result.session.takeoverRequested === 'boolean'
            ? { takeoverRequested: result.session.takeoverRequested }
            : {}),
          ...(typeof result.session.takeoverReady === 'boolean'
            ? { takeoverReady: result.session.takeoverReady }
            : {}),
        };
        const eventSeq = Number(result.eventSeq);
        if (Number.isSafeInteger(eventSeq) && eventSeq > handoff.lastEventSequence) {
          await this.#store.applyEvent(handoff.id, { sequence: eventSeq, state: nextState, patch });
        } else {
          // Without a real event sequence the watermark must not advance, or
          // the next genuine SSE event is discarded as a duplicate.
          await this.#store.patch(handoff.id, patch);
        }
      }
    }
    const snapshot = await this.snapshot({
      selectedSessionId: sessionId,
      extra: { commandResult: result, ...(takeover ? { takeover } : {}) },
    });
    this.#emit({ type: 'command-completed', command, snapshot });
    return snapshot;
  }

  async downloadResult({ sessionId }) {
    const handoff = (await this.#store.list()).find((entry) => entry.cloudSessionId === sessionId);
    if (!handoff) throw new Error('Cloud handoff does not exist on this device');
    // A lost confirmation response intentionally leaves the handoff in
    // `downloading` while background confirmation recovery runs. The result
    // and timeline have already been written and digest-verified at that
    // point, so subsequent Download clicks must use those durable local bytes
    // instead of asking a server that may already have purged them.
    if (handoff.recoveryPath && handoff.resultDigest) {
      return this.#readDownloadedResult(handoff);
    }
    const session = await this.#client.session(sessionId);
    const resultId = session.result?.id ?? session.resultId ?? session.id;
    if (!resultId) throw new Error('Cloud session does not have a completed result');
    await this.#store.transition(handoff.id, 'downloading');
    try {
      const timelineResult = await this.#client.downloadTimeline(sessionId);
      const result = await this.#client.downloadResult(resultId);
      const fileName = result.name || handoff.documentName;
      const recoveryPath = path.join(this.#recoveryDir, handoff.id, path.basename(fileName));
      const timelineRecoveryPath = path.join(this.#recoveryDir, handoff.id, 'timeline.json');
      const recovery = await writeVerifiedRecoveryFile({
        filePath: recoveryPath,
        bytes: result.bytes,
        expectedDigest: result.sha256,
      });
      await writeVerifiedRecoveryFile({
        filePath: timelineRecoveryPath,
        bytes: timelineResult.bytes,
        expectedDigest: timelineResult.sha256,
      });
      await this.#store.patch(handoff.id, {
        recoveryPath,
        resultDigest: result.sha256,
        resultSize: result.size,
        resultName: fileName,
        timeline: timelineResult.timeline,
        timelineRecoveryPath,
        timelineDigest: timelineResult.sha256,
        timelineSize: timelineResult.size,
        downloadVerifiedAt: new Date().toISOString(),
        error: null,
      });
      const downloadedAt = new Date().toISOString();
      try {
        await this.#client.confirmResultDownloaded(resultId, result, {
          retryAttempts: 1,
          timeoutMs: 5_000,
        });
        await this.#store.transition(handoff.id, 'downloaded', { downloadedAt });
      } catch (error) {
        const current = await this.#store.get(handoff.id);
        const attempt = Number(current?.confirmationAttempt ?? 0) + 1;
        await this.#store.patch(handoff.id, {
          downloadedAt,
          error: error.message,
          confirmationAttempt: attempt,
        });
        this.#scheduleResultRecovery(handoff.id, attempt);
        this.#emit({ type: 'result-confirmation-deferred', sessionId, error: error.message });
      }
      const snapshot = await this.snapshot({ selectedSessionId: sessionId });
      this.#emit({ type: 'result-downloaded', snapshot, sessionId });
      return {
        sessionId,
        fileName,
        bytes: new Uint8Array(result.bytes),
        byteLength: result.size,
        sha256: result.sha256,
        recoveryPath,
        previewOpened: false,
        conflict: 'none',
        preservedCopyName: null,
        timeline: timelineResult.timeline,
        snapshot,
        recovery,
      };
    } catch (error) {
      const current = await this.#store.get(handoff.id);
      if (current?.state === 'downloading' && current.recoveryPath && current.resultDigest) {
        const attempt = Number(current.confirmationAttempt ?? 0) + 1;
        await this.#store.patch(handoff.id, { error: error.message, confirmationAttempt: attempt }).catch(() => {});
        this.#scheduleResultRecovery(handoff.id, attempt);
      } else {
        await this.#store.transition(handoff.id, 'completed', { error: error.message }).catch(() => {});
      }
      throw error;
    }
  }

  async completeTakeover({ sessionId }) {
    const handoff = await this.handoffForSession(sessionId);
    if (handoff) {
      await this.#store.patch(handoff.id, {
        takeoverRequested: false,
        takeoverReady: false,
        takeoverAppliedAt: new Date().toISOString(),
      });
    }
    const remote = this.#remoteSessions.get(sessionId);
    if (!handoff) {
      const operationId = remote?.takeoverBoundary?.operationId;
      if (typeof operationId !== 'string' || !operationId) {
        throw new Error('Cannot complete a remote takeover without its frozen boundary receipt');
      }
      await this.#store.consumeTakeoverBoundary(sessionId, operationId);
    }
    if (remote) this.#remoteSessions.set(sessionId, {
      ...remote,
      takeoverRequested: false,
      takeoverReady: false,
    });
    const snapshot = await this.snapshot({ selectedSessionId: sessionId });
    this.#emit({ type: 'takeover-completed-locally', sessionId, snapshot });
    return snapshot;
  }

  async handoffForSession(sessionId) {
    return (await this.#store.list()).find((entry) => entry.cloudSessionId === sessionId || entry.id === sessionId) ?? null;
  }

  async dismissSession({ sessionId }) {
    const handoff = await this.handoffForSession(sessionId);
    if (!handoff) return this.snapshot();
    if (!['failed', 'cancelled', 'expired', 'downloaded'].includes(handoff.state)) {
      throw transferError('Only finished cloud sessions can be dismissed', 'CLOUD_SESSION_ACTIVE');
    }
    const timer = this.#recoveryTimers.get(handoff.id);
    if (timer) clearTimeout(timer);
    this.#recoveryTimers.delete(handoff.id);
    const resultTimer = this.#resultRecoveryTimers.get(handoff.id);
    if (resultTimer) clearTimeout(resultTimer);
    this.#resultRecoveryTimers.delete(handoff.id);
    await this.#store.dismiss(handoff.id);
    const snapshot = await this.snapshot();
    this.#emit({ type: 'session-dismissed', sessionId, snapshot });
    return snapshot;
  }

  async recordResolution(handoffId, resolution) {
    const current = await this.#store.get(handoffId);
    const recoveryCleanupPath = current?.recoveryPath ?? current?.recoveryCleanupPath ?? null;
    const updated = await this.#store.patch(handoffId, {
      resolvedAt: new Date().toISOString(),
      resolution: resolution.action,
      resolvedPath: resolution.path,
      externalConflict: resolution.conflict === true,
      recoveryPath: null,
      timelineRecoveryPath: null,
      recoveryCleanupPath,
    });
    if (updated.cloudSessionId) this.#remoteSessions.delete(updated.cloudSessionId);
    await this.#cleanupResolvedRecovery(updated);
    const snapshot = await this.snapshot({ selectedSessionId: updated.cloudSessionId });
    this.#emit({ type: 'result-resolved', snapshot, handoff: updated });
    return snapshot;
  }

  async #cleanupResolvedRecovery(record) {
    const cleanupPath = record?.recoveryCleanupPath;
    if (!cleanupPath) return true;
    const expectedDirectory = path.resolve(this.#recoveryDir, record.id);
    const cleanupDirectory = path.dirname(path.resolve(cleanupPath));
    if (cleanupDirectory !== expectedDirectory) {
      this.#emit({
        type: 'recovery-cleanup-failed',
        handoffId: record.id,
        error: 'Resolved recovery cleanup path is outside its handoff directory',
      });
      return false;
    }
    try {
      await rm(cleanupDirectory, { recursive: true, force: true });
      const latest = await this.#store.get(record.id);
      if (latest?.recoveryCleanupPath === cleanupPath) {
        await this.#store.patch(record.id, { recoveryCleanupPath: null });
      }
      return true;
    } catch (error) {
      this.#emit({ type: 'recovery-cleanup-failed', handoffId: record.id, error: error.message });
      return false;
    }
  }

  #watch(handoffId, sessionId, after) {
    if (this.#stopped || !sessionId || this.#watchers.has(sessionId)) return;
    const controller = new AbortController();
    this.#watchers.set(sessionId, controller);
    void this.#client.watchSession(sessionId, after, {
      signal: controller.signal,
      onEvent: async (event) => {
        const source = event.session ?? event.payload?.session ?? event.payload ?? event;
        const current = await this.#store.get(handoffId);
        if (!current) return;
        const serverState = String(source.state ?? source.status ?? '').toLowerCase();
        const state = serverState === 'purged'
          ? (['downloading', 'downloaded'].includes(current.state) ? current.state : 'expired')
          : cloudState(serverState, current.state);
        const queuedMessages = event.type === 'message.accepted'
          ? (current.queuedMessages ?? []).map((message) => (
              message.id === source.messageId ? { ...message, state: 'accepted' } : message
            ))
          : current.queuedMessages;
        const pauseRequested = event.type === 'session.pause_requested'
          ? true
          : state !== 'running'
            ? false
            : source.pauseRequested ?? current.pauseRequested ?? false;
        const takeoverRequested = event.type === 'session.takeover_requested'
          ? true
          : event.type === 'session.takeover_ready'
            ? false
            : source.takeoverRequested ?? current.takeoverRequested ?? false;
        const takeoverReady = event.type === 'session.takeover_ready'
          ? true
          : current.takeoverReady ?? false;
        const updated = await this.#store.applyEvent(handoffId, {
          sequence: event.sequence,
          state,
          patch: {
            serverVersion: source.stateVersion ?? source.version ?? current.serverVersion,
            statusMessage: source.statusMessage ?? source.message ?? source.reason?.message ?? null,
            suspendedCode: source.suspendedReason?.code ?? source.reason?.code ?? current.suspendedCode,
            resultId: source.result?.id ?? source.resultId ?? current.resultId,
            resultDigest: source.result?.sha256 ?? current.resultDigest,
            resultSize: source.result?.size ?? current.resultSize,
            resultExpiresAt: source.result?.expiresAt ?? current.resultExpiresAt,
            startedAt: source.startedAt ?? current.startedAt,
            completedAt: source.completedAt ?? current.completedAt,
            turnsUsed: source.turnsUsed ?? current.turnsUsed,
            pauseRequested,
            takeoverRequested,
            takeoverReady,
            takeoverBoundary: source.boundary ?? current.takeoverBoundary,
            queuedMessages,
          },
        });
        this.#emit({
          type: 'session-event',
          sessionId,
          event,
          handoff: updated,
        });
        // Apply and publish the durable state first. A slow timeline download
        // must never leave a completed session displayed as still running.
        if (event.type === 'timeline.updated') this.#timelinePending.set(sessionId, true);
        const owesTimelineSync = event.type === 'timeline.updated' || this.#timelinePending.get(sessionId) !== false;
        if ((event.type === 'timeline.updated' || state === 'completed') && owesTimelineSync) {
          try {
            await this.#syncLocalTimeline(sessionId, handoffId);
            this.#timelinePending.set(sessionId, false);
          } catch (error) {
            this.#timelinePending.set(sessionId, true);
            this.#emit({ type: 'timeline-sync-error', sessionId, error: error.message });
          }
        }
        if (['downloaded', 'cancelled', 'expired', 'failed'].includes(updated?.state)) controller.abort();
      },
    }).catch((error) => this.#emit({ type: 'session-stream-error', sessionId, error: error.message }))
      .finally(() => {
        this.#watchers.delete(sessionId);
        this.#timelinePending.delete(sessionId);
      });
  }

  async #finalizeTransferCancellation(record) {
    if (!record) throw new Error('Cloud handoff does not exist');
    const existing = this.#transferCancelPromises.get(record.id);
    if (existing) return existing;
    const operation = (async () => {
      this.#transferControllers.get(record.id)?.abort(new Error('Cloud transfer cancelled'));
      await this.#transferPromises.get(record.id)?.catch(() => {});
      let latest = await this.#store.get(record.id);
      if (!latest) throw new Error('Cloud handoff does not exist');
      const remembered = this.#transferRemoteSessions.get(record.id);
      const remoteId = latest.cloudSessionId ?? remembered?.sessionId ?? latest.id;
      let remote = null;
      try {
        remote = await this.#client.session(remoteId);
      } catch (error) {
        if (error?.status !== 404 && error?.code !== 'SESSION_NOT_FOUND') throw error;
      }
      if (remote) {
        let status = String(remote.status ?? remote.state ?? '').toLowerCase();
        for (let attempt = 0; attempt < 3 && !['cancelled', 'completed', 'failed', 'purged', 'expired'].includes(status); attempt += 1) {
          try {
            const response = await this.#client.command(
              remoteId,
              'session.cancel',
              { expectedVersion: remote.stateVersion ?? remote.version ?? remembered?.stateVersion ?? latest.serverVersion ?? 1 },
              `cancel_transfer_${String(record.id).replace(/[^A-Za-z0-9_-]/g, '_')}`,
            );
            remote = response.session ?? remote;
            status = String(remote.status ?? remote.state ?? 'cancelled').toLowerCase();
          } catch (error) {
            if (error?.status !== 409 || attempt === 2) throw error;
            remote = await this.#client.session(remoteId);
            status = String(remote.status ?? remote.state ?? '').toLowerCase();
          }
        }
        latest = await this.#store.get(record.id);
        if (status === 'completed' && ['preparing', 'uploading', 'committing'].includes(latest.state)) {
          const completed = await this.#store.transition(record.id, 'completed', {
            cloudSessionId: remoteId,
            serverVersion: remote.stateVersion ?? remote.version ?? latest.serverVersion,
            cancelRequested: false,
            resultId: remote.result?.id ?? remote.resultId ?? latest.resultId,
          });
          await this.#store.clearPayload(record.id).catch(() => {});
          return completed;
        }
        if (['failed', 'purged', 'expired'].includes(status) && ['preparing', 'uploading', 'committing'].includes(latest.state)) {
          const terminal = await this.#store.transition(record.id, status === 'failed' ? 'failed' : 'expired', {
            cloudSessionId: remoteId,
            serverVersion: remote.stateVersion ?? remote.version ?? latest.serverVersion,
            cancelRequested: false,
          });
          await this.#store.clearPayload(record.id).catch(() => {});
          return terminal;
        }
        if (status !== 'cancelled') throw new Error('VPS did not confirm cloud transfer cancellation');
      }
      latest = await this.#store.get(record.id);
      const cancelled = ['preparing', 'uploading', 'committing'].includes(latest.state)
        ? await this.#store.transition(record.id, 'cancelled', {
            cloudSessionId: remote ? remoteId : latest.cloudSessionId,
            serverVersion: remote?.stateVersion ?? remote?.version ?? latest.serverVersion,
            cancelRequested: false,
            error: null,
          })
        : latest;
      await this.#store.clearPayload(record.id).catch(() => {});
      this.#transferRemoteSessions.delete(record.id);
      return cancelled;
    })();
    this.#transferCancelPromises.set(record.id, operation);
    try {
      return await operation;
    } finally {
      this.#transferCancelPromises.delete(record.id);
    }
  }

  async #recoverIncompleteTransfer(record) {
    try {
      const latest = await this.#store.get(record.id);
      if (!latest || !['preparing', 'uploading', 'committing'].includes(latest.state)) return;
      record = latest;
      if (record.cancelRequested) {
        const cancelled = await this.#finalizeTransferCancellation(record);
        this.#emit({
          type: 'session-cancel-recovered',
          handoff: cancelled,
          snapshot: await this.snapshot({ selectedSessionId: cancelled.cloudSessionId ?? cancelled.id }),
        });
        return;
      }
      if (typeof this.#client.assertTransferReady === 'function') {
        const currentDestination = destinationFromReadiness(await this.#client.assertTransferReady());
        if (!record.destination) {
          throw transferError(
            'Legacy cloud transfer cannot be resumed until its original server is verified',
            'TRANSFER_DESTINATION_UNKNOWN',
          );
        }
        if (!sameDestination(record.destination, currentDestination)) {
          throw transferError(
            'Cloud transfer belongs to a different server or sandbox',
            'TRANSFER_DESTINATION_CHANGED',
          );
        }
      }
      const staged = await this.#store.readPayload(record.id);
      if (record.state === 'preparing') record = await this.#store.transition(record.id, 'uploading');
      await this.#seedRemoteProvider(record.provider);
      let committed = false;
      const controller = new AbortController();
      this.#transferControllers.set(record.id, controller);
      const transferPromise = this.#client.transfer({
        sessionId: record.id,
        threadId: record.threadId,
        documentId: record.originDocumentId,
        provider: record.provider,
        executionConfig: record.executionConfig,
        goal: record.goal,
        documentName: record.documentName,
        documentBytes: staged.documentBytes,
        timeline: record.timeline,
        resources: staged.resources,
        limits: record.limits,
        providerAuth: await this.#providerAuthFor(record.provider),
        signal: controller.signal,
        onSessionCreated: async ({ sessionId, stateVersion }) => {
          this.#transferRemoteSessions.set(record.id, { sessionId, stateVersion });
          await this.#store.patch(record.id, { cloudSessionId: sessionId, serverVersion: stateVersion });
        },
        onSessionActivated: async ({ sessionId, stateVersion, eventSeq }) => {
          this.#transferRemoteSessions.set(record.id, { sessionId, stateVersion, eventSeq });
          await this.#store.patch(record.id, {
            cloudSessionId: sessionId,
            serverVersion: stateVersion,
            ...(Number.isSafeInteger(eventSeq) && eventSeq > 0 ? { lastEventSequence: eventSeq } : {}),
          });
        },
        onProgress: async (progress) => {
          if (progress.phase === 'committing' && !committed) {
            committed = true;
            await this.#store.transition(record.id, 'committing');
          }
          this.#emit({
            type: 'session-recovery-progress',
            handoffId: record.id,
            progress,
          });
        },
      });
      this.#transferPromises.set(record.id, transferPromise);
      const session = await transferPromise;
      const beforeCommit = await this.#store.get(record.id);
      if (beforeCommit?.cancelRequested) {
        const cancelled = await this.#finalizeTransferCancellation(beforeCommit);
        this.#emit({
          type: 'session-cancel-recovered',
          handoff: cancelled,
          snapshot: await this.snapshot({ selectedSessionId: cancelled.cloudSessionId ?? cancelled.id }),
        });
        return;
      }
      const state = cloudState(session.state ?? session.status);
      if (!committed) await this.#store.transition(record.id, 'committing');
      const updated = await this.#store.transition(record.id, state, {
        cloudSessionId: session.id ?? session.sessionId ?? record.id,
        serverVersion: session.stateVersion ?? session.version ?? 1,
        error: null,
        errorCode: null,
        retryable: null,
        failurePhase: null,
        recoveryAttempt: 0,
        statusMessage: null,
      });
      await this.#store.clearPayload(record.id).catch(() => {});
      this.#recoveryTimers.delete(record.id);
      this.#watch(updated.id, updated.cloudSessionId, updated.lastEventSequence);
      this.#emit({
        type: 'session-transfer-recovered',
        handoff: updated,
        snapshot: await this.snapshot({ selectedSessionId: updated.cloudSessionId }),
      });
    } catch (error) {
      const interrupted = await this.#store.get(record.id).catch(() => null);
      if (interrupted?.cancelRequested) {
        try {
          const cancelled = await this.#finalizeTransferCancellation(interrupted);
          this.#emit({
            type: 'session-cancel-recovered',
            handoff: cancelled,
            snapshot: await this.snapshot({ selectedSessionId: cancelled.cloudSessionId ?? cancelled.id }),
          });
          return;
        } catch (cancelError) {
          error = cancelError;
        }
      }
      this.#emit({
        type: 'session-recovery-deferred',
        handoffId: record.id,
        error: error.message,
        snapshot: await this.snapshot(),
      });
      const latest = await this.#store.get(record.id);
      if (latest && ['preparing', 'uploading', 'committing'].includes(latest.state)) {
        const attempt = Number(latest.recoveryAttempt ?? 0) + 1;
        const retryable = !nonRetryableTransferError(error);
        if (!retryable || attempt >= MAX_TRANSFER_RECOVERY_ATTEMPTS) {
          await this.#store.transition(record.id, 'failed', {
            error: !retryable
              ? error.message
              : `Cloud transfer recovery failed ${attempt} times: ${error.message}`,
            errorCode: String(error?.code ?? '') || null,
            retryable: false,
            failurePhase: latest.state,
            recoveryAttempt: attempt,
          });
          this.#emit({
            type: 'session-transfer-failed',
            handoffId: record.id,
            error: error.message,
            snapshot: await this.snapshot(),
          });
          return;
        }
        await this.#store.patch(record.id, {
          recoveryAttempt: attempt,
          error: error.message,
          errorCode: String(error?.code ?? '') || null,
          retryable: true,
          failurePhase: latest.state,
        }).catch(() => {});
        this.#scheduleTransferRecovery(record.id, attempt);
      }
    } finally {
      this.#transferPromises.delete(record.id);
      this.#transferControllers.delete(record.id);
    }
  }

  #scheduleTransferRecovery(handoffId, attempt) {
    if (this.#stopped || this.#recoveryTimers.has(handoffId)) return;
    const delay = attempt === 0 ? 0 : Math.min(30_000, 1_000 * (2 ** Math.min(attempt - 1, 5)));
    const timer = setTimeout(() => {
      this.#recoveryTimers.delete(handoffId);
      void this.#store.get(handoffId).then((record) => (
        record ? this.#recoverIncompleteTransfer(record) : null
      )).catch((error) => {
        this.#emit({ type: 'session-recovery-error', handoffId, error: error.message });
        this.#scheduleTransferRecovery(handoffId, attempt + 1);
      });
    }, delay);
    timer.unref?.();
    this.#recoveryTimers.set(handoffId, timer);
  }

  async #recoverDownloadedResult(record) {
    try {
      const bytes = await readFile(record.recoveryPath);
      if (bytes.length !== record.resultSize || sha256Hex(bytes) !== record.resultDigest) {
        throw new Error('Verified cloud result recovery no longer matches its receipt');
      }
      if (record.timelineRecoveryPath && record.timelineDigest) {
        const timelineBytes = await readFile(record.timelineRecoveryPath);
        if (timelineBytes.length !== record.timelineSize || sha256Hex(timelineBytes) !== record.timelineDigest) {
          throw new Error('Verified cloud timeline recovery no longer matches its receipt');
        }
      }
      await this.#client.confirmResultDownloaded(record.resultId ?? record.cloudSessionId, {
        sha256: record.resultDigest,
        size: record.resultSize,
      }, {
        retryAttempts: 1,
        timeoutMs: 10_000,
      });
      const updated = await this.#store.transition(record.id, 'downloaded', {
        downloadedAt: new Date().toISOString(),
        confirmationAttempt: 0,
        error: null,
      });
      this.#emit({
        type: 'result-confirmation-recovered',
        sessionId: record.cloudSessionId,
        handoff: updated,
        snapshot: await this.snapshot({ selectedSessionId: record.cloudSessionId }),
      });
    } catch (error) {
      const latest = await this.#store.get(record.id).catch(() => null);
      const attempt = Number(latest?.confirmationAttempt ?? 0) + 1;
      await this.#store.patch(record.id, { error: error.message, confirmationAttempt: attempt }).catch(() => {});
      this.#emit({ type: 'result-confirmation-deferred', sessionId: record.cloudSessionId, error: error.message });
      this.#scheduleResultRecovery(record.id, attempt);
    }
  }

  #scheduleResultRecovery(handoffId, attempt) {
    if (this.#stopped || this.#resultRecoveryTimers.has(handoffId)) return;
    const delay = attempt === 0 ? 0 : Math.min(30_000, 1_000 * (2 ** Math.min(attempt - 1, 5)));
    const timer = setTimeout(() => {
      this.#resultRecoveryTimers.delete(handoffId);
      void this.#store.get(handoffId).then((record) => (
        record?.state === 'downloading' ? this.#recoverDownloadedResult(record) : null
      )).catch((error) => {
        this.#emit({ type: 'result-confirmation-error', handoffId, error: error.message });
        this.#scheduleResultRecovery(handoffId, attempt + 1);
      });
    }, delay);
    timer.unref?.();
    this.#resultRecoveryTimers.set(handoffId, timer);
  }

  async #readDownloadedResult(record) {
    const bytes = await readFile(record.recoveryPath);
    if (bytes.length !== record.resultSize || sha256Hex(bytes) !== record.resultDigest) {
      throw new Error('Verified cloud result recovery no longer matches its receipt');
    }
    if (record.timelineRecoveryPath && record.timelineDigest) {
      const timelineBytes = await readFile(record.timelineRecoveryPath);
      if (timelineBytes.length !== record.timelineSize || sha256Hex(timelineBytes) !== record.timelineDigest) {
        throw new Error('Verified cloud timeline recovery no longer matches its receipt');
      }
    }
    const snapshot = await this.snapshot({ selectedSessionId: record.cloudSessionId });
    return {
      sessionId: record.cloudSessionId,
      fileName: record.resultName ?? record.documentName,
      bytes: new Uint8Array(bytes),
      byteLength: bytes.length,
      sha256: record.resultDigest,
      recoveryPath: record.recoveryPath,
      previewOpened: false,
      conflict: record.externalConflict ? 'external-change' : 'none',
      preservedCopyName: record.resolvedPath ? path.basename(record.resolvedPath) : null,
      timeline: record.timeline ?? null,
      snapshot,
      recovery: { filePath: record.recoveryPath, byteLength: bytes.length, digest: record.resultDigest },
    };
  }

  async #requestTakeover(sessionId, body, handoff) {
    let receipt = null;
    try {
      receipt = await this.#client.takeoverState(sessionId);
    } catch (error) {
      if (error?.status !== 404 && error?.code !== 'TAKEOVER_NOT_REQUESTED') throw error;
    }
    let result;
    if (receipt) {
      result = { takeover: receipt, session: await this.#client.session(sessionId) };
    } else {
      result = await this.#client.command(sessionId, 'session.takeover', body);
      receipt = result.takeover;
    }
    if (!receipt || !['pending', 'ready'].includes(receipt.status)) {
      throw new Error('VPS did not return a valid takeover receipt');
    }
    if (receipt.status === 'pending') {
      if (handoff) {
        await this.#store.patch(handoff.id, {
          takeoverRequested: true,
          takeoverRequestedAt: new Date().toISOString(),
          takeoverReady: false,
        });
      } else if (result.session) {
        this.#remoteSessions.set(sessionId, { ...result.session, takeoverRequested: true });
      }
      this.#emit({
        type: 'takeover-pending',
        sessionId,
        snapshot: await this.snapshot({ selectedSessionId: sessionId }),
      });
      receipt = await this.#waitForTakeoverReady(sessionId, receipt);
      result = { ...result, takeover: receipt, session: await this.#client.session(sessionId) };
    }
    const takeover = await this.#prepareTakeover(sessionId, handoff, receipt.boundary);
    if (handoff) {
      await this.#store.patch(handoff.id, {
        takeoverRequested: false,
        takeoverReady: true,
        takeoverBoundary: receipt.boundary,
      });
    } else if (result.session) {
      this.#remoteSessions.set(sessionId, {
        ...result.session,
        takeoverRequested: false,
        takeoverReady: true,
        takeoverBoundary: receipt.boundary,
      });
    }
    return {
      result: {
        ...result,
        takeover: receipt,
        ...(result.session ? {
          session: {
            ...result.session,
            takeoverRequested: false,
            takeoverReady: true,
            takeoverBoundary: receipt.boundary,
          },
        } : {}),
      },
      takeover,
    };
  }

  async #waitForTakeoverReady(sessionId, initialReceipt) {
    if (initialReceipt?.status === 'ready') return initialReceipt;
    const existing = this.#takeoverPromises.get(sessionId);
    if (existing) return existing;
    const controller = new AbortController();
    this.#takeoverControllers.set(sessionId, controller);
    const operation = (async () => {
      let attempt = 0;
      while (!controller.signal.aborted) {
        const waitMs = Math.min(10_000, 500 * (2 ** Math.min(attempt, 5)));
        await delay(waitMs, undefined, { signal: controller.signal });
        const receipt = await this.#client.takeoverState(sessionId);
        if (receipt?.status === 'ready') return receipt;
        if (receipt?.status !== 'pending') throw new Error('VPS returned an invalid takeover state');
        attempt += 1;
      }
      throw controller.signal.reason ?? new Error('Cloud takeover was interrupted');
    })();
    this.#takeoverPromises.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.#takeoverPromises.get(sessionId) === operation) this.#takeoverPromises.delete(sessionId);
      if (this.#takeoverControllers.get(sessionId) === controller) this.#takeoverControllers.delete(sessionId);
    }
  }

  async #prepareTakeover(sessionId, handoff, boundary) {
    if (!boundary || typeof boundary.operationId !== 'string'
      || !Number.isSafeInteger(boundary.revision) || !Number.isSafeInteger(boundary.turnNumber)
      || !boundary.checkpoint || !boundary.timeline) {
      throw new Error('VPS takeover boundary receipt is invalid');
    }
    const timeline = await this.#client.downloadTimeline(sessionId);
    const checkpoint = await this.#client.downloadCheckpoint(sessionId);
    if (checkpoint.sha256 !== boundary.checkpoint.blobId
      || checkpoint.size !== boundary.checkpoint.size
      || checkpoint.boundaryOperation !== boundary.operationId
      || checkpoint.revision !== boundary.revision
      || checkpoint.turn !== boundary.turnNumber
      || timeline.sha256 !== boundary.timeline.blobId
      || timeline.size !== boundary.timeline.size
      || timeline.boundaryOperation !== boundary.operationId
      || timeline.boundaryRevision !== boundary.revision
      || timeline.boundaryTurn !== boundary.turnNumber) {
      throw new Error('Downloaded takeover artifacts do not match the frozen VPS boundary');
    }
    let document = null;
    const directoryName = handoff?.id ?? String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
    const extension = path.extname(checkpoint.name || handoff?.documentName || '') || '.hwpx';
    const recoveryPath = path.join(this.#recoveryDir, directoryName, `takeover${extension}`);
    await writeVerifiedRecoveryFile({
      filePath: recoveryPath,
      bytes: checkpoint.bytes,
      expectedDigest: checkpoint.sha256,
    });
    document = {
      bytes: new Uint8Array(checkpoint.bytes),
      fileName: handoff?.documentName ?? checkpoint.name ?? 'cloud-checkpoint.hwpx',
      byteLength: checkpoint.size,
      sha256: checkpoint.sha256,
      recoveryPath,
      revision: checkpoint.revision,
      turn: checkpoint.turn,
    };
    if (handoff) {
      await this.#store.patch(handoff.id, {
        timeline: timeline.timeline,
        timelineDigest: timeline.sha256,
        timelineSize: timeline.size,
        ...(document ? {
          takeoverRecoveryPath: document.recoveryPath,
        takeoverDigest: document.sha256,
        takeoverSize: document.byteLength,
        takeoverBoundary: boundary,
        } : {}),
      });
    }
    return { document, timeline: timeline.timeline };
  }

  async #syncLocalTimeline(sessionId, handoffId) {
    const downloaded = await this.#client.downloadTimeline(sessionId);
    await this.#store.patch(handoffId, {
      timeline: downloaded.timeline,
      timelineDigest: downloaded.sha256,
      timelineSize: downloaded.size,
    });
    return downloaded.timeline;
  }

  async #syncRemoteTimeline(sessionId) {
    if (!sessionId) return null;
    const downloaded = await this.#client.downloadTimeline(sessionId);
    const session = this.#remoteSessions.get(sessionId);
    if (session) this.#remoteSessions.set(sessionId, { ...session, timeline: downloaded.timeline });
    return downloaded.timeline;
  }

  #emit(event) {
    this.emit('event', { version: 1, at: new Date().toISOString(), ...event });
  }

  async #hydrateRemoteTakeover(session, boundaryHint = null) {
    if (!session?.takeoverReady) return session;
    const sessionId = session.id ?? session.sessionId;
    let boundary = session.takeoverBoundary ?? boundaryHint;
    if (!boundary?.operationId && sessionId) {
      try {
        const receipt = await this.#client.takeoverState(sessionId);
        if (receipt?.status === 'ready') boundary = receipt.boundary;
      } catch {}
    }
    if (typeof boundary?.operationId !== 'string' || !boundary.operationId) return session;
    const consumed = await this.#store.hasConsumedTakeoverBoundary(sessionId, boundary.operationId);
    return {
      ...session,
      takeoverRequested: consumed ? false : session.takeoverRequested,
      takeoverReady: consumed ? false : session.takeoverReady,
      takeoverBoundary: boundary,
    };
  }

  #watchRemote(sessionId) {
    if (!sessionId || this.#watchers.has(sessionId)) return;
    const controller = new AbortController();
    this.#watchers.set(sessionId, controller);
    // Resume from the last seen sequence instead of replaying the full history
    // every time a window refreshes.
    const after = this.#remoteWatchSequence.get(sessionId) ?? 0;
    void this.#client.watchSession(sessionId, after, {
      signal: controller.signal,
      onEvent: async (event) => {
        this.#remoteWatchSequence.set(sessionId, event.sequence);
        const source = event.session ?? event.payload?.session ?? event.payload ?? event;
        // Agent activity deltas carry no session state; refetching the full
        // session for each one adds a round trip per keystroke of the agent.
        const cached = this.#remoteSessions.get(sessionId);
        const needsRefetch = !cached
          || event.type !== 'agent.event'
          || Boolean(source.boundary ?? event.boundary)
          || cached.takeoverRequested
          || cached.takeoverReady;
        const session = needsRefetch
          ? await this.#hydrateRemoteTakeover(
              await this.#client.session(sessionId),
              source.boundary ?? event.boundary ?? null,
            )
          : cached;
        this.#remoteSessions.set(sessionId, session);
        this.#emit({
          type: 'remote-session-event',
          sessionId,
          event,
        });
        if (event.type === 'timeline.updated') this.#timelinePending.set(sessionId, true);
        const owesTimelineSync = event.type === 'timeline.updated' || this.#timelinePending.get(sessionId) !== false;
        if ((event.type === 'timeline.updated' || session.status === 'completed') && owesTimelineSync) {
          try {
            await this.#syncRemoteTimeline(sessionId);
            this.#timelinePending.set(sessionId, false);
          } catch (error) {
            this.#timelinePending.set(sessionId, true);
            this.#emit({ type: 'timeline-sync-error', sessionId, error: error.message });
          }
        }
        if (['purged', 'cancelled', 'failed'].includes(session.status)) controller.abort();
      },
    }).catch((error) => this.#emit({ type: 'remote-session-stream-error', sessionId, error: error.message }))
      .finally(() => {
        this.#watchers.delete(sessionId);
        this.#timelinePending.delete(sessionId);
      });
  }

  #publicRemoteSession(session) {
    if (!session) return { kind: 'idle' };
    const base = {
      sessionId: session.id ?? session.sessionId,
      version: session.stateVersion ?? session.version ?? 1,
      threadId: session.clientContext?.threadId ?? 'remote-cloud-thread',
      documentId: session.clientContext?.documentId ?? null,
      documentName: session.originDocument?.name ?? 'Cloud document',
    };
    const state = cloudState(session.status);
    if (session.takeoverReady) return {
      ...base,
      kind: 'taking-over',
      message: 'The frozen cloud boundary is ready to open on this device.',
    };
    if (session.takeoverRequested) return {
      ...base,
      kind: 'taking-over',
      message: 'Waiting for the next frozen cloud boundary…',
    };
    if (state === 'queued') return { ...base, kind: 'queued', position: 1, message: 'Waiting for a cloud worker.' };
    if (state === 'running' && session.pauseRequested) return {
      ...base,
      kind: 'pausing',
      message: 'Pausing at the next stable tool boundary…',
    };
    if (state === 'running') return {
      ...base,
      kind: 'running',
      startedAt: asIso(session.startedAt, new Date().toISOString()),
      turn: session.turnsUsed ?? 0,
      turnLimit: session.limits?.maxTurns ?? 100,
      elapsedMs: Math.max(0, Date.now() - Date.parse(asIso(session.startedAt, new Date().toISOString()))),
      timeLimitMs: (session.limits?.maxDurationSeconds ?? 28_800) * 1000,
      currentActivity: 'Cloud agent is working.',
    };
    if (state === 'suspended') return {
      ...base,
      kind: 'suspended',
      reason: session.suspendedReason?.message ?? 'Cloud agent needs attention.',
      resumable: !['TURN_LIMIT', 'DURATION_LIMIT'].includes(session.suspendedReason?.code),
    };
    if (state === 'completed') return {
      ...base,
      kind: 'completed',
      completedAt: asIso(session.completedAt, new Date().toISOString()),
      result: {
        fileName: session.originDocument?.name ?? 'Cloud document',
        byteLength: session.result?.size ?? 0,
        sha256: session.result?.sha256 ?? 'pending',
        downloaded: session.status === 'purged',
        availableOnThisDevice: session.originOnThisDevice === true,
        expiresAt: asIso(session.expiresAt),
        conflict: 'none',
        preservedCopyName: null,
      },
    };
    if (state === 'cancelled') return { ...base, kind: 'cancelled', cancelledAt: asIso(session.updatedAt, new Date().toISOString()) };
    return {
      ...base,
      kind: 'failed',
      code: session.status === 'purged' ? 'RESULT_PURGED' : 'CLOUD_ERROR',
      message: session.status === 'purged' ? 'Sensitive cloud data has been purged.' : 'Cloud session failed.',
      retryable: false,
    };
  }

  #publicSession(record) {
    if (!record) return { kind: 'idle' };
    const base = {
      sessionId: record.cloudSessionId ?? record.id,
      version: record.serverVersion ?? record.revision,
      threadId: record.threadId || 'cloud-thread',
      documentId: record.originDocumentId || null,
      documentName: record.documentName,
    };
    if (record.takeoverReady) return {
      ...base,
      kind: 'taking-over',
      message: 'The frozen cloud boundary is ready to open on this device.',
    };
    if (record.takeoverRequested) return {
      ...base,
      kind: 'taking-over',
      message: 'Waiting for the next frozen cloud boundary…',
    };
    if (['preparing', 'uploading', 'committing'].includes(record.state)) {
      return {
        ...base,
        kind: 'transferring',
        stage: record.state,
        completedBytes: record.completedBytes ?? 0,
        totalBytes: record.documentSize ?? 0,
        message: record.statusMessage ?? 'Transferring this session to the VPS…',
      };
    }
    if (record.state === 'queued') return { ...base, kind: 'queued', position: 1, message: record.statusMessage ?? 'Waiting for a cloud worker.' };
    if (record.state === 'running' && record.pauseRequested) return {
      ...base,
      kind: 'pausing',
      message: record.statusMessage ?? 'Pausing at the next stable tool boundary…',
    };
    if (record.state === 'running') return {
      ...base,
      kind: 'running',
      startedAt: asIso(record.startedAt, record.updatedAt),
      turn: record.turnsUsed ?? 0,
      turnLimit: record.limits?.maxTurns ?? 100,
      elapsedMs: Math.max(0, Date.now() - Date.parse(asIso(record.startedAt, record.updatedAt))),
      timeLimitMs: (record.limits?.maxDurationMinutes ?? 480) * 60_000,
      currentActivity: record.statusMessage ?? 'Cloud agent is working.',
    };
    if (record.state === 'suspended') return {
      ...base,
      kind: 'suspended',
      reason: record.statusMessage ?? record.error ?? 'Cloud agent needs attention.',
      resumable: !['TURN_LIMIT', 'DURATION_LIMIT'].includes(record.suspendedCode),
    };
    if (['completed', 'downloading', 'downloaded'].includes(record.state)) return {
      ...base,
      kind: 'completed',
      completedAt: asIso(record.completedAt, record.updatedAt),
      result: {
        fileName: record.documentName,
        byteLength: record.resultSize ?? 0,
        sha256: record.resultDigest ?? record.resultId ?? 'pending',
        downloaded: record.state === 'downloaded' || Boolean(record.downloadedAt),
        availableOnThisDevice: true,
        expiresAt: asIso(record.resultExpiresAt),
        conflict: record.externalConflict ? 'external-change' : 'none',
        preservedCopyName: record.resolvedPath ? path.basename(record.resolvedPath) : null,
      },
    };
    if (record.state === 'cancelled') return { ...base, kind: 'cancelled', cancelledAt: record.updatedAt };
    return {
      ...base,
      kind: 'failed',
      code: record.state === 'expired' ? 'RESULT_EXPIRED' : record.errorCode || 'CLOUD_ERROR',
      message: record.error ?? record.statusMessage ?? 'Cloud session failed.',
      retryable: typeof record.retryable === 'boolean' ? record.retryable : record.state !== 'expired',
    };
  }
}

export const __test = {
  uiProfileToStored,
  cloudState,
  goalFromTransfer,
  asIso,
  destinationFromReadiness,
  sameDestination,
  nonRetryableTransferError,
};

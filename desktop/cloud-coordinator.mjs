import { EventEmitter } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { collectProviderSession, listLocalSessionProviders } from '../cloud/src/provider-session.mjs';
import { SANDBOX_AGENT_PROVIDERS } from './cloud-railway.mjs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerError, createAppServerRegistry } from './cloud-app-server.mjs';
import { normalizeCloudProfile, normalizeTailscaleHttpsPort } from './cloud-profile.mjs';
import { sha256Hex, writeVerifiedRecoveryFile } from './cloud-handoff.mjs';

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
  const auth = source.auth ?? {};
  return normalizeCloudProfile({
    name: source.name ?? current?.name,
    endpoint,
    provider: source.provider ?? current?.provider ?? 'codex',
    transport: transport === 'tailscale' ? 'tailscale' : 'public-https',
    serverPublicKey: source.serverPublicKey
      ?? (current?.endpoint === endpoint ? current.serverPublicKey : ''),
    tailscaleHttpsPort,
    limits: source.limits ?? current?.limits,
    ssh: {
      host,
      user: source.sshUser ?? source.ssh?.user ?? current?.ssh?.user,
      port: source.sshPort ?? source.ssh?.port ?? current?.ssh?.port,
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
  #transferRemoteSessions = new Map();
  #transferCancelPromises = new Map();
  #takeoverControllers = new Map();
  #takeoverPromises = new Map();
  #remoteSessions = new Map();
  #snapshotChain = Promise.resolve();
  #revision = 0;
  #appServers;
  #sandboxLifecycle = 'idle';
  #sandboxMessage = null;
  #spawnPromise = null;
  #teardownPromise = null;
  #preferredMode = null;
  #idleTimer = null;
  #idleTimeoutMs;
  #armTimer;
  #disarmTimer;
  #collectProviderSession;
  #listLocalSessions;

  constructor({
    client,
    store,
    provisioner,
    recoveryDir,
    appServers = [],
    idleTimeoutMs = 30 * 60 * 1000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    collectProviderSession: collectSession = (provider) => collectProviderSession(provider, { home: homedir() }),
    listLocalSessions = () => listLocalSessionProviders({ home: homedir() }),
  }) {
    super();
    this.#client = client;
    this.#store = store;
    this.#provisioner = provisioner;
    this.#recoveryDir = recoveryDir;
    this.#appServers = Array.isArray(appServers) ? createAppServerRegistry(appServers) : appServers;
    this.#idleTimeoutMs = Number(idleTimeoutMs);
    this.#armTimer = setTimeoutFn;
    this.#disarmTimer = clearTimeoutFn;
    this.#collectProviderSession = collectSession;
    this.#listLocalSessions = listLocalSessions;
  }

  hasBillableSandbox() {
    return this.#sandboxLifecycle === 'provisioning'
      || this.#sandboxLifecycle === 'ready'
      || this.#sandboxLifecycle === 'tearing-down';
  }

  #clearIdleTeardown() {
    if (this.#idleTimer !== null) this.#disarmTimer(this.#idleTimer);
    this.#idleTimer = null;
  }

  #scheduleIdleTeardown() {
    this.#clearIdleTeardown();
    if (!Number.isFinite(this.#idleTimeoutMs) || this.#idleTimeoutMs <= 0) return;
    this.#idleTimer = this.#armTimer(() => {
      this.#idleTimer = null;
      return this.teardownAppServer({ force: false }).catch(() => {
        this.#scheduleIdleTeardown();
      });
    }, this.#idleTimeoutMs);
  }

  #touchSandboxActivity() {
    if (this.#sandboxLifecycle === 'ready') this.#scheduleIdleTeardown();
  }

  async start() {
    this.#preferredMode = await this.#client.loadServerMode?.().catch(() => null) ?? null;
    const profile = await this.#client.loadProfile().catch(() => null);
    if (profile?.mode === 'app-hosted') {
      const unmanaged = this.#sandboxProvider(profile.sandbox) ? null : unmanagedSandboxMessage(profile.sandbox);
      if (unmanaged) this.#setSandboxLifecycle('error', unmanaged);
      else {
        this.#sandboxLifecycle = await this.#client.isPaired().catch(() => false) ? 'ready' : 'error';
        this.#sandboxMessage = this.#sandboxLifecycle === 'error'
          ? 'This app sandbox is not paired with this device.'
          : null;
        if (this.#sandboxLifecycle === 'ready') this.#scheduleIdleTeardown();
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

  stop() {
    this.#clearIdleTeardown();
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
    const scoped = Boolean(originSessionId || documentId);
    const localMatch = visibleRecords.find((record) => (
      (originSessionId && record.originSessionId === originSessionId)
      || (documentId && record.originDocumentId === documentId)
    ));
    const selected = visibleRecords.find((record) => record.cloudSessionId === selectedSessionId)
      ?? localMatch
      ?? (!scoped ? visibleRecords.find((record) => ['preparing', 'uploading', 'committing', 'queued', 'running', 'suspended', 'completed', 'downloaded'].includes(record.state)) : null)
      ?? (!scoped ? visibleRecords[0] : null)
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
        credential: {
          ...(await this.#client.describeSandboxCredential?.().catch(() => ({ provider: null, stored: false }))
            ?? { provider: null, stored: false }),
          localProviders: this.#listLocalSessions?.() ?? [],
        },
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
    this.#preferredMode = await this.#client.saveServerMode('self-hosted').catch(() => this.#preferredMode);
    this.#setSandboxLifecycle('idle');
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
      profileConnection: health?.ok === false ? 'error' : 'ready',
      profileMessage: health?.error ?? null,
      extra: { test: { ok: true, preflight, health } },
    });
  }

  async provision({ installChannel = 'stable', profile: profileDraft } = {}) {
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
    if (receipt.pairingCode) {
      const pairing = await this.#client.redeemPairingCode(receipt.pairingCode, hostname(), {
        profile: updated,
        persist: false,
      });
      credentials = pairing.credentials;
    } else {
      preserveCredentials = Boolean(
        current
        && current.endpoint === updated.endpoint
        && current.serverPublicKey === updated.serverPublicKey
        && await this.#client.isPaired(),
      );
      if (!preserveCredentials) {
        throw new Error('VPS installer did not return the initial pairing code');
      }
    }
    const health = await this.#client.health(updated);
    if (health.ok !== true || health.serverPublicKey !== receipt.serverPublicKey) {
      throw new Error('Provisioned cloud service failed identity verification');
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

  async selectServerMode(mode) {
    this.#preferredMode = await this.#client.saveServerMode(mode);
    return this.snapshot();
  }

  async saveSandboxCredential(payload) {
    await this.#client.saveSandboxCredential(payload);
    return this.snapshot();
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

  async #spawnAppServer({ providerId = null, deviceName = hostname(), credentials = null } = {}) {
    if (credentials?.apiKey) await this.#client.saveSandboxCredential(credentials);
    const current = await this.#client.loadProfile().catch(() => null);
    if (current?.mode === 'app-hosted') {
      if (await this.#client.isPaired().catch(() => false)) {
        this.#setSandboxLifecycle('ready');
        this.#preferredMode = await this.#client.saveServerMode('app-hosted').catch(() => 'app-hosted');
        this.#scheduleIdleTeardown();
        return this.snapshot({ extra: { sandbox: { ok: true, reused: true } } });
      }
      throw new AppServerError('An app sandbox is already registered. Tear it down before creating another.', {
        code: 'SANDBOX_STILL_ACTIVE',
        retryable: false,
      });
    }
    const provider = this.#appServerFor(providerId);
    const storedCredentials = await this.#client.loadSandboxCredential?.().catch(() => null) ?? null;
    const agent = SANDBOX_AGENT_PROVIDERS.includes(credentials?.provider)
      ? credentials.provider
      : storedCredentials?.provider;
    const session = agent ? this.#collectProviderSession?.(agent) ?? null : null;
    const apiKey = typeof credentials?.apiKey === 'string' && credentials.apiKey
      ? credentials.apiKey
      : agent && storedCredentials?.provider === agent
        ? storedCredentials.apiKey ?? ''
        : '';
    if (!apiKey && !session) {
      throw new AppServerError('Save an agent API key before starting an app sandbox.', {
        code: 'PROVIDER_KEY_REQUIRED',
        retryable: false,
      });
    }
    const spawnCredentials = {
      provider: agent ?? storedCredentials?.provider,
      apiKey,
      ...(session ? { session } : {}),
    };
    this.#setSandboxLifecycle('provisioning', 'Starting an app-provided sandbox.');
    this.#emit({ type: 'sandbox-provision-started', providerId: provider.id });
    let spawned = null;
    try {
      spawned = await provider.spawn({
        deviceName,
        limits: current?.limits,
        credentials: spawnCredentials,
        onLine: (line) => this.#emit({ type: 'provision-log', line }),
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
      this.#preferredMode = await this.#client.saveServerMode('app-hosted').catch(() => 'app-hosted');
      this.#setSandboxLifecycle('ready');
      this.#scheduleIdleTeardown();
      const snapshot = await this.snapshot({ extra: { sandbox: { ok: true, reused: false } } });
      this.#emit({ type: 'sandbox-ready', providerId: provider.id, snapshot });
      return snapshot;
    } catch (error) {
      if (spawned?.sandbox) {
        await provider.teardown(spawned.sandbox).catch((cleanupError) => {
          this.#emit({ type: 'sandbox-cleanup-failed', providerId: provider.id, error: cleanupError.message });
        });
      }
      this.#setSandboxLifecycle('error', error.message);
      this.#emit({
        type: 'sandbox-provision-failed',
        providerId: provider.id,
        error: error.message,
        snapshot: await this.snapshot(),
      });
      throw error;
    }
  }

  async appServerStatus() {
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
      this.#setSandboxLifecycle('error', error.message);
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
    this.#clearIdleTeardown();
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

  async transfer(payload, { originSessionId, originPath = null }) {
    this.#touchSandboxActivity();
    const bytes = Buffer.from(payload?.document?.bytes ?? []);
    const goal = goalFromTransfer(payload);
    const record = await this.#store.create({
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
    this.#emit({
      type: 'session-transfer',
      handoffId: record.id,
      state: 'uploading',
      snapshot: await this.snapshot(),
    });
    let committed = false;
    const controller = new AbortController();
    this.#transferControllers.set(record.id, controller);
    try {
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
          this.#emit({
            type: 'session-transfer-progress',
            handoffId: record.id,
            progress,
            snapshot: await this.snapshot(),
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
        await this.#store.patch(record.id, { error: error.message, recoveryAttempt: 1 });
        this.#scheduleTransferRecovery(record.id, 1);
      }
      this.#emit({ type: 'session-transfer-failed', handoffId: record.id, error: error.message });
      throw error;
    } finally {
      this.#transferPromises.delete(record.id);
      this.#transferControllers.delete(record.id);
    }
  }

  async command({ sessionId, command, expectedVersion, payload = {}, message, messageId }) {
    this.#touchSandboxActivity();
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
        await this.#store.applyEvent(handoff.id, {
          sequence: Number(result.eventSeq) || handoff.lastEventSequence + 1,
          state: nextState,
          patch: {
            serverVersion: result.session.stateVersion ?? result.session.version ?? handoff.serverVersion,
            statusMessage: result.session.suspendedReason?.message ?? null,
            pauseRequested: result.session.pauseRequested === true,
            ...(typeof result.session.takeoverRequested === 'boolean'
              ? { takeoverRequested: result.session.takeoverRequested }
              : {}),
            ...(typeof result.session.takeoverReady === 'boolean'
              ? { takeoverReady: result.session.takeoverReady }
              : {}),
          },
        });
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
    if (handoff.state === 'downloaded' && handoff.recoveryPath && handoff.resultDigest) {
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
      await this.#client.confirmResultDownloaded(resultId, result);
      await this.#store.transition(handoff.id, 'downloaded', {
        downloadedAt: new Date().toISOString(),
      });
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
    if (!sessionId || this.#watchers.has(sessionId)) return;
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
        if (event.type === 'timeline.updated' || state === 'completed') {
          await this.#syncLocalTimeline(sessionId, handoffId).catch((error) => {
            this.#emit({ type: 'timeline-sync-error', sessionId, error: error.message });
          });
        }
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
          snapshot: await this.snapshot({ selectedSessionId: sessionId }),
        });
        if (['downloaded', 'cancelled', 'expired', 'failed'].includes(updated?.state)) controller.abort();
      },
    }).catch((error) => this.#emit({ type: 'session-stream-error', sessionId, error: error.message }))
      .finally(() => this.#watchers.delete(sessionId));
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
      const staged = await this.#store.readPayload(record.id);
      if (record.state === 'preparing') record = await this.#store.transition(record.id, 'uploading');
      if (record.state === 'uploading') record = await this.#store.transition(record.id, 'committing');
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
        onProgress: async (progress) => this.#emit({
          type: 'session-recovery-progress',
          handoffId: record.id,
          progress,
          snapshot: await this.snapshot(),
        }),
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
      const updated = await this.#store.transition(record.id, state, {
        cloudSessionId: session.id ?? session.sessionId ?? record.id,
        serverVersion: session.stateVersion ?? session.version ?? 1,
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
        await this.#store.patch(record.id, { recoveryAttempt: attempt, error: error.message }).catch(() => {});
        this.#scheduleTransferRecovery(record.id, attempt);
      }
    } finally {
      this.#transferPromises.delete(record.id);
      this.#transferControllers.delete(record.id);
    }
  }

  #scheduleTransferRecovery(handoffId, attempt) {
    if (this.#recoveryTimers.has(handoffId)) return;
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
    if (this.#resultRecoveryTimers.has(handoffId)) return;
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
    void this.#client.watchSession(sessionId, 0, {
      signal: controller.signal,
      onEvent: async (event) => {
        const source = event.session ?? event.payload?.session ?? event.payload ?? event;
        const session = await this.#hydrateRemoteTakeover(
          await this.#client.session(sessionId),
          source.boundary ?? event.boundary ?? null,
        );
        this.#remoteSessions.set(sessionId, session);
        if (event.type === 'timeline.updated' || session.status === 'completed') {
          await this.#syncRemoteTimeline(sessionId).catch((error) => {
            this.#emit({ type: 'timeline-sync-error', sessionId, error: error.message });
          });
        }
        this.#emit({
          type: 'remote-session-event',
          sessionId,
          event,
          snapshot: await this.snapshot({ selectedSessionId: sessionId }),
        });
        if (['purged', 'cancelled', 'failed'].includes(session.status)) controller.abort();
      },
    }).catch((error) => this.#emit({ type: 'remote-session-stream-error', sessionId, error: error.message }))
      .finally(() => this.#watchers.delete(sessionId));
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
      code: record.state === 'expired' ? 'RESULT_EXPIRED' : 'CLOUD_ERROR',
      message: record.error ?? record.statusMessage ?? 'Cloud session failed.',
      retryable: record.state !== 'expired',
    };
  }
}

export const __test = { uiProfileToStored, cloudState, goalFromTransfer, asIso };

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const CLOUD_DAILY_LIMIT_MS = 60 * 60 * 1000;
export const CLOUD_GRACE_LIMIT_MS = 30 * 60 * 1000;
export const CLOUD_WARM_IDLE_MS = 5 * 60 * 1000;
export const CLOUD_HEARTBEAT_LEASE_MS = 90 * 1000;
export const CLOUD_ALLOCATION_LEASE_MS = 30 * 60 * 1000;
export const CLOUD_TIMEZONE_CHANGE_MS = 30 * 24 * 60 * 60 * 1000;
export const CLOUD_COLD_START_WINDOW_MS = 15 * 60 * 1000;
export const CLOUD_COLD_START_WINDOW_LIMIT = 3;
export const CLOUD_COLD_START_DAILY_LIMIT = 12;

const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function cloudError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function validId(value, name) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(text)) {
    throw cloudError('CLOUD_INVALID_REQUEST', `${name} is required`);
  }
  return text;
}

function validateTimezone(value) {
  const timezone = String(value ?? '').trim();
  if (!timezone) throw cloudError('CLOUD_TIMEZONE_REQUIRED', 'Choose a timezone before using Raucloud');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    throw cloudError('CLOUD_TIMEZONE_INVALID', 'The supplied timezone is not a valid IANA timezone');
  }
  return timezone;
}

function dayKey(epochMs, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function boundaryForDay(epochMs, timezone, direction) {
  const current = dayKey(epochMs, timezone);
  const step = 60 * 60 * 1000;
  let low;
  let high;
  if (direction === 'next') {
    low = epochMs;
    high = epochMs + step;
    for (let i = 0; i < 30 && dayKey(high, timezone) === current; i += 1) high += step;
  } else {
    high = epochMs;
    low = epochMs - step;
    for (let i = 0; i < 30 && dayKey(low, timezone) === current; i += 1) low -= step;
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const same = dayKey(middle, timezone) === current;
    if (direction === 'next') {
      if (same) low = middle;
      else high = middle;
    } else if (same) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return direction === 'next' ? high : high;
}

function createWindow(at, timezone, debtMs = 0) {
  const startAt = boundaryForDay(at, timezone, 'previous');
  const endAt = boundaryForDay(at, timezone, 'next');
  const debtAppliedMs = Math.min(CLOUD_DAILY_LIMIT_MS, Math.max(0, debtMs));
  return {
    id: `${timezone}:${startAt}`,
    startAt,
    endAt,
    normalUsedMs: 0,
    debtAppliedMs,
  };
}

const LEGACY_RAUCLOUD_STATE_KEY = 'managedCloud'; // raucloud-legacy: durable broker state is moved on first access.

function ensureRaucloudState(state) {
  const legacy = state[LEGACY_RAUCLOUD_STATE_KEY];
  if (legacy && typeof legacy === 'object') {
    if (!state.raucloud || typeof state.raucloud !== 'object') {
      state.raucloud = legacy;
    } else if (state.raucloud !== legacy) {
      for (const collection of ['accounts', 'runs', 'idempotency']) {
        state.raucloud[collection] = {
          ...(legacy[collection] ?? {}),
          ...(state.raucloud[collection] ?? {}),
        };
      }
    }
    delete state[LEGACY_RAUCLOUD_STATE_KEY];
  }
  state.raucloud ??= {};
  state.raucloud.schemaVersion = 1;
  state.raucloud.accounts ??= {};
  state.raucloud.runs ??= {};
  state.raucloud.idempotency ??= {};
  return state.raucloud;
}

function ensureAccount(state, userId, at) {
  const cloud = ensureRaucloudState(state);
  cloud.accounts[userId] ??= {
    id: userId,
    createdAt: at,
    timezone: null,
    timezoneChangedAt: null,
    pendingTimezone: null,
    quota: { window: null, debtMs: 0 },
    worker: null,
    coldStarts: [],
  };
  const account = cloud.accounts[userId];
  account.quota ??= { window: null, debtMs: 0 };
  account.quota.debtMs = Math.max(0, Number(account.quota.debtMs) || 0);
  account.coldStarts = Array.isArray(account.coldStarts) ? account.coldStarts : [];
  return account;
}

function initializeTimezone(account, timezone, at) {
  if (account.timezone) return;
  account.timezone = validateTimezone(timezone);
  account.timezoneChangedAt = at;
  account.quota.window = createWindow(at, account.timezone, account.quota.debtMs);
  account.quota.debtMs = Math.max(0, account.quota.debtMs - account.quota.window.debtAppliedMs);
}

function advanceQuota(account, at) {
  if (!account.timezone) return;
  account.quota.window ??= createWindow(at, account.timezone, account.quota.debtMs);
  let safety = 0;
  while (at >= account.quota.window.endAt && safety < 400) {
    const previousEnd = account.quota.window.endAt;
    let timezoneChanged = false;
    if (account.pendingTimezone && previousEnd >= account.pendingTimezone.effectiveAt) {
      account.timezone = account.pendingTimezone.timezone;
      account.pendingTimezone = null;
      timezoneChanged = true;
    }
    const debtAppliedMs = Math.min(CLOUD_DAILY_LIMIT_MS, account.quota.debtMs);
    account.quota.debtMs -= debtAppliedMs;
    const nextEnd = timezoneChanged
      ? boundaryForDay(previousEnd + (24 * 60 * 60 * 1000) - 1, account.timezone, 'next')
      : boundaryForDay(previousEnd + 1, account.timezone, 'next');
    account.quota.window = {
      id: `${account.timezone}:${previousEnd}`,
      startAt: previousEnd,
      endAt: nextEnd,
      normalUsedMs: 0,
      debtAppliedMs,
    };
    safety += 1;
  }
}

function normalRemaining(account) {
  const window = account.quota.window;
  if (!window) return 0;
  return Math.max(0, CLOUD_DAILY_LIMIT_MS - window.debtAppliedMs - window.normalUsedMs);
}

function addGraceDebt(account, run, amountMs) {
  const amount = Math.max(0, Number(amountMs) || 0);
  if (!amount) return;
  const targetStartAt = Number(run.graceDebtWindowStartAt);
  if (Number.isFinite(targetStartAt) && account.quota.window?.startAt === targetStartAt) {
    account.quota.window.debtAppliedMs = Math.min(
      CLOUD_DAILY_LIMIT_MS,
      account.quota.window.debtAppliedMs + amount,
    );
    return;
  }
  account.quota.debtMs += amount;
}

function chargeRun(account, run, until) {
  if (run.status !== 'active' || run.lastAccountedAt == null || until <= run.lastAccountedAt) {
    return { chargedMs: 0, mustStop: false };
  }
  const logoutDeadline = run.logoutRequestedAt == null ? null : run.logoutRequestedAt + CLOUD_GRACE_LIMIT_MS;
  const requestedUntil = until;
  if (logoutDeadline != null) until = Math.min(until, logoutDeadline);
  let cursor = run.lastAccountedAt;
  let chargedMs = 0;
  while (cursor < until) {
    advanceQuota(account, cursor);
    if (run.graceStartedAt != null) {
      const graceRoom = Math.max(0, CLOUD_GRACE_LIMIT_MS - run.graceUsedMs);
      const grace = Math.min(until - cursor, graceRoom);
      run.graceUsedMs += grace;
      addGraceDebt(account, run, grace);
      cursor += grace;
      chargedMs += grace;
      if (grace === 0 || run.graceUsedMs >= CLOUD_GRACE_LIMIT_MS) break;
      continue;
    }
    const segmentEnd = Math.min(until, account.quota.window.endAt);
    const available = normalRemaining(account);
    const normal = Math.min(segmentEnd - cursor, available);
    account.quota.window.normalUsedMs += normal;
    cursor += normal;
    chargedMs += normal;
    if (cursor < segmentEnd) {
      run.graceStartedAt = cursor;
      run.graceDebtWindowStartAt = account.quota.window.endAt;
      continue;
    }
    if (cursor >= account.quota.window.endAt && cursor < until) advanceQuota(account, cursor);
  }
  run.lastAccountedAt = cursor;
  if (normalRemaining(account) <= 0 || run.graceStartedAt != null || run.logoutRequestedAt != null) {
    run.inputBlocked = true;
  }
  return {
    chargedMs,
    mustStop: run.graceUsedMs >= CLOUD_GRACE_LIMIT_MS
      || (logoutDeadline != null && requestedUntil >= logoutDeadline),
  };
}

function cleanupIdempotency(cloud, at) {
  for (const [key, record] of Object.entries(cloud.idempotency)) {
    if (at - Number(record?.createdAt ?? 0) > IDEMPOTENCY_TTL_MS) delete cloud.idempotency[key];
  }
}

function idempotencyKey(userId, operation, key) {
  return `${userId}:${operation}:${createHash('sha256').update(String(key ?? '')).digest('hex')}`;
}

function publicAccount(account, user) {
  return {
    id: account.id,
    email: typeof user?.email === 'string' ? user.email : null,
    loggedIn: true,
    timezone: account.timezone,
    pendingTimezone: account.pendingTimezone?.timezone ?? null,
    timezoneEffectiveAt: account.pendingTimezone?.effectiveAt ?? null,
    timezoneChangeAvailableAt: account.timezoneChangedAt == null
      ? null
      : account.timezoneChangedAt + CLOUD_TIMEZONE_CHANGE_MS,
  };
}

function coldStartCounts(account, at) {
  const stamps = account.coldStarts.filter((stamp) => Number.isFinite(stamp));
  return {
    usedToday: stamps.filter((stamp) => stamp >= Number(account.quota.window?.startAt ?? at)).length,
    dailyLimit: CLOUD_COLD_START_DAILY_LIMIT,
    recent: stamps.filter((stamp) => at - stamp < CLOUD_COLD_START_WINDOW_MS).length,
    recentLimit: CLOUD_COLD_START_WINDOW_LIMIT,
  };
}

function publicQuota(account, run = null, at = Date.now()) {
  const window = account.quota.window;
  const remainingMs = normalRemaining(account);
  const graceActive = Boolean(run?.status === 'active' && run.graceStartedAt != null);
  const graceUsedMs = Math.max(0, Number(run?.graceUsedMs) || 0);
  return {
    limitMs: CLOUD_DAILY_LIMIT_MS,
    usedMs: window?.normalUsedMs ?? 0,
    debtAppliedMs: window?.debtAppliedMs ?? 0,
    remainingMs,
    resetsAt: window?.endAt ?? null,
    timezone: account.timezone,
    grace: {
      active: graceActive,
      usedMs: graceUsedMs,
      limitMs: CLOUD_GRACE_LIMIT_MS,
      remainingMs: Math.max(0, CLOUD_GRACE_LIMIT_MS - graceUsedMs),
      debtMs: account.quota.debtMs,
    },
    coldStarts: coldStartCounts(account, at),
  };
}

function publicRun(run, viewerDeviceId = null) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    ownerDeviceId: run.ownerDeviceId,
    createdAt: run.createdAt,
    allocatedAt: run.allocatedAt ?? null,
    completedAt: run.completedAt ?? null,
    checkpointId: run.checkpointId ?? null,
    inputBlocked: Boolean(run.inputBlocked),
    graceDeadlineAt: run.logoutRequestedAt != null
      ? run.logoutRequestedAt + CLOUD_GRACE_LIMIT_MS
      : (run.graceStartedAt == null ? null : run.graceStartedAt + CLOUD_GRACE_LIMIT_MS),
    failureCode: run.failureCode ?? null,
    message: run.status === 'failed'
      ? run.failureMessage ?? 'Raucloud worker preparation failed'
      : null,
    receipt: run.receipt && viewerDeviceId === run.ownerDeviceId ? { ...run.receipt } : null,
  };
}

function publicWorker(worker, viewerDeviceId = null) {
  if (!worker) return null;
  return {
    id: worker.id,
    status: worker.status,
    ownerDeviceId: worker.ownerDeviceId,
    runId: worker.runId,
    warmUntil: worker.warmUntil ?? null,
    receipt: worker.receipt && viewerDeviceId === worker.ownerDeviceId ? { ...worker.receipt } : null,
  };
}

function activeRun(cloud, account) {
  const runId = account.worker?.runId;
  const run = runId ? cloud.runs[runId] : null;
  return run && ['allocating', 'ready', 'active', 'checkpointing'].includes(run.status) ? run : null;
}

function takeoverRun(cloud, account) {
  const run = account.latestCheckpointRunId ? cloud.runs[account.latestCheckpointRunId] : null;
  return run && run.checkpointId && ['checkpointed', 'completed'].includes(run.status) ? run : null;
}

function reconcileAccount(state, account, at) {
  const cloud = ensureRaucloudState(state);
  advanceQuota(account, at);
  const worker = account.worker;
  if (!worker) return;
  const run = cloud.runs[worker.runId];
  if (!run) {
    account.worker = null;
    return;
  }
  if (worker.status === 'allocating' && at - Number(run.createdAt ?? at) >= CLOUD_ALLOCATION_LEASE_MS) {
    run.status = 'failed';
    run.failureCode = 'ALLOCATION_LEASE_EXPIRED';
    run.failureMessage = 'Raucloud worker preparation timed out';
    run.completedAt = at;
    reserveTeardown(account, run, at);
    return;
  }
  if (['warm', 'ready'].includes(worker.status) && at >= Number(worker.warmUntil ?? 0)) {
    reserveTeardown(account, run, at);
  }
}

function reserveTeardown(account, run, at) {
  if (run?.remote) {
    run.teardownRequestedAt = at;
    if (account.worker?.runId === run.id) {
      account.worker.status = 'tearing_down';
      account.worker.warmUntil = null;
    }
    return;
  }
  if (account.worker?.runId === run?.id) account.worker = null;
}

function sanitizeRemote(remote) {
  if (!remote || typeof remote !== 'object') throw cloudError('CLOUD_PROVISION_FAILED', 'Provisioner returned no remote worker');
  const result = {};
  for (const key of ['providerId', 'serviceId', 'projectId', 'environmentId', 'domainId', 'domain', 'runId']) {
    const value = String(remote[key] ?? '').trim();
    if (value) result[key] = value.slice(0, 512);
  }
  if (!result.serviceId) throw cloudError('CLOUD_PROVISION_FAILED', 'Provisioner returned no remote service id');
  result.createdAt = Number(remote.createdAt) || Date.now();
  return result;
}

function sanitizeReceipt(receipt) {
  const endpoint = String(receipt?.endpoint ?? '').trim();
  const serverPublicKey = String(receipt?.serverPublicKey ?? '').trim();
  const pairingCode = String(receipt?.pairingCode ?? '').trim();
  let parsed;
  try { parsed = new URL(endpoint); } catch {}
  if (parsed?.protocol !== 'https:'
    || !/^ed25519:[A-Za-z0-9_-]{40,}$/.test(serverPublicKey)
    || !/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pairingCode)) {
    throw cloudError('CLOUD_PROVISION_FAILED', 'Provisioner returned an invalid pairing receipt');
  }
  return { endpoint: parsed.toString().replace(/\/$/, ''), serverPublicKey, pairingCode };
}

function confirmAllocationState(state, runId, at) {
  const cloud = ensureRaucloudState(state);
  const run = cloud.runs[validId(runId, 'runId')];
  if (!run) throw cloudError('CLOUD_RUN_NOT_FOUND', 'Raucloud run not found');
  const account = ensureAccount(state, run.accountId, at);
  if (account.worker?.runId !== run.id || !['allocating', 'ready'].includes(run.status)) {
    throw cloudError('CLOUD_RUN_STATE_INVALID', 'Raucloud run is not awaiting allocation');
  }
  advanceQuota(account, at);
  if (normalRemaining(account) <= 0) {
    throw cloudError('CLOUD_QUOTA_EXHAUSTED', 'The daily Raucloud allowance is exhausted');
  }
  if (run.coldStart && !run.coldStartConfirmed) {
    account.coldStarts = account.coldStarts.filter((stamp) => stamp >= account.quota.window.startAt);
    const counts = coldStartCounts(account, at);
    if (counts.recent >= CLOUD_COLD_START_WINDOW_LIMIT || counts.usedToday >= CLOUD_COLD_START_DAILY_LIMIT) {
      run.status = 'failed';
      run.failureCode = 'COLD_START_LIMIT';
      run.completedAt = at;
      reserveTeardown(account, run, at);
      throw cloudError('CLOUD_COLD_START_RATE_LIMITED', 'Too many Raucloud cold starts');
    }
    account.coldStarts.push(at);
    run.coldStartConfirmed = true;
  }
  run.status = 'active';
  run.allocatedAt ??= at;
  run.turnAllocatedAt = at;
  run.lastAccountedAt = at;
  run.lastHeartbeatAt = at;
  run.graceStartedAt = null;
  run.graceUsedMs = 0;
  delete run.graceDebtWindowStartAt;
  run.inputBlocked = false;
  delete run.logoutRequestedAt;
  delete run.checkpointOnComplete;
  account.worker.status = 'active';
  account.worker.warmUntil = null;
  return { run, account };
}

function gateFor(cloud, account, deviceId = '') {
  const run = activeRun(cloud, account);
  const checkpoint = takeoverRun(cloud, account);
  if (!account.timezone) {
    return { state: 'timezone_required', canStart: false, canTakeover: false, reason: 'Set an account timezone' };
  }
  if (run?.status === 'active' && run.graceStartedAt != null) {
    return { state: 'grace_active', canStart: false, canTakeover: false, reason: 'The active turn is finishing in grace' };
  }
  if (run && run.ownerDeviceId !== deviceId) {
    return { state: 'owned_elsewhere', canStart: false, canTakeover: run.status === 'checkpointed', reason: 'Raucloud is active on another device' };
  }
  if (account.worker && account.worker.ownerDeviceId !== deviceId) {
    return { state: 'owned_elsewhere', canStart: false, canTakeover: false, reason: 'Raucloud is reserved by another device' };
  }
  if (!run && !account.worker && checkpoint && checkpoint.ownerDeviceId !== deviceId) {
    const artifactReady = Boolean(checkpoint.checkpointArtifact?.id && checkpoint.checkpointArtifact?.sha256);
    return {
      state: 'owned_elsewhere',
      canStart: false,
      canTakeover: artifactReady,
      reason: artifactReady
        ? 'A checkpoint from another device is ready for takeover'
        : 'Cross-device takeover requires an encrypted checkpoint artifact',
    };
  }
  if (normalRemaining(account) <= 0) {
    return { state: 'quota_exhausted', canStart: false, canTakeover: false, reason: 'The daily Raucloud allowance is exhausted' };
  }
  return { state: 'ready', canStart: !run, canTakeover: false, reason: null };
}

function sameSecret(expected, candidate) {
  const left = Buffer.from(String(expected ?? ''));
  const right = Buffer.from(String(candidate ?? ''));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function secretHash(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/**
 * Durable, account-global Raucloud policy. The supplied mutate function must
 * serialize state changes across all service instances sharing the store.
 */
export function createRaucloudBroker({
  store,
  mutate,
  authenticateAccessToken,
  workerSecret = '',
  provisioner = null,
  provisionerRequired = false,
  now = Date.now,
} = {}) {
  if (!store || typeof mutate !== 'function' || typeof authenticateAccessToken !== 'function') {
    throw new Error('store, mutate, and authenticateAccessToken are required');
  }
  if (provisioner && (typeof provisioner.provision !== 'function' || typeof provisioner.teardown !== 'function')) {
    throw new Error('provisioner must implement provision and teardown');
  }
  const teardownClaims = new Set();
  const provisioningRuns = new Map();

  async function identity(token, deviceId = null) {
    return authenticateAccessToken(token, deviceId);
  }

  function assertWorkerSecret(candidate, run = null) {
    const scoped = run?.workerTokenHash && sameSecret(run.workerTokenHash, secretHash(candidate));
    if (!sameSecret(workerSecret, candidate) && !scoped) {
      throw cloudError('CLOUD_WORKER_UNAUTHORIZED', 'Worker authentication failed');
    }
  }

  function envelope(state, account, user, deviceId = '', runOverride = undefined, coldStart = undefined) {
    const cloud = ensureRaucloudState(state);
    const run = runOverride === undefined ? activeRun(cloud, account) : runOverride;
    const result = {
      account: publicAccount(account, user),
      quota: publicQuota(account, run, now()),
      worker: publicWorker(account.worker, deviceId),
      activeRun: publicRun(activeRun(cloud, account), deviceId),
      takeoverRun: publicRun(takeoverRun(cloud, account), deviceId),
      gate: gateFor(cloud, account, deviceId),
    };
    if (provisionerRequired && !provisioner) {
      result.gate = { state: 'unavailable', canStart: false, canTakeover: false, reason: 'Raucloud provisioning is unavailable' };
    }
    if (runOverride !== undefined) result.run = publicRun(runOverride, deviceId);
    if (coldStart !== undefined) result.coldStart = Boolean(coldStart);
    return result;
  }

  async function accountContext(token) {
    const userId = await identity(token);
    const state = await store.load();
    const cloud = ensureRaucloudState(state);
    const account = cloud.accounts[userId];
    return { state, cloud, account, userId, user: state.users?.[userId] };
  }

  async function cleanupPendingRemotes() {
    if (!provisioner) return;
    const snapshot = await store.load();
    const cloud = ensureRaucloudState(snapshot);
    const candidates = Object.values(cloud.runs).filter((run) => run?.remote && run.teardownRequestedAt);
    for (const run of candidates) {
      if (teardownClaims.has(run.id)) continue;
      teardownClaims.add(run.id);
      try {
        await provisioner.teardown(structuredClone(run.remote));
        await mutate((state) => {
          const current = ensureRaucloudState(state).runs[run.id];
          if (!current) return;
          delete current.remote;
          delete current.teardownRequestedAt;
          current.remoteDeletedAt = now();
          const account = ensureRaucloudState(state).accounts[current.accountId];
          if (account?.worker?.runId === current.id) account.worker = null;
        });
      } catch (error) {
        await mutate((state) => {
          const current = ensureRaucloudState(state).runs[run.id];
          if (current) current.teardownError = String(error?.message ?? error).slice(0, 500);
        });
      } finally {
        teardownClaims.delete(run.id);
      }
    }
  }

  async function cleanupRaucloudOrphans() {
    if (typeof provisioner?.reconcileRaucloud !== 'function' || typeof provisioner?.serviceName !== 'function') {
      return { enabled: false, found: 0, removed: 0 };
    }
    const cloud = ensureRaucloudState(await store.load());
    const keepServiceNames = Object.values(cloud.runs)
      .filter((run) => ['allocating', 'ready', 'active', 'checkpointing'].includes(run?.status))
      .flatMap((run) => [
        provisioner.serviceName({ accountId: run.accountId, runId: run.id }),
        provisioner.legacyServiceName?.({ accountId: run.accountId, runId: run.id }),
      ].filter(Boolean));
    return provisioner.reconcileRaucloud({ keepServiceNames, limit: 100 });
  }

  async function provisionCreatedRun(userId, runId, deviceId, workerToken) {
    if (!provisioner) return;
    try {
      const spawned = await provisioner.provision({
        runId,
        accountId: userId,
        deviceId,
        workerToken,
        onRemoteCreated: async (candidate) => {
          const remote = sanitizeRemote(candidate);
          await mutate((state) => {
            const cloud = ensureRaucloudState(state);
            const run = cloud.runs[runId];
            if (!run) throw cloudError('CLOUD_RUN_NOT_FOUND', 'Raucloud run not found');
            run.remote = remote;
            const account = ensureAccount(state, userId, now());
            if (account.worker?.runId === runId) account.worker.remote = remote;
          });
        },
      });
      const remote = sanitizeRemote(spawned.remote);
      const receipt = sanitizeReceipt(spawned.receipt);
      await mutate((state) => {
        const at = now();
        const cloud = ensureRaucloudState(state);
        const run = cloud.runs[runId];
        const account = ensureAccount(state, userId, at);
        if (!run || run.status !== 'allocating' || account.worker?.runId !== runId) {
          if (run) {
            run.remote = remote;
            run.teardownRequestedAt = at;
          }
          throw cloudError('CLOUD_RUN_STATE_INVALID', 'Raucloud allocation was cancelled');
        }
        run.remote = remote;
        run.receipt = receipt;
        run.status = 'ready';
        account.worker.remote = remote;
        account.worker.receipt = receipt;
        account.worker.status = 'ready';
        account.worker.warmUntil = at + CLOUD_WARM_IDLE_MS;
      });
    } catch (error) {
      await mutate((state) => {
        const run = ensureRaucloudState(state).runs[runId];
        if (!run) return;
        if (!['stopped', 'completed', 'failed'].includes(run.status)) {
          run.status = 'failed';
          run.failureCode = String(error?.code ?? 'CLOUD_PROVISION_FAILED').slice(0, 100);
          run.failureMessage = 'Raucloud could not allocate a worker';
          run.completedAt = now();
        }
        const account = ensureRaucloudState(state).accounts[userId];
        if (account) reserveTeardown(account, run, now());
      });
      await cleanupPendingRemotes();
      throw cloudError('CLOUD_PROVISION_FAILED', 'Raucloud could not allocate a worker', { cause: error?.code ?? null });
    }
  }

  function provisionCreatedRunInBackground(userId, runId, deviceId, workerToken) {
    if (provisioningRuns.has(runId)) return;
    const operation = provisionCreatedRun(userId, runId, deviceId, workerToken)
      .catch(() => {})
      .finally(() => {
        if (provisioningRuns.get(runId) === operation) provisioningRuns.delete(runId);
      });
    provisioningRuns.set(runId, operation);
  }

  return {
    async getAccount(token) {
      const userId = await identity(token);
      return mutate((state) => {
        const at = now();
        const account = ensureAccount(state, userId, at);
        reconcileAccount(state, account, at);
        return { account: publicAccount(account, state.users?.[userId]) };
      });
    },

    async setAccountTimezone(token, timezone) {
      const userId = await identity(token);
      return mutate((state) => {
        const at = now();
        const account = ensureAccount(state, userId, at);
        const selected = validateTimezone(timezone);
        if (!account.timezone) initializeTimezone(account, selected, at);
        else if (selected !== account.timezone && selected !== account.pendingTimezone?.timezone) {
          const availableAt = Number(account.timezoneChangedAt ?? 0) + CLOUD_TIMEZONE_CHANGE_MS;
          if (at < availableAt) {
            throw cloudError('CLOUD_TIMEZONE_CHANGE_RATE_LIMITED', 'Timezone can be changed once every 30 days', { availableAt });
          }
          advanceQuota(account, at);
          account.pendingTimezone = { timezone: selected, effectiveAt: account.quota.window.endAt };
          account.timezoneChangedAt = at;
        }
        return { account: publicAccount(account, state.users?.[userId]) };
      });
    },

    async getCloudStatus(token, { deviceId = '', timezone = null, runId = null } = {}) {
      const viewerDeviceId = String(deviceId ?? '');
      const userId = await identity(token, viewerDeviceId || null);
      const requestedRunId = runId == null || runId === '' ? null : validId(runId, 'runId');
      const result = await mutate((state) => {
        const at = now();
        const cloud = ensureRaucloudState(state);
        const account = ensureAccount(state, userId, at);
        if (!account.timezone && timezone) initializeTimezone(account, timezone, at);
        reconcileAccount(state, account, at);
        const requestedRun = requestedRunId ? cloud.runs[requestedRunId] : undefined;
        if (requestedRunId && (!requestedRun || requestedRun.accountId !== userId)) {
          throw cloudError('CLOUD_RUN_NOT_FOUND', 'Raucloud run not found');
        }
        return envelope(state, account, state.users?.[userId], viewerDeviceId, requestedRun);
      });
      await cleanupPendingRemotes();
      return result;
    },

    async createCloudRun(token, { deviceId, timezone = null, idempotencyKey: rawKey } = {}) {
      const ownerDeviceId = validId(deviceId, 'deviceId');
      const userId = await identity(token, ownerDeviceId);
      if (provisionerRequired && !provisioner) throw cloudError('CLOUD_UNAVAILABLE', 'Raucloud provisioning is unavailable');
      const requestKey = validId(rawKey, 'idempotencyKey');
      let shouldProvision = false;
      let provisionWorkerToken = null;
      const created = await mutate((state) => {
        const at = now();
        const cloud = ensureRaucloudState(state);
        cleanupIdempotency(cloud, at);
        const account = ensureAccount(state, userId, at);
        if (!account.timezone && timezone) initializeTimezone(account, timezone, at);
        if (!account.timezone) throw cloudError('CLOUD_TIMEZONE_REQUIRED', 'Choose a timezone before using Raucloud');
        reconcileAccount(state, account, at);
        const idem = idempotencyKey(userId, 'create', requestKey);
        const replay = cloud.idempotency[idem];
        if (replay) {
          const prior = cloud.runs[replay.runId];
          return envelope(state, account, state.users?.[userId], ownerDeviceId, prior, replay.coldStart);
        }
        const current = activeRun(cloud, account);
        if (current) {
          throw cloudError(
            current.ownerDeviceId === ownerDeviceId ? 'CLOUD_RUN_ALREADY_ACTIVE' : 'CLOUD_OWNED_ELSEWHERE',
            current.ownerDeviceId === ownerDeviceId ? 'A Raucloud run is already active' : 'Raucloud is active on another device',
            { runId: current.id },
          );
        }
        if (account.worker && account.worker.ownerDeviceId !== ownerDeviceId) {
          throw cloudError('CLOUD_OWNED_ELSEWHERE', 'Raucloud is reserved by another device');
        }
        if (account.worker?.status === 'tearing_down') {
          throw cloudError('CLOUD_TEARDOWN_PENDING', 'The previous Raucloud worker is still being removed');
        }
        if (normalRemaining(account) <= 0) {
          throw cloudError('CLOUD_QUOTA_EXHAUSTED', 'The daily Raucloud allowance is exhausted', { resetsAt: account.quota.window.endAt });
        }
        const coldStart = !account.worker;
        if (coldStart) {
          account.coldStarts = account.coldStarts.filter((stamp) => stamp >= account.quota.window.startAt);
          const counts = coldStartCounts(account, at);
          if (counts.recent >= CLOUD_COLD_START_WINDOW_LIMIT || counts.usedToday >= CLOUD_COLD_START_DAILY_LIMIT) {
            throw cloudError('CLOUD_COLD_START_RATE_LIMITED', 'Too many Raucloud cold starts', {
              retryAt: Math.min(
                account.coldStarts.at(-CLOUD_COLD_START_WINDOW_LIMIT) + CLOUD_COLD_START_WINDOW_MS,
                account.quota.window.endAt,
              ),
            });
          }
        }
        const runId = `run_${randomBytes(18).toString('base64url')}`;
        const workerToken = coldStart ? `mcw_${randomBytes(32).toString('base64url')}` : null;
        const worker = account.worker ?? {
          id: `worker_${randomBytes(18).toString('base64url')}`,
          createdAt: at,
        };
        const run = {
          id: runId,
          accountId: userId,
          ownerDeviceId,
          workerId: worker.id,
          status: coldStart ? 'allocating' : 'ready',
          createdAt: at,
          graceStartedAt: null,
          graceUsedMs: 0,
          inputBlocked: false,
          coldStart,
          workerTokenHash: coldStart ? secretHash(workerToken) : worker.workerTokenHash,
          ...(worker.receipt ? { receipt: { ...worker.receipt } } : {}),
          ...(worker.remote ? { remote: { ...worker.remote } } : {}),
        };
        cloud.runs[runId] = run;
        account.worker = {
          ...worker,
          ownerDeviceId,
          runId,
          status: 'allocating',
          warmUntil: coldStart ? null : at + CLOUD_WARM_IDLE_MS,
          workerTokenHash: coldStart ? secretHash(workerToken) : worker.workerTokenHash,
        };
        if (!coldStart) account.worker.status = 'ready';
        cloud.idempotency[idem] = { runId, coldStart, createdAt: at };
        shouldProvision = coldStart && Boolean(provisioner);
        if (shouldProvision) provisionWorkerToken = workerToken;
        return envelope(state, account, state.users?.[userId], ownerDeviceId, run, coldStart);
      });
      if (!shouldProvision) return created;
      provisionCreatedRunInBackground(userId, created.run.id, ownerDeviceId, provisionWorkerToken);
      return created;
    },

    async takeoverCloudRun(token, sourceRunId, { deviceId, checkpointId, idempotencyKey: rawKey } = {}) {
      const ownerDeviceId = validId(deviceId, 'deviceId');
      const userId = await identity(token, ownerDeviceId);
      if (provisionerRequired && !provisioner) throw cloudError('CLOUD_UNAVAILABLE', 'Raucloud provisioning is unavailable');
      const sourceId = validId(sourceRunId, 'runId');
      const requestedCheckpoint = validId(checkpointId, 'checkpointId');
      const requestKey = validId(rawKey, 'idempotencyKey');
      let shouldProvision = false;
      let provisionWorkerToken = null;
      const created = await mutate((state) => {
        const at = now();
        const cloud = ensureRaucloudState(state);
        cleanupIdempotency(cloud, at);
        const account = ensureAccount(state, userId, at);
        reconcileAccount(state, account, at);
        const idem = idempotencyKey(userId, `takeover:${sourceId}`, requestKey);
        const replay = cloud.idempotency[idem];
        if (replay) {
          return envelope(state, account, state.users?.[userId], ownerDeviceId, cloud.runs[replay.runId], replay.coldStart);
        }
        const source = cloud.runs[sourceId];
        if (!source || source.accountId !== userId) throw cloudError('CLOUD_RUN_NOT_FOUND', 'Raucloud run not found');
        if (!['checkpointed', 'completed'].includes(source.status) || source.checkpointId !== requestedCheckpoint) {
          throw cloudError('CLOUD_TAKEOVER_NOT_READY', 'A matching completed checkpoint is required for takeover');
        }
        if (!source.checkpointArtifact?.id || !source.checkpointArtifact?.sha256) {
          throw cloudError(
            'CLOUD_TAKEOVER_ARTIFACT_UNAVAILABLE',
            'Cross-device takeover requires an encrypted checkpoint artifact',
          );
        }
        if (activeRun(cloud, account) || account.worker) {
          throw cloudError('CLOUD_RUN_ALREADY_ACTIVE', 'Another Raucloud worker is already allocated');
        }
        if (!account.timezone || normalRemaining(account) <= 0) {
          throw cloudError('CLOUD_QUOTA_EXHAUSTED', 'The daily Raucloud allowance is exhausted');
        }
        account.coldStarts = account.coldStarts.filter((stamp) => stamp >= account.quota.window.startAt);
        const counts = coldStartCounts(account, at);
        if (counts.recent >= CLOUD_COLD_START_WINDOW_LIMIT || counts.usedToday >= CLOUD_COLD_START_DAILY_LIMIT) {
          throw cloudError('CLOUD_COLD_START_RATE_LIMITED', 'Too many Raucloud cold starts');
        }
        const runId = `run_${randomBytes(18).toString('base64url')}`;
        const workerToken = `mcw_${randomBytes(32).toString('base64url')}`;
        const workerId = `worker_${randomBytes(18).toString('base64url')}`;
        const run = {
          id: runId,
          accountId: userId,
          ownerDeviceId,
          workerId,
          sourceRunId: sourceId,
          checkpointId: requestedCheckpoint,
          status: 'allocating',
          createdAt: at,
          graceStartedAt: null,
          graceUsedMs: 0,
          inputBlocked: false,
          coldStart: true,
          workerTokenHash: secretHash(workerToken),
        };
        cloud.runs[runId] = run;
        account.worker = {
          id: workerId,
          ownerDeviceId,
          runId,
          status: 'allocating',
          createdAt: at,
          warmUntil: null,
          workerTokenHash: secretHash(workerToken),
        };
        cloud.idempotency[idem] = { runId, coldStart: true, createdAt: at };
        shouldProvision = Boolean(provisioner);
        if (shouldProvision) provisionWorkerToken = workerToken;
        return envelope(state, account, state.users?.[userId], ownerDeviceId, run, true);
      });
      if (!shouldProvision) return created;
      provisionCreatedRunInBackground(userId, created.run.id, ownerDeviceId, provisionWorkerToken);
      return created;
    },

    async forceQuitAccountCloud(token, { deviceId, reason = 'force-quit' } = {}) {
      const requesterDeviceId = validId(deviceId, 'deviceId');
      const userId = await identity(token, requesterDeviceId);
      const result = await mutate((state) => {
        const at = now();
        const cloud = ensureRaucloudState(state);
        const account = ensureAccount(state, userId, at);
        reconcileAccount(state, account, at);
        const live = Object.values(cloud.runs).filter((run) => (
          run?.accountId === userId
          && ['allocating', 'ready', 'active', 'checkpointing'].includes(run.status)
        ));
        for (const run of live) {
          if (run.status === 'active') chargeRun(account, run, at);
          if (!['stopped', 'completed', 'failed'].includes(run.status)) {
            run.status = 'stopped';
            run.stopReason = String(reason ?? 'force-quit').slice(0, 80);
            run.completedAt = at;
          }
          reserveTeardown(account, run, at);
        }
        if (account.worker && !live.some((run) => run.id === account.worker.runId)) {
          const leftover = cloud.runs[account.worker.runId];
          if (leftover) reserveTeardown(account, leftover, at);
          else account.worker = null;
        }
        return envelope(state, account, state.users?.[userId], requesterDeviceId);
      });
      await cleanupPendingRemotes();
      return result;
    },

    async stopCloudRun(token, runId, {
      deviceId,
      reason = 'user',
      finishCurrentTurn = false,
      checkpoint = false,
    } = {}) {
      const ownerDeviceId = validId(deviceId, 'deviceId');
      const userId = await identity(token, ownerDeviceId);
      const result = await mutate((state) => {
        const at = now();
        const cloud = ensureRaucloudState(state);
        const account = ensureAccount(state, userId, at);
        const run = cloud.runs[validId(runId, 'runId')];
        if (!run || run.accountId !== userId) throw cloudError('CLOUD_RUN_NOT_FOUND', 'Raucloud run not found');
        if (run.ownerDeviceId !== ownerDeviceId) throw cloudError('CLOUD_OWNED_ELSEWHERE', 'Only the controlling device can stop this run');
        if (run.status === 'active') {
          chargeRun(account, run, at);
          if (finishCurrentTurn) {
            run.inputBlocked = true;
            run.logoutRequestedAt = at;
            run.checkpointOnComplete = Boolean(checkpoint);
            account.worker.teardownAfterTurn = true;
            return envelope(state, account, state.users?.[userId], ownerDeviceId, run);
          }
        }
        if (!['stopped', 'completed', 'failed'].includes(run.status)) {
          run.status = 'stopped';
          run.stopReason = String(reason ?? 'user').slice(0, 80);
          run.completedAt = at;
        }
        reserveTeardown(account, run, at);
        return envelope(state, account, state.users?.[userId], ownerDeviceId, run);
      });
      await cleanupPendingRemotes();
      return result;
    },

    async logoutCloudDevice(token, deviceId) {
      const ownerDeviceId = validId(deviceId, 'deviceId');
      const userId = await identity(token, ownerDeviceId);
      const result = await mutate((state) => {
        const at = now();
        const cloud = ensureRaucloudState(state);
        const account = ensureAccount(state, userId, at);
        reconcileAccount(state, account, at);
        const run = activeRun(cloud, account);
        if (!account.worker || account.worker.ownerDeviceId !== ownerDeviceId) return { controlling: false };
        if (run?.status === 'active') {
          chargeRun(account, run, at);
          run.inputBlocked = true;
          run.logoutRequestedAt = at;
          account.worker.teardownAfterTurn = true;
          return { controlling: true, finishing: true, run: publicRun(run) };
        }
        if (run) {
          run.status = 'stopped';
          run.completedAt = at;
          run.stopReason = 'logout';
        }
        reserveTeardown(account, run, at);
        return { controlling: true, finishing: false, run: publicRun(run) };
      });
      await cleanupPendingRemotes();
      return result;
    },

    async confirmCloudAllocation(secret, runId) {
      return mutate((state) => {
        const at = now();
        const runRecord = ensureRaucloudState(state).runs[validId(runId, 'runId')];
        assertWorkerSecret(secret, runRecord);
        const { run, account } = confirmAllocationState(state, runId, at);
        return { run: publicRun(run), quota: publicQuota(account, run, at), mustStop: false };
      });
    },

    async heartbeatCloudRun(secret, runId) {
      const result = await mutate((state) => {
        const at = now();
        const cloud = ensureRaucloudState(state);
        const run = cloud.runs[validId(runId, 'runId')];
        assertWorkerSecret(secret, run);
        if (!run) throw cloudError('CLOUD_RUN_NOT_FOUND', 'Raucloud run not found');
        const account = ensureAccount(state, run.accountId, at);
        if (account.worker?.runId !== run.id || run.status !== 'active') {
          throw cloudError('CLOUD_RUN_STATE_INVALID', 'Raucloud run is not active');
        }
        const charge = chargeRun(account, run, at);
        run.lastHeartbeatAt = at;
        if (charge.mustStop) {
          run.status = 'stopped';
          run.stopReason = 'grace_fuse';
          run.completedAt = run.lastAccountedAt;
          reserveTeardown(account, run, at);
        }
        return { run: publicRun(run), quota: publicQuota(account, run, at), mustStop: charge.mustStop };
      });
      await cleanupPendingRemotes();
      return result;
    },

    async checkpointCloudRun(secret, runId, checkpointId) {
      const storedCheckpoint = validId(checkpointId, 'checkpointId');
      const result = await mutate((state) => {
        const at = now();
        const cloud = ensureRaucloudState(state);
        const run = cloud.runs[validId(runId, 'runId')];
        assertWorkerSecret(secret, run);
        if (!run) throw cloudError('CLOUD_RUN_NOT_FOUND', 'Raucloud run not found');
        const account = ensureAccount(state, run.accountId, at);
        if (run.status === 'active') chargeRun(account, run, at);
        if (!['active', 'checkpointing'].includes(run.status)) {
          throw cloudError('CLOUD_RUN_STATE_INVALID', 'Raucloud run cannot be checkpointed');
        }
        run.status = 'checkpointed';
        run.checkpointId = storedCheckpoint;
        run.completedAt = at;
        account.latestCheckpointRunId = run.id;
        reserveTeardown(account, run, at);
        return { run: publicRun(run), quota: publicQuota(account, run, at), worker: null };
      });
      await cleanupPendingRemotes();
      return result;
    },

    async completeCloudRun(secret, runId, { checkpointId = null } = {}) {
      const result = await mutate((state) => {
        const at = now();
        const cloud = ensureRaucloudState(state);
        const run = cloud.runs[validId(runId, 'runId')];
        assertWorkerSecret(secret, run);
        if (!run) throw cloudError('CLOUD_RUN_NOT_FOUND', 'Raucloud run not found');
        const account = ensureAccount(state, run.accountId, at);
        if (run.status !== 'active') throw cloudError('CLOUD_RUN_STATE_INVALID', 'Raucloud run is not active');
        const charge = chargeRun(account, run, at);
        run.lastTurnCompletedAt = at;
        if (checkpointId) run.checkpointId = validId(checkpointId, 'checkpointId');
        if (run.checkpointId) account.latestCheckpointRunId = run.id;
        if (account.worker?.runId === run.id) {
          if (account.worker.teardownAfterTurn || charge.mustStop) {
            run.status = 'completed';
            run.completedAt = at;
            reserveTeardown(account, run, at);
          }
          else {
            run.status = 'ready';
            account.worker.status = 'warm';
            account.worker.warmUntil = at + CLOUD_WARM_IDLE_MS;
          }
        }
        return { run: publicRun(run), quota: publicQuota(account, run, at), worker: publicWorker(account.worker), mustStop: charge.mustStop };
      });
      await cleanupPendingRemotes();
      return result;
    },

    async releaseCloudRun(secret, runId, { failureCode = 'WORKER_RELEASED' } = {}) {
      const result = await mutate((state) => {
        const at = now();
        const cloud = ensureRaucloudState(state);
        const run = cloud.runs[validId(runId, 'runId')];
        assertWorkerSecret(secret, run);
        if (!run) throw cloudError('CLOUD_RUN_NOT_FOUND', 'Raucloud run not found');
        const account = ensureAccount(state, run.accountId, at);
        if (run.status === 'active') chargeRun(account, run, at);
        if (!['completed', 'stopped', 'checkpointed', 'failed'].includes(run.status)) {
          run.status = 'failed';
          run.failureCode = String(failureCode ?? 'WORKER_RELEASED').slice(0, 80);
          run.completedAt = at;
        }
        reserveTeardown(account, run, at);
        return { run: publicRun(run), quota: publicQuota(account, run, at), worker: null };
      });
      await cleanupPendingRemotes();
      return result;
    },

    /** Broker-owned durable metering tick; run every 30s from the HTTP service. */
    async reconcileCloudUsage() {
      const result = await mutate((state) => {
        const at = now();
        const cloud = ensureRaucloudState(state);
        let active = 0;
        let stopped = 0;
        for (const account of Object.values(cloud.accounts)) {
          advanceQuota(account, at);
          const run = activeRun(cloud, account);
          if (run?.status === 'active') {
            active += 1;
            const charge = chargeRun(account, run, at);
            run.lastHeartbeatAt = at;
            if (charge.mustStop) {
              run.status = 'stopped';
              run.stopReason = 'grace_fuse';
              run.completedAt = run.lastAccountedAt;
              reserveTeardown(account, run, at);
              stopped += 1;
            }
          } else {
            reconcileAccount(state, account, at);
          }
        }
        return { active, stopped, at };
      });
      await cleanupPendingRemotes();
      const orphans = await cleanupRaucloudOrphans();
      return { ...result, orphans };
    },

    /** A warm worker discovers its newly assigned run without receiving a new secret. */
    async getCloudLease(secret) {
      const hash = secretHash(secret);
      const state = await store.load();
      const cloud = ensureRaucloudState(state);
      for (const account of Object.values(cloud.accounts)) {
        if (!account.worker?.workerTokenHash || !sameSecret(account.worker.workerTokenHash, hash)) continue;
        const run = cloud.runs[account.worker.runId];
        if (!run || !['ready', 'active'].includes(run.status)) break;
        return {
          runId: run.id,
          workerId: account.worker.id,
          status: run.status,
          ownerDeviceId: run.ownerDeviceId,
          shouldConfirm: run.status === 'ready',
          inputBlocked: Boolean(run.inputBlocked),
        };
      }
      throw cloudError('CLOUD_WORKER_UNAUTHORIZED', 'No Raucloud lease matches this worker token');
    },

    async reconcileLegacyCloud() {
      if (typeof provisioner?.reconcileLegacy !== 'function') return { enabled: false, found: 0, removed: 0 };
      return provisioner.reconcileLegacy({ checkpointWindowMs: 72 * 60 * 60 * 1000, limit: 100 });
    },

    // Read-only hook used by tests and store migrations; never expose via HTTP.
    async inspectCloudState(token) {
      const context = await accountContext(token);
      return structuredClone({ account: context.account, runs: context.cloud.runs });
    },
  };
}

import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function authError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requiredText(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw authError('INVALID_REQUEST', `${field} is required`);
  return text;
}

export class AuthRunRegistry {
  constructor({
    now = Date.now,
    ttlMs = DEFAULT_TTL_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.runs = new Map();
  }

  begin({ agent, ownerSessionId, requestId = null, method, replayableUi = null, cancel = null }) {
    const normalizedAgent = requiredText(agent, 'agent');
    this.#expire(normalizedAgent);
    if (this.runs.has(normalizedAgent)) {
      throw authError('AGENT_AUTH_BUSY', `${normalizedAgent} authentication is already in progress`);
    }
    const createdAt = this.now();
    const run = {
      runId: crypto.randomUUID(),
      agent: normalizedAgent,
      ownerSessionId: requiredText(ownerSessionId, 'ownerSessionId'),
      requestId: typeof requestId === 'string' ? requestId : null,
      method: requiredText(method, 'method'),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      phase: 'starting',
      replayableUi: replayableUi && typeof replayableUi === 'object'
        ? structuredClone(replayableUi)
        : null,
      cancel: typeof cancel === 'function' ? cancel : null,
      expiryTimer: null,
    };
    this.runs.set(normalizedAgent, run);
    this.#scheduleExpiry(run);
    return run;
  }

  get(agent) {
    const normalizedAgent = requiredText(agent, 'agent');
    this.#expire(normalizedAgent);
    return this.runs.get(normalizedAgent) ?? null;
  }

  requireOwned({ agent, runId, ownerSessionId }) {
    const run = this.get(agent);
    if (!run) throw authError('AGENT_AUTH_NOT_FOUND', 'Authentication is no longer in progress');
    if (run.runId !== runId || run.ownerSessionId !== ownerSessionId) {
      throw authError('AGENT_AUTH_NOT_OWNER', 'This authentication belongs to another Studio session');
    }
    return run;
  }

  update(run, { phase, replayableUi } = {}) {
    if (!run || this.runs.get(run.agent) !== run) {
      throw authError('AGENT_AUTH_NOT_FOUND', 'Authentication is no longer in progress');
    }
    if (typeof phase === 'string' && phase) run.phase = phase;
    if (replayableUi && typeof replayableUi === 'object') {
      run.replayableUi = {
        ...(run.replayableUi ?? {}),
        ...structuredClone(replayableUi),
      };
    }
    return run;
  }

  finish(run) {
    if (!run || this.runs.get(run.agent) !== run) return false;
    this.runs.delete(run.agent);
    this.#clearExpiry(run);
    return true;
  }

  cancelOwned({ agent, runId, ownerSessionId, reason = 'cancelled' }) {
    const run = this.requireOwned({ agent, runId, ownerSessionId });
    this.runs.delete(run.agent);
    this.#cancel(run, reason);
    return run;
  }

  cancelForSession(ownerSessionId, reason = 'owner-session-closed') {
    const cancelled = [];
    for (const run of this.runs.values()) {
      if (run.ownerSessionId !== ownerSessionId) continue;
      this.runs.delete(run.agent);
      this.#cancel(run, reason);
      cancelled.push(run);
    }
    return cancelled;
  }

  forSession(ownerSessionId) {
    const snapshots = [];
    for (const agent of [...this.runs.keys()]) {
      const run = this.get(agent);
      if (run?.ownerSessionId === ownerSessionId) snapshots.push(this.snapshot(run, true));
    }
    return snapshots;
  }

  status(agent, ownerSessionId) {
    const run = this.get(agent);
    return {
      authenticating: Boolean(run),
      authOwnedByThisSession: Boolean(run && run.ownerSessionId === ownerSessionId),
      ...(run && run.ownerSessionId === ownerSessionId
        ? {
          authRunId: run.runId,
          authPhase: run.phase,
          ...(run.replayableUi ? structuredClone(run.replayableUi) : {}),
        }
        : {}),
    };
  }

  snapshot(run, includePrivate = false) {
    return {
      authRunId: run.runId,
      agent: run.agent,
      method: run.method,
      phase: run.phase,
      createdAt: new Date(run.createdAt).toISOString(),
      expiresAt: new Date(run.expiresAt).toISOString(),
      ...(includePrivate && run.replayableUi ? structuredClone(run.replayableUi) : {}),
    };
  }

  #expire(agent) {
    const run = this.runs.get(agent);
    if (!run || run.expiresAt > this.now()) return;
    this.runs.delete(agent);
    this.#cancel(run, 'expired');
  }

  #scheduleExpiry(run) {
    const delay = Math.max(0, run.expiresAt - this.now());
    const timer = this.setTimer(() => {
      if (this.runs.get(run.agent) !== run) return;
      this.runs.delete(run.agent);
      run.expiryTimer = null;
      this.#invokeCancel(run, 'expired');
    }, delay);
    timer?.unref?.();
    run.expiryTimer = timer;
  }

  #clearExpiry(run) {
    if (run?.expiryTimer === null || run?.expiryTimer === undefined) return;
    this.clearTimer(run.expiryTimer);
    run.expiryTimer = null;
  }

  #invokeCancel(run, reason) {
    try {
      const result = run.cancel?.(reason);
      Promise.resolve(result).catch(() => {});
    } catch {
      // Cancellation is best-effort; registry ownership must still be released.
    }
  }

  #cancel(run, reason) {
    this.#clearExpiry(run);
    this.#invokeCancel(run, reason);
  }
}

export { DEFAULT_TTL_MS as AUTH_RUN_TTL_MS };

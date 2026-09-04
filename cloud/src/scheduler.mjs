import { randomBytes } from 'node:crypto';
import { statfs } from 'node:fs/promises';

const PAUSE_ACK_TIMEOUT_MS = 5 * 60 * 1000;
const TAKEOVER_ACK_TIMEOUT_MS = 5 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

export class Scheduler {
  constructor(sessionStore, runner, {
    logger,
    intervalMs = 2_000,
    maxRunningSessions = 2,
    now = Date.now,
    controlEndpoint,
    controlSocket,
    dataDirectory,
    maintenance,
  } = {}) {
    this.sessionStore = sessionStore;
    this.runner = runner;
    this.logger = logger;
    this.intervalMs = intervalMs;
    const runnerLimit = Number.isSafeInteger(runner?.maxRunningSessions) && runner.maxRunningSessions > 0
      ? runner.maxRunningSessions
      : maxRunningSessions;
    this.maxRunningSessions = Math.min(maxRunningSessions, runnerLimit);
    this.now = now;
    this.controlEndpoint = controlEndpoint ?? (controlSocket ? { socketPath: controlSocket } : null);
    this.dataDirectory = dataDirectory;
    this.maintenance = maintenance;
    this.lastMaintenanceAt = 0;
    this.timer = null;
    this.ticking = null;
    this.starting = null;
    this.stopping = null;
    this.launching = null;
    this.generation = 0;
  }

  async recover() {
    const live = await this.runner.list();
    return this.sessionStore.recoverInterruptedSessions(new Set(live.map((sandbox) => sandbox.sandboxId)));
  }

  async tick(generation = this.generation) {
    if (this.ticking) return this.ticking;
    this.ticking = this.#tick(generation).finally(() => { this.ticking = null; });
    return this.ticking;
  }

  #cancelled(generation) {
    return generation !== this.generation;
  }

  #requeueCancelledLaunch(sessionId) {
    try {
      this.sessionStore.requeueInterruptedSession?.(sessionId, 'scheduler_stopped');
      return null;
    } catch (error) {
      this.logger?.error('sandbox.start_cancel_failed', {
        code: error.code,
        message: error.message,
      }, sessionId);
      return error;
    }
  }

  async #tick(generation) {
    // Acquire the full inventory once per tick. A failed or malformed
    // inventory must stop recovery instead of looking like zero live
    // sandboxes and invalidating healthy workers.
    const sandboxes = await this.runner.list({ all: true });
    if (this.#cancelled(generation)) return;
    if (this.maintenance && this.now() - this.lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS) {
      await this.maintenance().catch((error) => {
        this.logger?.error('maintenance.failed', { code: error.code, message: error.message });
      });
      if (this.#cancelled(generation)) return;
      this.lastMaintenanceAt = this.now();
    }
    await this.sessionStore.expireRetainedSessions();
    if (this.#cancelled(generation)) return;
    this.sessionStore.requestIdleSleeps?.();
    const liveIds = new Set(
      sandboxes.filter((sandbox) => sandbox.running !== false).map((sandbox) => sandbox.sandboxId),
    );
    const runningSessions = this.sessionStore.database.prepare(`SELECT * FROM sessions WHERE status = 'running'`).all();
    for (const session of runningSessions) {
      if (this.#cancelled(generation)) return;
      if (session.takeover_requested_at && this.now() - session.takeover_requested_at >= TAKEOVER_ACK_TIMEOUT_MS) {
        if (session.sandbox_id) await this.runner.stop(session.sandbox_id);
        if (this.#cancelled(generation)) return;
        this.sessionStore.acknowledgeTakeover(session.id, { forced: true });
        continue;
      }
      if (session.pause_requested_at && this.now() - session.pause_requested_at >= PAUSE_ACK_TIMEOUT_MS) {
        if (session.sandbox_id) await this.runner.stop(session.sandbox_id);
        if (this.#cancelled(generation)) return;
        this.sessionStore.suspend(session.id, {
          code: 'PAUSE_TIMEOUT',
          message: 'Worker did not reach a stable pause boundary within five minutes',
        });
        continue;
      }
      if (session.started_at && this.now() >= session.started_at + session.max_duration_seconds * 1000) {
        if (session.sandbox_id) await this.runner.stop(session.sandbox_id);
        if (this.#cancelled(generation)) return;
        this.sessionStore.suspend(session.id, { code: 'DURATION_LIMIT', message: 'Session duration limit reached' });
        continue;
      }
      if (session.sandbox_id && !liveIds.has(session.sandbox_id)) {
        this.sessionStore.requeueInterruptedSession(session.id, 'sandbox_exited');
        continue;
      }
      if (session.sandbox_id && session.worker_heartbeat_at && this.now() - session.worker_heartbeat_at > 60_000) {
        await this.runner.stop(session.sandbox_id);
        if (this.#cancelled(generation)) return;
        this.sessionStore.requeueInterruptedSession(session.id, 'heartbeat_expired');
      }
    }
    for (const sandbox of sandboxes) {
      if (this.#cancelled(generation)) return;
      const session = this.sessionStore.database.prepare(
        'SELECT status, sandbox_id FROM sessions WHERE id = ?',
      ).get(sandbox.sessionId);
      if (session?.status === 'running'
        && session.sandbox_id === sandbox.sandboxId
        && liveIds.has(sandbox.sandboxId)) continue;
      await this.runner.stop(sandbox.sandboxId);
      if (this.#cancelled(generation)) return;
      this.sessionStore.clearSandbox(sandbox.sessionId, sandbox.sandboxId);
      this.logger?.info('sandbox.stopped', { sandboxId: sandbox.sandboxId }, sandbox.sessionId);
    }
    while (true) {
      if (this.#cancelled(generation)) return;
      const running = this.sessionStore.database.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE status = 'running'`).get().count;
      if (running >= this.maxRunningSessions) return;
      const session = this.sessionStore.claimNextSession(this.maxRunningSessions);
      if (!session) return;
      if (this.dataDirectory) {
        const filesystem = await statfs(this.dataDirectory, { bigint: true });
        if (this.#cancelled(generation)) {
          this.#requeueCancelledLaunch(session.id);
          return;
        }
        const available = filesystem.bavail * filesystem.bsize;
        const total = filesystem.blocks * filesystem.bsize;
        if (available < 5n * 1024n ** 3n || available * 10n < total) {
          this.sessionStore.suspend(session.id, {
            code: 'LOW_DISK',
            message: 'Cloud storage has less than 5 GiB or 10 percent free',
          });
          return;
        }
      }
      const provider = this.sessionStore.providerStatus(session.provider);
      if (!provider.available || !provider.authenticated) {
        const code = provider.available ? 'AUTH_REQUIRED' : 'PROVIDER_UNAVAILABLE';
        this.sessionStore.suspend(session.id, {
          code,
          message: provider.errorMessage || `${session.provider} is not ready on this Cloud host`,
          setupAction: provider.setupAction,
        });
        continue;
      }
      if (this.#cancelled(generation)) {
        this.#requeueCancelledLaunch(session.id);
        return;
      }
      let sandboxId = null;
      let attached = false;
      const launch = { generation, sessionId: session.id };
      this.launching = launch;
      try {
        const workerToken = `ra_wt_${randomBytes(32).toString('base64url')}`;
        this.sessionStore.prepareWorker(session.id, workerToken);
        if (this.#cancelled(generation)) {
          this.#requeueCancelledLaunch(session.id);
          return;
        }
        sandboxId = await this.runner.start(session, {
          workerToken,
          controlEndpoint: this.controlEndpoint,
          controlSocket: this.controlEndpoint?.socketPath,
        });
        if (this.#cancelled(generation)) {
          const requeueError = this.#requeueCancelledLaunch(session.id);
          await this.runner.stop(sandboxId).then(
            () => this.logger?.info('sandbox.start_cancelled', { sandboxId }, session.id),
            (cleanupError) => {
              this.logger?.error('sandbox.start_cancel_cleanup_failed', {
                sandboxId,
                code: cleanupError.code,
                message: cleanupError.message,
              }, session.id);
            },
          );
          if (requeueError) {
            this.logger?.error('sandbox.start_cancel_state_uncertain', {
              sandboxId,
              code: requeueError.code,
              message: requeueError.message,
            }, session.id);
          }
          return;
        }
        this.sessionStore.attachSandbox(session.id, sandboxId);
        attached = true;
        this.logger?.info('sandbox.started', { sandboxId }, session.id);
      } catch (error) {
        if (sandboxId && !attached) {
          await this.runner.stop(sandboxId).then(
            () => this.logger?.info('sandbox.start_rolled_back', { sandboxId }, session.id),
            (cleanupError) => {
              this.logger?.error('sandbox.start_rollback_failed', {
                sandboxId,
                code: cleanupError.code,
                message: cleanupError.message,
              }, session.id);
            },
          );
        }
        this.logger?.error('sandbox.start_failed', { code: error.code, message: error.message }, session.id);
        this.sessionStore.suspend(session.id, { code: 'WORKER_START_FAILED', message: error.message });
      } finally {
        if (this.launching === launch) this.launching = null;
      }
    }
  }

  async start() {
    if (this.timer) return;
    if (this.starting) return this.starting;
    if (this.stopping) {
      await this.stopping;
      return this.start();
    }
    const generation = ++this.generation;
    let starting;
    starting = (async () => {
      await this.recover();
      if (generation !== this.generation) return;
      await this.tick(generation);
      if (generation !== this.generation) return;
      this.timer = setInterval(() => {
        if (generation !== this.generation) return;
        void this.tick(generation).catch((error) => {
          this.logger?.error('scheduler.tick_failed', { code: error.code, message: error.message });
        });
      }, this.intervalMs);
      this.timer.unref();
    })().finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  async stop() {
    if (this.stopping) return this.stopping;
    this.generation += 1;
    if (this.launching) this.#requeueCancelledLaunch(this.launching.sessionId);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const pending = [this.starting, this.ticking].filter(Boolean);
    let stopping;
    stopping = Promise.allSettled(pending).then(() => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }).finally(() => {
      if (this.stopping === stopping) this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }
}

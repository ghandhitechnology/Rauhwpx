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
    this.maxRunningSessions = maxRunningSessions;
    this.now = now;
    this.controlEndpoint = controlEndpoint ?? (controlSocket ? { socketPath: controlSocket } : null);
    this.dataDirectory = dataDirectory;
    this.maintenance = maintenance;
    this.lastMaintenanceAt = 0;
    this.timer = null;
    this.ticking = null;
  }

  async recover() {
    const live = await this.runner.list();
    return this.sessionStore.recoverInterruptedSessions(new Set(live.map((sandbox) => sandbox.sandboxId)));
  }

  async tick() {
    if (this.ticking) return this.ticking;
    this.ticking = this.#tick().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  async #tick() {
    // Acquire both Podman inventories before touching session state. A failed or
    // malformed inventory must stop recovery instead of looking like zero live
    // sandboxes and invalidating healthy workers.
    const live = await this.runner.list();
    const allSandboxes = await this.runner.list({ all: true });
    if (this.maintenance && this.now() - this.lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS) {
      await this.maintenance().catch((error) => {
        this.logger?.error('maintenance.failed', { code: error.code, message: error.message });
      });
      this.lastMaintenanceAt = this.now();
    }
    await this.sessionStore.expireRetainedSessions();
    const liveIds = new Set(live.map((sandbox) => sandbox.sandboxId));
    const runningSessions = this.sessionStore.database.prepare(`SELECT * FROM sessions WHERE status = 'running'`).all();
    for (const session of runningSessions) {
      if (session.takeover_requested_at && this.now() - session.takeover_requested_at >= TAKEOVER_ACK_TIMEOUT_MS) {
        await this.runner.stop(session.sandbox_id);
        this.sessionStore.acknowledgeTakeover(session.id, { forced: true });
        continue;
      }
      if (session.pause_requested_at && this.now() - session.pause_requested_at >= PAUSE_ACK_TIMEOUT_MS) {
        await this.runner.stop(session.sandbox_id);
        this.sessionStore.suspend(session.id, {
          code: 'PAUSE_TIMEOUT',
          message: 'Worker did not reach a stable pause boundary within five minutes',
        });
        continue;
      }
      if (session.started_at && this.now() >= session.started_at + session.max_duration_seconds * 1000) {
        await this.runner.stop(session.sandbox_id);
        this.sessionStore.suspend(session.id, { code: 'DURATION_LIMIT', message: 'Session duration limit reached' });
        continue;
      }
      if (session.sandbox_id && !liveIds.has(session.sandbox_id)) {
        this.sessionStore.requeueInterruptedSession(session.id, 'sandbox_exited');
        continue;
      }
      if (session.sandbox_id && session.worker_heartbeat_at && this.now() - session.worker_heartbeat_at > 60_000) {
        await this.runner.stop(session.sandbox_id);
        this.sessionStore.requeueInterruptedSession(session.id, 'heartbeat_expired');
      }
    }
    for (const sandbox of allSandboxes) {
      const session = this.sessionStore.database.prepare('SELECT status FROM sessions WHERE id = ?').get(sandbox.sessionId);
      if (session?.status === 'running' && liveIds.has(sandbox.sandboxId)) continue;
      await this.runner.stop(sandbox.sandboxId);
      this.sessionStore.clearSandbox(sandbox.sessionId, sandbox.sandboxId);
      this.logger?.info('sandbox.stopped', { sandboxId: sandbox.sandboxId }, sandbox.sessionId);
    }
    while (true) {
      const running = this.sessionStore.database.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE status = 'running'`).get().count;
      if (running >= this.maxRunningSessions) return;
      const session = this.sessionStore.claimNextSession(this.maxRunningSessions);
      if (!session) return;
      if (this.dataDirectory) {
        const filesystem = await statfs(this.dataDirectory, { bigint: true });
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
      try {
        const workerToken = `ra_wt_${randomBytes(32).toString('base64url')}`;
        this.sessionStore.prepareWorker(session.id, workerToken);
        const sandboxId = await this.runner.start(session, {
          workerToken,
          controlEndpoint: this.controlEndpoint,
          controlSocket: this.controlEndpoint?.socketPath,
        });
        this.sessionStore.attachSandbox(session.id, sandboxId);
        this.logger?.info('sandbox.started', { sandboxId }, session.id);
      } catch (error) {
        this.logger?.error('sandbox.start_failed', { code: error.code, message: error.message }, session.id);
        this.sessionStore.suspend(session.id, { code: 'WORKER_START_FAILED', message: error.message });
      }
    }
  }

  async start() {
    if (this.timer) return;
    await this.recover();
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger?.error('scheduler.tick_failed', { code: error.code, message: error.message });
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
  }
}

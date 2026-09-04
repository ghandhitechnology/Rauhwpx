import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { chmod, chown } from 'node:fs/promises';
import http from 'node:http';
import { AuthService } from './auth.mjs';
import { BlobStore } from './blob-store.mjs';
import { openDatabase } from './database.mjs';
import { DisplayFrameStore } from './display-frame-store.mjs';
import { createCloudHttpHandler } from './http-server.mjs';
import { loadOrCreateServerIdentity } from './identity.mjs';
import { LocalRunner } from './local-runner.mjs';
import { raucloudLeaseFromConfig } from './raucloud-lease.mjs';
import { PodmanRunner } from './podman-runner.mjs';
import { applyProviderAuth, parseProviderAuth } from './provider-auth.mjs';
import { ProviderManager } from './provider-manager.mjs';
import { RedactedLogger } from './redacted-logger.mjs';
import { Scheduler } from './scheduler.mjs';
import { SecretVault } from './secret-vault.mjs';
import { SessionStore } from './session-store.mjs';
import { ProviderCliManager } from './provider-cli.mjs';

function listen(server, target, host) {
  return new Promise((resolve, reject) => {
    const cleanup = () => server.off('error', onError);
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    server.once('error', onError);
    try {
      server.listen(target, host, () => {
        cleanup();
        resolve();
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    // Cloud event streams and partial HTTP requests can otherwise keep
    // shutdown open forever. No request may survive control-plane shutdown.
    server.closeAllConnections?.();
  });
}

function runtimeLifecycleError(message, code) {
  return Object.assign(new Error(message), { code, retryable: false });
}

export function createCloudRuntime(config, dependencies = {}) {
  if (config.runner === 'local' && config.maxRunningSessions !== 1) {
    config = { ...config, maxRunningSessions: 1 };
  }
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(config.workerControlDirectory, { recursive: true, mode: 0o700 });
  if (config.runner === 'local') mkdirSync(config.workspaceRoot, { recursive: true, mode: 0o711 });
  const database = dependencies.database ?? openDatabase(config.databasePath);
  const identity = dependencies.identity ?? loadOrCreateServerIdentity(config.dataDirectory);
  const blobStore = dependencies.blobStore ?? new BlobStore(database, { root: config.blobDirectory });
  const auth = dependencies.auth ?? new AuthService(database, {
    retrySecret: identity.privateKey,
    bootstrapToken: config.bootstrapToken,
  });
  const displayFrameStore = dependencies.displayFrameStore ?? new DisplayFrameStore({
    maxSessions: config.maxRunningSessions,
  });
  const sessionStore = dependencies.sessionStore ?? new SessionStore(database, blobStore, {
    maxQueuedSessions: config.maxQueuedSessions,
  });
  sessionStore.setRuntimeInvalidationHandler?.((sessionId) => displayFrameStore.closeSession(sessionId));
  const logger = dependencies.logger ?? new RedactedLogger(database);
  const vault = dependencies.vault ?? new SecretVault(database, { dataDirectory: config.dataDirectory });
  const providerManager = dependencies.providerManager ?? new ProviderManager(sessionStore, {
    providerAuthDirectory: config.providerAuthDirectory,
    providerCliDirectory: config.providerCliDirectory,
    vault,
    podmanConnection: config.podmanConnection,
    workerImage: config.workerImage,
    useContainerProbe: config.platform === 'darwin',
  });
  const runner = dependencies.runner
    ?? (config.runner === 'local' ? new LocalRunner(config, {
      onWorkerExit: (sandboxId, sessionId, code, stderrTail) => {
        logger.error('worker.exited', { sandboxId, code, stderr: stderrTail || undefined }, sessionId);
      },
    }) : new PodmanRunner(config));
  const scheduler = dependencies.scheduler ?? new Scheduler(sessionStore, runner, {
    logger,
    maxRunningSessions: config.maxRunningSessions,
    controlEndpoint: config.workerControlMode === 'socket' ? { socketPath: config.workerControlSocket } : null,
    dataDirectory: config.dataDirectory,
    maintenance: async () => {
      auth.prune();
      logger.prune();
      await blobStore.pruneStaleUploads();
    },
  });
  const providerCli = dependencies.providerCli ?? new ProviderCliManager(config, providerManager, vault);
  const raucloudLease = dependencies.raucloudLease ?? raucloudLeaseFromConfig(config);
  const seedProvider = dependencies.seedProvider ?? ((input) => providerCli.seed(input.provider, input));
  const services = {
    auth,
    blobStore,
    displayFrameStore,
    sessionStore,
    identity,
    config,
    logger,
    vault,
    seedProvider,
    raucloudLease,
    applyProviderAuth: async (provider, raw) => {
      const imported = await applyProviderAuth(provider, parseProviderAuth(provider, raw), {
        vault,
        authDirectory: config.providerAuthDirectory,
      });
      const status = await providerManager.probe(provider);
      return { ...imported, provider: status };
    },
  };
  const publicServer = http.createServer(createCloudHttpHandler(services));
  const workerServer = http.createServer(createCloudHttpHandler(services, { workerOnly: true }));
  publicServer.requestTimeout = 30_000;
  publicServer.headersTimeout = 10_000;
  workerServer.requestTimeout = 30_000;
  workerServer.headersTimeout = 10_000;

  let lifecycle = 'idle';
  let startPromise = null;
  let stopPromise = null;
  let startResult = null;
  let databaseClosed = false;

  const assertStarting = () => {
    if (lifecycle !== 'starting') {
      throw runtimeLifecycleError('Cloud runtime stopped during startup', 'RUNTIME_STOPPING');
    }
  };

  const removeWorkerSocket = () => {
    if (config.workerControlMode === 'socket' && existsSync(config.workerControlSocket)) {
      unlinkSync(config.workerControlSocket);
    }
  };

  const reportCleanupFailure = (event, step, error) => {
    try {
      logger.error(event, {
        step, code: error?.code, message: error?.message ?? String(error), details: error?.details,
      });
    } catch {
      // Cleanup cannot depend on the durable logger remaining writable.
    }
  };

  const rollbackStart = async () => {
    const rollbackStep = async (step, action) => {
      try { await action(); } catch (error) {
        reportCleanupFailure('runtime.start_rollback_failed', step, error);
      }
    };
    // Stop new public work before draining schedulers and workers.
    await rollbackStep('public_server', () => close(publicServer));
    await rollbackStep('scheduler', () => scheduler.stop());
    // Revoke worker processes before removing their authenticated control path.
    await rollbackStep('workers', async () => runner.stopAll?.());
    await rollbackStep('display', async () => displayFrameStore.closeAll());
    await rollbackStep('worker_server', () => close(workerServer));
    await rollbackStep('worker_socket', async () => removeWorkerSocket());
  };

  const stopStep = async (failures, step, operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push({ step, error });
      reportCleanupFailure('runtime.stop_step_failed', step, error);
    }
  };

  return {
    database,
    identity,
    auth,
    blobStore,
    displayFrameStore,
    sessionStore,
    logger,
    providerManager,
    scheduler,
    publicServer,
    workerServer,
    async start() {
      if (lifecycle === 'running') return startResult;
      if (stopPromise || lifecycle === 'stopping' || lifecycle === 'stopped') {
        throw runtimeLifecycleError('Cloud runtime cannot start after shutdown begins', 'RUNTIME_STOPPED');
      }
      if (startPromise) return startPromise;
      lifecycle = 'starting';
      let operation;
      operation = (async () => {
        try {
          auth.prune();
          logger.prune();
          await blobStore.pruneStaleUploads();
          assertStarting();
          if (config.workerControlMode === 'socket') {
            removeWorkerSocket();
            await listen(workerServer, config.workerControlSocket);
            assertStarting();
            await chmod(config.workerControlSocket, 0o600);
            assertStarting();
            // local 실행에서는 워커가 다른 uid이므로 소켓 소유자를 워커로 옮긴다. 인증은 세션별 워커 토큰이 한다.
            if (config.runner === 'local' && config.workerUid !== null) {
              await chmod(config.workerControlDirectory, 0o711);
              assertStarting();
              await chown(config.workerControlSocket, config.workerUid, config.workerGid ?? config.workerUid);
              assertStarting();
            }
            scheduler.controlEndpoint = { socketPath: config.workerControlSocket };
          } else {
            await listen(workerServer, 0, '127.0.0.1');
            assertStarting();
            const address = workerServer.address();
            if (!address || typeof address === 'string') throw new Error('Worker control endpoint did not bind to TCP');
            scheduler.controlEndpoint = {
              baseUrl: `http://host.containers.internal:${address.port}`,
              hostUrl: `http://127.0.0.1:${address.port}`,
            };
            await runner.probeControl?.(scheduler.controlEndpoint);
            assertStarting();
          }
          await listen(publicServer, config.port, config.host);
          assertStarting();
          await providerManager.probeAll(config.startupProviders);
          assertStarting();
          await scheduler.start();
          assertStarting();
          startResult = {
            endpoint: `http://${config.host}:${config.port}${config.basePath}`,
            workerControlSocket: scheduler.controlEndpoint.socketPath ?? null,
            workerControlUrl: scheduler.controlEndpoint.hostUrl ?? null,
            serverPublicKey: identity.serverPublicKey,
          };
          lifecycle = 'running';
          return startResult;
        } catch (error) {
          if (lifecycle === 'starting') {
            await rollbackStart();
            if (lifecycle === 'starting') lifecycle = 'idle';
          }
          throw error;
        } finally {
          if (startPromise === operation) startPromise = null;
        }
      })();
      startPromise = operation;
      return operation;
    },
    async stop() {
      if (stopPromise) return stopPromise;
      lifecycle = 'stopping';
      const pendingStart = startPromise;
      stopPromise = (async () => {
        await pendingStart?.catch(() => {});
        const failures = [];
        // Reject new control requests first. Keep the worker endpoint open
        // until every sandbox has stopped or reported a cleanup failure.
        await stopStep(failures, 'public_server', () => close(publicServer));
        await stopStep(failures, 'scheduler', () => scheduler.stop());
        // Kill every worker before the control socket disappears so detached
        // workers cannot survive a restart and double-execute their session.
        await stopStep(failures, 'workers', async () => runner.stopAll?.());
        await stopStep(failures, 'raucloud_lease', () => raucloudLease.release('CONTROL_PLANE_SHUTDOWN'));
        await stopStep(failures, 'display', async () => displayFrameStore.closeAll());
        await stopStep(failures, 'worker_server', () => close(workerServer));
        await stopStep(failures, 'worker_socket', async () => removeWorkerSocket());
        if (!databaseClosed) {
          databaseClosed = true;
          await stopStep(failures, 'database', async () => database.close());
        }
        lifecycle = 'stopped';
        startResult = null;
        if (failures.length) {
          throw Object.assign(
            new AggregateError(failures.map(({ error }) => error), 'Cloud runtime shutdown failed'),
            {
              code: 'RUNTIME_STOP_FAILED',
              retryable: false,
              details: { failedSteps: failures.map(({ step }) => step) },
            },
          );
        }
      })();
      return stopPromise;
    },
  };
}

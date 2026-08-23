import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import http from 'node:http';
import { AuthService } from './auth.mjs';
import { BlobStore } from './blob-store.mjs';
import { openDatabase } from './database.mjs';
import { createCloudHttpHandler } from './http-server.mjs';
import { loadOrCreateServerIdentity } from './identity.mjs';
import { PodmanRunner } from './podman-runner.mjs';
import { ProviderManager } from './provider-manager.mjs';
import { RedactedLogger } from './redacted-logger.mjs';
import { Scheduler } from './scheduler.mjs';
import { SecretVault } from './secret-vault.mjs';
import { SessionStore } from './session-store.mjs';

function listen(server, target, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(target, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export function createCloudRuntime(config, dependencies = {}) {
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(config.workerControlDirectory, { recursive: true, mode: 0o700 });
  const database = dependencies.database ?? openDatabase(config.databasePath);
  const identity = dependencies.identity ?? loadOrCreateServerIdentity(config.dataDirectory);
  const blobStore = dependencies.blobStore ?? new BlobStore(database, { root: config.blobDirectory });
  const auth = dependencies.auth ?? new AuthService(database, { retrySecret: identity.privateKey });
  const sessionStore = dependencies.sessionStore ?? new SessionStore(database, blobStore, {
    maxQueuedSessions: config.maxQueuedSessions,
  });
  const logger = dependencies.logger ?? new RedactedLogger(database);
  const vault = dependencies.vault ?? new SecretVault(database, { dataDirectory: config.dataDirectory });
  const providerManager = dependencies.providerManager ?? new ProviderManager(sessionStore, {
    providerAuthDirectory: config.providerAuthDirectory,
    providerCliDirectory: config.providerCliDirectory,
    vault,
  });
  const runner = dependencies.runner ?? new PodmanRunner(config);
  const scheduler = dependencies.scheduler ?? new Scheduler(sessionStore, runner, {
    logger,
    maxRunningSessions: config.maxRunningSessions,
    controlSocket: config.workerControlSocket,
    dataDirectory: config.dataDirectory,
    maintenance: async () => {
      auth.prune();
      logger.prune();
      await blobStore.pruneStaleUploads();
    },
  });
  const services = { auth, blobStore, sessionStore, identity, config, logger, vault };
  const publicServer = http.createServer(createCloudHttpHandler(services));
  const workerServer = http.createServer(createCloudHttpHandler(services, { workerOnly: true }));
  publicServer.requestTimeout = 30_000;
  publicServer.headersTimeout = 10_000;
  workerServer.requestTimeout = 30_000;
  workerServer.headersTimeout = 10_000;

  return {
    database,
    identity,
    auth,
    blobStore,
    sessionStore,
    logger,
    providerManager,
    scheduler,
    publicServer,
    workerServer,
    async start() {
      auth.prune();
      logger.prune();
      await blobStore.pruneStaleUploads();
      if (existsSync(config.workerControlSocket)) unlinkSync(config.workerControlSocket);
      await listen(workerServer, config.workerControlSocket);
      await chmod(config.workerControlSocket, 0o600);
      await listen(publicServer, config.port, config.host);
      await providerManager.probeAll();
      await scheduler.start();
      return {
        endpoint: `http://${config.host}:${config.port}${config.basePath}`,
        workerControlSocket: config.workerControlSocket,
        serverPublicKey: identity.serverPublicKey,
      };
    },
    async stop() {
      await scheduler.stop();
      await Promise.allSettled([close(publicServer), close(workerServer)]);
      if (existsSync(config.workerControlSocket)) unlinkSync(config.workerControlSocket);
      database.close();
    },
  };
}

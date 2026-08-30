import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PORT,
  assertCreditsEnv,
  resolveCreditsDbPath,
  resolveCreditsOrigin,
} from './config.mjs';
import { creditsRequestListener, createCreditsService } from './service.mjs';
import { createRailwayCloudProvisioner, railwayCloudConfigFromEnv } from './cloud-provisioner.mjs';
import { createFileStore, createPostgresStore } from './store.mjs';

export async function createCreditsHttpServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const origin = options.origin ?? resolveCreditsOrigin(process.env, port);
  const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET;
  if (!sessionSecret) throw new Error('SESSION_SECRET is required');
  const dbPath = options.dbPath ?? resolveCreditsDbPath();
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? '';
  const store = options.store ?? (databaseUrl
    ? await createPostgresStore({ connectionString: databaseUrl, legacyFilePath: dbPath })
    : createFileStore(dbPath));
  const service = createCreditsService({
    origin,
    sessionSecret,
    workosApiKey: options.workosApiKey ?? process.env.WORKOS_API_KEY ?? '',
    workosClientId: options.workosClientId ?? process.env.WORKOS_CLIENT_ID ?? '',
    openRouterProvisioningKey: options.openRouterProvisioningKey ?? process.env.OPENROUTER_PROVISIONING_KEY ?? '',
    cloudWorkerSecret: options.cloudWorkerSecret ?? process.env.CLOUD_WORKER_SECRET ?? '',
    cloudProvisioner: options.cloudProvisioner === undefined
      ? createRailwayCloudProvisioner({
        fetchImpl: options.fetchImpl,
        config: { ...railwayCloudConfigFromEnv(), brokerUrl: origin },
      })
      : options.cloudProvisioner,
    cloudProvisionerRequired: options.cloudProvisionerRequired ?? true,
    store,
    fetchImpl: options.fetchImpl,
    now: options.now,
    authenticateWorkos: options.authenticateWorkos,
    createOpenRouterKey: options.createOpenRouterKey,
  });
  const server = http.createServer(creditsRequestListener(service));
  const reconcileTimer = setInterval(() => {
    void service.reconcileCloudUsage().catch((error) => {
      process.stderr.write(`[rau-credits] Raucloud reconcile failed: ${error?.message ?? error}\n`);
    });
  }, 30_000);
  reconcileTimer.unref();
  server.once('close', () => {
    clearInterval(reconcileTimer);
    void store.close?.();
  });
  const legacyTimer = setInterval(() => {
    void service.reconcileLegacyCloud().catch((error) => {
      process.stderr.write(`[rau-credits] legacy Cloud reconcile failed: ${error?.message ?? error}\n`);
    });
  }, 60 * 60 * 1000);
  legacyTimer.unref();
  server.once('close', () => clearInterval(legacyTimer));
  void service.reconcileLegacyCloud().catch((error) => {
    process.stderr.write(`[rau-credits] initial legacy Cloud reconcile failed: ${error?.message ?? error}\n`);
  });
  return { server, service, origin, dbPath: databaseUrl ? 'postgresql' : dbPath };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  assertCreditsEnv();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const { server, service, origin, dbPath } = await createCreditsHttpServer({ port });
  await service.migrateLegacyKeys();
  server.listen(port, '0.0.0.0', () => {
    process.stderr.write(`[rau-credits] listening on 0.0.0.0:${port} origin=${origin} db=${dbPath}\n`);
  });
}

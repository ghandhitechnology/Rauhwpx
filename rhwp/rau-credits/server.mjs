import http from 'node:http';
import path from 'node:path';

import {
  DEFAULT_PORT,
  assertCreditsEnv,
  resolveCreditsDbPath,
  resolveCreditsOrigin,
} from './config.mjs';
import { creditsRequestListener, createCreditsService } from './service.mjs';
import { createFileStore } from './store.mjs';

export function createCreditsHttpServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const origin = options.origin ?? resolveCreditsOrigin(process.env, port);
  const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET;
  if (!sessionSecret) throw new Error('SESSION_SECRET is required');
  const dbPath = options.dbPath ?? resolveCreditsDbPath();
  const service = createCreditsService({
    origin,
    sessionSecret,
    workosApiKey: options.workosApiKey ?? process.env.WORKOS_API_KEY ?? '',
    workosClientId: options.workosClientId ?? process.env.WORKOS_CLIENT_ID ?? '',
    openRouterProvisioningKey: options.openRouterProvisioningKey ?? process.env.OPENROUTER_PROVISIONING_KEY ?? '',
    store: options.store ?? createFileStore(dbPath),
    fetchImpl: options.fetchImpl,
    now: options.now,
    authenticateWorkos: options.authenticateWorkos,
    createOpenRouterKey: options.createOpenRouterKey,
  });
  const server = http.createServer(creditsRequestListener(service));
  return { server, service, origin, dbPath };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isMain) {
  assertCreditsEnv();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const { server, origin, dbPath } = createCreditsHttpServer({ port });
  server.listen(port, '0.0.0.0', () => {
    process.stderr.write(`[rau-credits] listening on 0.0.0.0:${port} origin=${origin} db=${dbPath}\n`);
  });
}

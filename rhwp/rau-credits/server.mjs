import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PORT,
  assertCreditsEnv,
  resolveCreditsDbPath,
  resolveCreditsOrigin,
  resolveUniqueInstallsDbPath,
} from './config.mjs';
import { creditsRequestListener, createCreditsService } from './service.mjs';
import { createFileStore } from './store.mjs';
import {
  createUniqueInstallsService,
  emptyUniqueInstallsState,
} from './unique-installs.mjs';

export function createCreditsHttpServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const origin = options.origin ?? resolveCreditsOrigin(process.env, port);
  const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET;
  if (!sessionSecret) throw new Error('SESSION_SECRET is required');
  const dbPath = options.dbPath ?? resolveCreditsDbPath();
  const uniqueInstallsDbPath = options.uniqueInstallsDbPath ?? resolveUniqueInstallsDbPath();
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
    authenticateMagic: options.authenticateMagic,
    sendMagicAuth: options.sendMagicAuth,
    createOpenRouterKey: options.createOpenRouterKey,
    minDeviceProtocol: options.minDeviceProtocol
      ?? Number(process.env.RAU_MIN_DEVICE_PROTOCOL ?? 1),
  });
  const uniqueInstalls = createUniqueInstallsService({
    store: options.uniqueInstallsStore ?? createFileStore(uniqueInstallsDbPath, {
      emptyState: emptyUniqueInstallsState,
    }),
    now: options.now,
  });
  const listener = creditsRequestListener(service, { uniqueInstalls });
  const server = http.createServer((req, res) => {
    void Promise.resolve(listener(req, res)).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
      }
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'RAU_CREDITS_FAILED' }));
    });
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } else {
      socket.destroy();
    }
  });
  return { server, service, uniqueInstalls, origin, dbPath, uniqueInstallsDbPath };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  assertCreditsEnv();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const { server, origin, dbPath } = createCreditsHttpServer({ port });
  server.listen(port, '0.0.0.0', () => {
    process.stderr.write(`[rau-credits] listening on 0.0.0.0:${port} origin=${origin} db=${dbPath}\n`);
  });
}

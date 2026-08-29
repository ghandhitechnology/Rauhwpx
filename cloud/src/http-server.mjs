import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import {
  CloudError,
  DEFAULT_LIMITS,
  PROTOCOL_VERSION,
  TRANSFER_LIMITS,
  parseCommand,
  parseDownloadConfirmation,
  parsePairingCreate,
  parsePairingRedeem,
  parseRefresh,
  parseSessionCreate,
  parseUploadInit,
} from './protocol.mjs';
import { SERVICE_VERSION } from './version.mjs';
import { parseProviderCredentialBody } from './provider-credentials.mjs';
import {
  SSE_STREAM_DIGEST,
  SSE_STREAM_PROTOCOL,
  createResponseProof,
  parseProofNonce,
  responseProofHeaders,
  sha256Hex,
  signedSseFrame,
} from './response-proof.mjs';

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
const responseProof = Symbol('rauhwpxResponseProof');

function bearer(request) {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length);
}

async function readBytes(request, maximum) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maximum) throw new CloudError('REQUEST_TOO_LARGE', 'Request body is too large', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new CloudError('REQUEST_TOO_LARGE', 'Request body is too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request) {
  const bytes = await readBytes(request, MAX_JSON_BYTES);
  if (bytes.length === 0) return {};
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new CloudError('INVALID_JSON', 'Request body must be valid JSON'); }
}

function json(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    ...responseProofHeaders(response[responseProof], status, sha256Hex(bytes)),
  });
  response.end(bytes);
}

function normalizePath(pathname, basePath) {
  if (pathname === basePath) return '/';
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return pathname;
}

function errorBody(error) {
  return {
    error: {
      code: error.code ?? 'INTERNAL_ERROR',
      // CloudError messages are hand-written for clients; unexpected faults
      // stay generic so internals never leak.
      message: error instanceof CloudError ? error.message : 'Cloud service failed',
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

function positiveSequence(value, label = 'after') {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CloudError('INVALID_REQUEST', `${label} must be a non-negative integer`);
  }
  return parsed;
}

function writeSse(response, event) {
  response.write(signedSseFrame(response[responseProof], event));
}

function applyBrowserCors(request, response, allowedOrigins = []) {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) return false;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Last-Event-ID, X-Rauhwpx-Request-Nonce, X-Upload-Offset',
  );
  response.setHeader(
    'Access-Control-Expose-Headers',
    [
      'Content-Length',
      'Content-Disposition',
      'X-Boundary-Operation',
      'X-Boundary-Kind',
      'X-Boundary-Revision',
      'X-Boundary-Turn',
      'X-Checkpoint-Revision',
      'X-Checkpoint-Turn',
      'X-Content-SHA256',
      'X-Document-Name',
      'X-Rauhwpx-Content-SHA256',
      'X-Rauhwpx-Response-Signature',
      'X-Rauhwpx-Server-Key',
      'X-Rauhwpx-Stream-Protocol',
    ].join(', '),
  );
  return true;
}

export function createCloudHttpHandler({
  auth,
  blobStore,
  sessionStore,
  identity,
  config,
  logger,
  vault,
  applyProviderAuth = null,
  seedProvider,
}, { workerOnly = false } = {}) {
  const authenticate = (request) => auth.authenticate(bearer(request));
  const authenticateWorker = (request, sessionId, options) => (
    sessionStore.authenticateWorker(sessionId, bearer(request), options)
  );

  return async function cloudHttpHandler(request, response) {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host || '127.0.0.1'}`);
    const pathname = normalizePath(requestUrl.pathname, config.basePath);
    const browserCors = !workerOnly && pathname.startsWith('/v1')
      ? applyBrowserCors(request, response, config.browserOrigins)
      : false;
    if (pathname.startsWith('/v1')) {
      response.setHeader('X-Rauhwpx-Server-Key', identity.serverPublicKey);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
    }
    try {
      if (request.method === 'OPTIONS' && pathname.startsWith('/v1')) {
        if (!browserCors) throw new CloudError('ORIGIN_NOT_ALLOWED', 'Browser origin is not allowed', 403);
        response.writeHead(204, { 'Content-Length': '0', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (!workerOnly && pathname.startsWith('/v1')) {
        const bootstrapHealth = request.method === 'GET' && pathname === '/v1/health';
        const nonce = parseProofNonce(request.headers['x-rauhwpx-request-nonce'], { required: !bootstrapHealth });
        if (nonce) {
          const externalPathAndQuery = `${config.basePath}${pathname}${requestUrl.search}`;
          response[responseProof] = createResponseProof(identity, request, nonce, externalPathAndQuery);
        }
      }
      if (request.method === 'GET' && pathname === '/v1/health') {
        json(response, 200, {
          ok: true,
          version: SERVICE_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          serverPublicKey: identity.serverPublicKey,
          serverId: identity.serverId,
        });
        return;
      }
      if (request.method === 'POST' && pathname === '/v1/pairing/bootstrap') {
        const input = parsePairingCreate(await readJson(request));
        json(response, 201, {
          ...auth.issueBootstrapPairing({ token: bearer(request), deviceName: input.deviceName }),
          serverPublicKey: identity.serverPublicKey,
          serverId: identity.serverId,
          protocolVersion: PROTOCOL_VERSION,
          version: SERVICE_VERSION,
        });
        return;
      }
      if (request.method === 'POST' && pathname === '/v1/pairing/redeem') {
        json(response, 200, auth.redeemPairingCode(parsePairingRedeem(await readJson(request))));
        return;
      }
      if (request.method === 'POST' && pathname === '/v1/token/refresh') {
        json(response, 200, auth.refresh(parseRefresh(await readJson(request)).refreshToken));
        return;
      }

      const internal = pathname.match(/^\/v1\/internal\/worker\/([^/]+)(\/.*)?$/);
      if (internal) {
        if (!workerOnly) throw new CloudError('NOT_FOUND', 'Endpoint was not found', 404);
        const sessionId = decodeURIComponent(internal[1]);
        const action = internal[2] ?? '';
        const session = authenticateWorker(request, sessionId, {
          allowCompletedResultRetry: request.method === 'POST' && action === '/result',
        });
        if (request.method === 'POST' && action === '/heartbeat') {
          json(response, 200, { ok: sessionStore.heartbeat(sessionId) });
          return;
        }
        if (request.method === 'POST' && action === '/events') {
          const body = await readJson(request);
          if (typeof body.type !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(body.type)) {
            throw new CloudError('INVALID_REQUEST', 'event type is invalid');
          }
          if (Buffer.byteLength(JSON.stringify(body.payload ?? {})) > MAX_EVENT_PAYLOAD_BYTES) {
            throw new CloudError('EVENT_TOO_LARGE', 'Worker event payload exceeds 64 KiB', 413);
          }
          json(response, 201, sessionStore.appendEvent(sessionId, body.type, body.payload ?? {}));
          return;
        }
        if (request.method === 'GET' && action === '/messages') {
          json(response, 200, {
            messages: sessionStore.takeQueuedMessages(sessionId),
            control: sessionStore.workerControl(sessionId),
          });
          return;
        }
        if (request.method === 'GET' && action === '/control') {
          json(response, 200, sessionStore.workerControl(sessionId));
          return;
        }
        const workerWait = action.match(/^\/waits\/([^/]+)$/);
        if (request.method === 'GET' && workerWait) {
          json(response, 200, sessionStore.waitState(sessionId, decodeURIComponent(workerWait[1])));
          return;
        }
        if (request.method === 'POST' && action === '/waits') {
          const body = await readJson(request);
          json(response, 201, sessionStore.createWait(sessionId, {
            turnNumber: body.turnNumber,
            kind: body.kind,
            payload: body.payload ?? {},
          }));
          return;
        }
        if (request.method === 'POST' && action === '/pause-ack') {
          json(response, 200, sessionStore.acknowledgePause(sessionId));
          return;
        }
        if (request.method === 'POST' && action === '/sleep-ack') {
          json(response, 200, sessionStore.acknowledgeSleep(sessionId));
          return;
        }
        if (request.method === 'POST' && action === '/takeover-ack') {
          json(response, 200, sessionStore.acknowledgeTakeover(sessionId));
          return;
        }
        if (request.method === 'POST' && action === '/finish-claim') {
          json(response, 200, sessionStore.claimFinish(sessionId));
          return;
        }
        if (request.method === 'GET' && action === '/manifest') {
          json(response, 200, sessionStore.workerManifest(sessionId));
          return;
        }
        if (request.method === 'GET' && action === '/credentials') {
          const credentials = Object.fromEntries(
            vault.list()
              .filter((credential) => credential.provider === session.provider)
              .map((credential) => [credential.name, vault.get(credential.provider, credential.name)]),
          );
          json(response, 200, { provider: session.provider, credentials });
          return;
        }
        if (request.method === 'POST' && action === '/uploads/init') {
          const input = parseUploadInit({ ...(await readJson(request)), sessionId });
          json(response, 200, await blobStore.initUpload({ deviceId: session.origin_device_id, ...input }));
          return;
        }
        const workerChunk = action.match(/^\/uploads\/([^/]+)\/chunks$/);
        if (request.method === 'POST' && workerChunk) {
          const offset = positiveSequence(request.headers['x-upload-offset'], 'x-upload-offset');
          const bytes = await readBytes(request, TRANSFER_LIMITS.chunkBytes);
          json(response, 200, await blobStore.appendChunk({
            uploadId: workerChunk[1], deviceId: session.origin_device_id, offset, bytes,
          }));
          return;
        }
        const workerBlob = action.match(/^\/blobs\/([a-f0-9]{64})$/);
        if (request.method === 'GET' && workerBlob) {
          const allowed = sessionStore.workerCanReadBlob(sessionId, workerBlob[1]);
          if (!allowed) throw new CloudError('BLOB_NOT_FOUND', 'Blob is not part of this session', 404);
          const { blob, stream } = blobStore.openReadStream(workerBlob[1]);
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': blob.size,
            'X-Content-SHA256': blob.sha256,
            'Cache-Control': 'no-store',
            ...responseProofHeaders(response[responseProof], 200, blob.sha256),
          });
          await pipeline(stream, response);
          return;
        }
        if (request.method === 'POST' && action === '/checkpoints') {
          const body = await readJson(request);
          json(response, 201, sessionStore.recordCheckpoint(sessionId, {
            operationId: String(body.operationId ?? ''),
            turnNumber: Number(body.turnNumber),
            revision: Number(body.revision),
            blobId: String(body.blobId ?? ''),
            stable: Boolean(body.stable),
          }));
          return;
        }
        if (request.method === 'POST' && action === '/boundary') {
          const body = await readJson(request);
          json(response, 201, await sessionStore.commitBoundary(sessionId, {
            operationId: body.operationId,
            turnNumber: body.turnNumber,
            revision: body.revision,
            kind: body.kind,
            checkpoint: {
              blobId: body.checkpoint?.blobId,
              size: body.checkpoint?.size,
            },
            timeline: {
              blobId: body.timeline?.blobId,
              size: body.timeline?.size,
            },
          }));
          return;
        }
        if (request.method === 'POST' && action === '/turn-start') {
          const body = await readJson(request);
          json(response, 201, sessionStore.beginTurn(sessionId, {
            turnNumber: body.turnNumber,
            messageId: body.messageId ?? null,
            mode: body.mode,
          }));
          return;
        }
        if (request.method === 'POST' && action === '/turn-complete') {
          const body = await readJson(request);
          json(response, 200, sessionStore.completeTurn(sessionId, {
            outcome: body.outcome,
            boundaryOperationId: body.boundaryOperationId ?? null,
          }));
          return;
        }
        if (request.method === 'POST' && action === '/result') {
          const body = await readJson(request);
          json(response, 200, sessionStore.publishResult(sessionId, { blobId: body.blobId, size: body.size }));
          return;
        }
        if (request.method === 'POST' && action === '/timeline') {
          const body = await readJson(request);
          json(response, 200, await sessionStore.publishTimeline(sessionId, { blobId: body.blobId, size: body.size }));
          return;
        }
        if (request.method === 'POST' && action === '/suspend') {
          const body = await readJson(request);
          json(response, 200, sessionStore.suspend(sessionId, {
            code: String(body.code || 'WORKER_SUSPENDED').slice(0, 64),
            message: String(body.message || 'Worker suspended').slice(0, 1024),
          }));
          return;
        }
        throw new CloudError('NOT_FOUND', 'Worker endpoint was not found', 404);
      }

      if (workerOnly) throw new CloudError('NOT_FOUND', 'Worker endpoint was not found', 404);

      const device = authenticate(request);
      if (request.method === 'GET' && pathname === '/v1/profile') {
        json(response, 200, {
          server: { id: identity.serverId, publicKey: identity.serverPublicKey, protocolVersion: PROTOCOL_VERSION },
          device,
          devices: auth.listDevices(),
          providers: sessionStore.listProviderStatus(),
          limits: {
            maxRunningSessions: config.maxRunningSessions,
            maxQueuedSessions: config.maxQueuedSessions,
            defaultDurationSeconds: DEFAULT_LIMITS.maxDurationSeconds,
            defaultTurns: DEFAULT_LIMITS.maxTurns,
          },
        });
        return;
      }
      if (request.method === 'POST' && pathname === '/v1/pairing') {
        const input = parsePairingCreate(await readJson(request));
        json(response, 201, auth.createPairingCode({ createdByDeviceId: device.id, intendedName: input.deviceName }));
        return;
      }
      const providerCredentials = pathname.match(/^\/v1\/providers\/([^/]+)\/credentials$/);
      if (request.method === 'POST' && providerCredentials) {
        if (typeof seedProvider !== 'function') throw new CloudError('NOT_FOUND', 'Endpoint was not found', 404);
        const input = parseProviderCredentialBody(decodeURIComponent(providerCredentials[1]), await readJson(request));
        json(response, 200, await seedProvider(input));
        return;
      }
      if (request.method === 'GET' && pathname === '/v1/sessions') {
        json(response, 200, { sessions: sessionStore.listSessions() });
        return;
      }
      if (request.method === 'POST' && pathname === '/v1/sessions') {
        json(response, 201, sessionStore.createSession(device, parseSessionCreate(await readJson(request))));
        return;
      }
      const providerAuthRoute = pathname.match(/^\/v1\/providers\/([^/]+)\/auth$/);
      if (request.method === 'PUT' && providerAuthRoute) {
        if (typeof applyProviderAuth !== 'function') {
          throw new CloudError('AUTH_IMPORT_UNAVAILABLE', 'This VPS cannot import provider credentials', 501);
        }
        json(response, 200, await applyProviderAuth(decodeURIComponent(providerAuthRoute[1]), await readJson(request)));
        return;
      }
      const sessionRoute = pathname.match(/^\/v1\/sessions\/([^/]+)(\/events|\/commands|\/timeline|\/checkpoint|\/takeover)?$/);
      if (sessionRoute) {
        const sessionId = decodeURIComponent(sessionRoute[1]);
        if (request.method === 'GET' && !sessionRoute[2]) {
          json(response, 200, sessionStore.getSession(sessionId));
          return;
        }
        if (request.method === 'POST' && sessionRoute[2] === '/commands') {
          json(response, 200, sessionStore.executeCommand(device, sessionId, parseCommand(await readJson(request))));
          return;
        }
        if (request.method === 'GET' && sessionRoute[2] === '/timeline') {
          const timeline = sessionStore.currentTimeline(sessionId);
          const { blob, stream } = blobStore.openReadStream(timeline.blobId);
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': blob.size,
            'X-Content-SHA256': blob.sha256,
            ...(timeline.revision === undefined ? {} : {
              'X-Boundary-Operation': timeline.operationId,
              'X-Boundary-Revision': String(timeline.revision),
              'X-Boundary-Turn': String(timeline.turnNumber),
            }),
            'Cache-Control': 'no-store',
            ...responseProofHeaders(response[responseProof], 200, blob.sha256),
          });
          await pipeline(stream, response);
          return;
        }
        if (request.method === 'GET' && sessionRoute[2] === '/checkpoint') {
          const operationId = requestUrl.searchParams.get('operationId');
          const checkpoint = sessionStore.latestStableCheckpoint(sessionId, operationId || null);
          const { blob, stream } = blobStore.openReadStream(checkpoint.blobId);
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': blob.size,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(checkpoint.name)}`,
            'X-Content-SHA256': blob.sha256,
            'X-Document-Name': encodeURIComponent(checkpoint.name),
            'X-Checkpoint-Revision': String(checkpoint.revision),
            'X-Checkpoint-Turn': String(checkpoint.turnNumber),
            'X-Boundary-Operation': checkpoint.operationId,
            'X-Boundary-Kind': checkpoint.kind,
            'Cache-Control': 'no-store',
            ...responseProofHeaders(response[responseProof], 200, blob.sha256),
          });
          await pipeline(stream, response);
          return;
        }
        if (request.method === 'GET' && sessionRoute[2] === '/takeover') {
          json(response, 200, sessionStore.takeoverState(sessionId));
          return;
        }
        if (request.method === 'GET' && sessionRoute[2] === '/events') {
          sessionStore.getSessionRow(sessionId);
          const presenceConnectionId = randomUUID();
          sessionStore.openPresence(sessionId, device.id, presenceConnectionId);
          const after = positiveSequence(requestUrl.searchParams.get('after') ?? request.headers['last-event-id']);
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'X-Rauhwpx-Stream-Protocol': SSE_STREAM_PROTOCOL,
            ...responseProofHeaders(response[responseProof], 200, SSE_STREAM_DIGEST),
          });
          let cursor = after;
          let following = false;
          const pending = [];
          const deliver = (event) => {
            if (!following) {
              pending.push(event);
              return;
            }
            if (event.seq <= cursor) return;
            writeSse(response, event);
            cursor = event.seq;
          };
          const unsubscribe = sessionStore.subscribe(sessionId, deliver);
          while (true) {
            const replay = sessionStore.listEvents(sessionId, cursor);
            for (const event of replay) {
              writeSse(response, event);
              cursor = event.seq;
            }
            if (replay.length < 1000) break;
          }
          following = true;
          pending.sort((left, right) => left.seq - right.seq);
          for (const event of pending) deliver(event);
          const keepalive = setInterval(() => {
            sessionStore.touchPresence(sessionId, device.id, presenceConnectionId);
            response.write(': keepalive\n\n');
          }, 15_000);
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            clearInterval(keepalive);
            unsubscribe();
            // A process/test shutdown may close SQLite before Node delivers
            // the socket's final close notification. Presence is advisory;
            // stale rows are expired by the idle sweep on the next startup.
            try {
              sessionStore.closePresence(sessionId, device.id, presenceConnectionId);
            } catch (error) {
              if (error?.code !== 'ERR_INVALID_STATE') throw error;
            }
          };
          request.once('close', close);
          response.once('close', close);
          return;
        }
      }
      if (request.method === 'POST' && pathname === '/v1/uploads/init') {
        json(response, 200, await blobStore.initUpload({ deviceId: device.id, ...parseUploadInit(await readJson(request)) }));
        return;
      }
      const chunkRoute = pathname.match(/^\/v1\/uploads\/([^/]+)\/chunks$/);
      if (request.method === 'POST' && chunkRoute) {
        const offset = positiveSequence(request.headers['x-upload-offset'], 'x-upload-offset');
        const bytes = await readBytes(request, TRANSFER_LIMITS.chunkBytes);
        json(response, 200, await blobStore.appendChunk({ uploadId: chunkRoute[1], deviceId: device.id, offset, bytes }));
        return;
      }
      const resultRoute = pathname.match(/^\/v1\/results\/([^/]+)(\/download-confirmed)?$/);
      if (resultRoute) {
        const sessionId = decodeURIComponent(resultRoute[1]);
        if (request.method === 'GET' && !resultRoute[2]) {
          const session = sessionStore.getSessionRow(sessionId);
          if (session.origin_device_id !== device.id) {
            throw new CloudError('ORIGIN_DEVICE_REQUIRED', 'Only the origin device can download the result', 403);
          }
          if (session.status !== 'completed' || !session.result_sha256) throw new CloudError('RESULT_NOT_READY', 'Result is not ready', 409);
          const { blob, stream } = blobStore.openReadStream(session.result_sha256);
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': blob.size,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(session.origin_name)}`,
            'X-Content-SHA256': blob.sha256,
            'X-Document-Name': encodeURIComponent(session.origin_name),
            'Cache-Control': 'no-store',
            ...responseProofHeaders(response[responseProof], 200, blob.sha256),
          });
          await pipeline(stream, response);
          return;
        }
        if (request.method === 'POST' && resultRoute[2] === '/download-confirmed') {
          json(response, 200, await sessionStore.confirmResultDownloaded(
            device,
            sessionId,
            parseDownloadConfirmation(await readJson(request)),
          ));
          return;
        }
      }
      throw new CloudError('NOT_FOUND', 'Endpoint was not found', 404);
    } catch (error) {
      const status = error.status ?? 500;
      // Routine client errors (expired tokens, retries) must not bury real
      // faults, so only 5xx land at error level.
      const entry = status >= 500
        ? { level: 'error', event: 'http.request_failed' }
        : { level: 'info', event: 'http.request_rejected' };
      const log = logger?.[entry.level];
      if (typeof log === 'function') {
        log.call(logger, entry.event, {
          method: request.method,
          pathname,
          code: error.code,
          message: error.message,
        });
      }
      if (!response.headersSent) json(response, error.status ?? 500, errorBody(error));
      else response.destroy();
    }
  };
}

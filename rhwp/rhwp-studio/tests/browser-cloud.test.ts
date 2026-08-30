import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { __test as browserCloudTest, createBrowserCloudApi } from '../src/cloud/browser-cloud.ts';

class MemoryStorage implements Storage {
  #values = new Map<string, string>();
  get length() { return this.#values.size; }
  clear() { this.#values.clear(); }
  getItem(key: string) { return this.#values.get(key) ?? null; }
  key(index: number) { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string) { this.#values.delete(key); }
  setItem(key: string, value: string) { this.#values.set(key, value); }
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function serverIdentity() {
  const pair = generateKeyPairSync('ed25519');
  return {
    pair,
    key: `ed25519:${pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`,
  };
}

function signedJson(
  request: Request,
  identity: ReturnType<typeof serverIdentity>,
  body: unknown,
  status = 200,
): Response {
  const bytes = Buffer.from(JSON.stringify(body));
  const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
  const url = new URL(request.url);
  const contentDigest = digest(bytes);
  const canonical = `RAUHWpx-response-v1\n${nonce}\n${request.method}\n${url.pathname}${url.search}\n${status}\n${contentDigest}`;
  return new Response(bytes, {
    status,
    headers: {
      'content-type': 'application/json',
      'x-rauhwpx-server-key': identity.key,
      'x-rauhwpx-content-sha256': contentDigest,
      'x-content-sha256': contentDigest,
      'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), identity.pair.privateKey).toString('base64url'),
    },
  });
}

function signedBytes(
  request: Request,
  identity: ReturnType<typeof serverIdentity>,
  bytes: Uint8Array,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
  const url = new URL(request.url);
  const contentDigest = digest(bytes);
  const canonical = `RAUHWpx-response-v1\n${nonce}\n${request.method}\n${url.pathname}${url.search}\n${status}\n${contentDigest}`;
  return new Response(bytes, {
    status,
    headers: {
      'x-rauhwpx-server-key': identity.key,
      'x-rauhwpx-content-sha256': contentDigest,
      'x-content-sha256': contentDigest,
      'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), identity.pair.privateKey).toString('base64url'),
      ...headers,
    },
  });
}

function signedSse(
  request: Request,
  identity: ReturnType<typeof serverIdentity>,
  event: Record<string, unknown>,
  sequence = 1,
): Response {
  const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
  const url = new URL(request.url);
  const data = JSON.stringify(event);
  const eventDigest = digest(Buffer.from(data));
  const eventType = String(event.type ?? 'message');
  const canonicalEvent = `RAUHWpx-sse-event-v1\n${nonce}\nGET\n${url.pathname}${url.search}\n200\n${sequence}\n${eventType}\n${eventDigest}`;
  const frame = [
    `id: ${sequence}`,
    `event: ${eventType}`,
    `rauhwpx-sha256: ${eventDigest}`,
    `rauhwpx-signature: ${sign(null, Buffer.from(canonicalEvent), identity.pair.privateKey).toString('base64url')}`,
    `data: ${data}`,
    '',
    '',
  ].join('\n');
  const protocolDigest = digest(Buffer.from('rauhwpx-sse-v1'));
  const canonicalResponse = `RAUHWpx-response-v1\n${nonce}\nGET\n${url.pathname}${url.search}\n200\n${protocolDigest}`;
  return new Response(frame, {
    headers: {
      'content-type': 'text/event-stream',
      'x-rauhwpx-server-key': identity.key,
      'x-rauhwpx-stream-protocol': 'rauhwpx-sse-v1',
      'x-rauhwpx-content-sha256': protocolDigest,
      'x-rauhwpx-response-signature': sign(null, Buffer.from(canonicalResponse), identity.pair.privateKey).toString('base64url'),
    },
  });
}

function storedBrowserProfile(endpoint: string, serverPublicKey: string) {
  return {
    name: 'Stored browser VPS',
    host: new URL(endpoint).hostname,
    sshUser: 'ubuntu',
    sshPort: 22,
    auth: { kind: 'ssh-agent' },
    transport: { kind: 'https', endpoint },
    endpoint,
    serverPublicKey,
  };
}

test('browser cloud pairs, verifies signed responses, and forwards a signed live agent event', async () => {
  const pair = generateKeyPairSync('ed25519');
  const encoded = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const serverPublicKey = `ed25519:${encoded}`;
  const endpoint = 'https://cloud.example.test/rauhwpx-cloud';
  const sessionId = 'pwa_signed_room';
  let streamCalls = 0;

  const signedResponse = (request: Request, body: unknown, status = 200) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
    const url = new URL(request.url);
    const contentDigest = digest(bytes);
    const canonical = `RAUHWpx-response-v1\n${nonce}\n${request.method}\n${url.pathname}${url.search}\n${status}\n${contentDigest}`;
    return new Response(bytes, {
      status,
      headers: {
        'content-type': 'application/json',
        'x-rauhwpx-server-key': serverPublicKey,
        'x-rauhwpx-content-sha256': contentDigest,
        'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), pair.privateKey).toString('base64url'),
      },
    });
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/v1/health')) {
      return new Response(JSON.stringify({
        ok: true, version: '1.1.0', protocolVersion: 1, serverPublicKey, serverId: 'browser-test',
      }), { status: 200, headers: { 'content-type': 'application/json', 'x-rauhwpx-server-key': serverPublicKey } });
    }
    if (url.pathname.endsWith('/v1/pairing/redeem')) {
      return signedResponse(request, {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        accessExpiresAt: Date.now() + 10 * 60_000,
        device: { id: 'pwa-device', name: 'PWA' },
      });
    }
    if (url.pathname.endsWith('/v1/sessions')) {
      return signedResponse(request, { sessions: [{
        id: sessionId,
        stateVersion: 4,
        status: 'running',
        persistent: true,
        roomStatus: 'active',
        executionPhase: 'working',
        originDeviceId: 'pwa-device',
        clientContext: { threadId: 'thread-pwa', documentId: 'document-pwa' },
        originDocument: { name: 'pwa.hwpx', sha256: 'a'.repeat(64), size: 12 },
        limits: { maxDurationSeconds: 28_800, maxTurns: 100 },
        turnsUsed: 1,
        startedAt: Date.now(),
        currentWait: null,
      }] });
    }
    if (url.pathname.endsWith(`/v1/sessions/${sessionId}/checkpoint`)) {
      const bytes = Buffer.from('SIGNED-OPERATION-CHECKPOINT');
      const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
      const contentDigest = digest(bytes);
      const canonical = `RAUHWpx-response-v1\n${nonce}\n${request.method}\n${url.pathname}${url.search}\n200\n${contentDigest}`;
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'x-rauhwpx-server-key': serverPublicKey,
          'x-rauhwpx-content-sha256': contentDigest,
          'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), pair.privateKey).toString('base64url'),
          'x-content-sha256': contentDigest,
          'x-boundary-operation': 'operation_1',
          'x-boundary-kind': 'operation',
          'x-checkpoint-revision': '2',
          'x-checkpoint-turn': '1',
          'x-document-name': encodeURIComponent('pwa.hwpx'),
        },
      });
    }
    if (url.pathname.endsWith(`/v1/sessions/${sessionId}/events`)) {
      streamCalls += 1;
      if (streamCalls > 1) throw new DOMException('stopped', 'AbortError');
      const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
      const event = {
        sessionId,
        seq: 1,
        type: 'agent.event',
        payload: { type: 'agent', event: { type: 'assistant-delta', text: '라이브' } },
      };
      const data = JSON.stringify(event);
      const eventDigest = digest(Buffer.from(data));
      const canonicalEvent = `RAUHWpx-sse-event-v1\n${nonce}\nGET\n${url.pathname}${url.search}\n200\n1\nagent.event\n${eventDigest}`;
      const frame = [
        'id: 1',
        'event: agent.event',
        `rauhwpx-sha256: ${eventDigest}`,
        `rauhwpx-signature: ${sign(null, Buffer.from(canonicalEvent), pair.privateKey).toString('base64url')}`,
        `data: ${data}`,
        '',
        '',
      ].join('\n');
      const protocolDigest = digest(Buffer.from('rauhwpx-sse-v1'));
      const canonicalResponse = `RAUHWpx-response-v1\n${nonce}\nGET\n${url.pathname}${url.search}\n200\n${protocolDigest}`;
      return new Response(frame, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-rauhwpx-server-key': serverPublicKey,
          'x-rauhwpx-stream-protocol': 'rauhwpx-sse-v1',
          'x-rauhwpx-content-sha256': protocolDigest,
          'x-rauhwpx-response-signature': sign(null, Buffer.from(canonicalResponse), pair.privateKey).toString('base64url'),
        },
      });
    }
    throw new Error(`Unexpected PWA request: ${request.method} ${url.pathname}`);
  };

  const api = createBrowserCloudApi({ fetchImpl, storage: new MemoryStorage() });
  assert.ok(api);
  let unsubscribe = () => {};
  const live = new Promise<Record<string, unknown>>((resolve) => {
    unsubscribe = api.onCloudEvent((raw) => {
      const event = raw as Record<string, unknown>;
      const envelope = event.event as Record<string, unknown> | undefined;
      if (envelope?.type === 'agent.event') resolve(event);
    });
  });
  const paired = await api.cloudPair({
    code: 'ABCD-EFGH-IJKL',
    profile: {
      name: 'Browser VPS',
      host: 'cloud.example.test',
      sshUser: 'ubuntu',
      sshPort: 22,
      auth: { kind: 'ssh-agent' },
      transport: { kind: 'https', endpoint },
    },
  });
  assert.equal((paired.profile as Record<string, unknown>).connection, 'ready');
  const scoped = await api.cloudGetState({ threadId: 'thread-pwa', documentId: 'document-pwa' });
  assert.equal((scoped.session as Record<string, unknown>).kind, 'running');
  const checkpoint = await api.cloudDownloadCheckpoint({ sessionId, operationId: 'operation_1' });
  assert.equal(checkpoint.kind, 'operation');
  assert.equal(checkpoint.operationId, 'operation_1');
  assert.equal(checkpoint.documentId, 'document-pwa');
  const event = await live;
  assert.equal(event.sessionId, sessionId);
  assert.equal(((event.event as Record<string, unknown>).payload as Record<string, unknown>).type, 'agent');
  unsubscribe();
  assert.ok(streamCalls >= 1);
});

test('browser verifies a 401 proof before starting token rotation', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://forged-401.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem('rauhwpx.cloud.browser.profile.v1', JSON.stringify(storedBrowserProfile(endpoint, identity.key)));
  storage.setItem('rauhwpx.cloud.browser.tokens.v1', JSON.stringify({
    accessToken: 'still-valid-access',
    refreshToken: 'forged-refresh',
    accessExpiresAt: Date.now() + 60_000,
  }));
  let refreshCalls = 0;
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/token/refresh')) refreshCalls += 1;
      return new Response(JSON.stringify({ error: { code: 'TOKEN_EXPIRED', message: 'Forged' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.ok(api);
  await api.cloudGetState({ threadId: 'thread-forged', documentId: null });
  assert.equal(refreshCalls, 0);
});

test('browser shares one verified 401 refresh and reuses the rotated token', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://shared-401.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem('rauhwpx.cloud.browser.profile.v1', JSON.stringify(storedBrowserProfile(endpoint, identity.key)));
  storage.setItem('rauhwpx.cloud.browser.tokens.v1', JSON.stringify({
    accessToken: 'shared-old-access',
    refreshToken: 'shared-old-refresh',
    accessExpiresAt: Date.now() + 60_000,
  }));
  const oldRequestsReady = Promise.withResolvers<void>();
  const releaseOldRequests = Promise.withResolvers<void>();
  let oldRequests = 0;
  let retriedRequests = 0;
  let refreshCalls = 0;
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/token/refresh')) {
        refreshCalls += 1;
        return signedJson(request, identity, {
          accessToken: 'shared-new-access',
          refreshToken: 'shared-new-refresh',
          accessExpiresAt: Date.now() + 60_000,
        });
      }
      if (url.pathname.endsWith('/v1/sessions')) {
        if (request.headers.get('authorization') === 'Bearer shared-old-access') {
          oldRequests += 1;
          if (oldRequests === 2) oldRequestsReady.resolve();
          await releaseOldRequests.promise;
          return signedJson(request, identity, {
            error: { code: 'TOKEN_EXPIRED', message: 'Expired access token' },
          }, 401);
        }
        assert.equal(request.headers.get('authorization'), 'Bearer shared-new-access');
        retriedRequests += 1;
        return signedJson(request, identity, { sessions: [] });
      }
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);
  const requests = Promise.all([
    api.cloudGetState({ threadId: 'thread-one', documentId: null }),
    api.cloudGetState({ threadId: 'thread-two', documentId: null }),
  ]);
  await oldRequestsReady.promise;
  releaseOldRequests.resolve();
  await requests;
  assert.equal(refreshCalls, 1);
  assert.equal(retriedRequests, 2);
  assert.equal(JSON.parse(storage.getItem('rauhwpx.cloud.browser.tokens.v1')!).refreshToken, 'shared-new-refresh');
});

test('browser late profile A refresh cannot commit into profile B', async () => {
  const identityA = serverIdentity();
  const identityB = serverIdentity();
  const endpointA = 'https://profile-a.example.test/rauhwpx-cloud';
  const endpointB = 'https://profile-b.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem('rauhwpx.cloud.browser.profile.v1', JSON.stringify(storedBrowserProfile(endpointA, identityA.key)));
  storage.setItem('rauhwpx.cloud.browser.tokens.v1', JSON.stringify({
    accessToken: 'profile-a-expired',
    refreshToken: 'profile-a-refresh',
    accessExpiresAt: Date.now() - 1,
  }));
  const refreshStarted = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<void>();
  const observed: Array<{ host: string; token: string }> = [];
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/health')) {
        const identity = url.host === new URL(endpointB).host ? identityB : identityA;
        return new Response(JSON.stringify({
          ok: true,
          version: '1.1.0',
          protocolVersion: 1,
          serverPublicKey: identity.key,
          serverId: url.host,
        }), { headers: { 'content-type': 'application/json', 'x-rauhwpx-server-key': identity.key } });
      }
      if (url.pathname.endsWith('/v1/token/refresh')) {
        observed.push({
          host: url.host,
          token: String((await request.json() as { refreshToken?: string }).refreshToken),
        });
        refreshStarted.resolve();
        await releaseRefresh.promise;
        return signedJson(request, identityA, {
          accessToken: 'profile-a-late-access',
          refreshToken: 'profile-a-late-refresh',
          accessExpiresAt: Date.now() + 60_000,
        });
      }
      if (url.pathname.endsWith('/v1/sessions')) return signedJson(request, identityA, { sessions: [] });
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);
  const stale = api.cloudGetState({ threadId: 'thread-a', documentId: null });
  await refreshStarted.promise;
  await api.cloudSaveProfile({
    profile: {
      name: 'Profile B',
      host: 'profile-b.example.test',
      sshUser: 'ubuntu',
      sshPort: 22,
      auth: { kind: 'ssh-agent' },
      transport: { kind: 'https', endpoint: endpointB },
    },
  });
  releaseRefresh.resolve();
  await assert.rejects(stale, { code: 'PROFILE_CHANGED' });
  assert.deepEqual(observed, [{ host: new URL(endpointA).host, token: 'profile-a-refresh' }]);
  assert.equal(storage.getItem('rauhwpx.cloud.browser.tokens.v1'), null);
  assert.equal(JSON.parse(storage.getItem('rauhwpx.cloud.browser.profile.v1')!).endpoint, endpointB);
  const current = await api.cloudGetState({ threadId: 'thread-b', documentId: null });
  assert.notEqual((current.profile as { connection?: string }).connection, 'error');
});

test('browser watcher cannot emit a profile A event after profile B activates', async (t) => {
  const identityA = serverIdentity();
  const identityB = serverIdentity();
  const endpointA = 'https://watch-a.example.test/rauhwpx-cloud';
  const endpointB = 'https://watch-b.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem('rauhwpx.cloud.browser.profile.v1', JSON.stringify(storedBrowserProfile(endpointA, identityA.key)));
  storage.setItem('rauhwpx.cloud.browser.tokens.v1', JSON.stringify({
    accessToken: 'watch-a-access', refreshToken: 'watch-a-refresh', accessExpiresAt: Date.now() + 60_000,
  }));
  const archiveReadStarted = Promise.withResolvers<void>();
  const releaseArchiveRead = Promise.withResolvers<void>();
  const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({
      objectStore: () => ({
        get: () => {
          const request: { result: null; onsuccess?: () => void } = { result: null };
          archiveReadStarted.resolve();
          void releaseArchiveRead.promise.then(() => request.onsuccess?.());
          return request;
        },
      }),
    }),
    close() {},
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open: () => {
        const request: { result: typeof database; onsuccess?: () => void } = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
  });
  t.after(() => {
    if (indexedDbDescriptor) Object.defineProperty(globalThis, 'indexedDB', indexedDbDescriptor);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
  let profileASessionRequests = 0;
  const session = {
    id: 'shared-watch-session', stateVersion: 2, status: 'running', persistent: true,
    clientContext: { threadId: 'watch-thread-a', documentId: 'watch-document-a' },
    originDocument: { name: 'watch-a.hwpx', sha256: 'a'.repeat(64), size: 1 },
    limits: { maxDurationSeconds: 60, maxTurns: 10 },
  };
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/health')) {
        return new Response(JSON.stringify({
          ok: true, version: '1.1.0', protocolVersion: 1, serverPublicKey: identityB.key,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.host === new URL(endpointA).host && url.pathname.endsWith('/v1/sessions')) {
        profileASessionRequests += 1;
        return signedJson(request, identityA, {
          sessions: [{ ...session, status: profileASessionRequests === 1 ? 'running' : 'purged' }],
        });
      }
      if (url.host === new URL(endpointA).host && url.pathname.endsWith('/timeline')) {
        return signedJson(request, identityA, {
          schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: '2026-08-30T00:00:00.000Z',
          thread: { id: 'watch-thread-a', title: 'Watch', messages: [] },
        });
      }
      if (url.host === new URL(endpointA).host && url.pathname.endsWith('/events')) {
        return signedSse(request, identityA, {
          sessionId: session.id, seq: 1, type: 'session.completed', payload: { status: 'completed' },
        });
      }
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);
  const events: unknown[] = [];
  api.onCloudEvent((event) => events.push(event));
  await api.cloudGetState({
    threadId: 'watch-thread-a', documentId: 'watch-document-a', selectedSessionId: session.id,
  });
  await archiveReadStarted.promise;
  await api.cloudSaveProfile({ profile: storedBrowserProfile(endpointB, identityB.key) });
  releaseArchiveRead.resolve();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(events, []);
});

test('browser selection changes the viewed session without releasing the scoped document lease', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://scope-selection.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem('rauhwpx.cloud.browser.profile.v1', JSON.stringify(storedBrowserProfile(endpoint, identity.key)));
  storage.setItem('rauhwpx.cloud.browser.tokens.v1', JSON.stringify({
    accessToken: 'scope-access',
    refreshToken: 'scope-refresh',
    accessExpiresAt: Date.now() + 60_000,
    device: { id: 'this-device', name: 'This device' },
  }));
  let selectedStatus = 'suspended';
  const session = (
    id: string,
    threadId: string,
    documentId: string,
    originDeviceId: string,
    status: string,
  ) => ({
    id,
    stateVersion: 3,
    status,
    persistent: true,
    roomStatus: 'active',
    executionPhase: 'working',
    originDeviceId,
    clientContext: { threadId, documentId },
    originDocument: { name: `${id}.hwpx`, sha256: 'a'.repeat(64), size: 12 },
    limits: { maxDurationSeconds: 28_800, maxTurns: 100 },
    turnsUsed: 1,
    startedAt: Date.now(),
    currentWait: null,
  });
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/sessions')) {
        return signedJson(request, identity, { sessions: [
          session('session-a', 'thread-a', 'document-a', 'this-device', 'suspended'),
          session('session-b', 'thread-b', 'document-b', 'other-device', selectedStatus),
        ] });
      }
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);

  let snapshot = await api.cloudGetState({
    threadId: 'thread-a',
    documentId: 'document-a',
    selectedSessionId: 'session-b',
  });
  assert.equal((snapshot.session as { sessionId: string }).sessionId, 'session-b');
  assert.deepEqual(snapshot.lease, {
    owner: 'cloud',
    sessionId: 'session-a',
    acquiredAt: (snapshot.lease as { acquiredAt: string }).acquiredAt,
  });

  selectedStatus = 'failed';
  snapshot = await api.cloudGetState({
    threadId: 'thread-a',
    documentId: 'document-a',
    selectedSessionId: 'session-b',
  });
  assert.equal((snapshot.session as { kind: string }).kind, 'failed');
  assert.equal((snapshot.lease as { sessionId: string }).sessionId, 'session-a');
});

test('browser stable document scope never falls back to a matching legacy thread', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://scope.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem('rauhwpx.cloud.browser.profile.v1', JSON.stringify(storedBrowserProfile(endpoint, identity.key)));
  storage.setItem('rauhwpx.cloud.browser.tokens.v1', JSON.stringify({
    accessToken: 'scope-access', refreshToken: 'scope-refresh', accessExpiresAt: Date.now() + 60_000,
  }));
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/sessions')) {
        return signedJson(request, identity, { sessions: [{
          id: 'wrong-document', stateVersion: 2, status: 'suspended',
          clientContext: { threadId: 'legacy-thread', documentId: 'document-b' },
          originDocument: { name: 'other.hwpx', sha256: 'a'.repeat(64), size: 1 },
          limits: { maxDurationSeconds: 60, maxTurns: 10 },
        }] });
      }
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);

  const snapshot = await api.cloudGetState({
    threadId: 'legacy-thread', documentId: 'document-a', selectedSessionId: 'wrong-document',
  });
  assert.equal((snapshot.session as { sessionId: string }).sessionId, 'wrong-document');
  assert.equal((snapshot.lease as { owner: string }).owner, 'local');
});

test('browser persistence keys isolate identical session ids by pinned server identity', () => {
  const identityA = serverIdentity();
  const identityB = serverIdentity();
  const profileA = storedBrowserProfile('https://server-a.example.test/cloud', identityA.key);
  const profileB = storedBrowserProfile('https://server-b.example.test/cloud', identityB.key);
  assert.notEqual(
    browserCloudTest.archiveId(profileA, 'shared-session', 'result'),
    browserCloudTest.archiveId(profileB, 'shared-session', 'result'),
  );
  assert.notEqual(
    browserCloudTest.originSyncKey(profileA, 'shared-session'),
    browserCloudTest.originSyncKey(profileB, 'shared-session'),
  );
  assert.notEqual(
    browserCloudTest.takeoverCompleteKey(profileA, 'shared-session', 'operation-a'),
    browserCloudTest.takeoverCompleteKey(profileB, 'shared-session', 'operation-a'),
  );
  assert.notEqual(
    browserCloudTest.takeoverCompleteKey(profileA, 'shared-session', 'operation-a'),
    browserCloudTest.takeoverCompleteKey(profileA, 'shared-session', 'operation-b'),
  );
});

test('browser profile changes clear server-scoped selection, timeline, and dismissal state', async () => {
  const identityA = serverIdentity();
  const identityB = serverIdentity();
  const endpointA = 'https://state-a.example.test/rauhwpx-cloud';
  const endpointB = 'https://state-b.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem('rauhwpx.cloud.browser.profile.v1', JSON.stringify(storedBrowserProfile(endpointA, identityA.key)));
  storage.setItem('rauhwpx.cloud.browser.tokens.v1', JSON.stringify({
    accessToken: 'state-a-access',
    refreshToken: 'state-a-refresh',
    accessExpiresAt: Date.now() + 60_000,
    device: { id: 'device-a' },
  }));
  const timelineA = {
    schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: '2026-08-30T00:00:00.000Z',
    thread: { id: 'thread-a', title: 'A', messages: [] },
  };
  const remote = (documentId: string, threadId: string) => ({
    id: 'shared-session', stateVersion: 2, status: 'suspended', persistent: true,
    clientContext: { documentId, threadId },
    originDocument: { name: `${documentId}.hwpx`, sha256: 'a'.repeat(64), size: 1 },
    suspendedReason: { code: 'WAITING', message: 'Waiting' },
  });
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const identity = url.host === new URL(endpointA).host ? identityA : identityB;
      if (url.pathname.endsWith('/v1/health')) {
        return new Response(JSON.stringify({
          ok: true, version: '1.1.0', protocolVersion: 1, serverPublicKey: identity.key,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.endsWith('/v1/pairing/redeem')) {
        return signedJson(request, identityB, {
          accessToken: 'state-b-access', refreshToken: 'state-b-refresh',
          accessExpiresAt: Date.now() + 60_000, device: { id: 'device-b' },
        });
      }
      if (url.pathname.endsWith('/v1/sessions')) {
        return signedJson(request, identity, {
          sessions: [url.host === new URL(endpointA).host
            ? remote('document-a', 'thread-a')
            : remote('document-b', 'thread-b')],
        });
      }
      if (url.pathname.endsWith('/timeline') && url.host === new URL(endpointA).host) {
        return signedJson(request, identityA, timelineA);
      }
      if (url.pathname.endsWith('/timeline')) {
        return signedJson(request, identityB, { error: { message: 'Timeline pending' } }, 404);
      }
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);

  let snapshot = await api.cloudGetState({
    threadId: 'thread-a', documentId: 'document-a', selectedSessionId: 'shared-session',
  });
  assert.equal((snapshot.timeline as typeof timelineA).thread.id, 'thread-a');
  await api.cloudDismissSession({ sessionId: 'shared-session' });

  snapshot = await api.cloudPair({
    code: 'ABCD-EFGH-IJKL',
    profile: {
      name: 'Server B', host: 'state-b.example.test', sshUser: 'ubuntu', sshPort: 22,
      auth: { kind: 'ssh-agent' }, transport: { kind: 'https', endpoint: endpointB },
    },
  });
  snapshot = await api.cloudGetState({
    threadId: 'thread-b', documentId: 'document-b', selectedSessionId: 'shared-session',
  });
  assert.equal((snapshot.session as { documentId: string }).documentId, 'document-b');
  assert.equal(snapshot.timeline, null);
  assert.equal((snapshot.sessions as unknown[]).length, 1);
});

test('browser same-server re-pair increments the profile epoch', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://same-profile.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem('rauhwpx.cloud.browser.profile.v1', JSON.stringify(storedBrowserProfile(endpoint, identity.key)));
  storage.setItem('rauhwpx.cloud.browser.tokens.v1', JSON.stringify({
    accessToken: 'old-access', refreshToken: 'old-refresh', accessExpiresAt: Date.now() + 60_000,
    device: { id: 'old-device' },
  }));
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/health')) {
        return new Response(JSON.stringify({
          ok: true, version: '1.1.0', protocolVersion: 1, serverPublicKey: identity.key,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.endsWith('/v1/pairing/redeem')) {
        return signedJson(request, identity, {
          accessToken: 'new-access', refreshToken: 'new-refresh', accessExpiresAt: Date.now() + 60_000,
          device: { id: 'new-device' },
        });
      }
      if (url.pathname.endsWith('/v1/sessions')) return signedJson(request, identity, { sessions: [] });
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);
  const before = await api.cloudGetState({ threadId: '', documentId: null });
  const repaired = await api.cloudPair({
    code: 'ABCD-EFGH-IJKL',
    profile: storedBrowserProfile(endpoint, identity.key),
  });
  assert.equal(before.profileEpoch, 0);
  assert.equal(repaired.profileEpoch, 1);
});

test('browser cancelled takeover-ready sessions keep their lease until local completion', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://takeover.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem('rauhwpx.cloud.browser.profile.v1', JSON.stringify(storedBrowserProfile(endpoint, identity.key)));
  storage.setItem('rauhwpx.cloud.browser.tokens.v1', JSON.stringify({
    accessToken: 'takeover-access', refreshToken: 'takeover-refresh',
    accessExpiresAt: Date.now() + 60_000,
  }));
  let operationId = 'takeover-operation-a';
  const apiFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/v1/sessions')) {
      return signedJson(request, identity, { sessions: [{
        id: 'takeover-session', stateVersion: 4, status: 'cancelled', takeoverReady: true,
        takeoverBoundary: { operationId },
        clientContext: { documentId: 'takeover-document', threadId: 'takeover-thread' },
        originDocument: { name: 'takeover.hwpx', sha256: 'a'.repeat(64), size: 1 },
      }] });
    }
    if (url.pathname.endsWith('/timeline')) {
      return signedJson(request, identity, { error: { message: 'Timeline pending' } }, 404);
    }
    throw new Error(`Unexpected request ${request.method} ${url}`);
  };
  const api = createBrowserCloudApi({ storage, fetchImpl: apiFetch });
  assert.ok(api);
  let snapshot = await api.cloudGetState({
    threadId: 'takeover-thread', documentId: 'takeover-document', selectedSessionId: 'takeover-session',
  });
  assert.equal((snapshot.session as { kind: string }).kind, 'taking-over');
  assert.equal((snapshot.lease as { owner: string }).owner, 'cloud');
  snapshot = await api.cloudCompleteTakeover({ sessionId: 'takeover-session' });
  assert.equal((snapshot.lease as { owner: string }).owner, 'local');
  const restarted = createBrowserCloudApi({ storage, fetchImpl: apiFetch });
  assert.ok(restarted);
  snapshot = await restarted.cloudGetState({
    threadId: 'takeover-thread', documentId: 'takeover-document', selectedSessionId: 'takeover-session',
  });
  assert.equal((snapshot.lease as { owner: string }).owner, 'local');

  operationId = 'takeover-operation-b';
  const future = createBrowserCloudApi({ storage, fetchImpl: apiFetch });
  assert.ok(future);
  snapshot = await future.cloudGetState({
    threadId: 'takeover-thread', documentId: 'takeover-document', selectedSessionId: 'takeover-session',
  });
  assert.equal((snapshot.session as { kind: string }).kind, 'taking-over');
  assert.equal((snapshot.lease as { owner: string }).owner, 'cloud');
});

test('browser takeover reuses its frozen receipt after a partial artifact failure', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://takeover-retry.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem('rauhwpx.cloud.browser.profile.v1', JSON.stringify(storedBrowserProfile(endpoint, identity.key)));
  storage.setItem('rauhwpx.cloud.browser.tokens.v1', JSON.stringify({
    accessToken: 'takeover-retry-access', refreshToken: 'takeover-retry-refresh',
    accessExpiresAt: Date.now() + 60_000, device: { id: 'device-a' },
  }));
  const sessionId = 'takeover-retry-session';
  const operationId = 'turn_takeover_retry';
  const checkpointBytes = new TextEncoder().encode('takeover-checkpoint');
  const timelineBytes = new TextEncoder().encode(JSON.stringify({
    schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: '2026-08-30T00:00:00.000Z',
    thread: {
      id: 'takeover-thread', title: 'Takeover', titleRequested: true, createdAt: 1, updatedAt: 2,
      agent: 'codex', model: 'gpt-5.6', effort: 'high', workflow: 'direct', docKey: 'takeover.hwpx',
      documentId: 'takeover-document', activeTemplateId: null, messages: [],
    },
  }));
  const boundary = {
    operationId,
    revision: 7,
    turnNumber: 4,
    checkpoint: { blobId: digest(checkpointBytes), size: checkpointBytes.byteLength },
    timeline: { blobId: digest(timelineBytes), size: timelineBytes.byteLength },
  };
  const session = {
    id: sessionId, stateVersion: 5, status: 'cancelled', takeoverReady: true,
    clientContext: { documentId: 'takeover-document', threadId: 'takeover-thread' },
    originDocument: { name: 'takeover.hwpx', sha256: 'a'.repeat(64), size: checkpointBytes.byteLength },
  };
  let takeoverCommands = 0;
  let checkpointDownloads = 0;
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith(`/${sessionId}/takeover`)) {
        return signedJson(request, identity, {
          error: { code: 'TAKEOVER_NOT_REQUESTED', message: 'No receipt' },
        }, 404);
      }
      if (url.pathname.endsWith(`/${sessionId}/commands`)) {
        takeoverCommands += 1;
        return signedJson(request, identity, { session, takeover: { status: 'ready', boundary } });
      }
      if (url.pathname.endsWith(`/${sessionId}/checkpoint`)) {
        checkpointDownloads += 1;
        if (checkpointDownloads === 1) {
          return signedJson(request, identity, { error: { code: 'TEMPORARY', message: 'offline' } }, 503);
        }
        return signedBytes(request, identity, checkpointBytes, {
          'x-boundary-operation': operationId,
          'x-boundary-kind': 'turn',
          'x-checkpoint-revision': '7',
          'x-checkpoint-turn': '4',
          'x-document-name': encodeURIComponent('takeover.hwpx'),
        });
      }
      if (url.pathname.endsWith(`/${sessionId}/timeline`)) {
        return signedBytes(request, identity, timelineBytes, {
          'content-type': 'application/json',
          'x-boundary-operation': operationId,
          'x-boundary-revision': '7',
          'x-boundary-turn': '4',
        });
      }
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);
  const request = { sessionId, command: 'takeover' as const, expectedVersion: 4 };
  await assert.rejects(api.cloudCommand(request), /offline/);
  const snapshot = await api.cloudCommand(request);
  assert.equal(takeoverCommands, 1);
  assert.equal(checkpointDownloads, 2);
  assert.deepEqual((snapshot.takeover as { document: { bytes: Uint8Array } }).document.bytes, checkpointBytes);
});

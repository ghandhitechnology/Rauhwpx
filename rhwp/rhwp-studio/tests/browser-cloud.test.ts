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

class ThrowingStorage extends MemoryStorage {
  #failures = new Map<string, number>();

  failNextSet(...keys: string[]) {
    for (const key of keys) this.#failures.set(key, (this.#failures.get(key) ?? 0) + 1);
  }

  override setItem(key: string, value: string) {
    const remaining = this.#failures.get(key) ?? 0;
    if (remaining > 0) {
      this.#failures.set(key, remaining - 1);
      throw new Error(`Storage write failed for ${key}`);
    }
    super.setItem(key, value);
  }
}

class MemoryLockManager {
  #tail = Promise.resolve();
  active = 0;
  maximumActive = 0;

  request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    const operation = this.#tail.then(async () => {
      this.active += 1;
      this.maximumActive = Math.max(this.maximumActive, this.active);
      try {
        return await callback();
      } finally {
        this.active -= 1;
      }
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

class MemoryStorageEvents {
  #listeners = new Set<(event: { key: string; storageArea: Storage }) => void>();

  addEventListener(_type: 'storage', listener: (event: { key?: string | null; storageArea?: Storage | null }) => void) {
    this.#listeners.add(listener as (event: { key: string; storageArea: Storage }) => void);
  }

  emit(storageArea: Storage, key = CREDENTIALS_KEY) {
    for (const listener of this.#listeners) listener({ key, storageArea });
  }
}

const CREDENTIALS_KEY = 'rauhwpx.cloud.browser.credentials.v2';
const PROFILE_KEY = 'rauhwpx.cloud.browser.profile.v1';
const TOKENS_KEY = 'rauhwpx.cloud.browser.tokens.v1';

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

function storeBrowserCredentials(storage: Storage, profile: unknown, tokens: unknown) {
  storage.setItem(CREDENTIALS_KEY, JSON.stringify({ profile, tokens }));
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
  storeBrowserCredentials(storage, storedBrowserProfile(endpoint, identity.key), {
    accessToken: 'still-valid-access',
    refreshToken: 'forged-refresh',
    accessExpiresAt: Date.now() + 60_000,
  });
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
  storeBrowserCredentials(storage, storedBrowserProfile(endpoint, identity.key), {
    accessToken: 'shared-old-access',
    refreshToken: 'shared-old-refresh',
    accessExpiresAt: Date.now() + 60_000,
  });
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
  assert.equal(JSON.parse(storage.getItem(CREDENTIALS_KEY)!).tokens.refreshToken, 'shared-new-refresh');
});

test('browser profile change waits for an admitted profile A refresh before activating B', async () => {
  const identityA = serverIdentity();
  const identityB = serverIdentity();
  const endpointA = 'https://profile-a.example.test/rauhwpx-cloud';
  const endpointB = 'https://profile-b.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storeBrowserCredentials(storage, storedBrowserProfile(endpointA, identityA.key), {
    accessToken: 'profile-a-expired',
    refreshToken: 'profile-a-refresh',
    accessExpiresAt: Date.now() - 1,
  });
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
  const save = api.cloudSaveProfile({
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
  await stale;
  await save;
  assert.deepEqual(observed, [{ host: new URL(endpointA).host, token: 'profile-a-refresh' }]);
  assert.equal(JSON.parse(storage.getItem(CREDENTIALS_KEY)!).tokens, null);
  assert.equal(JSON.parse(storage.getItem(CREDENTIALS_KEY)!).profile.endpoint, endpointB);
  const current = await api.cloudGetState({ threadId: 'thread-b', documentId: null });
  assert.notEqual((current.profile as { connection?: string }).connection, 'error');
});

test('browser pairing is a writer-priority barrier for commands', async () => {
  const identityA = serverIdentity();
  const identityB = serverIdentity();
  const endpointA = 'https://barrier-a.example.test/rauhwpx-cloud';
  const endpointB = 'https://barrier-b.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storeBrowserCredentials(storage, storedBrowserProfile(endpointA, identityA.key), {
    accessToken: 'barrier-a-access', refreshToken: 'barrier-a-refresh', accessExpiresAt: Date.now() + 60_000,
  });
  const redeemStarted = Promise.withResolvers<void>();
  const releaseRedeem = Promise.withResolvers<void>();
  const commandHosts: string[] = [];
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
      if (url.pathname.endsWith('/v1/pairing/redeem')) {
        redeemStarted.resolve();
        await releaseRedeem.promise;
        return signedJson(request, identityB, {
          accessToken: 'barrier-b-access', refreshToken: 'barrier-b-refresh', accessExpiresAt: Date.now() + 60_000,
        });
      }
      if (url.pathname.endsWith('/v1/sessions')) {
        assert.equal(url.host, new URL(endpointB).host);
        return signedJson(request, identityB, { sessions: [] });
      }
      if (url.pathname.endsWith('/commands')) {
        commandHosts.push(url.host);
        assert.equal(request.headers.get('authorization'), 'Bearer barrier-b-access');
        return signedJson(request, identityB, {});
      }
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);

  const pairing = api.cloudPair({
    code: 'ABCD-EFGH-IJKL',
    profile: storedBrowserProfile(endpointB, identityB.key),
  });
  await redeemStarted.promise;
  const command = api.cloudCommand({ sessionId: 'barrier-session', command: 'pause', expectedVersion: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(commandHosts, []);

  releaseRedeem.resolve();
  await pairing;
  await command;
  assert.deepEqual(commandHosts, [new URL(endpointB).host]);
});

test('browser pairing keeps profile A authoritative when the credential commit fails', async () => {
  const identityA = serverIdentity();
  const identityB = serverIdentity();
  const endpointA = 'https://pair-atomic-a.example.test/rauhwpx-cloud';
  const endpointB = 'https://pair-atomic-b.example.test/rauhwpx-cloud';
  const storage = new ThrowingStorage();
  storeBrowserCredentials(storage, storedBrowserProfile(endpointA, identityA.key), {
    accessToken: 'pair-a-access', refreshToken: 'pair-a-refresh', accessExpiresAt: Date.now() + 60_000,
  });
  const requests: Array<{ host: string; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
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
        accessToken: 'pair-b-access', refreshToken: 'pair-b-refresh', accessExpiresAt: Date.now() + 60_000,
      });
    }
    if (url.pathname.endsWith('/v1/sessions')) {
      requests.push({ host: url.host, authorization: request.headers.get('authorization') });
      return signedJson(request, identity, { sessions: [] });
    }
    throw new Error(`Unexpected request ${request.method} ${url}`);
  };
  const api = createBrowserCloudApi({ storage, fetchImpl });
  assert.ok(api);
  storage.failNextSet(CREDENTIALS_KEY, TOKENS_KEY);

  await assert.rejects(api.cloudPair({
    code: 'ABCD-EFGH-IJKL', profile: storedBrowserProfile(endpointB, identityB.key),
  }), /Storage write failed/);
  let snapshot = await api.cloudGetState({ threadId: 'pair-a', documentId: null });
  assert.equal(((snapshot.profile as { profile: { endpoint: string } }).profile).endpoint, endpointA);

  const restarted = createBrowserCloudApi({ storage, fetchImpl });
  assert.ok(restarted);
  snapshot = await restarted.cloudGetState({ threadId: 'pair-a', documentId: null });
  assert.equal(((snapshot.profile as { profile: { endpoint: string } }).profile).endpoint, endpointA);
  assert.deepEqual(requests, [
    { host: new URL(endpointA).host, authorization: 'Bearer pair-a-access' },
    { host: new URL(endpointA).host, authorization: 'Bearer pair-a-access' },
  ]);
});

test('browser profile save keeps profile A authoritative when the credential commit fails', async () => {
  const identityA = serverIdentity();
  const identityB = serverIdentity();
  const endpointA = 'https://save-atomic-a.example.test/rauhwpx-cloud';
  const endpointB = 'https://save-atomic-b.example.test/rauhwpx-cloud';
  const storage = new ThrowingStorage();
  storeBrowserCredentials(storage, storedBrowserProfile(endpointA, identityA.key), {
    accessToken: 'save-a-access', refreshToken: 'save-a-refresh', accessExpiresAt: Date.now() + 60_000,
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/v1/health')) {
      return new Response(JSON.stringify({
        ok: true, version: '1.1.0', protocolVersion: 1, serverPublicKey: identityB.key,
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname.endsWith('/v1/sessions')) return signedJson(request, identityA, { sessions: [] });
    throw new Error(`Unexpected request ${request.method} ${url}`);
  };
  const api = createBrowserCloudApi({ storage, fetchImpl });
  assert.ok(api);
  storage.failNextSet(CREDENTIALS_KEY, PROFILE_KEY);

  await assert.rejects(
    api.cloudSaveProfile({ profile: storedBrowserProfile(endpointB, identityB.key) }),
    /Storage write failed/,
  );
  let snapshot = await api.cloudGetState({ threadId: 'save-a', documentId: null });
  assert.equal(((snapshot.profile as { profile: { endpoint: string } }).profile).endpoint, endpointA);
  assert.equal(JSON.parse(storage.getItem(CREDENTIALS_KEY)!).tokens.refreshToken, 'save-a-refresh');

  const restarted = createBrowserCloudApi({ storage, fetchImpl });
  assert.ok(restarted);
  snapshot = await restarted.cloudGetState({ threadId: 'save-a', documentId: null });
  assert.equal(((snapshot.profile as { profile: { endpoint: string } }).profile).endpoint, endpointA);
});

test('browser writer intent aborts watchers before health and re-arms profile A after failure', async () => {
  const identityA = serverIdentity();
  const endpointA = 'https://watch-rearm-a.example.test/rauhwpx-cloud';
  const endpointB = 'https://watch-rearm-b.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storeBrowserCredentials(storage, storedBrowserProfile(endpointA, identityA.key), {
    accessToken: 'watch-rearm-access', refreshToken: 'watch-rearm-refresh', accessExpiresAt: Date.now() + 60_000,
  });
  const healthStarted = Promise.withResolvers<void>();
  const releaseHealth = Promise.withResolvers<void>();
  const firstWatchAborted = Promise.withResolvers<void>();
  const secondWatchStarted = Promise.withResolvers<void>();
  let watchCalls = 0;
  const session = {
    id: 'watch-rearm-session', stateVersion: 2, status: 'running', persistent: true,
    clientContext: { threadId: 'watch-rearm-thread', documentId: 'watch-rearm-document' },
    originDocument: { name: 'watch-rearm.hwpx', sha256: 'a'.repeat(64), size: 1 },
    limits: { maxDurationSeconds: 60, maxTurns: 10 },
  };
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/health')) {
        healthStarted.resolve();
        await releaseHealth.promise;
        return new Response(JSON.stringify({ ok: true, protocolVersion: 0 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/v1/sessions')) {
        return signedJson(request, identityA, { sessions: [session] });
      }
      if (url.pathname.endsWith('/timeline')) {
        return signedJson(request, identityA, { schema: 'timeline', thread: { messages: [] } });
      }
      if (url.pathname.endsWith('/events')) {
        watchCalls += 1;
        if (watchCalls === 2) secondWatchStarted.resolve();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            request.signal.addEventListener('abort', () => {
              if (watchCalls === 1) firstWatchAborted.resolve();
              try { controller.error(request.signal.reason); } catch {}
            }, { once: true });
          },
        });
        const protocolDigest = digest(Buffer.from('rauhwpx-sse-v1'));
        const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
        const canonical = `RAUHWpx-response-v1\n${nonce}\nGET\n${url.pathname}${url.search}\n200\n${protocolDigest}`;
        return new Response(body, { headers: {
          'content-type': 'text/event-stream',
          'x-rauhwpx-server-key': identityA.key,
          'x-rauhwpx-stream-protocol': 'rauhwpx-sse-v1',
          'x-rauhwpx-content-sha256': protocolDigest,
          'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), identityA.pair.privateKey).toString('base64url'),
        } });
      }
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);
  const unsubscribe = api.onCloudEvent(() => {});
  await api.cloudGetState({
    threadId: 'watch-rearm-thread', documentId: 'watch-rearm-document', selectedSessionId: session.id,
  });
  assert.equal(watchCalls, 1);

  const save = api.cloudSaveProfile({ profile: storedBrowserProfile(endpointB, identityA.key) });
  await healthStarted.promise;
  const abortedBeforeHealthFinished = await Promise.race([
    firstWatchAborted.promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
  releaseHealth.resolve();
  await assert.rejects(save, /지원하는 Rauhwpx Cloud 서버가 아닙니다/);
  const rearmed = await Promise.race([
    secondWatchStarted.promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
  unsubscribe();
  assert.equal(abortedBeforeHealthFinished, true);
  assert.equal(rearmed, true);
});

test('browser writer intent blocks late watcher result confirmation', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://watch-result.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storeBrowserCredentials(storage, storedBrowserProfile(endpoint, identity.key), {
    accessToken: 'watch-result-access', refreshToken: 'watch-result-refresh',
    accessExpiresAt: Date.now() + 60_000, device: { id: 'watch-result-device' },
  });
  const sessionId = 'watch-result-session';
  const session = {
    id: sessionId, stateVersion: 2, status: 'running', persistent: true,
    originDeviceId: 'watch-result-device',
    clientContext: { threadId: 'watch-result-thread', documentId: 'watch-result-document' },
    originDocument: { name: 'watch-result.hwpx', sha256: 'a'.repeat(64), size: 1 },
    limits: { maxDurationSeconds: 60, maxTurns: 10 },
  };
  const healthStarted = Promise.withResolvers<void>();
  const releaseHealth = Promise.withResolvers<void>();
  const watchStarted = Promise.withResolvers<void>();
  let releaseCompletedEvent = () => {};
  let sessionRequests = 0;
  let eventRequests = 0;
  let resultDownloads = 0;
  let resultConfirmations = 0;
  const resultBytes = new TextEncoder().encode('completed-result');
  const timelineBytes = new TextEncoder().encode(JSON.stringify({
    schema: 'rauhwpx.cloud.timeline', version: 1, thread: { messages: [] },
  }));
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/health')) {
        healthStarted.resolve();
        await releaseHealth.promise;
        return new Response(JSON.stringify({ ok: true, protocolVersion: 0 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/v1/sessions')) {
        sessionRequests += 1;
        return signedJson(request, identity, {
          sessions: [{ ...session, status: sessionRequests === 1 ? 'running' : 'completed' }],
        });
      }
      if (url.pathname.endsWith(`/${sessionId}/events`)) {
        eventRequests += 1;
        const protocolDigest = digest(Buffer.from('rauhwpx-sse-v1'));
        const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
        const canonical = `RAUHWpx-response-v1\n${nonce}\nGET\n${url.pathname}${url.search}\n200\n${protocolDigest}`;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (eventRequests === 1) {
              const event = {
                sessionId, seq: 1, type: 'session.completed', payload: { status: 'completed' },
              };
              const data = JSON.stringify(event);
              const eventDigest = digest(Buffer.from(data));
              const eventCanonical = `RAUHWpx-sse-event-v1\n${nonce}\nGET\n${url.pathname}${url.search}\n200\n1\nsession.completed\n${eventDigest}`;
              const frame = new TextEncoder().encode([
                'id: 1',
                'event: session.completed',
                `rauhwpx-sha256: ${eventDigest}`,
                `rauhwpx-signature: ${sign(null, Buffer.from(eventCanonical), identity.pair.privateKey).toString('base64url')}`,
                `data: ${data}`,
                '',
                '',
              ].join('\n'));
              releaseCompletedEvent = () => {
                controller.enqueue(frame);
                controller.close();
              };
              watchStarted.resolve();
            } else {
              request.signal.addEventListener('abort', () => {
                try { controller.error(request.signal.reason); } catch {}
              }, { once: true });
            }
          },
        });
        return new Response(body, { headers: {
          'content-type': 'text/event-stream',
          'x-rauhwpx-server-key': identity.key,
          'x-rauhwpx-stream-protocol': 'rauhwpx-sse-v1',
          'x-rauhwpx-content-sha256': protocolDigest,
          'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), identity.pair.privateKey).toString('base64url'),
        } });
      }
      if (url.pathname.endsWith(`/${sessionId}/timeline`)) {
        return signedBytes(request, identity, timelineBytes, { 'content-type': 'application/json' });
      }
      if (url.pathname.endsWith(`/v1/results/${sessionId}/download-confirmed`)) {
        resultConfirmations += 1;
        return signedJson(request, identity, {});
      }
      if (url.pathname.endsWith(`/v1/results/${sessionId}`)) {
        resultDownloads += 1;
        return signedBytes(request, identity, resultBytes);
      }
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);
  const unsubscribe = api.onCloudEvent(() => {});
  await api.cloudGetState({
    threadId: 'watch-result-thread', documentId: 'watch-result-document', selectedSessionId: sessionId,
  });
  await watchStarted.promise;

  const save = api.cloudSaveProfile({ profile: storedBrowserProfile(endpoint, identity.key) });
  await healthStarted.promise;
  releaseCompletedEvent();
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  releaseHealth.resolve();
  await assert.rejects(save, /지원하는 Rauhwpx Cloud 서버가 아닙니다/);
  unsubscribe();
  assert.equal(resultDownloads, 0);
  assert.equal(resultConfirmations, 0);
});

test('browser watcher cannot emit a profile A event after profile B activates', async (t) => {
  const identityA = serverIdentity();
  const identityB = serverIdentity();
  const endpointA = 'https://watch-a.example.test/rauhwpx-cloud';
  const endpointB = 'https://watch-b.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storeBrowserCredentials(storage, storedBrowserProfile(endpointA, identityA.key), {
    accessToken: 'watch-a-access', refreshToken: 'watch-a-refresh', accessExpiresAt: Date.now() + 60_000,
  });
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
  storeBrowserCredentials(storage, storedBrowserProfile(endpoint, identity.key), {
    accessToken: 'scope-access',
    refreshToken: 'scope-refresh',
    accessExpiresAt: Date.now() + 60_000,
    device: { id: 'this-device', name: 'This device' },
  });
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
  storeBrowserCredentials(storage, storedBrowserProfile(endpoint, identity.key), {
    accessToken: 'scope-access', refreshToken: 'scope-refresh', accessExpiresAt: Date.now() + 60_000,
  });
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

test('browser migrates a legacy profile without pairing its independently stored token', async () => {
  const identityA = serverIdentity();
  const identityB = serverIdentity();
  const endpointA = 'https://migrate-a.example.test/rauhwpx-cloud';
  const endpointB = 'https://migrate-b.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem(PROFILE_KEY, JSON.stringify(storedBrowserProfile(endpointA, identityA.key)));
  storage.setItem(TOKENS_KEY, JSON.stringify({
    accessToken: 'migrate-a-access', refreshToken: 'migrate-a-refresh', accessExpiresAt: Date.now() + 60_000,
  }));
  const observed: Array<{ host: string; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    observed.push({ host: url.host, authorization: request.headers.get('authorization') });
    const identity = url.host === new URL(endpointA).host ? identityA : identityB;
    return signedJson(request, identity, { sessions: [] });
  };

  const migrated = createBrowserCloudApi({ storage, fetchImpl });
  assert.ok(migrated);
  assert.equal(JSON.parse(storage.getItem(CREDENTIALS_KEY)!).profile.endpoint, endpointA);
  storage.setItem(PROFILE_KEY, JSON.stringify(storedBrowserProfile(endpointB, identityB.key)));
  storage.setItem(TOKENS_KEY, JSON.stringify({
    accessToken: 'migrate-b-access', refreshToken: 'migrate-b-refresh', accessExpiresAt: Date.now() + 60_000,
  }));

  const restarted = createBrowserCloudApi({ storage, fetchImpl });
  assert.ok(restarted);
  const snapshot = await restarted.cloudGetState({ threadId: 'migrate-a', documentId: null });
  assert.equal(((snapshot.profile as { profile: { endpoint: string } }).profile).endpoint, endpointA);
  assert.equal(JSON.parse(storage.getItem(CREDENTIALS_KEY)!).tokens, null);
  assert.deepEqual(observed, []);
  assert.equal(storage.getItem(PROFILE_KEY), null);
  assert.equal(storage.getItem(TOKENS_KEY), null);
});

test('browser migration preserves a valid pinned legacy profile when legacy token JSON is malformed', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://malformed-legacy.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem(PROFILE_KEY, JSON.stringify(storedBrowserProfile(endpoint, identity.key)));
  storage.setItem(TOKENS_KEY, '{malformed');
  let requests = 0;
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async () => {
      requests += 1;
      throw new Error('An unpaired profile must not make requests');
    },
  });
  assert.ok(api);

  const snapshot = await api.cloudGetState({ threadId: 'legacy', documentId: null });
  assert.equal(((snapshot.profile as { profile: { endpoint: string } }).profile).endpoint, endpoint);
  assert.equal(JSON.parse(storage.getItem(CREDENTIALS_KEY)!).tokens, null);
  assert.equal(storage.getItem(PROFILE_KEY), null);
  assert.equal(storage.getItem(TOKENS_KEY), null);
  assert.equal(requests, 0);
});

test('browser rejects malformed authoritative profiles before issuing a request', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://validated-profile.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storage.setItem(CREDENTIALS_KEY, JSON.stringify({
    profile: {
      ...storedBrowserProfile(endpoint, identity.key),
      endpoint,
      transport: { kind: 'https', endpoint: 'https://different.example.test/rauhwpx-cloud' },
    },
    tokens: {
      accessToken: 'unsafe-access', refreshToken: 'unsafe-refresh', accessExpiresAt: Date.now() + 60_000,
    },
  }));
  let requests = 0;
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async () => {
      requests += 1;
      throw new Error('Malformed credentials must not make requests');
    },
  });
  assert.ok(api);

  const snapshot = await api.cloudGetState({ threadId: 'invalid', documentId: null });
  assert.equal((snapshot.profile as { kind: string }).kind, 'unconfigured');
  assert.equal(requests, 0);
});

test('browser retries a verified rotated-token commit without refreshing the predecessor twice', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://pending-refresh.example.test/rauhwpx-cloud';
  const storage = new ThrowingStorage();
  storage.setItem(CREDENTIALS_KEY, JSON.stringify({
    profile: storedBrowserProfile(endpoint, identity.key),
    tokens: {
      accessToken: 'pending-old-access', refreshToken: 'pending-old-refresh', accessExpiresAt: Date.now() - 1,
    },
  }));
  let refreshCalls = 0;
  let sessionCalls = 0;
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/token/refresh')) {
        refreshCalls += 1;
        assert.equal((await request.json() as { refreshToken: string }).refreshToken, 'pending-old-refresh');
        return signedJson(request, identity, {
          accessToken: 'pending-new-access', refreshToken: 'pending-new-refresh',
          accessExpiresAt: Date.now() + 60_000,
        });
      }
      if (url.pathname.endsWith('/v1/sessions')) {
        sessionCalls += 1;
        assert.equal(request.headers.get('authorization'), 'Bearer pending-new-access');
        return signedJson(request, identity, { sessions: [] });
      }
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);
  storage.failNextSet(CREDENTIALS_KEY);

  const failed = await api.cloudGetState({ threadId: 'pending', documentId: null });
  assert.equal((failed.profile as { connection: string }).connection, 'error');
  assert.equal(JSON.parse(storage.getItem(CREDENTIALS_KEY)!).tokens.refreshToken, 'pending-old-refresh');
  const recovered = await api.cloudGetState({ threadId: 'pending', documentId: null });
  assert.equal((recovered.profile as { connection: string }).connection, 'ready');
  assert.equal(JSON.parse(storage.getItem(CREDENTIALS_KEY)!).tokens.refreshToken, 'pending-new-refresh');
  assert.equal(refreshCalls, 1);
  assert.equal(sessionCalls, 1);
});

test('two browser tabs serialize credential commits and preserve the latest same-server pairing', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://two-tab-lock.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  const lockManager = new MemoryLockManager();
  storage.setItem(CREDENTIALS_KEY, JSON.stringify({
    profile: storedBrowserProfile(endpoint, identity.key),
    tokens: {
      accessToken: 'two-tab-old-access', refreshToken: 'two-tab-old-refresh', accessExpiresAt: Date.now() + 60_000,
    },
  }));
  const firstHealthStarted = Promise.withResolvers<void>();
  const releaseFirstHealth = Promise.withResolvers<void>();
  let healthCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/v1/health')) {
      healthCalls += 1;
      if (healthCalls === 1) {
        firstHealthStarted.resolve();
        await releaseFirstHealth.promise;
      }
      return new Response(JSON.stringify({
        ok: true, version: '1.1.0', protocolVersion: 1, serverPublicKey: identity.key,
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname.endsWith('/v1/pairing/redeem')) {
      return signedJson(request, identity, {
        accessToken: 'two-tab-new-access', refreshToken: 'two-tab-new-refresh',
        accessExpiresAt: Date.now() + 60_000,
      });
    }
    if (url.pathname.endsWith('/v1/sessions')) return signedJson(request, identity, { sessions: [] });
    throw new Error(`Unexpected request ${request.method} ${url}`);
  };
  const tabA = createBrowserCloudApi({ storage, lockManager, fetchImpl });
  const tabB = createBrowserCloudApi({ storage, lockManager, fetchImpl });
  assert.ok(tabA);
  assert.ok(tabB);

  const save = tabA.cloudSaveProfile({ profile: storedBrowserProfile(endpoint, identity.key) });
  await firstHealthStarted.promise;
  await tabB.cloudPair({
    code: 'ABCD-EFGH-IJKL',
    profile: storedBrowserProfile(endpoint, identity.key),
  });
  releaseFirstHealth.resolve();
  await save;

  const authoritative = JSON.parse(storage.getItem(CREDENTIALS_KEY)!);
  assert.equal(authoritative.tokens.refreshToken, 'two-tab-new-refresh');
  assert.equal(lockManager.maximumActive, 1);
});

test('browser storage events advance authority and abort stale watchers from another tab', async () => {
  const identityA = serverIdentity();
  const identityB = serverIdentity();
  const endpointA = 'https://storage-event-a.example.test/rauhwpx-cloud';
  const endpointB = 'https://storage-event-b.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  const storageEvents = new MemoryStorageEvents();
  storage.setItem(CREDENTIALS_KEY, JSON.stringify({
    profile: storedBrowserProfile(endpointA, identityA.key),
    tokens: {
      accessToken: 'storage-a-access', refreshToken: 'storage-a-refresh', accessExpiresAt: Date.now() + 60_000,
    },
  }));
  const watcherStarted = Promise.withResolvers<void>();
  const watcherAborted = Promise.withResolvers<void>();
  const session = {
    id: 'storage-event-session', stateVersion: 2, status: 'running', persistent: true,
    clientContext: { threadId: 'storage-thread', documentId: 'storage-document' },
    originDocument: { name: 'storage.hwpx', sha256: 'a'.repeat(64), size: 1 },
    limits: { maxDurationSeconds: 60, maxTurns: 10 },
  };
  const api = createBrowserCloudApi({
    storage,
    storageEvents,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.host === new URL(endpointA).host && url.pathname.endsWith('/v1/sessions')) {
        return signedJson(request, identityA, { sessions: [session] });
      }
      if (url.host === new URL(endpointA).host && url.pathname.endsWith('/timeline')) {
        return signedJson(request, identityA, { schema: 'timeline', thread: { messages: [] } });
      }
      if (url.host === new URL(endpointA).host && url.pathname.endsWith('/events')) {
        watcherStarted.resolve();
        request.signal.addEventListener('abort', () => watcherAborted.resolve(), { once: true });
        const protocolDigest = digest(Buffer.from('rauhwpx-sse-v1'));
        const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
        const canonical = `RAUHWpx-response-v1\n${nonce}\nGET\n${url.pathname}${url.search}\n200\n${protocolDigest}`;
        return new Response(new ReadableStream<Uint8Array>(), { headers: {
          'content-type': 'text/event-stream',
          'x-rauhwpx-server-key': identityA.key,
          'x-rauhwpx-stream-protocol': 'rauhwpx-sse-v1',
          'x-rauhwpx-content-sha256': protocolDigest,
          'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), identityA.pair.privateKey).toString('base64url'),
        } });
      }
      if (url.host === new URL(endpointB).host && url.pathname.endsWith('/v1/sessions')) {
        assert.equal(request.headers.get('authorization'), 'Bearer storage-b-access');
        return signedJson(request, identityB, { sessions: [] });
      }
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);
  const before = await api.cloudGetState({
    threadId: 'storage-thread', documentId: 'storage-document', selectedSessionId: session.id,
  });
  await watcherStarted.promise;
  storage.setItem(CREDENTIALS_KEY, JSON.stringify({
    profile: storedBrowserProfile(endpointB, identityB.key),
    tokens: {
      accessToken: 'storage-b-access', refreshToken: 'storage-b-refresh', accessExpiresAt: Date.now() + 60_000,
    },
  }));
  storageEvents.emit(storage);
  const after = await api.cloudGetState({ threadId: 'storage-thread', documentId: 'storage-document' });

  await watcherAborted.promise;
  assert.equal(after.profileEpoch, before.profileEpoch + 1);
  assert.equal(((after.profile as { profile: { endpoint: string } }).profile).endpoint, endpointB);
  assert.equal((after.session as { kind: string }).kind, 'idle');
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
  storeBrowserCredentials(storage, storedBrowserProfile(endpointA, identityA.key), {
    accessToken: 'state-a-access',
    refreshToken: 'state-a-refresh',
    accessExpiresAt: Date.now() + 60_000,
    device: { id: 'device-a' },
  });
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
  storeBrowserCredentials(storage, storedBrowserProfile(endpoint, identity.key), {
    accessToken: 'old-access', refreshToken: 'old-refresh', accessExpiresAt: Date.now() + 60_000,
    device: { id: 'old-device' },
  });
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
  storeBrowserCredentials(storage, storedBrowserProfile(endpoint, identity.key), {
    accessToken: 'takeover-access', refreshToken: 'takeover-refresh',
    accessExpiresAt: Date.now() + 60_000,
  });
  let operationId = 'takeover-operation-a';
  const apiFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/v1/sessions')) {
      return signedJson(request, identity, { sessions: [{
        id: 'takeover-session', stateVersion: 4, status: 'cancelled', takeoverReady: true,
        clientContext: { documentId: 'takeover-document', threadId: 'takeover-thread' },
        originDocument: { name: 'takeover.hwpx', sha256: 'a'.repeat(64), size: 1 },
      }] });
    }
    if (url.pathname.endsWith('/v1/sessions/takeover-session/takeover')) {
      return signedJson(request, identity, { status: 'ready', boundary: { operationId } });
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
  snapshot = await api.cloudCompleteTakeover({
    sessionId: 'takeover-session', operationId: 'takeover-operation-a',
  });
  assert.equal((snapshot.lease as { owner: string }).owner, 'local');
  snapshot = await api.cloudGetState({
    threadId: 'takeover-thread', documentId: 'takeover-document', selectedSessionId: 'takeover-session',
  });
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
  snapshot = await future.cloudCompleteTakeover({
    sessionId: 'takeover-session', operationId: 'takeover-operation-a',
  });
  assert.equal((snapshot.session as { kind: string }).kind, 'taking-over');
  assert.equal((snapshot.lease as { owner: string }).owner, 'cloud');
});

test('browser takeover reuses its frozen receipt after a partial artifact failure', async () => {
  const identity = serverIdentity();
  const endpoint = 'https://takeover-retry.example.test/rauhwpx-cloud';
  const storage = new MemoryStorage();
  storeBrowserCredentials(storage, storedBrowserProfile(endpoint, identity.key), {
    accessToken: 'takeover-retry-access', refreshToken: 'takeover-retry-refresh',
    accessExpiresAt: Date.now() + 60_000, device: { id: 'device-a' },
  });
  const sessionId = 'takeover-retry-session';
  const operationId = 'turn_takeover_retry';
  const futureOperationId = 'turn_takeover_future';
  const checkpointBytes = new TextEncoder().encode('takeover-checkpoint');
  const futureCheckpointBytes = new TextEncoder().encode('future-takeover-checkpoint');
  const timelineBytes = new TextEncoder().encode(JSON.stringify({
    schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: '2026-08-30T00:00:00.000Z',
    thread: {
      id: 'takeover-thread', title: 'Takeover', titleRequested: true, createdAt: 1, updatedAt: 2,
      agent: 'codex', model: 'gpt-5.6', effort: 'high', workflow: 'direct', docKey: 'takeover.hwpx',
      documentId: 'takeover-document', activeTemplateId: null, messages: [],
    },
  }));
  const futureTimelineBytes = new TextEncoder().encode(JSON.stringify({
    schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: '2026-08-30T00:01:00.000Z',
    thread: {
      id: 'takeover-thread', title: 'Future takeover', titleRequested: true, createdAt: 1, updatedAt: 3,
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
  const futureBoundary = {
    operationId: futureOperationId,
    revision: 8,
    turnNumber: 5,
    checkpoint: { blobId: digest(futureCheckpointBytes), size: futureCheckpointBytes.byteLength },
    timeline: { blobId: digest(futureTimelineBytes), size: futureTimelineBytes.byteLength },
  };
  const session = {
    id: sessionId, stateVersion: 5, status: 'cancelled', takeoverReady: true,
    clientContext: { documentId: 'takeover-document', threadId: 'takeover-thread' },
    originDocument: { name: 'takeover.hwpx', sha256: 'a'.repeat(64), size: checkpointBytes.byteLength },
  };
  let takeoverCommands = 0;
  let checkpointDownloads = 0;
  let futureBoundaryActive = false;
  const api = createBrowserCloudApi({
    storage,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/sessions')) {
        return signedJson(request, identity, { sessions: [] });
      }
      if (url.pathname.endsWith(`/${sessionId}/takeover`)) {
        if (futureBoundaryActive) {
          return signedJson(request, identity, { status: 'ready', boundary: futureBoundary });
        }
        return signedJson(request, identity, {
          error: { code: 'TAKEOVER_NOT_REQUESTED', message: 'No receipt' },
        }, 404);
      }
      if (url.pathname.endsWith(`/${sessionId}/commands`)) {
        const body = await request.json() as { type?: string };
        if (body.type === 'session.pause') {
          futureBoundaryActive = true;
          return signedJson(request, identity, {
            session: { ...session, takeoverBoundary: futureBoundary },
          });
        }
        takeoverCommands += 1;
        return signedJson(request, identity, { session, takeover: { status: 'ready', boundary } });
      }
      if (url.pathname.endsWith(`/${sessionId}/checkpoint`)) {
        checkpointDownloads += 1;
        if (url.searchParams.get('operationId') === futureOperationId) {
          return signedBytes(request, identity, futureCheckpointBytes, {
            'x-boundary-operation': futureOperationId,
            'x-boundary-kind': 'turn',
            'x-checkpoint-revision': '8',
            'x-checkpoint-turn': '5',
            'x-document-name': encodeURIComponent('takeover.hwpx'),
          });
        }
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
        const bytes = futureBoundaryActive ? futureTimelineBytes : timelineBytes;
        const activeBoundary = futureBoundaryActive ? futureBoundary : boundary;
        return signedBytes(request, identity, bytes, {
          'content-type': 'application/json',
          'x-boundary-operation': String(activeBoundary.operationId),
          'x-boundary-revision': String(activeBoundary.revision),
          'x-boundary-turn': String(activeBoundary.turnNumber),
        });
      }
      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });
  assert.ok(api);
  await api.cloudGetState({
    threadId: 'takeover-thread', documentId: 'takeover-document', selectedSessionId: sessionId,
  });
  const request = { sessionId, command: 'takeover' as const, expectedVersion: 4 };
  await assert.rejects(api.cloudCommand(request), /offline/);
  const snapshot = await api.cloudCommand(request);
  assert.equal(takeoverCommands, 1);
  assert.equal(checkpointDownloads, 2);
  assert.equal((snapshot.takeover as { operationId: string }).operationId, operationId);
  assert.deepEqual((snapshot.takeover as { document: { bytes: Uint8Array } }).document.bytes, checkpointBytes);

  let future = await api.cloudCommand({ sessionId, command: 'pause', expectedVersion: 5 });
  assert.equal((future.session as { kind: string }).kind, 'taking-over');
  future = await api.cloudCompleteTakeover({ sessionId, operationId });
  assert.equal((future.session as { kind: string }).kind, 'taking-over');
  assert.equal((future.lease as { owner: string }).owner, 'cloud');
  future = await api.cloudCommand({ sessionId, command: 'takeover', expectedVersion: 5 });
  assert.equal((future.takeover as { operationId: string }).operationId, futureOperationId);
  assert.deepEqual(
    (future.takeover as { document: { bytes: Uint8Array } }).document.bytes,
    futureCheckpointBytes,
  );
  assert.equal(takeoverCommands, 1);
  assert.equal(checkpointDownloads, 3);
});


test('browser question starts and workflow changes require an explicit supportedWorkflows array', async (t) => {
  for (const capability of [undefined, null, 'question', { question: true }, ['direct', 'plan'], ['direct', 'plan', 'question']]) {
    await t.test(JSON.stringify(capability) ?? 'absent', async () => {
      const identity = serverIdentity();
      const endpoint = 'https://question-capability.example.test';
      const storage = new MemoryStorage();
      storeBrowserCredentials(storage, storedBrowserProfile(endpoint, identity.key), {
        accessToken: 'question-access', refreshToken: 'question-refresh', accessExpiresAt: Date.now() + 600_000,
      });
      const writes: Array<{ path: string; body: any }> = [];
      const api = createBrowserCloudApi({
        storage,
        fetchImpl: async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path.endsWith('/v1/health')) {
            return signedJson(request, identity, {
              conversationProtocolVersion: 2,
              ...(capability === undefined ? {} : { supportedWorkflows: capability }),
            });
          }
          const body = await request.json();
          writes.push({ path, body });
          if (path.endsWith('/v1/uploads/init')) return signedJson(request, identity, { blobExists: true });
          if (path.endsWith('/commands')) return signedJson(request, identity, { accepted: true });
          if (path.endsWith('/v1/sessions')) throw new Error('creation captured');
          throw new Error(`Unexpected request: ${path}`);
        },
      });
      assert.ok(api);
      const acceptsQuestion = Array.isArray(capability) && capability.includes('question');
      const transfer = {
        startId: 'question-browser-start', threadId: 'question-thread', documentId: 'question-doc',
        documentName: 'question.hwpx', agent: 'codex' as const, model: 'gpt-6-astra', effort: 'high',
        workflow: 'question' as const, permissionProfile: 'unrestricted' as const,
        timeline: { schema: 'rauhwpx.cloud.timeline' as const, version: 1 as const,
          exportedAt: new Date().toISOString(), thread: { id: 'question-thread', messages: [] } } as any,
        initialMessage: { id: 'question-message', text: 'Discuss this document without editing.', attachmentReferenceIds: [] },
        document: { bytes: new Uint8Array([1, 2, 3]), fileName: 'question.hwpx', sha256: 'a'.repeat(64) },
        references: [], limits: { maxDurationMs: 60_000, maxTurns: 10 },
      };
      const command = { sessionId: 'question-browser-start', command: 'workflow' as const,
        expectedVersion: 1, payload: { workflow: 'question' },
        attachments: [{ id: 'question-attachment', name: 'note.txt', mimeType: 'text/plain', size: 1, bytes: new Uint8Array([1]) }],
      };
      if (!acceptsQuestion) {
        for (const operation of [() => api.cloudTransfer(transfer), () => api.cloudCommand(command)]) {
          await assert.rejects(operation(), (error: any) => error.code === 'CLOUD_RUNTIME_OUTDATED' && error.retryable === false);
          assert.deepEqual(writes, [], 'unsupported question mode must reject before uploads or commands');
        }
      } else {
        await assert.rejects(api.cloudTransfer(transfer), /creation captured/);
        assert.equal(writes.find((write) => write.path.endsWith('/v1/sessions'))?.body.executionConfig.workflow, 'question');
        await api.cloudCommand(command);
        assert.equal(writes.find((write) => write.path.endsWith('/commands'))?.body.payload.workflow, 'question');
      }
      writes.length = 0;
      await api.cloudCommand({ sessionId: 'question-browser-start', command: 'workflow', expectedVersion: 1, payload: { workflow: 'plan' } });
      assert.equal(writes.at(-1)?.body.payload.workflow, 'plan', 'older servers must retain plan mode compatibility');
    });
  }
});

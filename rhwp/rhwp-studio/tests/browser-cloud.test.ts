import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { createBrowserCloudApi } from '../src/cloud/browser-cloud.ts';

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
      'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), identity.pair.privateKey).toString('base64url'),
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
  const event = await live;
  assert.equal(event.sessionId, sessionId);
  assert.equal(((event.event as Record<string, unknown>).payload as Record<string, unknown>).type, 'agent');
  unsubscribe();
  assert.equal(streamCalls, 1);
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
  await stale;
  assert.deepEqual(observed, [{ host: new URL(endpointA).host, token: 'profile-a-refresh' }]);
  assert.equal(storage.getItem('rauhwpx.cloud.browser.tokens.v1'), null);
  assert.equal(JSON.parse(storage.getItem('rauhwpx.cloud.browser.profile.v1')!).endpoint, endpointB);
});

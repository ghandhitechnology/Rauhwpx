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

class MemoryStorageEvents {
  #listeners = new Set<(event: { key: string; storageArea: Storage }) => void>();
  addEventListener(_type: 'storage', listener: (event: { key?: string | null; storageArea?: Storage | null }) => void) {
    this.#listeners.add(listener as (event: { key: string; storageArea: Storage }) => void);
  }
  emit(storageArea: Storage, key: string) {
    for (const listener of this.#listeners) listener({ key, storageArea });
  }
}

const sessionId = 'session_browser_display_01';
const streamId = 'stream-browser-display-01';
const credentialsKey = 'rauhwpx.cloud.browser.credentials.v2';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function waitFor<T>(predicate: () => T | undefined | false, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const check = () => {
      const result = predicate();
      if (result) resolve(result);
      else if (Date.now() >= deadline) reject(new Error(`Timed out waiting for ${message}`));
      else setTimeout(check, 5);
    };
    check();
  });
}

function displayFixture({
  unsupported = false,
  tamper = false,
  streamMissingOnce = false,
  blockFirstCapability = false,
  blockRefresh = false,
  oversizedCapability = false,
  oversizedInterest = false,
  failSecondHealth = false,
  inlineFrameCount = 0,
  oversizedEvent = false,
} = {}) {
  const identity = generateKeyPairSync('ed25519');
  const serverPublicKey = `ed25519:${identity.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;
  const endpoint = 'https://cloud.example.test/rauhwpx-cloud';
  const frameBytes = inlineFrameCount ? Buffer.alloc(524288, 1) : Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);
  const frameDigest = digest(frameBytes);
  const interests: Array<{ streamId: string; viewerId: string; active: boolean }> = [];
  const inputs: Array<{ streamId: string; viewerId: string; sequence: number; event: unknown }> = [];
  let streamCalls = 0;
  let capabilityCalls = 0;
  let streamAborted = false;
  const firstCapabilityStarted = Promise.withResolvers<void>();
  const releaseCapabilityCleanup = Promise.withResolvers<void>();
  const secondCapabilityStarted = Promise.withResolvers<void>();
  const refreshStarted = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<void>();
  let refreshCalls = 0;
  let healthCalls = 0;

  const signed = (
    request: Request,
    bytes: Uint8Array,
    status = 200,
    headers: HeadersInit = {},
    proofDigest = digest(bytes),
  ) => {
    const url = new URL(request.url);
    const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
    const canonical = `RAUHWpx-response-v1\n${nonce}\n${request.method}\n${url.pathname}${url.search}\n${status}\n${proofDigest}`;
    return new Response(bytes, {
      status,
      headers: {
        'x-rauhwpx-server-key': serverPublicKey,
        'x-rauhwpx-content-sha256': proofDigest,
        'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), identity.privateKey).toString('base64url'),
        ...headers,
      },
    });
  };
  const json = (request: Request, value: unknown, status = 200) => signed(
    request,
    Buffer.from(JSON.stringify(value)),
    status,
    { 'content-type': 'application/json' },
  );

  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/v1/health')) {
      healthCalls += 1;
      if (failSecondHealth && healthCalls === 2) {
        return new Response(JSON.stringify({ ok: true, protocolVersion: 0 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        ok: true, version: '1.1.0', protocolVersion: 1, serverPublicKey, serverId: 'display-browser',
      }), { headers: { 'content-type': 'application/json', 'x-rauhwpx-server-key': serverPublicKey } });
    }
    if (url.pathname.endsWith('/v1/pairing/redeem')) {
      return json(request, {
        accessToken: 'browser-display-access',
        refreshToken: 'browser-display-refresh',
        accessExpiresAt: Date.now() + 60_000,
        device: { id: 'browser-display-device' },
      });
    }
    if (url.pathname.endsWith('/v1/token/refresh')) {
      refreshCalls += 1;
      refreshStarted.resolve();
      if (blockRefresh) await releaseRefresh.promise;
      return json(request, {
        accessToken: 'browser-display-refreshed-access',
        refreshToken: 'browser-display-refreshed-refresh',
        accessExpiresAt: Date.now() + 60_000,
      });
    }
    if (url.pathname.endsWith('/v1/sessions')) return json(request, { sessions: [] });
    if (url.pathname.endsWith(`/v1/sessions/${sessionId}/display`)) {
      if (unsupported) {
        return json(request, { error: { code: 'NOT_FOUND', message: 'Endpoint was not found' } }, 404);
      }
      capabilityCalls += 1;
      if (blockFirstCapability && capabilityCalls === 1) {
        firstCapabilityStarted.resolve();
        await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        await releaseCapabilityCleanup.promise;
        throw request.signal.reason;
      }
      if (capabilityCalls === 2) secondCapabilityStarted.resolve();
      return json(request, {
        kind: 'available', protocol: 'rauhwpx-frame-v1', sessionId,
        streamId: streamMissingOnce && capabilityCalls > 1 ? `${streamId}-replacement` : streamId,
        width: 1280, height: 800,
        maxFrameBytes: oversizedCapability ? 524287 : 524288,
        maxFps: 12,
        inputProtocol: 'rauhwpx-input-v1',
        maxInputEventsPerSecond: 60,
        ...(oversizedCapability ? { padding: 'x'.repeat(2 * 1024 * 1024) } : {}),
      });
    }
    if (url.pathname.endsWith(`/v1/sessions/${sessionId}/display/interest`)) {
      const body = await request.json() as { active: boolean; streamId: string; viewerId: string };
      interests.push(body);
      return json(request, {
        streamId: body.streamId,
        interested: body.active,
        expiresAt: body.active ? '2026-08-30T00:00:20.000Z' : null,
        maxFps: body.active ? 12 : 0,
        ...(oversizedInterest ? { padding: 'x'.repeat(2 * 1024 * 1024) } : {}),
      });
    }
    if (url.pathname.endsWith(`/v1/sessions/${sessionId}/display/input`)) {
      const body = await request.json() as typeof inputs[number];
      inputs.push(body);
      return json(request, {
        streamId: body.streamId,
        viewerId: body.viewerId,
        sequence: body.sequence,
        accepted: true,
        acceptedAt: '2026-08-30T00:00:02.000Z',
      }, 202);
    }
    if (url.pathname.endsWith(`/v1/sessions/${sessionId}/display/frames`) && url.search) {
      streamCalls += 1;
      if (streamMissingOnce && streamCalls === 1) {
        return json(request, {
          error: {
            code: 'DISPLAY_STREAM_NOT_FOUND',
            message: 'Display stream was replaced',
            retryable: false,
          },
        }, 404);
      }
      const requestedStreamId = url.searchParams.get('streamId') ?? streamId;
      const nonce = request.headers.get('x-rauhwpx-request-nonce') ?? '';
      const frame = Buffer.concat(Array.from({ length: inlineFrameCount || 1 }, (_, index) => {
        const sequence = index + 1;
        const metadata = {
          streamId: requestedStreamId,
          sequence,
          capturedAt: '2026-08-30T00:00:01.000Z',
          width: 1280,
          height: 800,
          mimeType: 'image/jpeg',
          byteLength: frameBytes.length,
          sha256: frameDigest,
          framePath: `/v1/sessions/${sessionId}/display/frames/${requestedStreamId}/${sequence}`,
          ...(inlineFrameCount ? { bytesBase64: frameBytes.toString('base64') } : {}),
        };
        const data = JSON.stringify({ sessionId, seq: sequence, type: 'display.frame', payload: metadata });
        const eventDigest = digest(Buffer.from(data));
        const canonicalEvent = `RAUHWpx-sse-event-v1\n${nonce}\nGET\n${url.pathname}${url.search}\n200\n${sequence}\ndisplay.frame\n${eventDigest}`;
        const eventSignature = sign(null, Buffer.from(canonicalEvent), identity.privateKey).toString('base64url');
        return new TextEncoder().encode([
          ...(oversizedEvent ? [`:${'x'.repeat(2 * 1024 * 1024)}`] : []),
          `id: ${sequence}`,
          'event: display.frame',
          `rauhwpx-sha256: ${eventDigest}`,
          `rauhwpx-signature: ${tamper ? `${eventSignature[0] === 'A' ? 'B' : 'A'}${eventSignature.slice(1)}` : eventSignature}`,
          `data: ${data}`,
          '',
          '',
        ].join('\n'));
      }));
      const protocolDigest = digest(Buffer.from('rauhwpx-sse-v1'));
      const canonicalResponse = `RAUHWpx-response-v1\n${nonce}\nGET\n${url.pathname}${url.search}\n200\n${protocolDigest}`;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame);
          request.signal.addEventListener('abort', () => {
            streamAborted = true;
            try { controller.error(request.signal.reason); } catch {}
          }, { once: true });
        },
      });
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'x-rauhwpx-server-key': serverPublicKey,
          'x-rauhwpx-stream-protocol': 'rauhwpx-sse-v1',
          'x-rauhwpx-content-sha256': protocolDigest,
          'x-rauhwpx-response-signature': sign(null, Buffer.from(canonicalResponse), identity.privateKey).toString('base64url'),
        },
      });
    }
    if (url.pathname.includes(`/v1/sessions/${sessionId}/display/frames/`) && url.pathname.endsWith('/1')) {
      return signed(request, frameBytes, 200, {
        'content-type': 'image/jpeg',
        'content-length': String(frameBytes.length),
        'x-content-sha256': frameDigest,
      });
    }
    throw new Error(`Unexpected browser display request: ${request.method} ${url.pathname}${url.search}`);
  };

  return {
    endpoint,
    fetchImpl,
    serverPublicKey,
    interests,
    inputs,
    streamCalls: () => streamCalls,
    streamAborted: () => streamAborted,
    firstCapabilityStarted: firstCapabilityStarted.promise,
    releaseCapabilityCleanup: () => releaseCapabilityCleanup.resolve(),
    secondCapabilityStarted: secondCapabilityStarted.promise,
    refreshStarted: refreshStarted.promise,
    releaseRefresh: () => releaseRefresh.resolve(),
    refreshCalls: () => refreshCalls,
  };
}

async function pairedApi(fixture: ReturnType<typeof displayFixture>) {
  const api = createBrowserCloudApi({
    fetchImpl: fixture.fetchImpl,
    storage: new MemoryStorage(),
    display: { retryBaseMs: 1, retryMaxMs: 2 },
  });
  assert.ok(api);
  await api.cloudPair({
    code: 'ABCD-EFGH-IJKL',
    profile: {
      name: 'Browser display VPS',
      host: 'cloud.example.test',
      sshUser: 'ubuntu',
      sshPort: 22,
      auth: { kind: 'ssh-agent' },
      transport: { kind: 'https', endpoint: fixture.endpoint },
      serverPublicKey: fixture.serverPublicKey,
    },
  });
  return api;
}

test('browser display verifies capability-to-frame and releases only its own interest on close', async () => {
  const fixture = displayFixture();
  const api = await pairedApi(fixture);
  const events: unknown[] = [];
  const unsubscribe = api.onCloudDisplayEvent((event) => events.push(event));
  const opened = await api.cloudOpenDisplay({ sessionId });
  assert.equal(opened.capability.kind, 'available');
  const frameEnvelope = await waitFor(() => events.find((value) => {
    const event = value as { event?: { kind?: string } };
    return event.event?.kind === 'frame';
  }), 'verified browser frame') as { event: { bytes: Uint8Array; sessionId: string; streamId: string; sequence: number } };
  assert.deepEqual(frameEnvelope.event.bytes, new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]));
  assert.equal(frameEnvelope.event.sessionId, sessionId);
  assert.equal(frameEnvelope.event.streamId, streamId);
  assert.equal(frameEnvelope.event.sequence, 1);
  await api.cloudDisplayInput({
    connectionId: opened.connectionId,
    event: { kind: 'pointer', action: 'down', x: 640, y: 400, button: 'left' },
  });
  assert.deepEqual(fixture.inputs.map(({ sequence, event }) => ({ sequence, event })), [{
    sequence: 1,
    event: { kind: 'pointer', action: 'down', x: 640, y: 400, button: 'left' },
  }]);
  await api.cloudCloseDisplay({ connectionId: opened.connectionId });
  assert.deepEqual(fixture.interests.map(({ active }) => active), [true, false]);
  assert.equal(new Set(fixture.interests.map(({ viewerId }) => viewerId)).size, 1);
  assert.match(fixture.interests[0].viewerId, /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(fixture.streamAborted(), true);
  unsubscribe();
});

test('two browser tabs paired as one device keep independent viewer interest', async () => {
  const fixture = displayFixture();
  const firstApi = await pairedApi(fixture);
  const secondApi = await pairedApi(fixture);
  const first = await firstApi.cloudOpenDisplay({ sessionId });
  const second = await secondApi.cloudOpenDisplay({ sessionId });
  await waitFor(() => fixture.interests.filter(({ active }) => active).length === 2, 'two browser viewers');
  const activeViewers = fixture.interests.filter(({ active }) => active).map(({ viewerId }) => viewerId);
  assert.equal(new Set(activeViewers).size, 2);
  await firstApi.cloudCloseDisplay({ connectionId: first.connectionId });
  assert.ok(fixture.interests.some(({ viewerId, active }) => viewerId === activeViewers[0] && !active));
  assert.equal(fixture.interests.some(({ viewerId, active }) => viewerId === activeViewers[1] && !active), false);
  await secondApi.cloudCloseDisplay({ connectionId: second.connectionId });
  assert.ok(fixture.interests.some(({ viewerId, active }) => viewerId === activeViewers[1] && !active));
});

test('browser display returns server-unsupported for an older signed server route', async () => {
  const fixture = displayFixture({ unsupported: true });
  const api = await pairedApi(fixture);
  const opened = await api.cloudOpenDisplay({ sessionId });
  assert.deepEqual(opened.capability, {
    kind: 'unavailable',
    sessionId,
    reason: 'server-unsupported',
    message: 'This Cloud server does not support live display frames',
    retryable: false,
  });
  await api.cloudCloseDisplay({ connectionId: opened.connectionId });
  assert.deepEqual(fixture.interests, []);
});

test('browser display treats signed-SSE tampering as terminal and does not reconnect', async () => {
  const fixture = displayFixture({ tamper: true });
  const api = await pairedApi(fixture);
  const events: unknown[] = [];
  api.onCloudDisplayEvent((event) => events.push(event));
  const opened = await api.cloudOpenDisplay({ sessionId });
  await waitFor(() => events.find((value) => {
    const event = value as { event?: { kind?: string; state?: string } };
    return event.event?.kind === 'connection' && event.event.state === 'failed';
  }), 'terminal browser display failure');
  assert.equal(fixture.streamCalls(), 1);
  await api.cloudCloseDisplay({ connectionId: opened.connectionId });
  assert.deepEqual(fixture.interests.map(({ active }) => active), [true, false]);
});

test('browser display refreshes capability after a signed stream replacement response', async () => {
  const fixture = displayFixture({ streamMissingOnce: true });
  const api = await pairedApi(fixture);
  const events: unknown[] = [];
  api.onCloudDisplayEvent((event) => events.push(event));
  const opened = await api.cloudOpenDisplay({ sessionId });
  const frameEnvelope = await waitFor(() => events.find((value) => {
    const event = value as { event?: { kind?: string; streamId?: string } };
    return event.event?.kind === 'frame' && event.event.streamId === `${streamId}-replacement`;
  }), 'replacement browser frame');
  assert.ok(frameEnvelope);
  assert.equal(fixture.streamCalls(), 2);
  await api.cloudCloseDisplay({ connectionId: opened.connectionId });
});

test('browser display replacement awaits blocked capability cleanup', async () => {
  const fixture = displayFixture({ blockFirstCapability: true });
  const api = await pairedApi(fixture);
  const first = api.cloudOpenDisplay({ sessionId });
  await fixture.firstCapabilityStarted;
  const second = api.cloudOpenDisplay({ sessionId });
  const startedBeforeCleanup = await Promise.race([
    fixture.secondCapabilityStarted.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
  fixture.releaseCapabilityCleanup();
  await assert.rejects(first, (error) => error?.name === 'AbortError');
  const opened = await second;
  await api.cloudCloseDisplay({ connectionId: opened.connectionId });
  assert.equal(startedBeforeCleanup, false);
});

test('browser display aborts one refresh waiter without cancelling the shared refresh', async () => {
  const fixture = displayFixture({ blockRefresh: true });
  const storage = new MemoryStorage();
  storage.setItem(credentialsKey, JSON.stringify({
    profile: {
      name: 'Browser display VPS',
      host: 'cloud.example.test',
      sshUser: 'ubuntu',
      sshPort: 22,
      auth: { kind: 'ssh-agent' },
      transport: { kind: 'https', endpoint: fixture.endpoint },
      endpoint: fixture.endpoint,
      serverPublicKey: fixture.serverPublicKey,
    },
    tokens: {
      accessToken: 'browser-display-expired-access',
      refreshToken: 'browser-display-refresh',
      accessExpiresAt: Date.now() - 1,
    },
  }));
  const api = createBrowserCloudApi({
    fetchImpl: fixture.fetchImpl,
    storage,
    display: { retryBaseMs: 1, retryMaxMs: 2 },
  });
  assert.ok(api);
  const first = api.cloudOpenDisplay({ sessionId });
  const firstResult = first.then(() => null, (error) => error);
  await fixture.refreshStarted;
  const second = api.cloudOpenDisplay({ sessionId });
  assert.equal((await firstResult)?.name, 'AbortError');
  fixture.releaseRefresh();
  const opened = await second;
  assert.equal(fixture.refreshCalls(), 1);
  await api.cloudCloseDisplay({ connectionId: opened.connectionId });
});

test('browser display bounds capability and interest JSON before accepting proofs', async (t) => {
  await t.test('capability', async () => {
    const fixture = displayFixture({ oversizedCapability: true });
    const api = await pairedApi(fixture);
    await assert.rejects(
      api.cloudOpenDisplay({ sessionId }),
      (error) => error?.code === 'CLOUD_RESPONSE_TOO_LARGE',
    );
  });
  await t.test('interest', async () => {
    const fixture = displayFixture({ oversizedInterest: true });
    const api = await pairedApi(fixture);
    const events: unknown[] = [];
    api.onCloudDisplayEvent((event) => events.push(event));
    const opened = await api.cloudOpenDisplay({ sessionId });
    try {
      await waitFor(() => events.find((value) => {
        const event = value as { event?: { kind?: string; state?: string; code?: string } };
        return event.event?.kind === 'connection'
          && event.event.state === 'failed'
          && event.event.code === 'CLOUD_RESPONSE_TOO_LARGE';
      }), 'bounded interest failure');
    } finally {
      await api.cloudCloseDisplay({ connectionId: opened.connectionId });
    }
  });
});

test('browser profile activation closes and awaits the active display', async () => {
  const fixture = displayFixture();
  const api = await pairedApi(fixture);
  const opened = await api.cloudOpenDisplay({ sessionId });
  await waitFor(() => fixture.interests.some(({ active }) => active), 'active browser interest');
  await waitFor(() => fixture.streamCalls() > 0, 'active browser display stream');
  let released = false;
  try {
    await api.cloudSaveProfile({
      profile: {
        name: 'Updated browser VPS',
        host: 'cloud.example.test',
        sshUser: 'ubuntu',
        sshPort: 22,
        auth: { kind: 'ssh-agent' },
        transport: { kind: 'https', endpoint: fixture.endpoint },
        serverPublicKey: fixture.serverPublicKey,
      },
    });
    released = fixture.interests.at(-1)?.active === false;
  } finally {
    await api.cloudCloseDisplay({ connectionId: opened.connectionId });
  }
  assert.equal(released, true);
});

test('failed browser profile activation closes stale display work and allows reopening', async () => {
  const fixture = displayFixture({ failSecondHealth: true });
  const api = await pairedApi(fixture);
  const opened = await api.cloudOpenDisplay({ sessionId });
  await waitFor(() => fixture.interests.some(({ active }) => active), 'active browser interest');

  await assert.rejects(api.cloudSaveProfile({
    profile: {
      name: 'Invalid browser VPS',
      host: 'cloud.example.test',
      sshUser: 'ubuntu',
      sshPort: 22,
      auth: { kind: 'ssh-agent' },
      transport: { kind: 'https', endpoint: fixture.endpoint },
      serverPublicKey: fixture.serverPublicKey,
    },
  }), /지원하는 Rauhwpx Cloud 서버가 아닙니다/);
  let reopened: Awaited<ReturnType<typeof api.cloudOpenDisplay>> | null = null;
  try {
    assert.equal(fixture.interests.at(-1)?.active, false);
    reopened = await api.cloudOpenDisplay({ sessionId });
    assert.notEqual(reopened.connectionId, opened.connectionId);
  } finally {
    if (reopened) await api.cloudCloseDisplay({ connectionId: reopened.connectionId });
    else await api.cloudCloseDisplay({ connectionId: opened.connectionId });
  }
});

test('browser storage authority changes close an active display from the stale tab', async () => {
  const fixture = displayFixture();
  const storage = new MemoryStorage();
  const storageEvents = new MemoryStorageEvents();
  const api = createBrowserCloudApi({
    fetchImpl: fixture.fetchImpl,
    storage,
    storageEvents,
    display: { retryBaseMs: 1, retryMaxMs: 2 },
  });
  assert.ok(api);
  await api.cloudPair({
    code: 'ABCD-EFGH-IJKL',
    profile: {
      name: 'Browser display VPS',
      host: 'cloud.example.test',
      sshUser: 'ubuntu',
      sshPort: 22,
      auth: { kind: 'ssh-agent' },
      transport: { kind: 'https', endpoint: fixture.endpoint },
      serverPublicKey: fixture.serverPublicKey,
    },
  });
  const opened = await api.cloudOpenDisplay({ sessionId });
  await waitFor(() => fixture.interests.some(({ active }) => active), 'active browser interest');
  await waitFor(() => fixture.streamCalls() > 0, 'active browser display stream');
  const credentials = JSON.parse(storage.getItem(credentialsKey)!);
  storage.setItem(credentialsKey, JSON.stringify({
    ...credentials,
    tokens: { ...credentials.tokens, accessToken: 'other-tab-access' },
  }));
  storageEvents.emit(storage, credentialsKey);
  await api.cloudGetState({ threadId: '', documentId: null });

  assert.equal(fixture.interests.at(-1)?.active, false);
  assert.equal(fixture.streamAborted(), true);
  await api.cloudCloseDisplay({ connectionId: opened.connectionId });
});


test('browser display accepts buffered inline frames larger than the per-event limit together', async () => {
  const fixture = displayFixture({ inlineFrameCount: 4 });
  const api = await pairedApi(fixture);
  const events: Array<{ event?: { kind: string; sequence?: number; bytes?: Uint8Array } }> = [];
  const unsubscribe = api.onCloudDisplayEvent((event) => events.push(event as typeof events[number]));
  const opened = await api.cloudOpenDisplay({ sessionId });
  try {
    await waitFor(() => events.find(({ event }) => event?.kind === 'frame' && event.sequence === 4), 'four buffered inline frames');
    assert.deepEqual(events.filter(({ event }) => event?.kind === 'frame').map(({ event }) => event?.sequence), [1, 2, 3, 4]);
    assert.equal(events.filter(({ event }) => event?.kind === 'frame').every(({ event }) => event?.bytes?.byteLength === 524288), true);
    assert.equal(fixture.streamCalls(), 1);
  } finally {
    await api.cloudCloseDisplay({ connectionId: opened.connectionId });
    unsubscribe();
  }
});


test('browser display still rejects oversized individual events with ignored comment fields', async () => {
  const fixture = displayFixture({ oversizedEvent: true });
  const api = await pairedApi(fixture);
  const events: Array<{ event?: { kind: string; code?: string } }> = [];
  const unsubscribe = api.onCloudDisplayEvent((event) => events.push(event as typeof events[number]));
  const opened = await api.cloudOpenDisplay({ sessionId });
  try {
    await waitFor(() => events.find(({ event }) => event?.code === 'SSE_PAYLOAD_INVALID'), 'oversized event failure');
    assert.equal(events.some(({ event }) => event?.kind === 'frame'), false);
    assert.equal(fixture.streamCalls(), 1);
  } finally {
    await api.cloudCloseDisplay({ connectionId: opened.connectionId });
    unsubscribe();
  }
});

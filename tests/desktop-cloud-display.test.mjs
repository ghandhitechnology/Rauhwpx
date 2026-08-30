import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CloudClient } from '../desktop/cloud-client.mjs';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';
import {
  MAX_DISPLAY_FRAME_BYTES,
  openCloudDisplay,
  parseDisplayCapability,
  parseDisplayFrameMetadata,
} from '../desktop/cloud-display.mjs';
import { CloudDisplayRegistry } from '../desktop/cloud-display-registry.mjs';
import { normalizeCloudProfile } from '../desktop/cloud-profile.mjs';
import {
  invalidDisplayCapabilities,
  invalidDisplayMetadata,
  validDisplayCapability,
} from '../rhwp/rhwp-studio/tests/cloud-display-parity-fixtures.ts';

const IDENTITY = generateKeyPairSync('ed25519');
const SERVER_KEY = `ed25519:${IDENTITY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;
const PROFILE = normalizeCloudProfile({
  endpoint: 'https://cloud.example.test/rauhwpx-cloud',
  transport: 'public-https',
  ssh: { host: 'cloud.example.test', user: 'cloud', useTailscaleSsh: false },
  serverPublicKey: SERVER_KEY,
});
const SESSION_ID = 'session_display_01';
const STREAM_ID = 'stream-display-01';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function memoryVault() {
  const values = new Map();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); return true; },
    delete: async (key) => values.delete(key),
  };
}

async function clientWith(fetchImpl) {
  const client = new CloudClient({ vault: memoryVault(), fetchImpl });
  await client.activateProfile(PROFILE, {
    tokens: {
      accessToken: 'display-access',
      refreshToken: 'display-refresh',
      accessExpiresAt: Date.now() + 60_000,
    },
    device: { id: 'display-device' },
  });
  return client;
}

function signedResponse(url, options, bytes, {
  status = 200,
  contentDigest = digest(bytes),
  headers = {},
  identity = IDENTITY,
} = {}) {
  const requestUrl = new URL(url);
  const method = String(options.method ?? 'GET').toUpperCase();
  const nonce = options.headers['x-rauhwpx-request-nonce'];
  const canonical = `RAUHWpx-response-v1\n${nonce}\n${method}\n${requestUrl.pathname}${requestUrl.search}\n${status}\n${contentDigest}`;
  return new Response(bytes, {
    status,
    headers: {
      'x-rauhwpx-server-key': SERVER_KEY,
      'x-rauhwpx-content-sha256': contentDigest,
      'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), identity.privateKey).toString('base64url'),
      ...headers,
    },
  });
}

function signedJson(url, options, value, init = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  return signedResponse(url, options, bytes, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function capability(streamId = STREAM_ID) {
  return {
    kind: 'available',
    protocol: 'rauhwpx-frame-v1',
    sessionId: SESSION_ID,
    streamId,
    width: 1280,
    height: 800,
    maxFrameBytes: MAX_DISPLAY_FRAME_BYTES,
    maxFps: 12,
    inputProtocol: 'rauhwpx-input-v1',
    maxInputEventsPerSecond: 60,
  };
}

function metadata(sequence, streamId = STREAM_ID, bytes = Buffer.from([0xff, 0xd8, sequence, 0xff, 0xd9])) {
  return {
    sessionId: SESSION_ID,
    streamId,
    sequence,
    capturedAt: `2026-08-30T00:00:0${sequence}.000Z`,
    width: 1280,
    height: 800,
    mimeType: 'image/jpeg',
    byteLength: bytes.length,
    sha256: digest(bytes),
    framePath: `/v1/sessions/${SESSION_ID}/display/frames/${streamId}/${sequence}`,
  };
}

function signedSse(url, options, envelope, { tamperSignature = false } = {}) {
  const requestUrl = new URL(url);
  const nonce = options.headers['x-rauhwpx-request-nonce'];
  const data = JSON.stringify(envelope);
  const sequence = envelope.seq;
  const eventDigest = digest(Buffer.from(data));
  const canonicalEvent = `RAUHWpx-sse-event-v1\n${nonce}\nGET\n${requestUrl.pathname}${requestUrl.search}\n200\n${sequence}\ndisplay.frame\n${eventDigest}`;
  const signature = sign(null, Buffer.from(canonicalEvent), IDENTITY.privateKey).toString('base64url');
  const body = Buffer.from([
    `id: ${sequence}`,
    'event: display.frame',
    `rauhwpx-sha256: ${eventDigest}`,
    `rauhwpx-signature: ${tamperSignature ? `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}` : signature}`,
    `data: ${data}`,
    '',
    '',
  ].join('\n'));
  const streamDigest = digest(Buffer.from('rauhwpx-sse-v1'));
  return signedResponse(url, options, body, {
    contentDigest: streamDigest,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'x-rauhwpx-stream-protocol': 'rauhwpx-sse-v1',
    },
  });
}

async function waitFor(predicate, message = 'condition') {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

function untilAbort(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', resolve, { once: true });
  });
}

test('desktop display client verifies signed capability, interest, metadata SSE, and exact JPEG bytes', async () => {
  const frameBytes = Buffer.from([0xff, 0xd8, 7, 0xff, 0xd9]);
  const frameMetadata = metadata(7, STREAM_ID, frameBytes);
  const calls = [];
  const client = await clientWith(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith(`/v1/sessions/${SESSION_ID}/display`)) return signedJson(url, options, capability());
    if (url.endsWith(`/v1/sessions/${SESSION_ID}/display/interest`)) {
      return signedJson(url, options, {
        streamId: STREAM_ID,
        interested: true,
        expiresAt: '2026-08-30T00:00:20.000Z',
        maxFps: 12,
        inputProtocol: 'rauhwpx-input-v1',
        maxInputEventsPerSecond: 60,
      });
    }
    if (url.endsWith(`/v1/sessions/${SESSION_ID}/display/input`)) {
      const body = JSON.parse(options.body);
      return signedJson(url, options, {
        streamId: body.streamId,
        viewerId: body.viewerId,
        sequence: body.sequence,
        accepted: true,
        acceptedAt: '2026-08-30T00:00:02.000Z',
      }, { status: 202 });
    }
    if (url.includes(`/v1/sessions/${SESSION_ID}/display/frames?`)) {
      return signedSse(url, options, {
        sessionId: SESSION_ID,
        seq: 7,
        type: 'display.frame',
        payload: { ...frameMetadata, sessionId: undefined },
        createdAt: Date.parse(frameMetadata.capturedAt),
      });
    }
    if (url.endsWith(frameMetadata.framePath)) {
      return signedResponse(url, options, frameBytes, {
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(frameBytes.length),
          'x-content-sha256': frameMetadata.sha256,
        },
      });
    }
    throw new Error(`Unexpected request ${url}`);
  });

  const available = await client.displayCapability(SESSION_ID);
  assert.deepEqual(available, capability());
  assert.equal((await client.setDisplayInterest(SESSION_ID, STREAM_ID, 'viewer-desktop-01', true)).interested, true);
  const interestBody = JSON.parse(calls.find(({ url }) => url.endsWith('/display/interest')).options.body);
  assert.equal(interestBody.viewerId, 'viewer-desktop-01');
  await client.sendDisplayInput(
    SESSION_ID,
    STREAM_ID,
    'viewer-desktop-01',
    1,
    { kind: 'text', text: '안녕하세요' },
  );
  const inputBody = JSON.parse(calls.find(({ url }) => url.endsWith('/display/input')).options.body);
  assert.deepEqual(inputBody, {
    streamId: STREAM_ID,
    viewerId: 'viewer-desktop-01',
    sequence: 1,
    event: { kind: 'text', text: '안녕하세요' },
  });
  const received = [];
  assert.equal(await client.readDisplayFrames(SESSION_ID, available, 0, {
    onMetadata: (value) => received.push(value),
  }), 7);
  const frame = await client.downloadDisplayFrame(received[0]);
  assert.equal(frame.kind, 'frame');
  assert.deepEqual(frame.bytes, new Uint8Array(frameBytes));
  assert.equal(frame.sessionId, SESSION_ID);
  assert.equal(frame.streamId, STREAM_ID);
  assert.equal(frame.sequence, 7);
  assert.ok(calls.every(({ options }) => options.headers['x-rauhwpx-request-nonce']));
});

test('desktop display client rejects capability proof and metadata identity mismatches', async (t) => {
  await t.test('capability proof', async () => {
    let calls = 0;
    const impostor = generateKeyPairSync('ed25519');
    const client = await clientWith(async (url, options) => {
      calls += 1;
      return signedJson(url, options, capability(), { identity: impostor });
    });
    await assert.rejects(client.displayCapability(SESSION_ID), (error) => error.code === 'SERVER_PROOF_INVALID');
    assert.equal(calls, 1);
  });

  const mutations = [
    (event) => { event.sessionId = 'session_other_01'; },
    (event) => { event.payload.streamId = 'stream-other'; },
    (event) => { event.seq = 8; },
    (event) => { event.payload.framePath = '/v1/sessions/wrong/display/frames/wrong/7'; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    await t.test(`metadata mismatch ${index + 1}`, async () => {
      const frameMetadata = metadata(7);
      const event = {
        sessionId: SESSION_ID,
        seq: 7,
        type: 'display.frame',
        payload: { ...frameMetadata, sessionId: undefined },
      };
      mutate(event);
      const client = await clientWith((url, options) => signedSse(url, options, event));
      await assert.rejects(
        client.readDisplayFrames(SESSION_ID, capability(), 0),
        (error) => ['SSE_PAYLOAD_INVALID', 'SSE_PROOF_INVALID', 'DISPLAY_FRAME_METADATA_INVALID'].includes(error.code),
      );
    });
  }
});

test('desktop display bounds a non-2xx text/event-stream body', async () => {
  const protocolDigest = digest(Buffer.from('rauhwpx-sse-v1'));
  const client = await clientWith(async (url, options) => {
    const requestUrl = new URL(url);
    const nonce = options.headers['x-rauhwpx-request-nonce'];
    const canonical = `RAUHWpx-response-v1\n${nonce}\nGET\n${requestUrl.pathname}${requestUrl.search}\n500\n${protocolDigest}`;
    const body = new ReadableStream({
      start(controller) {
        options.signal?.addEventListener('abort', () => {
          controller.error(options.signal.reason);
        }, { once: true });
      },
    });
    return new Response(body, {
      status: 500,
      headers: {
        'content-type': 'text/event-stream',
        'x-rauhwpx-server-key': SERVER_KEY,
        'x-rauhwpx-stream-protocol': 'rauhwpx-sse-v1',
        'x-rauhwpx-content-sha256': protocolDigest,
        'x-rauhwpx-response-signature': sign(null, Buffer.from(canonical), IDENTITY.privateKey).toString('base64url'),
      },
    });
  });
  const fallback = new AbortController();
  const timer = setTimeout(() => fallback.abort(), 250);
  try {
    await assert.rejects(
      client.readDisplayFrames(SESSION_ID, capability(), 0, {
        signal: fallback.signal,
        nonStreamTimeoutMs: 20,
      }),
      (error) => error?.code === 'ETIMEDOUT',
    );
  } finally {
    clearTimeout(timer);
  }
});

test('desktop profile activation closes and awaits its active display', async () => {
  const client = await clientWith(async () => { throw new Error('unused'); });
  const streamStarted = Promise.withResolvers();
  const releaseStarted = Promise.withResolvers();
  const releaseGate = Promise.withResolvers();
  client.displayCapability = async () => capability();
  client.setDisplayInterest = async (_sessionId, streamId, _viewerId, active) => {
    if (!active) {
      releaseStarted.resolve();
      await releaseGate.promise;
    }
    return { streamId, interested: active };
  };
  client.readDisplayFrames = async (_sessionId, _capability, _after, { signal }) => {
    streamStarted.resolve();
    await untilAbort(signal);
  };
  const connection = await client.openDisplay(SESSION_ID, () => {});
  await streamStarted.promise;
  let activated = false;
  const activation = client.activateProfile({
    ...PROFILE,
    endpoint: 'https://replacement.example.test/rauhwpx-cloud',
    ssh: { ...PROFILE.ssh, host: 'replacement.example.test' },
  }, {
    tokens: {
      accessToken: 'replacement-access',
      refreshToken: 'replacement-refresh',
      accessExpiresAt: Date.now() + 60_000,
    },
  }).then(() => { activated = true; });
  const releaseObserved = await Promise.race([
    releaseStarted.promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
  let manualClose = null;
  if (!releaseObserved) {
    manualClose = connection.close();
    await releaseStarted.promise;
  }
  releaseGate.resolve();
  await activation;
  await manualClose;
  assert.equal(releaseObserved, true);
  assert.equal(activated, true);
  await connection.close();
});

test('desktop display JPEG verification rejects MIME, declared and streamed size, and digest tampering without retry', async (t) => {
  const bytes = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);
  const base = metadata(1, STREAM_ID, bytes);
  const cases = [
    {
      name: 'MIME mismatch',
      response: (url, options) => signedResponse(url, options, bytes, {
        headers: { 'content-type': 'image/png', 'content-length': String(bytes.length), 'x-content-sha256': base.sha256 },
      }),
      code: 'DISPLAY_FRAME_INTEGRITY_FAILED',
    },
    {
      name: 'declared size cap',
      response: (url, options) => signedResponse(url, options, bytes, {
        headers: { 'content-type': 'image/jpeg', 'content-length': String(MAX_DISPLAY_FRAME_BYTES + 1), 'x-content-sha256': base.sha256 },
      }),
      code: 'CLOUD_RESPONSE_TOO_LARGE',
    },
    {
      name: 'streamed size cap',
      metadata: { ...base, byteLength: MAX_DISPLAY_FRAME_BYTES },
      response: (url, options) => {
        const oversized = Buffer.alloc(MAX_DISPLAY_FRAME_BYTES + 1, 1);
        return signedResponse(url, options, oversized, {
          headers: { 'content-type': 'image/jpeg', 'x-content-sha256': digest(oversized) },
        });
      },
      code: 'CLOUD_RESPONSE_TOO_LARGE',
    },
    {
      name: 'digest mismatch',
      response: (url, options) => signedResponse(url, options, bytes, {
        headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.length), 'x-content-sha256': 'a'.repeat(64) },
      }),
      code: 'DISPLAY_FRAME_INTEGRITY_FAILED',
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let calls = 0;
      const client = await clientWith((url, options) => {
        calls += 1;
        return scenario.response(url, options);
      });
      await assert.rejects(
        client.downloadDisplayFrame(scenario.metadata ?? base),
        (error) => error.code === scenario.code || error.code === 'SERVER_BODY_TAMPERED',
      );
      assert.equal(calls, 1);
    });
  }
});

test('desktop display connection keeps one download in flight, newest pending metadata, and renews then releases interest', async () => {
  const first = Promise.withResolvers();
  const interests = [];
  const downloads = [];
  const events = [];
  let publishMetadata;
  const transport = {
    displayCapability: async () => capability(),
    setDisplayInterest: async (_sessionId, streamId, viewerId, active) => {
      interests.push({ streamId, viewerId, active });
      return { streamId, interested: active };
    },
    readDisplayFrames: async (_sessionId, _capability, _after, { signal, onMetadata }) => {
      publishMetadata = onMetadata;
      await untilAbort(signal);
    },
    downloadDisplayFrame: async (value) => {
      downloads.push(value.sequence);
      if (value.sequence === 1) await first.promise;
      return { kind: 'frame', ...value, bytes: new Uint8Array(value.byteLength) };
    },
  };
  const connection = await openCloudDisplay(transport, SESSION_ID, (event) => events.push(event), {
    interestRenewMs: 10,
    retryBaseMs: 1,
  });
  await waitFor(() => publishMetadata, 'display stream');
  publishMetadata(metadata(1));
  publishMetadata(metadata(2));
  publishMetadata(metadata(3));
  await waitFor(() => downloads.length === 1, 'first download');
  first.resolve();
  await waitFor(() => downloads.length === 2, 'newest pending download');
  assert.deepEqual(downloads, [1, 3]);
  await waitFor(() => interests.filter(({ active }) => active).length >= 2, 'interest renewal');
  await connection.close();
  assert.equal(interests.at(-1).active, false);
  assert.equal(new Set(interests.map(({ viewerId }) => viewerId)).size, 1);
  assert.match(interests[0].viewerId, /^[A-Za-z0-9_-]{8,128}$/);
  assert.deepEqual(events.filter(({ kind }) => kind === 'frame').map(({ sequence }) => sequence), [1, 3]);
});

test('two desktop connections keep independent viewer interest', async () => {
  const interests = [];
  const transport = {
    displayCapability: async () => capability(),
    setDisplayInterest: async (_sessionId, selectedStream, viewerId, active) => {
      interests.push({ streamId: selectedStream, viewerId, active });
      return { streamId: selectedStream, interested: active };
    },
    readDisplayFrames: async (_sessionId, _capability, _after, { signal }) => untilAbort(signal),
  };
  const first = await openCloudDisplay(transport, SESSION_ID, () => {});
  const second = await openCloudDisplay(transport, SESSION_ID, () => {});
  await waitFor(() => interests.filter(({ active }) => active).length === 2, 'two desktop viewers');
  const activeViewers = interests.filter(({ active }) => active).map(({ viewerId }) => viewerId);
  assert.equal(new Set(activeViewers).size, 2);
  assert.ok(activeViewers.every((viewerId) => /^[A-Za-z0-9_-]{8,128}$/.test(viewerId)));
  await first.close();
  assert.ok(interests.some(({ viewerId, active }) => viewerId === activeViewers[0] && !active));
  assert.equal(interests.some(({ viewerId, active }) => viewerId === activeViewers[1] && !active), false);
  await second.close();
  assert.ok(interests.some(({ viewerId, active }) => viewerId === activeViewers[1] && !active));
});

test('desktop display connection reconnects transient failures and resets sequence on stream replacement', async () => {
  const streamTwo = 'stream-display-02';
  const capabilities = [capability(), capability(streamTwo)];
  const interests = [];
  const events = [];
  let capabilityCalls = 0;
  const transport = {
    displayCapability: async () => capabilities[Math.min(capabilityCalls++, 1)],
    setDisplayInterest: async (_sessionId, streamId, viewerId, active) => {
      interests.push({ streamId, viewerId, active });
      return { streamId, interested: active };
    },
    readDisplayFrames: async (_sessionId, selected, _after, { signal, onMetadata }) => {
      if (selected.streamId === STREAM_ID) {
        throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET', retryable: true });
      }
      onMetadata(metadata(1, streamTwo));
      await untilAbort(signal);
    },
    downloadDisplayFrame: async (value) => ({
      kind: 'frame', ...value, bytes: new Uint8Array(value.byteLength),
    }),
  };
  const connection = await openCloudDisplay(transport, SESSION_ID, (event) => events.push(event), {
    retryBaseMs: 1,
    retryMaxMs: 2,
  });
  await waitFor(
    () => events.some((event) => event.kind === 'frame' && event.streamId === streamTwo),
    'replacement stream frame',
  );
  assert.equal(connection.capability.streamId, streamTwo);
  assert.ok(events.some((event) => event.kind === 'connection' && event.state === 'reconnecting'));
  assert.ok(events.some((event) => event.kind === 'connection' && event.state === 'connected' && event.streamId === streamTwo));
  assert.ok(interests.some((entry) => entry.streamId === STREAM_ID && entry.active === false));
  await connection.close();
});

test('desktop display resets the cursor when retryable unavailable becomes a new stream', async () => {
  const replacementStream = 'stream-display-02';
  const unavailable = {
    kind: 'unavailable',
    sessionId: SESSION_ID,
    reason: 'stream-unavailable',
    message: 'Display is restarting',
    retryable: true,
  };
  const capabilities = [capability(), unavailable, capability(replacementStream)];
  const afters = [];
  const interests = [];
  const events = [];
  const oldDelivered = Promise.withResolvers();
  let capabilityCalls = 0;
  const connection = await openCloudDisplay({
    displayCapability: async () => capabilities[Math.min(capabilityCalls++, capabilities.length - 1)],
    setDisplayInterest: async (_sessionId, selectedStream, viewerId, active) => {
      interests.push({ streamId: selectedStream, viewerId, active });
      return { streamId: selectedStream, interested: active };
    },
    readDisplayFrames: async (_sessionId, selected, after, { signal, onMetadata }) => {
      afters.push(after);
      if (selected.streamId === STREAM_ID) {
        onMetadata(metadata(7));
        await oldDelivered.promise;
        throw Object.assign(new Error('old stream ended'), { code: 'ECONNRESET', retryable: true });
      }
      await untilAbort(signal);
    },
    downloadDisplayFrame: async (value) => ({
      kind: 'frame', ...value, bytes: new Uint8Array(value.byteLength),
    }),
  }, SESSION_ID, (event) => {
    events.push(event);
    if (event.kind === 'frame' && event.streamId === STREAM_ID) oldDelivered.resolve();
  }, { retryBaseMs: 1, retryMaxMs: 1 });
  try {
    await waitFor(() => afters.length === 2, 'replacement stream watch');
    assert.deepEqual(afters, [0, 0]);
    assert.deepEqual(
      events.filter((event) => event.kind === 'connection' && event.state === 'connected')
        .map((event) => event.streamId),
      [STREAM_ID, replacementStream],
    );
    assert.ok(interests.findIndex((entry) => entry.streamId === STREAM_ID && entry.active === false)
      < interests.findIndex((entry) => entry.streamId === replacementStream && entry.active === true));
  } finally {
    await connection.close();
  }
});

test('desktop display stops polling retryable unavailable capabilities at the reconnect limit', async () => {
  const events = [];
  let capabilityCalls = 0;
  const connection = await openCloudDisplay({
    displayCapability: async () => {
      capabilityCalls += 1;
      return {
        kind: 'unavailable',
        sessionId: SESSION_ID,
        reason: 'stream-unavailable',
        message: `Display unavailable attempt ${capabilityCalls}`,
        retryable: true,
      };
    },
  }, SESSION_ID, (event) => events.push(event), {
    retryBaseMs: 1,
    retryMaxMs: 1,
    maxReconnectAttempts: 2,
  });
  try {
    await waitFor(
      () => events.some((event) => event.kind === 'connection' && event.state === 'failed'),
      'unavailable retry exhaustion',
    );
    assert.equal(capabilityCalls, 3);
    const failures = events.filter((event) => event.kind === 'connection' && event.state === 'failed');
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /stream-unavailable.*Display unavailable attempt 3/);
  } finally {
    await connection.close();
  }
});

test('desktop display close aborts setup, stream, and frame work without stale delivery', async (t) => {
  await t.test('setup', async () => {
    const controller = new AbortController();
    let aborted = false;
    const opening = openCloudDisplay({
      displayCapability: async (_sessionId, { signal }) => {
        await untilAbort(signal);
        aborted = true;
        throw signal.reason;
      },
    }, SESSION_ID, () => {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(opening, (error) => error?.name === 'AbortError');
    assert.equal(aborted, true);
  });

  await t.test('interest setup', async () => {
    let interestAborted = false;
    const connection = await openCloudDisplay({
      displayCapability: async () => capability(),
      setDisplayInterest: async (_sessionId, streamId, _viewerId, active, { signal } = {}) => {
        if (!active) return { streamId, interested: false };
        await untilAbort(signal);
        interestAborted = true;
        throw signal.reason;
      },
    }, SESSION_ID, () => {});
    await connection.close();
    assert.equal(interestAborted, true);
  });

  await t.test('stream and frame', async () => {
    const frame = Promise.withResolvers();
    const events = [];
    let publish;
    let streamAborted = false;
    const connection = await openCloudDisplay({
      displayCapability: async () => capability(),
      setDisplayInterest: async (_sessionId, streamId, _viewerId, active) => ({ streamId, interested: active }),
      readDisplayFrames: async (_sessionId, _capability, _after, { signal, onMetadata }) => {
        publish = onMetadata;
        await untilAbort(signal);
        streamAborted = true;
      },
      downloadDisplayFrame: async () => frame.promise,
    }, SESSION_ID, (event) => events.push(event));
    await waitFor(() => publish, 'stream callback');
    publish(metadata(1));
    const closing = connection.close();
    frame.resolve({ kind: 'frame', ...metadata(1), bytes: new Uint8Array(5) });
    await closing;
    assert.equal(streamAborted, true);
    assert.equal(events.some((event) => event.kind === 'frame'), false);
  });
});

test('desktop display parsers reject every Studio parity fixture', () => {
  for (const fixture of invalidDisplayCapabilities) {
    assert.throws(() => clientTestParseCapability(fixture.value), undefined, fixture.name);
  }
  for (const fixture of invalidDisplayMetadata) {
    assert.throws(() => clientTestParseMetadata(fixture.value), undefined, fixture.name);
  }
});

test('desktop display terminal failure clears pending metadata before download finally', async () => {
  const calls = [];
  const events = [];
  let publish;
  const connection = await openCloudDisplay({
    displayCapability: async () => capability(),
    setDisplayInterest: async () => {},
    readDisplayFrames: async (_sessionId, _capability, _after, { signal, onMetadata }) => {
      publish = onMetadata;
      await untilAbort(signal);
    },
    downloadDisplayFrame: async (value) => {
      calls.push(value.sequence);
      throw Object.assign(new Error('tampered frame'), { code: 'DISPLAY_FRAME_INTEGRITY_FAILED' });
    },
  }, SESSION_ID, (event) => events.push(event), { retryBaseMs: 1 });
  await waitFor(() => publish, 'metadata publisher');
  publish(metadata(1));
  publish(metadata(2));
  await waitFor(() => events.some((event) => event.kind === 'connection' && event.state === 'failed'), 'terminal failure');
  assert.deepEqual(calls, [1]);
  await connection.close();
});

test('desktop display repeated frame 500 failures exhaust reconnect budget', async () => {
  const calls = [];
  const events = [];
  const connection = await openCloudDisplay({
    displayCapability: async () => capability(),
    setDisplayInterest: async () => {},
    readDisplayFrames: async (_sessionId, _capability, _after, { onMetadata }) => {
      onMetadata(metadata(1));
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    downloadDisplayFrame: async (value) => {
      calls.push(value.sequence);
      throw Object.assign(new Error('frame endpoint failed'), { status: 500, retryable: true });
    },
  }, SESSION_ID, (event) => events.push(event), {
    retryBaseMs: 1,
    retryMaxMs: 1,
    maxReconnectAttempts: 2,
  });
  try {
    await waitFor(() => events.some((event) => event.kind === 'connection' && event.state === 'failed'), 'retry exhaustion');
    assert.equal(calls.length, 3);
  } finally {
    await connection.close();
  }
});

test('desktop display skips evicted frame and downloads newest pending metadata', async () => {
  const first = Promise.withResolvers();
  const calls = [];
  const events = [];
  let publish;
  const connection = await openCloudDisplay({
    displayCapability: async () => capability(),
    setDisplayInterest: async () => {},
    readDisplayFrames: async (_sessionId, _capability, _after, { signal, onMetadata }) => {
      publish = onMetadata;
      await untilAbort(signal);
    },
    downloadDisplayFrame: async (value) => {
      calls.push(value.sequence);
      if (value.sequence === 1) {
        await first.promise;
        throw Object.assign(new Error('evicted'), { code: 'DISPLAY_FRAME_NOT_FOUND', status: 404 });
      }
      return { kind: 'frame', ...value, bytes: new Uint8Array(value.byteLength) };
    },
  }, SESSION_ID, (event) => events.push(event), { retryBaseMs: 1 });
  await waitFor(() => publish, 'metadata publisher');
  publish(metadata(1));
  publish(metadata(2));
  first.resolve();
  await waitFor(() => events.some((event) => event.kind === 'frame' && event.sequence === 2), 'newest frame');
  assert.deepEqual(calls, [1, 2]);
  assert.equal(events.some((event) => event.kind === 'connection' && event.state === 'failed'), false);
  await connection.close();
});

test('display registry scopes replacement and cleanup to each window owner', async () => {
  const opened = [];
  const closed = [];
  const emitters = new Map();
  const registry = new CloudDisplayRegistry({
    openDisplay: async (sessionId, listener) => {
      const connection = {
        capability: { ...capability(`stream-${sessionId}`), sessionId },
        async close() { closed.push(sessionId); },
      };
      opened.push(sessionId);
      emitters.set(sessionId, listener);
      return connection;
    },
  });
  const firstEvents = [];
  const secondEvents = [];
  const first = await registry.open(101, 'session_window_1', (event) => firstEvents.push(event));
  const second = await registry.open(202, 'session_window_2', (event) => secondEvents.push(event));
  assert.equal(await registry.close(101, second.connectionId), false, 'one window cannot close another window connection');
  emitters.get('session_window_2')({ kind: 'frame', sessionId: 'session_window_2' });
  assert.equal(secondEvents.length, 1);
  const replacement = await registry.open(101, 'session_window_3', (event) => firstEvents.push(event));
  assert.ok(closed.includes('session_window_1'));
  emitters.get('session_window_1')({ kind: 'frame', sessionId: 'session_window_1' });
  assert.equal(firstEvents.length, 0, 'replaced window callbacks are stale');
  assert.equal(await registry.close(101, first.connectionId), false);
  assert.equal(await registry.close(101, replacement.connectionId), true);
  assert.equal(closed.includes('session_window_2'), false);
  await registry.closeAll();
  assert.deepEqual(new Set(opened), new Set(['session_window_1', 'session_window_2', 'session_window_3']));
  assert.ok(closed.includes('session_window_2'));
});

test('display registry forwards input only through the sender-owned live connection', async () => {
  const inputs = [];
  const registry = new CloudDisplayRegistry({
    openDisplay: async () => ({
      capability: capability(),
      async sendInput(event) { inputs.push(event); },
      async close() {},
    }),
  });
  const opened = await registry.open(101, SESSION_ID, () => {});
  await assert.rejects(
    registry.sendInput(202, opened.connectionId, { kind: 'text', text: 'blocked' }),
    (error) => error?.name === 'AbortError',
  );
  await registry.sendInput(101, opened.connectionId, { kind: 'text', text: 'accepted' });
  assert.deepEqual(inputs, [{ kind: 'text', text: 'accepted' }]);
  await registry.closeAll();
});

test('desktop coordinator retains a profile operation lease through remote input', async () => {
  const inputStarted = Promise.withResolvers();
  const releaseInput = Promise.withResolvers();
  let closed = false;
  const coordinator = new CloudCoordinator({
    client: {
      openDisplay: async () => ({
        capability: capability(),
        async sendInput() {
          inputStarted.resolve();
          await releaseInput.promise;
        },
        async close() { closed = true; },
      }),
    },
    store: { flush: async () => {} },
    provisioner: {},
  });
  const connection = await coordinator.openDisplay(SESSION_ID, () => {});
  const input = connection.sendInput({ kind: 'text', text: 'leased' });
  await inputStarted.promise;
  let stopped = false;
  const stopping = coordinator.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(closed, true);
  releaseInput.resolve();
  await Promise.all([input, stopping]);
  assert.equal(stopped, true);
});

test('display registry waits for prior cleanup before a concurrent replacement opens', async () => {
  const releaseClose = Promise.withResolvers();
  const opened = [];
  const registry = new CloudDisplayRegistry({
    openDisplay: async (sessionId) => {
      opened.push(sessionId);
      return {
        capability: { ...capability(`stream-${sessionId}`), sessionId },
        async close() {
          if (sessionId === 'session_window_1') await releaseClose.promise;
        },
      };
    },
  });
  await registry.open(101, 'session_window_1', () => {});
  const second = registry.open(101, 'session_window_2', () => {});
  const third = registry.open(101, 'session_window_3', () => {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(opened, ['session_window_1']);
  releaseClose.resolve();
  await assert.rejects(second, (error) => error?.name === 'AbortError');
  await third;
  assert.deepEqual(opened, ['session_window_1', 'session_window_3']);
  await registry.closeAll();
});

test('display registry close waits for blocked capability setup cleanup', async () => {
  const cleanup = Promise.withResolvers();
  const started = Promise.withResolvers();
  const registry = new CloudDisplayRegistry({
    openDisplay: async (_sessionId, _listener, { signal }) => {
      started.resolve();
      await untilAbort(signal);
      await cleanup.promise;
      throw signal.reason;
    },
  });
  const opening = registry.open(101, SESSION_ID, () => {});
  await started.promise;
  let closed = false;
  const closing = registry.close(101).then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(closed, false);
  cleanup.resolve();
  await closing;
  await assert.rejects(opening, (error) => error?.name === 'AbortError');
});

test('desktop renderer termination paths close the sender-owned display connection', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /window\.on\('closed',[\s\S]*?closeDisplayConnection\(\)/);
  assert.match(source, /webContents\.on\('render-process-gone',[\s\S]*?closeDisplayConnection\(\)/);
  assert.match(source, /webContents\.once\('destroyed', closeDisplayConnection\)/);
});

function clientTestParseCapability(value) {
  return parseDisplayCapability(value, SESSION_ID);
}

function clientTestParseMetadata(value) {
  return parseDisplayFrameMetadata(value, validDisplayCapability());
}

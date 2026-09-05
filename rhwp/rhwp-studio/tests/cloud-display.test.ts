import { acceptEdge13Pointer } from '../../../tests/fixtures/edge13-display-pointer.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCloudController } from '../src/cloud/desktop-cloud.ts';
import { openDisplayConnection } from '../src/cloud/display-connection.ts';
import {
  parseCloudDisplayCapability,
  parseCloudDisplayEvent,
  parseCloudDisplayFrameMetadata,
} from '../src/cloud/display.ts';
import type { CloudDisplayEvent } from '../src/cloud/types.ts';
import {
  invalidDisplayCapabilities,
  invalidDisplayMetadata,
  validDisplayCapability,
} from './cloud-display-parity-fixtures.ts';

const sessionId = 'session_display_01';
const streamId = 'stream-display-01';

function capability() {
  return {
    kind: 'available' as const,
    protocol: 'rauhwpx-frame-v1' as const,
    sessionId,
    streamId,
    width: 1280,
    height: 800,
    maxFrameBytes: 524288 as const,
    maxFps: 12 as const,
    inputProtocol: 'rauhwpx-input-v1' as const,
    maxInputEventsPerSecond: 60 as const,
  };
}

function metadata() {
  return {
    sessionId,
    streamId,
    sequence: 7,
    capturedAt: '2026-08-30T00:00:07.000Z',
    width: 1280,
    height: 800,
    mimeType: 'image/jpeg' as const,
    byteLength: 5,
    sha256: 'a'.repeat(64),
    framePath: `/v1/sessions/${sessionId}/display/frames/${streamId}/7`,
  };
}

test('display parsers preserve strict capability, metadata, and frame discriminants', () => {
  assert.deepEqual(parseCloudDisplayCapability(capability()), capability());
  assert.deepEqual(parseCloudDisplayCapability({
    kind: 'unavailable',
    sessionId,
    reason: 'server-unsupported',
    message: 'Upgrade the server',
    retryable: false,
  }), {
    kind: 'unavailable',
    sessionId,
    reason: 'server-unsupported',
    message: 'Upgrade the server',
    retryable: false,
  });
  assert.deepEqual(parseCloudDisplayFrameMetadata(metadata(), { capability: capability() }), metadata());
  assert.deepEqual(parseCloudDisplayEvent({
    kind: 'frame',
    ...metadata(),
    bytes: new Uint8Array(5),
  }, { sessionId, streamId }), {
    kind: 'frame',
    ...metadata(),
    bytes: new Uint8Array(5),
  });

  assert.equal(parseCloudDisplayCapability({ ...capability(), maxFrameBytes: 524287 }), null);
  assert.equal(parseCloudDisplayCapability({ ...capability(), reason: 'stream-unavailable' }), null);
  assert.equal(parseCloudDisplayCapability({
    kind: 'unavailable', sessionId, reason: 'unknown', message: 'No', retryable: false,
  }), null);
  assert.equal(parseCloudDisplayCapability({
    kind: 'unavailable', sessionId, reason: 'client-unsupported', message: 'No', retryable: false, streamId,
  }), null);
  assert.equal(parseCloudDisplayFrameMetadata({ ...metadata(), streamId: 'stale-stream' }, {
    capability: capability(),
  }), null);
  assert.equal(parseCloudDisplayEvent({
    kind: 'frame', ...metadata(), sequence: 8, bytes: new Uint8Array(5),
  }, { sessionId, streamId }), null);
  assert.equal(parseCloudDisplayEvent({
    kind: 'connection', state: 'connected', sessionId, streamId, retryable: true,
    capability: capability(), code: 'MIXED_STATE',
  }), null);
});

test('Studio display parsers reject every desktop parity fixture', () => {
  for (const fixture of invalidDisplayCapabilities) {
    assert.equal(parseCloudDisplayCapability(fixture.value), null, fixture.name);
  }
  for (const fixture of invalidDisplayMetadata) {
    assert.equal(parseCloudDisplayFrameMetadata(fixture.value, {
      capability: validDisplayCapability(),
    }), null, fixture.name);
  }
});

test('browser display state machine stops terminal failure before pending download starts', async () => {
  const published = Promise.withResolvers<void>();
  const calls: number[] = [];
  const events: CloudDisplayEvent[] = [];
  let publish!: (metadata: ReturnType<typeof metadata>) => void;
  const connection = await openDisplayConnection({
    capability: async () => capability(),
    interest: async () => {},
    frames: async (_sessionId, _capability, _after, { signal, onMetadata }) => {
      publish = onMetadata;
      published.resolve();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return 0;
    },
    frame: async (value) => {
      calls.push(value.sequence);
      throw Object.assign(new Error('tampered frame'), { code: 'DISPLAY_FRAME_INTEGRITY_FAILED' });
    },
  }, sessionId, (event) => events.push(event), { retryBaseMs: 1 });
  await published.promise;
  publish(metadata());
  publish({ ...metadata(), sequence: 8, framePath: `/v1/sessions/${sessionId}/display/frames/${streamId}/8` });
  await waitForEvent(events, (event) => event.kind === 'connection' && event.state === 'failed');
  assert.deepEqual(calls, [7]);
  await connection.close();
});

test('browser display state machine exhausts repeated frame 500 failures', async () => {
  const calls: number[] = [];
  const events: CloudDisplayEvent[] = [];
  const connection = await openDisplayConnection({
    capability: async () => capability(),
    interest: async () => {},
    frames: async (_sessionId, _capability, _after, { onMetadata }) => {
      onMetadata(metadata());
      await new Promise((resolve) => setTimeout(resolve, 1));
      return 0;
    },
    frame: async (value) => {
      calls.push(value.sequence);
      throw Object.assign(new Error('frame endpoint failed'), { status: 500, retryable: true });
    },
  }, sessionId, (event) => events.push(event), {
    retryBaseMs: 1,
    retryMaxMs: 1,
    maxReconnectAttempts: 2,
  });
  try {
    await waitForEvent(events, (event) => event.kind === 'connection' && event.state === 'failed');
    assert.equal(calls.length, 3);
  } finally {
    await connection.close();
  }
});

test('browser display state machine skips an evicted frame and delivers newest pending', async () => {
  const first = Promise.withResolvers<void>();
  const calls: number[] = [];
  const events: CloudDisplayEvent[] = [];
  let publish!: (metadata: ReturnType<typeof metadata>) => void;
  const connection = await openDisplayConnection({
    capability: async () => capability(),
    interest: async () => {},
    frames: async (_sessionId, _capability, _after, { signal, onMetadata }) => {
      publish = onMetadata;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return 0;
    },
    frame: async (value) => {
      calls.push(value.sequence);
      if (value.sequence === 7) {
        await first.promise;
        throw Object.assign(new Error('evicted'), { code: 'DISPLAY_FRAME_NOT_FOUND', status: 404 });
      }
      return { kind: 'frame' as const, ...value, bytes: new Uint8Array(value.byteLength) };
    },
  }, sessionId, (event) => events.push(event), { retryBaseMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  publish(metadata());
  publish({ ...metadata(), sequence: 8, framePath: `/v1/sessions/${sessionId}/display/frames/${streamId}/8` });
  first.resolve();
  await waitForEvent(events, (event) => event.kind === 'frame' && event.sequence === 8);
  assert.deepEqual(calls, [7, 8]);
  assert.equal(events.some((event) => event.kind === 'connection' && event.state === 'failed'), false);
  await connection.close();
});

test('browser display resets the cursor when retryable unavailable becomes a new stream', async () => {
  const replacementStream = 'stream-display-02';
  const unavailable = {
    kind: 'unavailable' as const,
    sessionId,
    reason: 'stream-unavailable' as const,
    message: 'Display is restarting',
    retryable: true,
  };
  const capabilities = [capability(), unavailable, { ...capability(), streamId: replacementStream }];
  const afters: number[] = [];
  const interests: Array<{ streamId: string; viewerId: string; active: boolean }> = [];
  const events: CloudDisplayEvent[] = [];
  const oldDelivered = Promise.withResolvers<void>();
  let capabilityCalls = 0;
  const connection = await openDisplayConnection({
    capability: async () => capabilities[Math.min(capabilityCalls++, capabilities.length - 1)],
    interest: async (_sessionId, selectedStream, viewerId, active) => {
      interests.push({ streamId: selectedStream, viewerId, active });
    },
    frames: async (_sessionId, selected, after, { signal, onMetadata }) => {
      afters.push(after);
      if (selected.streamId === streamId) {
        onMetadata(metadata());
        await oldDelivered.promise;
        throw Object.assign(new Error('old stream ended'), { code: 'ECONNRESET', retryable: true });
      }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return 0;
    },
    frame: async (value) => ({
      kind: 'frame' as const, ...value, bytes: new Uint8Array(value.byteLength),
    }),
  }, sessionId, (event) => {
    events.push(event);
    if (event.kind === 'frame' && event.streamId === streamId) oldDelivered.resolve();
  }, { retryBaseMs: 1, retryMaxMs: 1 });
  try {
    await waitForEvent(events, () => afters.length === 2);
    assert.deepEqual(afters, [0, 0]);
    assert.deepEqual(
      events.filter((event) => event.kind === 'connection' && event.state === 'connected')
        .map((event) => event.streamId),
      [streamId, replacementStream],
    );
    assert.ok(interests.findIndex((entry) => entry.streamId === streamId && entry.active === false)
      < interests.findIndex((entry) => entry.streamId === replacementStream && entry.active === true));
  } finally {
    await connection.close();
  }
});

test('browser display stops polling retryable unavailable capabilities at the reconnect limit', async () => {
  const events: CloudDisplayEvent[] = [];
  let capabilityCalls = 0;
  const connection = await openDisplayConnection({
    capability: async () => {
      capabilityCalls += 1;
      return {
        kind: 'unavailable' as const,
        sessionId,
        reason: 'stream-unavailable' as const,
        message: `Display unavailable attempt ${capabilityCalls}`,
        retryable: true,
      };
    },
    interest: async () => {},
    frames: async () => 0,
    frame: async () => { throw new Error('unused'); },
  }, sessionId, (event) => events.push(event), {
    retryBaseMs: 1,
    retryMaxMs: 1,
    maxReconnectAttempts: 2,
  });
  try {
    await waitForEvent(events, (event) => event.kind === 'connection' && event.state === 'failed');
    assert.equal(capabilityCalls, 3);
    const failures = events.filter((event) => event.kind === 'connection' && event.state === 'failed');
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /stream-unavailable.*Display unavailable attempt 3/);
  } finally {
    await connection.close();
  }
});

async function waitForEvent(
  events: CloudDisplayEvent[],
  predicate: (event: CloudDisplayEvent) => boolean,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (events.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for display event');
}

test('CloudController returns typed client unsupported capability for an older preload', async () => {
  const controller = createCloudController({} as never);
  const events: CloudDisplayEvent[] = [];
  const connection = await controller.openDisplay(sessionId, (event) => events.push(event));
  assert.deepEqual(connection.capability, {
    kind: 'unavailable',
    sessionId,
    reason: 'client-unsupported',
    message: 'This app build does not support live display frames',
    retryable: false,
  });
  assert.deepEqual(events, [connection.capability]);
  await connection.close();
  controller.dispose();
});

test('CloudController replaces one display connection and suppresses stale host events', async () => {
  let hostListener: ((event: unknown) => void) | undefined;
  const opened: string[] = [];
  const closed: string[] = [];
  const controller = createCloudController({
    cloudOpenDisplay: async ({ sessionId: selectedSessionId }) => {
      opened.push(selectedSessionId);
      return {
        connectionId: `connection-${opened.length}`,
        capability: { ...capability(), sessionId: selectedSessionId, streamId: `stream-${opened.length}` },
      };
    },
    cloudCloseDisplay: async ({ connectionId }) => {
      closed.push(connectionId);
      return true;
    },
    cloudDisplayInput: async () => true,
    onCloudDisplayEvent: (listener) => {
      hostListener = listener;
      return () => { hostListener = undefined; };
    },
  } as never);
  const firstEvents: CloudDisplayEvent[] = [];
  const secondEvents: CloudDisplayEvent[] = [];
  const first = await controller.openDisplay(sessionId, (event) => firstEvents.push(event));
  const second = await controller.openDisplay('session_display_02', (event) => secondEvents.push(event));
  assert.deepEqual(closed, ['connection-1']);

  hostListener?.({
    connectionId: 'connection-1',
    event: {
      kind: 'connection', state: 'failed', sessionId, streamId: 'stream-1',
      retryable: false, code: 'STALE', message: 'stale',
    },
  });
  hostListener?.({
    connectionId: 'connection-2',
    event: {
      kind: 'connection', state: 'connected', sessionId: 'session_display_02', streamId: 'stream-replaced',
      retryable: true,
      capability: { ...capability(), sessionId: 'session_display_02', streamId: 'stream-replaced' },
    },
  });
  assert.equal(firstEvents.length, 0);
  assert.equal(secondEvents.length, 1);
  assert.equal(second.capability.kind === 'available' ? second.capability.streamId : '', 'stream-replaced');
  await first.close();
  assert.deepEqual(closed, ['connection-1']);
  await second.close();
  assert.deepEqual(closed, ['connection-1', 'connection-2']);
  controller.dispose();
});

test('CloudController replays a verified frame that arrives during the open handshake', async () => {
  let hostListener: ((event: unknown) => void) | undefined;
  const controller = createCloudController({
    cloudOpenDisplay: async () => {
      hostListener?.({
        connectionId: 'connection-opening',
        event: { kind: 'frame', ...metadata(), bytes: new Uint8Array(5) },
      });
      return { connectionId: 'connection-opening', capability: capability() };
    },
    cloudCloseDisplay: async () => true,
    cloudDisplayInput: async () => true,
    onCloudDisplayEvent: (listener) => {
      hostListener = listener;
      return () => { hostListener = undefined; };
    },
  } as never);
  const events: CloudDisplayEvent[] = [];
  const connection = await controller.openDisplay(sessionId, (event) => events.push(event));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'frame');
  await connection.close();
  controller.dispose();
});

test('CloudController disposal closes owned resources exactly once', async () => {
  let cloudUnsubscribes = 0;
  let displayUnsubscribes = 0;
  let closes = 0;
  const controller = createCloudController({
    cloudOpenDisplay: async () => ({ connectionId: 'connection-owned', capability: capability() }),
    cloudCloseDisplay: async () => { closes += 1; },
    cloudDisplayInput: async () => true,
    onCloudEvent: () => () => { cloudUnsubscribes += 1; },
    onCloudDisplayEvent: () => () => { displayUnsubscribes += 1; },
  } as never);
  await controller.openDisplay(sessionId, () => {});
  controller.dispose();
  controller.dispose();
  await Promise.resolve();
  assert.deepEqual({ cloudUnsubscribes, displayUnsubscribes, closes }, {
    cloudUnsubscribes: 1,
    displayUnsubscribes: 1,
    closes: 1,
  });
});


test('browser display negotiates click counts before single or batched input reaches edge13', async () => {
  for (const supportsClickCount of [undefined, false, true]) {
    for (const batched of [false, true]) {
      const selected = parseCloudDisplayCapability({ ...capability(),
        ...(supportsClickCount === undefined ? {} : { supportsClickCount }),
        ...(batched ? { inputBatchSize: 32 } : {}),
      })!;
      const received: unknown[] = [];
      const receive = (event: unknown) => {
        if (supportsClickCount !== true) acceptEdge13Pointer(event);
        received.push(event);
      };
      const connection = await openDisplayConnection({
        capability: async () => selected,
        interest: async () => {},
        frames: async (_session, _capability, _after, { signal }) => {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          return 0;
        },
        frame: async () => { throw new Error('unused'); },
        input: async (_session, _stream, _viewer, _sequence, event) => receive(event),
        inputs: async (_session, _stream, _viewer, events) => events.forEach(({ event }) => receive(event)),
      }, sessionId, () => {});
      try {
        const events = (['down', 'up'] as const).map((action) => ({ kind: 'pointer' as const, action, x: 20, y: 20, button: 'left' as const, clickCount: 2 }));
        assert.throws(() => acceptEdge13Pointer(events[0]), { code: 'DISPLAY_INPUT_INVALID' });
        await Promise.all(events.map((event) => connection.sendInput(event)));
        assert.deepEqual(received, events.map((event) => supportsClickCount === true ? event : acceptEdge13Pointer(
          Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'clickCount')))));
      } finally { await connection.close(); }
    }
  }
  assert.equal(parseCloudDisplayCapability({ ...capability(), supportsClickCount: 'true' }), null);
});

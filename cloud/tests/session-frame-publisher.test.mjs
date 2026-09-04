import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { SessionFramePublisher } from '../document-runtime/session-frame-publisher.mjs';

function jpeg(content) {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(content), Buffer.from([0xff, 0xd9])]);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stderr.resume = () => {};
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    queueMicrotask(() => {
      child.signalCode = signal;
      child.emit('exit', null, signal);
      child.emit('close', null, signal);
    });
    return true;
  };
  return child;
}

async function waitFor(predicate, message = 'condition') {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

function fakeClient(initialDemands = []) {
  const demands = [...initialDemands];
  const published = [];
  const waiting = [];
  let closeCalls = 0;
  return {
    published,
    waiting,
    get closeCalls() { return closeCalls; },
    async openFrameStream({ width, height }) {
      return { streamId: 'stream-test', width, height };
    },
    async frameDemand(_streamId, { signal }) {
      if (demands.length) return demands.shift();
      const next = deferred();
      const abort = () => next.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal?.addEventListener('abort', abort, { once: true });
      waiting.push({
        resolve(value) {
          signal?.removeEventListener('abort', abort);
          next.resolve(value);
        },
        reject(error) {
          signal?.removeEventListener('abort', abort);
          next.reject(error);
        },
      });
      return next.promise;
    },
    async publishFrame(streamId, frame) {
      published.push({ streamId, ...frame });
      return { sequence: frame.sequence };
    },
    async closeFrameStream() { closeCalls += 1; return { closed: true }; },
  };
}

const sessionDisplay = {
  status: 'ready',
  display: ':77',
  environment: {
    DISPLAY: ':77', XAUTHORITY: '/workspace/home/.Xauthority', RAUHWpx_SESSION_DISPLAY: 'ready',
  },
  snapshot: () => ({ status: 'ready', width: 1280, height: 800 }),
};

async function startReady(publisher) {
  await publisher.start();
  publisher.markReady();
}

test('SessionFramePublisher starts and stops ffmpeg from demand', async () => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const children = [];
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    environment: {
      PATH: '/usr/bin:/bin',
      RAUHWpx_WORKER_TOKEN: 'worker-secret',
      RAUHWpx_CONTROL_SOCKET: '/run/rauhwpx/control.sock',
      CONTROL_PLANE_SECRET: 'secret',
    },
    spawnProcess(command, args, options) {
      assert.equal(command, 'ffmpeg');
      assert.deepEqual(args.slice(args.indexOf('-framerate'), args.indexOf('-framerate') + 2), ['-framerate', '12']);
      assert.ok(args.includes('1280x800'));
      assert.equal(options.env.DISPLAY, ':77');
      assert.equal(options.env.PATH, '/usr/bin:/bin');
      assert.equal(options.env.RAUHWpx_WORKER_TOKEN, undefined);
      assert.equal(options.env.RAUHWpx_CONTROL_SOCKET, undefined);
      assert.equal(options.env.CONTROL_PLANE_SECRET, undefined);
      assert.equal(options.detached, false);
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  await startReady(publisher);
  await waitFor(() => children.length === 1 && client.waiting.length === 1, 'capture start');
  client.waiting.shift().resolve({ version: 2, interested: false, closed: false });
  await waitFor(() => children[0].signalCode === 'SIGTERM', 'capture stop');
  assert.deepEqual(children[0].signals, ['SIGTERM']);
  await publisher.stop();
  assert.equal(client.closeCalls, 1);
});

test('SessionFramePublisher applies ordered remote input before advancing demand', async () => {
  const events = [
    { version: 2, sequence: 1, event: { kind: 'text', text: 'hello' } },
    { version: 3, sequence: 2, event: { kind: 'key', action: 'down', key: 'Enter' } },
  ];
  const client = fakeClient([{ version: 3, interested: false, inputEvents: events, closed: false }]);
  const applied = [];
  const failures = [];
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    onEvent: (event) => failures.push(event),
  });
  publisher.setInputHandler(async (event) => {
    applied.push(event);
    if (event.kind === 'key') throw new Error('synthetic key failure');
  });
  await publisher.start();
  publisher.markReady();
  await waitFor(() => client.waiting.length === 1, 'next demand after input');
  assert.deepEqual(applied, events.map((entry) => entry.event));
  assert.equal(publisher.demandVersion, 3);
  assert.equal(failures.some((event) => event.type === 'display-input-failed'), true);
  await publisher.stop();
});

test('SessionFramePublisher suppresses duplicate JPEGs', async () => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const child = fakeChild();
  const publisher = new SessionFramePublisher({ client, sessionDisplay, spawnProcess: () => child, now: () => 1_800_000_000_000 });
  await startReady(publisher);
  child.stdout.emit('data', Buffer.concat([jpeg('same'), jpeg('same'), jpeg('changed')]));
  await waitFor(() => client.published.length === 2, 'deduplicated uploads');
  assert.deepEqual(client.published.map(({ sequence }) => sequence), [1, 2]);
  assert.deepEqual(client.published.map(({ bytes }) => bytes), [jpeg('same'), jpeg('changed')]);
  await publisher.stop();
});

test('SessionFramePublisher keeps one upload in flight and only the newest pending frame', async () => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const child = fakeChild();
  const uploads = [];
  client.publishFrame = (_streamId, frame) => {
    const completion = deferred();
    uploads.push({ frame, completion });
    return completion.promise;
  };
  const publisher = new SessionFramePublisher({ client, sessionDisplay, spawnProcess: () => child });
  await startReady(publisher);
  child.stdout.emit('data', Buffer.concat([jpeg('first'), jpeg('second'), jpeg('newest')]));
  await waitFor(() => uploads.length === 1, 'first in-flight upload');
  uploads[0].completion.resolve({ sequence: 1 });
  await waitFor(() => uploads.length === 2, 'newest pending upload');
  assert.deepEqual(uploads.map(({ frame }) => frame.bytes), [jpeg('first'), jpeg('newest')]);
  assert.deepEqual(uploads.map(({ frame }) => frame.sequence), [1, 2]);
  uploads[1].completion.resolve({ sequence: 2 });
  await publisher.stop();
});

test('SessionFramePublisher fails soft for spawn errors and oversized frames', async () => {
  const spawnClient = fakeClient([{ version: 1, interested: true, closed: false }]);
  const spawnPublisher = new SessionFramePublisher({
    client: spawnClient,
    sessionDisplay,
    spawnProcess: () => { throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }); },
  });
  await startReady(spawnPublisher);
  await waitFor(() => /ENOENT/.test(spawnPublisher.snapshot().lastError ?? ''), 'soft spawn failure');
  await spawnPublisher.stop();

  const frameClient = fakeClient([{ version: 1, interested: true, closed: false }]);
  const child = fakeChild();
  const framePublisher = new SessionFramePublisher({
    client: frameClient,
    sessionDisplay,
    spawnProcess: () => child,
    maxFrameBytes: 12,
  });
  await startReady(framePublisher);
  child.stdout.emit('data', Buffer.concat([jpeg('far-too-large'), jpeg('ok')]));
  await waitFor(() => frameClient.published.length === 1, 'valid frame after oversized frame');
  assert.deepEqual(frameClient.published[0].bytes, jpeg('ok'));
  assert.match(framePublisher.snapshot().lastError, /512 KiB/);
  await framePublisher.stop();
  await framePublisher.stop();
  assert.equal(frameClient.closeCalls, 1);
});

test('SessionFramePublisher retries a lost open response and reconciles the stream', async (t) => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  let openCalls = 0;
  client.openFrameStream = async () => {
    openCalls += 1;
    if (openCalls === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return { streamId: 'stream-after-lost-response', width: 1280, height: 800 };
  };
  const child = fakeChild();
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    spawnProcess: () => child,
    retryBaseMs: 1,
    retryMaxMs: 4,
  });
  t.after(() => publisher.stop());
  await startReady(publisher);
  await waitFor(() => openCalls === 2 && publisher.snapshot().capturing, 'open retry');
  assert.equal(publisher.snapshot().streamId, 'stream-after-lost-response');
  await publisher.stop();
});

test('SessionFramePublisher retries one static frame with the same sequence before suppressing duplicates', async (t) => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const child = fakeChild();
  const attempts = [];
  client.publishFrame = async (streamId, frame) => {
    attempts.push({ streamId, sequence: frame.sequence, bytes: Buffer.from(frame.bytes) });
    if (attempts.length === 1) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    return { sequence: frame.sequence };
  };
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    spawnProcess: () => child,
    retryBaseMs: 1,
    retryMaxMs: 4,
  });
  t.after(() => publisher.stop());
  await startReady(publisher);
  child.stdout.emit('data', jpeg('static'));
  await waitFor(() => attempts.length === 2, 'static frame retry');
  assert.deepEqual(attempts.map(({ sequence }) => sequence), [1, 1]);
  assert.deepEqual(attempts.map(({ bytes }) => bytes), [jpeg('static'), jpeg('static')]);
  child.stdout.emit('data', jpeg('static'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(attempts.length, 2);
  await publisher.stop();
});

test('SessionFramePublisher retains a failed current frame and only the newest pending change', async (t) => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const child = fakeChild();
  const first = deferred();
  const attempts = [];
  client.publishFrame = async (_streamId, frame) => {
    attempts.push({ sequence: frame.sequence, bytes: Buffer.from(frame.bytes) });
    if (attempts.length === 1) return first.promise;
    return { sequence: frame.sequence };
  };
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    spawnProcess: () => child,
    retryBaseMs: 1,
    retryMaxMs: 4,
  });
  t.after(() => publisher.stop());
  await startReady(publisher);
  child.stdout.emit('data', jpeg('static-current'));
  await waitFor(() => attempts.length === 1, 'current upload');
  child.stdout.emit('data', Buffer.concat([jpeg('older-pending'), jpeg('newest-pending')]));
  first.reject(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
  await waitFor(() => attempts.length === 3, 'retry and newest pending upload');
  assert.deepEqual(attempts.map(({ sequence }) => sequence), [1, 1, 2]);
  assert.deepEqual(attempts.map(({ bytes }) => bytes), [
    jpeg('static-current'),
    jpeg('static-current'),
    jpeg('newest-pending'),
  ]);
  await publisher.stop();
});

test('SessionFramePublisher stops retrying when worker authorization is replaced', async (t) => {
  const client = fakeClient();
  let openCalls = 0;
  client.openFrameStream = async () => {
    openCalls += 1;
    throw Object.assign(new Error('worker token is invalid'), {
      code: 'WORKER_UNAUTHORIZED',
      status: 401,
    });
  };
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    spawnProcess: () => fakeChild(),
    retryBaseMs: 1,
    retryMaxMs: 4,
  });
  t.after(() => publisher.stop());
  await startReady(publisher);
  await waitFor(() => publisher.snapshot().status === 'error', 'authorization stop');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(openCalls, 1);
  await publisher.stop();
});

test('SessionFramePublisher reopens after control-plane frame state is lost', async (t) => {
  const client = fakeClient();
  const opens = [];
  const demandWait = deferred();
  const published = [];
  let secondStreamStarted = false;
  client.openFrameStream = async () => {
    const streamId = `stream-${opens.length + 1}`;
    opens.push(streamId);
    return { streamId, width: 1280, height: 800 };
  };
  client.frameDemand = async (streamId, { signal }) => {
    if (streamId === 'stream-1' && published.length === 0) {
      return { streamId, version: 1, interested: true, closed: false };
    }
    if (streamId === 'stream-1') {
      const abort = () => demandWait.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal?.addEventListener('abort', abort, { once: true });
      return demandWait.promise;
    }
    if (!secondStreamStarted) {
      secondStreamStarted = true;
      return { streamId, version: 1, interested: true, closed: false };
    }
    return new Promise((_resolve, reject) => signal?.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      ));
  };
  client.publishFrame = async (streamId, frame) => {
    published.push({ streamId, sequence: frame.sequence, bytes: Buffer.from(frame.bytes) });
    return { sequence: frame.sequence };
  };
  const children = [];
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    retryBaseMs: 1,
    retryMaxMs: 4,
  });
  t.after(() => publisher.stop());
  await startReady(publisher);
  await waitFor(() => children.length === 1, 'first capture process');
  children[0].stdout.emit('data', jpeg('same-static-screen'));
  await waitFor(() => published.length === 1, 'first stream frame');
  demandWait.reject(Object.assign(new Error('display stream was lost'), {
    code: 'DISPLAY_STREAM_NOT_FOUND',
    status: 404,
  }));
  await waitFor(() => opens.length === 2 && children.length === 2, 'reopened stream');
  children[1].stdout.emit('data', jpeg('same-static-screen'));
  await waitFor(() => published.length === 2, 'frame on reopened stream');
  assert.deepEqual(published.map(({ streamId, sequence }) => ({ streamId, sequence })), [
    { streamId: 'stream-1', sequence: 1 },
    { streamId: 'stream-2', sequence: 1 },
  ]);
  await publisher.stop();
});

test('SessionFramePublisher reports real asynchronous spawn and nonzero exit failures softly', async (t) => {
  const missingClient = fakeClient([{ version: 1, interested: true, closed: false }]);
  const missing = new SessionFramePublisher({
    client: missingClient,
    sessionDisplay,
    ffmpegBin: `/definitely-missing-ffmpeg-${process.pid}`,
  });
  t.after(() => missing.stop());
  await startReady(missing);
  await waitFor(() => /ENOENT/.test(missing.snapshot().lastError ?? ''), 'real missing executable failure');
  assert.match(missing.snapshot().lastError, /ENOENT/);
  assert.equal(missing.snapshot().capturing, false);
  await missing.stop();

  const exitClient = fakeClient([{ version: 1, interested: true, closed: false }]);
  const nonzero = new SessionFramePublisher({
    client: exitClient,
    sessionDisplay,
    ffmpegBin: process.execPath,
  });
  t.after(() => nonzero.stop());
  await startReady(nonzero);
  await waitFor(() => /exited/.test(nonzero.snapshot().lastError ?? ''), 'real nonzero process exit');
  assert.match(nonzero.snapshot().lastError, /exited/);
  assert.ok(nonzero.snapshot().lastError.length <= 5_000);
  assert.equal(nonzero.snapshot().capturing, false);
  await nonzero.stop();
});

test('SessionFramePublisher waits for Studio readiness and cannot restart after teardown', async () => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const children = [];
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  await publisher.start();
  await waitFor(() => client.waiting.length === 1, 'early viewer demand');
  assert.equal(children.length, 0);
  assert.equal(client.published.length, 0);

  publisher.markReady();
  await waitFor(() => children.length === 1, 'capture after Studio readiness');
  await publisher.stop();
  publisher.markReady();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(children.length, 1);
  assert.equal(publisher.snapshot().ready, false);
});

test('SessionFramePublisher uses SessionDisplay snapshot dimensions for stream and ffmpeg', async () => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  let opened;
  client.openFrameStream = async ({ width, height }) => {
    opened = { width, height };
    return { streamId: 'stream-sized', width, height };
  };
  let videoSize;
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay: {
      status: 'ready',
      display: ':77',
      environment: sessionDisplay.environment,
      snapshot: () => ({ status: 'ready', display: ':77', width: 1366, height: 768 }),
    },
    spawnProcess: (_command, args) => {
      videoSize = args[args.indexOf('-video_size') + 1];
      return fakeChild();
    },
  });
  await startReady(publisher);
  await waitFor(() => publisher.snapshot().capturing, 'dimension capture');
  assert.deepEqual(opened, { width: 1366, height: 768 });
  assert.equal(videoSize, '1366x768');
  await publisher.stop();
});

test('SessionFramePublisher exposes no capability after a fixed headless fallback', async () => {
  const client = fakeClient();
  let opens = 0;
  client.openFrameStream = async () => { opens += 1; throw new Error('must not open'); };
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay: {
      status: 'error',
      environment: null,
      snapshot: () => ({ status: 'error', width: 1280, height: 800 }),
    },
  });
  assert.equal((await publisher.start()).status, 'unavailable');
  publisher.markReady();
  assert.equal(publisher.snapshot().ready, false);
  assert.equal(publisher.snapshot().streamId, null);
  assert.equal(opens, 0);
  await publisher.stop();
});

test('SessionFramePublisher retries asynchronous ffmpeg errors without new demand', async () => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const children = [];
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    retryBaseMs: 5,
    retryMaxMs: 10,
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  await startReady(publisher);
  await waitFor(() => children.length === 1, 'initial ffmpeg');
  children[0].emit('error', Object.assign(new Error('ffmpeg pipe failed'), { code: 'EPIPE' }));
  await waitFor(() => children.length === 2, 'ffmpeg error retry');
  assert.equal(client.waiting.length, 1, 'retry must not require another demand response');
  await publisher.stop();
});

test('SessionFramePublisher retries nonzero ffmpeg exits without new demand', async () => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const children = [];
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    retryBaseMs: 5,
    retryMaxMs: 10,
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  await startReady(publisher);
  await waitFor(() => children.length === 1, 'initial ffmpeg');
  children[0].exitCode = 1;
  children[0].emit('close', 1, null);
  await waitFor(() => children.length === 2, 'ffmpeg exit retry');
  assert.equal(client.waiting.length, 1, 'retry must not require another demand response');
  await publisher.stop();
});

test('SessionFramePublisher cancels ffmpeg retries on demand loss, readiness loss, and stop', async () => {
  for (const cancellation of ['demand', 'readiness', 'stop']) {
    const client = fakeClient([{ version: 1, interested: true, closed: false }]);
    const children = [];
    const publisher = new SessionFramePublisher({
      client,
      sessionDisplay,
      retryBaseMs: 50,
      retryMaxMs: 50,
      spawnProcess: () => {
        const child = fakeChild();
        children.push(child);
        return child;
      },
    });
    await startReady(publisher);
    await waitFor(() => children.length === 1 && client.waiting.length === 1, `${cancellation} initial capture`);
    children[0].emit('error', new Error('capture failed'));
    if (cancellation === 'demand') {
      client.waiting.shift().resolve({ version: 2, interested: false, closed: false });
      await waitFor(() => publisher.snapshot().interested === false, 'demand loss');
    } else if (cancellation === 'readiness') {
      await publisher.markUnavailable();
      assert.equal(publisher.snapshot().ready, false);
    } else {
      await publisher.stop();
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(children.length, 1, `${cancellation} must cancel capture retry`);
    await publisher.stop();
  }
});

test('SessionFramePublisher fences a blocked upload on readiness loss and republishes only a fresh frame', async () => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const uploads = [];
  const children = [];
  client.publishFrame = (streamId, frame) => {
    const completion = deferred();
    uploads.push({ streamId, frame, completion });
    return completion.promise;
  };
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  await startReady(publisher);
  await waitFor(() => children.length === 1, 'initial capture');
  const pixels = jpeg('same-pixels');
  children[0].stdout.emit('data', pixels);
  await waitFor(() => uploads.length === 1, 'blocked upload');

  await publisher.markUnavailable();
  assert.equal(uploads[0].frame.signal.aborted, true);
  children[0].stdout.emit('data', jpeg('stale-child'));
  publisher.markReady();
  await waitFor(() => children.length === 2, 'fresh capture after readiness');
  children[1].stdout.emit('data', pixels);
  assert.equal(uploads.length, 1, 'the old upload remains the sole in-flight publication');

  uploads[0].completion.resolve({ sequence: 1 });
  await waitFor(() => uploads.length === 2, 'fresh frame publication');
  assert.deepEqual(uploads.map(({ frame }) => frame.sequence), [1, 2]);
  assert.deepEqual(uploads.map(({ frame }) => frame.bytes), [pixels, pixels]);
  uploads[1].completion.resolve({ sequence: 2 });
  await waitFor(() => publisher.snapshot().uploading === false, 'fresh upload completion');
  await publisher.stop();
});

test('SessionFramePublisher drops a late upload failure after demand loss', async () => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const uploads = [];
  const children = [];
  client.publishFrame = (streamId, frame) => {
    const completion = deferred();
    uploads.push({ streamId, frame, completion });
    return completion.promise;
  };
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    retryBaseMs: 5,
    retryMaxMs: 5,
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  await startReady(publisher);
  await waitFor(() => children.length === 1 && client.waiting.length === 1, 'initial demand');
  const pixels = jpeg('demand-frame');
  children[0].stdout.emit('data', pixels);
  await waitFor(() => uploads.length === 1, 'blocked demand upload');

  client.waiting.shift().resolve({ version: 2, interested: false, closed: false });
  await waitFor(() => uploads[0].frame.signal.aborted, 'upload abort on demand loss');
  uploads[0].completion.reject(Object.assign(new Error('late EPIPE'), { code: 'EPIPE' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(uploads.length, 1, 'a late failure may not retry stale publication');

  await waitFor(() => client.waiting.length === 1, 'renewed demand waiter');
  client.waiting.shift().resolve({ version: 3, interested: true, closed: false });
  await waitFor(() => children.length === 2, 'capture after demand returns');
  children[1].stdout.emit('data', pixels);
  await waitFor(() => uploads.length === 2, 'fresh upload after demand returns');
  assert.equal(uploads[1].frame.sequence, 2);
  uploads[1].completion.resolve({ sequence: 2 });
  await publisher.stop();
});

test('SessionFramePublisher cancels publication backoff when demand disappears', async () => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const child = fakeChild();
  let attempts = 0;
  client.publishFrame = async () => {
    attempts += 1;
    throw Object.assign(new Error('temporary upload failure'), { code: 'EPIPE' });
  };
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    retryBaseMs: 50,
    retryMaxMs: 50,
    spawnProcess: () => child,
  });
  await startReady(publisher);
  await waitFor(() => client.waiting.length === 1, 'demand waiter');
  child.stdout.emit('data', jpeg('retry-frame'));
  await waitFor(() => attempts === 1, 'first upload attempt');
  client.waiting.shift().resolve({ version: 2, interested: false, closed: false });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(attempts, 1);
  assert.equal(publisher.snapshot().pending, false);
  await publisher.stop();
});

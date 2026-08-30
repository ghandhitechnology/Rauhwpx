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
  child.kill = (signal) => {
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
  environment: { DISPLAY: ':77', XAUTHORITY: '/workspace/home/.Xauthority' },
};

test('SessionFramePublisher starts and stops ffmpeg from demand', async () => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const children = [];
  const publisher = new SessionFramePublisher({
    client,
    sessionDisplay,
    spawnProcess(command, args, options) {
      assert.equal(command, 'ffmpeg');
      assert.deepEqual(args.slice(args.indexOf('-framerate'), args.indexOf('-framerate') + 2), ['-framerate', '2']);
      assert.ok(args.includes('1280x800'));
      assert.equal(options.env.DISPLAY, ':77');
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  await publisher.start();
  await waitFor(() => children.length === 1 && client.waiting.length === 1, 'capture start');
  client.waiting.shift().resolve({ version: 2, interested: false, closed: false });
  await waitFor(() => children[0].signalCode === 'SIGTERM', 'capture stop');
  await publisher.stop();
  assert.equal(client.closeCalls, 1);
});

test('SessionFramePublisher suppresses duplicate JPEGs', async () => {
  const client = fakeClient([{ version: 1, interested: true, closed: false }]);
  const child = fakeChild();
  const publisher = new SessionFramePublisher({ client, sessionDisplay, spawnProcess: () => child, now: () => 1_800_000_000_000 });
  await publisher.start();
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
  await publisher.start();
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
  await spawnPublisher.start();
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
  await framePublisher.start();
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
  await publisher.start();
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
  await publisher.start();
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
  await publisher.start();
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
  await publisher.start();
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
  await publisher.start();
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
  await missing.start();
  await waitFor(() => missing.snapshot().status === 'error', 'real missing executable failure');
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
  await nonzero.start();
  await waitFor(() => nonzero.snapshot().status === 'error', 'real nonzero process exit');
  assert.match(nonzero.snapshot().lastError, /exited/);
  assert.ok(nonzero.snapshot().lastError.length <= 5_000);
  assert.equal(nonzero.snapshot().capturing, false);
  await nonzero.stop();
});

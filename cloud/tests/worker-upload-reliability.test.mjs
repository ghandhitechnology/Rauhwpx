import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorkerClient } from '../worker/client.mjs';

test('worker frame control supports the Unix socket transport', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-worker-frame-socket-'));
  const socketPath = path.join(root, 'control.sock');
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    requests.push({ method: request.method, url: request.url, headers: request.headers, bytes });
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/display/streams') && request.method === 'POST') {
      response.writeHead(201).end(JSON.stringify({ streamId: 'stream-socket' }));
    } else if (request.url.includes('/demand')) {
      response.end(JSON.stringify({ streamId: 'stream-socket', version: 1, interested: false, closed: false }));
    } else if (request.url.includes('/frames/1')) {
      response.writeHead(201).end(JSON.stringify({ streamId: 'stream-socket', sequence: 1 }));
    } else if (request.method === 'DELETE') {
      response.end(JSON.stringify({ streamId: 'stream-socket', closed: true }));
    } else {
      response.writeHead(404).end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
    }
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const client = new WorkerClient({
    socketPath,
    token: 'worker-token',
    sessionId: 'session-socket',
  });
  const opened = await client.openFrameStream({ width: 1280, height: 800 });
  await client.frameDemand(opened.streamId);
  const frame = Buffer.from([0xff, 0xd8, 0x61, 0xff, 0xd9]);
  await client.publishFrame(opened.streamId, {
    sequence: 1,
    capturedAt: '2026-08-30T00:00:00.000Z',
    bytes: frame,
  });
  await client.closeFrameStream(opened.streamId);
  assert.deepEqual(requests.map(({ method }) => method), ['POST', 'GET', 'POST', 'DELETE']);
  assert.deepEqual(JSON.parse(requests[0].bytes), { width: 1280, height: 800 });
  assert.match(requests[1].url, /\/display\/streams\/stream-socket\/demand\?after=0$/);
  assert.deepEqual(requests[2].bytes, frame);
  assert.equal(requests[2].headers['content-type'], 'image/jpeg');
  assert.equal(requests[2].headers['x-rauhwpx-frame-captured-at'], '2026-08-30T00:00:00.000Z');
});

test('worker upload resumes from the committed offset after a chunk response is lost', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-worker-upload-'));
  const filename = path.join(root, 'result.hwpx');
  const expected = Buffer.from('abcdefgh');
  await fs.writeFile(filename, expected);
  let committed = Buffer.alloc(0);
  let initCalls = 0;
  let chunkCalls = 0;

  const server = http.createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    if (request.url.endsWith('/uploads/init')) {
      initCalls += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(committed.length === expected.length ? {
        uploadId: 'upload-1', chunkSize: 4, offset: committed.length,
        status: 'complete', blob: { id: 'result-digest', size: expected.length },
      } : {
        uploadId: 'upload-1', chunkSize: 4, offset: committed.length, status: 'uploading', blob: null,
      }));
      return;
    }
    if (request.url.endsWith('/uploads/upload-1/chunks')) {
      chunkCalls += 1;
      const offset = Number(request.headers['x-upload-offset']);
      assert.equal(offset, committed.length);
      committed = Buffer.concat([committed, ...body]);
      if (chunkCalls === 1) {
        request.socket.destroy();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        uploadId: 'upload-1', chunkSize: 4, offset: committed.length,
        status: 'complete', blob: { id: 'result-digest', size: expected.length },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const client = new WorkerClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'worker-token',
    sessionId: 'session-1',
  });
  const blob = await client.upload(filename, { name: 'result.hwpx', kind: 'result' });

  assert.deepEqual(committed, expected);
  assert.equal(blob.id, 'result-digest');
  assert.equal(initCalls, 2, 'the second init reconciles the server offset');
  assert.equal(chunkCalls, 2, 'the committed first chunk is not resent');
});

test('worker upload retries a plain-text transient server response', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-worker-503-'));
  const filename = path.join(root, 'result.hwpx');
  const bytes = Buffer.from('finished-result');
  await fs.writeFile(filename, bytes);
  let calls = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request body */ }
    calls += 1;
    if (calls === 1) {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('upstream temporarily unavailable');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      uploadId: null,
      chunkSize: 64,
      offset: bytes.length,
      status: 'complete',
      blobExists: true,
      blob: { id: 'result-digest', size: bytes.length },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const client = new WorkerClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'worker-token',
    sessionId: 'session-1',
  });
  const blob = await client.upload(filename, { name: 'result.hwpx', kind: 'result' });

  assert.equal(blob.id, 'result-digest');
  assert.equal(calls, 2);
});

test('worker upload reconciles a commit made by the final allowed chunk attempt', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-worker-final-reconcile-'));
  const filename = path.join(root, 'result.hwpx');
  const expected = Buffer.from('x');
  await fs.writeFile(filename, expected);
  let committed = false;
  let initCalls = 0;
  let chunkCalls = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request body */ }
    if (request.url.endsWith('/uploads/init')) {
      initCalls += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(committed ? {
        uploadId: 'upload-final', chunkSize: 1, offset: 1, status: 'complete',
        blob: { id: 'result-digest', size: 1 },
      } : {
        uploadId: 'upload-final', chunkSize: 1, offset: 0, status: 'uploading', blob: null,
      }));
      return;
    }
    if (request.url.endsWith('/uploads/upload-final/chunks')) {
      chunkCalls += 1;
      if (chunkCalls === 5) committed = true;
      request.socket.destroy();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const client = new WorkerClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'worker-token',
    sessionId: 'session-1',
  });
  const blob = await client.upload(filename, { name: 'result.hwpx', kind: 'result' });

  assert.equal(blob.id, 'result-digest');
  assert.equal(chunkCalls, 5);
  assert.equal(initCalls, 6, 'one final init proves the exhausted chunk actually committed');
});

test('persistent turn completion retries its exact boundary after a lost response', async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    if (requests.length === 1) { request.socket.destroy(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'running', turnsUsed: 1 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const client = new WorkerClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'worker', sessionId: 'room' });
  const completion = { outcome: 'completed', boundaryOperationId: 'turn-1-digest' };
  assert.deepEqual(await client.completeTurn(completion, { retry: true }), { status: 'running', turnsUsed: 1 });
  assert.deepEqual(requests, [completion, completion]);
});

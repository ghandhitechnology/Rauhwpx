import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorkerClient } from '../worker/client.mjs';

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

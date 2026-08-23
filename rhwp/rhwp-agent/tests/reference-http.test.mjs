import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createReferenceHttpHandler } from '../reference-http.mjs';
import { ReferenceStore } from '../reference-store.mjs';

const SESSION_SCOPES = [
  { scope: 'global', scopeId: 'global' },
  { scope: 'document', scopeId: 'doc-a' },
  { scope: 'chat', scopeId: 'chat-a' },
  { scope: 'chat', scopeId: 'chat-b' },
];

async function fixture(t, storeOptions = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-reference-http-'));
  const store = await new ReferenceStore({ root: path.join(parent, 'refs'), ...storeOptions }).init();
  const handler = createReferenceHttpHandler({
    store,
    tokens: ['test-secret'],
    allowedScopes: SESSION_SCOPES,
  });
  const server = http.createServer((req, res) => {
    void handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1')).then((handled) => {
      if (!handled && !res.writableEnded) { res.statusCode = 404; res.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(parent, { recursive: true, force: true });
  });
  return { store, server, base };
}

test('raw upload/list/search/delete API is bearer-authenticated and CORS-safe', async (t) => {
  const { base } = await fixture(t);
  const origin = 'http://127.0.0.1:7700';
  const preflight = await fetch(`${base}/reference-files`, { method: 'OPTIONS', headers: { Origin: origin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);

  const unauthorized = await fetch(`${base}/reference-files?scope=chat&scopeId=a`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).message, 'A valid bearer token is required');

  const upload = await fetch(`${base}/reference-files?scope=chat&scopeId=chat-a`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-secret',
      Origin: origin,
      'Content-Type': 'text/plain',
      'X-File-Name': encodeURIComponent('한글 참고.txt'),
    },
    body: '라온 프로젝트 일정과 배포 품질 검증',
  });
  assert.equal(upload.status, 201);
  assert.equal(upload.headers.get('access-control-allow-origin'), origin);
  const created = await upload.json();
  assert.equal(created.name, '한글 참고.txt');
  assert.equal(created.scope, 'chat');
  assert.equal(created.scopeId, 'chat-a');
  assert.equal(created.status, 'ready');
  assert.equal(created.error, null);
  assert.match(created.sha256, /^[a-f0-9]{64}$/);
  assert.ok(created.chunkCount >= 1);

  const headers = { Authorization: 'Bearer test-secret', Origin: origin };
  const listed = await (await fetch(`${base}/reference-files?scope=chat&scopeId=chat-a`, { headers })).json();
  assert.equal(listed.files.length, 1);
  const searched = await (await fetch(`${base}/reference-search?scope=chat&scopeId=chat-a&q=${encodeURIComponent('배포 일정')}&limit=1`, { headers })).json();
  assert.equal(searched.results.length, 1, 'legacy frontend limit query should be accepted');
  assert.equal(searched.results[0].fileId, created.id);

  const removed = await fetch(`${base}/reference-files/${created.id}?scope=chat&scopeId=chat-a`, { method: 'DELETE', headers });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).status, 'deleted');
});

test('message attachment staging is invisible until promotion and can be discarded', async (t) => {
  const { base, store } = await fixture(t);
  const headers = {
    Authorization: 'Bearer test-secret',
    'Content-Type': 'text/plain',
    'X-File-Name': 'draft.txt',
  };
  const response = await fetch(`${base}/reference-staging?scopeId=chat-a`, {
    method: 'POST', headers, body: '메시지 전송 전 임시 파일',
  });
  assert.equal(response.status, 201);
  const staged = (await response.json()).staged;
  assert.equal(staged.status, 'ready');
  assert.equal(store.list({ scope: 'chat', scopeId: 'chat-a' }).length, 0);

  const wrongChat = await fetch(`${base}/reference-staging/${staged.id}?scopeId=chat-b`, {
    method: 'DELETE', headers: { Authorization: 'Bearer test-secret' },
  });
  assert.equal(wrongChat.status, 404);
  const discarded = await fetch(`${base}/reference-staging/${staged.id}?scopeId=chat-a`, {
    method: 'DELETE', headers: { Authorization: 'Bearer test-secret' },
  });
  assert.equal(discarded.status, 200);
});

test('message attachment staging rejects document and global scopes', async (t) => {
  const { base } = await fixture(t);
  const headers = {
    Authorization: 'Bearer test-secret',
    'Content-Type': 'text/plain',
    'X-File-Name': 'draft.txt',
  };
  for (const [scope, scopeId] of [['document', 'doc-a'], ['global', 'global']]) {
    const response = await fetch(`${base}/reference-staging?scope=${scope}&scopeId=${scopeId}`, {
      method: 'POST', headers, body: 'invalid staging scope',
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'REFERENCE_SCOPE_FORBIDDEN');
  }
});

test('the exact packaged origin is CORS-echoed', async (t) => {
  const { base } = await fixture(t);
  const origin = 'rauhwpx://app';
  const response = await fetch(`${base}/reference-files?scope=global`, {
    headers: { Authorization: 'Bearer test-secret', Origin: origin },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
});

test('non-loopback browser origins are denied with a top-level error message', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/reference-files?scope=global`, {
    headers: { Authorization: 'Bearer test-secret', Origin: 'https://evil.example' },
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, 'REFERENCE_ORIGIN_DENIED');
  assert.equal(body.message, body.error.message);

  const lookalike = await fetch(`${base}/reference-files?scope=global`, {
    headers: { Authorization: 'Bearer test-secret', Origin: 'rauhwpx://app.evil' },
  });
  assert.equal(lookalike.status, 403);
});

function chunkedRequest(url, { chunks, abort = false }) {
  return new Promise((resolve) => {
    const req = http.request(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-secret',
        'Content-Type': 'text/plain',
        'X-File-Name': 'stream.txt',
      },
    });
    let responseBody = '';
    req.on('response', (res) => {
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on('error', () => resolve({ status: null, body: '' }));
    for (const chunk of chunks) req.write(chunk);
    if (abort) req.destroy();
    else req.end();
  });
}

async function waitForEmpty(directory) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await fs.readdir(directory)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(await fs.readdir(directory), []);
}

test('chunked oversize and aborted HTTP uploads clean staging files', async (t) => {
  const { base, store } = await fixture(t, { maxFileBytes: 32 });
  const oversized = await chunkedRequest(`${base}/reference-files?scope=chat&scopeId=chat-a`, {
    chunks: [Buffer.alloc(20, 65), Buffer.alloc(20, 66)],
  });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).error.code, 'REFERENCE_FILE_TOO_LARGE');
  await waitForEmpty(store.stagingDir);

  await chunkedRequest(`${base}/reference-files?scope=chat&scopeId=chat-a`, {
    chunks: [Buffer.from('partial upload')],
    abort: true,
  });
  await waitForEmpty(store.stagingDir);
});

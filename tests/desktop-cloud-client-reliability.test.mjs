import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

import { CloudClient, CloudHttpError } from '../desktop/cloud-client.mjs';
import { normalizeCloudProfile } from '../desktop/cloud-profile.mjs';

const PROFILE = normalizeCloudProfile({
  endpoint: 'http://127.0.0.1:7740/rauhwpx-cloud',
  transport: 'ssh-tunnel',
  ssh: { host: '127.0.0.1', user: 'tester' },
});

function memoryVault(profile = PROFILE) {
  const values = new Map([
    ['cloud.profile', JSON.stringify(profile)],
    ['cloud.refresh', 'r'.repeat(32)],
  ]);
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); return true; },
    delete: async (key) => values.delete(key),
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokenResponse() {
  return jsonResponse({
    accessToken: 'access-token',
    accessExpiresAt: Date.now() + 60_000,
    refreshToken: 's'.repeat(32),
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(response, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(200, {
    'content-length': bytes.length,
    'content-type': 'application/json',
  });
  response.end(bytes);
}

async function startFaultServer(t, handleRequest) {
  const server = createServer((request, response) => {
    if (request.url === '/rauhwpx-cloud/v1/token/refresh') {
      writeJson(response, {
        accessToken: 'access-token',
        accessExpiresAt: Date.now() + 60_000,
        refreshToken: 's'.repeat(32),
      });
      return;
    }
    handleRequest(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}/rauhwpx-cloud`;
}

function localTransport(baseUrl) {
  return {
    acquire: async () => ({ baseUrl, release() {} }),
  };
}

function portableTimeline() {
  const now = Date.now();
  return {
    schema: 'rauhwpx.cloud.timeline',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    thread: {
      id: 'thread-1',
      title: 'Task',
      createdAt: now,
      updatedAt: now,
      agent: 'codex',
      model: 'gpt-5.6',
      effort: 'high',
      messages: [],
    },
  };
}

test('upload reconciles a committed chunk when its response is lost', async () => {
  const payload = Buffer.from('abcdefgh');
  const payloadDigest = sha256(payload);
  let remoteOffset = 0;
  let initCalls = 0;
  let chunkCalls = 0;
  let loseResponse = true;
  const state = () => ({
    uploadId: 'upload-1',
    chunkSize: 4,
    offset: remoteOffset,
    status: remoteOffset === payload.length ? 'complete' : 'uploading',
    blobExists: remoteOffset === payload.length,
    blob: remoteOffset === payload.length
      ? { id: payloadDigest, sha256: payloadDigest, size: payload.length }
      : null,
  });
  const client = new CloudClient({
    vault: memoryVault(),
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/v1/token/refresh')) return tokenResponse();
      if (url.endsWith('/v1/uploads/init')) {
        initCalls += 1;
        return jsonResponse(state());
      }
      if (url.includes('/chunks')) {
        chunkCalls += 1;
        assert.equal(Number(options.headers['x-upload-offset']), remoteOffset);
        remoteOffset += Buffer.from(options.body).length;
        if (loseResponse) {
          loseResponse = false;
          throw new TypeError('fetch failed');
        }
        return jsonResponse(state());
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const result = await client.uploadBlob({
    bytes: payload,
    name: 'source.hwpx',
    kind: 'document',
    sessionId: 'session-1234',
    retryAttempts: 3,
    retryBaseMs: 0,
  });

  assert.equal(result.blobId, payloadDigest);
  assert.equal(remoteOffset, payload.length);
  assert.equal(initCalls, 2, 'the lost response is reconciled through authoritative init state');
  assert.equal(chunkCalls, 2, 'the already committed first chunk is not sent twice');
});

test('upload succeeds when the final retry commits but its response is lost', async () => {
  const payload = Buffer.from('x');
  const payloadDigest = sha256(payload);
  let remoteOffset = 0;
  let initCalls = 0;
  let chunkCalls = 0;
  const state = () => ({
    uploadId: 'upload-final-reconcile',
    chunkSize: 1,
    offset: remoteOffset,
    status: remoteOffset === payload.length ? 'complete' : 'uploading',
    blobExists: remoteOffset === payload.length,
    blob: remoteOffset === payload.length
      ? { id: payloadDigest, sha256: payloadDigest, size: payload.length }
      : null,
  });
  const client = new CloudClient({
    vault: memoryVault(),
    fetchImpl: async (url) => {
      if (url.endsWith('/v1/token/refresh')) return tokenResponse();
      if (url.endsWith('/v1/uploads/init')) {
        initCalls += 1;
        return jsonResponse(state());
      }
      if (url.includes('/chunks')) {
        chunkCalls += 1;
        if (chunkCalls === 2) remoteOffset = payload.length;
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const result = await client.uploadBlob({
    bytes: payload,
    name: 'source.hwpx',
    kind: 'document',
    sessionId: 'session-final-reconcile',
    retryAttempts: 2,
    retryBaseMs: 0,
  });

  assert.equal(result.blobId, payloadDigest);
  assert.equal(remoteOffset, payload.length);
  assert.equal(chunkCalls, 2);
  assert.equal(initCalls, 3, 'the exhausted final response is reconciled once without replay');
});

test('upload never exceeds the chunk size advertised by the server', async () => {
  const payload = Buffer.alloc(20, 0x61);
  const payloadDigest = sha256(payload);
  const chunkSizes = [];
  let remoteOffset = 0;
  const state = () => ({
    uploadId: 'upload-small-chunks',
    chunkSize: 8,
    offset: remoteOffset,
    status: remoteOffset === payload.length ? 'complete' : 'uploading',
    blobExists: false,
    blob: remoteOffset === payload.length
      ? { id: payloadDigest, sha256: payloadDigest, size: payload.length }
      : null,
  });
  const client = new CloudClient({
    vault: memoryVault(),
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/v1/token/refresh')) return tokenResponse();
      if (url.endsWith('/v1/uploads/init')) return jsonResponse(state());
      if (url.includes('/chunks')) {
        const chunk = Buffer.from(options.body);
        chunkSizes.push(chunk.length);
        remoteOffset += chunk.length;
        return jsonResponse(state());
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  await client.uploadBlob({
    bytes: payload,
    name: 'source.hwpx',
    kind: 'document',
    sessionId: 'session-5678',
  });

  assert.deepEqual(chunkSizes, [8, 8, 4]);
});

test('upload failure budget resets after each reconciled durable chunk', async () => {
  const payload = Buffer.from('abcdef');
  const payloadDigest = sha256(payload);
  let remoteOffset = 0;
  let chunkCalls = 0;
  const state = () => ({
    uploadId: 'upload-progress-reset',
    chunkSize: 1,
    offset: remoteOffset,
    status: remoteOffset === payload.length ? 'complete' : 'uploading',
    blobExists: remoteOffset === payload.length,
    blob: remoteOffset === payload.length
      ? { id: payloadDigest, sha256: payloadDigest, size: payload.length }
      : null,
  });
  const client = new CloudClient({
    vault: memoryVault(),
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/v1/token/refresh')) return tokenResponse();
      if (url.endsWith('/v1/uploads/init')) return jsonResponse(state());
      if (url.includes('/chunks')) {
        chunkCalls += 1;
        assert.equal(Number(options.headers['x-upload-offset']), remoteOffset);
        remoteOffset += Buffer.from(options.body).length;
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const result = await client.uploadBlob({
    bytes: payload,
    name: 'source.hwpx',
    kind: 'document',
    sessionId: 'session-progress',
    retryAttempts: 5,
    retryBaseMs: 0,
  });

  assert.equal(result.blobId, payloadDigest);
  assert.equal(remoteOffset, payload.length);
  assert.equal(chunkCalls, payload.length);
});

test('a real truncated HTTP body becomes a retryable transport error', async (t) => {
  const baseUrl = await startFaultServer(t, (_request, response) => {
    response.writeHead(200, {
      'content-length': '8',
      'content-type': 'application/octet-stream',
      'x-content-sha256': 'a'.repeat(64),
    });
    response.flushHeaders();
    response.write('part');
    setImmediate(() => response.destroy());
  });
  const client = new CloudClient({
    vault: memoryVault(),
    transport: localTransport(baseUrl),
  });

  await assert.rejects(
    client.downloadResult('session-1234', { retryAttempts: 1, timeoutMs: 200 }),
    (error) => error instanceof CloudHttpError
      && error.code === 'UND_ERR_SOCKET'
      && error.retryable === true,
  );
});

test('safe result downloads retry a real truncated HTTP body', async (t) => {
  const bytes = Buffer.from('verified-result');
  let resultCalls = 0;
  const baseUrl = await startFaultServer(t, (_request, response) => {
    resultCalls += 1;
    response.writeHead(200, {
      'content-length': resultCalls === 1 ? bytes.length + 4 : bytes.length,
      'content-type': 'application/octet-stream',
      'x-content-sha256': sha256(bytes),
      'x-document-name': 'result.hwpx',
    });
    if (resultCalls === 1) {
      response.flushHeaders();
      response.write(bytes.subarray(0, 4));
      setImmediate(() => response.destroy());
      return;
    }
    response.end(bytes);
  });
  const client = new CloudClient({
    vault: memoryVault(),
    transport: localTransport(baseUrl),
  });

  const result = await client.downloadResult('session-1234', {
    retryAttempts: 2,
    retryBaseMs: 0,
    timeoutMs: 200,
  });

  assert.deepEqual(result.bytes, bytes);
  assert.equal(resultCalls, 2);
});

test('the request deadline remains active while a real HTTP body is stalled', async (t) => {
  let resultCalls = 0;
  const baseUrl = await startFaultServer(t, (_request, response) => {
    resultCalls += 1;
    response.writeHead(200, {
      'content-length': '8',
      'content-type': 'application/octet-stream',
      'x-content-sha256': 'a'.repeat(64),
    });
    response.flushHeaders();
    response.write('a');
  });
  const client = new CloudClient({
    vault: memoryVault(),
    transport: localTransport(baseUrl),
  });

  const started = Date.now();
  await assert.rejects(
    client.downloadResult('session-1234', { retryAttempts: 1, timeoutMs: 30 }),
    (error) => error instanceof CloudHttpError
      && error.code === 'ETIMEDOUT'
      && error.retryable === true,
  );
  assert.equal(resultCalls, 1);
  assert.ok(Date.now() - started < 500, 'the short injected deadline should terminate the stalled body promptly');
});

test('a wrong-content-type event stream has a bounded body deadline', async (t) => {
  const baseUrl = await startFaultServer(t, (_request, response) => {
    response.writeHead(200, {
      'content-length': '8',
      'content-type': 'application/json',
    });
    response.flushHeaders();
    response.write('{');
  });
  const client = new CloudClient({
    vault: memoryVault(),
    transport: localTransport(baseUrl),
  });

  const started = Date.now();
  await assert.rejects(
    client.readEvents('session-1234', 0, { nonStreamTimeoutMs: 30 }),
    (error) => error instanceof CloudHttpError
      && error.code === 'ETIMEDOUT'
      && error.retryable === true,
  );
  assert.ok(Date.now() - started < 500);
});

test('transfer readiness retries transient cold-server failures', async () => {
  let healthCalls = 0;
  const client = new CloudClient({
    vault: memoryVault(),
    fetchImpl: async (url) => {
      assert.ok(url.endsWith('/v1/health'));
      healthCalls += 1;
      if (healthCalls < 3) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNREFUSED' };
        throw error;
      }
      return jsonResponse({ ok: true, protocolVersion: 1, version: '1.0.0' });
    },
  });

  const readiness = await client.assertTransferReady({
    retryAttempts: 3,
    retryBaseMs: 0,
    timeoutMs: 100,
  });

  assert.equal(readiness.health.ok, true);
  assert.equal(healthCalls, 3);
});

test('pairing redemption retries a lost response with one idempotency key', async () => {
  const requests = [];
  const client = new CloudClient({
    vault: memoryVault(),
    fetchImpl: async (url, options = {}) => {
      assert.ok(url.endsWith('/v1/pairing/redeem'));
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      }
      return jsonResponse({
        accessToken: 'paired-access-token',
        accessExpiresAt: Date.now() + 60_000,
        refreshToken: 'p'.repeat(32),
        device: { id: 'device-1', name: 'Reliable desktop' },
      });
    },
  });

  const result = await client.redeemPairingCode('ABCD-EFGH-JKLM', 'Reliable desktop', {
    profile: PROFILE,
    persist: false,
    retryAttempts: 2,
    retryBaseMs: 0,
  });

  assert.equal(result.device.id, 'device-1');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.match(requests[0].requestId, /^[0-9a-f-]{36}$/);
});

test('idempotent commands retry a lost response with the same command id', async () => {
  const requests = [];
  const client = new CloudClient({
    vault: memoryVault(),
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/v1/token/refresh')) return tokenResponse();
      assert.ok(url.endsWith('/v1/sessions/session-1/commands'));
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      }
      return jsonResponse({ session: { id: 'session-1', status: 'queued', stateVersion: 2 } });
    },
  });

  const result = await client.command(
    'session-1',
    'session.activate',
    { expectedVersion: 1 },
    'activate_session_1',
    { retryAttempts: 2, retryBaseMs: 0 },
  );

  assert.equal(result.session.status, 'queued');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].commandId, 'activate_session_1');
  assert.deepEqual(requests[1], requests[0]);
});

test('refresh rotation retries a lost response with the same refresh token', async () => {
  const refreshBodies = [];
  const client = new CloudClient({
    vault: memoryVault(),
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/v1/token/refresh')) {
        refreshBodies.push(JSON.parse(options.body));
        if (refreshBodies.length === 1) {
          const error = new TypeError('fetch failed');
          error.cause = { code: 'ECONNRESET' };
          throw error;
        }
        return tokenResponse();
      }
      if (url.endsWith('/v1/profile')) return jsonResponse({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  assert.equal((await client.profile()).ok, true);
  assert.equal(refreshBodies.length, 2);
  assert.deepEqual(refreshBodies[1], refreshBodies[0]);
});

test('a transport failure does not blindly replay session creation', async () => {
  let sessionCreateCalls = 0;
  const client = new CloudClient({
    vault: memoryVault(),
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/v1/token/refresh')) return tokenResponse();
      if (url.endsWith('/v1/uploads/init')) {
        const body = JSON.parse(options.body);
        return jsonResponse({
          uploadId: null,
          chunkSize: 8,
          offset: body.size,
          status: 'complete',
          blobExists: true,
          blob: { id: body.sha256, sha256: body.sha256, size: body.size },
        });
      }
      if (url.endsWith('/v1/sessions')) {
        sessionCreateCalls += 1;
        throw new TypeError('fetch failed');
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  await assert.rejects(client.transfer({
    sessionId: 'handoff-1234',
    threadId: 'thread-1',
    documentId: 'document-1',
    provider: 'codex',
    executionConfig: {
      model: 'gpt-5.6', effort: 'high', workflow: 'direct', permissionProfile: 'unrestricted',
    },
    goal: 'Continue',
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    timeline: portableTimeline(),
    limits: { maxTurns: 100 },
  }), (error) => error.retryable === true);

  assert.equal(sessionCreateCalls, 1);
});

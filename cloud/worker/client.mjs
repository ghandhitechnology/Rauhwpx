import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';

const DEFAULT_TIMEOUT_MS = 120_000;

function request(socketPath, token, method, pathname, { body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const requestHandle = http.request({
      socketPath,
      method,
      path: pathname,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(bytes ? { 'Content-Length': bytes.length } : {}),
        ...(!Buffer.isBuffer(body) && body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
    }, resolve);
    requestHandle.once('error', reject);
    // Inactivity timeout: a stalled control plane aborts the call while a
    // healthy streaming transfer that keeps moving is never cut off.
    requestHandle.setTimeout(timeoutMs, () => {
      requestHandle.destroy(new Error(`Worker control request timed out after ${timeoutMs} ms`));
    });
    requestHandle.end(bytes);
  });
}

async function responseJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Worker control response exceeded 2 MiB');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const error = new Error(body.error?.message || `Worker control returned ${response.statusCode}`);
    error.code = body.error?.code;
    throw error;
  }
  return body;
}

export class WorkerClient {
  constructor({ socketPath, token, sessionId }) {
    this.socketPath = socketPath;
    this.token = token;
    this.sessionId = sessionId;
    this.prefix = `/v1/internal/worker/${encodeURIComponent(sessionId)}`;
  }

  async json(method, action, body) {
    return responseJson(await request(this.socketPath, this.token, method, `${this.prefix}${action}`, { body }));
  }

  manifest() { return this.json('GET', '/manifest'); }
  credentials() { return this.json('GET', '/credentials'); }
  messages() { return this.json('GET', '/messages'); }
  control() { return this.json('GET', '/control'); }
  pauseAck() { return this.json('POST', '/pause-ack', {}); }
  heartbeat() { return this.json('POST', '/heartbeat', {}); }
  event(type, payload) { return this.json('POST', '/events', { type, payload }); }
  checkpoint(checkpoint) { return this.json('POST', '/checkpoints', checkpoint); }
  commitBoundary(boundary) { return this.json('POST', '/boundary', boundary); }
  completeTurn() { return this.json('POST', '/turn-complete', {}); }
  finishClaim() { return this.json('POST', '/finish-claim', {}); }
  takeoverAck() { return this.json('POST', '/takeover-ack', {}); }
  suspend(code, message) { return this.json('POST', '/suspend', { code, message }); }

  async download(blobId, destination) {
    const response = await request(this.socketPath, this.token, 'GET', `${this.prefix}/blobs/${blobId}`);
    if (response.statusCode !== 200) return responseJson(response);
    const digest = createHash('sha256');
    response.on('data', (chunk) => digest.update(chunk));
    await pipeline(response, createWriteStream(destination, { mode: 0o600 }));
    if (digest.digest('hex') !== blobId) {
      await fs.rm(destination, { force: true });
      throw new Error(`Downloaded blob ${blobId} failed digest verification`);
    }
  }

  async upload(filename, { name, kind }) {
    const bytes = await fs.readFile(filename);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let state = await this.json('POST', '/uploads/init', { sha256, size: bytes.length, name, kind });
    while (state.status !== 'complete') {
      const chunk = bytes.subarray(state.offset, state.offset + state.chunkSize);
      state = await responseJson(await request(
        this.socketPath,
        this.token,
        'POST',
        `${this.prefix}/uploads/${state.uploadId}/chunks`,
        { body: chunk, headers: { 'X-Upload-Offset': String(state.offset), 'Content-Type': 'application/octet-stream' } },
      ));
    }
    return state.blob;
  }

  publishResult(blob) { return this.json('POST', '/result', { blobId: blob.id, size: blob.size }); }
  publishTimeline(blob) { return this.json('POST', '/timeline', { blobId: blob.id, size: blob.size }); }
}

import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = 120_000;
const UPLOAD_RETRY_ATTEMPTS = 5;

function request(target, token, method, pathname, { body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const requestHandle = http.request({
      ...(target.socketPath ? { socketPath: target.socketPath } : {
        hostname: target.url.hostname,
        port: target.url.port,
      }),
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
  const text = Buffer.concat(chunks, size).toString('utf8');
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (error) {
      if (response.statusCode >= 200 && response.statusCode < 300) throw error;
    }
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const error = new Error(body.error?.message || `Worker control returned ${response.statusCode}`);
    error.code = body.error?.code;
    error.status = response.statusCode;
    error.details = body.error?.details;
    throw error;
  }
  return body;
}

function retryableUploadError(error) {
  if (error?.code === 'UPLOAD_OFFSET_MISMATCH') return true;
  const status = Number(error?.status);
  if (status === 408 || status === 429 || status >= 500) return true;
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase();
  return [
    'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETDOWN',
    'ENETUNREACH', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  ].includes(code) || /socket hang up|terminated|timed out/i.test(String(error?.message ?? ''));
}

export class WorkerClient {
  constructor({ socketPath, baseUrl, token, sessionId }) {
    if (!socketPath && !baseUrl) throw new Error('Worker control endpoint is required');
    this.target = socketPath ? { socketPath } : { url: new URL(baseUrl) };
    this.token = token;
    this.sessionId = sessionId;
    this.prefix = `/v1/internal/worker/${encodeURIComponent(sessionId)}`;
  }

  async json(method, action, body) {
    return responseJson(await request(this.target, this.token, method, `${this.prefix}${action}`, { body }));
  }

  async retryJson(method, action, body, { attempts = UPLOAD_RETRY_ATTEMPTS } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.json(method, action, body);
      } catch (error) {
        lastError = error;
        if (!retryableUploadError(error) || attempt === attempts - 1) throw error;
        await delay(Math.min(2_000, 100 * (2 ** attempt)));
      }
    }
    throw lastError;
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
    const response = await request(this.target, this.token, 'GET', `${this.prefix}/blobs/${blobId}`);
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
    const initializeOnce = () => this.json('POST', '/uploads/init', {
      sha256, size: bytes.length, name, kind,
    });
    const initialize = async () => {
      let lastError;
      for (let attempt = 0; attempt < UPLOAD_RETRY_ATTEMPTS; attempt += 1) {
        try {
          return await initializeOnce();
        } catch (error) {
          lastError = error;
          if (!retryableUploadError(error) || attempt === UPLOAD_RETRY_ATTEMPTS - 1) throw error;
          await delay(Math.min(2_000, 100 * (2 ** attempt)));
        }
      }
      throw lastError;
    };
    let state = await initialize();
    let failures = 0;
    while (state.status !== 'complete') {
      const offset = Number(state.offset);
      const chunkSize = Number(state.chunkSize);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length
        || !Number.isSafeInteger(chunkSize) || chunkSize < 1) {
        throw new Error('Worker upload returned invalid resumable state');
      }
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
      try {
        state = await responseJson(await request(
          this.target,
          this.token,
          'POST',
          `${this.prefix}/uploads/${state.uploadId}/chunks`,
          { body: chunk, headers: { 'X-Upload-Offset': String(offset), 'Content-Type': 'application/octet-stream' } },
        ));
        failures = 0;
      } catch (error) {
        failures += 1;
        if (!retryableUploadError(error)) throw error;
        if (failures >= UPLOAD_RETRY_ATTEMPTS) {
          // A final chunk can be durable even when every allowed response was
          // lost. Reconcile once without replaying the chunk before reporting
          // failure, and continue only if the server proves forward progress.
          try {
            const reconciled = await initializeOnce();
            const reconciledOffset = reconciled.status === 'complete'
              ? bytes.length
              : Number(reconciled.offset);
            if (Number.isSafeInteger(reconciledOffset) && reconciledOffset > offset) {
              state = reconciled;
              failures = 0;
              continue;
            }
          } catch {
            // Keep the original chunk error; it best describes the failed
            // operation when reconciliation is unavailable.
          }
          throw error;
        }
        await delay(Math.min(2_000, 100 * (2 ** (failures - 1))));
        // The control plane may have committed the bytes before its response was
        // lost. Re-initialization returns the durable offset (or completed blob),
        // so the worker never blindly writes the same chunk twice.
        state = await initialize();
      }
    }
    return state.blob;
  }

  publishResult(blob) { return this.retryJson('POST', '/result', { blobId: blob.id, size: blob.size }); }
  publishTimeline(blob) { return this.retryJson('POST', '/timeline', { blobId: blob.id, size: blob.size }); }
}

export const __test = { retryableUploadError };

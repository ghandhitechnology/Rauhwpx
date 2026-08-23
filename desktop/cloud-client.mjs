import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeCloudProfile } from './cloud-profile.mjs';

const PROFILE_SECRET = 'cloud.profile';
const REFRESH_SECRET = 'cloud.refresh';
const DEVICE_SECRET = 'cloud.device';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_TIMELINE_BYTES = 100 * 1024 * 1024;
const RESPONSE_PROOF_VERSION = 'RAUHWpx-response-v1';
const SSE_PROOF_VERSION = 'RAUHWpx-sse-event-v1';
const SSE_STREAM_PROTOCOL = 'rauhwpx-sse-v1';
const SSE_STREAM_DIGEST = digest(Buffer.from(SSE_STREAM_PROTOCOL));
const RESPONSE_PROOF_CONTEXT = Symbol('rauhwpx-response-proof-context');

export class CloudHttpError extends Error {
  constructor(message, { status = 0, code = '', details = null } = {}) {
    super(message);
    this.name = 'CloudHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validTokenBundle(value) {
  return value
    && typeof value.accessToken === 'string'
    && value.accessToken
    && typeof value.refreshToken === 'string'
    && value.refreshToken;
}

function validPortableTimeline(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schema !== 'rauhwpx.cloud.timeline' || value.version !== 1) return false;
  if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) return false;
  const thread = value.thread;
  return Boolean(
    thread
    && typeof thread === 'object'
    && !Array.isArray(thread)
    && typeof thread.id === 'string'
    && thread.id
    && typeof thread.title === 'string'
    && typeof thread.createdAt === 'number'
    && Number.isFinite(thread.createdAt)
    && typeof thread.updatedAt === 'number'
    && Number.isFinite(thread.updatedAt)
    && ['claude', 'codex', 'pi', 'grok', 'cursor'].includes(thread.agent)
    && typeof thread.model === 'string'
    && typeof thread.effort === 'string'
    && Array.isArray(thread.messages)
    && thread.messages.every((message) => (
      message
      && typeof message === 'object'
      && !Array.isArray(message)
      && ['user', 'assistant', 'system'].includes(message.role)
      && typeof message.text === 'string'
    )),
  );
}

function joinEndpoint(endpoint, pathname) {
  const base = `${endpoint.replace(/\/+$/, '')}/`;
  return new URL(String(pathname).replace(/^\/+/, ''), base).toString();
}

async function responseJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new CloudHttpError('Cloud response is too large', { status: response.status });
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) {
    throw new CloudHttpError('Cloud response is too large', { status: response.status });
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    throw new CloudHttpError('Cloud returned invalid JSON', { status: response.status });
  }
}

function verifyServerPin(profile, response, body = null) {
  if (!profile.serverPublicKey) return;
  const received = response.headers.get('x-rauhwpx-server-key') || body?.serverPublicKey || '';
  if (received !== profile.serverPublicKey) {
    throw new CloudHttpError('Cloud server identity does not match the paired VPS', {
      status: response.status,
      code: 'SERVER_IDENTITY_MISMATCH',
    });
  }
}

function pinnedPublicKey(serverPublicKey) {
  const encoded = String(serverPublicKey ?? '').replace(/^ed25519:/, '');
  try {
    return createPublicKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'spki' });
  } catch {
    throw new CloudHttpError('Pinned cloud server identity is invalid', {
      code: 'SERVER_IDENTITY_INVALID',
    });
  }
}

function canonicalResponse({ nonce, method, pathAndQuery, status, digest: contentDigest }) {
  return `${RESPONSE_PROOF_VERSION}\n${nonce}\n${method}\n${pathAndQuery}\n${status}\n${contentDigest}`;
}

function canonicalSseEvent({ nonce, method, pathAndQuery, status, sequence, event, contentDigest }) {
  return `${SSE_PROOF_VERSION}\n${nonce}\n${method}\n${pathAndQuery}\n${status}\n${sequence}\n${event}\n${contentDigest}`;
}

function proofSignature(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 64 && bytes.toString('base64url') === value ? bytes : null;
}

function verifyResponseProof(profile, response, context) {
  verifyServerPin(profile, response);
  if (!profile.serverPublicKey) return null;
  const contentDigest = response.headers.get('x-rauhwpx-content-sha256') || '';
  const signature = proofSignature(response.headers.get('x-rauhwpx-response-signature'));
  if (!/^[a-f0-9]{64}$/.test(contentDigest) || !signature) {
    throw new CloudHttpError('Cloud response is missing a valid identity proof', {
      status: response.status,
      code: 'SERVER_PROOF_MISSING',
    });
  }
  const canonical = canonicalResponse({ ...context, status: response.status, digest: contentDigest });
  if (!verify(null, Buffer.from(canonical, 'utf8'), pinnedPublicKey(profile.serverPublicKey), signature)) {
    throw new CloudHttpError('Cloud response identity proof is invalid', {
      status: response.status,
      code: 'SERVER_PROOF_INVALID',
    });
  }
  return contentDigest;
}

function verifySseFrame(profile, frame, context) {
  const sequence = Number(frame.id);
  const contentDigest = digest(Buffer.from(frame.data, 'utf8'));
  const signature = proofSignature(frame.signature);
  if (!Number.isSafeInteger(sequence) || sequence < 1
    || frame.sha256 !== contentDigest || !signature) {
    throw new CloudHttpError('Cloud event identity proof is invalid', { code: 'SSE_PROOF_INVALID' });
  }
  const canonical = canonicalSseEvent({
    ...context,
    status: 200,
    sequence,
    event: frame.event,
    contentDigest,
  });
  if (!verify(null, Buffer.from(canonical, 'utf8'), pinnedPublicKey(profile.serverPublicKey), signature)) {
    throw new CloudHttpError('Cloud event identity proof is invalid', { code: 'SSE_PROOF_INVALID' });
  }
  return sequence;
}

function sseFrames(buffer) {
  const frames = [];
  let rest = buffer.replace(/\r\n/g, '\n');
  let boundary;
  while ((boundary = rest.indexOf('\n\n')) !== -1) {
    const raw = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    let event = 'message';
    let id = '';
    let sha256 = '';
    let signature = '';
    const data = [];
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'rauhwpx-sha256') sha256 = value;
      else if (field === 'rauhwpx-signature') signature = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) frames.push({ event, id, sha256, signature, data: data.join('\n') });
  }
  return { frames, rest };
}

export class CloudClient {
  #vault;
  #fetch;
  #profile = null;
  #accessToken = '';
  #accessExpiresAt = 0;
  #refreshPromise = null;
  #profileGeneration = 0;
  #credentialChain = Promise.resolve();

  constructor({ vault, fetchImpl = globalThis.fetch } = {}) {
    if (!vault) throw new Error('CloudClient requires a secret vault');
    if (typeof fetchImpl !== 'function') throw new Error('CloudClient requires fetch');
    this.#vault = vault;
    this.#fetch = fetchImpl;
  }

  async loadProfile() {
    if (this.#profile) return this.#profile;
    const stored = await this.#vault.get(PROFILE_SECRET);
    if (!stored) return null;
    this.#profile = normalizeCloudProfile(JSON.parse(stored));
    return this.#profile;
  }

  async saveProfile(raw) {
    const profile = normalizeCloudProfile(raw);
    const previous = await this.loadProfile().catch(() => null);
    return this.activateProfile(profile, {
      preserveCredentials: Boolean(previous && previous.endpoint === profile.endpoint),
    });
  }

  async activateProfile(raw, {
    tokens = null,
    device,
    preserveCredentials = false,
  } = {}) {
    const profile = normalizeCloudProfile(raw);
    if (tokens && !validTokenBundle(tokens)) {
      throw new CloudHttpError('Cloud pairing response is invalid');
    }
    return this.#withCredentialLock(async () => {
      this.#profileGeneration += 1;
      try {
        const previous = {
          profile: await this.#vault.get(PROFILE_SECRET),
          refresh: await this.#vault.get(REFRESH_SECRET),
          device: await this.#vault.get(DEVICE_SECRET),
          cachedProfile: this.#profile,
          accessToken: this.#accessToken,
          accessExpiresAt: this.#accessExpiresAt,
        };
        const restore = async (key, value) => {
          if (value === null) await this.#vault.delete(key);
          else await this.#vault.set(key, value);
        };
        try {
          await this.#vault.set(PROFILE_SECRET, JSON.stringify(profile));
          if (tokens) await this.#vault.set(REFRESH_SECRET, tokens.refreshToken);
          else if (!preserveCredentials) await this.#vault.delete(REFRESH_SECRET);
          if (device !== undefined) {
            if (device === null) await this.#vault.delete(DEVICE_SECRET);
            else await this.#vault.set(DEVICE_SECRET, JSON.stringify(device));
          } else if (!preserveCredentials) {
            await this.#vault.delete(DEVICE_SECRET);
          }
        } catch (error) {
          this.#profile = previous.cachedProfile;
          this.#accessToken = previous.accessToken;
          this.#accessExpiresAt = previous.accessExpiresAt;
          try {
            await restore(PROFILE_SECRET, previous.profile);
            await restore(REFRESH_SECRET, previous.refresh);
            await restore(DEVICE_SECRET, previous.device);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Cloud profile activation failed and the previous credentials could not be fully restored',
            );
          }
          throw error;
        }
        this.#profile = profile;
        if (tokens) {
          this.#accessToken = tokens.accessToken;
          this.#accessExpiresAt = Date.parse(tokens.accessExpiresAt) || Date.now() + 14 * 60_000;
        } else if (!preserveCredentials) {
          this.#accessToken = '';
          this.#accessExpiresAt = 0;
        }
        return profile;
      } finally {
        this.#profileGeneration += 1;
      }
    });
  }

  async disconnect() {
    return this.#withCredentialLock(async () => {
      this.#profileGeneration += 1;
      try {
        this.#accessToken = '';
        this.#accessExpiresAt = 0;
        await Promise.all([
          this.#vault.delete(REFRESH_SECRET).catch(() => false),
          this.#vault.delete(DEVICE_SECRET).catch(() => false),
        ]);
      } finally {
        this.#profileGeneration += 1;
      }
    });
  }

  async isPaired() {
    return Boolean(await this.#vault.get(REFRESH_SECRET));
  }

  async deviceId() {
    const stored = await this.#vault.get(DEVICE_SECRET);
    if (!stored) return null;
    try {
      const device = JSON.parse(stored);
      return typeof device?.id === 'string' ? device.id : null;
    } catch {
      return null;
    }
  }

  async health(profileOverride = null) {
    const profile = profileOverride ? normalizeCloudProfile(profileOverride) : await this.#requiredProfile();
    return this.#request('/v1/health', {
      auth: false,
      expectedPin: Boolean(profile.serverPublicKey),
      profile,
    });
  }

  async redeemPairingCode(code, deviceName, { profile: profileOverride = null, persist = true } = {}) {
    const profile = profileOverride ? normalizeCloudProfile(profileOverride) : await this.#requiredProfile();
    const result = await this.#request('/v1/pairing/redeem', {
      method: 'POST',
      auth: false,
      expectedPin: Boolean(profile.serverPublicKey),
      body: { code: String(code ?? '').trim(), deviceName: String(deviceName ?? '').trim() },
      profile,
    });
    if (!validTokenBundle(result)) throw new CloudHttpError('Cloud pairing response is invalid');
    if (persist) {
      await this.activateProfile(profile, { tokens: result, device: result.device ?? null });
    }
    return {
      device: result.device,
      accessExpiresAt: result.accessExpiresAt,
      ...(persist ? {} : { credentials: {
        accessToken: result.accessToken,
        accessExpiresAt: result.accessExpiresAt,
        refreshToken: result.refreshToken,
        device: result.device ?? null,
      } }),
    };
  }

  async profile() {
    return this.#request('/v1/profile');
  }

  async createPairingCode(deviceName = '') {
    return this.#request('/v1/pairing', { method: 'POST', body: { deviceName } });
  }

  async transfer({
    sessionId,
    threadId,
    documentId,
    provider,
    executionConfig,
    goal,
    documentName,
    documentBytes,
    timeline = [],
    resources = [],
    limits,
    onProgress = () => {},
    onSessionCreated = () => {},
    onSessionActivated = () => {},
    signal,
  }) {
    const document = Buffer.from(documentBytes ?? []);
    if (!document.length) throw new Error('A saved document is required for cloud transfer');
    if (document.length > MAX_RESULT_BYTES) throw new Error('Document exceeds the 64 MiB cloud limit');
    if (!validPortableTimeline(timeline)) throw new Error('Portable cloud timeline is invalid');
    const documentUpload = await this.uploadBlob({
      bytes: document,
      name: documentName,
      kind: 'document',
      sessionId,
      signal,
      onProgress: (progress) => onProgress({ phase: 'document', ...progress }),
    });
    const uploadedResources = [];
    for (let index = 0; index < resources.length; index += 1) {
      const resource = resources[index];
      const upload = await this.uploadBlob({
        bytes: Buffer.from(resource.bytes ?? []),
        name: resource.name,
        kind: 'reference',
        sessionId,
        signal,
        onProgress: (progress) => onProgress({
          phase: 'resource',
          index,
          totalResources: resources.length,
          ...progress,
        }),
      });
      uploadedResources.push({
        name: resource.name,
        sha256: upload.sha256,
        size: upload.size,
        blobId: upload.blobId,
        kind: 'reference',
      });
    }
    const timelineBytes = Buffer.from(JSON.stringify(timeline), 'utf8');
    const timelineUpload = await this.uploadBlob({
      bytes: timelineBytes,
      name: 'timeline.json',
      kind: 'timeline',
      sessionId,
      signal,
      onProgress: (progress) => onProgress({ phase: 'timeline', ...progress }),
    });
    await onProgress({ phase: 'committing', loaded: 1, total: 1 });
    const created = await this.#request('/v1/sessions', {
      method: 'POST',
      signal,
      body: {
        sessionId,
        provider,
        executionConfig,
        goal,
        clientContext: { threadId, documentId },
        originDocument: {
          name: documentName,
          size: documentUpload.size,
          blobId: documentUpload.blobId,
        },
        resources: uploadedResources,
        timeline: { blobId: timelineUpload.blobId, size: timelineUpload.size },
        limits: {
          maxDurationSeconds: limits?.maxDurationSeconds
            ?? (Number(limits?.maxDurationMinutes) * 60 || undefined),
          maxTurns: limits?.maxTurns,
        },
      },
    });
    const cloudSessionId = created.id ?? created.sessionId ?? sessionId;
    await onSessionCreated({
      sessionId: cloudSessionId,
      stateVersion: created.stateVersion ?? created.version ?? 1,
      session: created,
    });
    const activated = await this.command(
      cloudSessionId,
      'session.activate',
      { expectedVersion: created.stateVersion ?? created.version ?? 1 },
      `activate_${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}`,
      { signal },
    );
    await onSessionActivated({
      sessionId: cloudSessionId,
      stateVersion: activated.session?.stateVersion ?? activated.session?.version
        ?? activated.stateVersion ?? activated.version ?? 2,
      eventSeq: Number(activated.eventSeq) || 0,
      session: activated.session ?? activated,
    });
    return activated.session ?? created;
  }

  async uploadBlob({ bytes, name, kind, sessionId, onProgress = () => {}, signal }) {
    const payload = Buffer.from(bytes ?? []);
    const sha256 = digest(payload);
    const initialized = await this.#request('/v1/uploads/init', {
      method: 'POST',
      signal,
      body: { sha256, size: payload.length, name, kind, sessionId },
    });
    if (initialized.blobExists) {
      await onProgress({ loaded: payload.length, total: payload.length });
      return {
        ...initialized,
        sha256,
        size: payload.length,
        blobId: initialized.blob?.id ?? sha256,
      };
    }
    const chunkSize = Math.max(64 * 1024, Math.min(Number(initialized.chunkSize) || 1024 * 1024, 8 * 1024 * 1024));
    let offset = Math.max(0, Math.min(Number(initialized.offset) || 0, payload.length));
    let finalProgress = null;
    while (offset < payload.length) {
      const chunk = payload.subarray(offset, Math.min(offset + chunkSize, payload.length));
      const progress = await this.#request(`/v1/uploads/${encodeURIComponent(initialized.uploadId)}/chunks`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/octet-stream',
          'x-upload-offset': String(offset),
        },
        rawBody: chunk,
      });
      const nextOffset = Number(progress.offset);
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > payload.length) {
        throw new CloudHttpError('Cloud upload returned an invalid offset', { code: 'INVALID_UPLOAD_OFFSET' });
      }
      offset = nextOffset;
      finalProgress = progress;
      await onProgress({ loaded: offset, total: payload.length });
    }
    return {
      ...initialized,
      sha256,
      size: payload.length,
      offset,
      blobId: finalProgress?.blob?.id ?? sha256,
    };
  }

  async session(sessionId) {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async sessions() {
    const result = await this.#request('/v1/sessions');
    return Array.isArray(result.sessions) ? result.sessions : [];
  }

  async takeoverState(sessionId) {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/takeover`);
  }

  async downloadTimeline(sessionId) {
    const response = await this.#rawRequest(`/v1/sessions/${encodeURIComponent(sessionId)}/timeline`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TIMELINE_BYTES) {
      throw new CloudHttpError('Cloud timeline exceeds 100 MiB');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_TIMELINE_BYTES) {
      throw new CloudHttpError('Cloud timeline size is invalid');
    }
    const expected = response.headers.get('x-content-sha256') || '';
    const sha256 = digest(bytes);
    if (!expected || expected !== sha256) {
      throw new CloudHttpError('Cloud timeline failed integrity verification');
    }
    let timeline;
    try {
      timeline = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new CloudHttpError('Cloud timeline is invalid JSON');
    }
    if (!validPortableTimeline(timeline)) {
      throw new CloudHttpError('Cloud timeline does not match the portable timeline schema');
    }
    return {
      bytes,
      timeline,
      sha256,
      size: bytes.length,
      boundaryOperation: response.headers.get('x-boundary-operation') || '',
      boundaryRevision: Number(response.headers.get('x-boundary-revision')) || 0,
      boundaryTurn: Number(response.headers.get('x-boundary-turn')) || 0,
    };
  }

  async downloadCheckpoint(sessionId) {
    const response = await this.#rawRequest(`/v1/sessions/${encodeURIComponent(sessionId)}/checkpoint`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESULT_BYTES) {
      throw new CloudHttpError('Cloud checkpoint exceeds 64 MiB');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_RESULT_BYTES) {
      throw new CloudHttpError('Cloud checkpoint size is invalid');
    }
    const expected = response.headers.get('x-content-sha256') || '';
    const sha256 = digest(bytes);
    if (!expected || expected !== sha256) {
      throw new CloudHttpError('Cloud checkpoint failed integrity verification');
    }
    const encodedName = response.headers.get('x-document-name') || '';
    let name = encodedName;
    try { name = decodeURIComponent(encodedName); } catch {}
    return {
      bytes,
      sha256,
      size: bytes.length,
      name,
      revision: Number(response.headers.get('x-checkpoint-revision')) || 0,
      turn: Number(response.headers.get('x-checkpoint-turn')) || 0,
      boundaryOperation: response.headers.get('x-boundary-operation') || '',
    };
  }

  async command(sessionId, type, payload = {}, commandId = randomUUID(), options = {}) {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/commands`, {
      method: 'POST',
      signal: options.signal,
      body: { commandId, type, payload },
    });
  }

  async readEvents(sessionId, after = 0, { signal, onEvent = () => {} } = {}) {
    const response = await this.#rawRequest(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${encodeURIComponent(after)}`,
      { headers: { accept: 'text/event-stream' }, signal, timeoutMs: 0 },
    );
    const profile = await this.#requiredProfile();
    const proofContext = response[RESPONSE_PROOF_CONTEXT];
    if (!proofContext || response.headers.get('x-rauhwpx-stream-protocol') !== SSE_STREAM_PROTOCOL
      || response.headers.get('x-rauhwpx-content-sha256') !== SSE_STREAM_DIGEST) {
      throw new CloudHttpError('Cloud event stream identity proof is invalid', { code: 'SSE_PROOF_INVALID' });
    }
    if (!response.body) throw new CloudHttpError('Cloud event stream is unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastSequence = after;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_JSON_BYTES) throw new CloudHttpError('Cloud event frame is too large');
        const parsed = sseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          const verifiedSequence = verifySseFrame(profile, frame, proofContext);
          let data;
          try { data = JSON.parse(frame.data); } catch {
            throw new CloudHttpError('Cloud event payload is invalid JSON', { code: 'SSE_PAYLOAD_INVALID' });
          }
          const declaredSequence = Number(data.sequence ?? data.seq ?? verifiedSequence);
          if (declaredSequence !== verifiedSequence) {
            throw new CloudHttpError('Cloud event sequence does not match its identity proof', { code: 'SSE_PROOF_INVALID' });
          }
          if (verifiedSequence <= lastSequence) continue;
          lastSequence = verifiedSequence;
          await onEvent({ ...data, sequence: verifiedSequence, event: frame.event });
        }
      }
    } finally {
      reader.releaseLock();
    }
    return lastSequence;
  }

  async watchSession(sessionId, after = 0, { signal, onEvent = () => {}, retryBaseMs = 500 } = {}) {
    let sequence = after;
    let failures = 0;
    while (!signal?.aborted) {
      try {
        sequence = await this.readEvents(sessionId, sequence, { signal, onEvent });
        failures = 0;
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') break;
        failures += 1;
      }
      await delay(Math.min(30_000, retryBaseMs * (2 ** failures)), undefined, { signal }).catch(() => {});
    }
    return sequence;
  }

  async downloadResult(resultId) {
    const response = await this.#rawRequest(`/v1/results/${encodeURIComponent(resultId)}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESULT_BYTES) {
      throw new CloudHttpError('Cloud result exceeds 64 MiB');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_RESULT_BYTES) throw new CloudHttpError('Cloud result size is invalid');
    const expected = response.headers.get('x-content-sha256') || '';
    const sha256 = digest(bytes);
    if (expected && expected !== sha256) throw new CloudHttpError('Cloud result digest does not match');
    const encodedName = response.headers.get('x-document-name') || '';
    let name = encodedName;
    try { name = decodeURIComponent(encodedName); } catch {}
    return { bytes, sha256, size: bytes.length, name };
  }

  async confirmResultDownloaded(resultId, { sha256, size }) {
    return this.#request(`/v1/results/${encodeURIComponent(resultId)}/download-confirmed`, {
      method: 'POST',
      body: { sha256, size },
    });
  }

  async #requiredProfile() {
    const profile = await this.loadProfile();
    if (!profile) throw new Error('Cloud VPS is not configured');
    return profile;
  }

  #withCredentialLock(operation) {
    const run = this.#credentialChain.then(operation, operation);
    this.#credentialChain = run.catch(() => {});
    return run;
  }

  async #acceptTokens(tokens) {
    this.#accessToken = tokens.accessToken;
    this.#accessExpiresAt = Date.parse(tokens.accessExpiresAt) || Date.now() + 14 * 60_000;
    await this.#vault.set(REFRESH_SECRET, tokens.refreshToken);
  }

  async #ensureAccessToken() {
    if (this.#accessToken && this.#accessExpiresAt - Date.now() > 30_000) return this.#accessToken;
    if (!this.#refreshPromise) {
      const profileGeneration = this.#profileGeneration;
      this.#refreshPromise = (async () => {
        const refreshToken = await this.#vault.get(REFRESH_SECRET);
        if (!refreshToken) throw new CloudHttpError('This device must be paired with the VPS', {
          status: 401,
          code: 'PAIRING_REQUIRED',
        });
        const tokens = await this.#request('/v1/token/refresh', {
          method: 'POST',
          auth: false,
          body: { refreshToken },
          retryAuth: false,
        });
        if (!validTokenBundle(tokens)) throw new CloudHttpError('Cloud token response is invalid');
        return this.#withCredentialLock(async () => {
          if (profileGeneration !== this.#profileGeneration) {
            throw new CloudHttpError('Cloud profile changed during token refresh', {
              code: 'PROFILE_CHANGED',
            });
          }
          await this.#acceptTokens(tokens);
          return this.#accessToken;
        });
      })().finally(() => { this.#refreshPromise = null; });
    }
    return this.#refreshPromise;
  }

  async #request(pathname, options = {}) {
    const response = await this.#rawRequest(pathname, options);
    const body = await responseJson(response);
    const profile = options.profile ?? await this.#requiredProfile();
    verifyServerPin(profile, response, body);
    return body;
  }

  async #rawRequest(pathname, options = {}) {
    const profile = options.profile ?? await this.#requiredProfile();
    const auth = options.auth !== false;
    const headers = { ...(options.headers ?? {}) };
    const method = String(options.method ?? 'GET').toUpperCase();
    const requestUrl = joinEndpoint(profile.endpoint, pathname);
    const parsedRequestUrl = new URL(requestUrl);
    const proofContext = profile.serverPublicKey ? {
      nonce: randomBytes(24).toString('base64url'),
      method,
      pathAndQuery: `${parsedRequestUrl.pathname}${parsedRequestUrl.search}`,
    } : null;
    if (proofContext) headers['x-rauhwpx-request-nonce'] = proofContext.nonce;
    if (auth) headers.authorization = `Bearer ${await this.#ensureAccessToken()}`;
    let body = options.rawBody;
    if (body == null && options.body != null) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const abort = controller ? () => controller.abort(options.signal?.reason) : null;
    if (abort) {
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    }
    const timeout = timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error('Cloud request timed out')), timeoutMs)
      : null;
    let response;
    try {
      response = await this.#fetch(requestUrl, {
        method,
        headers,
        body,
        // Streaming requests have no request timeout. Passing the caller's
        // signal directly keeps cancellation attached after headers arrive and
        // throughout a blocked response-body read without a relay to clean up.
        signal: controller?.signal ?? options.signal,
        cache: 'no-store',
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abort) options.signal?.removeEventListener('abort', abort);
    }
    const expectedDigest = proofContext ? verifyResponseProof(profile, response, proofContext) : null;
    const isEventStream = response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream');
    if (proofContext && !isEventStream) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (digest(bytes) !== expectedDigest) {
        throw new CloudHttpError('Cloud response body failed identity verification', {
          status: response.status,
          code: 'SERVER_BODY_TAMPERED',
        });
      }
      response = new Response(bytes.length ? bytes : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    if (proofContext) Object.defineProperty(response, RESPONSE_PROOF_CONTEXT, { value: proofContext });
    if (response.status === 401 && auth && options.retryAuth !== false) {
      this.#accessToken = '';
      this.#accessExpiresAt = 0;
      await this.#ensureAccessToken();
      return this.#rawRequest(pathname, { ...options, retryAuth: false });
    }
    if (!response.ok) {
      const payload = await responseJson(response).catch(() => ({}));
      const cloudError = payload.error && typeof payload.error === 'object' ? payload.error : payload;
      throw new CloudHttpError(cloudError.message || `Cloud request failed with HTTP ${response.status}`, {
        status: response.status,
        code: cloudError.code,
        details: cloudError.details,
      });
    }
    return response;
  }
}

export const __test = {
  sseFrames,
  joinEndpoint,
  verifyServerPin,
  verifyResponseProof,
  verifySseFrame,
  canonicalResponse,
  canonicalSseEvent,
  validPortableTimeline,
};

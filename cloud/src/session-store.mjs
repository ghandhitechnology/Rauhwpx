import { EventEmitter } from 'node:events';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { transaction } from './database.mjs';
import { CloudError, DEFAULT_LIMITS, TRANSFER_LIMITS, publicSession } from './protocol.mjs';

const COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SUSPENDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TAKEOVER_RETENTION_MS = 24 * 60 * 60 * 1000;
const STAGED_RETENTION_MS = 24 * 60 * 60 * 1000;
const MUTABLE_STATES = new Set(['staged', 'queued', 'running', 'suspended']);

function parseEvent(row) {
  const payload = JSON.parse(row.payload_json);
  return {
    sessionId: row.session_id,
    seq: row.seq,
    type: row.type,
    stateVersion: payload.stateVersion,
    payload,
    createdAt: row.created_at,
  };
}

export class SessionStore {
  constructor(database, blobStore, { now = Date.now, maxQueuedSessions = DEFAULT_LIMITS.maxQueuedSessions } = {}) {
    this.database = database;
    this.blobStore = blobStore;
    this.now = now;
    this.maxQueuedSessions = maxQueuedSessions;
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
  }

  setProviderStatus(provider, status) {
    const checkedAt = status.checkedAt ?? this.now();
    const authenticated = status.authenticated ?? status.available;
    this.database.prepare(`
      INSERT INTO provider_status(provider, available, authenticated, version, error_code, error_message, setup_action, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        available = excluded.available,
        authenticated = excluded.authenticated,
        version = excluded.version,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        setup_action = excluded.setup_action,
        checked_at = excluded.checked_at
    `).run(
      provider,
      status.available ? 1 : 0,
      authenticated ? 1 : 0,
      status.version ?? null,
      status.errorCode ?? null,
      status.errorMessage ?? null,
      status.setupAction ?? null,
      checkedAt,
    );
    return this.providerStatus(provider);
  }

  providerStatus(provider) {
    const row = this.database.prepare('SELECT * FROM provider_status WHERE provider = ?').get(provider);
    return row ? {
      provider: row.provider,
      available: Boolean(row.available),
      authenticated: Boolean(row.authenticated),
      authRequired: Boolean(row.available && !row.authenticated),
      version: row.version,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      setupAction: row.setup_action,
      checkedAt: row.checked_at,
    } : {
      provider,
      available: false,
      authenticated: false,
      authRequired: false,
      version: null,
      errorCode: 'NOT_CHECKED',
      errorMessage: 'Provider has not been checked',
      setupAction: `sudo rauhwpx-cloud provider install ${provider}`,
      checkedAt: null,
    };
  }

  listProviderStatus() {
    return this.database.prepare('SELECT provider FROM provider_status ORDER BY provider').all()
      .map(({ provider }) => this.providerStatus(provider));
  }

  #requireBlob({ blobId, size }, label) {
    const blob = this.blobStore.get(blobId);
    if (!blob) throw new CloudError('BLOB_NOT_FOUND', `${label} upload is not complete`, 409, { blobId });
    if (blob.size !== size) throw new CloudError('BLOB_SIZE_MISMATCH', `${label} size does not match stored blob`, 409, { blobId });
    return blob;
  }

  createSession(device, input) {
    const provider = this.providerStatus(input.provider);
    if (!provider.available) {
      throw new CloudError('PROVIDER_UNAVAILABLE', `${input.provider} is not ready on this VPS`, 409, provider);
    }
    if (!provider.authenticated) {
      throw new CloudError('AUTH_REQUIRED', `${input.provider} must be authenticated on this VPS`, 409, provider);
    }
    this.#requireBlob(input.originDocument, 'Origin document');
    for (const resource of input.resources) this.#requireBlob(resource, `Resource ${resource.name}`);
    if (input.timeline) this.#requireBlob(input.timeline, 'Timeline');
    const now = this.now();
    const id = input.sessionId ?? randomUUID();
    const resources = [
      { ...input.originDocument, kind: 'document' },
      ...input.resources,
      ...(input.timeline ? [{ ...input.timeline, name: 'timeline.json', kind: 'timeline' }] : []),
    ];
    const transferBytes = resources.reduce((total, resource) => total + resource.size, 0);
    if (transferBytes > 512 * 1024 ** 2) {
      throw new CloudError('TRANSFER_TOO_LARGE', 'Session transfer exceeds 512 MiB', 413, { transferBytes });
    }
    let event;
    const session = transaction(this.database, () => {
      const existing = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      if (existing) {
        if (existing.status === 'purged') {
          // A purged row is a shell with no resources; replaying it as success
          // would hand the client a session id that can never activate.
          throw new CloudError('SESSION_EXISTS', 'Session ID was already used and purged', 409);
        }
        if (existing.origin_device_id === device.id
          && existing.provider === input.provider
          && existing.origin_sha256 === input.originDocument.blobId) return publicSession(existing);
        throw new CloudError('SESSION_EXISTS', 'Session ID is already in use', 409);
      }
      this.database.prepare(`
        INSERT INTO sessions(
          id, origin_device_id, client_thread_id, client_document_id, execution_config_json, provider, goal, status,
          origin_name, origin_sha256, origin_size,
          max_duration_seconds, max_turns, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        device.id,
        input.clientContext?.threadId ?? null,
        input.clientContext?.documentId ?? null,
        input.executionConfig ? JSON.stringify(input.executionConfig) : null,
        input.provider,
        input.goal,
        input.originDocument.name,
        input.originDocument.blobId,
        input.originDocument.size,
        input.limits.maxDurationSeconds,
        input.limits.maxTurns,
        now + STAGED_RETENTION_MS,
        now,
        now,
      );
      for (const resource of resources) {
        this.database.prepare(`
          INSERT INTO session_resources(session_id, sha256, name, kind, size) VALUES (?, ?, ?, ?, ?)
        `).run(id, resource.blobId, resource.name, resource.kind, resource.size);
        this.database.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE sha256 = ?').run(resource.blobId);
      }
      const initialOperationId = `handoff:${id}`;
      this.database.prepare(`
        INSERT INTO session_checkpoints(
          session_id, operation_id, turn_number, revision, blob_sha256, stable,
          timeline_blob_sha256, timeline_size, created_at
        ) VALUES (?, ?, 0, 0, ?, 1, ?, ?, ?)
      `).run(
        id,
        initialOperationId,
        input.originDocument.blobId,
        input.timeline?.blobId ?? null,
        input.timeline?.size ?? null,
        now,
      );
      this.database.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE sha256 = ?')
        .run(input.originDocument.blobId);
      if (input.timeline) {
        this.database.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE sha256 = ?')
          .run(input.timeline.blobId);
      }
      event = this.#appendEventInTransaction(id, 'session.created', { status: 'staged', provider: input.provider });
      return publicSession(this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
    });
    if (event) this.#notify(event);
    return session;
  }

  getSession(sessionId) {
    const row = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!row) throw new CloudError('SESSION_NOT_FOUND', 'Session was not found', 404);
    return publicSession(row);
  }

  getSessionRow(sessionId) {
    const row = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!row) throw new CloudError('SESSION_NOT_FOUND', 'Session was not found', 404);
    return row;
  }

  listSessions({ limit = 100 } = {}) {
    return this.database.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit).map(publicSession);
  }

  listEvents(sessionId, after = 0, limit = 1000) {
    this.getSessionRow(sessionId);
    return this.database.prepare(`
      SELECT * FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?
    `).all(sessionId, after, limit).map(parseEvent);
  }

  subscribe(sessionId, listener) {
    const key = `session:${sessionId}`;
    this.events.on(key, listener);
    return () => this.events.off(key, listener);
  }

  #notify(event) {
    queueMicrotask(() => this.events.emit(`session:${event.sessionId}`, event));
  }

  #appendEventInTransaction(sessionId, type, payload) {
    const session = this.database.prepare('SELECT state_version, next_event_seq FROM sessions WHERE id = ?').get(sessionId);
    const seq = session.next_event_seq;
    this.database.prepare('UPDATE sessions SET next_event_seq = next_event_seq + 1 WHERE id = ?').run(sessionId);
    const createdAt = this.now();
    const stateVersion = session.state_version;
    const eventPayload = { ...payload, stateVersion };
    this.database.prepare(`
      INSERT INTO session_events(session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, seq, type, JSON.stringify(eventPayload), createdAt);
    return { sessionId, seq, type, stateVersion, payload: eventPayload, createdAt };
  }

  appendEvent(sessionId, type, payload) {
    let event;
    transaction(this.database, () => { event = this.#appendEventInTransaction(sessionId, type, payload); });
    this.#notify(event);
    return event;
  }

  executeCommand(device, sessionId, command) {
    let event = null;
    const response = transaction(this.database, () => {
      const existing = this.database.prepare('SELECT * FROM commands WHERE id = ?').get(command.commandId);
      if (existing) {
        if (existing.session_id !== sessionId || existing.device_id !== device.id || existing.type !== command.type) {
          throw new CloudError('COMMAND_ID_CONFLICT', 'Command ID was already used for another command', 409);
        }
        return JSON.parse(existing.response_json);
      }
      const session = this.getSessionRow(sessionId);
      if (command.type !== 'message.queue') {
        if (!Number.isSafeInteger(command.payload.expectedVersion)) {
          throw new CloudError('INVALID_REQUEST', 'payload.expectedVersion is required for session controls');
        }
        if (command.payload.expectedVersion !== session.state_version) {
          throw new CloudError('STATE_VERSION_CONFLICT', 'Session state changed on another device', 409, {
            expectedVersion: command.payload.expectedVersion,
            currentVersion: session.state_version,
            session: publicSession(session),
          });
        }
      }
      const result = this.#applyCommand(device, session, command);
      event = result.event;
      this.database.prepare(`
        INSERT INTO commands(id, session_id, device_id, type, payload_json, response_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(command.commandId, sessionId, device.id, command.type, JSON.stringify(command.payload), JSON.stringify(result.response), this.now());
      return result.response;
    });
    if (event) this.#notify(event);
    return response;
  }

  #applyCommand(device, session, command) {
    const now = this.now();
    const updateStatus = (status, type, payload = {}, expiresAt = null) => {
      this.database.prepare(`
        UPDATE sessions SET status = ?, state_version = state_version + 1, updated_at = ?,
          suspended_reason = CASE WHEN ? = 'suspended' THEN ? ELSE NULL END,
          expires_at = COALESCE(?, expires_at)
        WHERE id = ?
      `).run(
        status,
        now,
        status,
        status === 'suspended' ? JSON.stringify(payload.reason ?? null) : null,
        expiresAt,
        session.id,
      );
      const event = this.#appendEventInTransaction(session.id, type, { status, ...payload });
      return { response: { session: this.getSession(session.id), eventSeq: event.seq }, event };
    };
    if (command.type === 'session.activate') {
      if (session.status !== 'staged') throw new CloudError('INVALID_SESSION_STATE', 'Only staged sessions can be activated', 409);
      const queued = this.database.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE status = 'queued'`).get().count;
      if (queued >= this.maxQueuedSessions) throw new CloudError('QUEUE_FULL', 'Cloud session queue is full', 429);
      return updateStatus('queued', 'session.queued', {}, now + STAGED_RETENTION_MS);
    }
    if (command.type === 'session.cancel') {
      if (!MUTABLE_STATES.has(session.status)) throw new CloudError('INVALID_SESSION_STATE', 'Session cannot be cancelled', 409);
      this.database.prepare(`
        UPDATE sessions SET takeover_requested_at = NULL, takeover_requested_by = NULL WHERE id = ?
      `).run(session.id);
      return updateStatus('cancelled', 'session.cancelled', { requestedByDeviceId: device.id }, now);
    }
    if (command.type === 'session.takeover') {
      if (!MUTABLE_STATES.has(session.status)) throw new CloudError('INVALID_SESSION_STATE', 'Session cannot be taken over', 409);
      if (session.finishing_at) {
        throw new CloudError('SESSION_FINISHING', 'Session has atomically claimed completion', 409);
      }
      if (session.status === 'running') {
        this.database.prepare(`
          UPDATE sessions SET takeover_requested_at = ?, takeover_requested_by = ?, pause_requested_at = NULL,
            state_version = state_version + 1, updated_at = ? WHERE id = ?
        `).run(now, device.id, now, session.id);
        const takeoverEvent = this.#appendEventInTransaction(session.id, 'session.takeover_requested', {
          status: 'running', requestedByDeviceId: device.id, safeBoundaryPending: true,
        });
        return {
          response: {
            session: this.getSession(session.id),
            eventSeq: takeoverEvent.seq,
            takeover: { status: 'pending' },
          },
          event: takeoverEvent,
        };
      }
      return this.#freezeTakeoverInTransaction(session, { requestedByDeviceId: device.id });
    }
    if (command.type === 'session.pause') {
      if (!['queued', 'running'].includes(session.status)) throw new CloudError('INVALID_SESSION_STATE', 'Session cannot be paused', 409);
      if (session.takeover_requested_at) throw new CloudError('TAKEOVER_PENDING', 'Session takeover is pending', 409);
      if (session.finishing_at) {
        throw new CloudError('SESSION_FINISHING', 'Session has atomically claimed completion', 409);
      }
      if (session.status === 'running') {
        this.database.prepare(`
          UPDATE sessions SET pause_requested_at = ?, state_version = state_version + 1, updated_at = ? WHERE id = ?
        `).run(now, now, session.id);
        const pauseEvent = this.#appendEventInTransaction(session.id, 'session.pause_requested', {
          status: 'running',
          requestedByDeviceId: device.id,
        });
        return { response: { session: this.getSession(session.id), eventSeq: pauseEvent.seq }, event: pauseEvent };
      }
      return updateStatus('suspended', 'session.suspended', {
        reason: { code: 'USER_PAUSED', message: 'Paused from a paired device' },
      }, now + SUSPENDED_RETENTION_MS);
    }
    if (command.type === 'session.resume') {
      if (session.status !== 'suspended') throw new CloudError('INVALID_SESSION_STATE', 'Session is not suspended', 409);
      const provider = this.providerStatus(session.provider);
      if (!provider.available) throw new CloudError('PROVIDER_UNAVAILABLE', `${session.provider} is not ready on this VPS`, 409, provider);
      if (!provider.authenticated) throw new CloudError('AUTH_REQUIRED', `${session.provider} must be authenticated on this VPS`, 409, provider);
      // The duration budget covers agent work, not wall time spent suspended;
      // clearing started_at lets the next claim restamp a fresh run.
      this.database.prepare('UPDATE sessions SET pause_requested_at = NULL, started_at = NULL WHERE id = ?').run(session.id);
      return updateStatus('queued', 'session.queued', { resumed: true }, now + STAGED_RETENTION_MS);
    }
    if (command.type === 'message.queue') {
      if (!['queued', 'running'].includes(session.status)) throw new CloudError('INVALID_SESSION_STATE', 'Session is not accepting messages', 409);
      if (session.takeover_requested_at) throw new CloudError('TAKEOVER_PENDING', 'Session takeover has closed the message gate', 409);
      if (session.finishing_at) {
        throw new CloudError('SESSION_FINISHING', 'Session has atomically closed its message gate', 409);
      }
      if (session.turns_used >= session.max_turns) {
        throw new CloudError('TURN_LIMIT', 'Session has reached its turn limit', 409);
      }
      const content = command.payload.content;
      if (typeof content !== 'string' || content.length < 1 || content.length > 64 * 1024) {
        throw new CloudError('INVALID_REQUEST', 'payload.content is invalid');
      }
      const messageId = command.payload.messageId ?? randomUUID();
      this.database.prepare(`
        INSERT INTO session_messages(id, session_id, device_id, content, status, created_at)
        VALUES (?, ?, ?, ?, 'queued', ?)
      `).run(messageId, session.id, device.id, content, now);
      const messageEvent = this.#appendEventInTransaction(session.id, 'message.queued', { messageId, deviceId: device.id });
      return { response: { messageId, status: 'queued', eventSeq: messageEvent.seq }, event: messageEvent };
    }
    throw new CloudError('INVALID_COMMAND', 'Command type is not supported');
  }

  claimNextSession(maxRunningSessions = DEFAULT_LIMITS.maxRunningSessions) {
    let event = null;
    const session = transaction(this.database, () => {
      const running = this.database.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE status = 'running'`).get().count;
      if (running >= maxRunningSessions) return null;
      const row = this.database.prepare(`SELECT * FROM sessions WHERE status = 'queued' ORDER BY created_at LIMIT 1`).get();
      if (!row) return null;
      const now = this.now();
      const updated = this.database.prepare(`
        UPDATE sessions SET status = 'running', state_version = state_version + 1,
          started_at = COALESCE(started_at, ?), worker_heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(now, now, now, row.id);
      if (updated.changes !== 1) return null;
      event = this.#appendEventInTransaction(row.id, 'session.running', { status: 'running' });
      return this.getSession(row.id);
    });
    if (event) this.#notify(event);
    return session;
  }

  attachSandbox(sessionId, sandboxId) {
    const now = this.now();
    const changed = this.database.prepare(`
      UPDATE sessions SET sandbox_id = ?, worker_heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'running'
    `).run(sandboxId, now, now, sessionId);
    if (changed.changes !== 1) throw new CloudError('INVALID_SESSION_STATE', 'Session is no longer running', 409);
  }

  clearSandbox(sessionId, sandboxId) {
    this.database.prepare(`
      UPDATE sessions SET sandbox_id = NULL, worker_token_hash = NULL, worker_heartbeat_at = NULL, updated_at = ?
      WHERE id = ? AND sandbox_id = ?
    `).run(this.now(), sessionId, sandboxId);
  }

  prepareWorker(sessionId, workerToken) {
    const tokenHash = createHash('sha256').update(workerToken).digest();
    const changed = this.database.prepare(`
      UPDATE sessions SET worker_token_hash = ?, updated_at = ? WHERE id = ? AND status = 'running'
    `).run(tokenHash, this.now(), sessionId);
    if (changed.changes !== 1) throw new CloudError('INVALID_SESSION_STATE', 'Session is no longer running', 409);
  }

  authenticateWorker(sessionId, workerToken) {
    const row = this.getSessionRow(sessionId);
    if (row.status !== 'running' || !row.worker_token_hash || typeof workerToken !== 'string') {
      throw new CloudError('WORKER_UNAUTHORIZED', 'Worker token is invalid', 401);
    }
    const actual = createHash('sha256').update(workerToken).digest();
    const expected = Buffer.from(row.worker_token_hash);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new CloudError('WORKER_UNAUTHORIZED', 'Worker token is invalid', 401);
    }
    return row;
  }

  heartbeat(sessionId) {
    const changed = this.database.prepare(`
      UPDATE sessions SET worker_heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'running'
    `).run(this.now(), this.now(), sessionId);
    return changed.changes === 1;
  }

  workerControl(sessionId) {
    const row = this.getSessionRow(sessionId);
    return {
      pauseRequested: Boolean(row.pause_requested_at),
      pauseRequestedAt: row.pause_requested_at,
      takeoverRequested: Boolean(row.takeover_requested_at),
      takeoverRequestedAt: row.takeover_requested_at,
    };
  }

  #boundaryRow(sessionId, operationId = null) {
    const clause = operationId ? 'AND c.operation_id = ?' : '';
    return this.database.prepare(`
      SELECT c.operation_id AS operationId, c.turn_number AS turnNumber, c.revision,
        c.blob_sha256 AS checkpointBlobId, checkpoint.size AS checkpointSize,
        c.timeline_blob_sha256 AS timelineBlobId, c.timeline_size AS timelineSize,
        c.created_at AS committedAt, s.origin_name AS originName
      FROM session_checkpoints c
      JOIN sessions s ON s.id = c.session_id
      JOIN blobs checkpoint ON checkpoint.sha256 = c.blob_sha256
      WHERE c.session_id = ? AND c.stable = 1 ${clause}
      ORDER BY (c.timeline_blob_sha256 IS NOT NULL) DESC, c.created_at DESC, c.revision DESC LIMIT 1
    `).get(...(operationId ? [sessionId, operationId] : [sessionId]));
  }

  #publicBoundary(sessionId, row) {
    if (!row) throw new CloudError('BOUNDARY_NOT_FOUND', 'A stable document boundary was not found', 404);
    const extension = path.extname(row.originName).slice(0, 16) || '.bin';
    const stem = path.basename(row.originName, path.extname(row.originName)).slice(0, 160) || 'document';
    return {
      operationId: row.operationId,
      turnNumber: row.turnNumber,
      revision: row.revision,
      committedAt: row.committedAt,
      checkpoint: {
        blobId: row.checkpointBlobId,
        size: row.checkpointSize,
        name: `${stem}.checkpoint-r${row.revision}${extension}`,
        downloadPath: `/v1/sessions/${encodeURIComponent(sessionId)}/checkpoint`,
      },
      timeline: row.timelineBlobId ? {
        blobId: row.timelineBlobId,
        size: row.timelineSize,
        downloadPath: `/v1/sessions/${encodeURIComponent(sessionId)}/timeline`,
      } : null,
    };
  }

  latestStableBoundary(sessionId) {
    const session = this.getSessionRow(sessionId);
    return this.#publicBoundary(sessionId, this.#boundaryRow(sessionId, session.frozen_checkpoint_operation_id));
  }

  takeoverState(sessionId) {
    const session = this.getSessionRow(sessionId);
    if (session.frozen_checkpoint_operation_id) {
      return { status: 'ready', boundary: this.latestStableBoundary(sessionId) };
    }
    if (session.takeover_requested_at) {
      return { status: 'pending', requestedAt: session.takeover_requested_at };
    }
    throw new CloudError('TAKEOVER_NOT_REQUESTED', 'Session does not have a takeover receipt', 404);
  }

  #freezeTakeoverInTransaction(session, { requestedByDeviceId, recovered = false, forced = false } = {}) {
    const boundary = this.#publicBoundary(session.id, this.#boundaryRow(session.id));
    const now = this.now();
    this.database.prepare(`
      UPDATE sessions SET status = 'cancelled', state_version = state_version + 1,
        takeover_requested_at = NULL, takeover_requested_by = NULL, pause_requested_at = NULL,
        frozen_checkpoint_operation_id = ?, finishing_at = NULL, sandbox_id = NULL,
        worker_token_hash = NULL, worker_heartbeat_at = NULL, expires_at = ?, updated_at = ?
      WHERE id = ?
    `).run(boundary.operationId, now + TAKEOVER_RETENTION_MS, now, session.id);
    const event = this.#appendEventInTransaction(session.id, 'session.takeover_ready', {
      status: 'cancelled',
      requestedByDeviceId: requestedByDeviceId ?? session.takeover_requested_by,
      safeBoundary: !forced,
      recovered,
      boundary,
    });
    return {
      response: {
        session: this.getSession(session.id),
        eventSeq: event.seq,
        takeover: { status: 'ready', boundary },
        latestCheckpoint: boundary.checkpoint,
      },
      event,
    };
  }

  claimFinish(sessionId) {
    const events = [];
    const result = transaction(this.database, () => {
      const row = this.getSessionRow(sessionId);
      if (row.status !== 'running') throw new CloudError('INVALID_SESSION_STATE', 'Session is not running', 409);
      if (row.pause_requested_at) {
        return { ready: false, messages: [], pauseRequested: true };
      }
      if (row.takeover_requested_at) {
        return { ready: false, messages: [], takeoverRequested: true };
      }
      if (row.finishing_at) return { ready: true, messages: [] };
      const queued = this.database.prepare(`
        SELECT id, device_id, content, created_at FROM session_messages
        WHERE session_id = ? AND status = 'queued' ORDER BY created_at, id
      `).all(sessionId);
      if (queued.length) {
        const now = this.now();
        for (const message of queued) {
          this.database.prepare(`
            UPDATE session_messages SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'queued'
          `).run(now, message.id);
          events.push(this.#appendEventInTransaction(sessionId, 'message.accepted', {
            messageId: message.id,
            deviceId: message.device_id,
            status: 'delivered',
          }));
        }
        return {
          ready: false,
          messages: queued.map((message) => ({
            id: message.id,
            deviceId: message.device_id,
            content: message.content,
            createdAt: message.created_at,
          })),
        };
      }
      const now = this.now();
      this.database.prepare('UPDATE sessions SET finishing_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, sessionId);
      events.push(this.#appendEventInTransaction(sessionId, 'session.finishing', { status: 'running' }));
      return { ready: true, messages: [] };
    });
    for (const event of events) this.#notify(event);
    return result;
  }

  acknowledgePause(sessionId) {
    let event = null;
    const session = transaction(this.database, () => {
      const row = this.getSessionRow(sessionId);
      if (row.status === 'suspended' && !row.pause_requested_at) return this.getSession(sessionId);
      if (row.status !== 'running' || !row.pause_requested_at) {
        throw new CloudError('PAUSE_NOT_REQUESTED', 'Session does not have a pending pause request', 409);
      }
      if (row.takeover_requested_at) throw new CloudError('TAKEOVER_PENDING', 'Takeover superseded the pause request', 409);
      const now = this.now();
      const reason = { code: 'USER_PAUSED', message: 'Paused at a stable worker boundary' };
      this.database.prepare(`
        UPDATE sessions SET status = 'suspended', pause_requested_at = NULL, state_version = state_version + 1,
          suspended_reason = ?, expires_at = ?, finishing_at = NULL, sandbox_id = NULL, worker_token_hash = NULL,
          worker_heartbeat_at = NULL, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(reason), now + SUSPENDED_RETENTION_MS, now, sessionId);
      event = this.#appendEventInTransaction(sessionId, 'session.suspended', {
        status: 'suspended', reason, safeBoundary: true,
      });
      return this.getSession(sessionId);
    });
    if (event) this.#notify(event);
    return session;
  }

  acknowledgeTakeover(sessionId, { forced = false, recovered = false } = {}) {
    let result;
    transaction(this.database, () => {
      const row = this.getSessionRow(sessionId);
      if (row.status === 'cancelled' && row.frozen_checkpoint_operation_id) {
        const boundary = this.latestStableBoundary(sessionId);
        result = {
          response: {
            session: this.getSession(sessionId),
            takeover: { status: 'ready', boundary },
            latestCheckpoint: boundary.checkpoint,
          },
          event: null,
        };
        return;
      }
      if (row.status !== 'running' || !row.takeover_requested_at) {
        throw new CloudError('TAKEOVER_NOT_REQUESTED', 'Session does not have a pending takeover request', 409);
      }
      result = this.#freezeTakeoverInTransaction(row, { forced, recovered });
    });
    if (result.event) this.#notify(result.event);
    return result.response;
  }

  takeQueuedMessages(sessionId) {
    const now = this.now();
    const events = [];
    const messages = transaction(this.database, () => {
      const messages = this.database.prepare(`
        SELECT id, device_id, content, created_at FROM session_messages
        WHERE session_id = ? AND status = 'queued' ORDER BY created_at, id
      `).all(sessionId);
      for (const message of messages) {
        this.database.prepare(`
          UPDATE session_messages SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'queued'
        `).run(now, message.id);
        events.push(this.#appendEventInTransaction(sessionId, 'message.accepted', {
          messageId: message.id,
          deviceId: message.device_id,
          status: 'delivered',
        }));
      }
      return messages.map((message) => ({
        id: message.id,
        deviceId: message.device_id,
        content: message.content,
        createdAt: message.created_at,
      }));
    });
    for (const event of events) this.#notify(event);
    return messages;
  }

  workerManifest(sessionId) {
    const session = this.getSessionRow(sessionId);
    const resources = this.database.prepare(`
      SELECT sha256 AS blobId, name, kind, size FROM session_resources WHERE session_id = ? ORDER BY kind, name
    `).all(sessionId);
    const checkpoint = this.database.prepare(`
      SELECT operation_id AS operationId, turn_number AS turnNumber, revision, blob_sha256 AS blobId, stable, created_at AS createdAt
      FROM session_checkpoints
      WHERE session_id = ? AND stable = 1 AND turn_number > 0
      ORDER BY created_at DESC, revision DESC LIMIT 1
    `).get(sessionId) ?? null;
    return {
      sessionId,
      provider: session.provider,
      goal: session.goal,
      clientContext: session.client_thread_id
        ? { threadId: session.client_thread_id, documentId: session.client_document_id }
        : null,
      executionConfig: session.execution_config_json ? JSON.parse(session.execution_config_json) : null,
      resources,
      latestCheckpoint: checkpoint ? { ...checkpoint, stable: Boolean(checkpoint.stable) } : null,
      limits: { maxDurationSeconds: session.max_duration_seconds, maxTurns: session.max_turns, turnsUsed: session.turns_used },
    };
  }

  currentTimeline(sessionId) {
    const session = this.getSessionRow(sessionId);
    if (session.frozen_checkpoint_operation_id) {
      const boundary = this.#boundaryRow(sessionId, session.frozen_checkpoint_operation_id);
      if (!boundary?.timelineBlobId) throw new CloudError('TIMELINE_NOT_FOUND', 'Frozen boundary has no portable timeline', 404);
      return {
        blobId: boundary.timelineBlobId,
        name: 'timeline.json',
        kind: 'timeline',
        size: boundary.timelineSize,
        operationId: boundary.operationId,
        revision: boundary.revision,
        turnNumber: boundary.turnNumber,
      };
    }
    const timeline = this.database.prepare(`
      SELECT sha256 AS blobId, name, kind, size FROM session_resources WHERE session_id = ? AND kind = 'timeline'
    `).get(sessionId);
    if (!timeline) throw new CloudError('TIMELINE_NOT_FOUND', 'Session timeline was not found', 404);
    return timeline;
  }

  latestStableCheckpoint(sessionId) {
    const session = this.getSessionRow(sessionId);
    const frozenClause = session.frozen_checkpoint_operation_id ? 'AND c.operation_id = ?' : '';
    const parameters = session.frozen_checkpoint_operation_id
      ? [sessionId, session.frozen_checkpoint_operation_id]
      : [sessionId];
    const checkpoint = this.database.prepare(`
      SELECT c.operation_id AS operationId, c.turn_number AS turnNumber, c.revision,
        c.blob_sha256 AS blobId, b.size, c.created_at AS createdAt, s.origin_name AS originName
      FROM session_checkpoints c
      JOIN blobs b ON b.sha256 = c.blob_sha256
      JOIN sessions s ON s.id = c.session_id
      WHERE c.session_id = ? AND c.stable = 1
      ${frozenClause}
      ORDER BY c.created_at DESC, c.revision DESC LIMIT 1
    `).get(...parameters);
    if (!checkpoint) throw new CloudError('CHECKPOINT_NOT_FOUND', 'A stable checkpoint was not found', 404);
    const extension = path.extname(checkpoint.originName).slice(0, 16) || '.bin';
    const stem = path.basename(checkpoint.originName, path.extname(checkpoint.originName)).slice(0, 160) || 'document';
    const { originName: _originName, ...publicCheckpoint } = checkpoint;
    return { ...publicCheckpoint, name: `${stem}.checkpoint-r${checkpoint.revision}${extension}` };
  }

  async commitBoundary(sessionId, {
    operationId,
    turnNumber,
    revision,
    checkpoint,
    timeline,
  }) {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(operationId)) {
      throw new CloudError('INVALID_REQUEST', 'Boundary operationId is invalid');
    }
    if (!Number.isSafeInteger(turnNumber) || turnNumber < 0 || turnNumber > 1_000_000
      || !Number.isSafeInteger(revision) || revision < 0 || revision > 1_000_000_000) {
      throw new CloudError('INVALID_REQUEST', 'Boundary turnNumber and revision must be non-negative integers');
    }
    this.#requireBlob(checkpoint, 'Boundary checkpoint');
    this.#requireBlob(timeline, 'Boundary timeline');
    const events = [];
    let previousTimelineBlobId = null;
    let boundary;
    transaction(this.database, () => {
      const session = this.getSessionRow(sessionId);
      if (session.status !== 'running') throw new CloudError('INVALID_SESSION_STATE', 'Session is not running', 409);
      const existing = this.database.prepare(`
        SELECT * FROM session_checkpoints WHERE session_id = ? AND operation_id = ?
      `).get(sessionId, operationId);
      if (existing) {
        if (existing.turn_number !== turnNumber || existing.revision !== revision
          || existing.blob_sha256 !== checkpoint.blobId
          || existing.timeline_blob_sha256 !== timeline.blobId
          || existing.timeline_size !== timeline.size) {
          throw new CloudError('BOUNDARY_OPERATION_CONFLICT', 'Boundary operationId was reused with different artifacts', 409);
        }
        boundary = this.#publicBoundary(sessionId, this.#boundaryRow(sessionId, operationId));
        return;
      }
      const previousTimeline = this.database.prepare(`
        SELECT sha256 AS blobId, size FROM session_resources WHERE session_id = ? AND kind = 'timeline'
      `).get(sessionId);
      if (previousTimeline?.blobId !== timeline.blobId) {
        previousTimelineBlobId = previousTimeline?.blobId ?? null;
        if (previousTimeline) {
          this.database.prepare(`
            UPDATE session_resources SET sha256 = ?, size = ? WHERE session_id = ? AND kind = 'timeline'
          `).run(timeline.blobId, timeline.size, sessionId);
          this.database.prepare('UPDATE blobs SET ref_count = MAX(ref_count - 1, 0) WHERE sha256 = ?')
            .run(previousTimeline.blobId);
        } else {
          this.database.prepare(`
            INSERT INTO session_resources(session_id, sha256, name, kind, size)
            VALUES (?, ?, 'timeline.json', 'timeline', ?)
          `).run(sessionId, timeline.blobId, timeline.size);
        }
        this.database.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE sha256 = ?').run(timeline.blobId);
        events.push(this.#appendEventInTransaction(sessionId, 'timeline.updated', {
          blobId: timeline.blobId, size: timeline.size, turnNumber, revision,
        }));
      }
      this.database.prepare(`
        INSERT INTO session_checkpoints(
          session_id, operation_id, turn_number, revision, blob_sha256, stable,
          timeline_blob_sha256, timeline_size, created_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        sessionId, operationId, turnNumber, revision, checkpoint.blobId,
        timeline.blobId, timeline.size, this.now(),
      );
      this.database.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE sha256 = ?').run(checkpoint.blobId);
      this.database.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE sha256 = ?').run(timeline.blobId);
      events.push(this.#appendEventInTransaction(sessionId, 'checkpoint.created', {
        operationId, turnNumber, revision, blobId: checkpoint.blobId, stable: true,
      }));
      events.push(this.#appendEventInTransaction(sessionId, 'boundary.committed', {
        operationId, turnNumber, revision,
        checkpoint: { blobId: checkpoint.blobId, size: checkpoint.size },
        timeline: { blobId: timeline.blobId, size: timeline.size },
      }));
      boundary = this.#publicBoundary(sessionId, this.#boundaryRow(sessionId, operationId));
    });
    for (const event of events) this.#notify(event);
    if (previousTimelineBlobId) await this.blobStore.removeUnreferenced(previousTimelineBlobId);
    return boundary;
  }

  async publishTimeline(sessionId, { blobId, size }) {
    this.#requireBlob({ blobId, size }, 'Timeline');
    let event = null;
    let previousBlobId = null;
    const timeline = transaction(this.database, () => {
      const session = this.getSessionRow(sessionId);
      if (session.status !== 'running') throw new CloudError('INVALID_SESSION_STATE', 'Session is not running', 409);
      const previous = this.currentTimeline(sessionId);
      if (previous.blobId === blobId) return previous;
      previousBlobId = previous.blobId;
      this.database.prepare(`
        UPDATE session_resources SET sha256 = ?, size = ? WHERE session_id = ? AND kind = 'timeline'
      `).run(blobId, size, sessionId);
      this.database.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE sha256 = ?').run(blobId);
      this.database.prepare('UPDATE blobs SET ref_count = MAX(ref_count - 1, 0) WHERE sha256 = ?').run(previous.blobId);
      event = this.#appendEventInTransaction(sessionId, 'timeline.updated', { blobId, size });
      return this.currentTimeline(sessionId);
    });
    if (event) {
      this.#notify(event);
      await this.blobStore.removeUnreferenced(previousBlobId);
    }
    return timeline;
  }

  recordCheckpoint(sessionId, { operationId, turnNumber, revision, blobId, stable }) {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(operationId)
      || !Number.isSafeInteger(turnNumber) || turnNumber < 0 || turnNumber > 1_000_000
      || !Number.isSafeInteger(revision) || revision < 0 || revision > 1_000_000_000) {
      throw new CloudError('INVALID_REQUEST', 'Checkpoint operation, turn, or revision is invalid');
    }
    this.#requireBlob({ blobId, size: this.blobStore.get(blobId)?.size }, 'Checkpoint');
    let event = null;
    const checkpoint = transaction(this.database, () => {
      const session = this.getSessionRow(sessionId);
      if (session.status !== 'running') throw new CloudError('INVALID_SESSION_STATE', 'Session is not running', 409);
      const existing = this.database.prepare(`
        SELECT * FROM session_checkpoints WHERE session_id = ? AND operation_id = ?
      `).get(sessionId, operationId);
      if (existing) return existing;
      this.database.prepare(`
        INSERT INTO session_checkpoints(session_id, operation_id, turn_number, revision, blob_sha256, stable, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, operationId, turnNumber, revision, blobId, stable ? 1 : 0, this.now());
      this.database.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE sha256 = ?').run(blobId);
      event = this.#appendEventInTransaction(sessionId, 'checkpoint.created', { operationId, turnNumber, revision, blobId, stable: Boolean(stable) });
      return this.database.prepare(`SELECT * FROM session_checkpoints WHERE session_id = ? AND operation_id = ?`).get(sessionId, operationId);
    });
    if (event) this.#notify(event);
    return checkpoint;
  }

  completeTurn(sessionId) {
    let event;
    const result = transaction(this.database, () => {
      const row = this.getSessionRow(sessionId);
      if (row.status !== 'running') throw new CloudError('INVALID_SESSION_STATE', 'Session is not running', 409);
      const turnsUsed = row.turns_used + 1;
      const controlPending = Boolean(row.pause_requested_at || row.takeover_requested_at);
      const exhausted = turnsUsed >= row.max_turns && !controlPending;
      const status = exhausted ? 'suspended' : 'running';
      const reason = exhausted ? { code: 'TURN_LIMIT', message: 'Turn limit reached' } : null;
      this.database.prepare(`
        UPDATE sessions SET turns_used = ?, status = ?, suspended_reason = ?, state_version = state_version + 1,
          expires_at = CASE WHEN ? = 'suspended' THEN ? ELSE expires_at END, updated_at = ? WHERE id = ?
      `).run(
        turnsUsed,
        status,
        reason ? JSON.stringify(reason) : null,
        status,
        this.now() + SUSPENDED_RETENTION_MS,
        this.now(),
        sessionId,
      );
      this.database.prepare(`
        UPDATE session_messages SET status = 'consumed'
        WHERE session_id = ? AND status = 'delivered'
      `).run(sessionId);
      event = this.#appendEventInTransaction(sessionId, exhausted ? 'session.suspended' : 'turn.completed', { turnsUsed, reason });
      return this.getSession(sessionId);
    });
    this.#notify(event);
    return result;
  }

  publishResult(sessionId, { blobId, size }) {
    if (!Number.isSafeInteger(size) || size < 1 || size > TRANSFER_LIMITS.maxDocumentBytes) {
      throw new CloudError('RESULT_TOO_LARGE', 'Result must be between 1 byte and 64 MiB', 413);
    }
    this.#requireBlob({ blobId, size }, 'Result');
    let event;
    const result = transaction(this.database, () => {
      const row = this.getSessionRow(sessionId);
      if (row.status !== 'running') throw new CloudError('INVALID_SESSION_STATE', 'Session cannot publish a result', 409);
      if (!row.finishing_at) throw new CloudError('FINISH_NOT_CLAIMED', 'Worker must atomically claim completion before publishing', 409);
      const queued = this.database.prepare(`
        SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND status = 'queued'
      `).get(sessionId).count;
      if (queued) throw new CloudError('PENDING_MESSAGES', 'Session has pending messages', 409, { count: queued });
      const now = this.now();
      this.database.prepare(`
        UPDATE sessions SET status = 'completed', state_version = state_version + 1, result_sha256 = ?, result_size = ?,
          completed_at = ?, expires_at = ?, finishing_at = NULL, sandbox_id = NULL, worker_token_hash = NULL,
          worker_heartbeat_at = NULL, takeover_requested_at = NULL, takeover_requested_by = NULL,
          updated_at = ? WHERE id = ?
      `).run(blobId, size, now, now + COMPLETED_RETENTION_MS, now, sessionId);
      this.database.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE sha256 = ?').run(blobId);
      event = this.#appendEventInTransaction(sessionId, 'session.completed', { status: 'completed', result: { sha256: blobId, size } });
      return this.getSession(sessionId);
    });
    this.#notify(event);
    return result;
  }

  suspend(sessionId, reason) {
    let event = null;
    const result = transaction(this.database, () => {
      const row = this.getSessionRow(sessionId);
      if (!['queued', 'running'].includes(row.status)) return this.getSession(sessionId);
      this.database.prepare(`
        UPDATE sessions SET status = 'suspended', state_version = state_version + 1, suspended_reason = ?,
          pause_requested_at = NULL, takeover_requested_at = NULL, takeover_requested_by = NULL,
          finishing_at = NULL, sandbox_id = NULL, worker_token_hash = NULL, worker_heartbeat_at = NULL,
          expires_at = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(reason), this.now() + SUSPENDED_RETENTION_MS, this.now(), sessionId);
      this.database.prepare(`
        UPDATE session_messages SET status = 'queued', delivered_at = NULL
        WHERE session_id = ? AND status = 'delivered'
      `).run(sessionId);
      event = this.#appendEventInTransaction(sessionId, 'session.suspended', { status: 'suspended', reason });
      return this.getSession(sessionId);
    });
    if (event) this.#notify(event);
    return result;
  }

  recoverInterruptedSessions(liveSandboxIds = new Set()) {
    const recovered = [];
    const notifications = [];
    transaction(this.database, () => {
      const rows = this.database.prepare(`SELECT * FROM sessions WHERE status = 'running'`).all();
      for (const row of rows) {
        if (row.sandbox_id && liveSandboxIds.has(row.sandbox_id)) {
          this.database.prepare('UPDATE sessions SET worker_heartbeat_at = ?, updated_at = ? WHERE id = ?')
            .run(this.now(), this.now(), row.id);
          recovered.push({ sessionId: row.id, action: 'adopted', sandboxId: row.sandbox_id });
          continue;
        }
        if (row.takeover_requested_at) {
          const result = this.#freezeTakeoverInTransaction(row, { recovered: true });
          notifications.push(result.event);
          recovered.push({ sessionId: row.id, action: 'takeover_frozen', sandboxId: null });
          continue;
        }
        const paused = Boolean(row.pause_requested_at);
        const status = paused ? 'suspended' : 'queued';
        const now = this.now();
        this.database.prepare(`
          UPDATE sessions SET status = ?, state_version = state_version + 1, pause_requested_at = NULL, finishing_at = NULL, sandbox_id = NULL,
            worker_token_hash = NULL, worker_heartbeat_at = NULL, started_at = NULL, expires_at = ?, updated_at = ? WHERE id = ?
        `).run(status, now + (paused ? SUSPENDED_RETENTION_MS : STAGED_RETENTION_MS), now, row.id);
        this.database.prepare(`
          UPDATE session_messages SET status = 'queued', delivered_at = NULL
          WHERE session_id = ? AND status = 'delivered'
        `).run(row.id);
        const event = this.#appendEventInTransaction(row.id, paused ? 'session.suspended' : 'session.recovered', {
          status,
          action: paused ? 'pause_recovered' : 'requeued',
          ...(paused ? { reason: { code: 'USER_PAUSED', message: 'Pause recovered after worker exit' } } : {}),
        });
        notifications.push(event);
        recovered.push({ sessionId: row.id, action: paused ? 'pause_recovered' : 'requeued', sandboxId: null });
      }
    });
    for (const event of notifications) this.#notify(event);
    return recovered;
  }

  requeueInterruptedSession(sessionId, reason = 'worker_lost') {
    let event = null;
    const session = transaction(this.database, () => {
      const row = this.getSessionRow(sessionId);
      if (row.status !== 'running') return this.getSession(sessionId);
      if (row.takeover_requested_at) {
        const result = this.#freezeTakeoverInTransaction(row, { recovered: true });
        event = result.event;
        return result.response.session;
      }
      const paused = Boolean(row.pause_requested_at);
      const status = paused ? 'suspended' : 'queued';
      this.database.prepare(`
        UPDATE sessions SET status = ?, state_version = state_version + 1, pause_requested_at = NULL, finishing_at = NULL, sandbox_id = NULL,
          worker_token_hash = NULL, worker_heartbeat_at = NULL, started_at = NULL, expires_at = ?, updated_at = ? WHERE id = ?
      `).run(status, this.now() + (paused ? SUSPENDED_RETENTION_MS : STAGED_RETENTION_MS), this.now(), sessionId);
      this.database.prepare(`
        UPDATE session_messages SET status = 'queued', delivered_at = NULL
        WHERE session_id = ? AND status = 'delivered'
      `).run(sessionId);
      event = this.#appendEventInTransaction(sessionId, paused ? 'session.suspended' : 'session.recovered', {
        status,
        action: paused ? 'pause_recovered' : 'requeued',
        reason: paused ? { code: 'USER_PAUSED', message: 'Pause recovered after worker exit' } : reason,
      });
      return this.getSession(sessionId);
    });
    if (event) this.#notify(event);
    return session;
  }

  async expireRetainedSessions() {
    const rows = this.database.prepare(`
      SELECT id FROM sessions
      WHERE status IN ('staged', 'suspended', 'completed', 'cancelled', 'failed') AND expires_at <= ?
    `).all(this.now());
    for (const row of rows) await this.purgeExpiredSession(row.id);
    const legacyPurgedUploads = this.database.prepare(`
      SELECT DISTINCT u.session_id AS id FROM uploads u
      JOIN sessions s ON s.id = u.session_id
      WHERE s.status = 'purged'
    `).all();
    for (const row of legacyPurgedUploads) await this.purgeExpiredSession(row.id);
    return rows.length;
  }

  async purgeExpiredSession(sessionId) {
    const row = this.getSessionRow(sessionId);
    if (row.status === 'purged') {
      const purge = this.#purgeSession(sessionId, null, 'legacy_upload_cleanup');
      await this.#removePurgedArtifacts(purge);
      return purge.uploads.length > 0;
    }
    if (['queued', 'running'].includes(row.status) || row.expires_at > this.now()) return false;
    const purge = this.#purgeSession(sessionId, null, 'retention_expired');
    await this.#removePurgedArtifacts(purge);
    return true;
  }

  async confirmResultDownloaded(device, sessionId, { sha256, size }) {
    const row = this.getSessionRow(sessionId);
    if (row.origin_device_id !== device.id) throw new CloudError('ORIGIN_DEVICE_REQUIRED', 'Only the origin device can confirm result download', 403);
    if (row.status === 'purged' && row.result_sha256 === sha256 && row.result_size === size) {
      const purge = this.#purgeSession(sessionId, null, 'legacy_upload_cleanup');
      await this.#removePurgedArtifacts(purge);
      const download = this.database.prepare(`
        SELECT confirmed_at FROM result_downloads WHERE session_id = ? AND device_id = ?
      `).get(sessionId, device.id);
      return {
        sessionId,
        status: 'purged',
        sha256,
        size,
        confirmedAt: download?.confirmed_at ?? row.updated_at,
        reason: 'origin_download_confirmed',
      };
    }
    if (row.status !== 'completed' || row.result_sha256 !== sha256 || row.result_size !== size) {
      throw new CloudError('RESULT_CONFIRMATION_MISMATCH', 'Downloaded result does not match the completed result', 409);
    }
    const purge = this.#purgeSession(sessionId, device, 'origin_download_confirmed');
    await this.#removePurgedArtifacts(purge);
    return purge.receipt;
  }

  async #removePurgedArtifacts(purge) {
    await this.blobStore.removeUploadTempFiles(purge.uploads);
    for (const digest of purge.unreferenced) await this.blobStore.removeUnreferenced(digest);
  }

  #purgeSession(sessionId, device, reason) {
    const unreferenced = [];
    const uploads = [];
    let newlyPurged = false;
    const receipt = transaction(this.database, () => {
      const row = this.getSessionRow(sessionId);
      uploads.push(...this.database.prepare(`
        SELECT id, sha256, temp_path AS tempPath FROM uploads WHERE session_id = ?
      `).all(sessionId));
      for (const upload of uploads) unreferenced.push(upload.sha256);
      this.database.prepare('DELETE FROM uploads WHERE session_id = ?').run(sessionId);
      if (row.status === 'purged') {
        return { sessionId, status: 'purged', sha256: row.result_sha256, size: row.result_size, confirmedAt: row.updated_at, reason };
      }
      const now = this.now();
      if (device) {
        this.database.prepare(`
          INSERT INTO result_downloads(session_id, device_id, sha256, size, confirmed_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id, device_id) DO NOTHING
        `).run(sessionId, device.id, row.result_sha256, row.result_size, now);
      }
      const references = this.database.prepare('SELECT sha256 FROM session_resources WHERE session_id = ?').all(sessionId);
      const checkpoints = this.database.prepare(`
        SELECT blob_sha256 AS sha256, timeline_blob_sha256 AS timelineSha256
        FROM session_checkpoints WHERE session_id = ?
      `).all(sessionId);
      const checkpointReferences = checkpoints.flatMap((checkpoint) => [
        { sha256: checkpoint.sha256 },
        ...(checkpoint.timelineSha256 ? [{ sha256: checkpoint.timelineSha256 }] : []),
      ]);
      for (const reference of [...references, ...checkpointReferences, ...(row.result_sha256 ? [{ sha256: row.result_sha256 }] : [])]) {
        this.database.prepare('UPDATE blobs SET ref_count = MAX(ref_count - 1, 0) WHERE sha256 = ?').run(reference.sha256);
        unreferenced.push(reference.sha256);
      }
      this.database.prepare('DELETE FROM session_resources WHERE session_id = ?').run(sessionId);
      this.database.prepare('DELETE FROM session_checkpoints WHERE session_id = ?').run(sessionId);
      this.database.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId);
      this.database.prepare('DELETE FROM commands WHERE session_id = ?').run(sessionId);
      this.database.prepare('DELETE FROM session_events WHERE session_id = ?').run(sessionId);
      this.database.prepare(`
        UPDATE sessions SET status = 'purged', state_version = state_version + 1, goal = '[purged]', origin_name = '[purged]',
          client_thread_id = NULL, client_document_id = NULL, execution_config_json = NULL, finishing_at = NULL,
          pause_requested_at = NULL, takeover_requested_at = NULL, takeover_requested_by = NULL,
          frozen_checkpoint_operation_id = NULL,
          sandbox_id = NULL, worker_token_hash = NULL, worker_heartbeat_at = NULL, suspended_reason = NULL, updated_at = ? WHERE id = ?
      `).run(now, sessionId);
      this.#appendEventInTransaction(sessionId, 'session.purged', { status: 'purged', reason });
      newlyPurged = true;
      return { sessionId, status: 'purged', sha256: row.result_sha256, size: row.result_size, confirmedAt: now, reason };
    });
    const event = newlyPurged ? this.listEvents(sessionId, 0, 1)[0] : null;
    if (event) this.#notify(event);
    return { receipt, unreferenced: [...new Set(unreferenced)], uploads };
  }
}

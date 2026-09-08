import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { transaction } from './database.mjs';
import { CloudError } from './protocol.mjs';

const TABLES = ['session_resources', 'session_messages', 'session_turns', 'session_waits',
  'session_attachment_versions', 'session_message_attachments', 'commands', 'session_events', 'session_checkpoints'];
const MAX_BYTES = 128 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => new CloudError('CONVERSATION_SNAPSHOT_INVALID', message, 422);

// Only conversation tables travel. Pairing tokens, provider credentials, server
// identity, worker tokens, absolute paths and runtime leases stay on the worker.
export class ConversationBackup {
  constructor({ sessionStore, blobStore, lease }) {
    this.sessionStore = sessionStore;
    this.database = sessionStore.database;
    this.blobStore = blobStore;
    this.lease = lease;
    this.enabled = lease?.enabled === true;
    this.tail = Promise.resolve();
    this.saving = new Map();
    this.flushing = null;
    this.database.exec('CREATE TABLE IF NOT EXISTS conversation_backup_pending (session_id TEXT PRIMARY KEY)');
    this.database.exec(`CREATE TABLE IF NOT EXISTS conversation_backup_state (
      session_id TEXT PRIMARY KEY, identity_json TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, sha256 TEXT)`);
    this.database.exec(`CREATE TABLE IF NOT EXISTS conversation_resource_receipts (
      session_id TEXT NOT NULL, sha256 TEXT NOT NULL, receipt_json TEXT NOT NULL, PRIMARY KEY(session_id, sha256))`);
    this.database.exec(`CREATE TABLE IF NOT EXISTS conversation_restore_receipts (
      session_id TEXT PRIMARY KEY, source_event_seq INTEGER NOT NULL, restored_event_seq INTEGER NOT NULL)`);
    if (this.enabled) sessionStore.onStateChanged = (sessionId) => this.markDirty(sessionId);
  }

  markDirty(sessionId) {
    if (!this.enabled) return;
    this.database.prepare('INSERT OR IGNORE INTO conversation_backup_pending VALUES (?)').run(sessionId);
  }

  validateCreate(input) {
    if (!this.enabled) return;
    const resources = [input.originDocument, ...(input.resources ?? []), ...(input.timeline ? [input.timeline] : [])];
    if (resources.some((resource) => resource.size > MAX_BYTES)) {
      throw new CloudError('CONVERSATION_STORAGE_LIMIT', 'Each Cloud document or reference must be at most 128 MiB', 413);
    }
  }

  save(sessionId) {
    if (!this.enabled) return Promise.resolve();
    this.markDirty(sessionId);
    const target = this.sessionStore.getSessionRow(sessionId);
    const existing = this.saving.get(sessionId);
    if (existing) return existing.then((saved) => {
      // The shared upload may have captured an earlier command. A receipt for
      // this request must cover its own durable state, not merely any snapshot.
      if (saved.eventSeq >= target.next_event_seq && saved.stateVersion >= target.state_version) return saved;
      return this.save(sessionId);
    });
    const operation = this.tail.catch(() => {}).then(() => this.#save(sessionId));
    this.tail = operation;
    this.saving.set(sessionId, operation);
    return operation.finally(() => {
      if (this.saving.get(sessionId) === operation) this.saving.delete(sessionId);
    });
  }

  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      for (const row of this.database.prepare('SELECT session_id FROM conversation_backup_pending').all()) {
        await this.save(row.session_id);
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async #save(sessionId) {
    await this.lease.prepareArchive?.();
    const session = { ...this.sessionStore.getSessionRow(sessionId) };
    session.worker_token_hash = null;
    session.sandbox_id = null;
    session.worker_heartbeat_at = null;
    const rows = Object.fromEntries(TABLES.map((table) => [table, this.database.prepare(table === 'session_message_attachments'
      ? `SELECT a.* FROM session_message_attachments a JOIN session_messages m ON a.message_id = m.id WHERE m.session_id = ?`
      : `SELECT * FROM ${table} WHERE session_id = ?`).all(sessionId)]));
    let state = this.database.prepare('SELECT * FROM conversation_backup_state WHERE session_id = ?').get(sessionId);
    let identity = state ? JSON.parse(state.identity_json) : null;
    if (!identity) {
      const timelineResource = rows.session_resources.find((row) => row.kind === 'timeline');
      let timeline;
      if (timelineResource) {
        const { blob, stream } = this.blobStore.openReadStream(timelineResource.sha256);
        if (blob.size > MAX_BYTES) { stream.destroy(); throw fail('Timeline exceeds the conversation limit'); }
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        try { timeline = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      }
      identity = { sessionId, documentId: session.client_document_id, threadId: session.client_thread_id,
        cloudStartId: timeline?.thread?.cloudStartId };
      if (!identity.documentId || !identity.threadId || !identity.cloudStartId) {
        throw new CloudError('CLOUD_START_IDENTITY_REQUIRED', 'Cloud document and start identity are required to retain the conversation', 409);
      }
      this.database.prepare('INSERT INTO conversation_backup_state(session_id, identity_json) VALUES (?, ?)')
        .run(sessionId, JSON.stringify(identity));
      state = { generation: 0, sha256: null };
    }
    const digests = new Set(session.status === 'purged' ? [] : [session.origin_sha256, session.result_sha256]);
    for (const values of Object.values(rows)) for (const row of values) {
      for (const [key, value] of Object.entries(row)) if (key === 'sha256' || key.endsWith('_sha256')) digests.add(value);
    }
    digests.delete(null);
    digests.delete(undefined);
    const blobs = [];
    for (const digest of digests) {
      const saved = this.database.prepare('SELECT receipt_json FROM conversation_resource_receipts WHERE session_id = ? AND sha256 = ?').get(sessionId, digest);
      let receipt = saved && JSON.parse(saved.receipt_json);
      if (!receipt || receipt.expiresAt < Date.now() + 7 * 24 * 60 * 60_000) {
        const { blob, stream } = this.blobStore.openReadStream(digest);
        if (blob.size === 0) { stream.destroy(); blobs.push({ sha256: digest, size: 0 }); continue; }
        const result = await this.lease.archiveConversation({ ...identity, operationId: digest,
          revision: 1, turn: 0, kind: 'conversation-resource', fileName: 'resource.bin',
          size: blob.size, sha256: digest }, stream);
        receipt = result.mergeRequest;
        this.database.prepare('INSERT OR REPLACE INTO conversation_resource_receipts VALUES (?, ?, ?)')
          .run(sessionId, digest, JSON.stringify(receipt));
      }
      blobs.push(receipt);
    }
    const bytes = Buffer.from(JSON.stringify({ version: 1, session, rows, blobs }));
    if (bytes.length > MAX_BYTES) throw new CloudError('CONVERSATION_STORAGE_LIMIT', 'Conversation state exceeds 128 MiB', 413);
    const sha256 = hash(bytes);
    const currentTurn = rows.session_turns.find((turn) => turn.id === session.current_turn_id);
    const committedTurn = currentTurn && rows.session_checkpoints.some((boundary) =>
      boundary.turn_number === currentTurn.turn_number && boundary.boundary_kind === 'turn' && boundary.stable === 1);
    const completedTurns = Math.max(session.turns_used, ...rows.session_checkpoints
      .filter((boundary) => boundary.boundary_kind === 'turn' && boundary.stable === 1).map((boundary) => boundary.turn_number));
    const pendingWork = ['staged', 'queued', 'running', 'suspended'].includes(session.status)
      && !['ended', 'purged'].includes(session.room_status) && !session.end_requested_at
      && (Boolean(currentTurn && !committedTurn) || completedTurns === 0
        || rows.session_messages.some((message) => ['queued', 'delivered'].includes(message.status)
          && !(committedTurn && message.id === currentTurn.message_id)));
    if (sha256 !== state.sha256) {
      const generation = state.generation + 1;
      // Persist the attempt before upload, so a restart cannot reuse its revision
      // for different bytes after losing the broker receipt.
      this.database.prepare('UPDATE conversation_backup_state SET generation = ? WHERE session_id = ?').run(generation, sessionId);
      await this.lease.archiveConversation({ ...identity, operationId: `${generation}:${sha256}`,
        revision: generation, turn: session.turns_used, kind: 'conversation', state: session.status, pendingWork,
        retentionUntil: Math.min(Date.now() + RETENTION_MS, ...blobs.filter((blob) => blob.size > 0).map((blob) => blob.expiresAt)),
        fileName: 'conversation.json', size: bytes.length, sha256 }, Readable.from([bytes]));
      this.database.prepare('UPDATE conversation_backup_state SET sha256 = ? WHERE session_id = ?').run(sha256, sessionId);
    }
    // Another request may have changed SQLite while resources were uploading.
    const current = this.sessionStore.getSessionRow(sessionId);
    if (current.next_event_seq === session.next_event_seq && current.state_version === session.state_version) {
      this.database.prepare('DELETE FROM conversation_backup_pending WHERE session_id = ?').run(sessionId);
    }
    return { eventSeq: session.next_event_seq, stateVersion: session.state_version };
  }

  async restore(device, sessionId) {
    if (!this.enabled) throw new CloudError('CONVERSATION_RESTORE_UNAVAILABLE', 'Conversation restore is unavailable', 501);
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(sessionId)) throw fail('Session identity is invalid');
    const existing = this.database.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (existing) {
      await this.save(sessionId);
      return this.#restoreReceipt(sessionId);
    }
    const { bytes, record } = await this.lease.downloadConversation(sessionId);
    let snapshot;
    try { snapshot = JSON.parse(bytes.toString('utf8')); } catch { throw fail('Conversation snapshot is invalid JSON'); }
    const { session, rows, blobs } = snapshot;
    const sourceEventSeq = session?.next_event_seq - 1;
    if (snapshot.version !== 1 || session?.id !== sessionId || session.client_document_id !== record.documentId
      || session.client_thread_id !== record.threadId || !rows || !Array.isArray(blobs)
      || !Number.isSafeInteger(sourceEventSeq) || sourceEventSeq < 0) throw fail('Conversation identity does not match');
    if (session.status === 'purged') throw new CloudError('CONVERSATION_SNAPSHOT_NOT_FOUND', 'Saved cloud conversation was not found', 404);
    for (const table of TABLES) {
      if (!Array.isArray(rows[table])) throw fail('Conversation rows are missing');
      const columns = new Set(this.database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
      for (const row of rows[table]) {
        if (!row || Object.keys(row).some((key) => !columns.has(key))
          || (table !== 'session_message_attachments' && row.session_id !== sessionId)) throw fail('Conversation row is invalid');
      }
    }
    const sessionColumns = new Set(this.database.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name));
    if (Object.keys(session).some((key) => !sessionColumns.has(key))) throw fail('Conversation schema is not supported');
    const safeName = (name) => typeof name === 'string' && name.length > 0 && name.length <= 255
      && !/[\x00-\x1f/\\]/.test(name) && !['.', '..'].includes(name);
    if (!safeName(session.origin_name)) throw fail('Conversation document name is unsafe');
    const available = new Map(blobs.map((blob) => [blob.sha256, blob]));
    if (available.size !== blobs.length || blobs.reduce((sum, blob) => sum + blob.size, 0) > 512 * 1024 * 1024) {
      throw fail('Conversation resources exceed the storage limit');
    }
    for (const table of ['session_resources', 'session_attachment_versions']) {
      for (const row of rows[table]) if (!safeName(row.name)) throw fail('Conversation resource name is unsafe');
    }
    for (const row of [session, ...Object.values(rows).flat()]) {
      for (const [key, value] of Object.entries(row)) {
        if (value && (key === 'sha256' || key.endsWith('_sha256')) && !available.has(value)) {
          throw fail('Conversation is missing a referenced resource');
        }
      }
    }
    for (const blob of blobs) {
      const content = blob.size === 0 ? Buffer.alloc(0) : await this.lease.downloadConversationArtifact(blob, true);
      if (!/^[a-f0-9]{64}$/.test(blob.sha256) || hash(content) !== blob.sha256) throw fail('Conversation resource failed verification');
      let upload = await this.blobStore.initUpload({ deviceId: device.id, sha256: blob.sha256, size: content.length,
        name: 'restored-resource', kind: 'resource' });
      while (upload.status !== 'complete') {
        upload = await this.blobStore.appendChunk({ deviceId: device.id, uploadId: upload.uploadId,
          offset: upload.offset, bytes: content.subarray(upload.offset, upload.offset + upload.chunkSize) });
      }
    }
    // A boundary may be durable even when its turn-complete response was lost.
    // Finalize that exact turn without replaying its provider work.
    const currentTurn = rows.session_turns.find((turn) => turn.id === session.current_turn_id);
    const completedBoundary = currentTurn && rows.session_checkpoints.find((boundary) =>
      boundary.turn_number === currentTurn.turn_number && boundary.boundary_kind === 'turn' && boundary.stable === 1);
    if (completedBoundary) {
      Object.assign(currentTurn, { status: 'completed', outcome: 'completed',
        stable_boundary_operation_id: completedBoundary.operation_id, completed_at: completedBoundary.created_at });
      const message = rows.session_messages.find((message) => message.id === currentTurn.message_id);
      if (message) message.status = 'consumed';
      for (const wait of rows.session_waits) if (wait.turn_id === currentTurn.id && wait.status === 'pending') wait.status = 'cancelled';
      session.turns_used = Math.max(session.turns_used, currentTurn.turn_number);
      session.current_turn_id = null;
      session.current_wait_id = null;
    }
    let admission = null;
    if (['queued', 'running'].includes(session.status) && !session.current_turn_id) {
      const provider = this.sessionStore.providerStatus(session.provider);
      if (!provider.available || !provider.authenticated) admission = { code: 'AUTH_REQUIRED', message: 'Connect this conversation provider to resume Cloud.' };
      else {
        try { await this.lease.assertCommandAllowed('session.resume'); }
        catch (error) { admission = { code: error.code ?? 'RAUCLOUD_INPUT_BLOCKED', message: 'Cloud will resume when its connection and allowance are available.' }; }
      }
    }
    let imported = false;
    transaction(this.database, () => {
      // A duplicate restore can race while downloading; only the first imports.
      if (this.database.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) return;
      this.database.exec('PRAGMA defer_foreign_keys = ON');
      const uncertain = session.status === 'running' && Boolean(session.current_turn_id);
      Object.assign(session, { origin_device_id: device.id, worker_token_hash: null, sandbox_id: null,
        worker_heartbeat_at: null, started_at: null, takeover_requested_by: null,
        pause_requested_at: null, sleep_requested_at: null, finishing_at: null,
        expires_at: Date.now() + RETENTION_MS });
      if (uncertain || admission) {
        session.status = 'suspended';
        session.suspended_reason = JSON.stringify(uncertain ? { code: 'WORKER_REPLACED_UNCERTAIN',
          message: 'The worker stopped during a turn. Review its last saved state before resuming.' } : admission);
      } else if (session.status === 'running') {
        session.status = 'queued';
        session.execution_phase = 'idle';
        session.current_turn_id = null;
        session.current_wait_id = null;
      }
      if (!uncertain) {
        for (const message of rows.session_messages) if (message.status === 'delivered') {
          message.status = 'queued'; message.delivered_at = null;
        }
      }
      const insert = (table, row) => {
        const mapped = Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
          value !== null && (key === 'device_id' || key.endsWith('_device_id')) ? device.id : value]));
        const keys = Object.keys(mapped);
        this.database.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(mapped));
      };
      insert('sessions', session);
      for (const table of TABLES) for (const row of rows[table]) insert(table, row);
      for (const blob of blobs) {
        let references = session.result_sha256 === blob.sha256 ? 1 : 0;
        for (const table of ['session_resources', 'session_checkpoints', 'session_attachment_versions', 'session_events']) {
          for (const row of rows[table]) for (const [key, value] of Object.entries(row)) {
            if ((key === 'sha256' || key.endsWith('_sha256')) && value === blob.sha256) references++;
          }
        }
        this.database.prepare('UPDATE blobs SET ref_count = ref_count + ? WHERE sha256 = ?').run(references, blob.sha256);
        if (blob.size > 0) this.database.prepare('INSERT OR REPLACE INTO conversation_resource_receipts VALUES (?, ?, ?)')
          .run(sessionId, blob.sha256, JSON.stringify(blob));
      }
      this.database.prepare('INSERT OR REPLACE INTO conversation_backup_state VALUES (?, ?, ?, NULL)').run(sessionId,
        JSON.stringify({ sessionId, documentId: record.documentId, threadId: record.threadId, cloudStartId: record.cloudStartId }), record.revision);
      imported = true;
    });
    if (imported) {
      const [event] = this.sessionStore.appendEvents(sessionId, [{ type: 'session.restored', payload: {
        status: session.status, reason: session.suspended_reason ? JSON.parse(session.suspended_reason) : null,
        snapshotId: record.id, stateVersion: session.state_version,
      } }]);
      this.database.prepare('INSERT OR REPLACE INTO conversation_restore_receipts VALUES (?, ?, ?)')
        .run(sessionId, sourceEventSeq, event.seq);
    }
    await this.save(sessionId);
    return this.#restoreReceipt(sessionId);
  }

  #restoreReceipt(sessionId) {
    const receipt = this.database.prepare('SELECT * FROM conversation_restore_receipts WHERE session_id = ?').get(sessionId);
    const latestSeq = this.sessionStore.getSessionRow(sessionId).next_event_seq - 1;
    return { session: this.sessionStore.getSession(sessionId), restored: true,
      sourceEventSeq: receipt?.source_event_seq ?? latestSeq, restoredEventSeq: receipt?.restored_event_seq ?? latestSeq };
  }
}

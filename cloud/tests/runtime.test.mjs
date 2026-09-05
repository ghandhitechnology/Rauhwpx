import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { AuthService } from '../src/auth.mjs';
import { BlobStore } from '../src/blob-store.mjs';
import { databasePragmas, openDatabase } from '../src/database.mjs';
import { DisplayFrameStore } from '../src/display-frame-store.mjs';
import { parseCommand, parseSessionCreate, parseUploadInit } from '../src/protocol.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { runSession } from '../document-runtime/run.mjs';

async function fixture(t, { now = () => Date.now(), chunkBytes = 8 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cloud-'));
  const database = openDatabase(path.join(root, 'cloud.sqlite3'));
  const blobs = new BlobStore(database, { root: path.join(root, 'data'), now, chunkBytes });
  const auth = new AuthService(database, { now });
  const sessions = new SessionStore(database, blobs, { now });
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, database, blobs, auth, sessions };
}

async function pairedDevice(auth, name = 'Origin Mac') {
  const pairing = auth.createPairingCode();
  return auth.redeemPairingCode({ code: pairing.code, deviceName: name });
}

async function upload(blobs, deviceId, bytes, { name = 'document.hwpx', kind = 'document', sessionId = null } = {}) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let state = await blobs.initUpload({ deviceId, sha256, size: bytes.length, name, kind, sessionId });
  while (state.status !== 'complete') {
    const chunk = bytes.subarray(state.offset, state.offset + state.chunkSize);
    state = await blobs.appendChunk({ uploadId: state.uploadId, deviceId, offset: state.offset, bytes: chunk });
  }
  return state.blob;
}

test('database migrates with WAL, FULL sync, and foreign keys', async (t) => {
  const { database } = await fixture(t);
  assert.deepEqual(databasePragmas(database), {
    journalMode: 'wal',
    synchronous: 2,
    foreignKeys: 1,
    migrationVersion: 14,
  });
});

test('existing version-one state upgrades without losing resources or event sequence', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cloud-migration-'));
  const filename = path.join(root, 'cloud.sqlite3');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = new DatabaseSync(filename);
  legacy.exec('PRAGMA foreign_keys = ON');
  legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT');
  legacy.exec(await fs.readFile(path.resolve(import.meta.dirname, '../migrations/001_initial.sql'), 'utf8'));
  legacy.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1)').run();
  legacy.prepare(`INSERT INTO devices(id, name, created_at, last_seen_at) VALUES ('device', 'Device', 1, 1)`).run();
  legacy.prepare(`INSERT INTO token_families(id, device_id, expires_at, created_at) VALUES ('family', 'device', 99, 1)`).run();
  legacy.prepare(`INSERT INTO refresh_tokens(family_id, generation, token_hash, created_at) VALUES ('family', 2, x'01', 1)`).run();
  legacy.prepare(`
    INSERT INTO access_tokens(token_hash, device_id, family_id, expires_at, created_at)
    VALUES (x'02', 'device', 'family', 99, 1)
  `).run();
  legacy.prepare(`
    INSERT INTO blobs(sha256, size, storage_path, ref_count, created_at) VALUES (?, 1, '/tmp/blob', 1, 1)
  `).run('a'.repeat(64));
  legacy.prepare(`
    INSERT INTO sessions(
      id, origin_device_id, provider, goal, status, state_version, origin_name, origin_sha256, origin_size,
      max_duration_seconds, max_turns, expires_at, created_at, updated_at
    ) VALUES ('session', 'device', 'codex', 'Goal', 'staged', 1, 'doc.hwp', ?, 1, 3600, 10, 9, 1, 1)
  `).run('a'.repeat(64));
  legacy.prepare(`
    INSERT INTO session_resources(session_id, sha256, name, kind, size) VALUES ('session', ?, 'doc.hwp', 'document', 1)
  `).run('a'.repeat(64));
  legacy.prepare(`
    INSERT INTO session_events(session_id, seq, type, payload_json, created_at)
    VALUES ('session', 7, 'legacy.event', '{}', 1)
  `).run();
  for (const id of ['z-first', 'a-second']) {
    legacy.prepare(`
      INSERT INTO session_messages(id, session_id, device_id, content, status, created_at)
      VALUES (?, 'session', 'device', ?, 'queued', 1)
    `).run(id, id);
  }
  legacy.close();

  const upgraded = openDatabase(filename);
  t.after(() => upgraded.close());
  assert.equal(databasePragmas(upgraded).migrationVersion, 14);
  assert.equal(upgraded.prepare(`SELECT next_event_seq FROM sessions WHERE id = 'session'`).get().next_event_seq, 8);
  assert.equal(upgraded.prepare(`SELECT name FROM session_resources WHERE session_id = 'session'`).get().name, 'doc.hwp');
  assert.deepEqual(upgraded.prepare(`
    SELECT id FROM session_messages WHERE session_id = 'session' ORDER BY queue_sequence
  `).all().map(({ id }) => id), ['z-first', 'a-second']);
  assert.equal(upgraded.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('sessions') WHERE name IN ('execution_config_json', 'pause_requested_at', 'finishing_at')`).get().count, 3);
  assert.equal(upgraded.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('access_tokens') WHERE name = 'generation'`).get().count, 1);
  assert.equal(upgraded.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('refresh_tokens') WHERE name = 'activated_at'`).get().count, 1);
  assert.equal(upgraded.prepare(`SELECT generation FROM access_tokens WHERE family_id = 'family'`).get().generation, 2);
  assert.equal(upgraded.prepare(`SELECT protocol_version, room_status, execution_phase FROM sessions WHERE id = 'session'`).get().protocol_version, 1);
  assert.equal(upgraded.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('session_events') WHERE name IN ('event_id', 'turn_id', 'payload_blob_sha256')`).get().count, 3);
  assert.equal(upgraded.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('session_turns', 'session_waits', 'session_attachment_versions', 'session_message_attachments', 'session_presence', 'session_runtime_leases')`).get().count, 6);
  assert.equal(upgraded.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('sessions') WHERE name IN ('takeover_requested_at', 'takeover_requested_by', 'frozen_checkpoint_operation_id')`).get().count, 3);
  assert.equal(upgraded.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('session_checkpoints') WHERE name IN ('timeline_blob_sha256', 'timeline_size')`).get().count, 2);
  assert.equal(upgraded.prepare(`SELECT blob_sha256 FROM session_checkpoints WHERE operation_id = 'migration-handoff:session'`).get().blob_sha256, 'a'.repeat(64));
  assert.equal(upgraded.prepare(`SELECT ref_count FROM blobs WHERE sha256 = ?`).get('a'.repeat(64)).ref_count, 2);
});

test('pairing is one-time and refresh reuse revokes the token family', async (t) => {
  let clock = 1_800_000_000_000;
  const { auth } = await fixture(t, { now: () => clock });
  const pairing = auth.createPairingCode();
  const first = auth.redeemPairingCode({ code: pairing.code, deviceName: 'Linux laptop' });
  assert.equal(auth.authenticate(first.accessToken).name, 'Linux laptop');
  assert.throws(
    () => auth.redeemPairingCode({ code: pairing.code, deviceName: 'Attacker' }),
    { code: 'PAIRING_CODE_INVALID' },
  );

  const rotated = auth.refresh(first.refreshToken);
  assert.deepEqual(auth.refresh(first.refreshToken), rotated, 'a crash retry returns the same successor token bundle');
  assert.equal(auth.authenticate(rotated.accessToken).id, first.device.id);
  assert.throws(() => auth.refresh(first.refreshToken), { code: 'REFRESH_TOKEN_REUSED' });
  assert.throws(() => auth.authenticate(rotated.accessToken), { code: 'UNAUTHORIZED' });

  clock += 31 * 24 * 60 * 60 * 1000;
  assert.throws(() => auth.refresh(rotated.refreshToken), { code: 'REFRESH_TOKEN_INVALID' });
});

test('refresh crash retry survives a service restart without weakening reuse detection', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cloud-refresh-restart-'));
  const filename = path.join(root, 'cloud.sqlite3');
  const retrySecret = Buffer.alloc(32, 0x42);
  let clock = 1_800_000_000_000;
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const firstDatabase = openDatabase(filename);
  const firstAuth = new AuthService(firstDatabase, { now: () => clock, retrySecret });
  const pairing = firstAuth.createPairingCode();
  const initial = firstAuth.redeemPairingCode({ code: pairing.code, deviceName: 'Restarting desktop' });
  const rotated = firstAuth.refresh(initial.refreshToken);
  firstDatabase.close();

  const restartedDatabase = openDatabase(filename);
  t.after(() => restartedDatabase.close());
  const restartedAuth = new AuthService(restartedDatabase, { now: () => clock, retrySecret });
  assert.deepEqual(
    restartedAuth.refresh(initial.refreshToken),
    rotated,
    'lost refresh response can be retried after the service restarts',
  );
  assert.equal(restartedAuth.authenticate(rotated.accessToken).id, initial.device.id);
  assert.throws(() => restartedAuth.refresh(initial.refreshToken), { code: 'REFRESH_TOKEN_REUSED' });
});

test('refresh retry receipt outlives the client maximum request and backoff schedule', async (t) => {
  let clock = 1_800_000_000_000;
  const { auth } = await fixture(t, { now: () => clock });
  const pairing = auth.createPairingCode();
  const initial = auth.redeemPairingCode({ code: pairing.code, deviceName: 'Slow desktop' });
  const rotated = auth.refresh(initial.refreshToken);

  clock += 119_000;
  assert.deepEqual(auth.refresh(initial.refreshToken), rotated);
  assert.equal(auth.authenticate(rotated.accessToken).id, initial.device.id);
  assert.throws(() => auth.refresh(initial.refreshToken), { code: 'REFRESH_TOKEN_REUSED' });
});

test('expired uploads recycle their unique reservation and result uploads stay desktop-sized', async (t) => {
  let clock = 1_800_000_000_000;
  const { blobs, auth } = await fixture(t, { now: () => clock, chunkBytes: 4 });
  const tokens = await pairedDevice(auth);
  const bytes = Buffer.from('retry-upload');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const first = await blobs.initUpload({
    deviceId: tokens.device.id, sessionId: 'session-upload-retry', sha256,
    size: bytes.length, name: 'retry.hwpx', kind: 'document',
  });
  await blobs.appendChunk({
    uploadId: first.uploadId, deviceId: tokens.device.id, offset: 0, bytes: bytes.subarray(0, 4),
  });
  clock += 25 * 60 * 60 * 1000;
  assert.equal(await blobs.pruneStaleUploads(), 1);
  const recycled = await blobs.initUpload({
    deviceId: tokens.device.id, sessionId: 'session-upload-retry', sha256,
    size: bytes.length, name: 'retry.hwpx', kind: 'document',
  });
  assert.notEqual(recycled.uploadId, first.uploadId);
  assert.throws(() => parseUploadInit({
    sha256: 'a'.repeat(64), size: 64 * 1024 ** 2 + 1, name: 'large.hwpx', kind: 'result',
  }), { code: 'INVALID_REQUEST' });
});

test('upload maintenance purges unattached completed blobs but preserves session references', async (t) => {
  let clock = 1_800_000_000_000;
  const { blobs, auth, sessions, database } = await fixture(t, { now: () => clock });
  const origin = await pairedDevice(auth);
  const orphan = await upload(blobs, origin.device.id, Buffer.from('orphaned sensitive upload'));
  const attached = await upload(blobs, origin.device.id, Buffer.from('attached document'));
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  sessions.createSession(origin.device, parseSessionCreate({
    sessionId: 'session_attached_upload', provider: 'codex', goal: 'Keep this',
    originDocument: { blobId: attached.id, name: 'attached.hwpx', size: attached.size },
  }));

  clock += 25 * 60 * 60 * 1000;
  assert.equal(await blobs.pruneStaleUploads(), 2);
  assert.equal(blobs.get(orphan.id), null);
  assert.ok(blobs.get(attached.id));
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM uploads WHERE sha256 = ?`).get(attached.id).count, 0);
});

test('resumable upload reconciles crash bytes and rejects digest mismatch', async (t) => {
  const { blobs, auth, database } = await fixture(t, { chunkBytes: 4 });
  const tokens = await pairedDevice(auth);
  const bytes = Buffer.from('durable document bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let uploadState = await blobs.initUpload({
    deviceId: tokens.device.id,
    sha256,
    size: bytes.length,
    name: 'document.hwpx',
    kind: 'document',
  });
  uploadState = await blobs.appendChunk({
    uploadId: uploadState.uploadId,
    deviceId: tokens.device.id,
    offset: 0,
    bytes: bytes.subarray(0, 4),
  });
  const row = database.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadState.uploadId);
  await fs.appendFile(row.temp_path, Buffer.from('uncommitted-crash-bytes'));
  const resumed = await blobs.initUpload({
    deviceId: tokens.device.id,
    sha256,
    size: bytes.length,
    name: 'document.hwpx',
    kind: 'document',
  });
  assert.equal(resumed.offset, 4);
  assert.equal((await fs.stat(row.temp_path)).size, 4);
  let current = resumed;
  while (current.status !== 'complete') {
    current = await blobs.appendChunk({
      uploadId: current.uploadId,
      deviceId: tokens.device.id,
      offset: current.offset,
      bytes: bytes.subarray(current.offset, current.offset + current.chunkSize),
    });
  }
  assert.equal(current.blob.sha256, sha256);
  assert.equal((await blobs.initUpload({
    deviceId: tokens.device.id,
    sha256,
    size: bytes.length,
    name: 'duplicate.hwpx',
    kind: 'document',
  })).blobExists, true);
});

test('session commands are idempotent, events replay, recovery requeues, and origin confirmation purges', async (t) => {
  const { blobs, auth, sessions, database } = await fixture(t);
  const origin = await pairedDevice(auth);
  const second = await pairedDevice(auth, 'Second device');
  sessions.setProviderStatus('codex', { available: true, version: 'codex 1.0' });
  const document = await upload(blobs, origin.device.id, Buffer.from('document'), { name: 'work.hwpx' });
  const timeline = await upload(blobs, origin.device.id, Buffer.from('[{"role":"user"}]'), { name: 'timeline.json', kind: 'timeline' });
  const input = parseSessionCreate({
    sessionId: 'session_cloud_01',
    provider: 'codex',
    goal: 'Finish the document',
    originDocument: { blobId: document.id, name: 'work.hwpx', size: document.size },
    timeline: { blobId: timeline.id, size: timeline.size },
  });
  assert.equal(sessions.createSession(origin.device, input).status, 'staged');
  const command = parseCommand({ commandId: 'command_activate_01', type: 'session.activate', payload: { expectedVersion: 1 } });
  const first = sessions.executeCommand(origin.device, input.sessionId, command);
  const retry = sessions.executeCommand(origin.device, input.sessionId, command);
  assert.deepEqual(retry, first);
  assert.throws(() => sessions.executeCommand(second.device, input.sessionId, parseCommand({
    commandId: 'command_stale_01',
    type: 'session.cancel',
    payload: { expectedVersion: 1 },
  })), { code: 'STATE_VERSION_CONFLICT', status: 409 });
  assert.equal(sessions.listEvents(input.sessionId, 0).map((event) => event.seq).join(','), '1,2');
  assert.deepEqual(sessions.listEvents(input.sessionId, 0).map((event) => event.stateVersion), [1, 2]);

  assert.equal(sessions.claimNextSession().status, 'running');
  sessions.executeCommand(second.device, input.sessionId, parseCommand({
    commandId: 'command_message_01', type: 'message.queue', payload: { content: 'Add one more note' },
  }));
  const delivered = sessions.takeQueuedMessages(input.sessionId);
  assert.equal(delivered.length, 1);
  assert.equal(sessions.listEvents(input.sessionId, 0).at(-1).type, 'message.accepted');
  sessions.attachSandbox(input.sessionId, 'sandbox-old');
  assert.deepEqual(sessions.recoverInterruptedSessions(new Set()), [{
    sessionId: input.sessionId,
    action: 'requeued',
    sandboxId: null,
  }]);
  sessions.claimNextSession();
  const result = await upload(blobs, origin.device.id, Buffer.from('finished-document'), {
    name: 'result.hwpx', kind: 'result', sessionId: input.sessionId,
  });
  const pendingBytes = Buffer.from('unfinished-worker-artifact');
  const pendingUpload = await blobs.initUpload({
    deviceId: origin.device.id,
    sessionId: input.sessionId,
    sha256: createHash('sha256').update(pendingBytes).digest('hex'),
    size: pendingBytes.length,
    name: 'unfinished-result.hwpx',
    kind: 'result',
  });
  const pendingRow = database.prepare('SELECT * FROM uploads WHERE id = ?').get(pendingUpload.uploadId);
  assert.equal((await fs.stat(pendingRow.temp_path)).isFile(), true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM uploads WHERE session_id = ?').get(input.sessionId).count, 2);
  const finalClaim = sessions.claimFinish(input.sessionId);
  assert.equal(finalClaim.ready, false);
  assert.equal(finalClaim.messages.length, 1);
  sessions.completeTurn(input.sessionId);
  assert.equal(sessions.claimFinish(input.sessionId).ready, true);
  sessions.publishResult(input.sessionId, { blobId: result.id, size: result.size });
  await assert.rejects(
    () => sessions.confirmResultDownloaded(second.device, input.sessionId, { sha256: result.sha256, size: result.size }),
    { code: 'ORIGIN_DEVICE_REQUIRED' },
  );
  const receipt = await sessions.confirmResultDownloaded(origin.device, input.sessionId, { sha256: result.sha256, size: result.size });
  assert.equal(receipt.status, 'purged');
  assert.equal(sessions.getSession(input.sessionId).goal, '[purged]');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM session_resources WHERE session_id = ?').get(input.sessionId).count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM uploads WHERE session_id = ?').get(input.sessionId).count, 0);
  await assert.rejects(fs.stat(pendingRow.temp_path), { code: 'ENOENT' });
  assert.equal(blobs.get(result.sha256), null);
  assert.ok(sessions.listEvents(input.sessionId, 0)[0].seq > 2, 'purge event sequence must remain monotonic after sensitive replay deletion');

  const legacyUploadId = '11111111-1111-4111-8111-111111111111';
  const legacyTempPath = path.join(blobs.staging, `${legacyUploadId}.part`);
  await fs.writeFile(legacyTempPath, 'legacy-purged-upload', { mode: 0o600 });
  database.prepare(`
    INSERT INTO uploads(
      id, device_id, session_id, sha256, size, name, kind, temp_path,
      received_bytes, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 21, 'legacy.part', 'result', ?, 0, 'uploading', 1, 1)
  `).run(legacyUploadId, origin.device.id, input.sessionId, 'f'.repeat(64), legacyTempPath);
  const repeated = await sessions.confirmResultDownloaded(origin.device, input.sessionId, {
    sha256: result.sha256,
    size: result.size,
  });
  assert.equal(repeated.status, 'purged');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM uploads WHERE session_id = ?').get(input.sessionId).count, 0);
  await assert.rejects(fs.stat(legacyTempPath), { code: 'ENOENT' });
});

test('session creation blocks unavailable providers and incomplete blobs', async (t) => {
  const { auth, sessions } = await fixture(t);
  const origin = await pairedDevice(auth);
  const body = {
    sessionId: 'session_blocked_01',
    provider: 'claude',
    goal: 'Work',
    originDocument: { blobId: 'a'.repeat(64), name: 'work.hwpx', size: 10 },
  };
  assert.throws(() => sessions.createSession(origin.device, parseSessionCreate(body)), { code: 'PROVIDER_UNAVAILABLE' });
  sessions.setProviderStatus('claude', { available: true, version: '1' });
  assert.throws(() => sessions.createSession(origin.device, parseSessionCreate(body)), { code: 'BLOB_NOT_FOUND' });
  sessions.setProviderStatus('claude', { available: true, authenticated: false, version: '1' });
  assert.throws(() => sessions.createSession(origin.device, parseSessionCreate(body)), { code: 'AUTH_REQUIRED' });
});

test('duplicate-byte references retain both names and execution config reaches the worker', async (t) => {
  const { blobs, auth, sessions } = await fixture(t);
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('document'));
  const reference = await upload(blobs, origin.device.id, Buffer.from('same reference'), { name: 'a.txt', kind: 'resource' });
  const input = parseSessionCreate({
    sessionId: 'session_duplicate_refs', provider: 'codex', goal: 'Use both names',
    clientContext: { threadId: 'thread-duplicate', documentId: null },
    executionConfig: {
      model: 'gpt-5.6-sol', effort: 'xhigh', workflow: 'plan', permissionProfile: 'unrestricted',
    },
    originDocument: { blobId: document.id, name: 'document.hwpx', size: document.size },
    resources: [
      { blobId: reference.id, name: 'first.txt', size: reference.size, kind: 'reference' },
      { blobId: reference.id, name: 'second.txt', size: reference.size, kind: 'reference' },
    ],
  });
  const session = sessions.createSession(origin.device, input);
  assert.deepEqual(session.clientContext, { threadId: 'thread-duplicate', documentId: null });
  const manifest = sessions.workerManifest(input.sessionId);
  assert.equal(manifest.latestCheckpoint, null, 'handoff boundary must not be mistaken for worker crash recovery');
  assert.deepEqual(manifest.resources.filter(({ kind }) => kind === 'reference').map(({ name }) => name), [
    'first.txt', 'second.txt',
  ]);
  assert.deepEqual(manifest.executionConfig, input.executionConfig);
});

test('safe pause waits for worker acknowledgement and successful turns consume delivered messages', async (t) => {
  const { blobs, auth, sessions } = await fixture(t);
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('document'));
  const input = parseSessionCreate({
    sessionId: 'session_safe_pause', provider: 'codex', goal: 'Pause safely',
    originDocument: { blobId: document.id, name: 'document.hwpx', size: document.size },
  });
  sessions.createSession(origin.device, input);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'activate_safe_pause', type: 'session.activate', payload: { expectedVersion: 1 },
  }));
  assert.equal(sessions.claimNextSession().stateVersion, 3);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'message_safe_pause', type: 'message.queue', payload: { content: 'Apply once' },
  }));
  assert.equal(sessions.takeQueuedMessages(input.sessionId).length, 1);
  sessions.completeTurn(input.sessionId);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'pause_safe_pause', type: 'session.pause', payload: { expectedVersion: 4 },
  }));
  assert.equal(sessions.getSession(input.sessionId).status, 'running');
  assert.equal(sessions.workerControl(input.sessionId).pauseRequested, true);
  const paused = sessions.acknowledgePause(input.sessionId);
  assert.equal(paused.status, 'suspended');
  assert.equal(paused.pauseRequested, false);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'resume_safe_pause', type: 'session.resume', payload: { expectedVersion: 6 },
  }));
  sessions.claimNextSession();
  sessions.attachSandbox(input.sessionId, 'sandbox-after-complete');
  sessions.recoverInterruptedSessions(new Set());
  sessions.claimNextSession();
  assert.equal(sessions.takeQueuedMessages(input.sessionId).length, 0, 'consumed messages are not replayed after recovery');
});

test('turn-limit resume rejects new messages and requeues a pre-limit finish-claim race on suspension', async (t) => {
  const { blobs, auth, sessions, database } = await fixture(t);
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('document'));
  const input = parseSessionCreate({
    sessionId: 'session_turn_limit_resume', provider: 'codex', goal: 'Pause on the final turn',
    originDocument: { blobId: document.id, name: 'document.hwpx', size: document.size },
    limits: { maxTurns: 1 },
  });
  sessions.createSession(origin.device, input);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'activate_turn_limit_resume', type: 'session.activate', payload: { expectedVersion: 1 },
  }));
  sessions.claimNextSession();
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'pause_turn_limit_resume', type: 'session.pause',
    payload: { expectedVersion: sessions.getSession(input.sessionId).stateVersion },
  }));
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'message_before_final_turn_commit', type: 'message.queue',
    payload: { content: 'Preserve this raced message' },
  }));
  assert.equal(sessions.completeTurn(input.sessionId).status, 'running', 'pending pause wins over turn-limit suspension');
  sessions.acknowledgePause(input.sessionId);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'resume_at_turn_limit', type: 'session.resume',
    payload: { expectedVersion: sessions.getSession(input.sessionId).stateVersion },
  }));
  assert.throws(() => sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'message_after_turn_limit', type: 'message.queue', payload: { content: 'Too late' },
  })), { code: 'TURN_LIMIT', status: 409 });

  sessions.claimNextSession();
  const pending = sessions.claimFinish(input.sessionId);
  assert.deepEqual(pending.messages.map(({ content }) => content), ['Preserve this raced message']);
  assert.equal(database.prepare(`
    SELECT status FROM session_messages WHERE session_id = ?
  `).get(input.sessionId).status, 'delivered');
  sessions.suspend(input.sessionId, {
    code: 'TURN_LIMIT_PENDING_MESSAGES',
    message: 'Turn limit reached before queued messages could be processed',
  });
  assert.equal(database.prepare(`
    SELECT status FROM session_messages WHERE session_id = ?
  `).get(input.sessionId).status, 'queued', 'worker suspension must preserve the raced message for a later resolution');
});

test('takeover waits for one atomic checkpoint and timeline boundary before revoking the worker', async (t) => {
  const { blobs, auth, sessions } = await fixture(t);
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('origin document'));
  const initialTimeline = await upload(blobs, origin.device.id, Buffer.from('[{"turn":0}]'), {
    name: 'timeline.json', kind: 'timeline',
  });
  const input = parseSessionCreate({
    sessionId: 'session_atomic_takeover', provider: 'codex', goal: 'Take over safely',
    originDocument: { blobId: document.id, name: 'document.hwpx', size: document.size },
    timeline: { blobId: initialTimeline.id, size: initialTimeline.size },
  });
  sessions.createSession(origin.device, input);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'activate_atomic_takeover', type: 'session.activate', payload: { expectedVersion: 1 },
  }));
  sessions.claimNextSession();
  sessions.prepareWorker(input.sessionId, 'ra_wt_atomic_takeover');

  const pending = sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'takeover_atomic_takeover', type: 'session.takeover', payload: { expectedVersion: 3 },
  }));
  assert.equal(pending.takeover.status, 'pending');
  assert.equal(sessions.getSession(input.sessionId).status, 'running');
  assert.equal(sessions.workerControl(input.sessionId).takeoverRequested, true);
  assert.equal(sessions.authenticateWorker(input.sessionId, 'ra_wt_atomic_takeover').id, input.sessionId);
  assert.deepEqual(sessions.claimFinish(input.sessionId), {
    ready: false, messages: [], takeoverRequested: true,
  });
  assert.throws(() => sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'message_during_takeover', type: 'message.queue', payload: { content: 'Too late' },
  })), { code: 'TAKEOVER_PENDING' });

  const checkpoint = await upload(blobs, origin.device.id, Buffer.from('edited at boundary'));
  const timeline = await upload(blobs, origin.device.id, Buffer.from('[{"turn":1,"revision":9}]'), {
    name: 'timeline.json', kind: 'timeline',
  });
  const committed = await sessions.commitBoundary(input.sessionId, {
    operationId: 'boundary-takeover-turn-1', turnNumber: 1, revision: 9,
    checkpoint: { blobId: checkpoint.id, size: checkpoint.size },
    timeline: { blobId: timeline.id, size: timeline.size },
  });
  assert.equal(committed.checkpoint.blobId, checkpoint.id);
  assert.equal(committed.timeline.blobId, timeline.id);
  sessions.completeTurn(input.sessionId);
  const ready = sessions.acknowledgeTakeover(input.sessionId);
  assert.equal(ready.takeover.status, 'ready');
  assert.equal(ready.session.takeoverReady, true);
  assert.equal(ready.session.takeoverRequested, false);
  assert.equal(ready.takeover.boundary.operationId, 'boundary-takeover-turn-1');
  assert.equal(ready.takeover.boundary.checkpoint.blobId, checkpoint.id);
  assert.equal(ready.takeover.boundary.timeline.blobId, timeline.id);
  assert.equal(sessions.latestStableCheckpoint(input.sessionId).blobId, checkpoint.id);
  assert.equal(sessions.currentTimeline(input.sessionId).blobId, timeline.id);
  assert.deepEqual(sessions.takeoverState(input.sessionId), ready.takeover);
  assert.throws(() => sessions.authenticateWorker(input.sessionId, 'ra_wt_atomic_takeover'), { code: 'WORKER_UNAUTHORIZED' });
  await assert.rejects(
    () => sessions.publishTimeline(input.sessionId, { blobId: initialTimeline.id, size: initialTimeline.size }),
    { code: 'INVALID_SESSION_STATE' },
  );
  const readyEvent = sessions.listEvents(input.sessionId, 0).find(({ type }) => type === 'session.takeover_ready');
  assert.equal(readyEvent.payload.boundary.checkpoint.blobId, checkpoint.id);
  assert.equal(readyEvent.payload.boundary.timeline.blobId, timeline.id);
});

test('takeover recovery before turn one freezes the initial handoff boundary', async (t) => {
  const { blobs, auth, sessions } = await fixture(t);
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('origin before crash'));
  const timeline = await upload(blobs, origin.device.id, Buffer.from('[{"turn":0}]'), {
    name: 'timeline.json', kind: 'timeline',
  });
  const input = parseSessionCreate({
    sessionId: 'session_takeover_before_turn_one', provider: 'codex', goal: 'Start work',
    originDocument: { blobId: document.id, name: 'origin.hwp', size: document.size },
    timeline: { blobId: timeline.id, size: timeline.size },
  });
  sessions.createSession(origin.device, input);
  assert.equal(sessions.workerManifest(input.sessionId).latestCheckpoint, null);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'activate_takeover_before_turn_one', type: 'session.activate', payload: { expectedVersion: 1 },
  }));
  sessions.claimNextSession();
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'takeover_before_turn_one', type: 'session.takeover', payload: { expectedVersion: 3 },
  }));

  const recovered = sessions.requeueInterruptedSession(input.sessionId, 'crashed_before_first_boundary');
  assert.equal(recovered.status, 'cancelled');
  assert.equal(recovered.takeoverReady, true);
  const receipt = sessions.takeoverState(input.sessionId);
  assert.equal(receipt.status, 'ready');
  assert.equal(receipt.boundary.operationId, `handoff:${input.sessionId}`);
  assert.equal(receipt.boundary.turnNumber, 0);
  assert.equal(receipt.boundary.checkpoint.blobId, document.id);
  assert.equal(receipt.boundary.timeline.blobId, timeline.id);
});

test('cancelled and abandoned sessions purge retained content and upload reservations after expiry', async (t) => {
  let clock = 1_800_000_000_000;
  const { blobs, auth, sessions, database } = await fixture(t, { now: () => clock });
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('sensitive document'));
  const input = parseSessionCreate({
    sessionId: 'session_cancel_purge', provider: 'codex', goal: 'Discard',
    originDocument: { blobId: document.id, name: 'document.hwpx', size: document.size },
  });
  sessions.createSession(origin.device, input);
  const pending = await blobs.initUpload({
    deviceId: origin.device.id,
    sessionId: input.sessionId,
    sha256: createHash('sha256').update('cancelled-pending-upload').digest('hex'),
    size: 24,
    name: 'cancelled.part',
    kind: 'result',
  });
  const pendingPath = database.prepare('SELECT temp_path FROM uploads WHERE id = ?').get(pending.uploadId).temp_path;
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'cancel_purge', type: 'session.cancel', payload: { expectedVersion: 1 },
  }));
  assert.equal(await sessions.expireRetainedSessions(), 1);
  assert.equal(sessions.getSession(input.sessionId).status, 'purged');
  assert.equal(blobs.get(document.sha256), null);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM uploads WHERE session_id = ?').get(input.sessionId).count, 0);
  await assert.rejects(fs.stat(pendingPath), { code: 'ENOENT' });

  const stagedDocument = await upload(blobs, origin.device.id, Buffer.from('abandoned document'));
  sessions.createSession(origin.device, parseSessionCreate({
    sessionId: 'session_abandoned_purge', provider: 'codex', goal: 'Abandoned',
    originDocument: { blobId: stagedDocument.id, name: 'abandoned.hwpx', size: stagedDocument.size },
  }));
  clock += 24 * 60 * 60 * 1000 + 1;
  assert.equal(await sessions.expireRetainedSessions(), 1);
  assert.equal(sessions.getSession('session_abandoned_purge').status, 'purged');

  const legacyBytes = Buffer.from('maintenance-cleans-this');
  const legacySha256 = createHash('sha256').update(legacyBytes).digest('hex');
  await upload(blobs, origin.device.id, legacyBytes, {
    sessionId: 'session_abandoned_purge',
    name: 'legacy.part',
    kind: 'result',
  });
  const legacyBlobPath = blobs.get(legacySha256).storage_path;
  assert.equal(blobs.get(legacySha256).ref_count, 0);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM uploads
    WHERE session_id = 'session_abandoned_purge' AND status = 'complete'
  `).get().count, 1);
  assert.equal((await fs.stat(legacyBlobPath)).isFile(), true);
  assert.equal(await sessions.expireRetainedSessions(), 0, 'legacy cleanup is maintenance, not a newly expired session');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM uploads WHERE session_id = 'session_abandoned_purge'
  `).get().count, 0);
  assert.equal(blobs.get(legacySha256), null);
  await assert.rejects(fs.stat(legacyBlobPath), { code: 'ENOENT' });
});

test('atomic finish delivers pre-claim messages and rejects post-claim messages without loss', async (t) => {
  const { blobs, auth, sessions } = await fixture(t);
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('document'));
  const input = parseSessionCreate({
    sessionId: 'session_atomic_finish', provider: 'codex', goal: 'Finish safely',
    originDocument: { blobId: document.id, name: 'document.hwpx', size: document.size },
  });
  sessions.createSession(origin.device, input);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'activate_atomic_finish', type: 'session.activate', payload: { expectedVersion: 1 },
  }));
  sessions.claimNextSession();
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'message_before_finish', type: 'message.queue', payload: { content: 'Include this final note' },
  }));
  const pending = sessions.claimFinish(input.sessionId);
  assert.equal(pending.ready, false);
  assert.deepEqual(pending.messages.map(({ content }) => content), ['Include this final note']);
  sessions.completeTurn(input.sessionId);
  assert.deepEqual(sessions.claimFinish(input.sessionId), { ready: true, messages: [] });
  assert.throws(() => sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'pause_after_finish', type: 'session.pause', payload: { expectedVersion: 4 },
  })), { code: 'SESSION_FINISHING', status: 409 });
  assert.throws(() => sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'message_after_finish', type: 'message.queue', payload: { content: 'Too late' },
  })), { code: 'SESSION_FINISHING', status: 409 });
  const result = await upload(blobs, origin.device.id, Buffer.from('result'), { kind: 'result' });
  const completed = sessions.publishResult(input.sessionId, { blobId: result.id, size: result.size });
  assert.equal(completed.status, 'completed');
  assert.equal(sessions.database.prepare(`
    SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND status = 'queued'
  `).get(input.sessionId).count, 0);
});

test('persistent conversation waits for another turn until explicit End', async (t) => {
  const { blobs, auth, sessions } = await fixture(t);
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('persistent document'));
  const input = parseSessionCreate({
    sessionId: 'session_persistent_room',
    provider: 'codex',
    goal: 'Start the persistent conversation',
    persistent: true,
    clientContext: { threadId: 'thread-persistent', documentId: 'document-persistent' },
    originDocument: { blobId: document.id, name: 'document.hwpx', size: document.size },
  });
  const created = sessions.createSession(origin.device, input);
  assert.equal(created.persistent, true);
  assert.equal(created.roomStatus, 'active');
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'activate_persistent_room', type: 'session.activate', payload: { expectedVersion: created.stateVersion },
  }));
  sessions.claimNextSession();

  sessions.completeTurn(input.sessionId);
  assert.deepEqual(sessions.claimFinish(input.sessionId), {
    ready: false, waiting: true, workflow: 'direct', messages: [],
  });
  assert.equal(sessions.getSession(input.sessionId).status, 'running');
  assert.equal(sessions.getSession(input.sessionId).executionPhase, 'idle');

  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'workflow_persistent_plan',
    type: 'conversation.workflow',
    payload: { expectedVersion: sessions.getSession(input.sessionId).stateVersion, workflow: 'plan' },
  }));
  assert.equal(sessions.getSession(input.sessionId).executionConfig.workflow, 'plan');

  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'message_persistent_second_turn',
    type: 'message.queue',
    payload: { messageId: 'persistent-message-2', content: 'Now update the footer.' },
  }));
  const next = sessions.claimFinish(input.sessionId);
  assert.deepEqual(next.messages.map(({ id, content }) => ({ id, content })), [{
    id: 'persistent-message-2', content: 'Now update the footer.',
  }]);
  assert.equal(next.workflow, 'plan');
  assert.equal(sessions.getSession(input.sessionId).executionPhase, 'working');

  sessions.completeTurn(input.sessionId);
  assert.equal(sessions.claimFinish(input.sessionId).waiting, true);
  const ending = sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'end_persistent_room',
    type: 'session.end',
    payload: { expectedVersion: sessions.getSession(input.sessionId).stateVersion },
  }));
  assert.equal(ending.session.roomStatus, 'ending');
  assert.equal(ending.session.endRequested, true);
  assert.deepEqual(sessions.claimFinish(input.sessionId), { ready: true, messages: [] });
  assert.throws(() => sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'message_after_persistent_end',
    type: 'message.queue',
    payload: { content: 'Too late' },
  })), { code: 'CONVERSATION_ENDING' });

  const types = sessions.listEvents(input.sessionId, 0).map(({ type }) => type);
  assert.ok(types.includes('conversation.waiting'));
  assert.ok(types.includes('conversation.workflow_changed'));
  assert.ok(types.includes('conversation.ending'));
});

test('persistent message claims bind one queued message to one crash-recoverable turn', async (t) => {
  const { blobs, auth, sessions, database } = await fixture(t);
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('persistent queue document'));
  const input = parseSessionCreate({
    sessionId: 'session_persistent_message_crash', provider: 'codex', goal: 'Start the room', persistent: true,
    clientContext: { threadId: 'thread-message-crash', documentId: 'document-message-crash' },
    originDocument: { blobId: document.id, name: 'message-crash.hwpx', size: document.size },
  });
  const created = sessions.createSession(origin.device, input);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'activate_persistent_message_crash', type: 'session.activate',
    payload: { expectedVersion: created.stateVersion },
  }));
  sessions.claimNextSession();
  sessions.beginTurn(input.sessionId, { turnNumber: 1, mode: 'direct' });
  sessions.completeTurn(input.sessionId);

  for (const [messageId, content] of [['crash-message-1', 'First follow-up'], ['crash-message-2', 'Second follow-up']]) {
    sessions.executeCommand(origin.device, input.sessionId, parseCommand({
      commandId: `queue_${messageId}`, type: 'message.queue', payload: { messageId, content },
    }));
  }
  const firstClaim = sessions.claimFinish(input.sessionId);
  assert.deepEqual(firstClaim.messages.map(({ id }) => id), ['crash-message-1']);
  sessions.beginTurn(input.sessionId, { turnNumber: 2, messageId: 'crash-message-1', mode: 'direct' });
  sessions.completeTurn(input.sessionId);
  assert.deepEqual(database.prepare(`
    SELECT id, status FROM session_messages WHERE session_id = ? ORDER BY created_at, id
  `).all(input.sessionId).map(({ id, status }) => ({ id, status })), [
    { id: 'crash-message-1', status: 'consumed' },
    { id: 'crash-message-2', status: 'queued' },
  ]);

  sessions.requeueInterruptedSession(input.sessionId, 'worker_crashed_between_turns');
  sessions.claimNextSession();
  const recoveredClaim = sessions.claimFinish(input.sessionId);
  assert.deepEqual(recoveredClaim.messages.map(({ id, content }) => ({ id, content })), [
    { id: 'crash-message-2', content: 'Second follow-up' },
  ]);
  const resumedTurn = sessions.beginTurn(input.sessionId, {
    turnNumber: 3, messageId: 'crash-message-2', mode: 'direct',
  });
  const operationCheckpoint = await upload(blobs, origin.device.id, Buffer.from('operation checkpoint'));
  const operationTimeline = await upload(blobs, origin.device.id, Buffer.from('{"turn":3,"kind":"operation"}'), {
    name: 'timeline.json', kind: 'timeline',
  });
  await sessions.commitBoundary(input.sessionId, {
    operationId: 'operation-message-crash', turnNumber: 3, revision: 1, kind: 'operation',
    checkpoint: { blobId: operationCheckpoint.id, size: operationCheckpoint.size },
    timeline: { blobId: operationTimeline.id, size: operationTimeline.size },
  });
  sessions.requeueInterruptedSession(input.sessionId, 'worker_crashed_after_operation');
  assert.equal(database.prepare('SELECT status FROM session_turns WHERE id = ?').get(resumedTurn.id).status, 'queued');
  assert.equal(database.prepare('SELECT status FROM session_messages WHERE id = ?').get('crash-message-2').status, 'queued');

  sessions.claimNextSession();
  assert.deepEqual(sessions.claimFinish(input.sessionId).messages.map(({ id }) => id), ['crash-message-2']);
  const retriedTurn = sessions.beginTurn(input.sessionId, {
    turnNumber: 3, messageId: 'crash-message-2', mode: 'direct',
  });
  assert.equal(retriedTurn.id, resumedTurn.id);
  const turnCheckpoint = await upload(blobs, origin.device.id, Buffer.from('turn checkpoint'));
  const turnTimeline = await upload(blobs, origin.device.id, Buffer.from('{"turn":3,"kind":"turn"}'), {
    name: 'timeline.json', kind: 'timeline',
  });
  await sessions.commitBoundary(input.sessionId, {
    operationId: 'turn-message-crash', turnNumber: 3, revision: 2, kind: 'turn',
    checkpoint: { blobId: turnCheckpoint.id, size: turnCheckpoint.size },
    timeline: { blobId: turnTimeline.id, size: turnTimeline.size },
  });
  sessions.requeueInterruptedSession(input.sessionId, 'worker_crashed_after_turn_boundary');
  assert.equal(database.prepare('SELECT status FROM session_turns WHERE id = ?').get(resumedTurn.id).status, 'completed');
  assert.equal(database.prepare('SELECT status FROM session_messages WHERE id = ?').get('crash-message-2').status, 'consumed');
  assert.equal(sessions.getSession(input.sessionId).turnsUsed, 3);
});

test('persistent turns expose durable plan waits and reject stale resolutions', async (t) => {
  const { blobs, auth, sessions, database } = await fixture(t);
  const origin = await pairedDevice(auth);
  const paired = await pairedDevice(auth, 'Paired laptop');
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('plan document'));
  const input = parseSessionCreate({
    sessionId: 'session_durable_plan_wait',
    provider: 'codex',
    goal: 'Plan and edit',
    persistent: true,
    clientContext: { threadId: 'thread-plan-wait', documentId: 'document-plan-wait' },
    executionConfig: { model: 'gpt-5.6-sol', effort: 'high', workflow: 'plan', permissionProfile: 'unrestricted' },
    originDocument: { blobId: document.id, name: 'plan.hwpx', size: document.size },
  });
  const created = sessions.createSession(origin.device, input);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'activate_durable_plan_wait', type: 'session.activate', payload: { expectedVersion: created.stateVersion },
  }));
  sessions.claimNextSession();
  const turn = sessions.beginTurn(input.sessionId, { turnNumber: 1, mode: 'plan' });
  const wait = sessions.createWait(input.sessionId, {
    turnNumber: 1,
    kind: 'plan-approval',
    payload: { planId: 'plan-1', plan: { summary: 'Update the title safely.' } },
  });
  assert.equal(wait.status, 'pending');
  assert.equal(sessions.getSession(input.sessionId).currentWait.id, wait.id);
  assert.equal(sessions.getSession(input.sessionId).executionPhase, 'awaiting-plan-approval');

  const resolved = sessions.executeCommand(paired.device, input.sessionId, parseCommand({
    commandId: 'approve_durable_plan_wait',
    type: 'wait.resolve',
    payload: {
      expectedVersion: sessions.getSession(input.sessionId).stateVersion,
      waitId: wait.id,
      action: 'approve',
    },
  }));
  assert.equal(resolved.session.currentWait, null);
  assert.deepEqual(sessions.waitState(input.sessionId, wait.id).resolution, { action: 'approve' });
  assert.throws(() => sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'approve_stale_plan_wait',
    type: 'wait.resolve',
    payload: {
      expectedVersion: sessions.getSession(input.sessionId).stateVersion,
      waitId: wait.id,
      action: 'approve',
    },
  })), { code: 'WAIT_NOT_PENDING' });
  sessions.completeTurn(input.sessionId);
  assert.equal(database.prepare('SELECT status FROM session_turns WHERE id = ?').get(turn.id).status, 'completed');
  const types = sessions.listEvents(input.sessionId, 0).map(({ type }) => type);
  assert.ok(types.includes('turn.started'));
  assert.ok(types.includes('wait.created'));
  assert.ok(types.includes('wait.resolved'));
});

test('follow-up attachment versions are immutable and delivered with their exact message', async (t) => {
  const { blobs, auth, sessions, database } = await fixture(t);
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('attachment document'));
  const first = await upload(blobs, origin.device.id, Buffer.from('attachment version one'), {
    name: 'notes.txt', kind: 'reference', sessionId: 'session_attachment_versions',
  });
  const second = await upload(blobs, origin.device.id, Buffer.from('attachment version two'), {
    name: 'notes.txt', kind: 'reference', sessionId: 'session_attachment_versions',
  });
  const input = parseSessionCreate({
    sessionId: 'session_attachment_versions', provider: 'codex', goal: 'Use follow-up files', persistent: true,
    clientContext: { threadId: 'thread-attachments', documentId: 'document-attachments' },
    originDocument: { blobId: document.id, name: 'attachments.hwpx', size: document.size },
  });
  const created = sessions.createSession(origin.device, input);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'activate_attachment_versions', type: 'session.activate', payload: { expectedVersion: created.stateVersion },
  }));
  sessions.claimNextSession();
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'queue_attachment_version_one', type: 'message.queue', payload: {
      messageId: 'attachment-message-one', content: 'Read version one.', attachments: [{
        attachmentId: 'logical-notes', blobId: first.id, size: first.size, name: 'notes.txt', mimeType: 'text/plain',
      }],
    },
  }));
  const firstDelivery = sessions.claimFinish(input.sessionId).messages[0];
  assert.equal(firstDelivery.attachments[0].version, 1);
  assert.equal(firstDelivery.attachments[0].blobId, first.id);
  sessions.completeTurn(input.sessionId);
  sessions.claimFinish(input.sessionId);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'queue_attachment_version_two', type: 'message.queue', payload: {
      messageId: 'attachment-message-two', content: 'Now read version two.', attachments: [{
        attachmentId: 'logical-notes', blobId: second.id, size: second.size, name: 'notes.txt', mimeType: 'text/plain',
      }],
    },
  }));
  const secondDelivery = sessions.claimFinish(input.sessionId).messages[0];
  assert.equal(secondDelivery.attachments[0].version, 2);
  assert.equal(secondDelivery.attachments[0].blobId, second.id);
  const versions = database.prepare(`
    SELECT version_number AS version, blob_sha256 AS blobId, supersedes_version_id AS supersedes
    FROM session_attachment_versions WHERE session_id = ? ORDER BY version_number
  `).all(input.sessionId);
  assert.deepEqual(versions.map(({ version, blobId }) => ({ version, blobId })), [
    { version: 1, blobId: first.id },
    { version: 2, blobId: second.id },
  ]);
  assert.equal(typeof versions[1].supersedes, 'string');
});

test('an idle persistent room sleeps thirty minutes after the last presence and wakes on reconnect', async (t) => {
  let clock = 1_800_000_000_000;
  const { blobs, auth, sessions } = await fixture(t, { now: () => clock });
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('sleep document'));
  const input = parseSessionCreate({
    sessionId: 'session_presence_sleep', provider: 'codex', goal: 'Wait persistently', persistent: true,
    clientContext: { threadId: 'thread-presence', documentId: 'document-presence' },
    originDocument: { blobId: document.id, name: 'sleep.hwpx', size: document.size },
  });
  const created = sessions.createSession(origin.device, input);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({
    commandId: 'activate_presence_sleep', type: 'session.activate', payload: { expectedVersion: created.stateVersion },
  }));
  sessions.claimNextSession();
  sessions.completeTurn(input.sessionId);
  sessions.claimFinish(input.sessionId);
  sessions.openPresence(input.sessionId, origin.device.id, 'connection-1');
  clock += 60_000;
  sessions.closePresence(input.sessionId, origin.device.id, 'connection-1');
  clock += 29 * 60_000;
  assert.deepEqual(sessions.requestIdleSleeps(), []);
  clock += 60_001;
  assert.deepEqual(sessions.requestIdleSleeps(), [input.sessionId]);
  assert.equal(sessions.workerControl(input.sessionId).sleepRequested, true);
  const sleeping = sessions.acknowledgeSleep(input.sessionId);
  assert.equal(sleeping.status, 'suspended');
  assert.equal(sleeping.suspendedReason.code, 'PRESENCE_SLEEP');
  const waking = sessions.openPresence(input.sessionId, origin.device.id, 'connection-2');
  assert.equal(waking.status, 'queued');
  assert.equal(waking.presence.waking, true);
  assert.ok(sessions.listEvents(input.sessionId, 0).some(({ type }) => type === 'runtime.sleeping'));
  assert.ok(sessions.listEvents(input.sessionId, 0).some(({ type }) => type === 'conversation.waking'));
});

test('session runtime invalidation clears transient display state across worker exits', async (t) => {
  const { blobs, auth, sessions } = await fixture(t);
  const frames = new DisplayFrameStore({ maxSessions: 1 });
  sessions.setRuntimeInvalidationHandler((sessionId) => frames.closeSession(sessionId));
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('display lifecycle document'));
  const start = (sessionId, token) => {
    const created = sessions.createSession(origin.device, parseSessionCreate({
      sessionId,
      provider: 'codex',
      goal: 'Exercise display cleanup',
      originDocument: { blobId: document.id, name: 'display.hwpx', size: document.size },
    }));
    sessions.executeCommand(origin.device, sessionId, parseCommand({
      commandId: `activate-${sessionId}`,
      type: 'session.activate',
      payload: { expectedVersion: created.stateVersion },
    }));
    sessions.claimNextSession();
    sessions.prepareWorker(sessionId, token);
    const workerId = Buffer.from(sessions.getSessionRow(sessionId).worker_token_hash).toString('hex');
    const capability = frames.openStream({ sessionId, workerId, width: 1280, height: 800 });
    return { capability, workerId };
  };

  start('session_display_suspend', 'worker-suspend');
  sessions.suspend('session_display_suspend', { code: 'TEST', message: 'suspend' });
  assert.equal(frames.capability('session_display_suspend'), null);

  start('session_display_requeue', 'worker-requeue');
  sessions.requeueInterruptedSession('session_display_requeue');
  assert.equal(frames.capability('session_display_requeue'), null);
  sessions.suspend('session_display_requeue', { code: 'TEST', message: 'stop requeue' });

  const active = start('session_display_complete', 'worker-complete-one');
  sessions.prepareWorker('session_display_complete', 'worker-complete-two');
  assert.equal(frames.capability('session_display_complete'), null, 'replacement worker closes the old stream');
  const replacementId = Buffer.from(
    sessions.getSessionRow('session_display_complete').worker_token_hash,
  ).toString('hex');
  frames.openStream({
    sessionId: 'session_display_complete', workerId: replacementId, width: 1280, height: 800,
  });
  assert.notEqual(active.workerId, replacementId);
  assert.deepEqual(sessions.claimFinish('session_display_complete'), { ready: true, messages: [] });
  const result = await upload(blobs, origin.device.id, Buffer.from('display lifecycle result'), {
    name: 'result.hwpx', kind: 'result', sessionId: 'session_display_complete',
  });
  sessions.publishResult('session_display_complete', { blobId: result.id, size: result.size });
  assert.equal(frames.capability('session_display_complete'), null);
});

async function persistentRoomFixture(t, options = {}) {
  const fixtureState = await fixture(t, options);
  const { auth, blobs, sessions } = fixtureState;
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('queue regression document'));
  const session = sessions.createSession(origin.device, parseSessionCreate({
    sessionId: 'session_queue_regression', provider: 'codex', goal: 'Finish the original task', persistent: true,
    clientContext: { threadId: 'queue-thread', documentId: 'queue-document' },
    originDocument: { blobId: document.id, name: 'document.hwpx', size: document.size },
  }));
  sessions.executeCommand(origin.device, session.id, parseCommand({
    commandId: 'activate_queue_regression', type: 'session.activate', payload: { expectedVersion: session.stateVersion },
  }));
  sessions.claimNextSession();
  return { ...fixtureState, origin, session };
}

test('queued messages retain acceptance order when clocks tie or move backwards', async (t) => {
  let now = 1_800_000_000_000;
  const { sessions, origin, session } = await persistentRoomFixture(t, { now: () => now });
  for (const messageId of ['z-first', 'a-second', 'b-third']) {
    sessions.executeCommand(origin.device, session.id, parseCommand({
      commandId: `queue_${messageId}`, type: 'message.queue', payload: { messageId, content: messageId },
    }));
    if (messageId === 'a-second') now -= 1_000;
  }
  for (const expected of ['z-first', 'a-second', 'b-third']) {
    assert.equal(sessions.claimFinish(session.id).messages[0].id, expected);
    sessions.completeTurn(session.id);
  }
  assert.equal(sessions.claimFinish(session.id).waiting, true);
});

test('an interrupted initial turn remains runnable before queued follow-ups', async (t) => {
  const { sessions, blobs, origin, session } = await persistentRoomFixture(t);
  sessions.beginTurn(session.id, { turnNumber: 1 });
  const checkpoint = await upload(blobs, origin.device.id, Buffer.from('first operation saved'));
  const timeline = await upload(blobs, origin.device.id, Buffer.from('{"history":"partial first turn"}'), {
    name: 'timeline.json', kind: 'timeline',
  });
  await sessions.commitBoundary(session.id, {
    operationId: 'initial_operation', turnNumber: 1, revision: 1, kind: 'operation',
    checkpoint: { blobId: checkpoint.id, size: checkpoint.size }, timeline: { blobId: timeline.id, size: timeline.size },
  });
  sessions.executeCommand(origin.device, session.id, parseCommand({
    commandId: 'queue_after_initial', type: 'message.queue', payload: { content: 'Then edit the footer' },
  }));
  sessions.requeueInterruptedSession(session.id, 'worker_crash');
  sessions.claimNextSession();
  assert.equal(sessions.workerManifest(session.id).latestCheckpoint.kind, 'operation');
  assert.deepEqual(sessions.claimFinish(session.id).messages, [{
    id: null, content: 'Finish the original task', initial: true,
  }]);
  sessions.beginTurn(session.id, { turnNumber: 1 });
  sessions.completeTurn(session.id);
  assert.equal(sessions.claimFinish(session.id).messages[0].content, 'Then edit the footer');
});

test('stopping a waiting turn cancels its durable decision and rejects blank inputs', async (t) => {
  const { sessions, origin, session } = await persistentRoomFixture(t);
  sessions.beginTurn(session.id, { turnNumber: 1 });
  const wait = sessions.createWait(session.id, { turnNumber: 1, kind: 'question', payload: { question: 'Which title?' } });
  sessions.completeTurn(session.id, { outcome: 'redirected' });
  assert.equal(sessions.waitState(session.id, wait.id).status, 'cancelled');
  for (const type of ['message.queue', 'turn.redirect']) {
    assert.throws(() => sessions.executeCommand(origin.device, session.id, parseCommand({
      commandId: `blank_${type}`, type, payload: { content: ' \n\t ' },
    })), { code: 'INVALID_REQUEST' });
  }
});

test('retrying a committed turn completion does not consume another turn', async (t) => {
  const { sessions, blobs, origin, session } = await persistentRoomFixture(t);
  sessions.beginTurn(session.id, { turnNumber: 1 });
  const checkpoint = await upload(blobs, origin.device.id, Buffer.from('completed turn document'));
  const timeline = await upload(blobs, origin.device.id, Buffer.from('{"history":"completed turn"}'), {
    name: 'timeline.json', kind: 'timeline',
  });
  await sessions.commitBoundary(session.id, {
    operationId: 'completed_turn_boundary', turnNumber: 1, revision: 1, kind: 'turn',
    checkpoint: { blobId: checkpoint.id, size: checkpoint.size }, timeline: { blobId: timeline.id, size: timeline.size },
  });
  const completion = { outcome: 'completed', boundaryOperationId: 'completed_turn_boundary' };
  const first = sessions.completeTurn(session.id, completion);
  assert.deepEqual(sessions.completeTurn(session.id, completion), first);
  assert.equal(sessions.getSession(session.id).turnsUsed, 1);
  assert.throws(() => sessions.completeTurn(session.id, { ...completion, outcome: 'redirected' }), {
    code: 'TURN_IDENTITY_CONFLICT',
  });
});

test('question workflows remain read-only mode through creation, dispatch, and durable turns', async (t) => {
  const { sessions, session, origin } = await persistentRoomFixture(t);
  const createdInput = parseSessionCreate({
    sessionId: 'question_protocol', provider: 'codex', goal: 'Explain the document', persistent: true,
    clientContext: { threadId: 'question-thread', documentId: 'question-document' },
    originDocument: { blobId: session.originDocument.sha256, name: 'document.hwpx', size: session.originDocument.size },
    executionConfig: { model: 'gpt-5.6-sol', effort: 'high', permissionProfile: 'unrestricted', workflow: 'question' },
  });
  assert.equal(createdInput.executionConfig.workflow, 'question');
  sessions.claimFinish(session.id);
  sessions.executeCommand(origin.device, session.id, parseCommand({
    commandId: 'switch_to_question', type: 'conversation.workflow',
    payload: { expectedVersion: sessions.getSession(session.id).stateVersion, workflow: 'question' },
  }));
  assert.equal(sessions.workerManifest(session.id).executionConfig.workflow, 'question');
  assert.equal(sessions.claimFinish(session.id).workflow, 'question');
  assert.equal(sessions.beginTurn(session.id, { turnNumber: 1, mode: 'question' }).mode, 'question');
  const wait = sessions.createWait(session.id, { turnNumber: 1, kind: 'question', payload: { question: 'Which section?' } });
  assert.equal(sessions.waitState(session.id, wait.id).status, 'pending');
});

test('question workflow migration preserves active turns and pending decisions with foreign keys enabled', async (t) => {
  const { sessions, session, database } = await persistentRoomFixture(t);
  const turn = sessions.beginTurn(session.id, { turnNumber: 1, mode: 'plan' });
  const wait = sessions.createWait(session.id, { turnNumber: 1, kind: 'plan-approval', payload: { planId: 'existing-plan' } });
  const migration = await fs.readFile(path.resolve(import.meta.dirname, '../migrations/013_question_workflow.sql'), 'utf8');
  database.exec('BEGIN IMMEDIATE');
  database.exec(migration);
  database.exec('COMMIT');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(sessions.getSession(session.id).currentTurnId, turn.id);
  assert.equal(sessions.waitState(session.id, wait.id).status, 'pending');
  assert.equal(sessions.waitState(session.id, wait.id).payload.planId, 'existing-plan');
  sessions.completeTurn(session.id, { outcome: 'stopped' });
  assert.equal(sessions.beginTurn(session.id, { turnNumber: 2, mode: 'question' }).mode, 'question');
});


test('provider changes checkpoint and restart the same room without losing queued messages or history', async (t) => {
  let now = 1_800_000_000_000;
  const { sessions, blobs, database, origin, session } = await persistentRoomFixture(t, { now: () => now });
  sessions.beginTurn(session.id, { turnNumber: 1 });
  sessions.completeTurn(session.id);
  sessions.claimFinish(session.id);
  const originalVersion = sessions.getSession(session.id).stateVersion;
  sessions.setProviderStatus('claude', { available: true, authenticated: true });
  const command = parseCommand({
    commandId: 'configure_claude_high', type: 'conversation.configure',
    payload: { expectedVersion: originalVersion, provider: 'claude', model: 'sonnet', effort: 'high' },
  });
  const selected = sessions.executeCommand(origin.device, session.id, command);
  assert.equal(selected.session.provider, 'claude');
  assert.equal(selected.session.configurationPending, true);
  assert.deepEqual(selected.session.executionConfig, {
    model: 'sonnet', effort: 'high', workflow: 'direct', permissionProfile: 'unrestricted',
  });
  assert.deepEqual(sessions.executeCommand(origin.device, session.id, command), selected);
  assert.throws(() => sessions.executeCommand(origin.device, session.id, {
    ...command, commandId: 'configure_stale_device',
  }), { code: 'STATE_VERSION_CONFLICT' });
  sessions.executeCommand(origin.device, session.id, parseCommand({
    commandId: 'queue_after_configuration', type: 'message.queue', payload: { messageId: 'after-switch', content: 'Continue our earlier discussion' },
  }));
  assert.deepEqual(sessions.claimFinish(session.id), { ready: false, messages: [], configurationRestartRequested: true });
  assert.throws(() => sessions.beginTurn(session.id, { turnNumber: 2, messageId: 'after-switch' }), { code: 'INVALID_SESSION_STATE' });
  assert.throws(() => sessions.acknowledgeConfigurationRestart(session.id), { code: 'CHECKPOINT_REQUIRED' });
  now++;
  const edited = await upload(blobs, origin.device.id, Buffer.from('latest manual edits'), { kind: 'result', sessionId: session.id });
  const transcript = await upload(blobs, origin.device.id, Buffer.from('earlier conversation'), { kind: 'timeline', name: 'timeline.json', sessionId: session.id });
  await sessions.commitBoundary(session.id, {
    operationId: 'configure_boundary_1', turnNumber: 1, revision: 1, kind: 'operation',
    checkpoint: { blobId: edited.id, size: edited.size }, timeline: { blobId: transcript.id, size: transcript.size },
  });
  const restarted = sessions.acknowledgeConfigurationRestart(session.id);
  assert.equal(restarted.status, 'queued');
  assert.equal(restarted.id, session.id);
  assert.equal(restarted.turnsUsed, 1);
  assert.deepEqual(restarted.clientContext, session.clientContext);
  assert.equal(sessions.claimNextSession().provider, 'claude');
  const manifest = sessions.workerManifest(session.id);
  assert.equal(manifest.latestCheckpoint.blobId, edited.id);
  assert.equal(manifest.resources.find((item) => item.kind === 'timeline').blobId, transcript.id);
  assert.equal(manifest.executionConfig.model, 'sonnet');
  const next = sessions.claimFinish(session.id).messages[0];
  assert.equal(next.id, 'after-switch');
  sessions.beginTurn(session.id, { turnNumber: 2, messageId: next.id });
  sessions.completeTurn(session.id);
  assert.equal(database.prepare('SELECT status FROM session_messages WHERE id = ?').get(next.id).status, 'consumed');
});

test('provider configuration rejects busy, unconnected, invalid and overlapping choices before changing state', async (t) => {
  const { sessions, origin, session } = await persistentRoomFixture(t);
  let seq = 0;
  const configure = (selection) => sessions.executeCommand(origin.device, session.id, parseCommand({
    commandId: `configuration_case_${++seq}`, type: 'conversation.configure',
    payload: { expectedVersion: sessions.getSession(session.id).stateVersion, provider: 'codex', model: 'gpt-5.6-sol', effort: 'high', ...selection },
  }));
  sessions.beginTurn(session.id, { turnNumber: 1 });
  assert.throws(() => configure({}), { code: 'INVALID_SESSION_STATE' });
  sessions.createWait(session.id, { turnNumber: 1, kind: 'question', payload: { question: 'Continue?' } });
  assert.throws(() => configure({}), { code: 'INVALID_SESSION_STATE' });
  sessions.completeTurn(session.id, { outcome: 'stopped' });
  sessions.claimFinish(session.id);
  const before = sessions.getSession(session.id);
  for (const [selection, code] of [
    [{ provider: 'unknown' }, 'INVALID_PROVIDER'],
    [{ provider: 'claude', model: 'sonnet' }, 'PROVIDER_UNAVAILABLE'],
    [{ model: 'sonnet' }, 'INVALID_MODEL'],
    [{ effort: 'ultra' }, 'INVALID_EFFORT'],
    [{ model: '--unsafe-option' }, 'INVALID_REQUEST'],
    [{ provider: 'cursor', model: 'auto', effort: 'high' }, 'INVALID_EFFORT'],
    [{ provider: 'claude', model: 'haiku', effort: 'max' }, 'INVALID_EFFORT'],
  ]) {
    assert.throws(() => configure(selection), { code });
    assert.deepEqual(sessions.getSession(session.id), before);
  }
  configure({ model: 'gpt-5.6-luna', effort: 'low' });
  assert.throws(() => configure({ model: 'gpt-6-astra', effort: 'max' }), { code: 'INVALID_SESSION_STATE' });
  // A crash between acceptance and the save/ack path still starts the chosen provider.
  sessions.requeueInterruptedSession(session.id);
  sessions.claimNextSession();
  assert.equal(sessions.getSession(session.id).configurationPending, false);
  assert.equal(sessions.workerManifest(session.id).executionConfig.model, 'gpt-5.6-luna');
});

test('End on the final allowed turn publishes instead of stranding the ending room at its turn limit', async (t) => {
  const { sessions, blobs, origin, session, database } = await persistentRoomFixture(t);
  database.prepare('UPDATE sessions SET max_turns = 1 WHERE id = ?').run(session.id);
  sessions.beginTurn(session.id, { turnNumber: 1 });
  sessions.executeCommand(origin.device, session.id, parseCommand({
    commandId: 'end_final_turn', type: 'session.end', payload: { expectedVersion: sessions.getSession(session.id).stateVersion },
  }));
  assert.equal(sessions.completeTurn(session.id, { outcome: 'stopped' }).status, 'running');
  assert.equal(sessions.claimFinish(session.id).ready, true);
  const result = await upload(blobs, origin.device.id, Buffer.from('last allowed turn checkpoint'));
  const completed = sessions.publishResult(session.id, { blobId: result.id, size: result.size });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.roomStatus, 'archived');
});

for (const messageId of [null, 'unfinished_followup']) {
  test(`active pause preserves ${messageId ? 'the follow-up' : 'the initial goal'} for Resume`, async (t) => {
    const { sessions, blobs, origin, session, database } = await persistentRoomFixture(t);
    if (messageId) {
      sessions.executeCommand(origin.device, session.id, parseCommand({
        commandId: 'queue_unfinished', type: 'message.queue', payload: { messageId, content: 'Finish the footer' },
      }));
      sessions.claimFinish(session.id);
    }
    sessions.beginTurn(session.id, { turnNumber: 1, messageId });
    const wait = sessions.createWait(session.id, { turnNumber: 1, kind: 'question', payload: { question: 'Which date?' } });
    const checkpoint = await upload(blobs, origin.device.id, Buffer.from('partial edit before pause'));
    const timeline = await upload(blobs, origin.device.id, Buffer.from('{"history":"unfinished"}'), { name: 'timeline.json', kind: 'timeline' });
    await sessions.commitBoundary(session.id, {
      operationId: 'paused_operation', turnNumber: 1, revision: 1, kind: 'operation',
      checkpoint: { blobId: checkpoint.id, size: checkpoint.size }, timeline: { blobId: timeline.id, size: timeline.size },
    });
    const command = (type) => sessions.executeCommand(origin.device, session.id, parseCommand({
      commandId: type.replace('.', '_'), type, payload: { expectedVersion: sessions.getSession(session.id).stateVersion },
    }));
    command('session.pause');
    sessions.acknowledgePause(session.id);
    assert.equal(sessions.waitState(session.id, wait.id).status, 'cancelled');
    assert.equal(database.prepare('SELECT status FROM session_turns WHERE session_id = ?').get(session.id).status, 'queued');
    command('session.resume');
    sessions.claimNextSession();
    const manifest = sessions.workerManifest(session.id);
    assert.equal(manifest.latestCheckpoint.blobId, checkpoint.id);
    assert.equal(manifest.latestCheckpoint.kind, 'operation');
    assert.equal(manifest.limits.turnsUsed, 0);
    const pending = sessions.claimFinish(session.id).messages;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, messageId);
    assert.equal(pending[0].content, messageId ? 'Finish the footer' : 'Finish the original task');
    assert.equal(sessions.beginTurn(session.id, { turnNumber: 1, messageId }).status, 'running');
  });
}

test('merge recovery selects the last completed turn while a later operation is still in progress', async (t) => {
  const { blobs, auth, sessions } = await fixture(t);
  const origin = await pairedDevice(auth);
  sessions.setProviderStatus('codex', { available: true, version: '1' });
  const document = await upload(blobs, origin.device.id, Buffer.from('origin'));
  const timeline = await upload(blobs, origin.device.id, Buffer.from('{"turn":0}'), { name: 'timeline.json', kind: 'timeline' });
  const input = parseSessionCreate({ sessionId: 'session_merge_turn_filter', provider: 'codex', goal: 'Merge finished turns',
    originDocument: { blobId: document.id, name: 'document.hwpx', size: document.size }, timeline: { blobId: timeline.id, size: timeline.size } });
  sessions.createSession(origin.device, input);
  sessions.executeCommand(origin.device, input.sessionId, parseCommand({ commandId: 'activate_merge_turn_filter', type: 'session.activate', payload: { expectedVersion: 1 } }));
  sessions.claimNextSession();
  sessions.prepareWorker(input.sessionId, 'ra_wt_merge_turn_filter');
  for (const [revision, kind] of [[1, 'turn'], [2, 'operation']]) {
    const checkpoint = await upload(blobs, origin.device.id, Buffer.from(`revision ${revision}`));
    await sessions.commitBoundary(input.sessionId, { operationId: `merge-revision-${revision}`, turnNumber: revision, revision, kind,
      checkpoint: { blobId: checkpoint.id, size: checkpoint.size }, timeline: { blobId: timeline.id, size: timeline.size } });
  }
  assert.equal(sessions.latestStableCheckpoint(input.sessionId).revision, 2);
  assert.equal(sessions.latestStableCheckpoint(input.sessionId, null, 'turn').operationId, 'merge-revision-1');
  assert.throws(() => sessions.latestStableCheckpoint(input.sessionId, 'merge-revision-2', 'turn'), { code: 'CHECKPOINT_NOT_FOUND' });
  assert.throws(() => sessions.latestStableCheckpoint(input.sessionId, null, 'untrusted'), { code: 'INVALID_CHECKPOINT_KIND' });
});

for (const control of ['end', 'pause', 'redirect']) {
  for (const stage of ['Studio startup', 'turn-start request']) {
    test(`${control} during ${stage} resolves through the durable control gate`, async (t) => {
      const { root, sessions, blobs, origin, session, database } = await persistentRoomFixture(t);
      database.prepare('UPDATE sessions SET max_turns = ? WHERE id = ?').run(control === 'redirect' ? 3 : 1, session.id);
      const workspace = path.join(root, 'runtime');
      await fs.mkdir(workspace);
      const documentPath = path.join(workspace, 'document.hwpx');
      const timelinePath = path.join(workspace, 'input-timeline.json');
      await fs.writeFile(documentPath, 'document before startup control');
      await fs.writeFile(timelinePath, '{}');
      const manifest = {
        ...sessions.workerManifest(session.id),
        resources: [
          { kind: 'document', name: 'document.hwpx', filename: documentPath },
          { kind: 'timeline', name: 'timeline.json', filename: timelinePath },
        ],
      };
      assert.equal(manifest.endRequested, false, 'the runtime starts with the pre-control manifest');
      let requested = false;
      let providerCalls = 0;
      let documentBytes = 'document before startup control';
      const command = (type, payload = {}) => sessions.executeCommand(origin.device, session.id, parseCommand({
        commandId: `${type.replace('.', '_')}_${sessions.getSession(session.id).stateVersion}`,
        type, payload: { expectedVersion: sessions.getSession(session.id).stateVersion, ...payload },
      }));
      const requestControl = () => {
        if (requested) return;
        requested = true;
        command(control === 'redirect' ? 'turn.redirect' : `session.${control}`, control === 'redirect'
          ? { messageId: 'startup-redirect', content: 'Use the replacement instruction' } : {});
      };
      const result = await runSession({
        manifest, workspace, credentials: {},
        client: {
          event: async () => {},
          beginTurn: async (turn) => {
            if (stage === 'turn-start request') requestControl();
            return sessions.beginTurn(session.id, turn);
          },
          control: async () => sessions.workerControl(session.id),
          completeTurn: async (completion) => sessions.completeTurn(session.id, completion),
          finishClaim: async () => sessions.claimFinish(session.id),
          pauseAck: async () => sessions.acknowledgePause(session.id),
          upload: async (filename, options) => upload(blobs, origin.device.id, await fs.readFile(filename), options),
          commitBoundary: async (boundary) => sessions.commitBoundary(session.id, boundary),
        },
        createHarness: async () => ({
          start: async () => { if (stage === 'Studio startup') requestControl(); },
          close: async () => {},
          documentRevision: async () => 0,
          runTurn: async (prompt, { readControl }) => {
            providerCalls += 1;
            assert.notEqual(control, 'end', 'End must not dispatch a provider after turn-start is refused');
            const pending = await readControl();
            if (pending.pauseRequested) return { stopReason: 'interrupted', stopped: true };
            if (pending.redirectRequested) return { stopReason: 'interrupted', redirected: true };
            assert.match(prompt, /Use the replacement instruction/);
            documentBytes = 'document from replacement instruction';
            command('session.end');
            return { stopReason: 'end_turn' };
          },
          exportDocument: async (_format, filename) => {
            const bytes = Buffer.from(documentBytes);
            await fs.writeFile(filename, bytes);
            return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
          },
        }),
      });
      assert.equal(requested, true);
      const turns = database.prepare(`
        SELECT status, outcome FROM session_turns WHERE session_id = ? ORDER BY turn_number
      `).all(session.id);
      if (control === 'pause') {
        assert.equal(result.paused, true);
        assert.equal(providerCalls, 1);
        assert.equal(sessions.getSession(session.id).turnsUsed, 0);
        assert.deepEqual(turns.map(({ status }) => status), ['queued']);
        command('session.resume');
        sessions.claimNextSession();
        assert.equal(sessions.claimFinish(session.id).messages[0].content, manifest.goal);
      } else {
        assert.equal(await fs.readFile(result.resultPath, 'utf8'), documentBytes);
        const resultBlob = await upload(blobs, origin.device.id, await fs.readFile(result.resultPath));
        const completed = sessions.publishResult(session.id, { blobId: resultBlob.id, size: resultBlob.size });
        assert.equal(completed.status, 'completed');
        assert.equal(completed.roomStatus, 'archived');
        assert.equal(completed.turnsUsed, control === 'end' ? 0 : 2);
        assert.equal(providerCalls, control === 'end' ? 0 : 2);
        assert.deepEqual(turns.map(({ outcome }) => outcome), control === 'end' ? [] : ['redirected', 'completed']);
        if (control === 'end') assert.equal(sessions.latestStableBoundary(session.id).turnNumber, 0);
      }
    });
  }
}

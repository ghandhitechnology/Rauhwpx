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
import { parseCommand, parseSessionCreate, parseUploadInit } from '../src/protocol.mjs';
import { SessionStore } from '../src/session-store.mjs';

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
    migrationVersion: 11,
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
  legacy.close();

  const upgraded = openDatabase(filename);
  t.after(() => upgraded.close());
  assert.equal(databasePragmas(upgraded).migrationVersion, 11);
  assert.equal(upgraded.prepare(`SELECT next_event_seq FROM sessions WHERE id = 'session'`).get().next_event_seq, 8);
  assert.equal(upgraded.prepare(`SELECT name FROM session_resources WHERE session_id = 'session'`).get().name, 'doc.hwp');
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

ALTER TABLE sessions ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN room_status TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE sessions ADD COLUMN execution_phase TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE sessions ADD COLUMN current_turn_id TEXT;
ALTER TABLE sessions ADD COLUMN current_wait_id TEXT;
ALTER TABLE sessions ADD COLUMN end_requested_at INTEGER;
ALTER TABLE sessions ADD COLUMN redirect_requested_at INTEGER;
ALTER TABLE sessions ADD COLUMN redirect_message_id TEXT;
ALTER TABLE sessions ADD COLUMN last_presence_at INTEGER;
ALTER TABLE sessions ADD COLUMN sleep_requested_at INTEGER;

ALTER TABLE session_events ADD COLUMN event_id TEXT;
ALTER TABLE session_events ADD COLUMN turn_id TEXT;
ALTER TABLE session_events ADD COLUMN payload_blob_sha256 TEXT;

ALTER TABLE session_checkpoints ADD COLUMN boundary_kind TEXT NOT NULL DEFAULT 'turn'
  CHECK(boundary_kind IN ('handoff', 'operation', 'turn'));

UPDATE session_checkpoints SET boundary_kind = 'handoff' WHERE turn_number = 0;

CREATE UNIQUE INDEX session_events_idempotency
  ON session_events(session_id, event_id)
  WHERE event_id IS NOT NULL;

CREATE UNIQUE INDEX sessions_active_room_identity
  ON sessions(client_document_id, client_thread_id)
  WHERE protocol_version = 2 AND room_status IN ('active', 'ending');

CREATE TABLE session_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  message_id TEXT REFERENCES session_messages(id),
  mode TEXT NOT NULL CHECK(mode IN ('direct', 'plan')),
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'running', 'waiting', 'checkpointing',
    'completed', 'stopped', 'redirected', 'failed'
  )),
  stable_boundary_operation_id TEXT,
  outcome TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, turn_number),
  UNIQUE(session_id, message_id)
) STRICT;

CREATE INDEX session_turns_session_status
  ON session_turns(session_id, status, turn_number);

CREATE TABLE session_waits (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN (
    'plan-approval', 'question', 'external-side-effect', 'destructive-external'
  )),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'resolved', 'cancelled')),
  resolution_json TEXT,
  resolved_by_device_id TEXT REFERENCES devices(id),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
) STRICT;

CREATE UNIQUE INDEX session_waits_one_pending_turn
  ON session_waits(turn_id)
  WHERE status = 'pending';

CREATE TABLE session_attachment_versions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  supersedes_version_id TEXT REFERENCES session_attachment_versions(id),
  blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  size INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  created_by_device_id TEXT NOT NULL REFERENCES devices(id),
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, attachment_id, version_number)
) STRICT;

CREATE TABLE session_message_attachments (
  message_id TEXT NOT NULL REFERENCES session_messages(id) ON DELETE CASCADE,
  attachment_version_id TEXT NOT NULL REFERENCES session_attachment_versions(id),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(message_id, ordinal),
  UNIQUE(message_id, attachment_version_id)
) STRICT;

CREATE TABLE session_presence (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, device_id, connection_id)
) STRICT;

CREATE INDEX session_presence_expiry ON session_presence(last_seen_at);

CREATE TABLE session_runtime_leases (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  document_id TEXT,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('warm', 'releasing')),
  acquired_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX session_runtime_one_warm_document
  ON session_runtime_leases(document_id)
  WHERE status = 'warm' AND document_id IS NOT NULL;

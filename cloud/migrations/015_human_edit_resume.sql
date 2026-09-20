ALTER TABLE sessions ADD COLUMN latest_human_edit_id TEXT;
ALTER TABLE sessions ADD COLUMN paused_writer_generation INTEGER;

CREATE TABLE session_human_edits (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL REFERENCES commands(id),
  from_operation_id TEXT NOT NULL,
  from_revision INTEGER NOT NULL,
  to_operation_id TEXT NOT NULL,
  to_revision INTEGER NOT NULL,
  blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  size INTEGER NOT NULL,
  change_summary TEXT,
  created_by_device_id TEXT NOT NULL REFERENCES devices(id),
  paused_state_version INTEGER NOT NULL,
  writer_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, to_operation_id)
) STRICT;

CREATE INDEX session_human_edits_session_created
  ON session_human_edits(session_id, created_at DESC);

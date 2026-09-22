-- Preserve durable turns and decisions while allowing read-only question turns.
CREATE TABLE session_turns_workflows (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  message_id TEXT REFERENCES session_messages(id),
  mode TEXT NOT NULL CHECK(mode IN ('direct', 'plan', 'question')),
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

CREATE INDEX session_turns_workflows_status
  ON session_turns_workflows(session_id, status, turn_number);

CREATE TABLE session_waits_workflows (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES session_turns_workflows(id) ON DELETE CASCADE,
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

CREATE UNIQUE INDEX session_waits_workflows_pending
  ON session_waits_workflows(turn_id)
  WHERE status = 'pending';

INSERT INTO session_turns_workflows SELECT * FROM session_turns;
INSERT INTO session_waits_workflows SELECT * FROM session_waits;
DROP TABLE session_waits;
DROP TABLE session_turns;
ALTER TABLE session_turns_workflows RENAME TO session_turns;
ALTER TABLE session_waits_workflows RENAME TO session_waits;
DROP INDEX session_turns_workflows_status;
DROP INDEX session_waits_workflows_pending;
CREATE INDEX session_turns_session_status ON session_turns(session_id, status, turn_number);
CREATE UNIQUE INDEX session_waits_one_pending_turn ON session_waits(turn_id) WHERE status = 'pending';

ALTER TABLE sessions ADD COLUMN execution_config_json TEXT;
ALTER TABLE sessions ADD COLUMN next_event_seq INTEGER NOT NULL DEFAULT 1;

UPDATE sessions
SET next_event_seq = COALESCE(
  (SELECT MAX(seq) + 1 FROM session_events WHERE session_events.session_id = sessions.id),
  1
);

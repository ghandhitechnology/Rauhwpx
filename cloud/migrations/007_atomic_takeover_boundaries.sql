ALTER TABLE sessions ADD COLUMN takeover_requested_at INTEGER;
ALTER TABLE sessions ADD COLUMN takeover_requested_by TEXT REFERENCES devices(id);
ALTER TABLE sessions ADD COLUMN frozen_checkpoint_operation_id TEXT;

ALTER TABLE session_checkpoints ADD COLUMN timeline_blob_sha256 TEXT;
ALTER TABLE session_checkpoints ADD COLUMN timeline_size INTEGER;

INSERT INTO session_checkpoints(
  session_id, operation_id, turn_number, revision, blob_sha256, stable,
  timeline_blob_sha256, timeline_size, created_at
)
SELECT
  sessions.id,
  'migration-handoff:' || sessions.id,
  0,
  0,
  sessions.origin_sha256,
  1,
  timeline.sha256,
  timeline.size,
  sessions.created_at
FROM sessions
LEFT JOIN session_resources AS timeline
  ON timeline.session_id = sessions.id AND timeline.kind = 'timeline'
WHERE NOT EXISTS (
  SELECT 1 FROM session_checkpoints
  WHERE session_checkpoints.session_id = sessions.id
    AND session_checkpoints.operation_id = 'migration-handoff:' || sessions.id
);

UPDATE blobs
SET ref_count = ref_count + (
  SELECT COUNT(*)
  FROM session_checkpoints
  WHERE session_checkpoints.operation_id LIKE 'migration-handoff:%'
    AND session_checkpoints.blob_sha256 = blobs.sha256
) + (
  SELECT COUNT(*)
  FROM session_checkpoints
  WHERE session_checkpoints.operation_id LIKE 'migration-handoff:%'
    AND session_checkpoints.timeline_blob_sha256 = blobs.sha256
);

CREATE INDEX checkpoints_session_boundary
  ON session_checkpoints(session_id, stable, created_at, revision);

ALTER TABLE session_messages ADD COLUMN queue_sequence INTEGER NOT NULL DEFAULT 0;

-- Existing row order preserves acceptance order even when clocks tie or move backwards.
UPDATE session_messages SET queue_sequence = rowid;
CREATE UNIQUE INDEX session_messages_queue_sequence
  ON session_messages(session_id, queue_sequence);

-- New messages use the next durable room event sequence as their queue position.
UPDATE sessions SET next_event_seq = MAX(next_event_seq,
  COALESCE((SELECT MAX(queue_sequence) + 1 FROM session_messages WHERE session_id = sessions.id), 1));

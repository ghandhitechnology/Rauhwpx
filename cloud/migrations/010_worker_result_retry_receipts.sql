CREATE TABLE worker_result_retry_receipts (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL,
  blob_sha256 TEXT NOT NULL CHECK(length(blob_sha256) = 64),
  size INTEGER NOT NULL,
  retry_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX worker_result_retry_receipts_expiry
  ON worker_result_retry_receipts(retry_until);

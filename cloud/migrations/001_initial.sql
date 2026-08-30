CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE TABLE pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash BLOB NOT NULL,
  salt BLOB NOT NULL,
  created_by_device_id TEXT REFERENCES devices(id),
  intended_name TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE token_families (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE refresh_tokens (
  family_id TEXT NOT NULL REFERENCES token_families(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  token_hash BLOB NOT NULL UNIQUE,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (family_id, generation)
) STRICT;

CREATE TABLE access_tokens (
  token_hash BLOB PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  family_id TEXT NOT NULL REFERENCES token_families(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0,
  sensitive INTEGER NOT NULL DEFAULT 1 CHECK(sensitive IN (0, 1)),
  expires_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  session_id TEXT,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  size INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  temp_path TEXT NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(device_id, sha256, size, session_id, kind)
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  origin_device_id TEXT NOT NULL REFERENCES devices(id),
  client_thread_id TEXT,
  client_document_id TEXT,
  provider TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 1,
  origin_name TEXT NOT NULL,
  origin_sha256 TEXT NOT NULL CHECK(length(origin_sha256) = 64),
  origin_size INTEGER NOT NULL,
  max_duration_seconds INTEGER NOT NULL,
  max_turns INTEGER NOT NULL,
  turns_used INTEGER NOT NULL DEFAULT 0,
  sandbox_id TEXT,
  worker_token_hash BLOB,
  worker_heartbeat_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  suspended_reason TEXT,
  result_sha256 TEXT,
  result_size INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE session_resources (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY(session_id, sha256, kind)
) STRICT;

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE session_events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, seq)
) STRICT;

CREATE TABLE provider_status (
  provider TEXT PRIMARY KEY,
  available INTEGER NOT NULL CHECK(available IN (0, 1)),
  authenticated INTEGER NOT NULL DEFAULT 0 CHECK(authenticated IN (0, 1)),
  version TEXT,
  error_code TEXT,
  error_message TEXT,
  setup_action TEXT,
  checked_at INTEGER NOT NULL
) STRICT;

CREATE TABLE provider_credentials (
  provider TEXT NOT NULL,
  credential_name TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(provider, credential_name)
) STRICT;

CREATE TABLE result_downloads (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id),
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  confirmed_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, device_id)
) STRICT;

CREATE TABLE session_checkpoints (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  stable INTEGER NOT NULL CHECK(stable IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, operation_id)
) STRICT;

CREATE TABLE session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id),
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
) STRICT;

CREATE TABLE service_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_status_created ON sessions(status, created_at);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX events_session_seq ON session_events(session_id, seq);
CREATE INDEX access_tokens_expiry ON access_tokens(expires_at);
CREATE INDEX uploads_updated ON uploads(updated_at);
CREATE INDEX service_logs_created ON service_logs(created_at);
CREATE INDEX checkpoints_session_created ON session_checkpoints(session_id, created_at);
CREATE INDEX messages_session_status ON session_messages(session_id, status, created_at);

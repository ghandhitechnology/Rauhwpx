ALTER TABLE session_resources RENAME TO session_resources_before_resource_names;

CREATE TABLE session_resources (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY(session_id, sha256, kind, name)
) STRICT;

INSERT INTO session_resources(session_id, sha256, name, kind, size)
SELECT session_id, sha256, name, kind, size
FROM session_resources_before_resource_names;

DROP TABLE session_resources_before_resource_names;

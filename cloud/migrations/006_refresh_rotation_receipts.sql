ALTER TABLE refresh_tokens ADD COLUMN activated_at INTEGER;
ALTER TABLE access_tokens ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

UPDATE access_tokens
SET generation = COALESCE(
  (SELECT MAX(refresh_tokens.generation)
   FROM refresh_tokens
   WHERE refresh_tokens.family_id = access_tokens.family_id),
  0
);

CREATE TABLE refresh_rotation_receipts (
  previous_token_hash BLOB PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES token_families(id) ON DELETE CASCADE,
  successor_generation INTEGER NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  retry_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX refresh_rotation_receipts_expiry ON refresh_rotation_receipts(retry_until);

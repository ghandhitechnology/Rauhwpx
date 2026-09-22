CREATE TABLE pairing_redemption_receipts (
  request_id TEXT PRIMARY KEY,
  code_seek BLOB NOT NULL,
  device_name TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  retry_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX pairing_redemption_receipts_expiry
  ON pairing_redemption_receipts(retry_until);

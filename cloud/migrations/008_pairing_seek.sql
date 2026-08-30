-- Pairing redemption used to hash up to 20 argon2id candidates per request on
-- an unauthenticated route. A deterministic seek column makes verification a
-- single indexed lookup; legacy rows (seek IS NULL) keep the slow path until
-- their 10 minute expiry prunes them.
ALTER TABLE pairing_codes ADD COLUMN code_seek BLOB;
CREATE INDEX pairing_codes_seek ON pairing_codes(code_seek);

-- Adds account ownership to devices (protocol v2). Idempotent-ish: run once.
ALTER TABLE devices ADD COLUMN owner_user_id TEXT;

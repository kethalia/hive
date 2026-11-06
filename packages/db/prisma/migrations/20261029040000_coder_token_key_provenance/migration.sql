-- Only keys positively identified at Hive creation may be revoked by rotation.
-- Existing encrypted credentials deliberately retain unknown provenance.
ALTER TABLE "coder_tokens" ADD COLUMN "remote_key_id" TEXT;

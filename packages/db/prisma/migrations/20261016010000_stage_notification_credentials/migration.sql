ALTER TABLE "notification_sources"
  ADD COLUMN "pending_token_hash" TEXT,
  ADD COLUMN "credential_generation" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "notification_sources_pending_token_hash_key" ON "notification_sources"("pending_token_hash");

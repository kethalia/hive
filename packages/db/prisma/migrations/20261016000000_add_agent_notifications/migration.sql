ALTER TABLE "push_subscriptions" ADD COLUMN "preferences" JSONB NOT NULL DEFAULT '{}';
CREATE TABLE "notification_sources" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "workspace_name" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "notification_sources_token_hash_key" ON "notification_sources"("token_hash");
CREATE UNIQUE INDEX "notification_sources_user_id_workspace_id_key" ON "notification_sources"("user_id", "workspace_id");
-- One browser endpoint must never remain subscribed to multiple accounts.
DELETE FROM "push_subscriptions" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "endpoint" ORDER BY "created_at" DESC, "id" DESC) AS ordinal
    FROM "push_subscriptions"
  ) ranked WHERE ordinal > 1
);
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- Preserve legacy users, UUID sessions and encrypted Coder credentials while
-- adding Better Auth's OAuth account and verification storage.
BEGIN;

ALTER TABLE "users"
  ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "image" TEXT,
  ADD COLUMN "auth_mode" TEXT NOT NULL DEFAULT 'legacy',
  ADD CONSTRAINT "users_auth_mode_check" CHECK (auth_mode IN ('legacy', 'oauth'));

ALTER TABLE "sessions"
  ADD COLUMN "auth_token" TEXT,
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "ip_address" TEXT,
  ADD COLUMN "user_agent" TEXT;
CREATE UNIQUE INDEX "sessions_auth_token_key" ON "sessions"("auth_token");

CREATE TABLE "coder_oauth_accounts" (
  "id" UUID NOT NULL,
  "account_id" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "access_token" TEXT,
  "refresh_token" TEXT,
  "id_token" TEXT,
  "password" TEXT,
  "access_token_expires_at" TIMESTAMPTZ,
  "refresh_token_expires_at" TIMESTAMPTZ,
  "scope" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  "refresh_state" TEXT NOT NULL DEFAULT 'idle',
  "refresh_holder" UUID,
  "refresh_until" TIMESTAMPTZ,
  CONSTRAINT "coder_oauth_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "coder_oauth_accounts_version_check" CHECK (version >= 1),
  CONSTRAINT "coder_oauth_accounts_refresh_state_check"
    CHECK (refresh_state IN ('idle', 'refreshing', 'reconnect')),
  CONSTRAINT "coder_oauth_accounts_refresh_lease_check" CHECK (
    (refresh_state = 'refreshing' AND refresh_holder IS NOT NULL AND refresh_until IS NOT NULL)
    OR (refresh_state IN ('idle', 'reconnect') AND refresh_holder IS NULL AND refresh_until IS NULL)
  ),
  CONSTRAINT "coder_oauth_accounts_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "coder_oauth_accounts_provider_id_account_id_key"
  ON "coder_oauth_accounts"("provider_id", "account_id");
CREATE UNIQUE INDEX "coder_oauth_accounts_user_id_provider_id_key"
  ON "coder_oauth_accounts"("user_id", "provider_id");

CREATE FUNCTION hive_coder_oauth_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_account text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.user_id, NEW.provider_id, NEW.account_id)
      IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.provider_id, OLD.account_id) THEN
      RAISE EXCEPTION 'HIVE_OAUTH_ACCOUNT_IDENTITY_IMMUTABLE';
    END IF;
    IF NEW.version < OLD.version OR NEW.version::bigint > OLD.version::bigint + 1 THEN
      RAISE EXCEPTION 'HIVE_OAUTH_ACCOUNT_VERSION';
    END IF;
    IF ROW(NEW.access_token, NEW.refresh_token, NEW.access_token_expires_at)
      IS DISTINCT FROM ROW(OLD.access_token, OLD.refresh_token, OLD.access_token_expires_at) THEN
      NEW.version := OLD.version + 1;
    END IF;
  END IF;
  EXECUTE format('SELECT coder_url || ''|'' || coder_user_id::text FROM %I.users WHERE id = $1', TG_TABLE_SCHEMA)
    INTO expected_account USING NEW.user_id;
  IF NEW.provider_id <> 'coder' OR expected_account IS NULL
    OR NEW.account_id IS DISTINCT FROM expected_account THEN
    RAISE EXCEPTION 'HIVE_OAUTH_ACCOUNT_BINDING';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER coder_oauth_accounts_identity_guard
  BEFORE INSERT OR UPDATE ON coder_oauth_accounts
  FOR EACH ROW EXECUTE FUNCTION hive_coder_oauth_account_guard();

-- Linking is scoped to the existing Coder origin and immutable Coder user UUID.
-- Existing email addresses and credential material do not participate.
INSERT INTO "coder_oauth_accounts" (id, account_id, provider_id, user_id)
  SELECT gen_random_uuid(), coder_url || '|' || coder_user_id::text, 'coder', id FROM "users";

CREATE TABLE "better_auth_verifications" (
  "id" UUID NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "better_auth_verifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "better_auth_verifications_identifier_idx" ON "better_auth_verifications"("identifier");

COMMIT;

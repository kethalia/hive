ALTER TABLE coder_tokens
  ADD COLUMN credential_source text NOT NULL DEFAULT 'legacy',
  ADD COLUMN oauth_client_id text,
  ADD COLUMN refresh_ciphertext bytea,
  ADD COLUMN refresh_iv bytea,
  ADD COLUMN refresh_auth_tag bytea,
  ADD COLUMN oauth_refresh_state text NOT NULL DEFAULT 'idle',
  ADD COLUMN oauth_refresh_holder uuid,
  ADD COLUMN oauth_refresh_until timestamptz;
UPDATE coder_tokens SET credential_source='managed_key' WHERE remote_key_id IS NOT NULL;
ALTER TABLE coder_tokens ADD CONSTRAINT coder_oauth_credential_state CHECK (
  credential_source IN ('legacy','managed_key','oauth') AND oauth_refresh_state IN ('idle','refreshing','reconnect')
  AND ((credential_source='oauth' AND remote_key_id IS NULL AND expires_at IS NOT NULL
    AND oauth_client_id IS NOT NULL AND length(oauth_client_id) BETWEEN 1 AND 256
    AND refresh_ciphertext IS NOT NULL AND octet_length(refresh_ciphertext) BETWEEN 1 AND 8192
    AND refresh_iv IS NOT NULL AND octet_length(refresh_iv)=12 AND refresh_auth_tag IS NOT NULL AND octet_length(refresh_auth_tag)=16)
    OR (credential_source<>'oauth' AND oauth_client_id IS NULL AND refresh_ciphertext IS NULL
      AND refresh_iv IS NULL AND refresh_auth_tag IS NULL AND oauth_refresh_state='idle'))
  AND ((oauth_refresh_state='refreshing' AND oauth_refresh_holder IS NOT NULL AND oauth_refresh_until IS NOT NULL)
    OR (oauth_refresh_state<>'refreshing' AND oauth_refresh_holder IS NULL AND oauth_refresh_until IS NULL))
);
CREATE TABLE coder_oauth_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), state_hash text NOT NULL UNIQUE, browser_hash text NOT NULL,
  coder_origin text NOT NULL, public_origin text NOT NULL, client_id text NOT NULL,
  verifier_ciphertext bytea NOT NULL, verifier_iv bytea NOT NULL, verifier_auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes', consumed_at timestamptz,
  CONSTRAINT coder_oauth_flow_bounds CHECK (
    state_hash ~ '^[a-f0-9]{64}$' AND browser_hash ~ '^[a-f0-9]{64}$'
    AND length(client_id) BETWEEN 1 AND 256 AND octet_length(verifier_ciphertext) BETWEEN 1 AND 4096
    AND octet_length(verifier_iv)=12 AND octet_length(verifier_auth_tag)=16
    AND expires_at>created_at AND expires_at<=created_at+interval '10 minutes 1 second'
    AND (consumed_at IS NULL OR (consumed_at>=created_at AND consumed_at<expires_at))
  )
);
CREATE INDEX coder_oauth_flows_expiry_idx ON coder_oauth_flows(expires_at);
CREATE FUNCTION hive_coder_oauth_flow_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'OAuth flow starts unconsumed'; END IF;
  ELSIF (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at')
    OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR NEW.consumed_at>=OLD.expires_at
  THEN RAISE EXCEPTION 'OAuth flow immutable or already consumed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coder_oauth_flow_integrity BEFORE INSERT OR UPDATE ON coder_oauth_flows
  FOR EACH ROW EXECUTE FUNCTION hive_coder_oauth_flow_integrity();
REVOKE ALL ON coder_oauth_flows FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['hive_app_runtime','hive_native_runtime'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON coder_oauth_flows TO %I',role_name);
      EXECUTE format('REVOKE TRUNCATE,REFERENCES,TRIGGER ON coder_oauth_flows FROM %I',role_name);
    END IF;
  END LOOP;
END $$;

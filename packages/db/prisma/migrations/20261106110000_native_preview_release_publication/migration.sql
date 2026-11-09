-- Additive native Preview authority. Existing action identity/transition and
-- remote_reference guards are unchanged. No enrollment, CONNECT or live effect.
CREATE TABLE delivery_native_release_artifacts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  release_id uuid NOT NULL,
  target_digest text NOT NULL CHECK(target_digest ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=32768),
  manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
  builder_evidence jsonb NOT NULL CHECK(jsonb_typeof(builder_evidence)='object' AND octet_length(builder_evidence::text)<=8192),
  publisher_identity jsonb NOT NULL CHECK(jsonb_typeof(publisher_identity)='object' AND octet_length(publisher_identity::text)<=4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,id), UNIQUE(id,owner_id,release_id,target_digest),
  FOREIGN KEY(owner_id,release_id) REFERENCES delivery_releases(owner_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(release_id,target_digest) REFERENCES delivery_releases(id,target_digest) ON DELETE RESTRICT
);
CREATE TABLE delivery_native_publication_grants (
  id uuid PRIMARY KEY,
  action_id uuid NOT NULL UNIQUE REFERENCES delivery_release_actions(id) ON DELETE RESTRICT,
  artifact_id uuid NOT NULL REFERENCES delivery_native_release_artifacts(id) ON DELETE RESTRICT,
  grant_data jsonb NOT NULL CHECK(jsonb_typeof(grant_data)='object' AND octet_length(grant_data::text)<=49152),
  grant_digest text NOT NULL CHECK(grant_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes')
);
CREATE TABLE delivery_native_publication_receipts (
  action_id uuid PRIMARY KEY REFERENCES delivery_release_actions(id) ON DELETE RESTRICT,
  grant_id uuid NOT NULL UNIQUE REFERENCES delivery_native_publication_grants(id) ON DELETE RESTRICT,
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=16384),
  receipt_digest text NOT NULL CHECK(receipt_digest ~ '^[a-f0-9]{64}$'),
  publisher_identity jsonb NOT NULL CHECK(jsonb_typeof(publisher_identity)='object' AND octet_length(publisher_identity::text)<=4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE delivery_native_release_baselines (
  observation_digest text PRIMARY KEY CHECK(observation_digest ~ '^[a-f0-9]{64}$'),
  artifact_id uuid NOT NULL REFERENCES delivery_native_release_artifacts(id) ON DELETE RESTRICT,
  action_id uuid NOT NULL REFERENCES delivery_release_actions(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL,
  target_digest text NOT NULL CHECK(target_digest ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=32768),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION hive_native_release_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'native_release_history_immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER native_release_baseline_immutable BEFORE UPDATE OR DELETE ON delivery_native_release_baselines
  FOR EACH ROW EXECUTE FUNCTION hive_native_release_immutable();
CREATE TRIGGER native_release_artifact_immutable BEFORE UPDATE OR DELETE ON delivery_native_release_artifacts
  FOR EACH ROW EXECUTE FUNCTION hive_native_release_immutable();
CREATE TRIGGER native_publication_grant_immutable BEFORE UPDATE OR DELETE ON delivery_native_publication_grants
  FOR EACH ROW EXECUTE FUNCTION hive_native_release_immutable();
CREATE TRIGGER native_publication_receipt_immutable BEFORE UPDATE OR DELETE ON delivery_native_publication_receipts
  FOR EACH ROW EXECUTE FUNCTION hive_native_release_immutable();
CREATE FUNCTION hive_native_publication_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE action delivery_release_actions; grantrow delivery_native_publication_grants;
  artifact delivery_native_release_artifacts; releaseowner uuid;
BEGIN
  SELECT * INTO action FROM delivery_release_actions WHERE id=NEW.action_id FOR UPDATE;
  IF NOT FOUND OR action.kind NOT IN ('promote','recover') OR action.phase NOT IN ('effect_started','held')
     OR action.request->>'provider' IS DISTINCT FROM 'cloudflare-native-preview' THEN
    RAISE EXCEPTION 'native_publication_action_scope' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='delivery_native_publication_grants' THEN
    SELECT owner_id INTO releaseowner FROM delivery_releases WHERE id=action.release_id;
    SELECT * INTO artifact FROM delivery_native_release_artifacts WHERE id=NEW.artifact_id;
    IF action.phase<>'effect_started' OR NEW.expires_at<=clock_timestamp()
       OR artifact.id IS NULL OR artifact.owner_id IS DISTINCT FROM releaseowner
       OR artifact.target_digest IS DISTINCT FROM action.target_digest
       OR NEW.artifact_id::text IS DISTINCT FROM action.request->>'artifactId'
       OR NEW.grant_data->'artifact' IS DISTINCT FROM artifact.manifest
       OR NEW.grant_data->>'id' IS DISTINCT FROM NEW.id::text
       OR NEW.grant_data->>'ownerId' IS DISTINCT FROM releaseowner::text
       OR NEW.grant_data->>'purpose' IS DISTINCT FROM action.request->>'purpose'
       OR NEW.grant_data->>'expectedCurrentDeploymentId' IS DISTINCT FROM action.request->>'expectedCurrentDeploymentId'
       OR NEW.grant_data->>'actionId' IS DISTINCT FROM action.id::text
       OR NEW.grant_data->>'releaseId' IS DISTINCT FROM action.release_id::text
       OR NEW.grant_data->>'requestDigest' IS DISTINCT FROM action.request_digest
       OR (NEW.grant_data->>'generation')::integer IS DISTINCT FROM action.generation THEN
      RAISE EXCEPTION 'native_publication_grant_scope' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO grantrow FROM delivery_native_publication_grants WHERE id=NEW.grant_id;
    IF NOT FOUND OR grantrow.action_id<>NEW.action_id
       OR NEW.receipt->>'grantId' IS DISTINCT FROM grantrow.id::text
       OR NEW.receipt->>'actionId' IS DISTINCT FROM action.id::text
       OR NEW.receipt->>'requestDigest' IS DISTINCT FROM action.request_digest THEN
      RAISE EXCEPTION 'native_publication_receipt_scope' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_publication_grant_insert BEFORE INSERT ON delivery_native_publication_grants
  FOR EACH ROW EXECUTE FUNCTION hive_native_publication_insert();
CREATE TRIGGER native_publication_receipt_insert BEFORE INSERT ON delivery_native_publication_receipts
  FOR EACH ROW EXECUTE FUNCTION hive_native_publication_insert();
CREATE FUNCTION hive_native_baseline_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE action delivery_release_actions; artifact delivery_native_release_artifacts;
BEGIN
  SELECT a.* INTO action FROM delivery_release_actions a JOIN delivery_releases r ON r.id=a.release_id
    WHERE a.id=NEW.action_id AND r.owner_id=NEW.owner_id AND r.target_digest=NEW.target_digest FOR UPDATE OF a,r;
  SELECT a.* INTO artifact FROM delivery_native_release_artifacts a JOIN delivery_native_publication_grants g ON g.artifact_id=a.id
    WHERE g.action_id=NEW.action_id AND a.id=NEW.artifact_id AND a.owner_id=NEW.owner_id AND a.target_digest=NEW.target_digest;
  IF action.id IS NULL OR artifact.id IS NULL OR action.phase<>'observed'
     OR action.kind NOT IN ('promote','recover') OR action.request->>'provider' IS DISTINCT FROM 'cloudflare-native-preview'
     OR NEW.evidence->>'scope' IS DISTINCT FROM 'sampled-health-no-atomic-exclusion'
     OR NEW.evidence->>'metrics' IS DISTINCT FROM 'sampled-only' OR NEW.evidence->>'smoke' IS DISTINCT FROM 'passed'
     OR NEW.evidence->>'actionId' IS DISTINCT FROM action.id::text OR NEW.evidence->>'artifactId' IS DISTINCT FROM artifact.id::text
     OR NOT EXISTS (SELECT 1 FROM delivery_release_observations o WHERE o.release_id=action.release_id
       AND o.kind IN ('healthy','recovered') AND o.evidence_digest=NEW.observation_digest AND o.evidence=NEW.evidence) THEN
    RAISE EXCEPTION 'native_baseline_scope' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_release_baseline_insert BEFORE INSERT ON delivery_native_release_baselines
  FOR EACH ROW EXECUTE FUNCTION hive_native_baseline_insert();
REVOKE ALL ON delivery_native_release_artifacts,delivery_native_publication_grants,delivery_native_publication_receipts,delivery_native_release_baselines FROM PUBLIC;
DO $$ DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['hive_app_runtime','hive_native_runtime'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format('GRANT SELECT,INSERT ON delivery_native_release_artifacts,delivery_native_publication_grants,delivery_native_publication_receipts,delivery_native_release_baselines TO %I',runtime_role);
      EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_native_release_artifacts,delivery_native_publication_grants,delivery_native_publication_receipts,delivery_native_release_baselines FROM %I',runtime_role);
    END IF;
  END LOOP;
END $$;

-- GitHub OIDC-authenticated build identity, not deployment authorization.
CREATE TABLE delivery_release_build_attestations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  release_id uuid NOT NULL,
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=32768),
  manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
  jti_digest text NOT NULL CHECK(jti_digest ~ '^[a-f0-9]{64}$'),
  workflow_sha text NOT NULL CHECK(workflow_sha ~ '^[a-f0-9]{40}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,id), UNIQUE(owner_id,release_id), UNIQUE(jti_digest),
  FOREIGN KEY(owner_id,release_id) REFERENCES delivery_releases(owner_id,id) ON DELETE RESTRICT
);
CREATE FUNCTION hive_release_build_attestation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'release_build_attestation_immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER release_build_attestation_immutable BEFORE UPDATE OR DELETE ON delivery_release_build_attestations
  FOR EACH ROW EXECUTE FUNCTION hive_release_build_attestation_immutable();
CREATE TABLE delivery_release_build_verifications (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  attestation_id uuid NOT NULL,
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=16384),
  evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,attestation_id),
  FOREIGN KEY(owner_id,attestation_id) REFERENCES delivery_release_build_attestations(owner_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER release_build_verification_immutable BEFORE UPDATE OR DELETE ON delivery_release_build_verifications
  FOR EACH ROW EXECUTE FUNCTION hive_release_build_attestation_immutable();
REVOKE ALL ON delivery_release_build_attestations,delivery_release_build_verifications FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hive_app_runtime') THEN
    GRANT SELECT,INSERT ON delivery_release_build_attestations TO hive_app_runtime;
    GRANT SELECT,INSERT ON delivery_release_build_verifications TO hive_app_runtime;
    REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_release_build_attestations FROM hive_app_runtime;
    REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_release_build_verifications FROM hive_app_runtime;
  END IF;
END $$;

-- Single-use, controller-issued challenge and immutable test-tree attestations.
-- OIDC identity and provider facts are checked by the trusted server before insertion.
CREATE TABLE delivery_release_test_challenges (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL,
 task_id uuid NOT NULL,
 request jsonb NOT NULL CHECK (jsonb_typeof(request)='object' AND octet_length(request::text)<=16384),
 request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
 nonce_digest text NOT NULL UNIQUE CHECK (nonce_digest ~ '^[a-f0-9]{64}$'),
 challenge_jti_digest text NOT NULL UNIQUE CHECK (challenge_jti_digest ~ '^[a-f0-9]{64}$'),
 policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
 checks_digest text NOT NULL CHECK (checks_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
 UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,task_id) REFERENCES delivery_tasks(owner_id,id) ON DELETE RESTRICT
);
CREATE TABLE delivery_release_test_attestations (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL,
 task_id uuid NOT NULL,
 challenge_id uuid NOT NULL UNIQUE,
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
 payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
 attestation_jti_digest text NOT NULL UNIQUE CHECK (attestation_jti_digest ~ '^[a-f0-9]{64}$'),
 workflow_digest text NOT NULL CHECK (workflow_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
 UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,challenge_id) REFERENCES delivery_release_test_challenges(owner_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id,task_id) REFERENCES delivery_tasks(owner_id,id) ON DELETE RESTRICT
);
CREATE INDEX delivery_release_test_attestations_lookup ON delivery_release_test_attestations(owner_id,task_id,expires_at);
CREATE FUNCTION hive_release_test_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'release_test_immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER release_test_challenge_immutable BEFORE UPDATE OR DELETE ON delivery_release_test_challenges FOR EACH ROW EXECUTE FUNCTION hive_release_test_immutable();
CREATE TRIGGER release_test_attestation_immutable BEFORE UPDATE OR DELETE ON delivery_release_test_attestations FOR EACH ROW EXECUTE FUNCTION hive_release_test_immutable();
REVOKE ALL ON delivery_release_test_challenges, delivery_release_test_attestations FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hive_app_runtime') THEN
   GRANT SELECT,INSERT ON delivery_release_test_challenges,delivery_release_test_attestations TO hive_app_runtime;
   REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_release_test_challenges,delivery_release_test_attestations FROM hive_app_runtime;
 END IF;
END $$;

CREATE TABLE delivery_release_deployment_observations (
  id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES delivery_releases(id) ON DELETE RESTRICT,
  generation integer NOT NULL CHECK (generation > 0),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 32768),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX delivery_release_deployment_observations_release_idx ON delivery_release_deployment_observations(release_id, observed_at DESC);
CREATE TRIGGER release_deployment_observation_immutable BEFORE UPDATE OR DELETE ON delivery_release_deployment_observations FOR EACH ROW EXECUTE FUNCTION hive_release_observation_immutable();
REVOKE ALL ON delivery_release_deployment_observations FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hive_app_runtime') THEN
    GRANT SELECT, INSERT ON delivery_release_deployment_observations TO hive_app_runtime;
  END IF;
END $$;

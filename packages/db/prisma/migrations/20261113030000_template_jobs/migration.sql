-- Additive legacy template publication; existing auth/session schema is unchanged.
CREATE TABLE template_jobs (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 coder_user_id uuid NOT NULL, session_id uuid NOT NULL, origin text NOT NULL,
 organization_id uuid NOT NULL, name text NOT NULL, artifact jsonb NOT NULL, state jsonb NOT NULL,
 phase text NOT NULL DEFAULT 'queued', reason text, holder uuid, lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, deadline timestamptz NOT NULL,
 UNIQUE(owner_id,request_id), UNIQUE(owner_id,id),
 CHECK(name IN ('ai-dev-k8s','browser-testing','game-dev','electronics','infrastructure')),
 CHECK(phase IN ('queued','uploading','creating_version','importing','activating','creating_template','succeeded','failed','held')),
 CHECK(attempts BETWEEN 0 AND 128 AND deadline>created_at AND deadline<=created_at+interval '15 minutes'),
 CHECK((holder IS NULL)=(lease_until IS NULL)),
 CHECK(jsonb_typeof(artifact)='object' AND octet_length(artifact::text)<=2048 AND jsonb_typeof(state)='object' AND octet_length(state::text)<=8192)
);
CREATE INDEX template_jobs_phase_next_attempt_at_idx ON template_jobs(phase,next_attempt_at);
-- Shared across owners: only one unfinished publication may control a Coder target.
CREATE UNIQUE INDEX template_jobs_active_target ON template_jobs(origin,organization_id,name)
 WHERE phase NOT IN ('succeeded','failed');
CREATE TABLE template_notices (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, job_id uuid NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(owner_id,job_id) REFERENCES template_jobs(owner_id,id),
 CHECK(status IN ('pending','processing','delivered','failed') AND attempts BETWEEN 0 AND 5)
);
CREATE INDEX template_notices_status_next_attempt_at_idx ON template_notices(status,next_attempt_at);
CREATE FUNCTION hive_legacy_template_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','phase','reason','holder','lease_until','next_attempt_at','attempts']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','phase','reason','holder','lease_until','next_attempt_at','attempts']) OR
    OLD.phase IN ('succeeded','failed','held') OR NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1 THEN
   RAISE EXCEPTION 'template job identity or terminal state is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER template_job_guard BEFORE UPDATE ON template_jobs FOR EACH ROW EXECUTE FUNCTION hive_legacy_template_job_guard();
REVOKE ALL ON template_jobs,template_notices FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['hive_foundation_runtime','hive_production_runtime'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON template_jobs,template_notices TO %I',role_name);
  END IF;
 END LOOP;
END $$;

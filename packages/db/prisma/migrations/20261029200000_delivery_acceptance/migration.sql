-- Controller-owned independent acceptance. No existing intent is adopted and
-- no policy/producer is enabled by this migration.
CREATE TABLE delivery_acceptance_intents (
  owner_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  project_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 65536),
  iv bytea NOT NULL CHECK (octet_length(iv)=12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag)=16),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,intent_id),
  UNIQUE(owner_id,project_id,intent_id),
  CONSTRAINT acceptance_intent_owner_fkey FOREIGN KEY(owner_id,project_id,intent_id)
    REFERENCES project_task_intents(owner_id,project_id,id) ON DELETE RESTRICT,
  CONSTRAINT acceptance_intent_policy_fkey FOREIGN KEY(owner_id,project_id,policy_version_id)
    REFERENCES delivery_repository_policy_versions(owner_id,project_id,id) ON DELETE RESTRICT
);
CREATE TABLE delivery_acceptance_jobs (
  material jsonb CHECK(material IS NULL OR (jsonb_typeof(material)='object' AND octet_length(material::text)<=262144)),
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  task_id uuid,
  kind text NOT NULL CHECK(kind IN ('plan','review')),
  scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object' AND octet_length(scope::text)<=32768),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  producer jsonb NOT NULL CHECK(jsonb_typeof(producer)='object' AND octet_length(producer::text)<=8192),
  producer_digest text NOT NULL CHECK(producer_digest ~ '^[a-f0-9]{64}$'),
  phase text NOT NULL DEFAULT 'queued' CHECK(phase IN ('queued','leased','started','completed','held')),
  lease_id uuid,
  lease_generation integer NOT NULL DEFAULT 0 CHECK(lease_generation>=0),
  lease_until timestamptz,
  registration_id uuid,
  server_instance_id text,
  manager_thread_id text,
  evaluator_thread_id text,
  evaluator_turn_id text,
  authority jsonb,
  input_digest text CHECK(input_digest IS NULL OR input_digest ~ '^[a-f0-9]{64}$'),
  result jsonb,
  result_digest text CHECK(result_digest IS NULL OR result_digest ~ '^[a-f0-9]{64}$'),
  receipt jsonb,
  held_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE(owner_id,id),
  UNIQUE(owner_id,intent_id,request_digest),
  CONSTRAINT acceptance_job_intent_fkey FOREIGN KEY(owner_id,project_id,intent_id)
    REFERENCES delivery_acceptance_intents(owner_id,project_id,intent_id) ON DELETE RESTRICT,
  CONSTRAINT acceptance_job_task_fkey FOREIGN KEY(owner_id,project_id,task_id)
    REFERENCES delivery_tasks(owner_id,project_id,id) ON DELETE RESTRICT,
  CHECK((kind='plan' AND task_id IS NULL) OR (kind='review' AND task_id IS NOT NULL)),
  CHECK((lease_id IS NULL AND lease_until IS NULL AND registration_id IS NULL AND server_instance_id IS NULL AND manager_thread_id IS NULL AND authority IS NULL)
    OR (lease_id IS NOT NULL AND lease_until IS NOT NULL AND registration_id IS NOT NULL AND server_instance_id IS NOT NULL AND manager_thread_id IS NOT NULL AND authority IS NOT NULL AND lease_generation>0)),
  CHECK(authority IS NULL OR (jsonb_typeof(authority)='object' AND octet_length(authority::text)<=16384)),
  CHECK(result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=73728)),
  CHECK(receipt IS NULL OR (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=8192)),
  CHECK(phase NOT IN ('queued','leased') OR (evaluator_thread_id IS NULL AND evaluator_turn_id IS NULL AND result IS NULL)),
  CHECK(phase<>'started' OR (evaluator_thread_id IS NOT NULL AND input_digest IS NOT NULL)),
  CHECK(phase<>'completed' OR (result IS NOT NULL AND result_digest IS NOT NULL AND receipt IS NOT NULL AND completed_at IS NOT NULL AND evaluator_turn_id IS NOT NULL AND evaluator_thread_id IS NOT NULL)),
  CHECK((result IS NULL AND result_digest IS NULL AND receipt IS NULL AND completed_at IS NULL) OR phase='completed')
);
CREATE INDEX delivery_acceptance_jobs_queue ON delivery_acceptance_jobs(owner_id,intent_id,phase,created_at);
CREATE UNIQUE INDEX delivery_acceptance_evaluator_thread ON delivery_acceptance_jobs(owner_id,server_instance_id,evaluator_thread_id)
  WHERE evaluator_thread_id IS NOT NULL;
CREATE TABLE delivery_acceptance_plans (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  source_job_id uuid NOT NULL,
  producer_digest text NOT NULL CHECK(producer_digest ~ '^[a-f0-9]{64}$'),
  intent_digest text NOT NULL CHECK(intent_digest ~ '^[a-f0-9]{64}$'),
  plan_digest text NOT NULL CHECK(plan_digest ~ '^[a-f0-9]{64}$'),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=73728),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,id),
  UNIQUE(owner_id,intent_id,producer_digest),
  UNIQUE(owner_id,source_job_id),
  CONSTRAINT acceptance_plan_intent_fkey FOREIGN KEY(owner_id,project_id,intent_id)
    REFERENCES delivery_acceptance_intents(owner_id,project_id,intent_id) ON DELETE RESTRICT,
  CONSTRAINT acceptance_plan_job_fkey FOREIGN KEY(owner_id,source_job_id)
    REFERENCES delivery_acceptance_jobs(owner_id,id) ON DELETE RESTRICT
);
CREATE FUNCTION hive_acceptance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'acceptance_history_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER acceptance_intent_immutable BEFORE UPDATE OR DELETE ON delivery_acceptance_intents
  FOR EACH ROW EXECUTE FUNCTION hive_acceptance_immutable();
CREATE TRIGGER acceptance_plan_immutable BEFORE UPDATE OR DELETE ON delivery_acceptance_plans
  FOR EACH ROW EXECUTE FUNCTION hive_acceptance_immutable();
CREATE FUNCTION hive_acceptance_intent_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source project_task_intents;
BEGIN
  SELECT * INTO source FROM project_task_intents WHERE owner_id=NEW.owner_id AND id=NEW.intent_id FOR UPDATE;
  IF NOT FOUND OR source.project_id<>NEW.project_id OR source.phase<>'queued'
    OR source.repository_policy_version_id IS DISTINCT FROM NEW.policy_version_id
    OR source.repository_policy_digest IS DISTINCT FROM NEW.policy_digest
    OR source.intent_text_digest IS DISTINCT FROM NEW.intent_digest
    OR source.request_digest<>NEW.request_digest THEN
    RAISE EXCEPTION 'acceptance_intent_binding' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acceptance_intent_binding BEFORE INSERT ON delivery_acceptance_intents
  FOR EACH ROW EXECUTE FUNCTION hive_acceptance_intent_insert();
CREATE FUNCTION hive_acceptance_job_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'acceptance_history_immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.phase<>'queued' OR NEW.lease_generation<>0 OR NEW.lease_id IS NOT NULL
      OR NEW.evaluator_thread_id IS NOT NULL OR NEW.evaluator_turn_id IS NOT NULL
      OR NEW.input_digest IS NOT NULL OR NEW.result IS NOT NULL
      OR NEW.registration_id IS NOT NULL OR NEW.server_instance_id IS NOT NULL OR NEW.manager_thread_id IS NOT NULL OR NEW.authority IS NOT NULL THEN
      RAISE EXCEPTION 'acceptance_job_initial_state' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.owner_id,NEW.project_id,NEW.intent_id,NEW.task_id,NEW.kind,NEW.material,NEW.scope,NEW.request_digest,NEW.producer,NEW.producer_digest,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.owner_id,OLD.project_id,OLD.intent_id,OLD.task_id,OLD.kind,OLD.material,OLD.scope,OLD.request_digest,OLD.producer,OLD.producer_digest,OLD.created_at)
    OR OLD.phase IN ('held','completed') THEN
    RAISE EXCEPTION 'acceptance_job_identity_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.phase='leased' THEN
    IF NOT (OLD.phase='queued' OR (OLD.phase='leased' AND OLD.lease_until<=clock_timestamp() AND OLD.evaluator_thread_id IS NULL))
      OR NEW.lease_generation<>OLD.lease_generation+1 OR NEW.lease_id IS NULL
      OR NEW.lease_id IS NOT DISTINCT FROM OLD.lease_id THEN
      RAISE EXCEPTION 'acceptance_lease_transition' USING ERRCODE='23514';
    END IF;
  ELSIF ROW(NEW.lease_id,NEW.lease_generation,NEW.lease_until,NEW.registration_id,NEW.server_instance_id,NEW.manager_thread_id,NEW.authority,NEW.input_digest)
    IS DISTINCT FROM ROW(OLD.lease_id,OLD.lease_generation,OLD.lease_until,OLD.registration_id,OLD.server_instance_id,OLD.manager_thread_id,OLD.authority,OLD.input_digest) THEN
    RAISE EXCEPTION 'acceptance_lease_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.phase='started' AND (OLD.phase<>'leased' OR NEW.evaluator_thread_id IS NULL OR OLD.lease_until<=clock_timestamp()) THEN
    RAISE EXCEPTION 'acceptance_start_transition' USING ERRCODE='23514';
  END IF;
  IF OLD.evaluator_thread_id IS NOT NULL AND NEW.evaluator_thread_id IS DISTINCT FROM OLD.evaluator_thread_id THEN
    RAISE EXCEPTION 'acceptance_thread_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.phase='completed' AND (OLD.phase<>'started' OR OLD.lease_until<=clock_timestamp()) THEN
    RAISE EXCEPTION 'acceptance_finish_transition' USING ERRCODE='23514';
  END IF;
  IF NOT ((OLD.phase IN ('queued','leased','started') AND NEW.phase='held')
    OR NEW.phase='leased' OR (OLD.phase='leased' AND NEW.phase='started') OR (OLD.phase='started' AND NEW.phase='completed')) THEN
    RAISE EXCEPTION 'acceptance_phase_transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acceptance_job_transition BEFORE INSERT OR UPDATE OR DELETE ON delivery_acceptance_jobs
  FOR EACH ROW EXECUTE FUNCTION hive_acceptance_job_transition();
CREATE FUNCTION hive_acceptance_plan_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job delivery_acceptance_jobs;
BEGIN
  SELECT * INTO job FROM delivery_acceptance_jobs WHERE owner_id=NEW.owner_id AND id=NEW.source_job_id FOR UPDATE;
  IF NOT FOUND OR job.kind<>'plan' OR job.phase<>'completed' OR job.intent_id<>NEW.intent_id
    OR job.project_id<>NEW.project_id OR job.producer_digest<>NEW.producer_digest
    OR job.result IS DISTINCT FROM NEW.content OR job.result_digest<>NEW.plan_digest
    OR job.scope->>'intentDigest' IS DISTINCT FROM NEW.intent_digest THEN
    RAISE EXCEPTION 'acceptance_plan_binding' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acceptance_plan_binding BEFORE INSERT ON delivery_acceptance_plans
  FOR EACH ROW EXECUTE FUNCTION hive_acceptance_plan_insert();
REVOKE ALL ON delivery_acceptance_intents,delivery_acceptance_plans,delivery_acceptance_jobs FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hive_app_runtime') THEN
    GRANT SELECT,INSERT ON delivery_acceptance_intents,delivery_acceptance_plans TO hive_app_runtime;
    GRANT SELECT,INSERT,UPDATE ON delivery_acceptance_jobs TO hive_app_runtime;
    REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_acceptance_intents,delivery_acceptance_plans FROM hive_app_runtime;
    REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_acceptance_jobs FROM hive_app_runtime;
  END IF;
END $$;

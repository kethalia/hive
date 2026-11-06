-- Short-lived, controller-produced observations; not an independent grant.
CREATE TABLE delivery_release_authority_facts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  task_id uuid NOT NULL,
  source_sha text NOT NULL CHECK(source_sha ~ '^[a-f0-9]{40}$'),
  target_digest text NOT NULL CHECK(target_digest ~ '^[a-f0-9]{64}$'),
  config_digest text NOT NULL CHECK(config_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=131072),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at > observed_at AND expires_at <= observed_at + interval '30 seconds'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,task_id,payload_digest),
  FOREIGN KEY(owner_id,task_id) REFERENCES delivery_tasks(owner_id,id) ON DELETE RESTRICT
);
CREATE FUNCTION hive_release_authority_fact_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'release_authority_fact_immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER release_authority_fact_immutable BEFORE UPDATE OR DELETE ON delivery_release_authority_facts FOR EACH ROW EXECUTE FUNCTION hive_release_authority_fact_immutable();
REVOKE ALL ON delivery_release_authority_facts FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hive_app_runtime') THEN
    GRANT SELECT,INSERT ON delivery_release_authority_facts TO hive_app_runtime;
    REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_release_authority_facts FROM hive_app_runtime;
  END IF;
END $$;
-- Durable pagination prevents old ineligible tasks from starving later work
-- when each Worker cron invocation starts with a fresh isolate.
CREATE TABLE delivery_release_scheduler_cursors (
  target_digest text PRIMARY KEY CHECK(target_digest ~ '^[a-f0-9]{64}$'),
  opener_cursor uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON delivery_release_scheduler_cursors FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hive_app_runtime') THEN
    GRANT SELECT,INSERT,UPDATE ON delivery_release_scheduler_cursors TO hive_app_runtime;
    REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_release_scheduler_cursors FROM hive_app_runtime;
  END IF;
END $$;

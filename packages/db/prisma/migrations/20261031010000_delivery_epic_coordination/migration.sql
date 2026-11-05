-- Versioned epic plans retain every prior decomposition. Task writers are
-- fenced by a locked epic head and separately verified guardian ownership.
CREATE TABLE delivery_epic_plans (
 owner_id uuid NOT NULL,
 epic_id uuid NOT NULL,
 version integer NOT NULL CHECK (version > 0),
 plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object' AND octet_length(plan::text) <= 131072),
 plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
 previous_plan_digest text CHECK (previous_plan_digest IS NULL OR previous_plan_digest ~ '^[a-f0-9]{64}$'),
 authored_by_task_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,epic_id,version), UNIQUE(owner_id,epic_id,plan_digest), UNIQUE(owner_id,epic_id,version,plan_digest),
 FOREIGN KEY(owner_id,epic_id) REFERENCES delivery_epics(owner_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id,authored_by_task_id) REFERENCES delivery_tasks(owner_id,id) ON DELETE RESTRICT
);
CREATE TABLE delivery_epic_plan_heads (
 owner_id uuid NOT NULL,
 epic_id uuid NOT NULL,
 version integer NOT NULL CHECK (version > 0),
 plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(owner_id,epic_id),
 FOREIGN KEY(owner_id,epic_id,version,plan_digest) REFERENCES delivery_epic_plans(owner_id,epic_id,version,plan_digest) ON DELETE RESTRICT
);
CREATE TABLE delivery_epic_task_inputs (
 owner_id uuid NOT NULL, epic_id uuid NOT NULL, plan_digest text NOT NULL,
 intent_id uuid NOT NULL, text_digest text NOT NULL CHECK (text_digest ~ '^[a-f0-9]{64}$'),
 ciphertext bytea NOT NULL, iv bytea NOT NULL, auth_tag bytea NOT NULL,
 PRIMARY KEY(owner_id,epic_id,plan_digest,intent_id),
 FOREIGN KEY(owner_id,epic_id,plan_digest) REFERENCES delivery_epic_plans(owner_id,epic_id,plan_digest) ON DELETE RESTRICT
);
CREATE TABLE delivery_epic_start_intents (
 owner_id uuid NOT NULL, epic_id uuid NOT NULL, intent_id uuid NOT NULL,
 plan_digest text NOT NULL, workspace_id uuid NOT NULL, build_id uuid NOT NULL,
 isolation_domain text NOT NULL CHECK (isolation_domain ~ '^[A-Za-z0-9_.:-]{1,100}$'), request_id uuid NOT NULL,
 phase text NOT NULL DEFAULT 'reserved' CHECK (phase IN ('reserved','accepted','finished')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,epic_id,intent_id),
 FOREIGN KEY(owner_id,epic_id,plan_digest) REFERENCES delivery_epic_plans(owner_id,epic_id,plan_digest) ON DELETE RESTRICT
);
-- Reserve the provisioned domain before checkout preparation starts. A writer
-- reservation taken only after preparation is too late to prevent overlap.
CREATE UNIQUE INDEX delivery_epic_start_workspace_active ON delivery_epic_start_intents(workspace_id) WHERE phase IN ('reserved','accepted');
CREATE UNIQUE INDEX delivery_epic_start_domain_active ON delivery_epic_start_intents(isolation_domain) WHERE phase IN ('reserved','accepted');
CREATE TABLE delivery_epic_writer_reservations (
 owner_id uuid NOT NULL, epic_id uuid NOT NULL, intent_id uuid NOT NULL, task_id uuid NOT NULL,
 plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
 workspace_id uuid NOT NULL, build_id uuid NOT NULL, lease_id uuid NOT NULL,
 checkout_incarnation uuid NOT NULL,
 checkout_identity_digest text NOT NULL CHECK (checkout_identity_digest ~ '^[a-f0-9]{64}$'),
 isolation_domain text NOT NULL CHECK (isolation_domain ~ '^[A-Za-z0-9_.:-]{1,100}$'),
 phase text NOT NULL DEFAULT 'held' CHECK (phase IN ('held','released')),
 release_evidence_digest text CHECK (release_evidence_digest IS NULL OR release_evidence_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz,
 CHECK ((phase='held' AND released_at IS NULL AND release_evidence_digest IS NULL) OR (phase='released' AND released_at IS NOT NULL AND release_evidence_digest IS NOT NULL)),
 PRIMARY KEY(owner_id,epic_id,intent_id),
 FOREIGN KEY(owner_id,epic_id,plan_digest) REFERENCES delivery_epic_plans(owner_id,epic_id,plan_digest) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id,task_id) REFERENCES delivery_tasks(owner_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id,intent_id) REFERENCES project_task_intents(owner_id,id) ON DELETE RESTRICT
);
CREATE INDEX delivery_epic_writers_held ON delivery_epic_writer_reservations(owner_id,epic_id) WHERE phase='held';
CREATE TABLE delivery_epic_preservations (
 owner_id uuid NOT NULL, epic_id uuid NOT NULL, intent_id uuid NOT NULL, task_id uuid NOT NULL,
 source_sha text NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
 artifact_key text NOT NULL, artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
 session_digest text NOT NULL CHECK (session_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,epic_id,intent_id),
 FOREIGN KEY(owner_id,epic_id,intent_id) REFERENCES delivery_epic_start_intents(owner_id,epic_id,intent_id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id,task_id) REFERENCES delivery_tasks(owner_id,id) ON DELETE RESTRICT
);
CREATE TABLE delivery_epic_lineage_proofs (
 owner_id uuid NOT NULL, epic_id uuid NOT NULL, intent_id uuid NOT NULL, dependency_intent_id uuid NOT NULL,
 plan_digest text NOT NULL, repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
 base_sha text NOT NULL CHECK (base_sha ~ '^[a-f0-9]{40}$'), head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
 proof_digest text NOT NULL CHECK (proof_digest ~ '^[a-f0-9]{64}$'), proof jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,epic_id,intent_id,dependency_intent_id,plan_digest),
 FOREIGN KEY(owner_id,epic_id,plan_digest) REFERENCES delivery_epic_plans(owner_id,epic_id,plan_digest) ON DELETE RESTRICT
);
CREATE TABLE delivery_epic_lease_releases (
 owner_id uuid NOT NULL, epic_id uuid NOT NULL, intent_id uuid NOT NULL, runtime_id uuid NOT NULL,
 receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[a-f0-9]{64}$'), receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,epic_id,intent_id),
 FOREIGN KEY(owner_id,epic_id,intent_id) REFERENCES delivery_epic_start_intents(owner_id,epic_id,intent_id) ON DELETE RESTRICT
);
CREATE TABLE delivery_epic_task_archives (
 owner_id uuid NOT NULL, epic_id uuid NOT NULL, intent_id uuid NOT NULL,
 archive_digest text NOT NULL CHECK (archive_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,epic_id,intent_id),
 FOREIGN KEY(owner_id,epic_id,intent_id) REFERENCES delivery_epic_lease_releases(owner_id,epic_id,intent_id) ON DELETE RESTRICT
);
-- A second epic must not evade a writer already held by another epic. The
-- provisioning authority assigns isolation domains globally, so these guards
-- intentionally also apply across owners and projects.
CREATE UNIQUE INDEX delivery_epic_writer_workspace_held ON delivery_epic_writer_reservations(workspace_id) WHERE phase='held';
CREATE UNIQUE INDEX delivery_epic_writer_domain_held ON delivery_epic_writer_reservations(isolation_domain) WHERE phase='held';
CREATE UNIQUE INDEX delivery_epic_writer_lease_held ON delivery_epic_writer_reservations(lease_id) WHERE phase='held';
CREATE UNIQUE INDEX delivery_epic_writer_checkout_held ON delivery_epic_writer_reservations(checkout_incarnation) WHERE phase='held';
CREATE FUNCTION hive_epic_plan_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'epic_plan_immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER epic_plan_immutable BEFORE UPDATE OR DELETE ON delivery_epic_plans FOR EACH ROW EXECUTE FUNCTION hive_epic_plan_immutable();
CREATE TRIGGER epic_task_input_immutable BEFORE UPDATE OR DELETE ON delivery_epic_task_inputs FOR EACH ROW EXECUTE FUNCTION hive_epic_plan_immutable();
CREATE TRIGGER epic_preservation_immutable BEFORE UPDATE OR DELETE ON delivery_epic_preservations FOR EACH ROW EXECUTE FUNCTION hive_epic_plan_immutable();
CREATE TRIGGER epic_lineage_immutable BEFORE UPDATE OR DELETE ON delivery_epic_lineage_proofs FOR EACH ROW EXECUTE FUNCTION hive_epic_plan_immutable();
CREATE TRIGGER epic_lease_release_immutable BEFORE UPDATE OR DELETE ON delivery_epic_lease_releases FOR EACH ROW EXECUTE FUNCTION hive_epic_plan_immutable();
CREATE TRIGGER epic_task_archive_immutable BEFORE UPDATE OR DELETE ON delivery_epic_task_archives FOR EACH ROW EXECUTE FUNCTION hive_epic_plan_immutable();
CREATE FUNCTION hive_epic_writer_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.owner_id<>OLD.owner_id OR NEW.epic_id<>OLD.epic_id OR NEW.intent_id<>OLD.intent_id OR NEW.task_id<>OLD.task_id OR NEW.plan_digest<>OLD.plan_digest OR NEW.workspace_id<>OLD.workspace_id OR NEW.build_id<>OLD.build_id OR NEW.lease_id<>OLD.lease_id OR NEW.checkout_incarnation<>OLD.checkout_incarnation OR NEW.checkout_identity_digest<>OLD.checkout_identity_digest OR NEW.isolation_domain<>OLD.isolation_domain OR NEW.created_at<>OLD.created_at OR OLD.phase<>'held' OR NEW.phase<>'released' THEN
   RAISE EXCEPTION 'epic_writer_transition_invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER epic_writer_transition BEFORE UPDATE OR DELETE ON delivery_epic_writer_reservations FOR EACH ROW EXECUTE FUNCTION hive_epic_writer_transition();
CREATE FUNCTION hive_epic_start_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.owner_id<>OLD.owner_id OR NEW.epic_id<>OLD.epic_id OR NEW.intent_id<>OLD.intent_id OR NEW.plan_digest<>OLD.plan_digest OR NEW.workspace_id<>OLD.workspace_id OR NEW.build_id<>OLD.build_id OR NEW.isolation_domain<>OLD.isolation_domain OR NEW.request_id<>OLD.request_id OR NEW.created_at<>OLD.created_at OR NOT ((OLD.phase='reserved' AND NEW.phase='accepted') OR (OLD.phase='accepted' AND NEW.phase='finished')) THEN
   RAISE EXCEPTION 'epic_start_transition_invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER epic_start_transition BEFORE UPDATE OR DELETE ON delivery_epic_start_intents FOR EACH ROW EXECUTE FUNCTION hive_epic_start_transition();
REVOKE ALL ON delivery_epic_plans,delivery_epic_task_inputs,delivery_epic_plan_heads,delivery_epic_start_intents,delivery_epic_writer_reservations,delivery_epic_preservations,delivery_epic_lineage_proofs,delivery_epic_lease_releases,delivery_epic_task_archives FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hive_app_runtime') THEN
  GRANT SELECT,INSERT ON delivery_epic_plans,delivery_epic_task_inputs,delivery_epic_preservations,delivery_epic_lineage_proofs,delivery_epic_lease_releases,delivery_epic_task_archives TO hive_app_runtime;
  GRANT SELECT,INSERT,UPDATE ON delivery_epic_plan_heads,delivery_epic_start_intents,delivery_epic_writer_reservations TO hive_app_runtime;
  REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_epic_plans,delivery_epic_task_inputs,delivery_epic_preservations,delivery_epic_lineage_proofs,delivery_epic_lease_releases,delivery_epic_task_archives FROM hive_app_runtime;
  REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_epic_plan_heads,delivery_epic_start_intents,delivery_epic_writer_reservations FROM hive_app_runtime;
 END IF;
END $$;

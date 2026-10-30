-- Repository policy is controller-owned; source/gate/semantic versions and
-- task projections are retained immutable evidence. Existing rows stay unbound.
CREATE TABLE delivery_repository_policies (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  project_id UUID NOT NULL,
  provider TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  active_version_id UUID,
  generation INTEGER NOT NULL DEFAULT 1,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT delivery_repository_policy_project_fkey FOREIGN KEY(owner_id,project_id)
    REFERENCES delivery_projects(owner_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT delivery_repository_policy_bounds CHECK (
    provider='github' AND repository_id ~ '^[1-9][0-9]{0,19}$'
    AND provider_account_id ~ '^[1-9][0-9]{0,19}$'
    AND char_length(full_name) BETWEEN 3 AND 140 AND generation>0
  ),
  UNIQUE(owner_id,id), UNIQUE(owner_id,project_id), UNIQUE(owner_id,project_id,id)
);
CREATE TABLE delivery_repository_policy_versions (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  project_id UUID NOT NULL,
  policy_id UUID NOT NULL,
  version INTEGER NOT NULL,
  policy_digest TEXT NOT NULL,
  catalog_digest TEXT NOT NULL,
  source_policy JSONB NOT NULL,
  evidence_gates JSONB NOT NULL,
  acceptance_contracts JSONB NOT NULL,
  verified_identity JSONB NOT NULL,
  verified_identity_digest TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT delivery_repository_policy_version_parent_fkey FOREIGN KEY(owner_id,project_id,policy_id)
    REFERENCES delivery_repository_policies(owner_id,project_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT delivery_repository_policy_version_bounds CHECK (
    version>0 AND policy_digest ~ '^[a-f0-9]{64}$' AND catalog_digest ~ '^[a-f0-9]{64}$'
    AND verified_identity_digest ~ '^[a-f0-9]{64}$' AND char_length(created_by) BETWEEN 1 AND 160
    AND jsonb_typeof(source_policy)='object' AND jsonb_typeof(evidence_gates)='object'
    AND jsonb_typeof(acceptance_contracts)='array' AND jsonb_typeof(verified_identity)='object'
    AND jsonb_array_length(acceptance_contracts)<=32
    AND octet_length(source_policy::text)+octet_length(evidence_gates::text)+octet_length(acceptance_contracts::text)<=73728
    AND octet_length(verified_identity::text)<=8192
  ),
  UNIQUE(owner_id,id), UNIQUE(owner_id,project_id,id), UNIQUE(owner_id,policy_id,version),
  UNIQUE(owner_id,project_id,policy_id,id)
);
ALTER TABLE delivery_repository_policies ADD CONSTRAINT delivery_repository_policy_active_fkey
  FOREIGN KEY(owner_id,project_id,id,active_version_id)
  REFERENCES delivery_repository_policy_versions(owner_id,project_id,policy_id,id)
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE project_task_intents
  ADD COLUMN repository_policy_version_id UUID,
  ADD COLUMN repository_policy_digest TEXT,
  ADD COLUMN intent_text_digest TEXT;
ALTER TABLE project_task_intents ADD CONSTRAINT project_task_intent_repository_policy_pin CHECK (
  (repository_policy_version_id IS NULL AND repository_policy_digest IS NULL AND intent_text_digest IS NULL)
  OR (repository_policy_version_id IS NOT NULL AND repository_policy_digest IS NOT NULL AND intent_text_digest IS NOT NULL
    AND repository_policy_digest ~ '^[a-f0-9]{64}$' AND intent_text_digest ~ '^[a-f0-9]{64}$')
);
ALTER TABLE project_task_intents ADD CONSTRAINT project_task_intent_repository_policy_fkey
  FOREIGN KEY(owner_id,project_id,repository_policy_version_id)
  REFERENCES delivery_repository_policy_versions(owner_id,project_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE UNIQUE INDEX delivery_task_repository_policy_project_key ON delivery_tasks(owner_id,project_id,id);

CREATE TABLE delivery_task_policy_bindings (
  owner_id UUID NOT NULL,
  task_id UUID NOT NULL,
  project_id UUID NOT NULL,
  intent_id UUID NOT NULL,
  policy_version_id UUID NOT NULL,
  policy_digest TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  intent_text_digest TEXT NOT NULL,
  outcome_digest TEXT NOT NULL,
  source_base TEXT NOT NULL,
  compiled_evidence_policy JSONB NOT NULL,
  criterion_coverage JSONB NOT NULL,
  pending_requirements JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(owner_id,task_id),
  CONSTRAINT delivery_task_policy_task_fkey FOREIGN KEY(owner_id,project_id,task_id)
    REFERENCES delivery_tasks(owner_id,project_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT delivery_task_policy_intent_fkey FOREIGN KEY(owner_id,project_id,intent_id)
    REFERENCES project_task_intents(owner_id,project_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT delivery_task_policy_version_fkey FOREIGN KEY(owner_id,project_id,policy_version_id)
    REFERENCES delivery_repository_policy_versions(owner_id,project_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT delivery_task_policy_bounds CHECK (
    policy_digest ~ '^[a-f0-9]{64}$' AND binding_digest ~ '^[a-f0-9]{64}$'
    AND intent_text_digest ~ '^[a-f0-9]{64}$' AND outcome_digest ~ '^[a-f0-9]{64}$'
    AND source_base ~ '^[a-f0-9]{40}$'
    AND jsonb_typeof(compiled_evidence_policy)='object'
    AND jsonb_typeof(criterion_coverage)='array' AND jsonb_typeof(pending_requirements)='array'
    AND jsonb_array_length(criterion_coverage)<=640 AND jsonb_array_length(pending_requirements)<=4480
    AND octet_length(compiled_evidence_policy::text)+octet_length(criterion_coverage::text)+octet_length(pending_requirements::text)<=73728
  )
);

CREATE FUNCTION hive_repository_policy_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_version INTEGER; next_version INTEGER; project_row RECORD;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Repository policy history is retained'; END IF;
  IF TG_TABLE_NAME='delivery_repository_policies' THEN
    SELECT provider,provider_repository_id,provider_account_id,full_name INTO project_row
      FROM delivery_projects WHERE owner_id=NEW.owner_id AND id=NEW.project_id;
    IF project_row IS NULL OR project_row.provider IS DISTINCT FROM NEW.provider
      OR project_row.provider_repository_id IS DISTINCT FROM NEW.repository_id
      OR project_row.provider_account_id IS DISTINCT FROM NEW.provider_account_id
      OR project_row.full_name IS DISTINCT FROM NEW.full_name THEN
      RAISE EXCEPTION 'Repository policy requires the exact owned project';
    END IF;
    IF TG_OP='INSERT' AND (NEW.generation<>1 OR NEW.active_version_id IS NOT NULL OR NEW.revoked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Repository policy starts without an active version';
    END IF;
    IF TG_OP='UPDATE' THEN
      IF (to_jsonb(NEW)-ARRAY['active_version_id','generation','revoked_at']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['active_version_id','generation','revoked_at'])
        OR NEW.generation<>OLD.generation+1 OR OLD.revoked_at IS NOT NULL
        OR (NEW.active_version_id IS NOT DISTINCT FROM OLD.active_version_id AND NEW.revoked_at IS NULL) THEN
        RAISE EXCEPTION 'Repository policy activation/revocation is fenced';
      END IF;
      IF NEW.active_version_id IS DISTINCT FROM OLD.active_version_id THEN
        SELECT version INTO previous_version FROM delivery_repository_policy_versions WHERE id=OLD.active_version_id;
        SELECT version INTO next_version FROM delivery_repository_policy_versions WHERE owner_id=NEW.owner_id AND policy_id=NEW.id AND id=NEW.active_version_id AND revoked_at IS NULL;
        IF next_version IS NULL OR next_version<=COALESCE(previous_version,0) THEN
          RAISE EXCEPTION 'Repository policy cannot roll back to an older version';
        END IF;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='delivery_repository_policy_versions' THEN
    IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
      OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'Repository policy versions are immutable';
    END IF;
  ELSIF TG_TABLE_NAME='delivery_task_policy_bindings' THEN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Task policy binding is immutable'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM project_task_intents i JOIN delivery_repository_policy_versions v
        ON v.owner_id=i.owner_id AND v.project_id=i.project_id AND v.id=i.repository_policy_version_id
      JOIN delivery_tasks t ON t.owner_id=i.owner_id AND t.project_id=i.project_id AND t.id=NEW.task_id
      JOIN delivery_manager_bindings m ON m.owner_id=t.owner_id AND m.id=t.manager_binding_id
      WHERE i.owner_id=NEW.owner_id AND i.project_id=NEW.project_id AND i.id=NEW.intent_id
        AND i.repository_policy_version_id=NEW.policy_version_id AND i.repository_policy_digest=NEW.policy_digest
        AND v.policy_digest=NEW.policy_digest AND i.intent_text_digest=NEW.intent_text_digest
        AND i.source_sha=NEW.source_base AND m.preparation_intent_id=i.id
        AND m.source_sha=NEW.source_base AND t.source_sha=NEW.source_base
        AND t.source_version=0 AND t.source_revision_id IS NULL
    ) THEN RAISE EXCEPTION 'Task policy requires its exact pinned preparation intent'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hive_repository_policy_integrity BEFORE INSERT OR UPDATE OR DELETE ON delivery_repository_policies
  FOR EACH ROW EXECUTE FUNCTION hive_repository_policy_integrity();
CREATE TRIGGER hive_repository_policy_version_integrity BEFORE INSERT OR UPDATE OR DELETE ON delivery_repository_policy_versions
  FOR EACH ROW EXECUTE FUNCTION hive_repository_policy_integrity();
CREATE TRIGGER hive_task_policy_integrity BEFORE INSERT OR UPDATE OR DELETE ON delivery_task_policy_bindings
  FOR EACH ROW EXECUTE FUNCTION hive_repository_policy_integrity();

CREATE FUNCTION hive_intent_repository_policy_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    -- Serialize new intent insertion with the enrollment transaction's project
    -- lock: flag-off/new-task races cannot create a post-enrollment legacy path.
    PERFORM id FROM delivery_projects WHERE owner_id=NEW.owner_id AND id=NEW.project_id FOR SHARE;
    IF NEW.repository_policy_version_id IS NULL AND EXISTS (
      SELECT 1 FROM delivery_repository_policies WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id
    ) THEN RAISE EXCEPTION 'An enrolled repository cannot create an unbound intent'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.repository_policy_version_id,NEW.repository_policy_digest,NEW.intent_text_digest)
    IS DISTINCT FROM ROW(OLD.repository_policy_version_id,OLD.repository_policy_digest,OLD.intent_text_digest) THEN
    RAISE EXCEPTION 'Existing intent policy cannot be adopted or replaced';
  END IF;
  IF TG_OP='INSERT' AND NEW.repository_policy_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM delivery_repository_policy_versions v JOIN delivery_repository_policies p
      ON p.owner_id=v.owner_id AND p.project_id=v.project_id AND p.id=v.policy_id
    WHERE v.owner_id=NEW.owner_id AND v.project_id=NEW.project_id AND v.id=NEW.repository_policy_version_id
      AND v.policy_digest=NEW.repository_policy_digest AND v.revoked_at IS NULL AND p.revoked_at IS NULL
      AND p.active_version_id=v.id AND p.repository_id=NEW.repository_id AND p.provider_account_id=NEW.provider_account_id
  ) THEN RAISE EXCEPTION 'New intent requires the active verified repository policy'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hive_intent_repository_policy_integrity BEFORE INSERT OR UPDATE ON project_task_intents
  FOR EACH ROW EXECUTE FUNCTION hive_intent_repository_policy_integrity();

REVOKE ALL ON delivery_repository_policies,delivery_repository_policy_versions,delivery_task_policy_bindings FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hive_app_runtime') THEN
    GRANT SELECT,INSERT,UPDATE ON delivery_repository_policies,delivery_repository_policy_versions,delivery_task_policy_bindings TO hive_app_runtime;
    REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_repository_policies,delivery_repository_policy_versions,delivery_task_policy_bindings FROM hive_app_runtime;
  END IF;
END $$;

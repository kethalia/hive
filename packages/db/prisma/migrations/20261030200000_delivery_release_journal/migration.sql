-- A target is a shared physical deployment boundary, not an owner-scoped lock.
-- Unknown or failed work retains ownership; an expired process lease does not
-- release it. No migration creates a policy, release, target or provider grant.
CREATE TABLE delivery_release_targets (
  target_digest text PRIMARY KEY CHECK(target_digest ~ '^[a-f0-9]{64}$'),
  active_release_id uuid,
  generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE delivery_release_target_members (
  resource_digest text PRIMARY KEY CHECK(resource_digest ~ '^[a-f0-9]{64}$'),
  target_digest text NOT NULL REFERENCES delivery_release_targets(target_digest) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(target_digest,resource_digest)
);
CREATE FUNCTION hive_release_target_member_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'release_target_member_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER release_target_member_immutable BEFORE UPDATE OR DELETE ON delivery_release_target_members
  FOR EACH ROW EXECUTE FUNCTION hive_release_target_member_immutable();
CREATE TABLE delivery_releases (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  task_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  target_digest text NOT NULL REFERENCES delivery_release_targets(target_digest) ON DELETE RESTRICT,
  policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=32768),
  snapshot_digest text NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
  phase text NOT NULL DEFAULT 'active' CHECK(phase IN ('active','held','healthy','recovered')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,id), UNIQUE(id,target_digest),
  FOREIGN KEY(owner_id,task_id,source_revision_id) REFERENCES delivery_source_revisions(owner_id,task_id,id) ON DELETE RESTRICT
);
ALTER TABLE delivery_release_targets ADD CONSTRAINT delivery_release_target_active_fkey
  FOREIGN KEY(active_release_id,target_digest) REFERENCES delivery_releases(id,target_digest) ON DELETE RESTRICT;
CREATE TABLE delivery_release_actions (
  id uuid PRIMARY KEY,
  release_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('merge','promote','recover')),
  target_digest text NOT NULL CHECK(target_digest ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=32768),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  generation integer NOT NULL CHECK(generation>0),
  phase text NOT NULL DEFAULT 'prepared' CHECK(phase IN ('prepared','effect_started','held','observed','canceled')),
  remote_reference jsonb CHECK(remote_reference IS NULL OR (jsonb_typeof(remote_reference)='object' AND octet_length(remote_reference::text)<=4096)),
  receipt_digest text CHECK(receipt_digest IS NULL OR receipt_digest ~ '^[a-f0-9]{64}$'),
  receipt jsonb CHECK(receipt IS NULL OR (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=32768)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(release_id,kind,request_digest),
  FOREIGN KEY(release_id,target_digest) REFERENCES delivery_releases(id,target_digest) ON DELETE RESTRICT,
  CHECK((phase='observed')=(receipt_digest IS NOT NULL AND receipt IS NOT NULL)),
  CHECK((receipt IS NULL)=(receipt_digest IS NULL))
);
CREATE UNIQUE INDEX delivery_release_action_inflight ON delivery_release_actions(release_id)
  WHERE phase IN ('prepared','effect_started','held');
CREATE TABLE delivery_release_observations (
  id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES delivery_releases(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK(kind IN ('stage_ready','healthy','regression','recovered')),
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=32768),
  evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(release_id,kind,evidence_digest)
);
CREATE FUNCTION hive_release_observation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'release_observation_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER release_observation_immutable BEFORE UPDATE OR DELETE ON delivery_release_observations
  FOR EACH ROW EXECUTE FUNCTION hive_release_observation_immutable();
CREATE FUNCTION hive_release_action_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target delivery_release_targets;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'release_action_immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.phase<>'prepared' OR NEW.receipt_digest IS NOT NULL OR NEW.receipt IS NOT NULL OR NEW.remote_reference IS NOT NULL THEN
      RAISE EXCEPTION 'release_action_initial_state' USING ERRCODE='23514'; END IF;
    SELECT * INTO target FROM delivery_release_targets WHERE target_digest=NEW.target_digest FOR UPDATE;
    IF NOT FOUND OR target.active_release_id IS DISTINCT FROM NEW.release_id OR target.generation<>NEW.generation THEN
      RAISE EXCEPTION 'release_action_fence' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.release_id,NEW.kind,NEW.target_digest,NEW.request,NEW.request_digest,NEW.generation,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.release_id,OLD.kind,OLD.target_digest,OLD.request,OLD.request_digest,OLD.generation,OLD.created_at)
    OR NOT ((OLD.phase='prepared' AND NEW.phase IN ('effect_started','canceled'))
      OR (OLD.phase='effect_started' AND NEW.phase IN ('held','observed'))
      OR (OLD.phase='held' AND NEW.phase='observed')) THEN
    RAISE EXCEPTION 'release_action_transition' USING ERRCODE='23514'; END IF;
  IF NEW.remote_reference IS DISTINCT FROM OLD.remote_reference AND NOT
    (OLD.phase='effect_started' AND NEW.phase='held' AND OLD.remote_reference IS NULL AND NEW.remote_reference IS NOT NULL) THEN
    RAISE EXCEPTION 'release_action_reference_immutable' USING ERRCODE='23514'; END IF;
  IF NEW.phase IN ('effect_started','observed') THEN
    SELECT * INTO target FROM delivery_release_targets WHERE target_digest=NEW.target_digest FOR UPDATE;
    IF NOT FOUND OR target.active_release_id IS DISTINCT FROM NEW.release_id OR target.generation<>NEW.generation THEN
      RAISE EXCEPTION 'release_action_fence' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_action_transition BEFORE INSERT OR UPDATE OR DELETE ON delivery_release_actions
  FOR EACH ROW EXECUTE FUNCTION hive_release_action_transition();
CREATE FUNCTION hive_release_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'release_history_immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.phase<>'active' THEN RAISE EXCEPTION 'release_initial_state' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.owner_id,NEW.task_id,NEW.source_revision_id,NEW.target_digest,NEW.policy_digest,NEW.snapshot,NEW.snapshot_digest,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.owner_id,OLD.task_id,OLD.source_revision_id,OLD.target_digest,OLD.policy_digest,OLD.snapshot,OLD.snapshot_digest,OLD.created_at)
    OR NOT ((OLD.phase='active' AND NEW.phase IN ('held','healthy')) OR (OLD.phase='held' AND NEW.phase='recovered')) THEN
    RAISE EXCEPTION 'release_transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_identity BEFORE INSERT OR UPDATE OR DELETE ON delivery_releases
  FOR EACH ROW EXECUTE FUNCTION hive_release_identity();
CREATE FUNCTION hive_release_target_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_phase text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'release_target_immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.active_release_id IS NOT NULL OR NEW.generation<>0 THEN
      RAISE EXCEPTION 'release_target_initial_state' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.target_digest,NEW.created_at) IS DISTINCT FROM ROW(OLD.target_digest,OLD.created_at) THEN
    RAISE EXCEPTION 'release_target_immutable' USING ERRCODE='23514'; END IF;
  IF OLD.active_release_id IS NULL AND NEW.active_release_id IS NOT NULL AND NEW.generation=OLD.generation+1 THEN
    RETURN NEW;
  END IF;
  IF OLD.active_release_id IS NOT NULL AND NEW.active_release_id IS NULL AND NEW.generation=OLD.generation THEN
    SELECT phase INTO prior_phase FROM delivery_releases WHERE id=OLD.active_release_id;
    IF prior_phase IN ('healthy','recovered') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'release_target_transition' USING ERRCODE='23514';
END $$;
CREATE TRIGGER release_target_transition BEFORE INSERT OR UPDATE OR DELETE ON delivery_release_targets
  FOR EACH ROW EXECUTE FUNCTION hive_release_target_transition();
REVOKE ALL ON delivery_release_targets,delivery_release_target_members,delivery_releases,delivery_release_actions,delivery_release_observations FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hive_app_runtime') THEN
    GRANT SELECT,INSERT,UPDATE ON delivery_release_targets,delivery_releases,delivery_release_actions TO hive_app_runtime;
    GRANT SELECT,INSERT ON delivery_release_target_members TO hive_app_runtime;
    GRANT SELECT,INSERT ON delivery_release_observations TO hive_app_runtime;
    REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_release_targets,delivery_releases,delivery_release_actions FROM hive_app_runtime;
    REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_release_observations FROM hive_app_runtime;
    REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON delivery_release_target_members FROM hive_app_runtime;
  END IF;
END $$;

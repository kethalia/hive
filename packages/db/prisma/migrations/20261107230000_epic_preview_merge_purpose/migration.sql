-- Preview integration is an attributed GitHub merge, never production health.
ALTER TABLE delivery_releases ADD COLUMN purpose text NOT NULL DEFAULT 'deployment'
  CHECK (purpose IN ('deployment','epic_preview_integration'));
ALTER TABLE delivery_releases DROP CONSTRAINT delivery_releases_phase_check;
ALTER TABLE delivery_releases ADD CONSTRAINT delivery_releases_phase_check
  CHECK ((purpose='deployment' AND phase IN ('active','held','healthy','recovered'))
    OR (purpose='epic_preview_integration' AND phase IN ('active','held','integrated')));
CREATE OR REPLACE FUNCTION hive_release_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'release_history_immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.phase<>'active' OR (NEW.purpose='epic_preview_integration' AND NEW.snapshot->>'purpose' IS DISTINCT FROM NEW.purpose)
      THEN RAISE EXCEPTION 'release_initial_state' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.owner_id,NEW.task_id,NEW.source_revision_id,NEW.target_digest,NEW.policy_digest,NEW.snapshot,NEW.snapshot_digest,NEW.created_at,NEW.purpose)
    IS DISTINCT FROM ROW(OLD.id,OLD.owner_id,OLD.task_id,OLD.source_revision_id,OLD.target_digest,OLD.policy_digest,OLD.snapshot,OLD.snapshot_digest,OLD.created_at,OLD.purpose)
    OR NOT ((OLD.purpose='deployment' AND ((OLD.phase='active' AND NEW.phase IN ('held','healthy')) OR (OLD.phase='held' AND NEW.phase='recovered')))
      OR (OLD.purpose='epic_preview_integration' AND OLD.phase='active' AND NEW.phase IN ('held','integrated'))) THEN
    RAISE EXCEPTION 'release_transition' USING ERRCODE='23514'; END IF;
  IF NEW.phase='integrated' AND (NOT EXISTS (
    SELECT 1 FROM delivery_release_actions a WHERE a.release_id=NEW.id AND a.kind='merge' AND a.phase='observed'
      AND a.receipt->>'provider'='github' AND a.receipt->>'headSha'=NEW.snapshot->>'sourceSha'
      AND a.receipt->>'requestId' ~ '^[a-f0-9-]{36}$' AND a.receipt->>'mergeSha' ~ '^[a-f0-9]{40}$'
    ) OR EXISTS (SELECT 1 FROM delivery_release_actions a WHERE a.release_id=NEW.id AND (a.kind<>'merge' OR a.phase<>'observed'))) THEN
    RAISE EXCEPTION 'release_integration_receipt_required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hive_release_target_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_phase text; prior_purpose text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'release_target_immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.active_release_id IS NOT NULL OR NEW.generation<>0 THEN RAISE EXCEPTION 'release_target_initial_state' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.target_digest,NEW.created_at) IS DISTINCT FROM ROW(OLD.target_digest,OLD.created_at) THEN
    RAISE EXCEPTION 'release_target_immutable' USING ERRCODE='23514'; END IF;
  IF OLD.active_release_id IS NULL AND NEW.active_release_id IS NOT NULL AND NEW.generation=OLD.generation+1 THEN RETURN NEW; END IF;
  IF OLD.active_release_id IS NOT NULL AND NEW.active_release_id IS NULL AND NEW.generation=OLD.generation THEN
    SELECT phase,purpose INTO prior_phase,prior_purpose FROM delivery_releases WHERE id=OLD.active_release_id;
    IF (prior_purpose='deployment' AND prior_phase IN ('healthy','recovered'))
      OR (prior_purpose='epic_preview_integration' AND prior_phase='integrated') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'release_target_transition' USING ERRCODE='23514';
END $$;
CREATE FUNCTION hive_preview_merge_action_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind<>'merge' AND EXISTS (SELECT 1 FROM delivery_releases r WHERE r.id=NEW.release_id AND r.purpose='epic_preview_integration') THEN
    RAISE EXCEPTION 'release_integration_merge_only' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preview_merge_action_scope BEFORE INSERT ON delivery_release_actions
  FOR EACH ROW EXECUTE FUNCTION hive_preview_merge_action_scope();

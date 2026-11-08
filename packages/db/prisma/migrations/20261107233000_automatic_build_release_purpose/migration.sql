-- Existing connected Builds are observed after a journaled GitHub merge. No deployment grant is created.
ALTER TABLE delivery_releases DROP CONSTRAINT delivery_releases_purpose_check;
ALTER TABLE delivery_releases ADD CONSTRAINT delivery_releases_purpose_check CHECK (purpose IN ('deployment','epic_preview_integration','automatic_production'));
ALTER TABLE delivery_releases DROP CONSTRAINT delivery_releases_phase_check;
ALTER TABLE delivery_releases ADD CONSTRAINT delivery_releases_phase_check CHECK (
  (purpose='deployment' AND phase IN ('active','held','healthy','recovered')) OR
  (purpose='epic_preview_integration' AND phase IN ('active','held','integrated')) OR
  (purpose='automatic_production' AND phase IN ('active','held','healthy')));
ALTER TABLE delivery_release_observations DROP CONSTRAINT delivery_release_observations_kind_check;
ALTER TABLE delivery_release_observations ADD CONSTRAINT delivery_release_observations_kind_check
  CHECK (kind IN ('stage_ready','healthy','regression','recovered','automatic_health'));
CREATE OR REPLACE FUNCTION hive_release_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'release_history_immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.phase<>'active' OR (NEW.purpose IN ('epic_preview_integration','automatic_production') AND NEW.snapshot->>'purpose' IS DISTINCT FROM NEW.purpose)
      THEN RAISE EXCEPTION 'release_initial_state' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.owner_id,NEW.task_id,NEW.source_revision_id,NEW.target_digest,NEW.policy_digest,NEW.snapshot,NEW.snapshot_digest,NEW.created_at,NEW.purpose)
    IS DISTINCT FROM ROW(OLD.id,OLD.owner_id,OLD.task_id,OLD.source_revision_id,OLD.target_digest,OLD.policy_digest,OLD.snapshot,OLD.snapshot_digest,OLD.created_at,OLD.purpose)
    OR NOT ((OLD.purpose='deployment' AND ((OLD.phase='active' AND NEW.phase IN ('held','healthy')) OR (OLD.phase='held' AND NEW.phase='recovered')))
      OR (OLD.purpose='epic_preview_integration' AND OLD.phase='active' AND NEW.phase IN ('held','integrated'))
      OR (OLD.purpose='automatic_production' AND ((OLD.phase='active' AND NEW.phase IN ('held','healthy')) OR (OLD.phase='healthy' AND NEW.phase='held')))) THEN
    RAISE EXCEPTION 'release_transition' USING ERRCODE='23514'; END IF;
  IF NEW.phase='integrated' AND (NOT EXISTS (
    SELECT 1 FROM delivery_release_actions a WHERE a.release_id=NEW.id AND a.kind='merge' AND a.phase='observed'
      AND a.receipt->>'provider'='github' AND a.receipt->>'headSha'=NEW.snapshot->>'sourceSha'
      AND a.receipt->>'requestId' ~ '^[a-f0-9-]{36}$' AND a.receipt->>'mergeSha' ~ '^[a-f0-9]{40}$'
    ) OR EXISTS (SELECT 1 FROM delivery_release_actions a WHERE a.release_id=NEW.id AND (a.kind<>'merge' OR a.phase<>'observed'))) THEN
    RAISE EXCEPTION 'release_integration_receipt_required' USING ERRCODE='23514'; END IF;
  IF NEW.purpose='automatic_production' AND NEW.phase='healthy' AND (
    (SELECT count(*) FROM delivery_release_observations o WHERE o.release_id=NEW.id AND o.kind='automatic_health')<2
    OR COALESCE((SELECT extract(epoch FROM (max(o.created_at)-min(o.created_at)))*1000 FROM delivery_release_observations o WHERE o.release_id=NEW.id AND o.kind='automatic_health'),0)<(NEW.snapshot->>'observationWindowMs')::bigint
    OR
    NOT EXISTS (SELECT 1 FROM delivery_release_actions a WHERE a.release_id=NEW.id AND a.kind='merge' AND a.phase='observed'
      AND a.receipt->>'provider'='github' AND a.receipt->>'headSha'=NEW.snapshot->>'sourceSha'
      AND a.receipt->>'mergeSha' ~ '^[a-f0-9]{40}$')
    OR EXISTS (SELECT 1 FROM delivery_release_actions a WHERE a.release_id=NEW.id AND (a.kind<>'merge' OR a.phase<>'observed'))
    OR NOT EXISTS (SELECT 1 FROM delivery_release_observations o JOIN delivery_release_actions a ON a.release_id=o.release_id AND a.kind='merge'
      WHERE o.release_id=NEW.id AND o.kind='automatic_health' AND o.evidence->>'mergeSha'=a.receipt->>'mergeSha'
        AND o.evidence->>'coverage'='fixed-origin-db-auth-smoke'
        AND o.evidence#>>'{health,build,sourceSha}'=a.receipt->>'mergeSha'
        AND o.evidence#>>'{health,build,branch}'='main'
        AND o.evidence#>>'{check,appId}'='85455' AND o.evidence#>>'{check,conclusion}'='success'
        AND o.evidence#>>'{health,readiness,database}'='true' AND o.evidence#>>'{health,readiness,authentication}'='true')
  ) THEN RAISE EXCEPTION 'release_automatic_health_required' USING ERRCODE='23514'; END IF;
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
      OR (prior_purpose='epic_preview_integration' AND prior_phase='integrated')
      OR (prior_purpose='automatic_production' AND prior_phase='healthy'
        AND NOT EXISTS (SELECT 1 FROM delivery_steps s JOIN delivery_releases r ON r.owner_id=s.owner_id AND r.task_id=s.task_id WHERE r.id=OLD.active_release_id AND s.acceptance_phase='activation_production' AND s.state<>'succeeded')
        AND (NOT EXISTS (SELECT 1 FROM delivery_steps s JOIN delivery_releases r ON r.owner_id=s.owner_id AND r.task_id=s.task_id WHERE r.id=OLD.active_release_id AND s.acceptance_phase='activation_production')
          OR EXISTS (SELECT 1 FROM delivery_events e JOIN delivery_releases r ON r.owner_id=e.owner_id AND r.task_id=e.task_id WHERE r.id=OLD.active_release_id AND e.aggregate_key='automatic-acceptance-finalized/'||r.id::text AND e.aggregate_version=1 AND e.type='production_acceptance_finalized' AND e.payload->>'releaseId'=r.id::text))) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'release_target_transition' USING ERRCODE='23514';
END $$;
CREATE OR REPLACE FUNCTION hive_preview_merge_action_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind<>'merge' AND EXISTS (SELECT 1 FROM delivery_releases r WHERE r.id=NEW.release_id AND r.purpose IN ('epic_preview_integration','automatic_production')) THEN
    RAISE EXCEPTION 'release_integration_merge_only' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

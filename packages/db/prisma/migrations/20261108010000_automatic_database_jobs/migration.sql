-- Reuse the release journal for controlled database workflow effects.
-- Provisional catalog/plan intent is distinct from authenticated plan approval.
ALTER TABLE delivery_release_actions DROP CONSTRAINT delivery_release_actions_kind_check;
ALTER TABLE delivery_release_actions ADD CONSTRAINT delivery_release_actions_kind_check
  CHECK (kind IN ('merge','promote','recover','database_job'));
ALTER TABLE delivery_release_observations DROP CONSTRAINT delivery_release_observations_kind_check;
ALTER TABLE delivery_release_observations ADD CONSTRAINT delivery_release_observations_kind_check
  CHECK (kind IN ('stage_ready','healthy','regression','recovered','automatic_health','automatic_baseline'));
CREATE OR REPLACE FUNCTION hive_preview_merge_action_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r delivery_releases;
BEGIN
  SELECT * INTO r FROM delivery_releases WHERE id=NEW.release_id;
  IF NEW.kind='database_job' THEN
    IF r.purpose IS DISTINCT FROM 'automatic_production' OR r.snapshot->>'riskClass' IS DISTINCT FROM 'database'
      OR r.snapshot#>>'{database,phase}' IS DISTINCT FROM 'plan_intent'
      OR NEW.request->>'purpose' IS DISTINCT FROM 'automatic-database-job'
      OR NEW.request->>'ownerId' IS DISTINCT FROM r.owner_id::text OR NEW.request->>'taskId' IS DISTINCT FROM r.task_id::text
      OR NEW.request->>'releaseId' IS DISTINCT FROM r.id::text OR NEW.request->>'targetDigest' IS DISTINCT FROM r.target_digest
      OR NEW.request->>'sourceSha' IS DISTINCT FROM r.snapshot->>'sourceSha'
      OR NEW.request->>'catalogDigest' IS DISTINCT FROM r.snapshot#>>'{database,catalogDigest}'
      OR NEW.request->>'planDigest' IS DISTINCT FROM r.snapshot#>>'{database,planDigest}'
      OR NEW.request->>'generation' IS DISTINCT FROM NEW.generation::text
      OR COALESCE(NEW.request->>'dispatchId','') !~ '^[a-f0-9-]{36}$'
      OR COALESCE(NEW.request->>'stage','') NOT IN ('approve','advance','activate')
      OR ((NEW.request->>'stage'='approve') IS DISTINCT FROM (NEW.request->>'planEventId' IS NULL)) THEN
      RAISE EXCEPTION 'release_database_action_scope' USING ERRCODE='23514'; END IF;
  ELSIF NEW.kind='merge' AND r.purpose='automatic_production' AND r.snapshot->>'riskClass'='database' THEN
    IF NEW.id::text IS DISTINCT FROM r.snapshot#>>'{database,mergeActionId}' OR
      NEW.request_digest IS DISTINCT FROM r.snapshot#>>'{database,mergeRequestDigest}' THEN
      RAISE EXCEPTION 'release_database_merge_reservation_required' USING ERRCODE='23514'; END IF;
  ELSIF NEW.kind<>'merge' AND r.purpose IN ('epic_preview_integration','automatic_production') THEN
    RAISE EXCEPTION 'release_integration_merge_only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION hive_automatic_database_effect_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r delivery_releases;
BEGIN
  IF OLD.phase='prepared' AND NEW.phase='effect_started' AND NEW.kind='merge' THEN
    SELECT * INTO r FROM delivery_releases WHERE id=NEW.release_id;
    IF r.purpose='automatic_production' AND r.snapshot->>'riskClass'='database' AND NOT EXISTS (
      SELECT 1 FROM delivery_events e WHERE e.owner_id=r.owner_id AND e.task_id=r.task_id
        AND e.type='database_merge_authorized' AND e.aggregate_key='database-merge-authorized/'||NEW.id::text AND e.aggregate_version=1
        AND e.payload->>'actionId'=NEW.id::text AND e.payload->>'releaseId'=r.id::text
        AND e.payload->>'requestDigest'=NEW.request_digest AND e.payload->>'generation'=NEW.generation::text
        AND e.payload->>'catalogDigest'=r.snapshot#>>'{database,catalogDigest}'
        AND e.payload->>'planDigest'=r.snapshot#>>'{database,planDigest}'
        AND (e.payload->>'observedAt')::numeric <= extract(epoch FROM clock_timestamp())*1000
        AND (e.payload->>'expiresAt')::numeric > extract(epoch FROM clock_timestamp())*1000
        AND (e.payload->>'expiresAt')::numeric > (e.payload->>'observedAt')::numeric
        AND (e.payload->>'expiresAt')::numeric <= (e.payload->>'observedAt')::numeric+30000
    ) THEN RAISE EXCEPTION 'release_database_fresh_effect_required' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automatic_database_effect_scope BEFORE UPDATE ON delivery_release_actions
  FOR EACH ROW EXECUTE FUNCTION hive_automatic_database_effect_scope();
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
    OR EXISTS (SELECT 1 FROM delivery_release_actions a WHERE a.release_id=NEW.id AND (a.kind NOT IN ('merge','database_job') OR a.phase<>'observed'))
    OR NOT EXISTS (SELECT 1 FROM delivery_release_observations o JOIN delivery_release_actions a ON a.release_id=o.release_id AND a.kind='merge'
      WHERE o.release_id=NEW.id AND o.kind='automatic_health' AND o.evidence->>'mergeSha'=a.receipt->>'mergeSha'
        AND o.evidence->>'coverage'='fixed-origin-db-auth-smoke'
        AND o.evidence#>>'{health,build,sourceSha}'=a.receipt->>'mergeSha'
        AND o.evidence#>>'{health,build,branch}'='main'
        AND o.evidence#>>'{check,appId}'='85455' AND o.evidence#>>'{check,conclusion}'='success'
        AND o.evidence#>>'{health,readiness,database}'='true' AND o.evidence#>>'{health,readiness,authentication}'='true')
    OR (NEW.snapshot->>'riskClass'='database' AND (
      NEW.snapshot#>>'{database,phase}' IS DISTINCT FROM 'plan_intent'
      OR NOT EXISTS (SELECT 1 FROM delivery_release_actions a WHERE a.release_id=NEW.id AND a.kind='database_job' AND a.phase='observed' AND a.request->>'stage'='approve')
      OR NOT EXISTS (SELECT 1 FROM delivery_release_actions a WHERE a.release_id=NEW.id AND a.kind='database_job' AND a.phase='observed' AND a.request->>'stage'='advance')
      OR NOT EXISTS (
        SELECT 1 FROM delivery_release_actions a JOIN delivery_events e ON e.owner_id=NEW.owner_id AND e.task_id=NEW.task_id AND e.type='database_job_observed'
        WHERE a.release_id=NEW.id AND a.kind='database_job' AND a.phase='observed' AND a.request->>'stage'='activate'
          AND e.payload#>>'{request,releaseId}'=NEW.id::text AND e.payload#>>'{request,dispatchId}'=a.request->>'dispatchId'
          AND e.payload#>>'{request,githubRunId}'=a.receipt->>'runId'
          AND e.payload#>>'{request,observation,phase}'='activated'
          AND e.payload#>>'{request,observation,activationReceiptDigest}' ~ '^[a-f0-9]{64}$'
          AND e.payload#>>'{request,observation,integrity,violations}'='0')
      OR NOT EXISTS (
        SELECT 1 FROM delivery_release_observations o WHERE o.release_id=NEW.id AND o.kind='automatic_health'
          AND o.evidence->>'treeSha'=NEW.snapshot#>>'{tested,treeSha}'
          AND o.evidence#>>'{health,databaseEndpointDigest}'=NEW.snapshot#>>'{database,baseline,health,databaseEndpointDigest}')
    ))
  ) THEN RAISE EXCEPTION 'release_automatic_health_required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

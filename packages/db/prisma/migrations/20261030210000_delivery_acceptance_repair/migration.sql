-- Preserve the physical writer and all ordinary progression fences. Only an
-- exact controller-reserved, ready and atomically consumed same-step repair
-- may move a failed logical cursor; a generic failed attempt remains blocked.
CREATE OR REPLACE FUNCTION hive_delivery_manager_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof JSONB;
BEGIN
  IF (to_jsonb(NEW) - ARRAY['active_attempt_id','current_attempt_id','cursor_version','native_sequence','blocked_reason','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['active_attempt_id','current_attempt_id','cursor_version','native_sequence','blocked_reason','updated_at']) THEN
    RAISE EXCEPTION 'Manager checkout identity is immutable';
  END IF;
  IF NEW.native_sequence < OLD.native_sequence THEN RAISE EXCEPTION 'Native source sequence cannot decrease'; END IF;
  IF OLD.blocked_reason IS NOT NULL AND NEW.blocked_reason IS NULL THEN
    RAISE EXCEPTION 'Blocked native lifetime requires explicit reviewed reconciliation';
  END IF;
  IF NEW.current_attempt_id IS DISTINCT FROM OLD.current_attempt_id THEN
    IF NEW.progression_protocol<>1 OR NEW.current_attempt_id IS NULL OR NEW.cursor_version<>OLD.cursor_version+1 THEN
      RAISE EXCEPTION 'Logical cursor requires monotonic protocol-one advancement';
    END IF;
    IF OLD.current_attempt_id IS NULL AND NEW.current_attempt_id IS DISTINCT FROM NEW.active_attempt_id THEN
      RAISE EXCEPTION 'First logical attempt must anchor its writer';
    END IF;
    IF OLD.current_attempt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM delivery_attempts old_attempt JOIN delivery_steps old_step
        ON old_step.owner_id=old_attempt.owner_id AND old_step.id=old_attempt.step_id
      JOIN delivery_attempts next_attempt ON next_attempt.owner_id=old_attempt.owner_id
        AND next_attempt.id=NEW.current_attempt_id
      JOIN delivery_steps next_step ON next_step.owner_id=next_attempt.owner_id AND next_step.id=next_attempt.step_id
      WHERE old_attempt.owner_id=OLD.owner_id AND old_attempt.id=OLD.current_attempt_id
        AND ((old_attempt.outcome IN ('reported','succeeded') AND old_step.state=old_attempt.outcome)
          OR (old_attempt.outcome='failed' AND old_step.id=next_step.id
            AND old_attempt.manager_binding_id=OLD.id AND next_attempt.manager_binding_id=OLD.id
            AND old_attempt.lease_expires_at>clock_timestamp()
            AND old_step.attempt_count<=old_step.attempt_budget
            AND EXISTS (
              SELECT 1 FROM delivery_events reserved
              JOIN delivery_events ready ON ready.owner_id=reserved.owner_id
                AND ready.aggregate_key=reserved.aggregate_key AND ready.aggregate_version=2
                AND ready.type='acceptance_repair_ready'
              JOIN delivery_events consumed ON consumed.owner_id=reserved.owner_id
                AND consumed.aggregate_key='repair-consumed/'||reserved.id::text
                AND consumed.aggregate_version=1 AND consumed.type='acceptance_repair_consumed'
              JOIN delivery_events claimed ON claimed.owner_id=consumed.owner_id
                AND claimed.id::text=consumed.payload->>'claimEventId' AND claimed.type='attempt_started'
              JOIN delivery_source_revisions output ON output.owner_id=old_attempt.owner_id AND output.id=old_attempt.output_revision_id
              JOIN delivery_tasks current_task ON current_task.owner_id=old_attempt.owner_id
                AND current_task.id=old_step.task_id
                AND current_task.manager_binding_id=OLD.id
                AND current_task.source_revision_id=output.id
                AND current_task.source_version=output.version
                AND current_task.source_sha=output.head_sha
              WHERE reserved.owner_id=OLD.owner_id AND reserved.type='acceptance_repair_reserved'
                AND reserved.aggregate_key='acceptance-repair/'||old_attempt.id::text AND reserved.aggregate_version=1
                AND reserved.attempt_id=old_attempt.id AND reserved.step_id=old_step.id AND reserved.task_id=old_step.task_id
                AND reserved.payload->>'repairId'=reserved.id::text AND reserved.payload->>'schemaVersion'='1'
                AND reserved.payload->>'ownerId'=OLD.owner_id::text AND reserved.payload->>'managerBindingId'=OLD.id::text
                AND reserved.payload->>'attemptId'=old_attempt.id::text AND reserved.payload->>'stepId'=old_step.id::text
                AND reserved.payload->>'taskId'=old_step.task_id::text
                AND reserved.payload->>'serverInstanceId'=OLD.server_instance_id
                AND reserved.payload->>'managerThreadId'=OLD.native_thread_id
                AND reserved.payload->>'preparationIntentId'=OLD.preparation_intent_id::text
                AND reserved.payload->>'cursorVersion'=OLD.cursor_version::text
                AND reserved.payload->>'leaseGeneration'=old_attempt.lease_generation::text
                AND (reserved.payload->>'leaseExpiresAt')::numeric=extract(epoch FROM old_attempt.lease_expires_at)*1000
                AND (reserved.payload->>'ordinal')::integer BETWEEN 1 AND 2
                AND reserved.payload->'sourceContext'->>'revisionId'=output.id::text
                AND reserved.payload->'sourceContext'->>'headSha'=output.head_sha
                AND reserved.payload->'sourceContext'->>'version'=output.version::text
                AND ready.attempt_id=old_attempt.id AND ready.step_id=old_step.id AND ready.task_id=old_step.task_id
                AND ready.payload->>'repairId'=reserved.id::text
                AND consumed.attempt_id=next_attempt.id AND consumed.step_id=old_step.id AND consumed.task_id=old_step.task_id
                AND consumed.payload->>'repairId'=reserved.id::text
                AND claimed.attempt_id=next_attempt.id AND claimed.step_id=old_step.id AND claimed.task_id=old_step.task_id
                AND claimed.payload->'nativeClaim'->>'managerThreadId'=OLD.native_thread_id
                AND claimed.payload->'nativeClaim'->>'cursorVersion'=NEW.cursor_version::text
            )))
        AND old_step.task_id=next_step.task_id AND COALESCE((SELECT head_sha FROM delivery_source_revisions r WHERE r.owner_id=old_attempt.owner_id AND r.id=old_attempt.output_revision_id),old_attempt.source_sha)=next_attempt.source_sha
        AND next_attempt.outcome='running' AND next_step.state='running'
    ) THEN RAISE EXCEPTION 'Previous logical attempt must be terminal in the same task/source'; END IF;
  ELSIF NEW.cursor_version<>OLD.cursor_version THEN
    RAISE EXCEPTION 'Logical cursor version cannot change without its attempt';
  END IF;
  IF OLD.active_attempt_id IS NOT NULL AND NEW.active_attempt_id IS DISTINCT FROM OLD.active_attempt_id THEN
    IF OLD.progression_protocol=1 THEN RAISE EXCEPTION 'Writer cohort drain is not implemented'; END IF;
    SELECT payload INTO proof FROM delivery_events
      WHERE owner_id=OLD.owner_id AND attempt_id=OLD.active_attempt_id
        AND type IN ('native_attempt_quiescent','native_attempt_observed')
      ORDER BY aggregate_version DESC LIMIT 1;
    IF NOT EXISTS (SELECT 1 FROM delivery_attempts WHERE owner_id=OLD.owner_id AND id=OLD.active_attempt_id AND quiesced_at IS NOT NULL)
      OR proof IS NULL OR proof->>'nativeTurn' IS DISTINCT FROM 'quiescent'
      OR proof->>'backgroundProcesses' IS DISTINCT FROM 'quiescent'
      OR proof->>'externalOperations' IS DISTINCT FROM 'quiescent'
      OR proof->>'externalEffects' IS DISTINCT FROM 'none' THEN
      RAISE EXCEPTION 'Previous native writer is not confirmed quiescent';
    END IF;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE delivery_manager_bindings
  ADD COLUMN current_attempt_id UUID,
  ADD COLUMN cursor_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN progression_protocol INTEGER NOT NULL DEFAULT 0;

ALTER TABLE delivery_manager_bindings ADD CONSTRAINT delivery_manager_current_attempt_fkey
  FOREIGN KEY (owner_id, id, current_attempt_id)
  REFERENCES delivery_attempts(owner_id, manager_binding_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE delivery_manager_bindings ADD CONSTRAINT delivery_manager_progression_shape_check CHECK (
  progression_protocol IN (0,1) AND cursor_version >= 0 AND
  ((progression_protocol=0 AND current_attempt_id IS NULL AND cursor_version=0) OR
   (progression_protocol=1 AND
    ((active_attempt_id IS NULL AND current_attempt_id IS NULL AND cursor_version=0) OR
     (active_attempt_id IS NOT NULL AND current_attempt_id IS NOT NULL AND cursor_version>0))))
);

-- Preserve the legacy anchor guard. Protocol-one anchors cannot retire until a
-- separately reviewed writer-cohort drain operation exists.
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
        AND old_attempt.outcome IN ('reported','succeeded') AND old_step.state=old_attempt.outcome
        AND old_step.task_id=next_step.task_id AND old_attempt.source_sha=next_attempt.source_sha
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

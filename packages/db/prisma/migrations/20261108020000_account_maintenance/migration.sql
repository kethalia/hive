-- Forward migration50. Existing completion closure remains the default. Control
-- metadata contains no credentials and never releases an unfinished writer.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE codex_host_slots
  ADD COLUMN account_maintenance jsonb,
  ADD COLUMN account_maintenance_version integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT codex_host_slots_account_maintenance_shape CHECK (
    account_maintenance_version >= 0 AND
    (account_maintenance IS NULL OR (
      jsonb_typeof(account_maintenance) = 'object' AND
      account_maintenance->>'schemaVersion' = '1' AND
      account_maintenance->>'purpose' = 'account-maintenance' AND
      account_maintenance->>'ownerId' = owner_id::text AND
      account_maintenance->>'workspaceId' = workspace_id::text AND
      account_maintenance->>'coderOwnerId' = coder_owner_id::text AND
      account_maintenance->>'coderOrigin' = coder_origin AND
      account_maintenance->>'phase' IN ('requested','waiting-boundary','closing','ready','resuming','held','finished') AND
      octet_length(account_maintenance::text) <= 32768
    ) IS TRUE)
  );
ALTER TABLE codex_guardian_barriers
  ADD COLUMN purpose text NOT NULL DEFAULT 'completion',
  ADD COLUMN maintenance_id uuid,
  ADD CONSTRAINT codex_guardian_barriers_purpose CHECK (
    (purpose = 'completion' AND maintenance_id IS NULL) OR
    (purpose = 'account-maintenance' AND maintenance_id IS NOT NULL)
  );
CREATE FUNCTION hive_account_maintenance_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_maintenance IS DISTINCT FROM OLD.account_maintenance THEN
    IF OLD.account_maintenance IS NOT NULL AND OLD.account_maintenance->>'phase'<>'finished'
      AND NEW.account_maintenance->>'phase' IS DISTINCT FROM OLD.account_maintenance->>'phase'
      AND NOT ((OLD.account_maintenance->>'phase',NEW.account_maintenance->>'phase') IN (
        ('requested','waiting-boundary'),('requested','closing'),('requested','held'),
        ('waiting-boundary','closing'),('waiting-boundary','held'),('closing','ready'),('closing','held'),
        ('ready','resuming'),('ready','held'),('resuming','finished'),('resuming','held'))) THEN
      RAISE EXCEPTION 'account_maintenance_phase_rejected';
    END IF;
    IF NEW.account_maintenance_version <> OLD.account_maintenance_version + 1 OR
       NEW.account_maintenance IS NULL THEN
      RAISE EXCEPTION 'account_maintenance_transition_rejected';
    END IF;
    IF OLD.account_maintenance IS NOT NULL AND OLD.account_maintenance->>'phase' <> 'finished' AND
       (NEW.account_maintenance->>'id' IS DISTINCT FROM OLD.account_maintenance->>'id' OR
        NEW.account_maintenance->>'buildId' IS DISTINCT FROM OLD.account_maintenance->>'buildId' OR
        NEW.account_maintenance->'runtimes' IS DISTINCT FROM OLD.account_maintenance->'runtimes' OR
        NEW.account_maintenance->'tasks' IS DISTINCT FROM OLD.account_maintenance->'tasks' OR
        NEW.account_maintenance->'projects' IS DISTINCT FROM OLD.account_maintenance->'projects' OR
        NEW.account_maintenance->>'requestedAt' IS DISTINCT FROM OLD.account_maintenance->>'requestedAt') THEN
      RAISE EXCEPTION 'account_maintenance_identity_immutable';
    END IF;
    IF OLD.account_maintenance->>'resumeRequestId' IS NOT NULL AND
      NOT (OLD.account_maintenance->>'phase'='finished' AND NEW.account_maintenance->>'phase'='requested'
        AND NEW.account_maintenance->>'id' IS DISTINCT FROM OLD.account_maintenance->>'id') AND
      (NEW.account_maintenance->>'resumeRequestId',NEW.account_maintenance->>'resumeIntentRuntimeId',NEW.account_maintenance->>'resumeIntentEventId',NEW.account_maintenance->>'idleRuntimeId')
      IS DISTINCT FROM (OLD.account_maintenance->>'resumeRequestId',OLD.account_maintenance->>'resumeIntentRuntimeId',OLD.account_maintenance->>'resumeIntentEventId',OLD.account_maintenance->>'idleRuntimeId') THEN
      RAISE EXCEPTION 'maintenance_owner_resume_identity_immutable';
    END IF;
  ELSIF NEW.account_maintenance_version <> OLD.account_maintenance_version THEN
    RAISE EXCEPTION 'account_maintenance_transition_rejected';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hive_account_maintenance_transition BEFORE UPDATE OF account_maintenance,account_maintenance_version
ON codex_host_slots FOR EACH ROW EXECUTE FUNCTION hive_account_maintenance_transition();

-- Owner-only intent, NOT a host/model operation. Keep the original receipt
-- runtime/admission/generation integrity trigger and append-only permissions.
ALTER TABLE codex_guardian_operation_receipts DROP CONSTRAINT guardian_operation_receipt_bounds;
ALTER TABLE codex_guardian_operation_receipts ADD CONSTRAINT guardian_operation_receipt_bounds CHECK (
  action IN ('prepare','checkout','native','fence','maintenance_resume_intent')
  AND request_digest ~ '^[a-f0-9]{64}$' AND response_digest ~ '^[a-f0-9]{64}$'
  AND config_sha256 ~ '^[a-f0-9]{64}$' AND outer_key_fingerprint ~ '^[a-f0-9]{64}$'
  AND input_runtime_generation>0 AND result_runtime_generation BETWEEN input_runtime_generation AND input_runtime_generation+1
  AND result_admission_generation>0 AND jsonb_typeof(response)='object' AND octet_length(response::text)<=65536
);
CREATE UNIQUE INDEX maintenance_owner_resume_request_history ON codex_guardian_operation_receipts
  (owner_id,(response->'maintenance'->>'requestId')) WHERE action='maintenance_resume_intent';
CREATE UNIQUE INDEX maintenance_native_intent_consumption ON codex_guardian_operation_receipts
  (owner_id,(response->'maintenanceRebind'->>'ownerIntentRuntimeId'),
    (response->'maintenanceRebind'->>'ownerIntentEventId'),(response->'admission'->>'preparationIntentId'))
  WHERE action='native' AND response->'maintenanceRebind' IS NOT NULL;

CREATE FUNCTION hive_account_maintenance_closure_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m jsonb:=NEW.account_maintenance;
BEGIN
  IF m IS NULL THEN RETURN NEW; END IF;
  IF m->>'phase' IN ('ready','resuming','finished') AND (
    jsonb_array_length(m->'runtimes')<>jsonb_array_length(m->'barrierIds') OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(m->'runtimes') p WHERE NOT EXISTS (
      SELECT 1 FROM codex_guardian_runtimes r
      JOIN codex_guardian_barriers b ON b.owner_id=r.owner_id AND b.id=r.closed_barrier_id
      JOIN codex_guardian_tree_receipts t ON t.owner_id=r.owner_id AND t.runtime_id=r.id AND t.barrier_id=b.id
      WHERE r.owner_id=NEW.owner_id AND r.id::text=p->>'runtimeId' AND r.phase='tree_closed'
        AND r.workspace_id=NEW.workspace_id AND r.build_id::text=m->>'buildId'
        AND b.purpose='account-maintenance' AND b.maintenance_id::text=m->>'id'
        AND m->'barrierIds' ? b.id::text AND m->'treeReceiptDigests' ? t.digest
    ))) THEN RAISE EXCEPTION 'maintenance_physical_closure_unverified'; END IF;
  IF m->>'phase' IN ('resuming','finished') AND NOT EXISTS (
    SELECT 1 FROM codex_guardian_operation_receipts receipt
    WHERE receipt.owner_id=NEW.owner_id AND receipt.runtime_id::text=m->>'resumeIntentRuntimeId'
      AND receipt.event_id::text=m->>'resumeIntentEventId' AND receipt.action='maintenance_resume_intent'
      AND receipt.response->'maintenance'->>'requestId'=m->>'resumeRequestId'
      AND receipt.response->'maintenance'->>'maintenanceId'=m->>'id'
      AND receipt.response->'maintenance'->>'idleRuntimeId'=m->>'idleRuntimeId'
  ) THEN RAISE EXCEPTION 'maintenance_owner_intent_unverified'; END IF;
  IF m->>'phase'='finished' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(m->'projects') p WHERE NOT EXISTS (
      SELECT 1 FROM codex_guardian_operation_receipts receipt
      JOIN codex_guardian_runtimes r ON r.owner_id=receipt.owner_id AND r.id=receipt.runtime_id
      JOIN codex_host_slots s ON s.owner_id=r.owner_id AND s.id=r.slot_id
      JOIN codex_guardian_admissions a ON a.owner_id=r.owner_id AND a.runtime_id=r.id
        AND a.id::text=receipt.response->'admission'->>'id'
      WHERE receipt.owner_id=NEW.owner_id AND receipt.runtime_id::text=m->>'idleRuntimeId' AND receipt.action='native'
        AND receipt.response->'maintenanceRebind'->>'ownerIntentRuntimeId'=m->>'resumeIntentRuntimeId'
        AND receipt.response->'maintenanceRebind'->>'ownerIntentEventId'=m->>'resumeIntentEventId'
        AND a.preparation_intent_id::text=p->>'preparationIntentId' AND a.native_thread_id=p->>'nativeThreadId'
        AND a.phase='native' AND a.registration_id=s.active_registration_id AND r.phase='open' AND r.producer_approved
        AND NOT EXISTS(SELECT 1 FROM delivery_manager_bindings binding WHERE binding.owner_id=r.owner_id
          AND binding.preparation_intent_id=a.preparation_intent_id AND
          (binding.execution_epoch_runtime_id IS DISTINCT FROM r.id OR binding.execution_epoch_event_id IS DISTINCT FROM receipt.event_id))
    )
  ) THEN RAISE EXCEPTION 'maintenance_fresh_execution_unverified'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER account_maintenance_closure_scope AFTER UPDATE ON codex_host_slots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hive_account_maintenance_closure_scope();

CREATE FUNCTION hive_account_maintenance_owner_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r codex_guardian_runtimes; s codex_host_slots; m jsonb; v jsonb;
BEGIN
  IF NEW.action<>'maintenance_resume_intent' THEN RETURN NEW; END IF;
  SELECT * INTO r FROM codex_guardian_runtimes WHERE owner_id=NEW.owner_id AND id=NEW.runtime_id FOR UPDATE;
  SELECT * INTO s FROM codex_host_slots WHERE owner_id=NEW.owner_id AND id=r.slot_id FOR UPDATE;
  m:=s.account_maintenance; v:=NEW.response->'maintenance';
  IF (r.phase='tree_closed' AND m->>'phase'='resuming'
    AND m->>'resumeIntentRuntimeId'=r.id::text AND m->>'resumeIntentEventId'=NEW.event_id::text
    AND v->>'purpose'='maintenance_resume_intent' AND v->>'schemaVersion'='1'
    AND v->>'ownerId'=NEW.owner_id::text AND v->>'workspaceId'=r.workspace_id::text
    AND v->>'buildId'=r.build_id::text AND v->>'slotId'=s.id::text
    AND v->>'maintenanceId'=m->>'id' AND v->>'requestId'=m->>'resumeRequestId'
    AND v->>'maintenanceVersion'=s.account_maintenance_version::text
    AND v->>'idleRuntimeId'=m->>'idleRuntimeId'
    AND jsonb_typeof(v->'projects')='array' AND jsonb_array_length(v->'projects') BETWEEN 1 AND 32
    AND jsonb_array_length(v->'projects')=jsonb_array_length(m->'projects')
    AND (SELECT count(DISTINCT p->>'preparationIntentId') FROM jsonb_array_elements(v->'projects') p)=jsonb_array_length(v->'projects')
    AND EXISTS (SELECT 1 FROM codex_guardian_runtimes n WHERE n.owner_id=NEW.owner_id
      AND n.id::text=v->>'idleRuntimeId' AND n.slot_id=s.id AND n.workspace_id=r.workspace_id AND n.build_id=r.build_id
      AND n.generation::text=v->>'idleRuntimeGeneration' AND n.phase='open' AND NOT n.producer_approved
      AND n.native_launch_id IS NULL AND n.server_instance_id IS NULL AND n.authority_until>clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM codex_guardian_admissions a WHERE a.owner_id=n.owner_id AND a.runtime_id=n.id))
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v->'projects') p WHERE NOT EXISTS (
        SELECT 1 FROM codex_guardian_admissions a
        JOIN project_task_intents i ON i.owner_id=a.owner_id AND i.id=a.preparation_intent_id
        JOIN codex_guardian_runtimes parked_runtime ON parked_runtime.owner_id=a.owner_id AND parked_runtime.id=a.runtime_id
        JOIN codex_guardian_barriers b ON b.owner_id=parked_runtime.owner_id AND b.id=parked_runtime.closed_barrier_id
        JOIN codex_guardian_tree_receipts t ON t.owner_id=parked_runtime.owner_id AND t.runtime_id=parked_runtime.id AND t.barrier_id=b.id
        JOIN codex_guardian_stop_decisions d ON d.owner_id=a.owner_id AND d.admission_id=a.id AND d.barrier_id=b.id
        WHERE a.owner_id=NEW.owner_id AND a.phase='native' AND parked_runtime.phase='tree_closed'
          AND parked_runtime.workspace_id=r.workspace_id AND parked_runtime.build_id=r.build_id
          AND a.project_id::text=p->>'projectId' AND a.preparation_intent_id::text=p->>'preparationIntentId'
          AND a.native_thread_id=p->>'nativeThreadId' AND a.lease_id::text=p->>'leaseId' AND a.lease_generation::text=p->>'leaseGeneration'
          AND i.workspace_id=r.workspace_id AND i.request_id::text=p->>'requestId' AND i.request_digest=p->>'requestDigest'
          AND i.request_digest=a.intent_request_digest AND i.source_sha=p->>'sourceSha' AND i.phase<>'blocked'
          AND p->>'firstPromptRequestId'=i.request_id::text
          AND d.state->'observation'->>'firstPromptDigest'=p->>'firstPromptDigest'
          AND d.state->'observation'->>'historyDigest'=p->>'historyDigest'
          AND d.state->'observation'->>'rootTurns' ~ '^[1-9][0-9]*$'
          AND b.purpose='account-maintenance' AND b.maintenance_id::text=m->>'id'
          AND parked_runtime.id::text=p->>'oldRuntimeId' AND b.id::text=p->>'oldBarrierId'
          AND t.receipt_id::text=p->>'oldTreeReceiptId' AND t.digest=p->>'oldTreeReceiptDigest'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(m->'projects') parked WHERE parked->>'preparationIntentId'=i.id::text
            AND parked->>'checkoutDigest'=p->>'checkoutDigest' AND parked->>'nativeThreadId'=a.native_thread_id)
      )
    )) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'maintenance_owner_resume_intent_rejected'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_maintenance_owner_receipt BEFORE INSERT ON codex_guardian_operation_receipts
  FOR EACH ROW EXECUTE FUNCTION hive_account_maintenance_owner_receipt();

ALTER TABLE delivery_manager_bindings
  ADD COLUMN execution_epoch_version integer NOT NULL DEFAULT 0,
  ADD COLUMN execution_epoch_runtime_id uuid,
  ADD COLUMN execution_epoch_event_id uuid,
  ADD COLUMN execution_epoch_resume_event_id uuid,
  ADD CONSTRAINT manager_maintenance_epoch_shape CHECK (
    (execution_epoch_version=0 AND execution_epoch_runtime_id IS NULL AND execution_epoch_event_id IS NULL AND execution_epoch_resume_event_id IS NULL) OR
    (execution_epoch_version>0 AND execution_epoch_runtime_id IS NOT NULL AND execution_epoch_event_id IS NOT NULL AND execution_epoch_resume_event_id IS NOT NULL)
  ),
  ADD CONSTRAINT manager_maintenance_epoch_receipt_fk FOREIGN KEY(owner_id,execution_epoch_runtime_id,execution_epoch_event_id)
    REFERENCES codex_guardian_operation_receipts(owner_id,runtime_id,event_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT manager_maintenance_resume_event_fk FOREIGN KEY(owner_id,execution_epoch_resume_event_id)
    REFERENCES delivery_events(owner_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE UNIQUE INDEX manager_maintenance_epoch_current_receipt ON delivery_manager_bindings(owner_id,execution_epoch_runtime_id,execution_epoch_event_id)
  WHERE execution_epoch_runtime_id IS NOT NULL;
CREATE UNIQUE INDEX manager_maintenance_epoch_current_resume ON delivery_manager_bindings(owner_id,execution_epoch_resume_event_id)
  WHERE execution_epoch_resume_event_id IS NOT NULL;
-- Consumption uniqueness is retained across ALL epochs, not just the current pointer.
CREATE UNIQUE INDEX maintenance_epoch_receipt_history ON delivery_events(owner_id,(payload->>'newRuntimeId'),(payload->>'newNativeReceiptEventId'))
  WHERE type='account_maintenance_epoch_committed';
CREATE UNIQUE INDEX maintenance_epoch_resume_history ON delivery_events(owner_id,(payload->>'resumeEventId'))
  WHERE type='account_maintenance_epoch_committed';

CREATE FUNCTION hive_check_account_maintenance_epoch(old_row delivery_manager_bindings,new_row delivery_manager_bindings)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(new_row.execution_epoch_version,new_row.execution_epoch_runtime_id,new_row.execution_epoch_event_id,new_row.execution_epoch_resume_event_id)
    IS NOT DISTINCT FROM ROW(old_row.execution_epoch_version,old_row.execution_epoch_runtime_id,old_row.execution_epoch_event_id,old_row.execution_epoch_resume_event_id) THEN RETURN; END IF;
  IF new_row.execution_epoch_version<>old_row.execution_epoch_version+1 OR new_row.execution_epoch_runtime_id IS NULL
     OR new_row.execution_epoch_event_id IS NULL OR new_row.execution_epoch_resume_event_id IS NULL OR
     ROW(new_row.active_attempt_id,new_row.current_attempt_id,new_row.cursor_version,new_row.native_sequence,new_row.blocked_reason)
       IS DISTINCT FROM ROW(old_row.active_attempt_id,old_row.current_attempt_id,old_row.cursor_version,old_row.native_sequence,old_row.blocked_reason) THEN
    RAISE EXCEPTION 'maintenance_epoch_pointer_rejected';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM codex_guardian_operation_receipts receipt
    JOIN codex_guardian_runtimes runtime ON runtime.owner_id=receipt.owner_id AND runtime.id=receipt.runtime_id
    JOIN codex_host_slots slot ON slot.owner_id=runtime.owner_id AND slot.id=runtime.slot_id
    JOIN codex_guardian_admissions admission ON admission.owner_id=runtime.owner_id AND admission.runtime_id=runtime.id
      AND admission.id::text=receipt.response->'admission'->>'id'
    JOIN delivery_events resume ON resume.owner_id=receipt.owner_id AND resume.id=new_row.execution_epoch_resume_event_id
    JOIN codex_guardian_operation_receipts owner_intent ON owner_intent.owner_id=resume.owner_id
      AND owner_intent.runtime_id::text=resume.payload->>'ownerIntentRuntimeId'
      AND owner_intent.event_id::text=resume.payload->>'ownerIntentEventId'
    JOIN delivery_events committed ON committed.owner_id=receipt.owner_id AND committed.aggregate_key='maintenance-epoch/'||old_row.id::text
      AND committed.aggregate_version=new_row.execution_epoch_version AND committed.type='account_maintenance_epoch_committed'
    JOIN codex_guardian_runtimes prior ON prior.owner_id=runtime.owner_id AND prior.id::text=resume.payload->>'oldRuntimeId'
    JOIN codex_guardian_barriers barrier ON barrier.owner_id=prior.owner_id AND barrier.id=prior.closed_barrier_id
    JOIN codex_guardian_tree_receipts tree ON tree.owner_id=prior.owner_id AND tree.runtime_id=prior.id AND tree.barrier_id=barrier.id
    JOIN codex_host_registrations registration ON registration.owner_id=slot.owner_id AND registration.id=slot.active_registration_id
    WHERE receipt.owner_id=old_row.owner_id AND receipt.runtime_id=new_row.execution_epoch_runtime_id AND receipt.event_id=new_row.execution_epoch_event_id
      AND receipt.action='native' AND receipt.result_runtime_generation=runtime.generation
      AND receipt.response->'runtime'->>'id'=runtime.id::text
      AND admission.phase='native' AND admission.project_id=old_row.project_id
      AND admission.preparation_intent_id=old_row.preparation_intent_id AND admission.native_thread_id=old_row.native_thread_id
      AND admission.lease_id=old_row.lease_id AND admission.lease_generation=old_row.lease_generation
      AND admission.registration_id=registration.id AND admission.metadata_pins_digest=resume.payload->>'newMetadataPinsDigest'
      AND runtime.phase='open' AND runtime.producer_approved AND runtime.authority_until>clock_timestamp()
      AND runtime.workspace_id=old_row.workspace_id AND runtime.build_id=old_row.build_id
      AND registration.server_instance_id=runtime.server_instance_id AND registration.expires_at>clock_timestamp()
      AND resume.type='account_maintenance_resume_requested'
      AND owner_intent.action='maintenance_resume_intent'
      AND owner_intent.response->'maintenance'->>'requestId'=resume.payload->>'ownerRequestId'
      AND owner_intent.response->'maintenance'->>'maintenanceId'=resume.payload->>'maintenanceId'
      AND owner_intent.response->'maintenance'->>'idleRuntimeId'=runtime.id::text
      AND owner_intent.response->'maintenance'->>'parkedJournalDigest'=resume.payload->>'parkedJournalDigest'
      AND receipt.response->'maintenanceRebind'->>'parkedJournalDigest'=resume.payload->>'parkedJournalDigest'
      AND receipt.response->'maintenanceRebind'->>'historyDigest'=resume.payload->>'parkedHistoryDigest'
      AND slot.account_maintenance->>'resumeIntentRuntimeId'=owner_intent.runtime_id::text
      AND slot.account_maintenance->>'resumeIntentEventId'=owner_intent.event_id::text
      AND resume.payload->>'managerBindingId'=old_row.id::text
      AND resume.payload->>'previousEpochVersion'=old_row.execution_epoch_version::text
      AND resume.payload->>'workspaceId'=old_row.workspace_id::text AND resume.payload->>'buildId'=old_row.build_id::text
      AND resume.payload->>'slotId'=slot.id::text AND resume.payload->>'projectId'=old_row.project_id::text
      AND resume.payload->>'preparationIntentId'=old_row.preparation_intent_id::text
      AND resume.payload->>'managerThreadId'=old_row.native_thread_id
      AND resume.payload->>'sourceSha'=old_row.source_sha
      AND resume.payload->>'currentAttemptId' IS NOT DISTINCT FROM old_row.current_attempt_id::text
      AND resume.payload->>'cursorVersion'=old_row.cursor_version::text
      AND resume.payload->>'nativeSequence'=old_row.native_sequence::text
      AND (resume.payload->>'leaseValidUntil')::timestamptz>clock_timestamp()
      AND (old_row.active_attempt_id IS NULL OR EXISTS (SELECT 1 FROM delivery_attempts writer
        WHERE writer.owner_id=old_row.owner_id AND writer.id=old_row.active_attempt_id
        AND writer.manager_binding_id=old_row.id AND writer.runtime_version::text=resume.payload->>'writerRuntimeVersion'
        AND writer.lease_expires_at>clock_timestamp()))
      AND resume.payload->>'leaseId'=old_row.lease_id::text AND resume.payload->>'leaseGeneration'=old_row.lease_generation::text
      AND resume.payload->>'writerAttemptId' IS NOT DISTINCT FROM old_row.active_attempt_id::text
      AND resume.payload->>'newRuntimeId'=runtime.id::text
      AND resume.payload->>'newNativeReceiptEventId'=receipt.event_id::text
      AND resume.payload->>'newRegistrationId'=registration.id::text
      AND resume.payload->>'newServerInstanceId'=runtime.server_instance_id
      AND prior.phase='tree_closed' AND prior.workspace_id=runtime.workspace_id AND prior.build_id=runtime.build_id AND prior.slot_id=slot.id
      AND barrier.purpose='account-maintenance' AND barrier.maintenance_id::text=resume.payload->>'maintenanceId'
      AND tree.receipt_id::text=resume.payload->>'oldTreeReceiptId' AND tree.digest=resume.payload->>'oldTreeReceiptDigest'
      AND slot.account_maintenance->>'phase'='resuming' AND slot.account_maintenance->>'id'=barrier.maintenance_id::text
      AND slot.account_maintenance->>'idleRuntimeId'=runtime.id::text
      AND slot.account_maintenance_version::text=resume.payload->>'maintenanceVersion'
      AND committed.payload->>'resumeEventId'=resume.id::text
      AND committed.payload->>'managerBindingId'=old_row.id::text
      AND committed.payload->>'previousEpochVersion'=old_row.execution_epoch_version::text
      AND committed.payload->>'newRuntimeId'=receipt.runtime_id::text
      AND committed.payload->>'newNativeReceiptEventId'=receipt.event_id::text
      AND committed.payload->>'epochVersion'=new_row.execution_epoch_version::text
  ) THEN RAISE EXCEPTION 'maintenance_epoch_authority_unverified'; END IF;
END $$;
CREATE FUNCTION hive_account_maintenance_initial_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_epoch_version<>0 OR NEW.execution_epoch_runtime_id IS NOT NULL OR NEW.execution_epoch_event_id IS NOT NULL OR NEW.execution_epoch_resume_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'maintenance_epoch_requires_retained_binding';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_maintenance_initial_epoch BEFORE INSERT ON delivery_manager_bindings
FOR EACH ROW EXECUTE FUNCTION hive_account_maintenance_initial_epoch();

-- Preserve the existing progression/repair/writer checks verbatim, except the
-- separately validated, monotonically advancing maintenance pointer fields.
CREATE OR REPLACE FUNCTION hive_delivery_manager_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof JSONB;
BEGIN
  PERFORM hive_check_account_maintenance_epoch(OLD,NEW);
  IF (to_jsonb(NEW) - ARRAY['active_attempt_id','current_attempt_id','cursor_version','native_sequence','blocked_reason','updated_at','execution_epoch_version','execution_epoch_runtime_id','execution_epoch_event_id','execution_epoch_resume_event_id'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['active_attempt_id','current_attempt_id','cursor_version','native_sequence','blocked_reason','updated_at','execution_epoch_version','execution_epoch_runtime_id','execution_epoch_event_id','execution_epoch_resume_event_id']) THEN
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
COMMIT;

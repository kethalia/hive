-- AlterTable
ALTER TABLE "delivery_tasks" ADD COLUMN     "source_revision_id" UUID,
ADD COLUMN     "source_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "delivery_attempts" ADD COLUMN     "output_revision_id" UUID;

-- CreateTable
CREATE TABLE "delivery_source_revisions" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "manager_binding_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "producing_attempt_id" UUID NOT NULL,
    "previous_revision_id" UUID,
    "version" INTEGER NOT NULL,
    "input_sha" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "tree_sha" TEXT NOT NULL,
    "manifest_digest" TEXT NOT NULL,
    "operation_id" UUID NOT NULL,
    "request_digest" TEXT NOT NULL,
    "producer" TEXT NOT NULL,
    "proof_digest" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "base_branch" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "pull_number" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_source_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_source_revisions_owner_id_id_key" ON "delivery_source_revisions"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_source_revisions_owner_id_task_id_id_key" ON "delivery_source_revisions"("owner_id", "task_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_source_revision_attempt_key" ON "delivery_source_revisions"("owner_id", "step_id", "producing_attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_source_revision_output_key" ON "delivery_source_revisions"("owner_id", "step_id", "producing_attempt_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_source_revisions_owner_id_manager_binding_id_opera_key" ON "delivery_source_revisions"("owner_id", "manager_binding_id", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_source_revisions_owner_id_task_id_version_key" ON "delivery_source_revisions"("owner_id", "task_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_tasks_owner_id_id_manager_binding_id_key" ON "delivery_tasks"("owner_id", "id", "manager_binding_id");

-- AddForeignKey
ALTER TABLE "delivery_tasks" ADD CONSTRAINT "delivery_tasks_owner_id_id_source_revision_id_fkey" FOREIGN KEY ("owner_id", "id", "source_revision_id") REFERENCES "delivery_source_revisions"("owner_id", "task_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_owner_id_step_id_id_output_revision_id_fkey" FOREIGN KEY ("owner_id", "step_id", "id", "output_revision_id") REFERENCES "delivery_source_revisions"("owner_id", "step_id", "producing_attempt_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_source_revisions" ADD CONSTRAINT "delivery_source_revisions_owner_id_task_id_manager_binding_fkey" FOREIGN KEY ("owner_id", "task_id", "manager_binding_id") REFERENCES "delivery_tasks"("owner_id", "id", "manager_binding_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_source_revisions" ADD CONSTRAINT "delivery_source_revisions_owner_id_task_id_step_id_fkey" FOREIGN KEY ("owner_id", "task_id", "step_id") REFERENCES "delivery_steps"("owner_id", "task_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_source_revisions" ADD CONSTRAINT "delivery_source_revisions_owner_id_manager_binding_id_fkey" FOREIGN KEY ("owner_id", "manager_binding_id") REFERENCES "delivery_manager_bindings"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_source_revisions" ADD CONSTRAINT "delivery_source_revisions_owner_id_step_id_producing_attem_fkey" FOREIGN KEY ("owner_id", "step_id", "producing_attempt_id") REFERENCES "delivery_attempts"("owner_id", "step_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_source_revisions" ADD CONSTRAINT "delivery_source_revisions_owner_id_task_id_previous_revisi_fkey" FOREIGN KEY ("owner_id", "task_id", "previous_revision_id") REFERENCES "delivery_source_revisions"("owner_id", "task_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE delivery_tasks ADD CONSTRAINT delivery_task_source_version_shape CHECK (
  source_version>=0 AND ((source_revision_id IS NULL AND source_version=0) OR (source_revision_id IS NOT NULL AND source_version>0))
);
ALTER TABLE delivery_source_revisions ADD CONSTRAINT delivery_source_revision_shape CHECK (
  version>0 AND input_sha ~ '^[a-f0-9]{40}$' AND head_sha ~ '^[a-f0-9]{40}$' AND input_sha<>head_sha
  AND tree_sha ~ '^[a-f0-9]{40}$' AND manifest_digest ~ '^[a-f0-9]{64}$'
  AND request_digest ~ '^[a-f0-9]{64}$' AND proof_digest ~ '^[a-f0-9]{64}$'
  AND repository_id ~ '^[1-9][0-9]{0,19}$' AND provider_account_id ~ '^[1-9][0-9]{0,19}$'
  AND pull_request_id ~ '^[1-9][0-9]{0,19}$' AND pull_number>0
  AND producer='protected-source-broker-v1'
  AND length(full_name) BETWEEN 3 AND 140 AND length(branch) BETWEEN 1 AND 255 AND length(base_branch) BETWEEN 1 AND 255
);
CREATE FUNCTION hive_delivery_source_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task delivery_tasks; binding delivery_manager_bindings; attempt delivery_attempts; prior delivery_source_revisions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Source revision history is immutable'; END IF;
  SELECT * INTO task FROM delivery_tasks WHERE owner_id=NEW.owner_id AND id=NEW.task_id;
  SELECT * INTO binding FROM delivery_manager_bindings WHERE owner_id=NEW.owner_id AND id=NEW.manager_binding_id;
  SELECT * INTO attempt FROM delivery_attempts WHERE owner_id=NEW.owner_id AND id=NEW.producing_attempt_id;
  IF task.id IS NULL OR binding.id IS NULL OR attempt.id IS NULL OR task.manager_binding_id<>binding.id
    OR binding.current_attempt_id IS DISTINCT FROM attempt.id OR binding.progression_protocol<>1
    OR binding.blocked_reason IS NOT NULL OR task.pause_requested OR task.scheduling_paused
    OR attempt.outcome<>'running' OR attempt.output_revision_id IS NOT NULL OR attempt.source_sha<>NEW.input_sha
    OR task.source_sha<>NEW.input_sha OR NEW.version<>task.source_version+1
    OR NEW.previous_revision_id IS DISTINCT FROM task.source_revision_id THEN
    RAISE EXCEPTION 'Source publication must extend the active same-writer source';
  END IF;
  IF NEW.previous_revision_id IS NULL THEN
    IF NEW.version<>1 OR NEW.input_sha<>binding.source_sha THEN RAISE EXCEPTION 'Source chain base mismatch'; END IF;
  ELSE
    SELECT * INTO prior FROM delivery_source_revisions WHERE owner_id=NEW.owner_id AND id=NEW.previous_revision_id AND task_id=NEW.task_id;
    IF prior.id IS NULL OR prior.head_sha<>NEW.input_sha OR prior.version<>NEW.version-1 THEN RAISE EXCEPTION 'Source chain predecessor mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_source_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON delivery_source_revisions
FOR EACH ROW EXECUTE FUNCTION hive_delivery_source_revision_guard();

CREATE FUNCTION hive_delivery_task_source_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision delivery_source_revisions;
BEGIN
  IF NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id THEN
    SELECT * INTO revision FROM delivery_source_revisions WHERE owner_id=NEW.owner_id AND task_id=NEW.id AND id=NEW.source_revision_id;
    IF revision.id IS NULL OR NEW.source_version<>OLD.source_version+1 OR revision.version<>NEW.source_version
      OR revision.previous_revision_id IS DISTINCT FROM OLD.source_revision_id OR revision.input_sha<>OLD.source_sha
      OR revision.head_sha<>NEW.source_sha OR revision.branch<>NEW.branch THEN
      RAISE EXCEPTION 'Task source pointer must advance its immutable revision chain';
    END IF;
  ELSIF NEW.source_version<>OLD.source_version THEN RAISE EXCEPTION 'Source version requires a new revision'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_task_source_pointer_guard BEFORE UPDATE ON delivery_tasks
FOR EACH ROW EXECUTE FUNCTION hive_delivery_task_source_pointer_guard();

CREATE FUNCTION hive_delivery_attempt_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision delivery_source_revisions;
BEGIN
  IF NEW.source_sha IS DISTINCT FROM OLD.source_sha THEN RAISE EXCEPTION 'Attempt input source is immutable'; END IF;
  IF OLD.output_revision_id IS NOT NULL AND NEW.output_revision_id IS DISTINCT FROM OLD.output_revision_id THEN
    RAISE EXCEPTION 'Attempt accepted output is immutable';
  END IF;
  IF NEW.output_revision_id IS DISTINCT FROM OLD.output_revision_id THEN
    SELECT * INTO revision FROM delivery_source_revisions WHERE owner_id=NEW.owner_id AND producing_attempt_id=NEW.id AND id=NEW.output_revision_id;
    IF OLD.outcome<>'running' OR NEW.outcome<>'running' OR revision.id IS NULL OR revision.input_sha<>OLD.source_sha THEN
      RAISE EXCEPTION 'Only the running producing attempt can bind its accepted output';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_attempt_source_guard BEFORE UPDATE ON delivery_attempts
FOR EACH ROW EXECUTE FUNCTION hive_delivery_attempt_source_guard();

-- Logical continuation uses the verified output, never rewrites the input SHA.
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

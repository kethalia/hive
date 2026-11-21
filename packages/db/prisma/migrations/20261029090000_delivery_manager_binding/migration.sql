-- AlterTable
ALTER TABLE "delivery_tasks" ADD COLUMN     "manager_binding_id" UUID;

-- AlterTable
ALTER TABLE "delivery_attempts" ADD COLUMN     "manager_binding_id" UUID;

-- CreateTable
CREATE TABLE "delivery_manager_bindings" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "preparation_intent_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "build_id" UUID NOT NULL,
    "server_instance_id" TEXT NOT NULL,
    "native_thread_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "source_sha" TEXT NOT NULL,
    "lease_id" UUID NOT NULL,
    "lease_generation" INTEGER NOT NULL,
    "binding_digest" TEXT NOT NULL,
    "active_attempt_id" UUID,
    "native_sequence" INTEGER NOT NULL DEFAULT 0,
    "blocked_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_manager_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_manager_bindings_owner_id_preparation_intent_id_idx" ON "delivery_manager_bindings"("owner_id", "preparation_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_manager_bindings_owner_id_id_key" ON "delivery_manager_bindings"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_manager_bindings_owner_id_project_id_id_key" ON "delivery_manager_bindings"("owner_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_manager_bindings_owner_id_binding_digest_key" ON "delivery_manager_bindings"("owner_id", "binding_digest");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_owner_id_manager_binding_id_id_key" ON "delivery_attempts"("owner_id", "manager_binding_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "project_task_intents_owner_id_project_id_id_key" ON "project_task_intents"("owner_id", "project_id", "id");

-- AddForeignKey
ALTER TABLE "delivery_tasks" ADD CONSTRAINT "delivery_tasks_owner_id_project_id_manager_binding_id_fkey" FOREIGN KEY ("owner_id", "project_id", "manager_binding_id") REFERENCES "delivery_manager_bindings"("owner_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_owner_id_manager_binding_id_fkey" FOREIGN KEY ("owner_id", "manager_binding_id") REFERENCES "delivery_manager_bindings"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_manager_bindings" ADD CONSTRAINT "delivery_manager_bindings_owner_id_project_id_fkey" FOREIGN KEY ("owner_id", "project_id") REFERENCES "delivery_projects"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_manager_bindings" ADD CONSTRAINT "delivery_manager_bindings_owner_id_project_id_preparation__fkey" FOREIGN KEY ("owner_id", "project_id", "preparation_intent_id") REFERENCES "project_task_intents"("owner_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_manager_bindings" ADD CONSTRAINT "delivery_manager_bindings_owner_id_project_id_conversation_fkey" FOREIGN KEY ("owner_id", "project_id", "conversation_id") REFERENCES "delivery_conversations"("owner_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_manager_bindings" ADD CONSTRAINT "delivery_manager_bindings_owner_id_id_active_attempt_id_fkey" FOREIGN KEY ("owner_id", "id", "active_attempt_id") REFERENCES "delivery_attempts"("owner_id", "manager_binding_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE delivery_manager_bindings ADD CONSTRAINT delivery_manager_binding_shape_check
CHECK (lease_generation > 0 AND native_sequence >= 0 AND source_sha ~ '^[a-f0-9]{40}$'
  AND binding_digest ~ '^[a-f0-9]{64}$' AND repository_id ~ '^[1-9][0-9]{0,19}$'
  AND (blocked_reason IS NULL OR length(blocked_reason) BETWEEN 1 AND 1000));

CREATE FUNCTION hive_delivery_manager_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof JSONB;
BEGIN
  IF (to_jsonb(NEW) - ARRAY['active_attempt_id','native_sequence','blocked_reason','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['active_attempt_id','native_sequence','blocked_reason','updated_at']) THEN
    RAISE EXCEPTION 'Manager checkout identity is immutable';
  END IF;
  IF NEW.native_sequence < OLD.native_sequence THEN RAISE EXCEPTION 'Native source sequence cannot decrease'; END IF;
  IF OLD.blocked_reason IS NOT NULL AND NEW.blocked_reason IS NULL THEN
    RAISE EXCEPTION 'Blocked native lifetime requires explicit reviewed reconciliation';
  END IF;
  IF OLD.active_attempt_id IS NOT NULL AND NEW.active_attempt_id IS DISTINCT FROM OLD.active_attempt_id THEN
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
CREATE TRIGGER delivery_manager_binding_immutable BEFORE UPDATE ON delivery_manager_bindings
FOR EACH ROW EXECUTE FUNCTION hive_delivery_manager_binding_immutable();

CREATE FUNCTION hive_delivery_task_manager_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.manager_binding_id IS NOT NULL AND NEW.manager_binding_id IS DISTINCT FROM OLD.manager_binding_id THEN
    RAISE EXCEPTION 'Task manager checkout binding is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_task_manager_binding_immutable BEFORE UPDATE ON delivery_tasks
FOR EACH ROW EXECUTE FUNCTION hive_delivery_task_manager_binding_immutable();

CREATE FUNCTION hive_delivery_attempt_manager_binding_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected UUID;
BEGIN
  IF TG_OP='UPDATE' AND OLD.manager_binding_id IS NOT NULL AND NEW.manager_binding_id IS DISTINCT FROM OLD.manager_binding_id THEN
    RAISE EXCEPTION 'Attempt manager checkout binding is immutable';
  END IF;
  SELECT task.manager_binding_id INTO expected FROM delivery_steps step JOIN delivery_tasks task
    ON task.id=step.task_id AND task.owner_id=step.owner_id WHERE step.owner_id=NEW.owner_id AND step.id=NEW.step_id;
  IF NEW.manager_binding_id IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Attempt manager binding must match task'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_attempt_manager_binding_check BEFORE INSERT OR UPDATE ON delivery_attempts
FOR EACH ROW EXECUTE FUNCTION hive_delivery_attempt_manager_binding_check();

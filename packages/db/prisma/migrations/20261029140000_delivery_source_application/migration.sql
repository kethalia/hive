-- CreateTable
CREATE TABLE "delivery_source_applications" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "runtime_id" UUID NOT NULL,
    "runtime_generation" INTEGER NOT NULL,
    "admission_id" UUID NOT NULL,
    "admission_generation" INTEGER NOT NULL,
    "producer_digest" TEXT NOT NULL,
    "registration_id" UUID NOT NULL,
    "server_instance_id" TEXT NOT NULL,
    "manager_thread_id" TEXT NOT NULL,
    "manager_binding_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "producing_attempt_id" UUID NOT NULL,
    "publication_operation_id" UUID NOT NULL,
    "target_revision_id" UUID NOT NULL,
    "previous_applied_revision_id" UUID,
    "previous_application_id" UUID,
    "application_version" INTEGER NOT NULL,
    "predecessor_head_sha" TEXT NOT NULL,
    "target_head_sha" TEXT NOT NULL,
    "metadata_pins_digest" TEXT NOT NULL,
    "namespace_receipt_digest" TEXT NOT NULL,
    "cursor_version" INTEGER NOT NULL,
    "native_sequence" INTEGER NOT NULL,
    "idle_snapshot_digest" TEXT NOT NULL,
    "idle_snapshot" JSONB NOT NULL,
    "input_barrier_id" UUID NOT NULL,
    "input_barrier_digest" TEXT NOT NULL,
    "input_barrier" JSONB NOT NULL,
    "request_digest" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ,
    "applied_receipt_digest" TEXT,
    "applied_evidence" JSONB,

    CONSTRAINT "delivery_source_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_source_applications_owner_id_admission_id_phase_idx" ON "delivery_source_applications"("owner_id", "admission_id", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_source_applications_owner_id_id_key" ON "delivery_source_applications"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_source_applications_owner_id_admission_id_id_key" ON "delivery_source_applications"("owner_id", "admission_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_source_applications_owner_id_admission_id_applicat_key" ON "delivery_source_applications"("owner_id", "admission_id", "application_version");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_source_applications_owner_id_admission_id_target_r_key" ON "delivery_source_applications"("owner_id", "admission_id", "target_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_source_applications_owner_id_admission_id_publicat_key" ON "delivery_source_applications"("owner_id", "admission_id", "publication_operation_id");

-- AddForeignKey
ALTER TABLE "delivery_source_applications" ADD CONSTRAINT "delivery_source_applications_owner_id_runtime_id_admission_fkey" FOREIGN KEY ("owner_id", "runtime_id", "admission_id") REFERENCES "codex_guardian_admissions"("owner_id", "runtime_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_source_applications" ADD CONSTRAINT "delivery_source_applications_owner_id_registration_id_fkey" FOREIGN KEY ("owner_id", "registration_id") REFERENCES "codex_host_registrations"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_source_applications" ADD CONSTRAINT "delivery_source_applications_owner_id_task_id_manager_bind_fkey" FOREIGN KEY ("owner_id", "task_id", "manager_binding_id") REFERENCES "delivery_tasks"("owner_id", "id", "manager_binding_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_source_applications" ADD CONSTRAINT "delivery_source_applications_owner_id_step_id_producing_at_fkey" FOREIGN KEY ("owner_id", "step_id", "producing_attempt_id", "target_revision_id") REFERENCES "delivery_source_revisions"("owner_id", "step_id", "producing_attempt_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_source_applications" ADD CONSTRAINT "delivery_source_applications_owner_id_previous_applied_rev_fkey" FOREIGN KEY ("owner_id", "previous_applied_revision_id") REFERENCES "delivery_source_revisions"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_source_applications" ADD CONSTRAINT "delivery_source_applications_owner_id_admission_id_previou_fkey" FOREIGN KEY ("owner_id", "admission_id", "previous_application_id") REFERENCES "delivery_source_applications"("owner_id", "admission_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The target must belong to both the original producing attempt and exact task.
ALTER TABLE delivery_source_applications ADD CONSTRAINT delivery_source_application_target_task_fkey
  FOREIGN KEY(owner_id,task_id,target_revision_id)
  REFERENCES delivery_source_revisions(owner_id,task_id,id) ON DELETE RESTRICT;
-- A timeout is not an application outcome. Unresolved operations remain exclusive.
CREATE UNIQUE INDEX delivery_source_application_pending_key
  ON delivery_source_applications(owner_id,admission_id) WHERE phase='pending';
ALTER TABLE delivery_source_applications ADD CONSTRAINT delivery_source_application_state_check CHECK (
  phase IN ('pending','applied')
  AND runtime_generation>0 AND admission_generation>0 AND application_version>0
  AND cursor_version>0 AND native_sequence>=0
  AND producer_digest ~ '^[a-f0-9]{64}$'
  AND predecessor_head_sha ~ '^[a-f0-9]{40}$' AND target_head_sha ~ '^[a-f0-9]{40}$'
  AND metadata_pins_digest ~ '^[a-f0-9]{64}$' AND namespace_receipt_digest ~ '^[a-f0-9]{64}$'
  AND idle_snapshot_digest ~ '^[a-f0-9]{64}$' AND input_barrier_digest ~ '^[a-f0-9]{64}$'
  AND request_digest ~ '^[a-f0-9]{64}$'
  AND (previous_application_id IS NULL)=(previous_applied_revision_id IS NULL)
  AND (application_version=1)=(previous_application_id IS NULL)
  AND (phase='applied')=(applied_at IS NOT NULL)
  AND (applied_at IS NULL)=(applied_receipt_digest IS NULL)
  AND (applied_at IS NULL)=(applied_evidence IS NULL)
  AND (applied_receipt_digest IS NULL OR applied_receipt_digest ~ '^[a-f0-9]{64}$')
);
CREATE FUNCTION delivery_source_application_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'source application is retained'; END IF;
  IF (to_jsonb(NEW)-ARRAY['phase','applied_at','applied_receipt_digest','applied_evidence'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','applied_at','applied_receipt_digest','applied_evidence'])
     OR (OLD.phase='applied' AND NEW IS DISTINCT FROM OLD)
     OR (OLD.phase='pending' AND NEW.phase NOT IN ('pending','applied'))
     OR (OLD.phase='pending' AND NEW.phase='pending' AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'source application identity or transition rejected'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_source_application_integrity BEFORE UPDATE OR DELETE ON delivery_source_applications
  FOR EACH ROW EXECUTE FUNCTION delivery_source_application_integrity();

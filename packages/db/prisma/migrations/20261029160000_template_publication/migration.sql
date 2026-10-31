-- CreateTable
CREATE TABLE "template_publication_targets" (
    "id" UUID NOT NULL,
    "configured_origin" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "organization_name" TEXT NOT NULL,
    "template_id" UUID NOT NULL,
    "template_name" TEXT NOT NULL,
    "current_job_id" UUID,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "held_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_publication_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_publication_jobs" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "actor_session_id" UUID NOT NULL,
    "actor_coder_user_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "target_generation" INTEGER NOT NULL,
    "request_id" UUID NOT NULL,
    "request_digest" TEXT NOT NULL,
    "template_name" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "archive_digest" TEXT NOT NULL,
    "archive_bytes" INTEGER NOT NULL,
    "manifest_digest" TEXT NOT NULL,
    "version_name" TEXT NOT NULL,
    "expected_active_version_id" UUID NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "effect_state" TEXT NOT NULL DEFAULT 'clear',
    "effect_digest" TEXT,
    "file_id" UUID,
    "version_id" UUID,
    "import_job_id" UUID,
    "remote_status" TEXT,
    "remote_log_after" BIGINT NOT NULL DEFAULT 0,
    "logs_overflowed" BOOLEAN NOT NULL DEFAULT false,
    "lease_holder" UUID,
    "lease_generation" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "event_sequence" INTEGER NOT NULL DEFAULT 0,
    "held_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "template_publication_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_publication_events" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_publication_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "template_publication_targets_configured_origin_organization_key" ON "template_publication_targets"("configured_origin", "organization_id", "template_id");

-- CreateIndex
CREATE INDEX "template_publication_jobs_stage_next_attempt_at_idx" ON "template_publication_jobs"("stage", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "template_publication_jobs_owner_id_id_key" ON "template_publication_jobs"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "template_publication_jobs_target_id_id_key" ON "template_publication_jobs"("target_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "template_publication_jobs_owner_id_request_id_key" ON "template_publication_jobs"("owner_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_publication_events_job_id_sequence_key" ON "template_publication_events"("job_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "template_publication_events_job_id_key_key" ON "template_publication_events"("job_id", "key");

-- AddForeignKey
ALTER TABLE "template_publication_targets" ADD CONSTRAINT "template_publication_targets_id_current_job_id_fkey" FOREIGN KEY ("id", "current_job_id") REFERENCES "template_publication_jobs"("target_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "template_publication_jobs" ADD CONSTRAINT "template_publication_jobs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_publication_jobs" ADD CONSTRAINT "template_publication_jobs_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "template_publication_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_publication_events" ADD CONSTRAINT "template_publication_events_owner_id_job_id_fkey" FOREIGN KEY ("owner_id", "job_id") REFERENCES "template_publication_jobs"("owner_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE template_publication_targets ADD CONSTRAINT template_publication_target_bounds CHECK (generation >= 0);
ALTER TABLE template_publication_jobs ADD CONSTRAINT template_publication_job_bounds CHECK (
  target_generation > 0 AND lease_generation >= 0 AND retries BETWEEN 0 AND 5
  AND event_sequence BETWEEN 0 AND 256 AND remote_log_after >= 0
  AND archive_bytes BETWEEN 1 AND 1048576
  AND request_digest ~ '^[a-f0-9]{64}$' AND content_hash ~ '^[a-f0-9]{64}$'
  AND archive_digest ~ '^[a-f0-9]{64}$' AND manifest_digest ~ '^[a-f0-9]{64}$'
  AND stage IN ('queued','uploading','creating_version','importing','activating','succeeded','failed','held')
  AND effect_state IN ('clear','started','unknown')
  AND (lease_holder IS NULL) = (lease_until IS NULL)
  AND (stage IN ('succeeded','failed','held')) = (finished_at IS NOT NULL)
  AND (remote_status IS NULL OR remote_status IN ('pending','running','succeeded','failed','canceling','canceled'))
);
ALTER TABLE template_publication_events ADD CONSTRAINT template_publication_event_bounds CHECK (
  sequence BETWEEN 1 AND 256 AND length(key) BETWEEN 1 AND 100 AND digest ~ '^[a-f0-9]{64}$'
);

CREATE FUNCTION hive_template_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'template_publication_events' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publication history is immutable';
  END IF;
  IF TG_TABLE_NAME = 'template_publication_targets' THEN
    IF (to_jsonb(NEW) - ARRAY['current_job_id','generation','held_reason']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['current_job_id','generation','held_reason']) OR NEW.generation < OLD.generation THEN
      RAISE EXCEPTION 'publication target identity is immutable';
    END IF;
  ELSE
    IF OLD.stage IN ('succeeded','failed','held') OR
      (to_jsonb(NEW) - ARRAY['stage','effect_state','effect_digest','file_id','version_id','import_job_id','remote_status','remote_log_after','logs_overflowed','lease_holder','lease_generation','lease_until','next_attempt_at','retries','event_sequence','held_reason','updated_at','finished_at']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['stage','effect_state','effect_digest','file_id','version_id','import_job_id','remote_status','remote_log_after','logs_overflowed','lease_holder','lease_generation','lease_until','next_attempt_at','retries','event_sequence','held_reason','updated_at','finished_at']) OR
      (OLD.file_id IS NOT NULL AND NEW.file_id IS DISTINCT FROM OLD.file_id) OR
      (OLD.version_id IS NOT NULL AND NEW.version_id IS DISTINCT FROM OLD.version_id) OR
      (OLD.import_job_id IS NOT NULL AND NEW.import_job_id IS DISTINCT FROM OLD.import_job_id) OR
      NEW.remote_log_after < OLD.remote_log_after OR NEW.event_sequence < OLD.event_sequence OR NEW.lease_generation < OLD.lease_generation THEN
      RAISE EXCEPTION 'publication job identity or history is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER template_publication_targets_immutable BEFORE UPDATE OR DELETE ON template_publication_targets FOR EACH ROW EXECUTE FUNCTION hive_template_publication_immutable();
CREATE TRIGGER template_publication_jobs_immutable BEFORE UPDATE OR DELETE ON template_publication_jobs FOR EACH ROW EXECUTE FUNCTION hive_template_publication_immutable();
CREATE TRIGGER template_publication_events_immutable BEFORE UPDATE OR DELETE ON template_publication_events FOR EACH ROW EXECUTE FUNCTION hive_template_publication_immutable();

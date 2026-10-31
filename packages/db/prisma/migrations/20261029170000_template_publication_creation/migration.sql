-- AlterTable
ALTER TABLE "template_publication_targets" ALTER COLUMN "template_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "template_publication_jobs" ADD COLUMN     "operation_mode" TEXT NOT NULL DEFAULT 'update',
ADD COLUMN     "provisioner_tags_digest" TEXT,
ALTER COLUMN "expected_active_version_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "template_publication_target_name_key" ON "template_publication_targets"("configured_origin", "organization_id", "template_name");

ALTER TABLE template_publication_jobs DROP CONSTRAINT template_publication_job_bounds;
ALTER TABLE template_publication_jobs ADD CONSTRAINT template_publication_job_bounds CHECK (
  target_generation > 0 AND lease_generation >= 0 AND retries BETWEEN 0 AND 5
  AND event_sequence BETWEEN 0 AND 256 AND remote_log_after >= 0
  AND archive_bytes BETWEEN 1 AND 1048576
  AND request_digest ~ '^[a-f0-9]{64}$' AND content_hash ~ '^[a-f0-9]{64}$'
  AND archive_digest ~ '^[a-f0-9]{64}$' AND manifest_digest ~ '^[a-f0-9]{64}$'
  AND stage IN ('queued','uploading','creating_version','creating_template','importing','activating','succeeded','failed','held')
  AND effect_state IN ('clear','started','unknown')
  AND (lease_holder IS NULL) = (lease_until IS NULL)
  AND (stage IN ('succeeded','failed','held')) = (finished_at IS NOT NULL)
  AND (remote_status IS NULL OR remote_status IN ('pending','running','succeeded','failed','canceling','canceled'))
);

ALTER TABLE template_publication_jobs ADD CONSTRAINT template_publication_mode_bounds CHECK (
  operation_mode IN ('create','update')
  AND ((operation_mode='create' AND expected_active_version_id IS NULL AND provisioner_tags_digest IS NULL) OR (operation_mode='update' AND expected_active_version_id IS NOT NULL))
  AND (provisioner_tags_digest IS NULL OR provisioner_tags_digest ~ '^[a-f0-9]{64}$')
  AND (stage<>'creating_template' OR operation_mode='create')
  AND (stage<>'activating' OR operation_mode='update')
);

CREATE OR REPLACE FUNCTION hive_template_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'template_publication_events' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publication history is immutable';
  END IF;
  IF TG_TABLE_NAME = 'template_publication_targets' THEN
    IF (to_jsonb(NEW) - ARRAY['current_job_id','generation','held_reason','template_id']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['current_job_id','generation','held_reason','template_id']) OR NEW.generation < OLD.generation THEN
      RAISE EXCEPTION 'publication target identity is immutable';
    END IF;
    IF NEW.template_id IS DISTINCT FROM OLD.template_id THEN
      IF OLD.template_id IS NOT NULL OR NEW.template_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM template_publication_jobs j WHERE j.id=OLD.current_job_id AND j.target_id=OLD.id
          AND j.target_generation=OLD.generation AND j.operation_mode='create'
          AND j.stage='creating_template' AND j.effect_state='started'
          AND j.version_id IS NOT NULL AND j.remote_status='succeeded'
          AND j.lease_holder IS NOT NULL AND j.lease_until>clock_timestamp()
      ) THEN RAISE EXCEPTION 'publication template UUID cannot be rebound'; END IF;
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

CREATE FUNCTION hive_template_publication_mode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE remote_id uuid;
BEGIN
  SELECT template_id INTO remote_id FROM template_publication_targets WHERE id=NEW.target_id;
  IF (NEW.operation_mode='update' AND remote_id IS NULL) OR
     (TG_OP='INSERT' AND NEW.operation_mode='create' AND remote_id IS NOT NULL) OR
     (NEW.stage='succeeded' AND remote_id IS NULL) THEN
    RAISE EXCEPTION 'publication mode does not match reserved target';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER template_publication_mode BEFORE INSERT OR UPDATE ON template_publication_jobs FOR EACH ROW EXECUTE FUNCTION hive_template_publication_mode();

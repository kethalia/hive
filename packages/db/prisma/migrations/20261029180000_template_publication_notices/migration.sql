-- CreateTable
CREATE TABLE "template_publication_notices" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_holder" UUID,
    "lease_until" TIMESTAMPTZ,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "template_publication_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "template_publication_notices_job_id_key" ON "template_publication_notices"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_publication_notices_event_id_key" ON "template_publication_notices"("event_id");

-- CreateIndex
CREATE INDEX "template_publication_notices_status_next_attempt_at_idx" ON "template_publication_notices"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "template_publication_notices_owner_id_job_id_key" ON "template_publication_notices"("owner_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_publication_notices_owner_id_job_id_event_id_key" ON "template_publication_notices"("owner_id", "job_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_publication_event_notice_key" ON "template_publication_events"("owner_id", "job_id", "id");

-- AddForeignKey
ALTER TABLE "template_publication_notices" ADD CONSTRAINT "template_publication_notices_owner_id_job_id_fkey" FOREIGN KEY ("owner_id", "job_id") REFERENCES "template_publication_jobs"("owner_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "template_publication_notices" ADD CONSTRAINT "template_publication_notices_owner_id_job_id_event_id_fkey" FOREIGN KEY ("owner_id", "job_id", "event_id") REFERENCES "template_publication_events"("owner_id", "job_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE template_publication_notices ADD CONSTRAINT template_publication_notice_bounds CHECK (
  attempts BETWEEN 0 AND 5 AND status IN ('pending','processing','delivered','failed','skipped')
  AND ((lease_holder IS NULL)=(lease_until IS NULL))
  AND ((status='processing')=(lease_holder IS NOT NULL))
  AND ((status IN ('delivered','failed','skipped'))=(finished_at IS NOT NULL))
  AND (last_reason IS NULL OR last_reason IN ('delivered','retry','exhausted','owner_changed','invalid_terminal','subscription_limit','send_failed'))
);
CREATE FUNCTION hive_template_notice_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE terminal_stage text; terminal_key text; terminal_code text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'publication notice history is retained'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT j.stage,e.key,e.code INTO terminal_stage,terminal_key,terminal_code
      FROM template_publication_jobs j JOIN template_publication_events e ON e.owner_id=j.owner_id AND e.job_id=j.id
      WHERE j.owner_id=NEW.owner_id AND j.id=NEW.job_id AND e.id=NEW.event_id;
    IF terminal_stage NOT IN ('succeeded','failed','held') OR terminal_stage IS NULL
      OR terminal_key <> 'terminal:'||terminal_stage
      OR terminal_code <> (CASE WHEN terminal_stage='succeeded' THEN 'activation_verified' ELSE terminal_stage END)
      OR NEW.status<>'pending' OR NEW.attempts<>0 THEN
      RAISE EXCEPTION 'notice requires its exact owner/job terminal event';
    END IF;
  ELSE
    IF OLD.status IN ('delivered','failed','skipped') OR
      (to_jsonb(NEW)-ARRAY['status','attempts','lease_holder','lease_until','next_attempt_at','last_reason','finished_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','attempts','lease_holder','lease_until','next_attempt_at','last_reason','finished_at']) OR
      NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1 THEN
      RAISE EXCEPTION 'publication notice identity/history is immutable';
    END IF;
    IF NEW.attempts=OLD.attempts+1 THEN
      IF NEW.status<>'processing' OR NEW.lease_holder IS NULL OR NEW.lease_holder IS NOT DISTINCT FROM OLD.lease_holder
        OR (OLD.status='pending' AND OLD.next_attempt_at>clock_timestamp())
        OR (OLD.status='processing' AND OLD.lease_until>clock_timestamp()) THEN
        RAISE EXCEPTION 'publication notice claim is fenced';
      END IF;
    ELSIF NOT ((OLD.status='processing' AND NEW.status IN ('pending','delivered','failed','skipped'))
      OR (OLD.status='pending' AND OLD.attempts=5 AND NEW.status='failed')) THEN
      RAISE EXCEPTION 'publication notice transition rejected';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER template_publication_notice_integrity BEFORE INSERT OR UPDATE OR DELETE ON template_publication_notices FOR EACH ROW EXECUTE FUNCTION hive_template_notice_integrity();

-- Match the existing server-owned tenancy model: composite owner FKs + scoped
-- application queries, not a new caller-controlled RLS/session-claim mechanism.
REVOKE ALL ON template_publication_notices FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hive_app_runtime') THEN
    GRANT SELECT,INSERT,UPDATE ON template_publication_notices TO hive_app_runtime;
    REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON template_publication_notices FROM hive_app_runtime;
  END IF;
END $$;

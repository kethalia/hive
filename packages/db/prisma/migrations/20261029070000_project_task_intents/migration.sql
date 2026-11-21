CREATE TABLE "project_task_intents" (
  "id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "request_digest" TEXT NOT NULL,
  "phase" TEXT NOT NULL DEFAULT 'queued',
  "ciphertext" BYTEA,
  "iv" BYTEA,
  "auth_tag" BYTEA,
  "status" JSONB,
  "lease_id" UUID,
  "lease_until" TIMESTAMPTZ,
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_task_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_task_intents_project_fkey" FOREIGN KEY ("owner_id", "project_id") REFERENCES "delivery_projects"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "project_task_intents_phase_check" CHECK ("phase" IN ('queued','preparing','running','blocked')),
  CONSTRAINT "project_task_intents_failure_check" CHECK ("failure_count" >= 0 AND "failure_count" <= 5),
  CONSTRAINT "project_task_intents_payload_check" CHECK (("ciphertext" IS NULL AND "iv" IS NULL AND "auth_tag" IS NULL) OR ("ciphertext" IS NOT NULL AND octet_length("ciphertext") <= 200000 AND octet_length("iv") = 12 AND octet_length("auth_tag") = 16)),
  CONSTRAINT "project_task_intents_status_check" CHECK ("status" IS NULL OR octet_length("status"::text) <= 4096)
);
CREATE UNIQUE INDEX "project_task_intents_owner_id_id_key" ON "project_task_intents"("owner_id", "id");
CREATE UNIQUE INDEX "project_task_intents_owner_id_project_id_request_id_key" ON "project_task_intents"("owner_id", "project_id", "request_id");
CREATE INDEX "project_task_intents_phase_next_attempt_at_idx" ON "project_task_intents"("phase", "next_attempt_at");

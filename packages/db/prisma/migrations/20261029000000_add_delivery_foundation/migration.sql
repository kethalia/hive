BEGIN;

-- CreateTable
CREATE TABLE "delivery_projects" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_repository_id" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_conversations" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "native_thread_id" TEXT NOT NULL,
    "build_id" UUID NOT NULL,
    "server_instance_id" TEXT NOT NULL,
    "native_path" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_epics" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "criteria" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_epics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_tasks" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "epic_id" UUID,
    "conversation_id" UUID,
    "outcome" TEXT NOT NULL,
    "source_sha" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "pause_requested" BOOLEAN NOT NULL DEFAULT false,
    "scheduling_paused" BOOLEAN NOT NULL DEFAULT false,
    "release_mode" TEXT NOT NULL DEFAULT 'disabled',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_steps" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "acceptance_phase" TEXT NOT NULL DEFAULT 'implementation_preview',
    "state" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 0,
    "reopen_generation" INTEGER NOT NULL DEFAULT 0,
    "lease_generation" INTEGER NOT NULL DEFAULT 0,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "attempt_budget" INTEGER NOT NULL DEFAULT 3,
    "criterion_ids" TEXT[],
    "required_evidence_kinds" TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_step_dependencies" (
    "owner_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "depends_on_step_id" UUID NOT NULL,

    CONSTRAINT "delivery_step_dependencies_pkey" PRIMARY KEY ("owner_id","task_id","step_id","depends_on_step_id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "lease_generation" INTEGER NOT NULL,
    "lease_holder" TEXT NOT NULL,
    "lease_expires_at" TIMESTAMPTZ NOT NULL,
    "source_sha" TEXT NOT NULL,
    "requested_model" TEXT,
    "effective_model" TEXT,
    "requested_effort" TEXT,
    "effective_effort" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_evidence" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "producer" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "remote_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "verification_mode" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "source_sha" TEXT NOT NULL,
    "artifact_digest" TEXT,
    "criterion_ids" TEXT[],
    "object_key" TEXT NOT NULL,
    "content_digest" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ NOT NULL,
    "invalidated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_events" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "step_id" UUID,
    "attempt_id" UUID,
    "aggregate_key" TEXT NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "policy_version" TEXT NOT NULL DEFAULT 'disabled-v1',
    "type" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_step_reports" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "difficulty_reason" TEXT NOT NULL,
    "issues" JSONB NOT NULL,
    "remaining_uncertainty" TEXT NOT NULL,
    "next_action" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_step_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_report_evidence" (
    "owner_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,

    CONSTRAINT "delivery_report_evidence_pkey" PRIMARY KEY ("owner_id","report_id","evidence_id")
);

-- CreateTable
CREATE TABLE "delivery_outbox" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'push',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_projects_owner_id_id_key" ON "delivery_projects"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_projects_owner_id_provider_provider_repository_id_key" ON "delivery_projects"("owner_id", "provider", "provider_repository_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_conversations_owner_id_id_key" ON "delivery_conversations"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_conversations_owner_id_project_id_id_key" ON "delivery_conversations"("owner_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_conversations_owner_id_workspace_id_native_thread__key" ON "delivery_conversations"("owner_id", "workspace_id", "native_thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_epics_owner_id_id_key" ON "delivery_epics"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_epics_owner_id_project_id_id_key" ON "delivery_epics"("owner_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_tasks_owner_id_id_key" ON "delivery_tasks"("owner_id", "id");

-- CreateIndex
CREATE INDEX "delivery_steps_owner_id_task_id_state_idx" ON "delivery_steps"("owner_id", "task_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_steps_owner_id_id_key" ON "delivery_steps"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_steps_owner_id_task_id_id_key" ON "delivery_steps"("owner_id", "task_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_owner_id_id_key" ON "delivery_attempts"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_owner_id_step_id_id_key" ON "delivery_attempts"("owner_id", "step_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_owner_id_step_id_lease_generation_key" ON "delivery_attempts"("owner_id", "step_id", "lease_generation");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_evidence_owner_id_id_key" ON "delivery_evidence"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_evidence_owner_id_step_id_id_key" ON "delivery_evidence"("owner_id", "step_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_evidence_owner_id_step_id_producer_remote_id_key" ON "delivery_evidence"("owner_id", "step_id", "producer", "remote_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_events_owner_id_id_key" ON "delivery_events"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_events_owner_id_aggregate_key_aggregate_version_key" ON "delivery_events"("owner_id", "aggregate_key", "aggregate_version");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_step_reports_event_id_key" ON "delivery_step_reports"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_step_reports_owner_id_id_key" ON "delivery_step_reports"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_step_reports_owner_id_step_id_id_key" ON "delivery_step_reports"("owner_id", "step_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_step_reports_owner_id_event_id_key" ON "delivery_step_reports"("owner_id", "event_id");

-- CreateIndex
CREATE INDEX "delivery_outbox_status_next_attempt_at_idx" ON "delivery_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_outbox_owner_id_id_key" ON "delivery_outbox"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_outbox_owner_id_event_id_channel_key" ON "delivery_outbox"("owner_id", "event_id", "channel");

-- AddForeignKey
ALTER TABLE "delivery_projects" ADD CONSTRAINT "delivery_projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_conversations" ADD CONSTRAINT "delivery_conversations_owner_id_project_id_fkey" FOREIGN KEY ("owner_id", "project_id") REFERENCES "delivery_projects"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_epics" ADD CONSTRAINT "delivery_epics_owner_id_project_id_fkey" FOREIGN KEY ("owner_id", "project_id") REFERENCES "delivery_projects"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_tasks" ADD CONSTRAINT "delivery_tasks_owner_id_project_id_fkey" FOREIGN KEY ("owner_id", "project_id") REFERENCES "delivery_projects"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_tasks" ADD CONSTRAINT "delivery_tasks_owner_id_project_id_epic_id_fkey" FOREIGN KEY ("owner_id", "project_id", "epic_id") REFERENCES "delivery_epics"("owner_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_tasks" ADD CONSTRAINT "delivery_tasks_owner_id_project_id_conversation_id_fkey" FOREIGN KEY ("owner_id", "project_id", "conversation_id") REFERENCES "delivery_conversations"("owner_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_steps" ADD CONSTRAINT "delivery_steps_owner_id_task_id_fkey" FOREIGN KEY ("owner_id", "task_id") REFERENCES "delivery_tasks"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_step_dependencies" ADD CONSTRAINT "delivery_step_dependencies_owner_id_task_id_step_id_fkey" FOREIGN KEY ("owner_id", "task_id", "step_id") REFERENCES "delivery_steps"("owner_id", "task_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_step_dependencies" ADD CONSTRAINT "delivery_step_dependencies_owner_id_task_id_depends_on_ste_fkey" FOREIGN KEY ("owner_id", "task_id", "depends_on_step_id") REFERENCES "delivery_steps"("owner_id", "task_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_owner_id_step_id_fkey" FOREIGN KEY ("owner_id", "step_id") REFERENCES "delivery_steps"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_evidence" ADD CONSTRAINT "delivery_evidence_owner_id_step_id_fkey" FOREIGN KEY ("owner_id", "step_id") REFERENCES "delivery_steps"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_owner_id_task_id_fkey" FOREIGN KEY ("owner_id", "task_id") REFERENCES "delivery_tasks"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_owner_id_task_id_step_id_fkey" FOREIGN KEY ("owner_id", "task_id", "step_id") REFERENCES "delivery_steps"("owner_id", "task_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_owner_id_step_id_attempt_id_fkey" FOREIGN KEY ("owner_id", "step_id", "attempt_id") REFERENCES "delivery_attempts"("owner_id", "step_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_step_reports" ADD CONSTRAINT "delivery_step_reports_owner_id_step_id_fkey" FOREIGN KEY ("owner_id", "step_id") REFERENCES "delivery_steps"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_step_reports" ADD CONSTRAINT "delivery_step_reports_owner_id_step_id_attempt_id_fkey" FOREIGN KEY ("owner_id", "step_id", "attempt_id") REFERENCES "delivery_attempts"("owner_id", "step_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_step_reports" ADD CONSTRAINT "delivery_step_reports_owner_id_event_id_fkey" FOREIGN KEY ("owner_id", "event_id") REFERENCES "delivery_events"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_report_evidence" ADD CONSTRAINT "delivery_report_evidence_owner_id_step_id_report_id_fkey" FOREIGN KEY ("owner_id", "step_id", "report_id") REFERENCES "delivery_step_reports"("owner_id", "step_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_report_evidence" ADD CONSTRAINT "delivery_report_evidence_owner_id_step_id_evidence_id_fkey" FOREIGN KEY ("owner_id", "step_id", "evidence_id") REFERENCES "delivery_evidence"("owner_id", "step_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_owner_id_event_id_fkey" FOREIGN KEY ("owner_id", "event_id") REFERENCES "delivery_events"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Bound disabled foundation state and preserve owner/attempt consistency.
ALTER TABLE delivery_tasks ADD CONSTRAINT delivery_tasks_release_disabled CHECK (release_mode = 'disabled');
ALTER TABLE delivery_steps ADD CONSTRAINT delivery_steps_counters CHECK (version >= 0 AND lease_generation >= 0 AND attempt_count >= 0 AND attempt_budget BETWEEN 1 AND 5 AND cardinality(criterion_ids) BETWEEN 1 AND 20 AND cardinality(required_evidence_kinds) BETWEEN 1 AND 7);
ALTER TABLE delivery_steps ADD CONSTRAINT delivery_steps_state CHECK (state IN ('pending','ready','running','waiting_external','blocked','succeeded','failed','canceled'));
ALTER TABLE delivery_step_dependencies ADD CONSTRAINT delivery_dependency_not_self CHECK (step_id <> depends_on_step_id);
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempt_generation CHECK (lease_generation > 0);
ALTER TABLE delivery_events ADD CONSTRAINT delivery_event_attempt_step CHECK (attempt_id IS NULL OR step_id IS NOT NULL);
ALTER TABLE delivery_events ADD CONSTRAINT delivery_event_version CHECK (aggregate_version >= 0 AND schema_version = 1);
ALTER TABLE delivery_outbox ADD CONSTRAINT delivery_outbox_status CHECK (status IN ('pending','processing','delivered','failed') AND attempts >= 0);

COMMIT;

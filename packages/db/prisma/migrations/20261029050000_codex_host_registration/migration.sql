-- CreateTable
CREATE TABLE "codex_host_slots" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "coder_origin" TEXT NOT NULL,
    "coder_owner_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "active_registration_id" UUID,

    CONSTRAINT "codex_host_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_registration_grants" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "binding" JSONB NOT NULL,
    "binding_digest" TEXT NOT NULL,
    "token_digest" TEXT,
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,

    CONSTRAINT "codex_registration_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_host_registrations" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "binding" JSONB NOT NULL,
    "build_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "app_origin" TEXT NOT NULL,
    "server_instance_id" TEXT NOT NULL,
    "protocol_version" TEXT NOT NULL,
    "host_public_key_pem" TEXT NOT NULL,
    "host_key_fingerprint" TEXT NOT NULL,
    "registered_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "heartbeat_sequence" INTEGER NOT NULL DEFAULT 0,
    "heartbeat_nonce" UUID NOT NULL,

    CONSTRAINT "codex_host_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_registered_threads" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "registration_id" UUID NOT NULL,
    "native_thread_id" TEXT NOT NULL,

    CONSTRAINT "codex_registered_threads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "codex_host_slots_owner_id_id_key" ON "codex_host_slots"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_host_slots_owner_id_coder_origin_workspace_id_agent_i_key" ON "codex_host_slots"("owner_id", "coder_origin", "workspace_id", "agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_registration_grants_token_digest_key" ON "codex_registration_grants"("token_digest");

-- CreateIndex
CREATE UNIQUE INDEX "codex_registration_grants_slot_id_generation_key" ON "codex_registration_grants"("slot_id", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "codex_host_registrations_owner_id_id_key" ON "codex_host_registrations"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_host_registrations_owner_id_slot_id_id_key" ON "codex_host_registrations"("owner_id", "slot_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_host_registrations_slot_id_generation_key" ON "codex_host_registrations"("slot_id", "generation");

-- CreateIndex
CREATE INDEX "codex_registered_threads_owner_id_project_id_idx" ON "codex_registered_threads"("owner_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_registered_threads_registration_id_project_id_key" ON "codex_registered_threads"("registration_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_registered_threads_registration_id_native_thread_id_key" ON "codex_registered_threads"("registration_id", "native_thread_id");

-- AddForeignKey
ALTER TABLE "codex_host_slots" ADD CONSTRAINT "codex_host_slots_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_registration_grants" ADD CONSTRAINT "codex_registration_grants_owner_id_slot_id_fkey" FOREIGN KEY ("owner_id", "slot_id") REFERENCES "codex_host_slots"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_host_registrations" ADD CONSTRAINT "codex_host_registrations_owner_id_slot_id_fkey" FOREIGN KEY ("owner_id", "slot_id") REFERENCES "codex_host_slots"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_registered_threads" ADD CONSTRAINT "codex_registered_threads_owner_id_project_id_fkey" FOREIGN KEY ("owner_id", "project_id") REFERENCES "delivery_projects"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_registered_threads" ADD CONSTRAINT "codex_registered_threads_owner_id_project_id_conversation__fkey" FOREIGN KEY ("owner_id", "project_id", "conversation_id") REFERENCES "delivery_conversations"("owner_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_registered_threads" ADD CONSTRAINT "codex_registered_threads_owner_id_registration_id_fkey" FOREIGN KEY ("owner_id", "registration_id") REFERENCES "codex_host_registrations"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The active pointer must belong to this exact owner and slot.
ALTER TABLE "codex_host_slots" ADD CONSTRAINT "codex_host_slots_active_registration_fkey" FOREIGN KEY ("owner_id", "id", "active_registration_id") REFERENCES "codex_host_registrations"("owner_id", "slot_id", "id") ON DELETE RESTRICT;
ALTER TABLE "codex_host_slots" ADD CONSTRAINT "codex_host_slots_generation_positive" CHECK (generation >= 0);
ALTER TABLE "codex_host_registrations" ADD CONSTRAINT "codex_host_registration_lease_bounded" CHECK (expires_at > registered_at AND protocol_version = '0.165.0' AND heartbeat_sequence >= 0);

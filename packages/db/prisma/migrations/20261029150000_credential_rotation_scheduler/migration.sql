-- CreateTable
CREATE TABLE "credential_rotation_schedules" (
    "id" UUID NOT NULL,
    "configured_origin" TEXT NOT NULL,
    "after_id" UUID,
    "holder" UUID,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ,
    "next_run_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sweep_started_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_rotation_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_rotation_operations" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "token_id" UUID NOT NULL,
    "token_version" INTEGER NOT NULL,
    "coder_user_id" UUID NOT NULL,
    "configured_origin" TEXT NOT NULL,
    "holder" UUID NOT NULL,
    "schedule_generation" INTEGER NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'minting',
    "remote_key_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "credential_rotation_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_expiry_notices" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "token_id" UUID NOT NULL,
    "token_version" INTEGER NOT NULL,
    "configured_origin" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_expiry_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credential_rotation_schedules_configured_origin_key" ON "credential_rotation_schedules"("configured_origin");

-- CreateIndex
CREATE INDEX "credential_rotation_operations_phase_created_at_idx" ON "credential_rotation_operations"("phase", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "credential_rotation_operations_token_id_token_version_key" ON "credential_rotation_operations"("token_id", "token_version");

-- CreateIndex
CREATE INDEX "credential_expiry_notices_configured_origin_status_next_att_idx" ON "credential_expiry_notices"("configured_origin", "status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "credential_expiry_notices_token_id_token_version_key" ON "credential_expiry_notices"("token_id", "token_version");

-- CreateIndex
CREATE UNIQUE INDEX "coder_tokens_user_id_id_key" ON "coder_tokens"("user_id", "id");

-- AddForeignKey
ALTER TABLE "credential_rotation_operations" ADD CONSTRAINT "credential_rotation_operations_owner_id_token_id_fkey" FOREIGN KEY ("owner_id", "token_id") REFERENCES "coder_tokens"("user_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "credential_rotation_operations" ADD CONSTRAINT "credential_rotation_operations_configured_origin_fkey" FOREIGN KEY ("configured_origin") REFERENCES "credential_rotation_schedules"("configured_origin") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "credential_expiry_notices" ADD CONSTRAINT "credential_expiry_notices_owner_id_token_id_fkey" FOREIGN KEY ("owner_id", "token_id") REFERENCES "coder_tokens"("user_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- One consumed remote mint reservation per immutable credential generation.
-- Expired scheduler leases never erase this reservation or authorize reminting.
ALTER TABLE credential_rotation_schedules
  ADD CONSTRAINT credential_rotation_schedule_bounds CHECK (
    generation>=0 AND length(configured_origin) BETWEEN 1 AND 2048
    AND ((holder IS NULL)=(lease_until IS NULL))
  );
ALTER TABLE credential_rotation_operations
  ADD CONSTRAINT credential_rotation_operation_bounds CHECK (
    token_version>=1 AND schedule_generation>=1
    AND phase IN ('minting','stored','not_stored','uncertain')
    AND (remote_key_id IS NULL OR remote_key_id ~ '^[A-Za-z0-9]{10}$')
    AND (reason IS NULL OR reason IN ('stored','mint_unknown','write_unknown','rolled_back','cleanup_failed'))
    AND ((phase='minting' AND finished_at IS NULL AND reason IS NULL AND remote_key_id IS NULL)
      OR (phase<>'minting' AND finished_at IS NOT NULL AND reason IS NOT NULL))
    AND (phase<>'stored' OR remote_key_id IS NOT NULL)
  );
ALTER TABLE credential_expiry_notices
  ADD CONSTRAINT credential_expiry_notice_bounds CHECK (
    token_version>=1 AND attempts BETWEEN 0 AND 5
    AND status IN ('pending','processing','delivered','failed','skipped')
    AND length(configured_origin) BETWEEN 1 AND 2048
  );

CREATE FUNCTION preserve_credential_rotation_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'credential rotation reservations require independent reconciliation';
  END IF;
  IF OLD.phase<>'minting' OR NEW.phase='minting'
    OR (to_jsonb(OLD)-ARRAY['phase','remote_key_id','reason','finished_at'])
      IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['phase','remote_key_id','reason','finished_at']) THEN
    RAISE EXCEPTION 'immutable credential rotation reservation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credential_rotation_operation_immutable
  BEFORE UPDATE OR DELETE ON credential_rotation_operations
  FOR EACH ROW EXECUTE FUNCTION preserve_credential_rotation_operation();

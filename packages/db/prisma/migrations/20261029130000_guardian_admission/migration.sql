-- CreateTable
CREATE TABLE "codex_guardian_runtimes" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "lifetime_id" UUID NOT NULL,
    "binding_digest" TEXT NOT NULL,
    "outer_public_key_pem" TEXT NOT NULL,
    "outer_key_fingerprint" TEXT NOT NULL,
    "binding" JSONB NOT NULL,
    "package_manifest_sha256" TEXT NOT NULL,
    "guardian_elf_sha256" TEXT NOT NULL,
    "node_sha256" TEXT NOT NULL,
    "policy_digest" TEXT NOT NULL,
    "metadata_policy_digest" TEXT NOT NULL,
    "config_sha256" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "build_id" UUID NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'reserved',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "producer_approved" BOOLEAN NOT NULL DEFAULT false,
    "server_instance_id" TEXT,
    "host_key_fingerprint" TEXT,
    "native_launch_id" UUID,
    "native_launch_digest" TEXT,
    "native_launch_at" TIMESTAMPTZ,
    "authority_until" TIMESTAMPTZ NOT NULL,
    "closed_barrier_id" UUID,
    "enrolled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "codex_guardian_runtimes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_guardian_enrollment_grants" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "runtime_id" UUID NOT NULL,
    "token_digest" TEXT NOT NULL,
    "binding_digest" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "consumption_digest" TEXT,

    CONSTRAINT "codex_guardian_enrollment_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_guardian_admissions" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "runtime_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "preparation_intent_id" UUID NOT NULL,
    "preparation_digest" TEXT NOT NULL,
    "preparation" JSONB NOT NULL,
    "intent_request_digest" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'preparation',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "checkout_binding" JSONB,
    "checkout_binding_digest" TEXT,
    "checkout_incarnation" UUID,
    "lease_id" UUID,
    "lease_generation" INTEGER,
    "registration_id" UUID,
    "native_thread_id" TEXT,
    "producer_digest" TEXT,
    "metadata_pins" JSONB,
    "metadata_pins_digest" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkout_bound_at" TIMESTAMPTZ,
    "native_bound_at" TIMESTAMPTZ,

    CONSTRAINT "codex_guardian_admissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_guardian_barriers" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "runtime_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "ownership_digest" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "closed_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "codex_guardian_barriers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codex_guardian_stop_decisions" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "runtime_id" UUID NOT NULL,
    "barrier_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "admission_generation" INTEGER NOT NULL,
    "state_digest" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "decided_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "codex_guardian_stop_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_runtimes_owner_id_id_key" ON "codex_guardian_runtimes"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_runtimes_owner_id_slot_id_lifetime_id_key" ON "codex_guardian_runtimes"("owner_id", "slot_id", "lifetime_id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_runtimes_owner_id_outer_key_fingerprint_life_key" ON "codex_guardian_runtimes"("owner_id", "outer_key_fingerprint", "lifetime_id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_enrollment_grants_token_digest_key" ON "codex_guardian_enrollment_grants"("token_digest");

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_enrollment_grants_owner_id_id_key" ON "codex_guardian_enrollment_grants"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_admissions_owner_id_id_key" ON "codex_guardian_admissions"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_admissions_owner_id_runtime_id_id_key" ON "codex_guardian_admissions"("owner_id", "runtime_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_admissions_owner_id_runtime_id_project_id_key" ON "codex_guardian_admissions"("owner_id", "runtime_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_barriers_owner_id_id_key" ON "codex_guardian_barriers"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_barriers_owner_id_runtime_id_id_key" ON "codex_guardian_barriers"("owner_id", "runtime_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_barriers_owner_id_runtime_id_generation_key" ON "codex_guardian_barriers"("owner_id", "runtime_id", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_stop_decisions_owner_id_id_key" ON "codex_guardian_stop_decisions"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "codex_guardian_stop_decisions_owner_id_barrier_id_admission_key" ON "codex_guardian_stop_decisions"("owner_id", "barrier_id", "admission_id");

-- AddForeignKey
ALTER TABLE "codex_guardian_runtimes" ADD CONSTRAINT "codex_guardian_runtimes_owner_id_slot_id_fkey" FOREIGN KEY ("owner_id", "slot_id") REFERENCES "codex_host_slots"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_guardian_enrollment_grants" ADD CONSTRAINT "codex_guardian_enrollment_grants_owner_id_runtime_id_fkey" FOREIGN KEY ("owner_id", "runtime_id") REFERENCES "codex_guardian_runtimes"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_guardian_admissions" ADD CONSTRAINT "codex_guardian_admissions_owner_id_runtime_id_fkey" FOREIGN KEY ("owner_id", "runtime_id") REFERENCES "codex_guardian_runtimes"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_guardian_admissions" ADD CONSTRAINT "codex_guardian_admissions_owner_id_project_id_fkey" FOREIGN KEY ("owner_id", "project_id") REFERENCES "delivery_projects"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_guardian_admissions" ADD CONSTRAINT "codex_guardian_admissions_owner_id_project_id_preparation__fkey" FOREIGN KEY ("owner_id", "project_id", "preparation_intent_id") REFERENCES "project_task_intents"("owner_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_guardian_admissions" ADD CONSTRAINT "codex_guardian_admissions_owner_id_registration_id_fkey" FOREIGN KEY ("owner_id", "registration_id") REFERENCES "codex_host_registrations"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_guardian_barriers" ADD CONSTRAINT "codex_guardian_barriers_owner_id_runtime_id_fkey" FOREIGN KEY ("owner_id", "runtime_id") REFERENCES "codex_guardian_runtimes"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_guardian_stop_decisions" ADD CONSTRAINT "codex_guardian_stop_decisions_owner_id_runtime_id_barrier__fkey" FOREIGN KEY ("owner_id", "runtime_id", "barrier_id") REFERENCES "codex_guardian_barriers"("owner_id", "runtime_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codex_guardian_stop_decisions" ADD CONSTRAINT "codex_guardian_stop_decisions_owner_id_runtime_id_admissio_fkey" FOREIGN KEY ("owner_id", "runtime_id", "admission_id") REFERENCES "codex_guardian_admissions"("owner_id", "runtime_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Expiry is not a tree-exit certificate. A closed input barrier still prevents
-- replacing this lifetime until a separately verified tree receipt is ingested.
CREATE UNIQUE INDEX codex_guardian_unresolved_slot_key
  ON codex_guardian_runtimes(owner_id, slot_id) WHERE phase <> 'tree_closed';
ALTER TABLE codex_guardian_runtimes ADD CONSTRAINT codex_guardian_runtime_state_check CHECK (
  phase IN ('reserved','open','barrier_closed','tree_closed') AND generation > 0
  AND (closed_barrier_id IS NULL) = (phase IN ('reserved','open'))
  AND (server_instance_id IS NULL) = (host_key_fingerprint IS NULL)
  AND (native_launch_id IS NULL) = (native_launch_digest IS NULL)
  AND (native_launch_id IS NULL) = (native_launch_at IS NULL)
  AND outer_key_fingerprint ~ '^[a-f0-9]{64}$'
  AND binding_digest ~ '^[a-f0-9]{64}$'
  AND package_manifest_sha256 ~ '^[a-f0-9]{64}$'
  AND guardian_elf_sha256 ~ '^[a-f0-9]{64}$' AND node_sha256 ~ '^[a-f0-9]{64}$'
  AND policy_digest ~ '^[a-f0-9]{64}$' AND metadata_policy_digest ~ '^[a-f0-9]{64}$'
  AND config_sha256 ~ '^[a-f0-9]{64}$'
);
ALTER TABLE codex_guardian_runtimes ADD CONSTRAINT codex_guardian_closed_barrier_fkey
  FOREIGN KEY(owner_id,id,closed_barrier_id)
  REFERENCES codex_guardian_barriers(owner_id,runtime_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE codex_guardian_enrollment_grants ADD CONSTRAINT codex_guardian_grant_state_check CHECK (
  expires_at > issued_at AND expires_at <= issued_at + interval '60 seconds'
  AND (consumed_at IS NULL) = (consumption_digest IS NULL)
  AND token_digest ~ '^[a-f0-9]{64}$' AND binding_digest ~ '^[a-f0-9]{64}$'
);
ALTER TABLE codex_guardian_admissions ADD CONSTRAINT codex_guardian_admission_state_check CHECK (
  phase IN ('preparation','checkout','native') AND generation > 0
  AND preparation_digest ~ '^[a-f0-9]{64}$' AND intent_request_digest ~ '^[a-f0-9]{64}$'
  AND (phase = 'preparation') = (checkout_binding IS NULL)
  AND (checkout_binding IS NULL) = (checkout_binding_digest IS NULL)
  AND (checkout_binding IS NULL) = (checkout_incarnation IS NULL)
  AND (checkout_binding IS NULL) = (lease_id IS NULL)
  AND (checkout_binding IS NULL) = (lease_generation IS NULL)
  AND (checkout_binding IS NULL) = (checkout_bound_at IS NULL)
  AND (lease_generation IS NULL OR lease_generation > 0)
  AND (phase = 'native') = (registration_id IS NOT NULL)
  AND (registration_id IS NULL) = (native_thread_id IS NULL)
  AND (registration_id IS NULL) = (producer_digest IS NULL)
  AND (registration_id IS NULL) = (native_bound_at IS NULL)
  AND (registration_id IS NULL) = (metadata_pins IS NULL)
  AND (registration_id IS NULL) = (metadata_pins_digest IS NULL)
);
CREATE FUNCTION codex_guardian_runtime_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'guardian runtime is retained'; END IF;
  IF (to_jsonb(NEW)-ARRAY['phase','generation','producer_approved','authority_until','server_instance_id','host_key_fingerprint','native_launch_id','native_launch_digest','native_launch_at','enrolled_at','closed_barrier_id'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','generation','producer_approved','authority_until','server_instance_id','host_key_fingerprint','native_launch_id','native_launch_digest','native_launch_at','enrolled_at','closed_barrier_id'])
     OR NEW.generation < OLD.generation OR NEW.generation > OLD.generation+1
     OR (OLD.server_instance_id IS NOT NULL AND (NEW.server_instance_id,NEW.host_key_fingerprint) IS DISTINCT FROM (OLD.server_instance_id,OLD.host_key_fingerprint))
     OR (OLD.native_launch_id IS NOT NULL AND (NEW.native_launch_id,NEW.native_launch_digest,NEW.native_launch_at) IS DISTINCT FROM (OLD.native_launch_id,OLD.native_launch_digest,OLD.native_launch_at))
     OR (OLD.enrolled_at IS NOT NULL AND NEW.enrolled_at IS DISTINCT FROM OLD.enrolled_at)
     OR (OLD.closed_barrier_id IS NOT NULL AND NEW.closed_barrier_id IS DISTINCT FROM OLD.closed_barrier_id)
     OR (OLD.phase='reserved' AND NEW.phase NOT IN ('reserved','open'))
     OR (OLD.phase='open' AND NEW.phase NOT IN ('open','barrier_closed'))
     OR (OLD.phase='barrier_closed' AND NEW.phase NOT IN ('barrier_closed','tree_closed'))
     OR (OLD.phase='tree_closed' AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'guardian runtime identity or transition rejected'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER codex_guardian_runtime_integrity BEFORE UPDATE OR DELETE ON codex_guardian_runtimes
  FOR EACH ROW EXECUTE FUNCTION codex_guardian_runtime_integrity();
CREATE FUNCTION codex_guardian_admission_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'guardian admission is retained'; END IF;
  IF (to_jsonb(NEW)-ARRAY['phase','generation','checkout_binding','checkout_binding_digest','checkout_incarnation','lease_id','lease_generation','registration_id','native_thread_id','producer_digest','metadata_pins','metadata_pins_digest','checkout_bound_at','native_bound_at'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','generation','checkout_binding','checkout_binding_digest','checkout_incarnation','lease_id','lease_generation','registration_id','native_thread_id','producer_digest','metadata_pins','metadata_pins_digest','checkout_bound_at','native_bound_at'])
     OR NEW.generation < OLD.generation OR NEW.generation > OLD.generation+1
     OR (OLD.checkout_binding IS NOT NULL AND (NEW.checkout_binding,NEW.checkout_binding_digest,NEW.checkout_incarnation,NEW.lease_id,NEW.lease_generation,NEW.checkout_bound_at)
         IS DISTINCT FROM (OLD.checkout_binding,OLD.checkout_binding_digest,OLD.checkout_incarnation,OLD.lease_id,OLD.lease_generation,OLD.checkout_bound_at))
     OR (OLD.registration_id IS NOT NULL AND (NEW.registration_id,NEW.native_thread_id,NEW.producer_digest,NEW.metadata_pins,NEW.metadata_pins_digest,NEW.native_bound_at)
         IS DISTINCT FROM (OLD.registration_id,OLD.native_thread_id,OLD.producer_digest,OLD.metadata_pins,OLD.metadata_pins_digest,OLD.native_bound_at))
     OR (OLD.phase='preparation' AND NEW.phase NOT IN ('preparation','checkout'))
     OR (OLD.phase='checkout' AND NEW.phase NOT IN ('checkout','native'))
     OR (OLD.phase='native' AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'guardian admission identity or transition rejected'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER codex_guardian_admission_integrity BEFORE UPDATE OR DELETE ON codex_guardian_admissions
  FOR EACH ROW EXECUTE FUNCTION codex_guardian_admission_integrity();
CREATE FUNCTION codex_guardian_grant_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'guardian grant is retained'; END IF;
  IF (to_jsonb(NEW)-ARRAY['consumed_at','consumption_digest']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_at','consumption_digest'])
     OR (OLD.consumed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'guardian grant is immutable after consumption'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER codex_guardian_grant_integrity BEFORE UPDATE OR DELETE ON codex_guardian_enrollment_grants
  FOR EACH ROW EXECUTE FUNCTION codex_guardian_grant_integrity();
CREATE FUNCTION codex_guardian_stop_record_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'guardian stop records are append-only'; END $$;
CREATE TRIGGER codex_guardian_barrier_integrity BEFORE UPDATE OR DELETE ON codex_guardian_barriers
  FOR EACH ROW EXECUTE FUNCTION codex_guardian_stop_record_integrity();
CREATE TRIGGER codex_guardian_stop_decision_integrity BEFORE UPDATE OR DELETE ON codex_guardian_stop_decisions
  FOR EACH ROW EXECUTE FUNCTION codex_guardian_stop_record_integrity();

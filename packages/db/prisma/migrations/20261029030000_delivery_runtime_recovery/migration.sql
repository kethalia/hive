BEGIN;

-- AlterTable
ALTER TABLE "delivery_steps" ADD COLUMN     "waiting_reason" TEXT;

-- AlterTable
ALTER TABLE "delivery_attempts" ADD COLUMN     "quiesced_at" TIMESTAMPTZ,
ADD COLUMN     "runtime_binding" JSONB,
ADD COLUMN     "runtime_binding_digest" TEXT,
ADD COLUMN     "runtime_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "delivery_events" ADD COLUMN     "payload" JSONB;

-- CreateIndex
CREATE INDEX "delivery_runtime_events_lookup" ON "delivery_events"("owner_id", "task_id", "attempt_id", "aggregate_version");


ALTER TABLE delivery_steps ADD CONSTRAINT delivery_waiting_reason_bound CHECK (waiting_reason IS NULL OR length(waiting_reason) <= 1000);
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_runtime_binding_pair CHECK ((runtime_binding IS NULL) = (runtime_binding_digest IS NULL));
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_runtime_binding_shape CHECK (runtime_binding IS NULL OR (jsonb_typeof(runtime_binding) = 'object' AND runtime_binding_digest ~ '^[a-f0-9]{64}$'));
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_runtime_version_nonnegative CHECK (runtime_version >= 0 AND (quiesced_at IS NULL OR runtime_binding IS NOT NULL));
ALTER TABLE delivery_events ADD CONSTRAINT delivery_event_payload_bound CHECK (payload IS NULL OR (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 65536));
CREATE FUNCTION hive_delivery_runtime_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.runtime_binding IS NOT NULL AND NEW.runtime_binding IS DISTINCT FROM OLD.runtime_binding THEN
    RAISE EXCEPTION 'Native runtime identity is immutable';
  END IF;
  IF OLD.runtime_binding_digest IS NOT NULL AND NEW.runtime_binding_digest IS DISTINCT FROM OLD.runtime_binding_digest THEN
    RAISE EXCEPTION 'Native runtime binding digest is immutable';
  END IF;
  IF OLD.quiesced_at IS NOT NULL AND NEW.quiesced_at IS DISTINCT FROM OLD.quiesced_at THEN
    RAISE EXCEPTION 'Accepted quiescence history is immutable';
  END IF;
  IF NEW.runtime_version < OLD.runtime_version THEN
    RAISE EXCEPTION 'Native observation version cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_runtime_immutable BEFORE UPDATE ON delivery_attempts
FOR EACH ROW EXECUTE FUNCTION hive_delivery_runtime_immutable();

COMMIT;

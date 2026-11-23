-- Existing lifetimes cannot acquire retroactive operation receipts. The runtime
-- integrity trigger already makes every field outside its mutable allowlist immutable.
ALTER TABLE codex_guardian_runtimes ADD COLUMN operation_receipts_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE codex_guardian_operation_receipts (
  owner_id uuid NOT NULL, runtime_id uuid NOT NULL, event_id uuid NOT NULL,
  action text NOT NULL, request_digest text NOT NULL,
  input_runtime_generation integer NOT NULL, result_runtime_generation integer NOT NULL,
  result_admission_generation integer NOT NULL, response jsonb NOT NULL, response_digest text NOT NULL,
  lifetime_id uuid NOT NULL, build_id uuid NOT NULL, config_sha256 text NOT NULL,
  outer_key_fingerprint text NOT NULL, committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT codex_guardian_operation_receipts_pkey PRIMARY KEY(owner_id,runtime_id,event_id),
  CONSTRAINT guardian_operation_receipt_runtime_fk FOREIGN KEY(owner_id,runtime_id)
    REFERENCES codex_guardian_runtimes(owner_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT guardian_operation_receipt_bounds CHECK (
    action IN ('prepare','checkout','native','fence') AND request_digest ~ '^[a-f0-9]{64}$'
    AND response_digest ~ '^[a-f0-9]{64}$' AND config_sha256 ~ '^[a-f0-9]{64}$'
    AND outer_key_fingerprint ~ '^[a-f0-9]{64}$' AND input_runtime_generation>0
    AND result_runtime_generation BETWEEN input_runtime_generation AND input_runtime_generation+1
    AND result_admission_generation>0 AND jsonb_typeof(response)='object'
    AND octet_length(response::text)<=65536
  )
);
CREATE FUNCTION hive_guardian_operation_receipt_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r codex_guardian_runtimes; a codex_guardian_admissions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'guardian operation receipt is immutable'; END IF;
  SELECT * INTO r FROM codex_guardian_runtimes WHERE owner_id=NEW.owner_id AND id=NEW.runtime_id FOR UPDATE;
  SELECT * INTO a FROM codex_guardian_admissions
    WHERE owner_id=NEW.owner_id AND runtime_id=NEW.runtime_id AND id=(NEW.response->'admission'->>'id')::uuid;
  IF r.id IS NULL OR NOT r.operation_receipts_enabled OR a.id IS NULL
    OR (NEW.lifetime_id,NEW.build_id,NEW.config_sha256,NEW.outer_key_fingerprint)
      IS DISTINCT FROM (r.lifetime_id,r.build_id,r.config_sha256,r.outer_key_fingerprint)
    OR NEW.result_runtime_generation<>r.generation OR NEW.result_admission_generation<>a.generation
    OR NEW.response->'runtime'->>'id' IS DISTINCT FROM r.id::text
    OR NEW.response->'runtime'->>'ownerId' IS DISTINCT FROM r.owner_id::text
    OR NEW.response->'admission'->>'runtimeId' IS DISTINCT FROM r.id::text
    OR (NEW.response->'runtime'->>'generation')::integer IS DISTINCT FROM r.generation
    OR (NEW.response->'admission'->>'generation')::integer IS DISTINCT FROM a.generation
    OR NEW.committed_at>clock_timestamp()
  THEN RAISE EXCEPTION 'guardian operation receipt scope/result rejected'; END IF;
  IF (SELECT count(*) FROM codex_guardian_operation_receipts WHERE owner_id=NEW.owner_id AND runtime_id=NEW.runtime_id)>=1024
  THEN RAISE EXCEPTION 'guardian operation receipt limit reached'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guardian_operation_receipt_integrity BEFORE INSERT OR UPDATE OR DELETE
  ON codex_guardian_operation_receipts FOR EACH ROW EXECUTE FUNCTION hive_guardian_operation_receipt_integrity();
REVOKE ALL ON codex_guardian_operation_receipts FROM PUBLIC;
DO $$ DECLARE runtime_role text; BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['hive_app_runtime','hive_native_runtime'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format('GRANT SELECT,INSERT ON codex_guardian_operation_receipts TO %I',runtime_role);
      EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON codex_guardian_operation_receipts FROM %I',runtime_role);
    END IF;
  END LOOP;
END $$;

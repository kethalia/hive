CREATE TABLE codex_guardian_tree_receipts (
  owner_id UUID NOT NULL,
  runtime_id UUID NOT NULL,
  barrier_id UUID NOT NULL,
  receipt_id UUID NOT NULL UNIQUE,
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id, runtime_id),
  FOREIGN KEY(owner_id, runtime_id, barrier_id)
    REFERENCES codex_guardian_barriers(owner_id, runtime_id, id) ON DELETE RESTRICT
);
CREATE FUNCTION codex_guardian_tree_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'guardian tree receipt is immutable'; END $$;
CREATE TRIGGER codex_guardian_tree_receipt_immutable BEFORE UPDATE OR DELETE
  ON codex_guardian_tree_receipts FOR EACH ROW EXECUTE FUNCTION codex_guardian_tree_receipt_immutable();
CREATE FUNCTION codex_guardian_tree_receipt_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase = 'tree_closed' AND OLD.phase <> 'tree_closed' AND NOT EXISTS (
    SELECT 1 FROM codex_guardian_tree_receipts r
    WHERE r.owner_id=NEW.owner_id AND r.runtime_id=NEW.id AND r.barrier_id=NEW.closed_barrier_id
  ) THEN RAISE EXCEPTION 'guardian tree exit receipt required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER codex_guardian_tree_receipt_required BEFORE UPDATE ON codex_guardian_runtimes
  FOR EACH ROW EXECUTE FUNCTION codex_guardian_tree_receipt_required();

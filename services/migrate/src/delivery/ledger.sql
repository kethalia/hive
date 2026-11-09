-- Explicit controlled target setup, never auto-run by the delivery controller.
-- No application/runtime grants: provision a separate migration job role.
CREATE SCHEMA hive_delivery_db;
REVOKE ALL ON SCHEMA hive_delivery_db FROM PUBLIC;
CREATE TABLE hive_delivery_db.targets (
 target_id UUID PRIMARY KEY, scope JSONB NOT NULL, scope_digest TEXT NOT NULL CHECK(scope_digest ~ '^[a-f0-9]{64}$'),
 current_run UUID, generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0)
);
CREATE TABLE hive_delivery_db.runs (
 id UUID PRIMARY KEY, target_id UUID NOT NULL REFERENCES hive_delivery_db.targets(target_id),
 scope_digest TEXT NOT NULL, plan_digest TEXT NOT NULL CHECK(plan_digest ~ '^[a-f0-9]{64}$'), plan JSONB NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('pending','expanded','compatible','backfilled','verified','activated','contract_held')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), cursor BIGINT NOT NULL DEFAULT 0 CHECK(cursor>=0),
 high_water BIGINT NOT NULL DEFAULT 0 CHECK(high_water>=0), changed_rows BIGINT NOT NULL DEFAULT 0 CHECK(changed_rows>=0),
 checkpoint_digest TEXT NOT NULL CHECK(checkpoint_digest ~ '^[a-f0-9]{64}$'), compatibility JSONB, integrity JSONB, activation JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK(cursor<=high_water), CHECK(octet_length(plan::text)<=150000)
);
ALTER TABLE hive_delivery_db.targets ADD FOREIGN KEY(current_run) REFERENCES hive_delivery_db.runs(id);
CREATE TABLE hive_delivery_db.events (
 run_id UUID NOT NULL REFERENCES hive_delivery_db.runs(id), version INTEGER NOT NULL CHECK(version>0),
 kind TEXT NOT NULL, payload JSONB NOT NULL, digest TEXT NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(run_id,version), CHECK(octet_length(payload::text)<=32768)
);
CREATE FUNCTION hive_delivery_db.immutable_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Migration checkpoint history is immutable'; END $$;
CREATE TRIGGER immutable_event BEFORE UPDATE OR DELETE ON hive_delivery_db.events FOR EACH ROW EXECUTE FUNCTION hive_delivery_db.immutable_event();
REVOKE ALL ON ALL TABLES IN SCHEMA hive_delivery_db FROM PUBLIC;

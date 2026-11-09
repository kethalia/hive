-- Forward-only retirement. Migration 45 and its checksum remain unchanged.
-- Never discard publisher history automatically: any row requires operator
-- preservation/review before this migration can proceed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Block inserts before checking emptiness. These are the only explicit locks.
-- Removing their foreign keys also needs PostgreSQL metadata locks on the
-- referenced delivery_releases / delivery_release_actions tables.
LOCK TABLE ONLY delivery_native_release_artifacts,
  ONLY delivery_native_publication_grants,
  ONLY delivery_native_publication_receipts,
  ONLY delivery_native_release_baselines IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM delivery_native_release_artifacts)
     OR EXISTS (SELECT 1 FROM delivery_native_publication_grants)
     OR EXISTS (SELECT 1 FROM delivery_native_publication_receipts)
     OR EXISTS (SELECT 1 FROM delivery_native_release_baselines) THEN
    RAISE EXCEPTION 'native_publication_retirement_nonempty'
      USING ERRCODE = '23514';
  END IF;
END $$;

-- Explicit FK-safe order; RESTRICT is the default. An unexpected dependency
-- aborts and rolls back the entire retirement instead of cascading elsewhere.
DROP TABLE delivery_native_release_baselines;
DROP TABLE delivery_native_publication_receipts;
DROP TABLE delivery_native_publication_grants;
DROP TABLE delivery_native_release_artifacts;
DROP FUNCTION hive_native_baseline_insert();
DROP FUNCTION hive_native_publication_insert();
DROP FUNCTION hive_native_release_immutable();
COMMIT;

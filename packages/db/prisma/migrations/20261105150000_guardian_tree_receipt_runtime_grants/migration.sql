-- The immutable closure receipt was introduced before the restricted runtime
-- grants were added. Keep the owner-only default and grant only its read/append
-- operations to an already-provisioned application role.
REVOKE ALL ON codex_guardian_tree_receipts FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hive_app_runtime') THEN
    GRANT SELECT, INSERT ON codex_guardian_tree_receipts TO hive_app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON codex_guardian_tree_receipts FROM hive_app_runtime;
  END IF;
END $$;

-- Factual predecessor fence, not native closure or authorization retirement.
-- The runtime integrity trigger already makes fields outside its mutable
-- allowlist immutable and forbids deleting runtime history.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE codex_guardian_runtimes
  ADD COLUMN unused_bootstrap_predecessor_build_id uuid,
  ADD CONSTRAINT guardian_unused_bootstrap_distinct_build
    CHECK (unused_bootstrap_predecessor_build_id IS NULL OR unused_bootstrap_predecessor_build_id <> build_id);
CREATE INDEX guardian_unused_bootstrap_predecessor
  ON codex_guardian_runtimes(owner_id,workspace_id,unused_bootstrap_predecessor_build_id)
  WHERE unused_bootstrap_predecessor_build_id IS NOT NULL;
COMMIT;

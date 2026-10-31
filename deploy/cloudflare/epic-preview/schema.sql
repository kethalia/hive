-- Apply ONLY to the recorded isolated preview database, externally, before the
-- Worker receives its restricted role. Never apply to an existing production branch.
CREATE SCHEMA hive_epic_preview;
CREATE TABLE hive_epic_preview.probes (
  run_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('commit', 'rollback')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, phase)
);
-- The Worker role needs only USAGE on this schema and SELECT, INSERT on this
-- table. Migration credentials must not be bound into the deployed Worker.

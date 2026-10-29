BEGIN;

ALTER TABLE delivery_steps DROP CONSTRAINT delivery_steps_state;
ALTER TABLE delivery_steps ADD CONSTRAINT delivery_steps_state
  CHECK (state IN ('pending','ready','running','waiting_external','blocked','succeeded','reported','failed','canceled'));
ALTER TABLE delivery_steps ADD CONSTRAINT delivery_steps_informational_report
  CHECK (state <> 'reported' OR
    (kind = 'understand' AND acceptance_phase = 'implementation_preview'
      AND required_evidence_kinds = ARRAY['analysis']::text[]));

COMMIT;

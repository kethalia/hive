-- PostgreSQL CHECK accepts UNKNOWN. Legacy array columns are nullable at SQL
-- level, so explicitly reject NULL for the new informational terminal outcome.
ALTER TABLE delivery_steps ADD CONSTRAINT delivery_report_evidence_kind_required
  CHECK (state <> 'reported' OR required_evidence_kinds IS NOT NULL);

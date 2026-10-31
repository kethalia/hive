BEGIN;

-- Domain audit records have no update/delete operation. Retention changes need
-- their own reviewed migration rather than an application-controlled shortcut.
CREATE FUNCTION hive_delivery_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Delivery audit records are append only';
END;
$$;

CREATE TRIGGER delivery_events_append_only BEFORE UPDATE OR DELETE ON delivery_events
FOR EACH ROW EXECUTE FUNCTION hive_delivery_append_only();
CREATE TRIGGER delivery_reports_append_only BEFORE UPDATE OR DELETE ON delivery_step_reports
FOR EACH ROW EXECUTE FUNCTION hive_delivery_append_only();
CREATE TRIGGER delivery_report_evidence_append_only BEFORE UPDATE OR DELETE ON delivery_report_evidence
FOR EACH ROW EXECUTE FUNCTION hive_delivery_append_only();

-- Evidence content/identity is immutable. Explicit invalidation remains allowed
-- so changed source or withdrawn authority cannot leave an old proof eligible.
CREATE FUNCTION hive_delivery_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'invalidated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'invalidated_at') THEN
    RAISE EXCEPTION 'Delivery evidence content is immutable';
  END IF;
  IF OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at THEN
    RAISE EXCEPTION 'Delivery evidence invalidation cannot be cleared or rewritten';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_evidence_immutable BEFORE UPDATE ON delivery_evidence
FOR EACH ROW EXECUTE FUNCTION hive_delivery_evidence_immutable();

COMMIT;

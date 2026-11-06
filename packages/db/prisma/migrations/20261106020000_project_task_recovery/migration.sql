-- Explicit owner recovery is a durable "authorization", never a replacement prompt.
CREATE TABLE project_task_recoveries (
  owner_id uuid NOT NULL, task_id uuid NOT NULL, id uuid NOT NULL,
  phase text NOT NULL DEFAULT 'inspecting', scope jsonb NOT NULL,
  inspection jsonb, "authorization" jsonb, receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,id),
  FOREIGN KEY(owner_id,task_id) REFERENCES project_task_intents(owner_id,id) ON DELETE RESTRICT,
  CHECK(phase IN ('inspecting','authorized','consumed')),
  CHECK(jsonb_typeof(scope)='object' AND octet_length(scope::text)<=4096),
  CHECK(inspection IS NULL OR (jsonb_typeof(inspection)='object' AND octet_length(inspection::text)<=4096)),
  CHECK("authorization" IS NULL OR (jsonb_typeof("authorization")='object' AND octet_length("authorization"::text)<=2048)),
  CHECK(receipt IS NULL OR (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=2048)),
  CHECK((phase='inspecting' AND inspection IS NULL AND "authorization" IS NULL AND receipt IS NULL)
    OR (phase='authorized' AND inspection IS NOT NULL AND "authorization" IS NOT NULL AND receipt IS NULL)
    OR (phase='consumed' AND inspection IS NOT NULL AND "authorization" IS NOT NULL AND receipt IS NOT NULL))
);
CREATE UNIQUE INDEX project_task_recovery_active ON project_task_recoveries(owner_id,task_id) WHERE phase<>'consumed';
CREATE FUNCTION hive_project_task_recovery_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'recovery history is immutable'; END IF;
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM project_task_intents WHERE owner_id=NEW.owner_id AND id=NEW.task_id FOR UPDATE;
    IF NEW.phase<>'inspecting' OR (SELECT count(*) FROM project_task_recoveries WHERE owner_id=NEW.owner_id AND task_id=NEW.task_id)>=32
      OR NEW.scope->>'ownerId' IS DISTINCT FROM NEW.owner_id::text
      OR NEW.scope->>'taskId' IS DISTINCT FROM NEW.task_id::text
      OR NEW.scope->>'recoveryId' IS DISTINCT FROM NEW.id::text
    THEN RAISE EXCEPTION 'recovery bound rejected'; END IF;
  ELSE
    IF (NEW.owner_id,NEW.task_id,NEW.id,NEW.scope,NEW.created_at) IS DISTINCT FROM
       (OLD.owner_id,OLD.task_id,OLD.id,OLD.scope,OLD.created_at)
      OR NOT ((OLD.phase='inspecting' AND NEW.phase='authorized') OR (OLD.phase='authorized' AND NEW.phase='consumed'))
      OR (OLD.inspection IS NOT NULL AND (NEW.inspection,NEW."authorization") IS DISTINCT FROM (OLD.inspection,OLD."authorization"))
    THEN RAISE EXCEPTION 'recovery transition rejected'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_task_recovery_integrity BEFORE INSERT OR UPDATE OR DELETE ON project_task_recoveries
FOR EACH ROW EXECUTE FUNCTION hive_project_task_recovery_integrity();

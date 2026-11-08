-- Forward53: one explicitly owner/operator-authorized renewal of an unused
-- successor. Existing retirement/enrollment rows and all tree/writer guards stay.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE codex_guardian_operation_receipts DROP CONSTRAINT guardian_operation_receipt_bounds;
ALTER TABLE codex_guardian_operation_receipts ADD CONSTRAINT guardian_operation_receipt_bounds CHECK (
 action IN ('prepare','checkout','native','fence','maintenance_resume_intent','authorization_retired','unused_recovery_resumed')
 AND request_digest ~ '^[a-f0-9]{64}$' AND response_digest ~ '^[a-f0-9]{64}$'
 AND config_sha256 ~ '^[a-f0-9]{64}$' AND outer_key_fingerprint ~ '^[a-f0-9]{64}$'
 AND input_runtime_generation>0 AND result_runtime_generation BETWEEN input_runtime_generation AND input_runtime_generation+1
 AND ((action='unused_recovery_resumed' AND result_admission_generation=0) OR (action<>'unused_recovery_resumed' AND result_admission_generation>0))
 AND jsonb_typeof(response)='object' AND octet_length(response::text)<=65536
);
CREATE UNIQUE INDEX guardian_unused_resumption_once ON codex_guardian_operation_receipts(owner_id,runtime_id) WHERE action='unused_recovery_resumed';
CREATE UNIQUE INDEX guardian_unused_recovery_resumption_once ON codex_guardian_operation_receipts(owner_id,(response->'resumption'->>'recoveryId')) WHERE action='unused_recovery_resumed';

CREATE FUNCTION hive_guardian_unused_resumption(e codex_guardian_operation_receipts) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r codex_guardian_runtimes; s codex_host_slots; old_event codex_guardian_operation_receipts;
 t jsonb:=e.response->'resumption'; a jsonb:=t->'approval'; ticket jsonb:=t->'ticket'; scope jsonb:=t->'scope'; i jsonb:=t->'inspection';
 old_data jsonb; recovery project_task_recoveries; intent project_task_intents; clock_ms numeric; field text;
BEGIN
 SELECT * INTO r FROM codex_guardian_runtimes WHERE owner_id=e.owner_id AND id=e.runtime_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'unused resumption runtime missing'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('hive-account-maintenance-v1:'||e.owner_id::text||':'||(r.binding->>'coderOrigin')||':'||r.workspace_id::text,0));
 SELECT * INTO s FROM codex_host_slots WHERE owner_id=r.owner_id AND id=r.slot_id FOR UPDATE;
 SELECT * INTO r FROM codex_guardian_runtimes WHERE owner_id=e.owner_id AND id=e.runtime_id FOR UPDATE;
 IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR jsonb_typeof(a) IS DISTINCT FROM 'object'
 OR jsonb_typeof(ticket) IS DISTINCT FROM 'object' OR jsonb_typeof(scope) IS DISTINCT FROM 'object' OR jsonb_typeof(i) IS DISTINCT FROM 'object'
 OR (t ?& ARRAY['schemaVersion','recoveryId','approval','scope','retirementEventId','originalAuthorityUntil','authorityUntil','identityDigest','inspectionDigest','inspection','ticket','identityIssuedAt','identityExpiresAt','nativeTreeExited','cleanupAuthorized','writerReleased']) IS DISTINCT FROM TRUE
 OR (SELECT count(*) FROM jsonb_object_keys(t))<>16
 OR t->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR t->'nativeTreeExited' IS DISTINCT FROM 'false'::jsonb
 OR t->'cleanupAuthorized' IS DISTINCT FROM 'false'::jsonb OR t->'writerReleased' IS DISTINCT FROM 'false'::jsonb
 OR a->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR a->>'purpose' IS DISTINCT FROM 'unused-recovery-resumption'
 OR (a ?& ARRAY['schemaVersion','purpose','id','ownerId','coderOwnerId','workspaceId','projectId','taskId','recoveryId','runtimeId','retirementEventId','attestationDigest','continuationDigest','final','originalAuthorityUntil','issuedAt','expiresAt']) IS DISTINCT FROM TRUE
 OR (SELECT count(*) FROM jsonb_object_keys(a))<>17
 THEN RAISE EXCEPTION 'unused resumption shape rejected'; END IF;
 FOREACH field IN ARRAY ARRAY['identityDigest','inspectionDigest'] LOOP
   IF t->>field IS NULL OR t->>field !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'unused resumption digest rejected'; END IF;
 END LOOP;
 FOREACH field IN ARRAY ARRAY['originalAuthorityUntil','authorityUntil','identityIssuedAt','identityExpiresAt'] LOOP
   IF jsonb_typeof(t->field) IS DISTINCT FROM 'number' OR t->>field !~ '^[0-9]{1,16}$' THEN RAISE EXCEPTION 'unused resumption deadline rejected'; END IF;
 END LOOP;
 FOREACH field IN ARRAY ARRAY['originalAuthorityUntil','issuedAt','expiresAt'] LOOP
   IF jsonb_typeof(a->field) IS DISTINCT FROM 'number' OR a->>field !~ '^[0-9]{1,16}$' THEN RAISE EXCEPTION 'unused resumption approval deadline rejected'; END IF;
 END LOOP;
 SELECT * INTO old_event FROM codex_guardian_operation_receipts WHERE owner_id=e.owner_id AND event_id=(a->>'retirementEventId')::uuid AND action='authorization_retired';
 old_data:=old_event.response->'retirement';
 SELECT * INTO intent FROM project_task_intents WHERE owner_id=e.owner_id AND id=(a->>'taskId')::uuid FOR UPDATE;
 SELECT * INTO recovery FROM project_task_recoveries WHERE owner_id=e.owner_id AND id=(a->>'recoveryId')::uuid FOR UPDATE;
 clock_ms:=extract(epoch FROM clock_timestamp())*1000;
 IF r.phase IS DISTINCT FROM 'open' OR r.generation<>1 OR NOT r.operation_receipts_enabled OR r.enrolled_at IS NULL
 OR r.native_launch_id IS NOT NULL OR r.native_launch_digest IS NOT NULL OR r.native_launch_at IS NOT NULL
 OR r.server_instance_id IS NOT NULL OR r.host_key_fingerprint IS NOT NULL OR r.producer_approved OR r.closed_barrier_id IS NOT NULL OR s.active_registration_id IS NOT NULL
 OR (s.account_maintenance IS NOT NULL AND s.account_maintenance->>'phase' IS DISTINCT FROM 'finished')
 OR (e.lifetime_id,e.build_id,e.config_sha256,e.outer_key_fingerprint) IS DISTINCT FROM (r.lifetime_id,r.build_id,r.config_sha256,r.outer_key_fingerprint)
 OR e.input_runtime_generation<>1 OR e.result_runtime_generation<>1 OR e.result_admission_generation<>0
 OR a->>'id' IS DISTINCT FROM e.event_id::text OR a->>'ownerId' IS DISTINCT FROM r.owner_id::text
 OR a->>'coderOwnerId' IS DISTINCT FROM r.binding->>'ownerId' OR a->>'workspaceId' IS DISTINCT FROM r.workspace_id::text
 OR a->>'runtimeId' IS DISTINCT FROM r.id::text OR a->'final' IS DISTINCT FROM jsonb_build_object('buildId',r.build_id::text,'lifetimeId',r.lifetime_id::text,'configSha256',r.config_sha256,'packageManifestSha256',r.package_manifest_sha256)
 OR old_event.event_id IS NULL OR old_data->>'newLifetimeId' IS DISTINCT FROM r.lifetime_id::text OR old_data->'newBinding' IS DISTINCT FROM r.binding
 OR NOT EXISTS(SELECT 1 FROM codex_guardian_runtimes WHERE owner_id=e.owner_id AND id=old_event.runtime_id AND phase='authorization_retired')
 OR old_data->>'attestationDigest' IS DISTINCT FROM a->>'attestationDigest' OR old_data->>'continuationDigest' IS DISTINCT FROM a->>'continuationDigest'
 OR old_data->'attestation'->'final' IS DISTINCT FROM a->'final' OR old_data->'continuation'->'finalSuccessor' IS DISTINCT FROM a->'final'
 OR old_data->>'recoveryId' IS DISTINCT FROM a->>'recoveryId' OR t->>'recoveryId' IS DISTINCT FROM a->>'recoveryId'
 OR t->>'retirementEventId' IS DISTINCT FROM a->>'retirementEventId' OR t->'originalAuthorityUntil' IS DISTINCT FROM a->'originalAuthorityUntil'
 OR (a->>'originalAuthorityUntil')::numeric IS DISTINCT FROM floor(extract(epoch FROM r.enrolled_at)*1000)+180000
 OR extract(epoch FROM r.authority_until)*1000 NOT IN ((a->>'originalAuthorityUntil')::numeric,(t->>'authorityUntil')::numeric)
 OR (a->>'issuedAt')::numeric>clock_ms OR (a->>'expiresAt')::numeric<=clock_ms
 OR (a->>'expiresAt')::numeric<=(a->>'issuedAt')::numeric OR (a->>'expiresAt')::numeric>(a->>'issuedAt')::numeric+3600000
 OR (t->>'authorityUntil')::numeric<=clock_ms OR (t->>'authorityUntil')::numeric>(a->>'expiresAt')::numeric
 OR (t->>'authorityUntil')::numeric>extract(epoch FROM e.committed_at)*1000+180000
 OR (t->>'identityIssuedAt')::numeric>clock_ms OR (t->>'identityExpiresAt')::numeric<=clock_ms
 OR (t->>'identityExpiresAt')::numeric>(t->>'identityIssuedAt')::numeric+30000
 OR e.committed_at>clock_timestamp()
 OR recovery.id IS NULL OR recovery.phase IS DISTINCT FROM 'inspecting' OR recovery.scope IS DISTINCT FROM scope
 OR recovery.inspection IS NOT NULL OR recovery.authorization IS NOT NULL OR recovery.receipt IS NOT NULL
 OR recovery.task_id IS DISTINCT FROM intent.id OR intent.id IS NULL OR intent.phase IS DISTINCT FROM 'blocked' OR intent.ciphertext IS NULL
 OR intent.request_digest IS DISTINCT FROM scope->>'intentDigest' OR intent.source_sha IS DISTINCT FROM scope->>'revision'
 OR intent.project_id::text IS DISTINCT FROM a->>'projectId' OR intent.workspace_id::text IS DISTINCT FROM a->>'workspaceId'
 OR scope->>'taskId' IS DISTINCT FROM a->>'taskId' OR scope->>'recoveryId' IS DISTINCT FROM a->>'recoveryId'
 OR scope->>'ownerId' IS DISTINCT FROM a->>'ownerId' OR scope->>'coderOwnerId' IS DISTINCT FROM a->>'coderOwnerId'
 OR scope->>'projectId' IS DISTINCT FROM a->>'projectId' OR scope->>'workspaceId' IS DISTINCT FROM a->>'workspaceId'
 OR scope->>'hostRequestDigest' IS DISTINCT FROM old_data->'proof'->>'hostRequestDigest'
 OR scope->>'intentVersion' IS DISTINCT FROM to_char(intent.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')
 OR i->>'outcome' IS DISTINCT FROM 'existing_preexecution' OR i->'guardianGeneration' IS DISTINCT FROM '1'::jsonb
 OR i->>'lifetimeId' IS DISTINCT FROM r.lifetime_id::text OR i->>'buildId' IS DISTINCT FROM r.build_id::text
 OR i->'remount'->>'attestationDigest' IS DISTINCT FROM a->>'attestationDigest' OR i->'remount'->>'continuationDigest' IS DISTINCT FROM a->>'continuationDigest'
 OR i->'remount'->'mapping' IS DISTINCT FROM old_data->'attestation'->'mapping'
 OR ticket IS DISTINCT FROM jsonb_build_object('attestationDigest',a->'attestationDigest','continuationDigest',a->'continuationDigest','originalProofDigest',old_data->'proofDigest',
   'recoveryId',a->'recoveryId','ownerId',a->'ownerId','workspaceId',a->'workspaceId','projectId',a->'projectId','taskId',a->'taskId',
   'final',a->'final','volume',old_data->'attestation'->'volume','mapping',old_data->'attestation'->'mapping','expiresAt',a->'expiresAt')
 OR EXISTS(SELECT 1 FROM codex_guardian_admissions WHERE owner_id=r.owner_id AND runtime_id=r.id)
 OR EXISTS(SELECT 1 FROM codex_guardian_runtimes WHERE owner_id=r.owner_id AND workspace_id=r.workspace_id AND id<>r.id AND phase NOT IN ('tree_closed','authorization_retired'))
 OR EXISTS(SELECT 1 FROM codex_host_registrations g JOIN codex_host_slots x ON x.owner_id=g.owner_id AND x.id=g.slot_id WHERE x.owner_id=r.owner_id AND x.workspace_id=r.workspace_id)
 OR EXISTS(SELECT 1 FROM codex_registration_grants g JOIN codex_host_slots x ON x.owner_id=g.owner_id AND x.id=g.slot_id WHERE x.owner_id=r.owner_id AND x.workspace_id=r.workspace_id)
 OR EXISTS(SELECT 1 FROM codex_host_registrations WHERE owner_id=r.owner_id AND slot_id=r.slot_id)
 OR EXISTS(SELECT 1 FROM codex_registration_grants WHERE owner_id=r.owner_id AND slot_id=r.slot_id)
 OR (SELECT count(*) FROM codex_guardian_enrollment_grants WHERE owner_id=r.owner_id AND runtime_id=r.id)<>1
 OR NOT EXISTS(SELECT 1 FROM codex_guardian_enrollment_grants WHERE owner_id=r.owner_id AND runtime_id=r.id AND consumed_at=r.enrolled_at AND consumption_digest IS NOT NULL)
 OR EXISTS(SELECT 1 FROM project_task_recoveries WHERE owner_id=r.owner_id AND task_id=recovery.task_id AND phase<>'consumed' AND id<>recovery.id)
 OR EXISTS(SELECT 1 FROM codex_guardian_operation_receipts WHERE owner_id=r.owner_id AND runtime_id=r.id AND event_id<>e.event_id)
 THEN RAISE EXCEPTION 'unused recovery resumption rejected'; END IF;
END $$;

CREATE FUNCTION hive_guardian_unused_resumption_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM hive_guardian_unused_resumption(NEW);
 IF NOT EXISTS(SELECT 1 FROM codex_guardian_runtimes WHERE owner_id=NEW.owner_id AND id=NEW.runtime_id AND authority_until<=clock_timestamp()) THEN RAISE EXCEPTION 'unused renewal requires expired authority'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER guardian_operation_receipt_integrity ON codex_guardian_operation_receipts;
CREATE TRIGGER guardian_operation_receipt_integrity BEFORE UPDATE OR DELETE ON codex_guardian_operation_receipts FOR EACH ROW EXECUTE FUNCTION hive_guardian_operation_receipt_integrity();
CREATE TRIGGER guardian_operation_receipt_insert BEFORE INSERT ON codex_guardian_operation_receipts FOR EACH ROW WHEN (NEW.action<>'unused_recovery_resumed') EXECUTE FUNCTION hive_guardian_operation_receipt_integrity();
CREATE TRIGGER guardian_unused_resumption_insert BEFORE INSERT ON codex_guardian_operation_receipts FOR EACH ROW WHEN (NEW.action='unused_recovery_resumed') EXECUTE FUNCTION hive_guardian_unused_resumption_insert();

CREATE FUNCTION hive_guardian_unused_resumption_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e codex_guardian_operation_receipts;
BEGIN
 IF OLD.phase='open' AND OLD.authority_until<=clock_timestamp() AND NEW.authority_until>OLD.authority_until THEN
   IF (to_jsonb(NEW)-'authority_until') IS DISTINCT FROM (to_jsonb(OLD)-'authority_until') THEN RAISE EXCEPTION 'unused renewal changes identity'; END IF;
   SELECT * INTO e FROM codex_guardian_operation_receipts WHERE owner_id=OLD.owner_id AND runtime_id=OLD.id AND action='unused_recovery_resumed';
   IF e.event_id IS NULL OR (e.response->'resumption'->>'originalAuthorityUntil')::numeric IS DISTINCT FROM extract(epoch FROM OLD.authority_until)*1000
      OR (e.response->'resumption'->>'authorityUntil')::numeric IS DISTINCT FROM extract(epoch FROM NEW.authority_until)*1000 THEN RAISE EXCEPTION 'unused renewal event missing'; END IF;
   PERFORM hive_guardian_unused_resumption(e);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guardian_unused_resumption_update BEFORE UPDATE ON codex_guardian_runtimes FOR EACH ROW EXECUTE FUNCTION hive_guardian_unused_resumption_update();
COMMIT;

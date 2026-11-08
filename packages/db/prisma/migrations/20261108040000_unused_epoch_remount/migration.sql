-- Forward-only extension. Applied51 and all physical closure/writer guards remain.
-- The authenticated application matches explicit operator configuration before
-- writing this event; this trigger independently enforces scope/shape/inventory.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER FUNCTION hive_guardian_unstarted_event(codex_guardian_operation_receipts) RENAME TO hive_guardian_unstarted_event_v1;
CREATE FUNCTION hive_guardian_unstarted_event(e codex_guardian_operation_receipts) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t jsonb:=e.response->'retirement'; p jsonb:=t->'proof'; c jsonb:=t->'continuation'; h jsonb:=c->'unusedEpochHop'; f jsonb:=c->'finalSuccessor'; a jsonb:=t->'attestation'; r codex_guardian_runtimes; normalized codex_guardian_operation_receipts:=e; field record;
BEGIN
 IF c IS NULL THEN
   IF t ? 'attestation' OR t ? 'attestationDigest' OR t ? 'continuationDigest' THEN RAISE EXCEPTION 'unused remount partial envelope'; END IF;
   PERFORM hive_guardian_unstarted_event_v1(e); RETURN;
 END IF;
 SELECT * INTO r FROM codex_guardian_runtimes WHERE owner_id=e.owner_id AND id=e.runtime_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('hive-account-maintenance-v1:'||e.owner_id::text||':'||(r.binding->>'coderOrigin')||':'||r.workspace_id::text,0));
 PERFORM id FROM codex_host_slots WHERE owner_id=e.owner_id AND workspace_id=r.workspace_id ORDER BY id FOR UPDATE;
 IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR octet_length(c::text)>4096 OR c->'schemaVersion' IS DISTINCT FROM '2'::jsonb
 OR (SELECT count(*) FROM jsonb_object_keys(c))<>4
 OR c->>'originalProofDigest' IS DISTINCT FROM t->>'proofDigest'
 OR jsonb_typeof(h) IS DISTINCT FROM 'object' OR h->'schemaVersion' IS DISTINCT FROM '1'::jsonb
 OR (h ?& ARRAY['schemaVersion','buildId','lifetimeId','configSha256','packageManifestSha256','originalProofDigest','oldJournalDigests','neverEnrolled','nativeCreationAttempted','firstPromptSubmissionAttempted']) IS DISTINCT FROM TRUE
 OR (SELECT count(*) FROM jsonb_object_keys(h))<>10
 OR h->>'lifetimeId' IS NULL OR h->>'lifetimeId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 OR h->>'buildId' IS NULL OR h->>'buildId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 OR h->>'buildId' IS DISTINCT FROM p->>'newBuildId' OR h->>'configSha256' IS DISTINCT FROM p->>'newConfigSha256'
 OR h->>'packageManifestSha256' IS DISTINCT FROM p->>'newPackageManifestSha256'
 OR h->>'packageManifestSha256' IS DISTINCT FROM 'b16854fee6f44c96652c5b8bd64b9b3025e28037f93ab4bfe86c9bd218dd4efe'
 OR h->>'originalProofDigest' IS DISTINCT FROM t->>'proofDigest'
 OR h->'neverEnrolled' IS DISTINCT FROM 'true'::jsonb OR h->'nativeCreationAttempted' IS DISTINCT FROM 'false'::jsonb OR h->'firstPromptSubmissionAttempted' IS DISTINCT FROM 'false'::jsonb
 OR jsonb_typeof(h->'oldJournalDigests') IS DISTINCT FROM 'object'
 OR ((h->'oldJournalDigests') ?& ARRAY['lifetime','project','supervisor','config','controller']) IS DISTINCT FROM TRUE
 OR EXISTS(SELECT 1 FROM jsonb_each_text(h->'oldJournalDigests') j WHERE j.key NOT IN ('lifetime','project','supervisor','config','controller') OR (j.key IN ('supervisor','controller') AND j.value IS NOT NULL AND j.value !~ '^[a-f0-9]{64}$') OR (j.key IN ('lifetime','project','config') AND (j.value IS NULL OR j.value !~ '^[a-f0-9]{64}$')))
 OR jsonb_typeof(f) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(f))<>4
 OR (f ?& ARRAY['buildId','lifetimeId','configSha256','packageManifestSha256']) IS DISTINCT FROM TRUE
 OR f->>'buildId' IS DISTINCT FROM t->'newBinding'->>'buildId'
 OR f->>'lifetimeId' IS DISTINCT FROM t->>'newLifetimeId'
 OR f->>'configSha256' IS DISTINCT FROM t->'newIdentity'->>'configSha256'
 OR f->>'packageManifestSha256' IS DISTINCT FROM t->'newIdentity'->>'packageManifestSha256'
 OR f->>'buildId' IN (p->>'oldBuildId',h->>'buildId') OR f->>'lifetimeId' IN (p->>'oldLifetimeId',h->>'lifetimeId') OR h->>'lifetimeId'=p->>'oldLifetimeId'
 OR jsonb_typeof(a) IS DISTINCT FROM 'object' OR a->>'schemaVersion' IS DISTINCT FROM '1' OR a->>'purpose' IS DISTINCT FROM 'unused-checkout-remount'
 OR a->>'ownerId' IS DISTINCT FROM e.owner_id::text OR a->>'coderOwnerId' IS DISTINCT FROM p->>'coderOwnerId'
 OR a->>'workspaceId' IS DISTINCT FROM r.workspace_id::text OR a->>'templateId' IS DISTINCT FROM p->>'templateId'
 OR a->>'projectId' IS DISTINCT FROM p->>'projectId' OR a->>'taskId' IS DISTINCT FROM p->>'taskId'
 OR a->>'oldBuildId' IS DISTINCT FROM p->>'oldBuildId' OR a->>'oldLifetimeId' IS DISTINCT FROM p->>'oldLifetimeId'
 OR a->>'finalTemplateVersionId' IS NULL OR a->>'finalTemplateVersionId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 OR a->>'originalProofDigest' IS DISTINCT FROM t->>'proofDigest'
 OR a->'held' IS DISTINCT FROM (h-ARRAY['schemaVersion','originalProofDigest','oldJournalDigests','neverEnrolled','nativeCreationAttempted','firstPromptSubmissionAttempted'])
 OR a->'heldJournalDigests' IS DISTINCT FROM h->'oldJournalDigests' OR a->'final' IS DISTINCT FROM f
 OR a->>'expiresAt' IS NULL OR (a->>'expiresAt')::numeric<=extract(epoch FROM clock_timestamp())*1000
 OR t->>'attestationDigest' IS NULL OR t->>'attestationDigest' !~ '^[a-f0-9]{64}$' OR t->>'continuationDigest' IS NULL OR t->>'continuationDigest' !~ '^[a-f0-9]{64}$'
 OR a->'volume'->>'capacity' IS NULL OR a->'volume'->>'capacity' !~ '^[1-9][0-9]{0,3}Gi$'
 OR a->'volume'->>'pvcUid' IS NULL OR a->'volume'->>'pvcUid' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' OR a->'volume'->>'pvcName' IS DISTINCT FROM 'coder-'||r.workspace_id::text||'-home'
 OR a->'volume'->>'boundVolumeName' IS DISTINCT FROM 'pvc-'||(a->'volume'->>'pvcUid')
 OR a->'volume'->>'namespace' IS DISTINCT FROM 'coder' OR a->'volume'->>'storageClass' IS DISTINCT FROM 'longhorn'
 OR a->'volume'->'accessModes' IS DISTINCT FROM '["ReadWriteOnce"]'::jsonb
 OR a->'volume'->>'containerName' IS DISTINCT FROM 'dev' OR a->'volume'->>'podVolumeName' IS DISTINCT FROM 'home'
 OR a->'volume'->>'mountPath' IS DISTINCT FROM '/home/coder' OR a->'volume'->>'subPath' IS DISTINCT FROM '' OR a->'volume'->>'subPathExpr' IS DISTINCT FROM ''
 OR a->'volume'->>'readOnly' IS DISTINCT FROM 'false' OR a->'volume'->>'claimReadOnly' IS DISTINCT FROM 'false'
 OR a->'mapping'->'old'->'checkout' IS DISTINCT FROM p->'checkout'->'checkoutIdentity'
 OR EXISTS(SELECT 1 FROM codex_guardian_runtimes WHERE owner_id=e.owner_id AND workspace_id=r.workspace_id AND (build_id=(h->>'buildId')::uuid OR lifetime_id=(h->>'lifetimeId')::uuid))
 OR EXISTS(SELECT 1 FROM codex_host_registrations x JOIN codex_host_slots s ON s.owner_id=x.owner_id AND s.id=x.slot_id WHERE x.owner_id=e.owner_id AND s.workspace_id=r.workspace_id AND x.build_id=(h->>'buildId')::uuid)
 OR EXISTS(SELECT 1 FROM codex_registration_grants g JOIN codex_host_slots s ON s.owner_id=g.owner_id AND s.id=g.slot_id WHERE g.owner_id=e.owner_id AND s.workspace_id=r.workspace_id AND g.binding->>'buildId'=h->>'buildId')
 THEN RAISE EXCEPTION 'unused remount envelope prerequisites rejected'; END IF;
 FOR field IN SELECT k FROM unnest(ARRAY['root','project','checkout']) k LOOP
  IF a->'mapping'->'old'->field.k->>'device' IS NULL OR a->'mapping'->'current'->field.k->>'device' IS NULL
   OR a->'mapping'->'old'->field.k->>'device' !~ '^[0-9]{1,24}$' OR a->'mapping'->'current'->field.k->>'device' !~ '^[0-9]{1,24}$'
   OR a->'mapping'->'old'->field.k->>'inode' IS NULL OR a->'mapping'->'old'->field.k->>'inode' !~ '^[1-9][0-9]{0,24}$'
   OR a->'mapping'->'old'->field.k->>'inode' IS DISTINCT FROM a->'mapping'->'current'->field.k->>'inode'
   OR a->'mapping'->'old'->field.k->>'device' IS DISTINCT FROM a->'mapping'->'old'->'root'->>'device'
   OR a->'mapping'->'current'->field.k->>'device' IS DISTINCT FROM a->'mapping'->'current'->'root'->>'device'
   OR a->'mapping'->'old'->field.k->>'device'=a->'mapping'->'current'->field.k->>'device'
  THEN RAISE EXCEPTION 'unused remount physical mapping rejected'; END IF;
 END LOOP;
 FOR field IN SELECT k FROM unnest(ARRAY['oldRootRecordSha256','oldProjectRecordSha256','oldLeaseDigest']) k LOOP
  IF a->'mapping'->>field.k IS NULL OR a->'mapping'->>field.k !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'unused remount record digest rejected'; END IF;
 END LOOP;
 -- Check the identical51 prerequisites against the final endpoint, without
 -- modifying the original event/proof. This local validation copy is not stored.
 normalized.response:=jsonb_set(e.response,'{retirement,proof}',p||jsonb_build_object('newBuildId',f->'buildId','newConfigSha256',f->'configSha256','newPackageManifestSha256',f->'packageManifestSha256'));
 PERFORM hive_guardian_unstarted_event_v1(normalized);
END $$;
-- A waiter that authenticated before retirement cannot resurrect its explicitly
-- retired intermediate endpoint after the absence check. Locking old runtime rows
-- also makes an older SERIALIZABLE snapshot abort on the retirement phase write.
CREATE FUNCTION hive_guardian_unused_endpoint_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_scope uuid:=NEW.owner_id; workspace_scope uuid; build_scope uuid; lifetime_scope uuid; origin_scope text; slot codex_host_slots;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.owner_id,NEW.slot_id,NEW.binding) IS DISTINCT FROM (OLD.owner_id,OLD.slot_id,OLD.binding) THEN RAISE EXCEPTION 'unused endpoint binding is immutable'; END IF;
  IF TG_TABLE_NAME='codex_host_registrations' THEN
   IF NEW.build_id IS DISTINCT FROM OLD.build_id THEN RAISE EXCEPTION 'unused endpoint build is immutable'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO slot FROM codex_host_slots WHERE owner_id=owner_scope AND id=NEW.slot_id;
 IF slot.id IS NULL OR NEW.binding->>'hiveUserId' IS DISTINCT FROM owner_scope::text OR NEW.binding->>'ownerId' IS DISTINCT FROM slot.coder_owner_id::text
 OR NEW.binding->>'workspaceId' IS DISTINCT FROM slot.workspace_id::text OR NEW.binding->>'coderOrigin' IS DISTINCT FROM slot.coder_origin
 OR NEW.binding->>'buildId' IS NULL THEN RAISE EXCEPTION 'unused endpoint insert scope rejected'; END IF;
 workspace_scope:=slot.workspace_id;origin_scope:=slot.coder_origin;build_scope:=(NEW.binding->>'buildId')::uuid;
 IF TG_TABLE_NAME='codex_guardian_runtimes' THEN
  lifetime_scope:=NEW.lifetime_id;
  IF NEW.workspace_id IS DISTINCT FROM workspace_scope OR NEW.build_id IS DISTINCT FROM build_scope THEN RAISE EXCEPTION 'unused endpoint runtime scope rejected'; END IF;
 ELSIF TG_TABLE_NAME='codex_host_registrations' THEN
  IF NEW.build_id IS DISTINCT FROM build_scope THEN RAISE EXCEPTION 'unused endpoint registration scope rejected'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('hive-account-maintenance-v1:'||owner_scope::text||':'||origin_scope||':'||workspace_scope::text,0));
 PERFORM id FROM codex_guardian_runtimes WHERE owner_id=owner_scope AND workspace_id=workspace_scope ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM codex_guardian_operation_receipts e JOIN codex_guardian_runtimes r ON r.owner_id=e.owner_id AND r.id=e.runtime_id
  WHERE e.owner_id=owner_scope AND r.workspace_id=workspace_scope AND r.phase='authorization_retired' AND e.action='authorization_retired'
  AND e.response->'retirement'->'continuation'->'schemaVersion'='2'::jsonb
  AND (e.response->'retirement'->'continuation'->'unusedEpochHop'->>'buildId'=build_scope::text OR e.response->'retirement'->'continuation'->'unusedEpochHop'->>'lifetimeId'=lifetime_scope::text))
 THEN RAISE EXCEPTION 'unused intermediate endpoint is permanently retired'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guardian_unused_runtime_insert BEFORE INSERT ON codex_guardian_runtimes FOR EACH ROW EXECUTE FUNCTION hive_guardian_unused_endpoint_insert();
CREATE TRIGGER guardian_unused_registration_grant_insert BEFORE INSERT OR UPDATE ON codex_registration_grants FOR EACH ROW EXECUTE FUNCTION hive_guardian_unused_endpoint_insert();
CREATE TRIGGER guardian_unused_registration_insert BEFORE INSERT OR UPDATE ON codex_host_registrations FOR EACH ROW EXECUTE FUNCTION hive_guardian_unused_endpoint_insert();
COMMIT;

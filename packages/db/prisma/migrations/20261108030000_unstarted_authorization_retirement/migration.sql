-- Forward-only: unused authorization is NOT native tree closure or writer release.
-- Trusted application authenticates owner/Coder/source/Ed25519 evidence before this
-- defense-in-depth trigger. No claim of protection against a compromised DB role.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE codex_guardian_runtimes DROP CONSTRAINT codex_guardian_runtime_state_check;
ALTER TABLE codex_guardian_runtimes ADD CONSTRAINT codex_guardian_runtime_state_check CHECK (
  phase IN ('reserved','open','barrier_closed','tree_closed','authorization_retired') AND generation > 0
  AND (closed_barrier_id IS NULL) = (phase IN ('reserved','open','authorization_retired'))
  AND (server_instance_id IS NULL) = (host_key_fingerprint IS NULL)
  AND (native_launch_id IS NULL) = (native_launch_digest IS NULL)
  AND (native_launch_id IS NULL) = (native_launch_at IS NULL)
  AND outer_key_fingerprint ~ '^[a-f0-9]{64}$'
  AND binding_digest ~ '^[a-f0-9]{64}$'
  AND package_manifest_sha256 ~ '^[a-f0-9]{64}$'
  AND guardian_elf_sha256 ~ '^[a-f0-9]{64}$' AND node_sha256 ~ '^[a-f0-9]{64}$'
  AND policy_digest ~ '^[a-f0-9]{64}$' AND metadata_policy_digest ~ '^[a-f0-9]{64}$'
  AND config_sha256 ~ '^[a-f0-9]{64}$'
);

DROP INDEX codex_guardian_unresolved_slot_key;
CREATE UNIQUE INDEX codex_guardian_unresolved_slot_key ON codex_guardian_runtimes(owner_id,slot_id)
 WHERE phase NOT IN ('tree_closed','authorization_retired');
ALTER TABLE codex_guardian_operation_receipts DROP CONSTRAINT guardian_operation_receipt_bounds;
ALTER TABLE codex_guardian_operation_receipts ADD CONSTRAINT guardian_operation_receipt_bounds CHECK (
 action IN ('prepare','checkout','native','fence','maintenance_resume_intent','authorization_retired')
 AND request_digest ~ '^[a-f0-9]{64}$' AND response_digest ~ '^[a-f0-9]{64}$'
 AND config_sha256 ~ '^[a-f0-9]{64}$' AND outer_key_fingerprint ~ '^[a-f0-9]{64}$'
 AND input_runtime_generation>0 AND result_runtime_generation BETWEEN input_runtime_generation AND input_runtime_generation+1
 AND result_admission_generation>0 AND jsonb_typeof(response)='object' AND octet_length(response::text)<=65536
);
CREATE UNIQUE INDEX guardian_unstarted_retirement_once ON codex_guardian_operation_receipts(owner_id,runtime_id) WHERE action='authorization_retired';
CREATE UNIQUE INDEX guardian_unstarted_successor_once ON codex_guardian_operation_receipts(owner_id,(response->'retirement'->>'newLifetimeId')) WHERE action='authorization_retired';
CREATE FUNCTION hive_guardian_unstarted_event(e codex_guardian_operation_receipts) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r codex_guardian_runtimes; a codex_guardian_admissions; i project_task_intents; q project_task_recoveries;
 p jsonb:=e.response->'retirement'->'proof'; n jsonb; slot uuid; v text;
BEGIN
 SELECT * INTO r FROM codex_guardian_runtimes WHERE owner_id=e.owner_id AND id=e.runtime_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('hive-account-maintenance-v1:'||e.owner_id::text||':'||(r.binding->>'coderOrigin')||':'||r.workspace_id::text,0));
 PERFORM id FROM codex_host_slots WHERE owner_id=e.owner_id AND workspace_id=(p->>'workspaceId')::uuid ORDER BY id FOR UPDATE;
 SELECT * INTO r FROM codex_guardian_runtimes WHERE owner_id=e.owner_id AND id=e.runtime_id FOR UPDATE;
 PERFORM id FROM codex_guardian_admissions WHERE owner_id=e.owner_id AND runtime_id=e.runtime_id ORDER BY id FOR UPDATE;
 SELECT * INTO a FROM codex_guardian_admissions WHERE owner_id=e.owner_id AND runtime_id=e.runtime_id;
 SELECT * INTO i FROM project_task_intents WHERE owner_id=e.owner_id AND id=(p->>'taskId')::uuid FOR UPDATE;
 SELECT * INTO q FROM project_task_recoveries WHERE owner_id=e.owner_id AND id=(e.response->'retirement'->>'recoveryId')::uuid FOR UPDATE;
 n:=p->'neverStarted';
 v:=to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US');
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (p ?& ARRAY['schemaVersion','transferId','ownerId','coderOwnerId','workspaceId','templateId','projectId','taskId','requestId','hostRequestDigest','sourceSha','repositoryId','providerAccountId','oldRuntimeId','oldBuildId','oldLifetimeId','oldIdentityDigest','oldConfigSha256','oldPackageManifestSha256','newBuildId','newConfigSha256','newPackageManifestSha256','nativeLaunchId','launchIntentDigest','preparation','checkout','oldJournalDigests','predecessorController','neverStarted']) IS DISTINCT FROM TRUE
 OR EXISTS(SELECT 1 FROM jsonb_each_text(p) field WHERE field.key IN ('hostRequestDigest','oldIdentityDigest','oldConfigSha256','oldPackageManifestSha256','newConfigSha256','newPackageManifestSha256','launchIntentDigest') AND (field.value IS NULL OR field.value !~ '^[a-f0-9]{64}$'))
 OR jsonb_typeof(p->'oldJournalDigests') IS DISTINCT FROM 'object' OR ((p->'oldJournalDigests') ?& ARRAY['lifetime','controller','project','supervisor']) IS DISTINCT FROM TRUE
 OR EXISTS(SELECT 1 FROM jsonb_each_text(p->'oldJournalDigests') field WHERE field.key NOT IN ('lifetime','controller','project','supervisor') OR field.value IS NULL OR field.value !~ '^[a-f0-9]{64}$')
 OR r.id IS NULL OR a.id IS NULL OR i.id IS NULL OR q.id IS NULL
 OR r.phase<>'open' OR NOT r.operation_receipts_enabled OR r.producer_approved
 OR r.server_instance_id IS NOT NULL OR r.host_key_fingerprint IS NOT NULL OR r.closed_barrier_id IS NOT NULL
 OR r.native_launch_id IS NULL OR r.native_launch_digest IS NULL OR r.native_launch_at IS NULL OR r.enrolled_at IS NULL
 OR (SELECT count(*) FROM codex_guardian_admissions WHERE owner_id=r.owner_id AND runtime_id=r.id)<>1
 OR a.phase<>'checkout' OR a.registration_id IS NOT NULL OR a.native_thread_id IS NOT NULL OR a.native_bound_at IS NOT NULL OR a.producer_digest IS NOT NULL OR a.metadata_pins IS NOT NULL
 OR a.checkout_binding IS NULL OR a.preparation IS DISTINCT FROM p->'preparation' OR a.checkout_binding IS DISTINCT FROM p->'checkout'
 OR a.preparation_intent_id IS DISTINCT FROM i.id OR a.intent_request_digest IS DISTINCT FROM i.request_digest
 OR i.phase<>'blocked' OR i.ciphertext IS NULL OR i.lease_id IS NOT NULL OR i.lease_until IS NOT NULL
 OR i.project_id IS DISTINCT FROM (p->>'projectId')::uuid OR i.workspace_id IS DISTINCT FROM r.workspace_id
 OR i.request_id::text IS DISTINCT FROM p->>'requestId' OR i.repository_id IS DISTINCT FROM p->>'repositoryId'
 OR i.provider_account_id IS DISTINCT FROM p->>'providerAccountId' OR i.source_sha IS DISTINCT FROM p->>'sourceSha'
 OR i.status->>'nativeThreadId' IS NOT NULL OR i.status->>'terminalSessionName' IS NOT NULL
 OR q.phase<>'inspecting' OR q.task_id IS DISTINCT FROM i.id OR q.scope->>'intentVersion' IS DISTINCT FROM v
 OR q.scope->>'ownerId' IS DISTINCT FROM r.owner_id::text OR q.scope->>'taskId' IS DISTINCT FROM i.id::text
 OR q.scope->>'workspaceId' IS DISTINCT FROM r.workspace_id::text OR q.scope->>'intentDigest' IS DISTINCT FROM i.request_digest
 OR q.scope->>'hostRequestDigest' IS DISTINCT FROM p->>'hostRequestDigest'
 OR q.scope->>'coderOwnerId' IS DISTINCT FROM p->>'coderOwnerId' OR q.scope->>'projectId' IS DISTINCT FROM i.project_id::text
 OR q.scope->>'originalRequestId' IS DISTINCT FROM i.request_id::text OR q.scope->>'repositoryId' IS DISTINCT FROM i.repository_id OR q.scope->>'providerAccountId' IS DISTINCT FROM i.provider_account_id OR q.scope->>'revision' IS DISTINCT FROM i.source_sha
 OR p->>'coderOwnerId' IS DISTINCT FROM r.binding->>'ownerId' OR p->>'templateId' IS DISTINCT FROM r.binding->>'templateId'
 OR p->>'workspaceId' IS DISTINCT FROM r.workspace_id::text
 OR p->>'oldRuntimeId' IS DISTINCT FROM r.id::text OR p->>'ownerId' IS DISTINCT FROM r.owner_id::text
 OR p->>'oldBuildId' IS DISTINCT FROM r.build_id::text OR p->>'oldLifetimeId' IS DISTINCT FROM r.lifetime_id::text
 OR p->>'oldConfigSha256' IS DISTINCT FROM r.config_sha256 OR p->>'oldPackageManifestSha256' IS DISTINCT FROM r.package_manifest_sha256
 OR p->>'nativeLaunchId' IS DISTINCT FROM r.native_launch_id::text OR p->>'launchIntentDigest' IS DISTINCT FROM r.native_launch_digest
 OR p->>'newBuildId' IS NULL OR p->>'newBuildId'=r.build_id::text OR p->>'newConfigSha256' IS NULL OR p->>'newPackageManifestSha256' IS NULL
 OR p->>'schemaVersion' IS DISTINCT FROM '1'
 OR p->'predecessorController'->>'signature' IS NULL OR p->'predecessorController'->>'signature' !~ '^[A-Za-z0-9_-]{86}$'
 OR p->'predecessorController'->'state'->>'schemaVersion' IS DISTINCT FROM '1' OR p->'predecessorController'->'state'->>'generation' IS DISTINCT FROM r.generation::text
 OR p->'predecessorController'->'state'->>'runtimeId' IS DISTINCT FROM r.id::text
 OR p->'predecessorController'->'state'->>'lifetimeId' IS DISTINCT FROM r.lifetime_id::text
 OR p->'predecessorController'->'state'->>'identityDigest' IS DISTINCT FROM p->>'oldIdentityDigest'
 OR p->'predecessorController'->'state'->'pending' IS DISTINCT FROM 'null'::jsonb OR p->'predecessorController'->'state'->>'hold' IS DISTINCT FROM 'false'
 OR (SELECT count(*) FROM jsonb_object_keys(p->'predecessorController'->'state'->'projects'))<>1
 OR p->'predecessorController'->'state'->'projects'->(p->>'projectId')->>'admissionId' IS DISTINCT FROM a.id::text
 OR p->'predecessorController'->'state'->'projects'->(p->>'projectId')->>'phase' IS DISTINCT FROM 'checkout'
 OR p->'predecessorController'->'state'->'launch'->>'nativeLaunchId' IS DISTINCT FROM r.native_launch_id::text
 OR p->'predecessorController'->'state'->'launch'->>'launchIntentDigest' IS DISTINCT FROM r.native_launch_digest
 OR p->'predecessorController'->'state'->'launch'->>'runtimeId' IS DISTINCT FROM r.id::text
 OR p->>'transferId' IS DISTINCT FROM e.event_id::text OR e.request_digest IS DISTINCT FROM e.response->'retirement'->>'proofDigest'
 OR e.response->'retirement'->>'newLifetimeId' IS NULL OR e.response->'retirement'->>'newLifetimeId'=r.lifetime_id::text
 OR e.response->'retirement'->>'purpose' IS DISTINCT FROM 'unused-metadata-authorization'
 OR e.response->'retirement'->>'nativeTreeExited' IS DISTINCT FROM 'false' OR e.response->'retirement'->>'cleanupAuthorized' IS DISTINCT FROM 'false' OR e.response->'retirement'->>'writerReleased' IS DISTINCT FROM 'false'
 OR e.response->'retirement'->>'intentDigest' IS DISTINCT FROM i.request_digest
 OR e.response->'retirement'->'newBinding'->>'hiveUserId' IS DISTINCT FROM r.owner_id::text OR e.response->'retirement'->'newBinding'->>'ownerId' IS DISTINCT FROM p->>'coderOwnerId'
 OR e.response->'retirement'->'newBinding'->>'coderOrigin' IS DISTINCT FROM r.binding->>'coderOrigin'
 OR e.response->'retirement'->'newBinding'->>'workspaceId' IS DISTINCT FROM r.workspace_id::text OR e.response->'retirement'->'newBinding'->>'templateId' IS DISTINCT FROM r.binding->>'templateId'
 OR e.response->'retirement'->'newBinding'->>'buildId' IS DISTINCT FROM p->>'newBuildId' OR e.response->'retirement'->'newBinding'->'projects' IS DISTINCT FROM '[]'::jsonb
 OR e.response->'retirement'->'newIdentity'->>'lifetimeId' IS DISTINCT FROM e.response->'retirement'->>'newLifetimeId'
 OR e.response->'retirement'->'newIdentity'->>'outerPublicKeyPem' IS DISTINCT FROM r.outer_public_key_pem
 OR (e.response->'retirement'->'newIdentity' ?& ARRAY['lifetimeId','bindingDigest','outerPublicKeyPem','packageManifestSha256','guardianElfSha256','nodeSha256','policyDigest','metadataPolicyDigest','configSha256']) IS DISTINCT FROM TRUE
 OR e.response->'retirement'->'newBinding'->>'agentId' IS NULL OR e.response->'retirement'->'newBinding'->>'appId' IS NULL OR e.response->'retirement'->'newBinding'->>'appOrigin' IS NULL
 OR e.response->'retirement'->'newIdentity'->>'configSha256' IS DISTINCT FROM p->>'newConfigSha256' OR e.response->'retirement'->'newIdentity'->>'packageManifestSha256' IS DISTINCT FROM p->>'newPackageManifestSha256'
 OR n IS DISTINCT FROM '{"metadataPhase":"reservationRequested","status":"starting","nativeProcess":null,"executionIdentity":null,"projectCount":0,"nativeCreationAttempted":false,"firstPromptSubmissionAttempted":false,"nativeThreadId":null,"terminalSessionName":null}'::jsonb
 OR e.input_runtime_generation<>r.generation OR e.result_runtime_generation<>r.generation OR e.result_admission_generation<>a.generation
 OR (e.lifetime_id,e.build_id,e.config_sha256,e.outer_key_fingerprint) IS DISTINCT FROM (r.lifetime_id,r.build_id,r.config_sha256,r.outer_key_fingerprint)
 OR e.response->'runtime'->>'id' IS DISTINCT FROM r.id::text OR e.response->'admission'->>'id' IS DISTINCT FROM a.id::text
 OR EXISTS(SELECT 1 FROM codex_host_slots WHERE owner_id=r.owner_id AND workspace_id=r.workspace_id AND (active_registration_id IS NOT NULL OR account_maintenance IS NOT NULL))
 OR EXISTS(SELECT 1 FROM codex_host_registrations WHERE owner_id=r.owner_id AND slot_id=r.slot_id)
 OR EXISTS(SELECT 1 FROM codex_registration_grants WHERE owner_id=r.owner_id AND slot_id=r.slot_id)
 OR EXISTS(SELECT 1 FROM codex_guardian_runtimes WHERE owner_id=r.owner_id AND workspace_id=r.workspace_id AND id<>r.id AND phase NOT IN ('tree_closed','authorization_retired'))
 OR EXISTS(SELECT 1 FROM delivery_manager_bindings WHERE owner_id=r.owner_id AND preparation_intent_id=i.id)
 OR EXISTS(SELECT 1 FROM delivery_source_applications WHERE owner_id=r.owner_id AND runtime_id=r.id)
 OR EXISTS(SELECT 1 FROM codex_guardian_barriers WHERE owner_id=r.owner_id AND runtime_id=r.id)
 OR EXISTS(SELECT 1 FROM codex_guardian_operation_receipts WHERE owner_id=r.owner_id AND runtime_id=r.id AND (action='native' OR (action='authorization_retired' AND event_id<>e.event_id)))
 OR EXISTS(SELECT 1 FROM project_task_recoveries WHERE owner_id=r.owner_id AND task_id=i.id AND phase<>'consumed' AND id<>q.id)
 OR (SELECT count(*) FROM codex_guardian_operation_receipts WHERE owner_id=r.owner_id AND runtime_id=r.id AND event_id<>e.event_id)>=1024
 OR e.committed_at>clock_timestamp()
 THEN RAISE EXCEPTION 'guardian unused retirement prerequisites rejected'; END IF;
END $$;
CREATE OR REPLACE FUNCTION hive_guardian_operation_receipt_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r codex_guardian_runtimes; a codex_guardian_admissions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'guardian operation receipt is immutable'; END IF;
  IF NEW.action='authorization_retired' THEN
    PERFORM hive_guardian_unstarted_event(NEW);
    RETURN NEW;
  END IF;
  SELECT * INTO r FROM codex_guardian_runtimes WHERE owner_id=NEW.owner_id AND id=NEW.runtime_id FOR UPDATE;
  SELECT * INTO a FROM codex_guardian_admissions
    WHERE owner_id=NEW.owner_id AND runtime_id=NEW.runtime_id AND id=(NEW.response->'admission'->>'id')::uuid;
  IF r.id IS NULL OR NOT r.operation_receipts_enabled OR a.id IS NULL
    OR (NEW.lifetime_id,NEW.build_id,NEW.config_sha256,NEW.outer_key_fingerprint)
      IS DISTINCT FROM (r.lifetime_id,r.build_id,r.config_sha256,r.outer_key_fingerprint)
    OR NEW.result_runtime_generation<>r.generation OR NEW.result_admission_generation<>a.generation
    OR NEW.response->'runtime'->>'id' IS DISTINCT FROM r.id::text
    OR NEW.response->'runtime'->>'ownerId' IS DISTINCT FROM r.owner_id::text
    OR NEW.response->'admission'->>'runtimeId' IS DISTINCT FROM r.id::text
    OR (NEW.response->'runtime'->>'generation')::integer IS DISTINCT FROM r.generation
    OR (NEW.response->'admission'->>'generation')::integer IS DISTINCT FROM a.generation
    OR NEW.committed_at>clock_timestamp()
  THEN RAISE EXCEPTION 'guardian operation receipt scope/result rejected'; END IF;
  IF (SELECT count(*) FROM codex_guardian_operation_receipts WHERE owner_id=NEW.owner_id AND runtime_id=NEW.runtime_id)>=1024
  THEN RAISE EXCEPTION 'guardian operation receipt limit reached'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION codex_guardian_runtime_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retirement codex_guardian_operation_receipts;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'guardian runtime is retained'; END IF;
  IF (to_jsonb(NEW)-ARRAY['phase','generation','producer_approved','authority_until','server_instance_id','host_key_fingerprint','native_launch_id','native_launch_digest','native_launch_at','enrolled_at','closed_barrier_id'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','generation','producer_approved','authority_until','server_instance_id','host_key_fingerprint','native_launch_id','native_launch_digest','native_launch_at','enrolled_at','closed_barrier_id'])
     OR NEW.generation < OLD.generation OR NEW.generation > OLD.generation+1
     OR (OLD.server_instance_id IS NOT NULL AND (NEW.server_instance_id,NEW.host_key_fingerprint) IS DISTINCT FROM (OLD.server_instance_id,OLD.host_key_fingerprint))
     OR (OLD.native_launch_id IS NOT NULL AND (NEW.native_launch_id,NEW.native_launch_digest,NEW.native_launch_at) IS DISTINCT FROM (OLD.native_launch_id,OLD.native_launch_digest,OLD.native_launch_at))
     OR (OLD.enrolled_at IS NOT NULL AND NEW.enrolled_at IS DISTINCT FROM OLD.enrolled_at)
     OR (OLD.closed_barrier_id IS NOT NULL AND NEW.closed_barrier_id IS DISTINCT FROM OLD.closed_barrier_id)
     OR (OLD.phase='reserved' AND NEW.phase NOT IN ('reserved','open'))
     OR (OLD.phase='open' AND NEW.phase NOT IN ('open','barrier_closed','authorization_retired'))
     OR (OLD.phase='barrier_closed' AND NEW.phase NOT IN ('barrier_closed','tree_closed'))
     OR (OLD.phase IN ('tree_closed','authorization_retired') AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'guardian runtime identity or transition rejected'; END IF;
  IF NEW.phase='authorization_retired' AND OLD.phase<>'authorization_retired' THEN
    IF (to_jsonb(NEW)-'phase') IS DISTINCT FROM (to_jsonb(OLD)-'phase') OR NOT EXISTS (
      SELECT 1 FROM codex_guardian_operation_receipts WHERE owner_id=OLD.owner_id AND runtime_id=OLD.id AND action='authorization_retired'
    ) THEN RAISE EXCEPTION 'guardian unused retirement event missing'; END IF;
    SELECT * INTO retirement FROM codex_guardian_operation_receipts WHERE owner_id=OLD.owner_id AND runtime_id=OLD.id AND action='authorization_retired';
    PERFORM hive_guardian_unstarted_event(retirement);
  END IF;
  RETURN NEW;
END $$;

COMMIT;

# Hive bootstrap cutover and recovery

Status: rehearsal in progress; production cutover requires the owner's approval after PR #402
is ready and merged. The source read-only capture and local/Neon restore-upgrade checks passed
on 2026-11-05. See `20261105-restore-upgrade.json` and `20261105-recovery.json`. Application/session
and installed browser/manager gates remain open. The October capture and preview are never a
substitute for a final capture at the maintenance boundary.

## Before requesting cutover approval

Record the merged release revision, app/auth artifact hashes, all migration checksums, current
production database identity, target Neon database/role, Cloudflare scripts/routes and exact
previous Kubernetes image digests. Complete the current-build preview gates and check included
resource usage again. Keep the old deployment and final backup recoverable; no cluster resource
deletions are part of this cutover.

Use the existing single `hive` Worker and repository-connected Workers Builds. Production
`deploy/cloudflare/native/deploy.mjs production` now supports the reviewed owner-enrollment
gate from PR417. It still refuses deployment without an explicit, unexpired
`HIVE_NATIVE_PRODUCTION_ENROLLMENT_JSON` build setting. The offline
`prepare-production.mjs` output is a review artifact, not activation. Owner cutover approval
must cover the exact merged main revision, public configuration, verified private resource
identities and inert parent snapshot before enrolling this existing command. Do not introduce an upload/promote publisher, another Worker,
or a deployment token. Preserve the separately enrolled epic Preview and its test database;
its credentials and execution flags are not production defaults.

Keep production `ENCRYPTION_KEY`, `COOKIE_SECRET` and VAPID identity unchanged when transferring
their existing encrypted rows, sessions and subscriptions. Set the same fixed `CODER_URL` on
all services. Transfer secrets through owner-only files or provider secret bindings; never
through logs, PRs, task reports or browser payloads. Verify secret names and formats without
printing values. Use the existing shared internal auth identity consistently on app/auth, or
rotate it in a coordinated deployment; it does not decrypt stored credentials. Preview keys
and test-account credentials are not production keys.

The application uses `__Host-hive-session` and purpose-separated cookie signatures. A matching
host-only cookie and unchanged signing key can survive on the same public origin; cookies for
another origin, expired sessions, legacy cookie names and duplicate selected-name cookies are
rejected. An origin change requires sign-in. Do not promise universal session continuation.
Retain original data even when fixed-origin checks reject a legacy account record. Test key
mismatch, expiration, logout and correct session behavior before enabling the new public route.

## Approved maintenance window

1. Put the old public entry point into maintenance and stop new writes. Pause delivery,
   publication, notifications and credential-rotation scheduling, then drain and verify all old
   worker processes and in-flight provider operations. Pausing only the UI does not stop writes.
   Set `HIVE_DISABLE_TOKEN_ROTATION_WORKER=true` on every old Node worker before enabling any
   replacement scheduler. Keep Cloudflare crons and release execution off.
2. Take a fresh read-only exported-snapshot capture after the write stop. Record source version,
   extensions, schema objects, sequence values, counts, original-column fingerprints and archive
   hash. Confirm no writes occurred after the chosen boundary. The capture helper covers ordinary
   `public` tables only; reject unexpected schemas/partitioned/foreign/materialized objects and
   reconcile sequence state separately.
3. Restore into the exact approved empty Neon target. Apply the reviewed migration runner using
   its direct endpoint and database-owner credential. Compare all original columns/rows and
   migration checksums. Grant only required runtime privileges; bind the runtime role to Workers,
   never the migration owner. Verify no failed migration history or unresolved job remains.
4. Let the existing connected main build publish the exact approved production configuration
   of `hive`, with background scheduling and autonomous delivery still disabled. Stage the
   approved production route as part of that deployment; this can start serving the new app
   immediately and is an approved cutover effect, not a traffic-free staging operation. Keep
   the old public entry point in maintenance; the removed Preview authorization gate is not
   a cutover control. Validate the compiled main
   source SHA/provider build UUID, database identity, configuration/crypto readiness and actual
   production OAuth login without sending notifications, rotating Coder credentials or running
   delivery jobs. Do not claim that these postactivation checks happened before any new write.
   Treat the activated deployment as potentially accepting Neon writes unless a separately
   verified maintenance control proves otherwise. Authenticated readiness proves configuration/schema access,
   not historical-key continuity or business acceptance; check those separately.
5. Observe login, current-user access, repository discovery, Conversation/Terminal stream and
   reconnect, task reports, worker errors and database health. Restore background features one
   at a time with one scheduler owner. Record every activation and its readback. The observer
   must distinguish an unknown provider effect from a known failed effect; do not retry blindly.

## Recovery decision

Before the new app accepts any write, restore the prior route and old workers from their recorded
configuration if validation fails; the original database remains authoritative. Verify the old
writers resume only after the new writers are stopped.

After the first Neon write, the old database is stale. Do not route writes back to it. Re-enter
maintenance, stop new writers and capture the current Neon state. Prefer fixing or reverting
only the application while retaining the compatible upgraded schema and current data. Any return
to the old database requires an independently rehearsed export/restore or reconciliation of all
post-cutover writes, explicit acceptance of any data loss and a fresh integrity check. That path
has not been validated by the local backup rehearsal. Destructive contract migrations remain
manual and outside this bootstrap release.

Do not retire the cluster deployment, final backup, VAPID identity or retained sessions until the
owner accepts the observation result and the recovery window has closed. Production verification
is necessarily a post-approval step; it cannot be claimed by this preview roadmap.

## Autonomous delivery after bootstrap

Enable the installed release controller only after its exact repository, source-test workflow,
connected GitHub authority and production target are enrolled and the owner approves its policy.
The controller attributes the permitted merge; existing Workers Builds owns deployment. Correlate
the Cloudflare app's successful GitHub check to the exact serving main source/build identity,
then collect the configured observation window and independent semantic acceptance. A successful
HTTP/DB/auth smoke result cannot prove arbitrary feature behavior. Keep the target fenced while
production acceptance is pending, and retain physical writer/archive/checkout holds until their
own proofs pass. Database-changing tasks additionally require the controlled migration plan,
backup, compatibility, backfill/integrity and activation gates; production bootstrap does not
grant blanket migration or destructive-contract permission.

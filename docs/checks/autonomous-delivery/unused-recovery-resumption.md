# Unused successor recovery resumption

An owner retry can retire the original unused launch authorization and enroll its
successor, then fail before inspection. The successor's three-minute authority
expires. Ordinary provisioning correctly rejects that expired runtime. This
change adds a bounded continuation of that exact owner recovery, not a general
expiry exemption. It does not establish why the original request failed.

## Explicit enrollment and ordering

The operator may configure `HIVE_GUARDIAN_RECOVERY_RESUMPTIONS_JSON` with at most
eight strict `unused-recovery-resumption` approvals. Each includes a unique ID,
owner/Coder owner, workspace/project/task/recovery/runtime IDs, original retirement
event and attestation/continuation digests, exact final build/lifetime/config/package,
original runtime authority deadline, and an issued/expiry interval of at most one
hour. There is at most one approval per runtime and recovery. No value is enabled
by this source change. Existing package and legacy attestation enrollments must
remain present and exact; removing either still denies recovery.

Only authenticated owner retry enters the new path. It checks current Coder
ownership, build/template/agent, predecessor stop history and the agent-bearing
resource's exact volume. It sends the existing signed recovery-inspect request
before renewing authority. The installed host validates its original task/source/
lease and physical mapping and freezes the entire continuity ticket. Inspection
does not admit work. Its fresh signed guardian identity binds the exact scope and
inspection. The same provider checks run again before the renewal transaction.

The ticket retains the **original attestation digest** required by the installed
enrollment ACK. Its effective expiry comes from the separate explicit approval;
it is not a claim that the legacy attestation contained a later expiry. Its shape,
mapping and endpoint remain unchanged. The approval expiry is fixed across every
replay. If an earlier different ticket was already stored locally, b965 rejects
the request. The protocol never rewrites that local history.

The transaction uses READ COMMITTED with the existing workspace advisory fence,
slot/runtime locks and intent/recovery locks. It requires the exact blocked intent
and inspecting recovery with null persisted inspection, authorization and receipt,
generation one, one consumed enrollment, zero admission/native/registration/grant
history for this unused successor, no competing live workspace runtime, and no
maintenance conflict. Repository policy is checked again under those locks.

It inserts one immutable `unused_recovery_resumed` operation receipt and changes
only `authorityUntil`, capped at three minutes and approval expiry. Forward53
checks the event's structural scope, deadlines and empty inventory independently,
rejects unsupported expired-runtime deadline updates, and retains the earlier
retirement and native-tree/writer guards. This retains the existing trusted app/
database-role boundary; SQL does not independently verify Ed25519 signatures or
authenticate operator configuration.

The renewal event has admission generation zero because it creates no admission.
Generation, identity, original consumed grant and enrollment timestamp are
unchanged. Historical enrollment readback returns its original deadline; an
immutable renewal event explains the later unused-runtime deadline to existing
empty-close eligibility checks. No tree-exit, cleanup or writer-release fact is
created. Exact retry after a lost renewal ACK returns the same deadline. A second
approval cannot extend the same runtime again. Expired replay stays held.

After renewal the existing recovery authorization and consume paths obtain fresh
fences; the original task/request/prompt/source/lease identities remain intact.
An already authorized/consumed recovery is never reset to inspecting. The new
path does not submit a new prompt, bootstrap another host or mint another
enrollment grant.

## Compatibility and validation limits

No host source, wire shape, package, template or runtime issuer is changed. The
shipped b965 guardian and recovery modules support fresh inspection after a
normal enrollment's server authority expires. An empty host whose enrollment ACK
was recovered through `enrollmentRecovery` has a separate historical local cutoff;
that cutoff continues to reject identity/inspection when expired. Never extend
its historical receipt to make this path work.

Tests exercise actual PostgreSQL transactions and forward guards, signed service
identity verification, duplicate renewal replay, expired original attestation,
revocation and changed scope, malformed SQL events, delayed SQL rollback, and
registration/intent changes committed ahead of an advisory-lock waiter. The
installed-module test extracts the existing package and exercises real ticket
freeze/signing; its kernel/provider and task-provenance observations are fixtures,
not a claim of live host or native execution. Route tests verify inspection before
renewal and subsequent ordinary authorization/consume, while the normal path
continues to provision first. No provider activation or live owner retry is part
of these checks.

# Trusted checkout binding and native observation checkpoint

2026-10-29. D04 bounded implementation; manager and native ingestion remain disabled.
The [local evidence](native-observation-local/result.json) uses PostgreSQL 17 and
the installed Codex 0.165.0 executable with a local Responses fixture. No account
inference, paid service, production database or live deployment was used.

## Checkout identity and writer ownership

The installed host supplies `currentProjectContext(threadId)` from its verified
supervisor registration, preparation journal and managed checkout lease. Its exact
fields are `projectId`, `preparationIntentId`, `repositoryId`, `revision`, `leaseId`
and `leaseGeneration`. Tool arguments cannot override this context. Preparation
intent IDs and manager-created task/epic IDs are distinct identities.

Manager envelope version 2 signs the context with the command and native
thread/turn/call IDs. The server reauthorizes the persisted registration through
Coder, then locks and rechecks registration, conversation, preparation intent and
manager binding inside the mutation's Serializable transaction. It checks the
owner/project, repository/account, workspace/build/native lifetime and immutable
intent source revision. No native path or source revision comes from a model's
task definition. Explicit source rebinding is not implemented.

Migration `20261029090000_delivery_manager_binding` adds an immutable
`DeliveryManagerBinding`, nullable bindings on tasks/attempts, composite tenant
foreign keys and an active-attempt fence. A preparation intent serializes bindings
across native lifetimes; a second writer is denied even for a different manager
task. Replacement registration for the same native lifetime can reuse the binding.
Changing lifetime does not discard an unresolved old writer. SQL also rejects
clearing its active slot without persisted all-operation quiescence. Existing
unbound rows retain their identities and data.

## Separate observation channel

`POST /api/delivery/native` has a distinct signing domain and strict schema. It
requires both `HIVE_DELIVERY_MANAGER_ENABLED=true` and
`HIVE_DELIVERY_NATIVE_ENABLED=true`; neither is enabled by this checkpoint. The
route rejects browser Origin, query parameters, compressed/oversized bodies and
unbounded error details. An authenticated manager cannot choose a producer or
submit a check result through this source schema.

The installed observer pairs the actual native raw collaboration spawn call with
the corresponding `subAgentActivity` item. Only the exact manager parent turn,
spawn call, child thread and child turn are attributed to the reserved attempt.
Requested settings come from the native spawn request; effective settings come
from the native resolved creation item. Unknown or mismatched settings pause the
binding. The server's configured model/effort allowlist defaults to empty.

The source records native start, completed command and terminal turn facts. Command
and output content are reduced to SHA-256 digests; no command, output or prompt is
stored by this channel. It creates **no `DeliveryEvidence`**. Exit zero does not
prove a test ran or passed, and model prose does not establish success. Structured
completion still requires independent persisted, trusted acceptance evidence.

Source event IDs and sequence, attempt generation and exact runtime binding are
checked transactionally. Exact replay is idempotent. Changed content under an
existing source identity preserves the original event and adds a conflict, safety
pause and notice. Missing sequence is rejected. Observations arriving after an
attempt expires are retained as held facts; they do not restore execution authority.

Native turn completion records the turn as quiescent while background processes,
external operations and external effects remain unknown. The attempt's
`quiescedAt` stays null and its checkout writer stays reserved. Failed/interrupted
turns pause scheduling. No automatic manager retry, held-slot retirement or
external-operation reconciliation is exposed.

## Restart and offline behavior

The private journal persists the claim before returning its tool receipt, then
stores native source facts before sending them. Atomic writes and file/directory
fsync preserve unacknowledged state; source state is HMAC-bound to the installed
host key. Same native lifetime registration renewal can resend a lost response.
Old lifetime state cannot be attributed to a new runtime. A missing old claim,
tampered journal, conflicting native identity, partial history or unavailable
history lookup requires reconciliation.

On restart the installed synchronous `registerChild` callback restores only
proven child mappings. The private history callback reads one bounded page
(at most 20 turns); a next cursor is an explicit incomplete-history hold. The
spool retains acknowledged identities rather than recycling them. Bounds are
32 claims, 128 spawn fragments, 1024 source frames, 4 MiB journal, eight frames per
flush and a ten-second request timeout. Limits fail closed. Awaited adapter close
finishes any active delivery before the supervisor releases its process lock.

## Evidence and remaining gates

The focused suite passed 180 tests across 18 files, including real PostgreSQL
owner/replay/revocation/writer fences and an actual native child whose completed
command crossed the signed observer path into PostgreSQL. Fourteen host tests
cover private journal persistence, offline capture, lost acknowledgement,
conflicting facts, history recovery and actual native tool calls. Coder authority
and CI evidence in these fixtures are explicitly synthetic. The local provider
does not call an OpenAI account.

An initial ambient read-only native profile failed its `/oldroot` bind mount.
The passing test uses an explicit minimal permission profile with only its fixture
directory and the exact native ELF allowed. This is a runtime test profile, not a
production isolation proof. Fresh nineteen-migration and upgrade checks preserve
legacy user/session/ciphertext/active-attempt data and match repository migration
checksums. Prisma reports the same two pre-existing schema representations before
and after this migration: a manually added host-slot composite FK and the existing
preparation-intent project FK name. This migration adds no new drift.

Production activation still requires the [native authority isolation
gate](native-authority-isolation.md), authenticated live Coder host provenance,
immutable external evidence preservation and a trusted background/external
quiescence adapter. Journal file mode and signatures alone do not protect a signer
from native commands running under the same account. The browser bridge stays
read-only, and release, merge and production-phase acceptance remain disabled.

Parent integration review passed 19 real PostgreSQL manager/source tests, eight route/error
checks, sixteen host/package/spool checks (the additional native opt-in case was covered by
the specialist's actual-native run), and seven installer checks. The parent also corrected
Python sibling imports that wrote bytecode into the immutable installed package; installer
replay now explicitly checks that helper execution leaves package contents unchanged.

# Same-manager delivery progression

2026-10-29. Design proposal following report commit `2e3c10e`; no implementation,
activation or cloud migration in this document. Manager/native execution flags
remain off. The first pilot uses delegated work, as requested by the owner.

## Correct the completion premise

`DeliveryManagerService` checks the attempt's **child** native thread/turn and its
trusted `turn_completed` observation. The registered root manager invokes
`complete_step`. A root manager whose turn is still running can therefore complete
an already-finished child. It does not need to finish its own turn first.

There is an arrival-order race: child completion can precede delivery of its
observer facts to the controller. Today the manager adapter neither flushes the
native spool before its HTTP completion request nor retries that request. Fix that
bounded transport ordering first. A durable pending-result workflow is not needed
to solve the proposed delegated-work pilot. Direct/self-bound work is outside it.

## Actual progression barriers

| Current source | Barrier |
| --- | --- |
| `src/lib/delivery/manager.server.ts` | An existing `activeAttemptId` rejects a different claim; the claim callback requires it to be NULL. |
| `src/lib/delivery/repository.ts` | `pendingWriters` scans previous attempts; a reported/succeeded native attempt with unknown background/external activity still blocks a claim. |
| Migration `20261029090000_delivery_manager_binding` | Replacing/clearing the active anchor requires old-attempt quiescence. Native child completion does not establish that. |
| `templates/ai-dev-k8s/scripts/delivery-native-spool.mjs` | One claim per manager thread is retained indefinitely. A new claim must start at native sequence zero; fragments resolve through that single claim. |

`observeAttemptRuntime` can record quiescence but does not clear the anchor. Merely
adding a NULL update would neither fix the spool nor provide a sound multi-step
writer model. The informational report slice intentionally leaves these holds.

## Two distinct transitions

**Logical continuation:** the same registered root manager, native lifetime,
preparation intent and managed checkout lease advances to the next step. The
existing writer retains exclusive ownership throughout. The manager and native
app-server stay alive. For this pilot, the preceding root turn and its known child
turns must finish; the next claim belongs to a new turn on that same root thread.
This is a turn boundary, not process death or checkout handoff.

**Physical handoff or cleanup:** another native lifetime, checkout owner, rebuild,
source binding or cleanup action acquires/releases the checkout. This still needs
trusted drain of the entire relevant writer cohort, including descendants,
background processes and external operations. A child turn ending, a report being
accepted, or a logical cursor moving establishes none of that.

Reuse immutable `DeliveryManagerBinding` for writer identity. It already pins Hive
owner/project/conversation, preparation intent, Coder workspace/build, native
server/root thread, repository/source and managed lease ID/generation. Manager task
IDs remain distinct from preparation-intent IDs. Safe same-writer lease renewal
preserves this tuple; its separate cleanup renewal fence is not a new writer.

## Smallest additive persistence change

Keep `activeAttemptId` as the **physical writer anchor**, set by the first claim
and retained across logical steps. Do not remove its existing retirement trigger.
Add only these fields to `DeliveryManagerBinding` in a new additive migration:

| Field | Purpose |
| --- | --- |
| `currentAttemptId` nullable UUID | Logical attempt cursor, with composite owner/binding/attempt FK like the existing anchor FK. |
| `cursorVersion` nonnegative integer, initially zero | Compare-and-swap fence for logical continuation and its host receipt. |
| `progressionProtocol` integer, default zero | Legacy rows retain existing behavior; fresh explicitly opted-in pilot bindings use protocol one. |

First claim atomically sets both pointers. An accepted report/completion leaves
both held. The **next claim** atomically changes only the logical cursor and
increments its version, after checking the prior result and trusted continuation
checkpoint below. It creates the new attempt/event in that same transaction.
No intermediate NULL cursor, free-checkout state or release notification appears.

For this pilot, one binding owns one delivery task: continuation must match the
anchor's task. Multiple task/epic IDs may exist as bookkeeping, but crossing tasks
under a held writer is not implicitly enabled. Legacy bindings are not backfilled
as available; use a fresh, explicitly opted-in pilot checkout. Failure, expiry,
retry, source change and reopen retain reconciliation holds rather than gaining
a new continuation exception in this slice.

Add monotonic/version and owner-FK constraints and a guard against protocol-one
anchor retirement through the old *single-attempt* proof. Until a cohort-drain
operation exists, it cannot retire. An eventual trusted drain must cover the
binding's entire attempt/operation history and current cleanup fence, not just
the first anchored attempt. Historical reports/events/outbox remain immutable.

## Close the native admission race

The current host cannot freeze a live root turn's collaboration admission.
`createNativeManagerRouter` invokes observers without awaiting their promises and
allows eight concurrent dynamic-tool handlers. The adapter's `active` set excludes
only duplicate call identities. The spool flushes a batch while notifications keep
arriving. A successful history read or a JavaScript mutex therefore does not prove
that an in-flight root turn cannot spawn another child during the claim HTTP await.
The earlier same-live-turn checkpoint proposal is withdrawn.

Use a conservative boundary that can be implemented through existing native
methods, with new trusted supervisor sequencing. These are requirements to prove,
not capabilities already provided by `flushNative()`:

- One installed supervisor owns root `turn/start`/steer/input admission during the
  pilot. No CLI attachment, parallel prompt producer or browser mutation path may
  start/resume work. Existing supervisor `firstPrompt` handles only the first turn;
  a private bounded continuation-start method and its durable journal are needed.
- After the exact prior root `turn/completed`, the supervisor reconciles the root
  turn's complete bounded item history and every proven child's turn history. Any
  nonterminal turn, unresolved spawn, unknown active thread, truncation, pending
  tool handler or unacknowledged fact blocks the boundary. A router receive counter
  orders frames and fences the asynchronous handlers locally; it is not asserted
  to be a native global admission watermark. Reconcile again if relevant frames
  change during the reads/flush.
- While no root turn is running, journal a boundary receipt containing the exact
  completed parent turn, cursor/version, reconciled spawn identities, native
  sequence and host lifetime. Start one continuation turn on the same root thread
  under the same supervisor gate, with an exact durable request ID. An ambiguous
  `turn/start` ACK requires exact history reconciliation or a hold, never a blind
  second start. The first started-turn frame/response binds the actual new turn ID.
- The next `claim_step` must be the first admitted delivery operation in that exact
  new turn. A root spawn or other work item before the new claim receipt is durably
  installed is a protocol violation: retain its original identity, hold the writer
  and refuse trusted execution binding/completion. Do not silently assign it to the
  old attempt or promote it after the HTTP ACK. Native collaboration can still run
  such invalid work; the host cannot prevent that through this mutex. It remains
  inside the already-held writer cohort and is never accepted as admitted work.

The old root turn is terminal before the controller changes the logical cursor,
so it cannot continue spawning admitted old-attempt work across that transition.
Out-of-order/delayed facts retain immutable old-attempt attribution and can still
force a hold. The new turn may only yield positively accepted child facts after
its claim receipt. This closes acceptance/attribution races without pretending to
stop untrusted native execution. If the pinned protocol cannot demonstrate the
terminal-history boundary, the pilot stops; no fallback to same-live-turn claims.

## Claim, completion and host responsibilities

1. The manager claims an informational `understand` step and submits `report_step`.
   That records model-authored understanding, not verification. Alternatively, a
   step delegates work to exactly one proven native child with requested/effective
   settings matched by the observer. The root may complete that child and submit
   the result in its existing turn, then finishes the turn before progression.
2. Before the next claim, the installed host establishes the completed-root-turn
   boundary above. It resolves every admitted spawn fragment, reconciles bounded
   root/child history, and flushes observer facts through controller acknowledgement.
   Unresolved, truncated, ambiguous or lifetime-conflicting history produces a hold.
   An informational step with no admitted child needs no invented child observation.
3. The host adds a strict signed envelope field, unavailable in model tool input:
   binding ID, prior attempt ID, completed root turn ID, actual next root turn ID,
   expected cursor version, acknowledged native sequence and exact checkout tuple.
   A manager boolean cannot authorize this. Revalidate registration, lease/context
   and journaled boundary immediately before send. Persist the completed-root-turn
   observation and unique one-use boundary identity in the existing event log; the
   claim transaction consumes that identity with the cursor advance. Bind its
   digest to the exact next claim for idempotent replay, and reject a different
   next turn/claim. Model input cannot choose a terminal observation or its status.
4. In the claim transaction, lock/revalidate registration, intent and binding,
   then task/step/attempt. Require the same writer, current cursor/version/sequence,
   terminal prior `reported` or `succeeded` result, the persisted exact completed
   parent turn and unused boundary/next-turn binding, satisfied dependency contract,
   no blocked binding/pause and no foreign or legacy unresolved writer. Preserve
   existing budgets, source, generation and phase checks. Advance the cursor
   atomically; simultaneous next claims have one winner.
5. For `complete_step`, the adapter first performs a bounded observer
   flush/readback for that exact attempt and terminal child. Then it sends the
   existing completion request. The server independently rechecks native identity,
   settings, attempt lease, source and applicable shared GitHub policy inside the
   mutation transaction. Child completion is not test/check/review evidence.

The narrow same-writer claim path may tolerate prior background/external activity
remaining **unknown and owned by this same cohort**. It must not change
`proofQuiescent`, set `quiescedAt`, exempt foreign writers or make pause/drain,
handoff, source changes and cleanup treat those operations as stopped. A future
step requiring a frozen workspace needs an independent stable-snapshot gate;
logical dependency success does not provide it.

The host spool needs an attempt-indexed claim history plus a separate current
cursor. Persist immutable attempt attribution on each spawn fragment/event;
never look up a delayed old child through the new current claim. Retain old
acknowledgements and conflicts. Native sequence remains binding-lifetime monotonic;
new claims start from the server's acknowledged sequence, not zero. Journal the
new cursor receipt atomically before permitting its spawn. Missing receipt after
lost ACK can recover only by exact server replay/readback, never guessed state.
Keep file/byte/history limits explicit and hold at capacity; general compaction
is not part of the pilot.

Completion retries preserve the original native call identity, event ID, canonical
command and digest. Refresh only permitted transport timestamp/signature fields
under the same valid registration/lifetime; every retry repeats authorization.
Use a small total deadline and attempt limit. Do not retry policy, source,
revocation, settings or content conflicts. Network ambiguity/lost ACK uses existing
transactional replay. If observer readiness cannot be established within the
bound, return a safe retryable failure without recording acceptance or extending
the lease. A separate later model call is a new event, not an exact transport
replay. A proven recovery requirement could justify a durable pending proposal
later, but it is not a new table or API in this first implementation.

## Implementation order and ownership

1. `packages/db/prisma/schema.prisma` and one additive migration: anchor/cursor
   split, protocol opt-in and retirement guard. Coordinate schema ownership and
   regenerate both existing clients; no live apply in this slice.
2. `src/lib/delivery/{manager-contracts,manager.server,repository}.ts`, narrowly
   `manager-binding.server.ts` and native contracts/service as needed: strict
   host-only checkpoint, transactional continuation, claim receipts carrying
   cursor/version/sequence. Existing manager HTTP endpoint suffices; no public
   manager authority, pending-results endpoint or scheduler is introduced.
3. Canonical `delivery-manager-adapter.mjs` and `delivery-native-spool.mjs`:
   attempt attribution, boundary/receipt journal and completion flush/retry.
   Extend the router with frame/handler accounting, and coordinate the supervisor's
   private root-history and gated continuation-start methods with its owner. The
   existing child-history callback alone is insufficient. Root regenerates
   packages/profiles/archives.
4. Focused unit/native and real PostgreSQL integration fixtures below, then
   independent review. Keep both execution flags off regardless of fixture results.

## Acceptance and bounded pilot

Use the actual pinned native runtime with mocked Responses, isolated fixture
checkout, fixture registration and local PostgreSQL. No account inference,
personal credential copy, remote push/deploy or cloud mutation. Keep one root
manager/native lifetime alive through `understand → validate → validate` at one
immutable SHA, with a completed root turn between steps and automatic trusted
continuation turns. No browser/manual prompt is required to advance. Use read-only
child work, controller-trusted fixture evidence and
explicit independent policy negatives; this is not proof of real CI success.

| Proof | Required result |
| --- | --- |
| Same-manager progression | Informational report, then two distinct delegated child attempts complete in separate root turns; thread/server and native process identity stay unchanged, cursor advances and physical anchor/lease remain held. |
| Arrival order | Completion called after child terminal but before observer HTTP ACK waits/flushes within its bound; controller accepts only after matching trusted facts. No dependency on parent-turn completion. |
| Native boundary | Delayed old-turn spawn frames, unresolved child, concurrent tool calls, a root still in progress, duplicate next-turn start, parallel external turn producer and spawn-before-claim-ACK all hold; no invalid work is retroactively admitted. Demonstrate actual native completed-turn history plus continuation-start ordering, not only mocked callback ordering. |
| Replay/restart | Lost claim/completion ACK and host restart recover the same attempts/reports/outbox once; changed payload conflicts; no sequence reset. |
| Cursor races | Concurrent next claims, stale cursor/version/checkpoint, delayed old-child facts, unresolved spawn and paginated history never authorize the wrong attempt. |
| Authority drift | Revoked/expired registration, changed source/lease/native lifetime, settings mismatch, failed child, missing required checks/review and same-policy supersession block acceptance. |
| Held cohort | Unknown background/external activity does not become quiescent after report, completion or continuation; another lifetime/task cannot claim or clean up. |
| Storage and projection | Fresh/upgrade migration retains legacy holds, reports/events/outbox; owner-composite FKs reject cross-owner/cross-binding cursor links; notices remain exactly once. |

Stop after logical progression with the physical writer still held. Existing
native command `processId`/terminal counts are not OS-process death attestations.
The retained writer-quiescence proof demonstrates why detached descendants and
unlinked-file writers require a real cohort boundary; that drain is not yet an
integrated general handoff capability. No forced manager death between steps is
required or claimed by this pilot. Finishing the previous root turn is required
for logical continuation; finishing the parent turn is not required to submit an
already-completed child's current result.

Further roadmap gates remain: trusted cohort drain for handoff/cleanup, bounded
failure/retry cursor transitions, trusted source advance from immutable preparation
SHA to committed head, actual independent GitHub collection and policy proof,
portable transport/notifications and owner-approved release. Source advance is
particularly distinct: current intent/binding pin the original SHA, so logical
progression cannot silently authorize a new commit. These are follow-up slices,
not implied by this limited progression acceptance.

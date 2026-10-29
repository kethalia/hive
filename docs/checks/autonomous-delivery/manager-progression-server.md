# Server-side logical progression

2026-10-29. Bounded server foundation, not integrated native execution. No cloud
migration, production activation, canonical host or generated bundle change in
this slice. Existing manager/native HTTP flags remain off by default, and their
production service construction does not opt into protocol one.

The [design](manager-progression-design.md) separates one native checkout writer
from successive logical attempts. This implementation preserves `activeAttemptId`
as the original physical writer anchor and adds `currentAttemptId`, `cursorVersion`
and `progressionProtocol` to `DeliveryManagerBinding`. Protocol zero is the default;
only explicit controller composition with `ManagerDependencies.progressionProtocol
= 1` can create a fresh protocol-one binding. Existing bindings never upgrade via
an upsert. The new composite FK binds the cursor to the same owner and binding.

The first claim sets anchor and cursor together. Later claims change only the
cursor/version. SQL rejects anchor retirement for protocol one until a separately
reviewed whole-cohort drain exists. Legacy anchor retirement retains its existing
proof requirements. Reporting, completing, recording a root boundary and advancing
the cursor do not set `quiescedAt` or establish background/external quiescence.

## Installed-host contract

All fields below are strict and signed in the existing fixed native/manager proof
domains. Neither model tool commands nor their payloads accept a checkpoint,
producer or terminal-status assertion. The authenticated observer is responsible
for deriving native facts; the server cannot independently query that runtime.

| Operation | Contract |
| --- | --- |
| Native `POST /api/delivery/native` | Existing envelope pins prior task/step/attempt/generation, registration, checkout and lifetime. Its source is `{kind:"root_boundary",parentTurnId,nextParentTurnId,cursorVersion,observedAt}`. Sequence is the next binding-lifetime native sequence. |
| Boundary receipt | `{accepted,blocked,replayed,sequence,boundaryEventId,cursorVersion,activeAttemptHeld:true}`; exact replay retains the original boundary identity. |
| Manager `claim_step` envelope | Optional outer `continuation:{boundaryEventId,priorAttemptId,cursorVersion,parentTurnId,nextParentTurnId,sequence}`. It is claim-only. `nativeTurnId` must equal `nextParentTurnId`. This is outside the model-controlled `command`. |
| Protocol-one claim receipt | Adds `progressionProtocol:1,cursorVersion,nativeSequence` to the existing scoped attempt receipt. Exact replay returns the original cursor/sequence, even if the binding subsequently advanced. |

There is no new readback API. Exact retries use the existing signed endpoints and
immutable event IDs/content. Refreshing transport timestamps/signature does not
change the canonical operation. A replay remains `canRun:false` and retains the
existing reconciliation indication: a host needs its matching pre-send journal
and trusted native reconciliation, rather than treating a receipt as execution
or cache authority.

Boundary ingestion requires the fixed native observer producer, an opted-in
current cursor, exact preceding claim parent turn, a distinct unused next parent
turn, terminal logical result, matching step/source and unexpired attempt lease.
If a native child was bound, its matching trusted successful terminal observation
is required too. An unbound result can advance only as the explicitly permitted
informational report. Future/stale observations and paused tasks reject. There is
one immutable boundary event per binding/cursor, and recording it advances the
native sequence without creating verification evidence.

Publish/read back that event immediately before the next claim. `observedAt` means
the host genuinely revalidated the stored completed-root boundary and its admission
journal; it is not a fabricated timestamp for the original completion. Do not mint
it at next-turn start and then assume it remains usable while the model thinks
beyond 60 seconds. Once published, exact retries retain its original bytes/digest.

Claim authorization repeats active-registration/checkout/task checks inside the
Serializable mutation. It matches the boundary, both turn IDs, current attempt,
cursor version, native sequence, same task and source; the boundary must be at
most 60 seconds old. The repository's narrow exception admits only terminal
attempts owned by that exact writer. Ordinary repository claims, unknown/failed
attempts, other tasks, legacy writers and other native lifetimes remain held.
Existing dependency, budget, phase and pause checks still apply.

The transaction creates the next attempt/start event, compare-and-swaps the cursor
and inserts a uniquely keyed `native_boundary_consumed` event. Failure rolls all
of those back. Exact duplicate calls replay once; a changed checkpoint/content
under the same event ID conflicts. Another claim cannot consume the boundary.
Late exact native-source replays remain historical acknowledgements. A new frame
for an old cursor instead records a conflict and holds/pauses the writer.

## Validation and remaining integration

[Local evidence](manager-progression-local/result.json) records the final checks.
The PostgreSQL fixtures exercise a synthetic signed-host sequence of an
informational report and two delegated child attempts, unchanged source/binding,
monotonic cursor/native sequence and preserved original writer anchor. They also
cover duplicate and competing claims, rollback on pause, missing/stale/wrong-scope
boundaries, model assertions, revoked registration, unfinished children, lease
expiry, legacy opt-in, cross-owner/binding SQL constraints, lifetime handoff and
late old-attempt conflicts. These are server authority tests, not actual native
admission proof or real GitHub checks.

Fresh 22-migration and copied 21→22 upgrade validation preserve prior table
digests, including historical reports/outbox and a legacy held anchor. A separate
new temporary PostgreSQL cluster verifies final migration bytes. An earlier
shared local fixture applied a pre-final draft of this new uncommitted migration;
its history rows were not rewritten. No remote database was touched.

The host implementation must still prove sole admission of root starts/steers/CLI
inputs, durable exact-once continuation-start journaling, complete root/child
history and observer acknowledgement, and attribution of delayed old facts. The
actual native feasibility probe found that concurrent `turn/start` requests can
be accepted into the same active turn; native rejection is not a lock. Root history
also gains late child-completion items after root completion, so it must be reread
after children finish. A signed `root_boundary` is not evidence those host checks
are implemented. The host must hold on unexpected user messages, ambiguous starts,
unresolved children and work before the new claim receipt; it must never
retroactively attribute that work to the accepted attempt.

No new quiescence, handoff, cleanup, retry/reopen, source-advance, release or
production authority is enabled. Same-thread progression spans completed root
turns while the same process/checkout writer stays held. Integration and separate
native isolation/admission proofs remain required before any pilot activation.

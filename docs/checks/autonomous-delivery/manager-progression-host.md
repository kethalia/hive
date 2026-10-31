# Local protocol-one host progression

This slice connects the canonical manager adapter, native observer spool and
project supervisor to the committed protocol-one controller contract. It is
explicit constructor opt-in for a fresh local/pilot binding. The installed
workspace-host configuration still passes `nativeEnabled: false`; no deployed
flag, template, model account or Cloudflare resource was changed.

The local fixture uses actual pinned Codex 0.165.0 with a private mock Responses
provider, canonical supervisor/router and real PostgreSQL transactions. It
automatically records an informational `understand` report, then completes two
distinct delegated `validate` attempts in three root turns at one synthetic
source SHA. Check evidence is explicitly simulated and supplied by a trusted
fixture producer; this is not real CI acceptance or account inference.

## Journal and admission

The existing HMAC-protected `native/source.json` retains the original schema-one
legacy claim format. Protocol one adds bounded attempt-indexed immutable identity,
per-root logical cursor, binding-lifetime native sequence and acknowledged
sequence, pre-send claim intents, accepted result receipts and continuation
receipts. The first claim remains the physical anchor. Spawn fragments retain
their original attempt ID; a late duplicate is idempotent, while a new late fact
for an older attempt stays attributed there and holds the writer. An unadmitted
spawn/work item retains its original identity without an attempt and is never
promoted after a later claim ACK. Nested delegation is outside this pilot.

The supervisor's existing signed `registry.json` stores a continuation request,
completed prior turn/cursor, history digest and `start-uncertain` phase before its
single `turn/start`. A successful ACK binds the actual new turn ID. An uncertain
start is never resubmitted. The private `continueDeliveryRoot` and
`revalidateDeliveryBoundary` methods are absent from command/gateway/browser
dispatch. CLI attach and rejoin are prohibited for this protocol.

Before continuation, the supervisor drains measured async observer/handler work,
reads full bounded root and every known child history, exhausts item cursors,
compares item contents, verifies exact spawn/settings identities and known loaded
inventory, and repeats if its notification counter changes. RPC read responses do
not advance that counter. The claim handler excludes only its own exact
thread/turn/call identity from drain. A timed-out model-facing tool reply does not
remove the still-running underlying handler from accounting.

The root must be terminal before the new start. Just before the new turn's first
claim, the host repeats the history/admission checks, publishes the signed
`root_boundary` with a genuine fresh observation timestamp, waits for its native
sequence ACK, then attaches the host-only continuation checkpoint to the signed
claim envelope. It is never accepted from model command arguments. Competing
manager calls, unexpected input, a spawn/work item before receipt, unresolved or
changing history, changed lease/context and unknown native inventory retain a
hold. A JavaScript gate is not claimed to stop native collaboration execution.

Before delegated completion, bounded full child history and native source ACKs
must be ready. Completion transport retries retain the original event, native
call identity and command; only transport timestamp/signature refresh. Policy,
source and other 4xx conflicts are not automatically retried.

## Reservations are not execution grants

The frozen controller's fresh response is intentionally `canRun: false`,
`replayed: false`, `outcome: running`, `needsRuntimeBinding: true`,
`needsReconciliation: false`. The host durably records this exact reservation and
preserves those values in model-visible history. It permits informational reports
and the existing provenance/settings observation path for a proposed native child
under the already-held writer. It never changes the receipt to `canRun: true` or
creates new physical execution authority. Child binding and completion evidence
still pass the controller's independent gates.

Historical replay, reconciliation-required receipts and unknown authority shapes
hold. Exact lost-claim-ACK requests remain journaled but are not runnable from a
historical receipt. Fresh authoritative cursor/lease readback is a later gate;
there is no invented restart recovery here. The first local integration failure
from conservatively conflating a fresh reservation with historical uncertainty is
preserved in `manager-progression-local/host-native-pg-first-failure.json`.

## Deliberate pilot bounds

Current controller registration ID, expiry, native lifetime and immutable checkout
context are rechecked before continuation, after awaited history, after durable
start-intent fsync, and after HTTP response/receipt processing. Heartbeat expiry
extension of the same registration is allowed; registration replacement is not
silently adopted. A stale positive ACK remains journaled by digest under its
original registration/lifetime and holds the root. The server's reservation or
accepted report is not pretended undone, and it cannot schedule a new turn.

Owner pause currently stops authoritative new step claims/scheduling; it is not
an instantaneous inference or process-kill contract. A reconciliation turn may
request a next claim, which the server denies while paused. Local revocation,
lease failure and registration expiry reject new native starts. There is no
invented server pause preflight. The earlier positive checkpoint is retained as
`manager-progression-local/host-native-pg-pre-review.json`; the new regressions
cover expiry before start, during awaited history, and across claim/report/
completion ACKs.

- Full root history is capped at **20 turns**, while the task schema allows 32
  steps. Larger epics stop at the bound; this slice is not complete large-epic
  support. There are at most 512 items per turn and explicit page/byte limits.
- Each logical delegated attempt uses exactly **one child with one completed
  turn**. All prior cohort children are rechecked too. Informational steps may
  have no child. Nested delegation and new old-child turns hold.
- Native loaded-thread inventory is exclusive to **one project** and its known
  children. Other loaded project threads hold even when unrelated work could
  otherwise be legitimate; multi-project coexistence is not accepted here.
- CLI attach/rejoin, alternate prompt producers, runnable replay/start recovery,
  source advance, general pause/retry progression and physical cohort drain are
  not implemented. Later CLI and lifecycle work must address these explicitly.
- Journals have fixed capacities and no general compaction. The anchor and
  unknown background/external writer state remain held; `quiescedAt` is never set
  and the physical anchor is never cleared by this continuation path.

## Reproduce

```sh
node --test scripts/verify-delivery-native-spool.test.mjs scripts/verify-delivery-manager-adapter.test.mjs scripts/verify-codex-project-supervisor.test.mjs
HIVE_TEST_NATIVE_CODEX=1 HIVE_DELIVERY_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:39789/hive_delivery_test pnpm exec vitest run src/__tests__/lib/delivery/host-progression.integration.test.ts
```

The PostgreSQL URL must address the isolated loopback `hive_delivery_test`
database. Fixtures use fresh owner IDs and do not truncate shared tables.
The original baseline ran on the retained schema-22 fixture at port 43811. After
canonical client regeneration for the additive source model, the post-review
base-task compatibility proof uses the separate schema-23 fixture at port 39789;
it does not exercise advanced source context or source publication.
`HIVE_HOST_PROGRESSION_EVIDENCE_PATH` can select another JSON filename beneath
`docs/checks/autonomous-delivery/manager-progression-local` for independent parent
reruns. This is test-only output configuration. Scratch is removed only after
successful close/drain and observed native process exit; shutdown failure records
and retains its path. No writer-quiescence or production cleanup authority is
derived from this synthetic fixture shutdown.

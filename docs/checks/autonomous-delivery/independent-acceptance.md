# Independent intent-aware acceptance (schema 31, default off)

This slice adds a controller-owned evaluator for arbitrary original intent. It uses
one separately created native thread on the existing pinned Codex runtime/account;
it is not the implementation manager's child and cannot call tools. No new account,
paid API key, cloud activation, or production permission is introduced.

At original task enqueue, an immutable, purpose-bound encrypted snapshot preserves
exact user text and the already selected repository policy. Clearing preparation
ciphertext does not erase it. A durable plan job derives explicit `acceptance:*`
requirements, meanings, phases, and original-byte citations. The first manager
prompt waits for that exact plan and evaluator archive. Task creation must cover
all requirements with matching phases and review evidence; an informational step
cannot discharge them. A plan needing clarification remains unmet.

The installed factory schedules evaluation, with durable leases and journal writes
before thread creation and turn submission. The private native thread has the
read-only permission profile, never approvals, no repository instruction sources,
and shell/collaboration/apps/plugins/hooks/search disabled. The actual tool catalog
is empty in the local pinned-runtime proof. Requested and effective model/effort
must match; no fallback is accepted. Accepted output must meet the deployment
descriptor deadline (at most five minutes). An in-flight native RPC has its existing
five-second bound; cancellation/interrupt can therefore settle after the accepted-
result deadline. Unknown outcomes retain a hold rather than claiming immediate stop. Unknown creation/submission retains a
hold; it does not cause another inference. Completed output can be resent after a
lost result ACK, and historical ACK is factual, not new execution authority.

`read_acceptance_plan` has an empty manager payload and exposes authoritative
scope. The implementation manager cannot select the evaluator's model, producer,
input, criteria meanings, paths, or permissions. The signed fixed
`POST /api/delivery/host/acceptance` endpoint authenticates the current registered
host and locks current guardian/checkout/policy scope before and after processing.
Its action/result bodies grant no execution, publication, or cleanup permission.

After accepted publication, the installed factory schedules a bounded review of
that publication; `read_status` can coalesce a refresh no more than once per minute.
The fixed Python reader opens only the existing private published broker operation,
checks its HMAC scope and sealed bytes, and never contacts a provider or modifies
Git. Server `prepare_review` independently compares the full manifest digest and
all supplied UTF-8 file bytes' SHA256/Git blob hashes to the accepted source. The
immutable job material is bounded to 200,000 JSON bytes and 131,072 source bytes.
The reviewer receives changed files, deletion manifest, exact candidate/parent/tree
identity, original intent/plan, and independently authenticated provider facts.
Unchanged files, binary material, and production observations are explicitly absent;
insufficient context is not a pass. Source comments/logs remain untrusted data.

Review results cite supplied immutable entry digests/ranges and include every plan
requirement. They produce only `review` evidence for implementation preview, with
actual native model/effort/thread/turn/config provenance. The immutable result is
stored in the acceptance job; its evidence object reference is explicitly
`database/acceptance/<owner>/<job>` (not a claimed R2 object). No check, migration,
production observation, or quiescence evidence is synthesized. Existing repository
CI/reviewer gates remain mandatory and independently authorized. Consumption checks
current accepted source, plan and producer; a review cannot substitute those gates.
Stale queued material is held; stale completed inference is acknowledged as held
without producing evidence. A new current material identity can queue a new job.

Before source application or manager progression, evaluator admission closes and
existing work must finish/archive before the unchanged complete native inventory
check. There is no unknown-thread exemption. The barrier is an input/observer
boundary, not kernel writer quiescence. Physical writer/guardian holds remain.
Revocation aborts transports and the private reader, interrupts only the exact
owned evaluator turn, and cannot return a late positive authority. Normal shutdown
waits for owned work within the existing host shutdown bound; uncertainty retains
work and holds.

## Deployment and limits

`HIVE_DELIVERY_ACCEPTANCE_ENABLED=true` plus the exact JSON
`HIVE_DELIVERY_ACCEPTANCE_PRODUCER` is an explicit opt-in. It also requires delivery
execution, manager and repository enrollment. The optional `acceptance` host config
is included in the independently computed guardian config digest; absence preserves
the old digest/default behavior. The descriptor pins the compiled native evaluator
module SHA256, reviewed prompt/schema digests, permission-profile digest, runtime
0.165.0, model/effort and input/output/time bounds. The host checks the actual installed
module bytes; package/guardian identity binds the remaining compiled modules.
Python installer, host and server reject malformed selections. No deployment flag
or template activation was changed by this slice.

Runtime has one evaluator slot and a bounded 64-entry lifetime journal. Idle polling
is every 30 seconds; immediate plan preparation and newly queued review trigger the
same coalesced pump. Review preparation is at most once per minute. Pending or
ambiguous old-lifetime work is never adopted. Producer rotation does not retrofit
old intents or regenerate their plan silently. Production-phase requirements remain
pending without independently scoped production observations. This is defensible
independent review evidence, not formal proof of goal fulfillment or immunity to
model mistakes/prompt injection.

Automatic repair after a failed or insufficient review is not implemented in this
slice. The producer records unmet requirements and the current continuation holds;
it never converts failure into a pass. A follow-on controller loop must expose the
scoped feedback to the manager, authorize a new repair attempt, and evaluate the
new candidate. After source application, the installed callback requires the exact
current review to pass and the evaluator to archive before returning to manager
continuation. This sequencing prevents the next claim from outrunning acceptance,
but does not claim a complete iterative repair loop.

## Evidence and remaining acceptance gates

`acceptance-native-local/` preserves early native fixture failures and their targeted
corrections. The final actual native-to-signed-service local proof uses a canned
Responses endpoint and actual PostgreSQL/guardian authorization. Exactly one native
request survives a deliberately lost post-commit ACK; recovery resends only its
stored result. Native permissions, evaluator tool configuration, model/effort and archive
are real. A second actual manager root tries the advertised v2 `send_message` against
the evaluator UUID and receives agent-not-found. The unsupported legacy `send_input`
probe is retained as a fixture correction, not an exploit. Independently, observed
inputs must match the one controller-supplied message/client ID. The evaluator
archives and reads persisted history before returning any receipt: exactly one
completed turn, one original input and one final output, with no tool/child items.
Bounded `thread/turns/list` and `thread/items/list` pages must both exhaust with
explicit null cursors and match the archived read exactly. Partial/truncated
metadata, duplicate IDs, over 100 items, or combined history over 2 MiB hold.
Unexpected input or history ambiguity prevents server acceptance. Guardian enrollment and provider/publication facts in DB fixtures are
explicit synthetic authorities; they are not account-backed provider acceptance.

Installed compiled-package tests, reviewer approval, deployment policy/descriptor
binding, and a bounded account-backed workspace pilot remain required. This document
does not claim that the default-off feature is activated or that a delivery or
production rollout completed.

# F07 native Preview durable wake — approval proposal

Status. Owner approved this bounded implementation on 2026-11-09. Source and local
validation are complete for independent review. The new flag remains false, with no pilot tuple or live
binding enrollment performed by this change. The target is the existing `hive`
Worker and its isolated epic Preview. Production configuration remains outside
this slice. Live enrollment and any spending require the separately reviewed
pilot configuration and unused included capacity described below.

## Demonstrated gap and existing execution

[`startProjectTask`](../../../src/lib/projects/task.server.ts) validates ownership,
repository/source and runtime policy, then persists `ProjectTaskIntent` and returns
`preparing`. It creates no durable wake. `readProjectTask` advances one exact
intent through `reconcileProjectTasks`; the browser's
[`ProjectWorkspacePanel`](../../../src/components/projects/ProjectWorkspacePanel.tsx)
polls every three seconds, at most twenty times, and cancels on unmount. Closing
before that first status call can strand an accepted intent; server-assisted
`awaitingRegistration` recovery can also stall.

After signed `/projects/tasks/start` reaches the installed host, its saved task,
controller queue, five-second resume loop, lease renewal and native event spool
continue without a browser. This proposal fixes the preceding server preparation
wake; it does not replace those pumps, guardian authority or recovery holds.

Native [`composition.mjs`](../../../deploy/cloudflare/native/composition.mjs)
intentionally excludes Preview schedules. Current [Cloudflare Preview support](https://developers.cloudflare.com/workers/previews/resources/)
also excludes cron invocations and Queue consumers. Preview Queue producers alone
cannot execute branch code. Workflow bindings call an existing Workflow's deployed
code/bindings/instances, not the Preview's code; none is enrolled for this role.
Same-Worker Durable Object classes without `script_name` instead receive an
isolated namespace per Preview, retained across its deployments. Thus a small
SQLite Durable Object alarm is the supported branch-local wake option, without
another Worker or Workflow service. `waitUntil` alone is not durable recovery.

## Proposed bounded contract

One `ProjectTaskWake` class, binding `HIVE_PROJECT_TASK_WAKE`, enabled only by a
new default-off `HIVE_PROJECT_TASK_WAKE_ENABLED` flag. One pilot object is named
from the server-derived owner/task identity; the operator enrolls that exact task
for the pilot, not a wildcard. No public DO endpoint or caller-selected origin,
class, database, workspace or credentials. The object stores only schema version,
owner/project/task IDs, initial reservation time/deadline, attempt budget, next
wake and terminal outcome. No prompt, encrypted prompt copy, token, cookie,
provider response, credential value/hash or model-selected authority is stored.
Total serialized application state is capped at 64 KiB; bound SQL rows and avoid
an append-only log. Physical SQLite allocation may exceed logical payload size.

PostgreSQL stays the task/source/policy/lease authority. Reuse
[`ProjectTaskIntents`](../../../src/lib/projects/task-intents.server.ts): immutable
request replay, encrypted payload, due time, lease claim, progress timeout,
failure accounting and host idempotency. The alarm calls the same reconciliation
for its **exact owner/task**, limit one, after freshly loading/authorizing the DB
row. It cannot fabricate a task or bypass pause/build/guardian checks. At-least-once
alarms and lost host ACKs use existing replay/hold rules, never a second prompt.

1. Following successful request validation/policy selection, durably reserve and
   arm the wake **before** `store.enqueue` can commit. Obtain its acknowledgment;
   unavailable/unknown reservation means no new DB enqueue. Existing-intent replay
   must also ensure the same reservation or return its durable terminal hold; the
   current early-return path cannot bypass this step.
2. Enqueue with the existing deterministic task ID. The pre-armed alarm retains
   bounded retries when no row is visible yet; an absent row is not completion.
   An optional post-commit notification accelerates it but is not the only wake.
   A crash or lost ACK after DB commit therefore leaves the reserved alarm.
3. No distributed transaction is claimed. Reservation has a fixed first-created
   30-minute deadline, never extended by replay. Enqueue must use bounded DB/request
   deadlines and refuse an expired reservation. If a delayed/unknown commit appears
   after that deadline, the retained DO tombstone is a **hold**, not permission to
   launch: status must expose the hold and reconcile it into the DB without
   dispatch. The same guard applies to browser-driven reconciliation when this
   feature is enabled. Never erase a reservation merely because enqueue errored;
   its commit may be unknown.
4. Re-arm durably before each external reconciliation attempt, incrementing its
   persisted budget first. Bound each attempt to 45 seconds, cancel/close request
   resources, and do not overlap attempts. Follow DB next-attempt/lease times,
   with bounded backoff. Stop alarms on running handoff, blocked state, exhausted
   budget or deadline; persist the terminal result. No empty global DB scans and
   **zero idle DB polls** once the pilot task is handed off or held. Alarm delivery
   itself is not a deadline guarantee.

## Small implementation and provisioning surface, after approval

- New `deploy/cloudflare/native/project-task-wake.mjs` class and focused tests;
  export it from existing `native/worker.ts`.
- `native/wrangler.jsonc`: reviewed `new_sqlite_classes` migration plus exact
  same-Worker binding repeated under `previews`, no `script_name`; flag stays off.
  Update strict `native/deploy.mjs` validation/tests to allow only this reviewed
  class/binding/migration and default-off flag. Do not broaden production prep.
- One server adapter in `src/lib/projects/task-wake.server.ts`; minimal hooks in
  `task.server.ts`/`task-intents.server.ts` for reservation, existing replay and
  terminal-hold checks. Use server-derived identities only.
- Extend the existing `deploy/cloudflare/app/project-tasks.ts` request-lifetime
  adapter with an **in-process, exact-task** reconciliation entry using the same
  scoped environment/DB context. The DO invokes that local adapter; do not reuse
  or weaken the publicly routed bearer-only reconciliation endpoint, add a token,
  or fall back to production service bindings. Actual Workerd proof must verify
  environment/request-context wiring before live enrollment.

After source review/tests, root reviews the exact plan and provider-returned
Preview binding/namespace identity, publishes the approved source through the
existing Workers Builds path, and separately enables the exact pilot flag/task.
No manual production deployment, new Worker, plan upgrade or new token. Retain
failed pilot state/evidence; disable enrollment to stop new wakes, preserving
accepted intents and existing holds.

## Verification, limits and included-cost basis

Unit + real local Workerd/SQLite + isolated PostgreSQL composition must cover:
reservation failure causes zero enqueue; reserve→crash before enqueue; commit→crash
before acceleration; lost reservation/commit/host ACK; duplicate alarms/replay;
isolate restart; row not yet visible; late commit after expiry; expired lease,
pause, wrong owner/build and concurrent browser reconciliation; budget exhaustion;
and no DB access after terminal state. These are software proofs, not live-provider
acceptance. Live acceptance closes the browser immediately after accepted start,
observes exact host preparation/native handoff without polling, then verifies
restart/replay and sanitized usage/state evidence. No model-spend expansion.

Pilot hard bounds: **one object, at most 100 application requests/attempts including
reserve/replay/status, 64 KiB logical SQL state, fixed 30 minutes**, and no standing
interval timer. Reserve budget for platform retry/no-op invocations; count them in
receipts. Cloudflare automatically retries failed alarms up to six times, so a
strict provider billing-request ceiling cannot be guaranteed during platform
faults; fail closed, retain state and report any excess instead of claiming the
application counter is an account billing cap. [Alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/).

Current [SQLite DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
includes 100,000 requests/day and 13,000 GB-seconds/day on Free; Paid includes
1 million requests/month and 400,000 GB-seconds/month, with published overage
rates. A conservative **single-object, 30-minute continuously active** application
budget is about 230.4 GB-seconds (0.128 GB × 1,800 s), plus <=100 requests and small
SQL usage. This fits unused included capacity. At published marginal rates its
unrounded compute+request usage is under **$0.004**. This is not the worst-case
bill: the pricing page rounds excess usage to billable units. If included Paid
allocations were already exhausted, conservatively budgeting one additional unit
each for requests ($0.15), duration ($12.50), SQL reads ($0.001), SQL writes ($1),
and a GB-month of storage ($0.20) gives **under $15**, excluding unrelated usage
and the unchanged existing plan fee. This is a pricing illustration, not spend
authorization or a provider-enforced dollar cap. Enrollment should require unused
included capacity so the expected incremental charge is **$0**; otherwise return
for owner cost review. Namespace allocation/rounding and platform retries require
measured usage, not just payload accounting.

Avoid replacing this with minute-wide empty polling: planned enabled jobs query
PostgreSQL even without work. Neon Free currently supplies 100 CU-hours/project/month
and sleeps after five inactive minutes; continuous minute queries at 0.25 CU imply
about 180 CU-hours/30 days. [Neon pricing](https://neon.com/pricing),
[scale to zero](https://neon.com/docs/introduction/scale-to-zero). No current billing
or plan mutation is asserted.

This preparation wake does **not** complete all F07. Notification outboxes,
publication retries and token-warning deadlines need their own event-driven
arming at the existing authoritative producers, with the same commit/wake gap
proof and bounded due-time scheduling. Reuse those existing outboxes; do not
poll idle Neon or claim the task-only pilot validates notices, warnings, rotation,
release scheduling, full F07/F08 or production cutover.

## Implemented configuration and local validation

`HIVE_PROJECT_TASK_WAKE_ENABLED=false` preserves existing enqueue and status paths
without a namespace lookup. Enabling it requires the exact single public
`HIVE_PROJECT_TASK_WAKE_TASK_JSON` object containing `ownerId`, `projectId`, and
`taskId`, under the active native Preview. The app derives those values from the
authenticated owner, owned project, and deterministic task ID. The additional wake
contract applies only to that exact tuple. Other valid authorized task starts,
accepted replays, and exact-task status reads retain the existing path with zero
namespace lookups. An enabled invocation with missing context or invalid enrollment
continues to fail closed. Off/invalid or
revoked enrollment stops alarm work and retains a hold. Default configuration
contains the reviewed same-Worker class and SQLite migration, with no `script_name`.

The SQLite object retains one bounded row. Its original deadline is immutable on
reserve/replay. At 100 admitted application invocations, further work holds.
Refused calls and redundant platform alarm deliveries remain counted even after
the budget, so this counter does not promise an account billing ceiling. Terminal
alarms access retained local state and perform no PostgreSQL reconciliation.

The internal app adapter creates an independent request-local PrismaNeon lifetime,
with five-second connection/query/transaction limits. It cancels at the earlier
of the fixed reservation deadline and 45-second attempt deadline, then bounds
pool teardown to five seconds. The watchdog is stored before reconciliation.
An unknown outcome retains the existing 90-second PostgreSQL task lease.
Pilot preparation in the browser uses the same wake hold and lease guard.
After a running handoff, explicit browser status retains the existing metadata and
registration-repair path, including after the preparation deadline. The existing
PostgreSQL facts retain that handoff when a bound native thread is present and
all three encrypted prompt columns were erased by running completion. This also
covers registration loss before the alarm first observes running. The atomic
preparation-hold update preserves those retained facts. A pre-execution
check prevents that handoff path from carrying a first-prompt request. Current
owner, repository policy, registration, and PostgreSQL lease checks still apply.
Autonomous terminal alarms remain stopped. Untargeted reconciliation stays held
while pilot wakes are enabled, preserving the exact-task dispatch boundary. No public route authenticates
or forwards a Durable Object operation.

Local Workerd tests exercise actual SQLite alarms and restart persistence.
Composed tests use an isolated local PostgreSQL database, the unchanged PrismaNeon
driver, the production app adapter and exact-task reconciler. Provider/native
responses are fixed synthetic doubles. Delayed visibility and clock-boundary
fixtures exercise the corresponding holds. These checks do not establish live
provider acceptance, browser-closed native execution, notices, rotation, full F07
or production cutover.

## Exact agent-notification wake

`HIVE_AGENT_NOTIFICATION_WAKE_ENABLED=false` is the default. With no
`HIVE_AGENT_NOTIFICATION_WAKE_EVENT_JSON`, existing callbacks and dispatches perform
zero notification-DO lookups. An opt-in native Preview selects one exact
`{ownerId, sourceId, eventKey}` tuple and requires the existing notification ingress
and dispatch flags. The same-Worker `AgentNotificationWake` class uses SQLite.

The callback derives owner/source from the existing bearer credential before
reserving metadata. Reservation runs outside the revocable source transaction.
The transaction then locks and revalidates that exact source and current Coder
identity, preserves rate/backlog/digest checks, and checks the original deadline
before and after insertion. Failed reservation inserts nothing. A lost committed
acknowledgement replays the same event with the original reservation deadline.

One metadata-only SQLite row retains the fixed 30-minute deadline, 100-invocation
application boundary, 64-KiB logical state bound and 45-second attempt watchdog.
The alarm uses an independent bounded PostgreSQL request lifetime and the existing
exact-row push claim/settle adapter. Both exhausted-row updates and candidate
claims are filtered by owner and exact row ID. Five delivery attempts, PostgreSQL
lease fences, subscription preferences and stable source/event tags continue to
apply. Alarm and ordinary jobs dispatch propagate the original absolute wake deadline
through subscription/VAPID reads and fetch admission. The send timer uses the
earlier of that deadline and the existing 15-second budget. Fetch admission also
checks the absolute clock after signing, including when timer delivery is delayed.
Alarm delivery and external push are at least once. A fetch admitted before the
cutoff can have an unknown outcome after abort or disablement.

Keep the exact selector configured when disabling the wake flag. Inspection marks
that retained enrollment held, and all existing outbox consumers check it before
sending. A due event can fail through the existing claim/settle CAS. The immutable
PostgreSQL trigger prevents forcibly failing arbitrary pending rows, and a current
processing lease is preserved. Held and terminal alarms make zero idle database
queries. A late commit remains fenced even after the alarm stops. Remove the
selector only after the exact PostgreSQL event is terminal and all unknown producer
commits have been reconciled. Disabling the flag and removing the selector while
work is pending, leased or uncertain does not preserve that fence. Other valid
owners/events retain their existing path with zero pilot-object I/O.

Local checks cover SQLite eviction/restart, duplicate alarms, bounded holds,
source revocation between reservation and locking, post-insert deadline rollback,
unknown committed acknowledgements, exact-row exhaustion and claims, five attempts,
stable tags and retained disablement. The composed proof runs actual split
framework/custom-Worker bundles, SQLite alarms, PrismaNeon and PostgreSQL. It has
zero push subscriptions. A real alarm settles the event after the callback request
closes, and the actual jobs consumer respects a retained disabled enrollment.
This establishes local notification preparation and dispatch composition. Live
producer events, external push delivery, browser notification presentation and
included-usage acceptance remain separate gates. Rotation, warning deadlines,
template publication and release arming retain their existing limits.

# F07 native Preview durable wake — approval proposal

Status: design only, 2026-11-08. No code, bindings, namespaces, resources, secrets,
schedules or plan changes are authorized by this document. Repository
[architecture discipline](../../../AGENTS.md) requires owner agreement before
implementing this additional runtime dependency. Proposed target remains the
existing `hive` Worker, account `225177f82b9234ede14e897fe15e0cb5`, enrolled epic
Preview `codex/delivery-system-design`; production activation stays unchanged.

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

- New `deploy/cloudflare/native/project-task-wake.ts` class and focused tests;
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

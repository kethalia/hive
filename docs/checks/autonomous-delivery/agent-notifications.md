# Portable agent callback ingress and dispatch

Implementation checkpoint: server-only, default off. This covers ordinary Codex/Claude
terminal hook events (`question`, `approval`, `ready`, `failure`), distinct from delivery
reports and terminal-state **template publication** notices, which already have their
own implementations. Existing callback credential staging, overlap, generation and
revocation remain in `source-credentials.ts`; no host package, hook installer or user
configuration changes were included in the original ingress slice. The separate
[portable setup followup](agent-notification-installer.md) adds the fixed pinned installer
and corrects callback transport through the app Preview wrapper.

`POST /api/notifications/events` selects PostgreSQL admission when
`HIVE_RUNTIME_TARGET=cloudflare` and `HIVE_AGENT_NOTIFICATION_EVENTS_ENABLED=true`.
The Worker allowlist admits only that method/path when this separate flag is true.
The route independently enforces its flag and the existing source bearer format.
Source installation/reinstallation/deletion mutations require the separate default-off
portable setup capability documented in the followup; enabling ingress alone does not
enable source mutations.
The legacy Node path retains its Redis/BullMQ transport; those imports are evaluated
only after selecting that path.

The request body has a 4 KiB/4,096-chunk bound and a five-second read deadline.
The transaction hashes the bearer, locks the exact existing source and derives owner,
workspace and labels from that row. Both active and pending credential hashes work as
before. It requires the owner's current fixed Coder origin; callback-supplied owners,
workspaces and extra fields cannot select a target. Credentials, request exception text
and provider bodies never enter the durable event or response.

One transaction checks source/event identity, bounds that source's pending/processing
backlog to 600, admits at most 60 new events per database-clock minute, and commits
its immutable push payload and outbox identity. The per-source rate window occupies
one row and is overwritten each minute. Source locking serializes duplicate callbacks,
rate admission and revocation. Only committed acceptance returns 202. Identical event
replay returns the original accepted acknowledgment without consuming rate capacity;
changed content under the same source/event key returns 409. Unknown/revoked sources
return 401, rate/backlog bounds return 429 and transient database failures return 503
with fixed labels. A lost response can be retried using the same event identity.

Migration `20261105233000_agent_notification_events` adds source-owner composite
foreign keys, immutable event/payload fields and bounded state/rate checks. It does not
rewrite existing source credentials. Deleting a source deliberately cascades its accepted
callbacks and rate row, suppressing queued work; late credential confirmation cannot
recreate it. Accepted rows are deduplicated until bounded garbage collection removes
terminal rows at least 24 hours after admission, or the source is explicitly revoked.
This retention clock is admission time; it is not BullMQ's completion-age clock.
Pending work is never removed by age. Runtime table grants follow the existing
server-owned tenancy model; no new caller-controlled SQL/RLS identity is introduced.

The new agent queue reuses D06's extracted `claimDurablePush`/`settleDurablePush` SQL,
not a third claim/retry state machine. Only two fixed table identifiers are accepted;
all values remain parameters and complete SQL crosses the Prisma runtime boundary.
Claims use `SKIP LOCKED`, a 120-second lease and a monotonic attempt fence. There are
five total attempts and 30-second exponential retry backoff. Settlement locks the exact
row first, samples database time after lock acquisition and rechecks time after its
write before commit. Expiry during an UPDATE trigger rolls the transaction back.
D06's original task/event/report relationships and public API remain intact.

`HIVE_AGENT_NOTIFICATION_DISPATCH_ENABLED=true` enables at most one event per jobs
wake, with at most 20 subscriptions and 100 old terminal rows pruned. Before sending,
the dispatcher checks the still-existing source and current owner/Coder identity.
A source deletion during a send cannot acknowledge or resurrect the removed row.
A provider send already in flight cannot be undone by revocation; there is no
cross-provider transaction and push remains at least once. Stable source/event tags
collapse retries. Event preferences, labels, urgency and workspace/session deep links
match the legacy path, including hiding opaque clone IDs from human labels while
retaining them for routing. Missing subscriptions acknowledge without loading VAPID keys.

The shared bounded sender comes from the existing reviewed template-notice transport.
It propagates cancellation into fetch, filters the actual event-kind preference and
removes expired subscriptions only by exact owner/id/endpoint. The dispatcher aborts
a send at 15 seconds but drains its actual promise before acknowledging/closing the
database, including late subscription/VAPID reads and deletes. An opaque sender that
never settles keeps the invocation held rather than claiming cancellation completed.
The jobs Worker already bounds database requests; combined job/subrequest/cost budgets
still require review before enabling additional production dispatchers.

## Local evidence and limits

Fresh local PostgreSQL applies all 41 migrations. Focused cases cover committed
acceptance, concurrent replay/rate limits, atomic rollback, staged credentials,
revocation, backlog, concurrent claims, stale attempts, retry exhaustion, owner changes,
late sender/database work and an UPDATE that runs past lease expiry. Lease-expiry
controls use administrator access only in the dedicated local fixture; normal claim
and settlement calls run with the production integrity trigger enabled. Existing D06
PostgreSQL tests also pass after extracting the shared queue primitive.

[Actual Workerd evidence](agent-notifications-local/workerd.json) imports the migrated
Next POST route, full generated PrismaNeon client, actual jobs dispatcher and shared
sender through a fixed loopback-only PostgreSQL WebSocket bridge. The initial route-only proof verified 12
checks including replay, fixed owner/link binding, rate dedupe, conflict, acknowledgment
and revocation. The followup extends it through actual app composition and a real staged
pending credential to cover private Preview transport; see its current check map. The sender has **zero subscriptions**: this is real local composition,
not provider push delivery or browser notification acceptance. No remote binding or
provider operation is performed.

Reproduction uses the task-owned local database:

```sh
HIVE_AGENT_NOTIFICATION_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:55439/hive_agent_notification_test pnpm exec vitest run src/__tests__/push/agent-events.integration.test.ts src/__tests__/push/agent-events-route.test.ts src/__tests__/push/bounded-send.test.ts --no-file-parallelism
HIVE_AGENT_NOTIFICATION_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:55439/hive_agent_notification_test node deploy/cloudflare/jobs/run-local-agent-notifications.mjs
```

Remaining gates: populated upgrade/restricted-runtime rehearsal on the final release
schema, real browser foreground/background delivery, actual Codex/Claude hook events,
portable owner/build-bound installer, preview callback access under the existing preview
gate, Node worker drain and credential/origin migration, aggregate capacity and scheduler
ownership. The followup admits only the fixed, flag-gated callback transport through the Preview
wrapper, preserving source Authorization for the route's own verification. A source
bearer grants no browser/UI Preview access. Preview/production flags, database,
providers, schedules and resources are untouched by this source slice.

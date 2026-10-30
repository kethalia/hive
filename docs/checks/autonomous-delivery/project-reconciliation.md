# App-owned project intent reconciliation

The jobs Worker wakes the application through its private `APP_SERVICE` binding.
`POST /api/internal/project-tasks/reconcile` accepts only `{"schemaVersion":1}`,
with no owner, workspace, task, model or path selector. PostgreSQL selects at most
one existing intent. The app retains its credential encryption and issuer keys;
a project-only jobs wake needs neither those keys nor a database connection.

The transport requires both existing `HIVE_PROJECT_TASKS_ENABLED` gates and a
dedicated 64-character lowercase hexadecimal `HIVE_PROJECT_TASK_RECONCILE_SECRET`.
The credential cannot reuse the configured preview bearer or auth service secret.
The Worker, proxy and route independently authenticate it with a constant-time
comparison. Browser cookies and preview credentials cannot substitute. Origin,
Cookie, Sec-Fetch-Site, Upgrade, Next-Action, Content-Encoding, wrong method,
queries and oversized bodies reject before an intent claim. The maximum body is
512 bytes. NextRequest normalizes an empty trailing query away; the outer Worker
checks the raw Request first rather than claiming middleware can recover lost bytes.

The private request includes an authenticated `X-Hive-Reconcile-Deadline` in epoch
milliseconds. Missing, malformed, expired or more than 45 seconds in the future values
reject. Transit consumes this lifetime; it never renews it. The app combines its
own timer with the request signal and passes it through reconciliation, Coder
credentials/API requests, guardian enrollment and the fixed app-cookie exchange.
Public ticket issuers still use configured `HIVE_CODEX_HIVE_ORIGIN`, never the
synthetic internal service URL. The local provider checks this explicitly.

The jobs transport aborts at 60 seconds and awaits its fetch. A real workerd test
showed that aborting a caller's service-binding fetch does **not** cancel the
receiving app's request signal. Early disconnect therefore remains an unknown
accepted wake; it is not revocation, cancellation evidence or process quiescence.
The first failed propagation assertion is preserved in
`project-reconciliation-binding-abort-first.json` and its matching log. The final
proof explicitly observes the already-authorized late effect and its durable
same-intent acknowledgement. A separate shortened authenticated app deadline
arrives during the simulated provider POST and actually aborts Coder transport; the original queued
claim remains leased for later fenced recovery. The provider double checks its request signal before recording its effect counter; this does not prove a real host rolls back an already accepted command. No new prompt identity is minted.

After cancellation, no next intent is claimed and no fresh finish/fail write is
scheduled. An already-running database operation must settle before cleanup.
Optional request bounds configure 10-second connection/query/transaction limits
and PostgreSQL `statement_timeout`; the latter defaults to the client query bound.
An optional tighter server bound cannot exceed the client bound. This proof uses
a 100 ms server limit and 1000 ms driver limit to observe actual PostgreSQL `57014`
without a race between equal client/server timers. Disconnect is awaited; a client
timeout alone is not proof that every remote effect stopped.

The private app adapter buffers only 512 bytes of aggregate JSON, awaits framework
tasks and disconnects the database **before** returning. It does not depend on an
aborted caller consuming a late response stream. The previous generic streaming
lifetime left one socket open in the actual aborted-caller test; its failed log is
preserved as `project-reconciliation-pool-cleanup-first.txt`. The final proof
observes zero Worker database sockets before disposing the runtime. General page
streaming behavior is unchanged.

## Local proof

```sh
node --no-experimental-strip-types --import tsx \
  deploy/cloudflare/jobs/run-local-project-tasks.mjs
```

This uses the pinned Miniflare/workerd runtime, actual private service bindings,
the generated Worker Prisma client, real encrypted intents in a new uniquely named
local PostgreSQL database, actual Ed25519 host requests and the actual scoped app
cookie helper. Coder/workspace responses are local doubles. The server deadline is
accelerated only by the fixture's authenticated header; product limits are fixed.
The exact source hashes and sanitized timeout metadata are in
`project-reconciliation-local.json`. Scratch directories, databases and earlier
failed harness logs remain available for review. The runner formats new evidence
on write and rejects source changes during the proof.

This checkpoint does not run the full generated Next handler: it calls the same
private lifetime and actual route under workerd. Proxy/route/transport checks have
separate focused tests. A later assembled app proof must exercise framework routing
and the existing remote Neon pooler's startup-parameter compatibility. No remote
database, real workspace, provider mutation, cron, public activation or resource
change occurs here. Deployment credentials and activation remain separate gates.

Focused validation passed 79 tests across 11 files; full TypeScript validation passed. The final fixture snapshots exactly 29 migrations through `20261029180000_template_publication_notices`, verifies every applied checksum, and excludes the unreviewed `190000` repository-policy draft.

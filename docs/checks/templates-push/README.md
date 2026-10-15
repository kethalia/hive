# Template list and push progress validation

The template list now separates descriptions from the metadata columns, provides
one confirmed **Push all** action, and scrolls within the bounded dashboard.
Individual pushes and per-template success/failure reporting remain available.
The existing server worker limits execution to two template pushes at a time.

Validation uses the real React components, production Tailwind styles, and xterm
progress panels in a standalone fixture. Requests and SSE output are mocked;
no live template versions are created or activated.

The reused `creator-direction-upgrade` Browser Testing workspace ran installed
Chrome at desktop (1440×900), tablet touch (900×800), and phone touch (390×844)
viewports. The checks cover batch confirmation/cancellation, five independent
push requests including one rejected request, page-width containment, scrolling
past multiple panels, scrolling over output already at its bottom, and reaching
and closing the final panel. Touch checks also cover returning up the list
without pull-to-refresh stealing the gesture. This is Chrome touch emulation;
physical-device Safari acceptance is separate.

`report.json` records the assertions; the PNGs show the list and the bottom of
the progress stack at each viewport. The browser process is closed by the
runner. The reused workspace is retained because it serves another active task.

Build fixture assets in Software:

```sh
node e2e/templates-push-regressions.mjs --build-only /tmp/hive-templates-push/assets
```

Transfer the assets and runner to Browser Testing, where Chrome and either
`playwright-core` or `@playwright/test` are available, then run:

```sh
node e2e/templates-push-regressions.mjs /tmp/hive-templates-push/assets /tmp/hive-templates-push/evidence
```

After preserving a new report in the repository, normalize it with
`pnpm exec biome format --write docs/checks/templates-push/report.json`.

Component regression coverage includes independent batch outcomes, stream
cleanup, empty-list disabling, individual pushes, and nested scroll-container
handling by pull-to-refresh:

```sh
pnpm exec vitest run src/__tests__/components/templates-list-mobile.test.tsx src/__tests__/components/template-detail.test.tsx src/__tests__/components/pull-to-refresh.test.tsx
```

Review follow-up: the SSE route now keeps queued and active jobs pending using
BullMQ state and sends heartbeat comments while waiting. It no longer treats
30 seconds without a local log, or 120 seconds of execution, as push failure.
Terminal queue states supply the result when a worker-local log is unavailable.
The route verifies the job belongs to the session user and requested template
before reading logs. Route regressions simulate a 65-second queue wait, active
execution beyond 120 seconds, terminal states without logs, transient queue
lookup errors, ownership checks, and cancellation that stops polling.

```sh
pnpm exec vitest run src/__tests__/app/api/templates/push-routes.test.ts src/__tests__/lib/templates/push-queue.test.ts
```

Client review follow-up: both template screens reconnect the same stream with
backoff while keeping push controls disabled, and suppress replayed log lines.
Only terminal status events complete a push. The browser fixture now includes
an initial HTTP 503 for one stream and a midstream disconnect for another;
both recover without creating another push request at all three viewports.
Batch completion waits for all active pushes, then requests one status scan.
Manual and periodic refreshes share an in-flight request; a completion scan
waits for older work so an earlier snapshot cannot overwrite newer results.
Periodic scans are deferred during active pushes.

```sh
pnpm exec vitest run src/__tests__/lib/templates/push-stream.test.ts src/__tests__/components/templates-list-mobile.test.tsx
```

Log-drain review follow-up: after a queue job reaches completed/failed, a
readable local log gets up to two seconds to flush its final lines and exit
sentinel before queue state closes the stream. An arriving sentinel completes
the stream immediately. Missing or unreadable logs still use queue state
without a drain delay. Route regressions cover both successful and failed jobs
whose final diagnostics arrive after queue completion, a readable log with no
sentinel, and an unreadable log.

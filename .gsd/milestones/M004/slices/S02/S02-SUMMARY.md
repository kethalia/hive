---
id: S02
parent: M004
milestone: M004
provides:
  - ["templatePushQueue — BullMQ queue for enqueuing template push jobs", "POST /api/templates/[name]/push — trigger a template push and get a jobId", "GET /api/templates/[name]/push/[jobId]/stream — SSE stream of push job output"]
requires:
  []
affects:
  []
key_files:
  - ["src/lib/templates/push-queue.ts", "src/app/api/templates/[name]/push/route.ts", "src/app/api/templates/[name]/push/[jobId]/stream/route.ts", "src/lib/queue/index.ts"]
key_decisions:
  - ["Log-file-based SSE streaming decouples stream consumers from BullMQ, supports multiple clients and reconnection", "Exit sentinel protocol ([exit:0]/[exit:1]) provides a simple, grep-friendly job completion signal"]
patterns_established:
  - ["Log-file-based SSE streaming: decouple SSE consumers from BullMQ by tailing a log file, enabling multiple clients and reconnection resilience", "Exit sentinel protocol: [exit:0]/[exit:1] lines in log files signal job completion to stream readers", "Template name validation against KNOWN_TEMPLATES from staleness module ensures consistency across S01 and S02"]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-13T23:13:42.850Z
blocker_discovered: false
---

# S02: Push Job Worker & SSE Streaming Route

**BullMQ push queue/worker spawns coder templates push as a child process, tees output to log files; POST and SSE API routes trigger and stream push jobs in real time.**

## What Happened

All three tasks were completed successfully. The source implementation (push-queue module and API routes) was already in place from a prior session; the executor tasks focused on creating comprehensive test coverage and verifying correctness.

**T01 — Template push queue, worker, and job processor:** Created `src/__tests__/lib/templates/push-queue.test.ts` with 8 tests covering the BullMQ queue/worker in `src/lib/templates/push-queue.ts`. The module resolves the coder CLI binary via `which`, spawns `coder templates push <name> --directory templates/<name> --yes` as a child process, injects `CODER_URL` and `CODER_SESSION_TOKEN` into the child env, tees stdout+stderr to `/tmp/template-push-<jobId>.log`, and writes `[exit:0]` or `[exit:1]` sentinels on completion. The worker is re-exported from `src/lib/queue/index.ts`.

**T02 — POST and SSE stream routes:** Created `src/__tests__/app/api/templates/push-routes.test.ts` with 9 tests covering both API routes. The POST route (`src/app/api/templates/[name]/push/route.ts`) validates template name against KNOWN_TEMPLATES, generates a UUID jobId, enqueues to BullMQ, and returns `{ jobId }`. The SSE route (`src/app/api/templates/[name]/push/[jobId]/stream/route.ts`) waits up to 30s for the log file to appear, then polls with byte-offset reads, emitting lines as SSE data events and detecting exit sentinels to emit a named "status" event before closing.

**T03 — Test verification:** Confirmed all 17 tests across both test files pass, plus verified no regressions in the full suite (312 tests across 41 files).

## Key Design Choices

- **Log-file-based SSE streaming:** The SSE route tails a log file on disk rather than connecting directly to the BullMQ job. This decouples the stream consumer from BullMQ, allows multiple clients to stream the same job, and survives SSE reconnection since the log file persists.
- **Exit sentinel protocol:** `[exit:0]` and `[exit:1]` lines in the log file signal job completion to the SSE stream reader. This is a simple, grep-friendly protocol that works with both programmatic and manual log inspection.
- **Template name validation:** Both routes validate against KNOWN_TEMPLATES from the staleness module, ensuring consistency with S01's template inventory.

## Verification

All slice verification checks pass:

1. `npx vitest run src/__tests__/lib/templates/push-queue.test.ts` — 8 tests pass (queue creation, worker creation, spawn args/env, log tee, exit sentinels, spawn error handling)
2. `npx vitest run src/__tests__/app/api/templates/` — 9 tests pass (POST validation, enqueueing, error handling, SSE headers, log streaming, exit sentinel detection)
3. Full suite: `npx vitest run` — 312 tests pass across 41 files, no regressions

## Requirements Advanced

None.

## Requirements Validated

None.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

None.

## Known Limitations

Pre-existing ioredis dual-install type mismatch requires @ts-ignore on BullMQ Queue/Worker constructors (same pattern as council-queues.ts, tracked in D003).

## Follow-ups

None.

## Files Created/Modified

- `src/lib/templates/push-queue.ts` — BullMQ queue, worker, and coder CLI child process spawner with log tee and exit sentinels
- `src/app/api/templates/[name]/push/route.ts` — POST route: validates template name, enqueues push job, returns jobId
- `src/app/api/templates/[name]/push/[jobId]/stream/route.ts` — GET SSE route: tails log file, emits lines as SSE events, detects exit sentinels
- `src/lib/queue/index.ts` — Re-exports template push queue and worker alongside existing workers
- `src/__tests__/lib/templates/push-queue.test.ts` — 8 unit tests for push queue processor
- `src/__tests__/app/api/templates/push-routes.test.ts` — 9 unit tests for POST and SSE stream routes

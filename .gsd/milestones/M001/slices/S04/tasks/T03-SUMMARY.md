---
id: T03
parent: S04
milestone: M001
provides:
  - 8-step worker pipeline (hydrate → rules → tools → agent → lint → commit-push → ci → pr)
  - cleanupWorkspace function (stop + delete + DB update with grace period)
  - prUrl and branch persistence on successful task completion
key_files:
  - src/lib/workspace/cleanup.ts
  - src/lib/queue/task-queue.ts
  - src/__tests__/lib/workspace/cleanup.test.ts
  - src/__tests__/lib/queue/worker.test.ts
key_decisions:
  - cleanupWorkspace is fire-and-forget in the finally block (not awaited) to avoid blocking job completion on slow workspace teardown
patterns_established:
  - Cleanup runs in finally block so it executes on both success and error paths; errors are swallowed with a log
observability_surfaces:
  - "[cleanup] workspace=<id>" log prefix for workspace stop/delete lifecycle
  - tasks.prUrl and tasks.branch populated on success for inspection
  - workspaces.status set to "deleted" after cleanup
duration: 12 minutes
verification_result: passed
completed_at: 2026-03-19
blocker_discovered: false
---

# T03: Wire extended pipeline into worker and add workspace cleanup

**Wired 8-step blueprint pipeline into worker, added workspace cleanup in finally block, and persisted prUrl/branch to task record**

## What Happened

Connected the four new blueprint steps (lint, commit-push, CI feedback, PR creation) from T01/T02 into the worker pipeline in `task-queue.ts`. The step array now runs all 8 steps in order: hydrate → rules → tools → agent → lint → commit-push → ci → pr.

Created `cleanupWorkspace()` in `src/lib/workspace/cleanup.ts` — waits a configurable grace period (env `CLEANUP_GRACE_MS`, default 60s), then stops and deletes the Coder workspace, updating the DB record to `deleted`. Errors are caught and logged, never propagated.

The CI step receives its injected dependencies (`createAgentStep`, `createLintStep`, `createCommitPushStep`) for its retry cycle. On success, the worker persists `ctx.prUrl` and `ctx.branchName` to the task record. Cleanup runs in a `finally` block so it fires on both success and failure paths.

Increased `JOB_TIMEOUT_MS` from 35 to 90 minutes to accommodate CI polling + agent retry rounds.

## Verification

- `npx vitest run src/__tests__/lib/workspace/cleanup.test.ts` — 3 tests pass (stop→delete→DB order, error swallowing, grace period delay)
- `npx vitest run src/__tests__/lib/queue/worker.test.ts` — 9 tests pass (8-step pipeline, prUrl/branch persistence, CI dep injection, cleanup on success/failure/exception, no cleanup when workspace not created)
- `npx vitest run` — 78 tests pass across 16 files, zero regressions

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/workspace/cleanup.test.ts` | 0 | ✅ pass | 3.8s |
| 2 | `npx vitest run src/__tests__/lib/queue/worker.test.ts` | 0 | ✅ pass | 3.8s |
| 3 | `npx vitest run src/__tests__/lib/blueprint/steps/lint.test.ts` | 0 | ✅ pass | ~0.2s |
| 4 | `npx vitest run src/__tests__/lib/blueprint/steps/commit-push.test.ts` | 0 | ✅ pass | ~0.2s |
| 5 | `npx vitest run src/__tests__/lib/blueprint/steps/pr.test.ts` | 0 | ✅ pass | ~0.2s |
| 6 | `npx vitest run src/__tests__/lib/blueprint/steps/ci.test.ts` | 0 | ✅ pass | ~0.2s |
| 7 | `npx vitest run` | 0 | ✅ pass | 3.9s |

## Diagnostics

- Grep for `[cleanup]` in container logs to trace workspace teardown
- Check `workspaces.status` in DB — should be `deleted` after cleanup
- Check `tasks.prUrl` and `tasks.branch` for PR link and branch name
- Cleanup errors are logged to stderr with `[cleanup]` prefix but never fail the task

## Deviations

- `cleanupWorkspace` is called without `await` in the finally block (fire-and-forget) — the plan said "call" but didn't specify awaiting. Since cleanup can take 60+ seconds and shouldn't block job completion or error re-throw, fire-and-forget is the right call.

## Known Issues

None.

## Files Created/Modified

- `src/lib/workspace/cleanup.ts` — new workspace cleanup function (stop + delete + DB update with grace period)
- `src/__tests__/lib/workspace/cleanup.test.ts` — 3 tests for cleanup (order, error swallowing, grace period)
- `src/lib/queue/task-queue.ts` — extended with 8-step pipeline, prUrl/branch persistence, cleanup in finally, 90-min timeout
- `src/__tests__/lib/queue/worker.test.ts` — expanded from 5 to 9 tests covering extended pipeline, cleanup on all paths

---
id: T02
parent: S07
milestone: M001
provides:
  - listWorkspaces method on CoderClient for querying Coder workspace API
  - Periodic cleanup scheduler as safety net for leaked workspaces
  - Benchmark documentation for cold-start vs warm-start measurement
key_files:
  - src/lib/coder/client.ts
  - src/lib/coder/types.ts
  - src/lib/workspace/scheduler.ts
  - src/__tests__/lib/coder/client.test.ts
  - src/__tests__/lib/workspace/scheduler.test.ts
  - docs/workspace-benchmarks.md
key_decisions:
  - Scheduler runs immediate sweep on start plus periodic interval (no delay before first check)
  - Grace period checked via Prisma query (task.updatedAt < cutoff) rather than in-process timer
  - cleanupWorkspace called with graceMs=0 since grace already enforced by query filter
patterns_established:
  - Scheduler pattern with startCleanupScheduler returning { stop } handle for graceful shutdown
  - Prisma relational query filter for task status + time-based cleanup eligibility
observability_surfaces:
  - "[cleanup-scheduler]" prefixed console logs for sweep start, per-workspace errors, and sweep completion with counts
duration: 20m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T02: Build cleanup scheduler with listWorkspaces and benchmark docs

**Added listWorkspaces to CoderClient, created periodic cleanup scheduler for stale workspace garbage collection, and wrote cold-start benchmark documentation**

## What Happened

Implemented three deliverables:

1. **listWorkspaces on CoderClient**: Added `ListWorkspacesResponse` type to `types.ts` and `listWorkspaces(options?)` method to `client.ts`. The method accepts optional `owner` and `status` filters, encoding them into Coder's `q` query parameter. Added 3 tests covering no-filter, combined filters, and single-filter cases (11 total client tests now).

2. **Cleanup scheduler**: Created `src/lib/workspace/scheduler.ts` with `startCleanupScheduler(coderClient, db, options?)`. Each sweep queries Prisma for workspaces where `status != 'deleted'`, `coderWorkspaceId` is set, and the associated task is terminal (`done`/`failed`) with `updatedAt` past the grace period. For each match, calls `cleanupWorkspace` with grace=0. All errors are caught and logged — never thrown. Returns `{ stop }` handle that clears the interval. Wrote 6 tests covering: stale workspace cleanup, skip-running filter verification, skip-deleted filter verification, error resilience, stop() halting sweeps, and periodic execution.

3. **Benchmark docs**: Created `docs/workspace-benchmarks.md` with measurement instructions for cold-start and warm-start using `time coder create`, expected time ranges, pool size configuration guide, and Coder Premium requirement note.

## Verification

- `npx vitest run src/__tests__/lib/coder/client.test.ts` — 11 tests passed
- `npx vitest run src/__tests__/lib/workspace/scheduler.test.ts` — 6 tests passed
- `npx vitest run` — 148 tests across 25 files, all passed, zero regressions
- `test -f docs/workspace-benchmarks.md` — exists
- Terraform validate passes for both templates (T01 checks still green)
- `grep -q "ignore_changes"` passes for both templates

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cd templates/hive-worker && terraform init -backend=false && terraform validate` | 0 | ✅ pass | ~8s |
| 2 | `cd templates/hive-verifier && terraform init -backend=false && terraform validate` | 0 | ✅ pass | ~5s |
| 3 | `grep -q "coder_workspace_preset" templates/hive-worker/main.tf` | 0 | ✅ pass | <1s |
| 4 | `grep -q "coder_workspace_preset" templates/hive-verifier/main.tf` | 0 | ✅ pass | <1s |
| 5 | `npx vitest run src/__tests__/lib/coder/client.test.ts` | 0 | ✅ pass | 2.3s |
| 6 | `npx vitest run src/__tests__/lib/workspace/scheduler.test.ts` | 0 | ✅ pass | 2.3s |
| 7 | `npx vitest run` | 0 | ✅ pass | 1.8s |
| 8 | `test -f docs/workspace-benchmarks.md` | 0 | ✅ pass | <1s |
| 9 | `grep -q "ignore_changes" templates/hive-worker/main.tf && grep -q "ignore_changes" templates/hive-verifier/main.tf` | 0 | ✅ pass | <1s |

## Diagnostics

- **Scheduler logs**: Look for `[cleanup-scheduler]` prefix in container stdout. Each sweep logs count of stale workspaces found and cleaned/total ratio.
- **Per-workspace errors**: Individual cleanup failures logged with `[cleanup-scheduler] failed to clean workspace=<id>` — non-fatal to the sweep cycle.
- **Sweep errors**: Database query failures logged with `[cleanup-scheduler] sweep error:` — the scheduler continues running on next interval.
- **Integration note**: The scheduler must be imported and started in the main server entrypoint (deferred to integration task).

## Deviations

None.

## Known Issues

- The scheduler needs to be wired into the application entrypoint (`startCleanupScheduler` must be called with real CoderClient and PrismaClient instances). This is noted in the slice plan's Integration Closure section as deferred to integration.

## Files Created/Modified

- `src/lib/coder/types.ts` — Added `ListWorkspacesResponse` interface
- `src/lib/coder/client.ts` — Added `listWorkspaces` method with owner/status query filters
- `src/lib/workspace/scheduler.ts` — New cleanup scheduler with `startCleanupScheduler` and internal `sweep` function
- `src/__tests__/lib/coder/client.test.ts` — Added 3 listWorkspaces tests (no filters, combined filters, single filter)
- `src/__tests__/lib/workspace/scheduler.test.ts` — New test file with 6 tests covering all scheduler behaviors
- `docs/workspace-benchmarks.md` — Benchmark documentation with measurement instructions and expected time ranges

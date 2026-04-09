---
id: T03
parent: S05
milestone: M001
provides:
  - Verifier wired into worker pipeline — triggers automatically after successful PR
  - verificationReport JSON column on Task model for persistent storage
  - getVerificationReport(taskId) API function
  - Task status transition running → verifying → done on success path
key_files:
  - prisma/schema.prisma
  - src/lib/api/tasks.ts
  - src/lib/queue/task-queue.ts
  - src/__tests__/lib/queue/worker.test.ts
key_decisions:
  - Verifier failure is informational — task still set to done with inconclusive report (PR exists regardless)
  - Task transitions to verifying before verifier workspace creation, then to done after report persistence
patterns_established:
  - Dual-workspace lifecycle pattern: worker + verifier workspaces tracked independently, both cleaned up in finally block
observability_surfaces:
  - "[queue] Starting verifier for task ${taskId}" log when verifier triggers
  - tasks.status = 'verifying' during verification phase
  - tasks.verificationReport JSON column stores structured report
  - getVerificationReport(taskId) API retrieval function
  - verificationReport.outcome = "inconclusive" on verifier failure
duration: 12m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T03: Wire verifier into orchestration pipeline with DB persistence

**Integrated verifier into task-queue worker with DB persistence: auto-triggers after PR, transitions through verifying status, and stores structured verification report.**

## What Happened

Added `verificationReport Json?` column to the Prisma Task model, then added `getVerificationReport(taskId)` to the API layer. Extended the worker pipeline in `task-queue.ts` to trigger the verifier blueprint after a successful worker blueprint that produces a PR: creates a verifier workspace, runs the 4-step verifier blueprint, and persists the structured report. Verifier failure is handled gracefully — the task still transitions to `done` with an inconclusive report. Both worker and verifier workspaces are cleaned up in the finally block. Added 4 new integration tests covering the verifier trigger, no-trigger on failure, verifier failure graceful handling, and dual-workspace cleanup.

## Verification

- `npx prisma validate` — schema validates with new verificationReport column
- `npx vitest run src/__tests__/lib/queue/worker.test.ts` — 12 tests pass (8 existing + 4 new)
- `npx vitest run` — 100 tests pass across 20 files, zero regressions

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx prisma validate` | 0 | ✅ pass | 49.8s |
| 2 | `npx vitest run src/__tests__/lib/queue/worker.test.ts` | 0 | ✅ pass | 2.5s |
| 3 | `npx vitest run src/__tests__/lib/blueprint/steps/verify-clone.test.ts` | 0 | ✅ pass | <1s |
| 4 | `npx vitest run src/__tests__/lib/blueprint/steps/verify-detect.test.ts` | 0 | ✅ pass | <1s |
| 5 | `npx vitest run src/__tests__/lib/blueprint/steps/verify-execute.test.ts` | 0 | ✅ pass | <1s |
| 6 | `npx vitest run src/__tests__/lib/blueprint/steps/verify-report.test.ts` | 0 | ✅ pass | <1s |
| 7 | `test -d templates/hive-verifier && test -f templates/hive-verifier/main.tf` | 0 | ✅ pass | <1s |
| 8 | `npx vitest run` | 0 | ✅ pass | 2.8s |

## Diagnostics

- Query `tasks.verificationReport` for structured verification outcome on any task
- Check `tasks.status = 'verifying'` to find tasks currently in verification phase
- Grep container logs for `[queue] Starting verifier` to trace verifier triggers
- `getVerificationReport(taskId)` returns parsed JSON report or null
- Verifier workspace cleanup logged with `[cleanup]` prefix

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `prisma/schema.prisma` — Added `verificationReport Json?` column to Task model
- `src/lib/api/tasks.ts` — Added `getVerificationReport(taskId)` API function
- `src/lib/queue/task-queue.ts` — Extended worker with verifier trigger, dual-workspace lifecycle, report persistence
- `src/__tests__/lib/queue/worker.test.ts` — Added 4 verifier integration tests (trigger, no-trigger, failure handling, dual cleanup)

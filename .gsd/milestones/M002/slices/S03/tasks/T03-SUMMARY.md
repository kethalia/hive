---
id: T03
parent: S03
milestone: M002
key_files:
  - src/lib/queue/task-queue.ts
  - src/lib/queue/council-queues.ts
  - src/__tests__/lib/queue/council-step.test.ts
  - src/__tests__/lib/queue/council-queues.test.ts
  - src/__tests__/lib/queue/worker.test.ts
key_decisions:
  - QueueEvents connection uses `as any` cast — consistent with all other getRedisConnection() usages in the codebase (pre-existing ioredis/bullmq version type conflict)
  - Fixed worker.test.ts TS2556 spread error to stay within ≤23 TS error budget
  - council-queues.test.ts updated with processor mocks required because council-queues.ts now imports them at module load time
duration: 
verification_result: passed
completed_at: 2026-04-09T09:42:13.281Z
blocker_discovered: false
---

# T03: Wired council step (step 13) into task-queue.ts, updated worker factories to use real processors, and verified all 250 tests pass with TS error count at ≤23 threshold

**Wired council step (step 13) into task-queue.ts, updated worker factories to use real processors, and verified all 250 tests pass with TS error count at ≤23 threshold**

## What Happened

Added council step to task-queue.ts after the verifier block: reads councilSize, guards on prUrl/template/size, fans out N reviewer children + 1 aggregator parent via FlowProducer, awaits aggregator via QueueEvents (closed in finally), all wrapped in try/catch per D015. Updated council-queues.ts worker factories to use real createCouncilReviewerProcessor/createCouncilAggregatorProcessor implementations. Created 10-test council-step.test.ts covering happy path, no-op guards, and failure tolerance. Fixed council-queues.test.ts for new coderClient param. Fixed worker.test.ts TS2556 spread error to hit exactly 23 TS errors.

## Verification

Ran npx vitest run (250 tests, 36 files, all pass) and npx tsc --noEmit | grep -c error TS | xargs test -le 23 (exit 0). Verification command from task plan exited 0 (VERIFICATION PASSED).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/queue/council-step.test.ts` | 0 | ✅ pass | 188ms |
| 2 | `npx vitest run (all 250 tests, 36 files)` | 0 | ✅ pass | 1590ms |
| 3 | `npx tsc --noEmit | grep -c 'error TS' | xargs test -le 23` | 0 | ✅ pass | 2500ms |

## Deviations

Fixed worker.test.ts TS2556 and added processor mocks to council-queues.test.ts — both required for correctness but not explicitly in the T03 plan steps.

## Known Issues

None.

## Files Created/Modified

- `src/lib/queue/task-queue.ts`
- `src/lib/queue/council-queues.ts`
- `src/__tests__/lib/queue/council-step.test.ts`
- `src/__tests__/lib/queue/council-queues.test.ts`
- `src/__tests__/lib/queue/worker.test.ts`

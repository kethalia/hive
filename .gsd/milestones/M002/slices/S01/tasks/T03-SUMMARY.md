---
id: T03
parent: S01
milestone: M002
key_files:
  - src/__tests__/lib/queue/council-queues.test.ts
key_decisions:
  - Singleton tests assert identity (first === second) rather than Queue.toHaveBeenCalledTimes(1), because module-level singletons survive vi.clearAllMocks() — call-count assertions would give false negatives after the first initialising test.
duration: 
verification_result: passed
completed_at: 2026-04-09T08:25:45.185Z
blocker_discovered: false
---

# T03: Added 8 unit tests for council queue singletons, FlowProducer factory, and worker factories — 161 total tests pass with zero regressions

**Added 8 unit tests for council queue singletons, FlowProducer factory, and worker factories — 161 total tests pass with zero regressions**

## What Happened

Created src/__tests__/lib/queue/council-queues.test.ts following the exact mock pattern from worker.test.ts. Mocked ioredis, @/lib/queue/connection, and bullmq (Queue, Worker, FlowProducer). Tests cover all three singletons (reviewer queue, aggregator queue, FlowProducer) with both construction assertions and identity-based singleton checks, plus both worker factories. Singleton tests use first===second identity rather than call-count guards because module-level singletons persist across vi.clearAllMocks() in the same vitest worker.

## Verification

Ran npx vitest run src/__tests__/lib/queue/council-queues.test.ts (8/8 pass), then npx vitest run (161/161 pass across 26 test files, zero regressions).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/queue/council-queues.test.ts` | 0 | ✅ pass | 154ms |
| 2 | `npx vitest run` | 0 | ✅ pass | 1260ms |

## Deviations

Singleton tests use identity assertion (first === second) rather than call-count approach; necessary due to module state surviving vi.clearAllMocks().

## Known Issues

None.

## Files Created/Modified

- `src/__tests__/lib/queue/council-queues.test.ts`

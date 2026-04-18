---
id: T03
parent: S02
milestone: M010
key_files:
  - src/lib/api/tasks.ts
  - src/lib/queue/task-queue.ts
  - src/lib/queue/council-queues.ts
  - src/lib/council/dispatch.ts
  - src/lib/council/reviewer-processor.ts
  - src/lib/actions/tasks.ts
key_decisions:
  - Switched createTaskAction from actionClient to authActionClient — ensures userId is always available from the authenticated session, no need for client to pass it explicitly
  - Jobs with missing userId fail immediately before any Coder API call — prevents silent failures on legacy jobs without credentials
duration: 
verification_result: passed
completed_at: 2026-04-18T20:26:04.562Z
blocker_discovered: false
---

# T03: Rewire BullMQ task and council workers to resolve per-user Coder credentials per-job via getCoderClientForUser

**Rewire BullMQ task and council workers to resolve per-user Coder credentials per-job via getCoderClientForUser**

## What Happened

Rewired the entire job processing chain to use per-user credentials instead of a shared injected CoderClient:

1. **createTask** (`src/lib/api/tasks.ts`): Added required `userId` parameter, stored on Task record and included in `TaskJobData`.

2. **Task worker** (`src/lib/queue/task-queue.ts`): Changed `createTaskWorker(coderClient)` to `createTaskWorker()` (no param). Worker now resolves credentials per-job via `getCoderClientForUser(job.data.userId)` before processing. Jobs with no userId fail immediately with a clear error message. Removed `CoderClient` import, added `getCoderClientForUser` import.

3. **Council dispatch** (`src/lib/council/dispatch.ts`): Added `userId` to `CouncilDispatchParams` interface. Task worker passes `userId` through to dispatch, which propagates it into each `CouncilReviewerJobData`.

4. **Council reviewer** (`src/lib/queue/council-queues.ts` + `src/lib/council/reviewer-processor.ts`): Added `userId` to `CouncilReviewerJobData`. Changed `createCouncilReviewerWorker(coderClient)` to `createCouncilReviewerWorker()`. Processor resolves credentials per-job via `getCoderClientForUser(userId)`.

5. **Task action** (`src/lib/actions/tasks.ts`): Switched `createTaskAction` from `actionClient` to `authActionClient` so it gets the authenticated user's session, passes `ctx.user.id` as userId.

6. **Tests**: Updated all 39 tests across 5 test files to use the new signatures — mock `getCoderClientForUser` instead of passing a client, add `userId` to all `TaskJobData` and `createTask` calls.

## Verification

1. Ran `pnpm vitest run src/__tests__/lib/queue/ src/__tests__/lib/api/tasks.test.ts src/__tests__/app/tasks/tasks-pages.test.ts` — all 39 tests pass across 5 files.
2. Ran `rg 'CODER_SESSION_TOKEN|CODER_URL' src/lib/queue/ src/lib/api/tasks.ts src/lib/council/dispatch.ts | grep -v test; test $? -eq 1` �� no env var references found, confirming clean removal.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/lib/queue/ src/__tests__/lib/api/tasks.test.ts src/__tests__/app/tasks/tasks-pages.test.ts` | 0 | ✅ pass | 391ms |
| 2 | `rg 'CODER_SESSION_TOKEN|CODER_URL' src/lib/queue/ src/lib/api/tasks.ts src/lib/council/dispatch.ts | grep -v test; test $? -eq 1` | 0 | ✅ pass | 50ms |

## Deviations

none

## Known Issues

none

## Files Created/Modified

- `src/lib/api/tasks.ts`
- `src/lib/queue/task-queue.ts`
- `src/lib/queue/council-queues.ts`
- `src/lib/council/dispatch.ts`
- `src/lib/council/reviewer-processor.ts`
- `src/lib/actions/tasks.ts`

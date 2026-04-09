---
estimated_steps: 5
estimated_files: 4
---

# T03: Wire extended pipeline into worker and add workspace cleanup

**Slice:** S04 — CI Feedback Loop & PR Generation
**Milestone:** M001

## Description

Connect the four new blueprint steps (lint, commit-push, CI feedback, PR creation) into the worker pipeline in `task-queue.ts`, add workspace cleanup, and persist prUrl/branch to the Task record. Without this task, the T01/T02 steps are dead code.

**Key knowledge from prior slices:**
- The worker in `task-queue.ts` builds a `BlueprintContext`, creates a step array, calls `runBlueprint(steps, ctx)`, then updates task status based on `result.success`
- The runner calls steps sequentially — adding new steps to the array is all that's needed
- `CoderClient` already has `stopWorkspace(id)` and `deleteWorkspace(id)` methods
- The Prisma schema has `tasks.prUrl` and `tasks.branch` fields ready to populate
- `Workspace` model has `status` field with `stopped` and `deleted` enum values
- Current JOB_TIMEOUT_MS is 35 minutes — must increase to ~90 minutes for CI polling + agent retry
- Worker tests mock `runBlueprint` and step factories — same pattern continues
- Mock `@/lib/queue/connection` module boundary, not ioredis directly (KNOWLEDGE.md)

## Steps

1. **Create `src/lib/workspace/cleanup.ts`** — `cleanupWorkspace(coderClient, workspaceId, graceMs, db)`:
   - Wait `graceMs` milliseconds (default from env `CLEANUP_GRACE_MS` or 60000)
   - Call `coderClient.stopWorkspace(workspaceId)`
   - Call `coderClient.deleteWorkspace(workspaceId)`
   - Update workspace record: `status: "deleted"`
   - Log `[cleanup] workspace=${workspaceId} stopped and deleted after ${graceMs}ms grace`
   - Wrap in try/catch — cleanup errors should log but never throw (don't fail the task over cleanup)
   - Return void

2. **Write `src/__tests__/lib/workspace/cleanup.test.ts`** — Tests:
   - Successful cleanup: stop → delete → DB update, all called in order
   - Cleanup error (e.g., workspace already deleted): logs error, does not throw
   - Grace period: verify setTimeout/delay is called with correct ms

3. **Extend `src/lib/queue/task-queue.ts`**:
   - Import new step factories: `createLintStep`, `createCommitPushStep`, `createCIStep`, `createPRStep`
   - Import `cleanupWorkspace` from `@/lib/workspace/cleanup`
   - Increase `JOB_TIMEOUT_MS` to `90 * 60 * 1_000` (90 minutes)
   - Extend the step array: `[hydrate, rules, tools, agent, lint, commitPush, ci, pr]`
   - Pass CI step deps: `createCIStep({ createAgentStep, createLintStep, createCommitPushStep })`
   - After successful blueprint: extract `ctx.prUrl` and persist to task record along with `ctx.branchName`:
     ```
     await db.task.update({ where: { id: taskId }, data: { status: "done", prUrl: ctx.prUrl, branch: ctx.branchName } })
     ```
   - In a `finally` block (after the try/catch): call `cleanupWorkspace(coderClient, workspaceId, graceMs, db)` — runs on both success and failure
   - The cleanup needs the Coder workspace ID (from step 2 of the existing flow), so capture it in a variable accessible to `finally`

4. **Update `src/__tests__/lib/queue/worker.test.ts`**:
   - Add mock for new step factories (same pattern as existing hydrate/rules/tools/agent mocks)
   - Add mock for `cleanupWorkspace`
   - Update success flow test: verify 8-step pipeline passed to runBlueprint, prUrl/branch persisted to task record
   - Add test: verify cleanup is called after successful blueprint
   - Add test: verify cleanup is called after failed blueprint (finally block)
   - Verify JOB_TIMEOUT_MS is 90 minutes in Worker constructor options

5. **Run full test suite:** `npx vitest run` — all tests pass, zero regressions

## Must-Haves

- [ ] Worker pipeline includes all 8 steps in correct order: hydrate → rules → tools → agent → lint → commit-push → ci → pr
- [ ] CI step receives injected dependencies for agent/lint/commit-push
- [ ] Task record updated with prUrl and branch on success — R004
- [ ] Workspace cleanup runs in finally block (both success and failure paths) — R015
- [ ] Cleanup errors are caught and logged, never propagated
- [ ] JOB_TIMEOUT_MS increased to 90 minutes
- [ ] All existing tests still pass (zero regressions)

## Verification

- `npx vitest run src/__tests__/lib/workspace/cleanup.test.ts` — all pass
- `npx vitest run src/__tests__/lib/queue/worker.test.ts` — all pass (extended pipeline)
- `npx vitest run` — full suite passes, zero regressions

## Observability Impact

- Signals added: `[cleanup]` log prefix for workspace stop/delete lifecycle
- How a future agent inspects this: grep for `[cleanup]` in container logs; check `workspaces.status` in DB for `deleted`; check `tasks.prUrl` for PR URL
- Failure state exposed: cleanup errors logged but swallowed; `tasks.errorMessage` still contains blueprint failure details

## Inputs

- `src/lib/queue/task-queue.ts` — existing worker pipeline to extend (read this file first)
- `src/lib/blueprint/steps/lint.ts` — T01 output, lint step factory
- `src/lib/blueprint/steps/commit-push.ts` — T01 output, commit-push step factory
- `src/lib/blueprint/steps/pr.ts` — T01 output, PR step factory
- `src/lib/blueprint/steps/ci.ts` — T02 output, CI feedback step factory
- `src/lib/blueprint/types.ts` — T02 updated BlueprintContext with prUrl, ciRoundsUsed
- `src/lib/coder/client.ts` — stopWorkspace, deleteWorkspace methods
- `src/__tests__/lib/queue/worker.test.ts` — existing test to extend (read first for mock patterns)

## Expected Output

- `src/lib/workspace/cleanup.ts` — workspace cleanup function (stop + delete + DB update)
- `src/__tests__/lib/workspace/cleanup.test.ts` — 2-3 cleanup tests
- `src/lib/queue/task-queue.ts` — extended with 8-step pipeline, prUrl persistence, cleanup in finally
- `src/__tests__/lib/queue/worker.test.ts` — updated with extended pipeline tests, cleanup verification

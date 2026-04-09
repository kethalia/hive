---
estimated_steps: 5
estimated_files: 6
---

# T02: Build cleanup scheduler with listWorkspaces and benchmark docs

**Slice:** S07 — Workspace Lifecycle & Pre-warming
**Milestone:** M001

## Description

Build a periodic garbage collection scheduler that serves as a safety net for workspace cleanup. The existing `cleanupWorkspace` call in `task-queue.ts` is fire-and-forget (no `await`) — if it fails silently, workspaces leak. This scheduler periodically queries the database for workspaces whose tasks are terminal (`done`/`failed`) and whose `updatedAt` exceeds the grace period, then cleans them up.

Also adds `listWorkspaces` to `CoderClient` (needed for potential future use but primarily the scheduler queries Prisma directly) and creates benchmark documentation.

## Steps

1. **Add `ListWorkspacesResponse` type and `listWorkspaces` method** — In `src/lib/coder/types.ts`, add `ListWorkspacesResponse` interface (`{ workspaces: CoderWorkspace[], count: number }`). In `src/lib/coder/client.ts`, add `listWorkspaces(options?: { owner?: string, status?: string })` that calls `GET /api/v2/workspaces` with query params. Add tests in `src/__tests__/lib/coder/client.test.ts` for the new method (correct URL, query params, response parsing).

2. **Create cleanup scheduler** — Create `src/lib/workspace/scheduler.ts` with:
   - `startCleanupScheduler(coderClient, db, options?)` — returns `{ stop: () => void }` for graceful shutdown
   - `options`: `intervalMs` (default 5 minutes), `graceMs` (default 60 seconds from env `CLEANUP_GRACE_MS`)
   - Each sweep: query Prisma for `Workspace` records where `status != 'deleted'` and the associated `task.status` is `done` or `failed` and `task.updatedAt < now - graceMs`
   - For each stale workspace with a `coderWorkspaceId`, call `cleanupWorkspace(coderClient, workspaceId, 0, db)` (grace=0 since the grace period was already accounted for in the query)
   - Log `[cleanup-scheduler]` with sweep count and results
   - Never throw — wrap entire sweep in try/catch

3. **Write scheduler tests** — Create `src/__tests__/lib/workspace/scheduler.test.ts`:
   - Sweep finds and cleans stale workspaces (task done, updatedAt past grace)
   - Sweep skips workspaces for running/queued tasks
   - Sweep skips already-deleted workspaces
   - Sweep handles cleanup errors gracefully (logs, continues to next)
   - `stop()` clears the interval
   - Use `vi.useFakeTimers()` for interval control

4. **Create benchmark documentation** — Write `docs/workspace-benchmarks.md` with:
   - Measurement instructions using `time coder create` with and without prebuilds
   - Expected cold-start vs warm-start time ranges
   - How to configure prebuild pool size
   - Coder Premium requirement note

5. **Run full test suite** — Verify no regressions across all existing tests.

## Must-Haves

- [ ] `listWorkspaces` method on `CoderClient` with at least 2 tests
- [ ] `startCleanupScheduler` function exports from `src/lib/workspace/scheduler.ts`
- [ ] Scheduler only cleans workspaces for terminal tasks (`done`, `failed`)
- [ ] Scheduler skips workspaces for `running`, `queued`, `verifying` tasks
- [ ] Scheduler returns `{ stop }` for graceful shutdown
- [ ] Scheduler errors are logged, never thrown
- [ ] At least 4 scheduler tests
- [ ] `docs/workspace-benchmarks.md` exists with measurement instructions
- [ ] Full test suite passes

## Verification

- `npx vitest run src/__tests__/lib/coder/client.test.ts` — passes
- `npx vitest run src/__tests__/lib/workspace/scheduler.test.ts` — passes
- `npx vitest run` — full suite green, no regressions
- `test -f docs/workspace-benchmarks.md` — exists

## Inputs

- `src/lib/coder/client.ts` — Current CoderClient with `request()` helper, no `listWorkspaces` yet
- `src/lib/coder/types.ts` — Current types: `CoderWorkspace`, `CoderClientConfig`, etc.
- `src/lib/workspace/cleanup.ts` — Existing `cleanupWorkspace(coderClient, workspaceId, graceMs, db)` function
- `src/__tests__/lib/coder/client.test.ts` — Existing test file with `makeClient()`, `mockWorkspace()`, `jsonResponse()` helpers
- `prisma/schema.prisma` — Schema with `Task` (status: `TaskStatus`), `Workspace` (status: `WorkspaceStatus`, `coderWorkspaceId`, `taskId`), both have `updatedAt`
- The `cleanupWorkspace` call in `task-queue.ts` is fire-and-forget (no `await`) — the scheduler is the safety net

## Expected Output

- `src/lib/coder/client.ts` — Modified with `listWorkspaces` method
- `src/lib/coder/types.ts` — Modified with `ListWorkspacesResponse` type
- `src/lib/workspace/scheduler.ts` — New file with `startCleanupScheduler`
- `src/__tests__/lib/coder/client.test.ts` — Extended with listWorkspaces tests
- `src/__tests__/lib/workspace/scheduler.test.ts` — New test file
- `docs/workspace-benchmarks.md` — New documentation file

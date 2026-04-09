# S07: Workspace Lifecycle & Pre-warming

**Goal:** Workspaces auto-cleanup after configurable grace period via a garbage collector safety net. Coder prebuilt workspace pools configured for worker and verifier templates. Cold start time measured and documented.
**Demo:** Both Terraform templates have `coder_workspace_preset` with `prebuilds` blocks. A cleanup scheduler periodically finds and deletes stale workspaces. `docs/workspace-benchmarks.md` contains measurement instructions.

## Must-Haves

- `coder_workspace_preset` with `prebuilds` block in both `templates/hive-worker/main.tf` and `templates/hive-verifier/main.tf`
- Variables that lack defaults (`task_id`, `task_prompt`, `repo_url`) get placeholder defaults for prebuild phase
- Startup scripts conditionally skip task-specific logic during prebuild via `data.coder_workspace.me.prebuild_count`
- Container name uses stable identifier to avoid resource replacement on claim
- `listWorkspaces` method on `CoderClient` with tests
- Periodic cleanup scheduler in `src/lib/workspace/scheduler.ts` that finds stale workspaces and calls `cleanupWorkspace`
- Scheduler tests covering: periodic execution, only cleans terminal tasks, skips running tasks
- Benchmark documentation in `docs/workspace-benchmarks.md`

## Verification

- `cd templates/hive-worker && terraform init -backend=false && terraform validate` — passes
- `cd templates/hive-verifier && terraform init -backend=false && terraform validate` — passes
- `grep -q "coder_workspace_preset" templates/hive-worker/main.tf` — preset exists
- `grep -q "coder_workspace_preset" templates/hive-verifier/main.tf` — preset exists
- `npx vitest run src/__tests__/lib/coder/client.test.ts` — passes including listWorkspaces tests
- `npx vitest run src/__tests__/lib/workspace/scheduler.test.ts` — passes
- `npx vitest run` — full suite passes, no regressions
- `test -f docs/workspace-benchmarks.md` — benchmark doc exists
- `grep -q "ignore_changes" templates/hive-worker/main.tf && grep -q "ignore_changes" templates/hive-verifier/main.tf` — container lifecycle stable across prebuild claim (failure-path: container replacement on name change)

## Observability / Diagnostics

- Runtime signals: `[cleanup-scheduler]` prefixed logs for each sweep cycle with count of workspaces cleaned
- Inspection surfaces: scheduler logs in container stdout, workspace/task tables in Postgres
- Failure visibility: individual cleanup errors logged with workspace ID, non-fatal to sweep cycle

## Integration Closure

- Upstream surfaces consumed: `src/lib/workspace/cleanup.ts` (cleanupWorkspace), `src/lib/coder/client.ts` (CoderClient), Prisma schema (Task, Workspace models)
- New wiring introduced in this slice: cleanup scheduler (needs to be started in app entrypoint — deferred to integration)
- What remains before the milestone is truly usable end-to-end: scheduler needs to be imported and started in the main server process

## Tasks

- [x] **T01: Add prebuilds configuration to worker and verifier Terraform templates** `est:30m`
  - Why: Enables prebuilt workspace pools so workspaces claim in seconds instead of cold-starting in minutes (R031)
  - Files: `templates/hive-worker/main.tf`, `templates/hive-verifier/main.tf`
  - Do: Add default values to variables lacking them (`task_id`, `task_prompt`, `repo_url`, `branch_name`). Add `data "coder_workspace_preset"` with `prebuilds { instances = N }` block. Use `lifecycle { ignore_changes = [name] }` on `docker_container` to prevent replacement on claim. Guard startup script env vars with prebuild-aware conditionals. Document Coder Premium requirement in comments.
  - Verify: `cd templates/hive-worker && terraform init -backend=false && terraform validate && cd ../../templates/hive-verifier && terraform init -backend=false && terraform validate`
  - Done when: Both templates have preset+prebuilds blocks, `terraform validate` passes for both, container name is stable across claim

- [x] **T02: Build cleanup scheduler with listWorkspaces and benchmark docs** `est:45m`
  - Why: The existing `cleanupWorkspace` in task-queue.ts is fire-and-forget — if it fails silently, workspaces leak. The scheduler is the safety net that periodically garbage-collects stale workspaces (R015). Also closes R031 documentation.
  - Files: `src/lib/coder/client.ts`, `src/lib/coder/types.ts`, `src/lib/workspace/scheduler.ts`, `src/__tests__/lib/coder/client.test.ts`, `src/__tests__/lib/workspace/scheduler.test.ts`, `docs/workspace-benchmarks.md`
  - Do: (1) Add `ListWorkspacesResponse` type and `listWorkspaces()` method to CoderClient using `GET /api/v2/workspaces?q=owner:me`. (2) Create `src/lib/workspace/scheduler.ts` with a `startCleanupScheduler(coderClient, db, options?)` function using `setInterval`. Each sweep queries Prisma for Workspace records where associated task status is `done` or `failed` and `updatedAt` is older than grace period, then calls `cleanupWorkspace` for each. (3) Write tests for both. (4) Create `docs/workspace-benchmarks.md` with cold-start vs warm-start measurement instructions.
  - Verify: `npx vitest run src/__tests__/lib/coder/client.test.ts && npx vitest run src/__tests__/lib/workspace/scheduler.test.ts && npx vitest run && test -f docs/workspace-benchmarks.md`
  - Done when: listWorkspaces tested, scheduler tested (periodic sweep, terminal-only cleanup, skip-running), full suite green, benchmark doc exists

## Files Likely Touched

- `templates/hive-worker/main.tf`
- `templates/hive-verifier/main.tf`
- `src/lib/coder/client.ts`
- `src/lib/coder/types.ts`
- `src/lib/workspace/scheduler.ts`
- `src/__tests__/lib/coder/client.test.ts`
- `src/__tests__/lib/workspace/scheduler.test.ts`
- `docs/workspace-benchmarks.md`

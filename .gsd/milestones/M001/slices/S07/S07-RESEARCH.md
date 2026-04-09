# S07: Workspace Lifecycle & Pre-warming — Research

**Date:** 2026-03-20

## Summary

S07 is a low-risk, configuration-focused slice with three deliverables: (1) add `coder_workspace_preset` with `prebuilds` blocks to the worker and verifier Terraform templates, (2) build a cleanup scheduler for periodic workspace garbage collection, and (3) document cold-start vs warm-start benchmarks. All patterns are straightforward — the cleanup primitive (`cleanupWorkspace`) already exists in `src/lib/workspace/cleanup.ts` with 3 passing tests. The prebuilds configuration is pure Terraform using `data "coder_workspace_preset"` with a `prebuilds { instances = N }` block. The garbage collector needs a `listWorkspaces` method on `CoderClient` and a periodic scheduler.

The primary requirement is **R031** (prebuilt workspace pools) and the slice also closes out **R015** (automatic workspace cleanup after grace period) with the garbage collector.

## Recommendation

Build in three tasks: (1) Add prebuilds configuration to both Terraform templates — pure `.tf` changes, no TypeScript. (2) Add `listWorkspaces` to `CoderClient` and build a cleanup scheduler that finds orphaned/stale workspaces and deletes them. (3) Write a benchmark documentation file with cold-start measurement instructions.

Prebuilds require **Coder Premium** — document this constraint. The presets use placeholder/default parameter values since actual task parameters are applied during the claim `terraform apply`. The `prebuild_count` / `is_prebuild` fields on `data.coder_workspace.me` can be used to conditionally skip task-specific startup logic during the prebuild phase.

## Implementation Landscape

### Key Files

- `templates/hive-worker/main.tf` — Add `coder_workspace_preset` data source with `prebuilds { instances = 2 }`. Needs default values for task_id, task_prompt, repo_url, branch_name parameters. Use `data.coder_workspace.me.prebuild_count` to conditionally skip startup scripts that need real task data.
- `templates/hive-verifier/main.tf` — Same pattern, preset with `prebuilds { instances = 1 }`. Needs defaults for task_id, repo_url, branch_name.
- `src/lib/coder/client.ts` — Add `listWorkspaces(options?: { owner?: string, status?: string }): Promise<CoderWorkspace[]>` using `GET /api/v2/workspaces?q=owner:me`. Needed by garbage collector to find stale workspaces.
- `src/lib/coder/types.ts` — Add `ListWorkspacesResponse` type (the API returns `{ workspaces: CoderWorkspace[], count: number }`).
- `src/lib/workspace/cleanup.ts` — Already has `cleanupWorkspace(coderClient, workspaceId, graceMs, db)` that stops, deletes, and updates DB. The garbage collector will reuse this.
- `src/lib/workspace/scheduler.ts` — **New file.** Periodic cleanup scheduler using `setInterval`. Queries DB for workspaces with `status != 'deleted'` whose associated task is `done` or `failed` and `updatedAt` is older than the grace period. Calls `cleanupWorkspace` for each. Configurable via `CLEANUP_INTERVAL_MS` (default: 5 minutes) and `CLEANUP_GRACE_MS` (default: 60 seconds, already used in `task-queue.ts`).
- `src/__tests__/lib/workspace/scheduler.test.ts` — **New file.** Tests for the scheduler.
- `src/__tests__/lib/coder/client.test.ts` — Add tests for `listWorkspaces`.
- `docs/workspace-benchmarks.md` — **New file.** Cold-start vs warm-start measurement instructions and benchmark template.

### Build Order

1. **Terraform prebuilds** (T01) — Add preset + prebuilds blocks to both templates. Add default values to variables that currently lack them (task_id, task_prompt, repo_url). Use `prebuild_count` to guard startup scripts. Pure Terraform, no dependencies.
2. **Cleanup scheduler** (T02) — Add `listWorkspaces` to CoderClient, build the periodic scheduler, add tests. Depends on existing `cleanupWorkspace` and DB schema.
3. **Benchmark docs** (T03) — Write documentation with measurement commands (`time coder create ...` with and without prebuilds). Can run in parallel with T02.

### Verification Approach

- `terraform validate` in both template directories confirms HCL syntax
- `npx vitest run src/__tests__/lib/workspace/scheduler.test.ts` — scheduler tests pass
- `npx vitest run src/__tests__/lib/coder/` — client tests pass including new listWorkspaces
- `npx vitest run` — full suite passes, no regressions
- `docs/workspace-benchmarks.md` exists with measurement instructions

## Constraints

- **Coder Premium required for prebuilds** — The `prebuilds` block on `coder_workspace_preset` requires Coder Premium license. Without it, the preset still works but no pool is maintained. Document this clearly.
- **Prebuilt workspaces need default parameter values** — Variables like `task_id`, `task_prompt`, `repo_url` currently have no defaults. Prebuilds create workspaces before a real task exists, so these need placeholder defaults (empty strings). The preset's `parameters` block provides these defaults.
- **`prebuild_count` for conditional startup** — Startup scripts that reference task-specific env vars (HIVE_TASK_ID, HIVE_REPO_URL) will get placeholder values during prebuild phase. Use `data.coder_workspace.me.is_prebuild` to skip task-specific init during prebuild creation — the agent reinitializes after claim.

## Common Pitfalls

- **Terraform resource replacement on claim** — When a prebuilt workspace is claimed, `coder_workspace.me.name` and owner change. If these are used in `docker_container.name` (they are: `coder-${owner}-${name}`), Terraform will destroy and recreate the container, losing the prebuild benefit. The `name` attribute on `docker_container` must use a stable identifier (e.g., workspace ID) or use `lifecycle { ignore_changes = [name] }`.
- **Cleanup race with active tasks** — The garbage collector must only clean up workspaces whose task is terminal (`done`, `failed`). Never clean up workspaces for `running` or `verifying` tasks. Query by task status, not just workspace age.
- **Fire-and-forget cleanup in task-queue.ts** — The existing `finally` block in task-queue.ts calls `cleanupWorkspace` without `await` — it's fire-and-forget. The garbage collector serves as a safety net for cases where this fails silently.

## Open Risks

- **Coder version compatibility** — `coder_workspace_preset` with `prebuilds` is available from Coder v2.22+. The running Coder instance must be at this version or newer. If not, the preset works but prebuilds silently don't activate.

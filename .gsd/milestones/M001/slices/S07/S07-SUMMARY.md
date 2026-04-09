---
id: S07
parent: M001
milestone: M001
provides:
  - Prebuilt workspace pool configuration for worker (2 instances) and verifier (1 instance) templates
  - Stable container lifecycle across prebuild claim transitions via ignore_changes
  - listWorkspaces method on CoderClient for querying workspace inventory
  - Periodic cleanup scheduler as safety net for leaked/stale workspaces
  - Benchmark documentation for cold-start vs warm-start measurement
requires:
  - slice: S03
    provides: Worker template (templates/hive-worker/main.tf)
  - slice: S04
    provides: cleanupWorkspace function (src/lib/workspace/cleanup.ts)
  - slice: S05
    provides: Verifier template (templates/hive-verifier/main.tf)
affects: []
key_files:
  - templates/hive-worker/main.tf
  - templates/hive-verifier/main.tf
  - src/lib/coder/client.ts
  - src/lib/coder/types.ts
  - src/lib/workspace/scheduler.ts
  - src/__tests__/lib/coder/client.test.ts
  - src/__tests__/lib/workspace/scheduler.test.ts
  - docs/workspace-benchmarks.md
key_decisions:
  - Worker pool size of 2 instances, verifier pool size of 1 (verifiers needed less frequently)
  - Empty string defaults for task variables to allow prebuild creation before real task assignment
  - Scheduler runs immediate sweep on start plus periodic interval
  - Grace period enforced via Prisma query filter (task.updatedAt < cutoff), not in-process timer
patterns_established:
  - coder_workspace_preset with prebuilds block pattern for all Hive templates
  - lifecycle ignore_changes on container name to survive prebuild ownership transfer
  - Scheduler pattern returning { stop } handle for graceful shutdown
  - Prisma relational query filter for task status + time-based cleanup eligibility
observability_surfaces:
  - "[cleanup-scheduler]" prefixed console logs for sweep start, per-workspace errors, and completion counts
drill_down_paths:
  - .gsd/milestones/M001/slices/S07/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001/slices/S07/tasks/T02-SUMMARY.md
duration: 35m
verification_result: passed
completed_at: 2026-03-20
---

# S07: Workspace Lifecycle & Pre-warming

**Prebuilt workspace pools configured for both templates, periodic cleanup scheduler catches leaked workspaces, cold-start benchmark docs written**

## What Happened

This slice added two operational capabilities that close the workspace lifecycle loop:

**T01 — Prebuilds configuration:** Added `coder_workspace_preset` with `prebuilds` blocks to both Terraform templates. Worker gets 2 prebuilt instances (higher demand), verifier gets 1. Variables that lack meaningful defaults during prebuild (`task_id`, `task_prompt`, `repo_url`, `branch_name`) received empty string defaults so Coder can create prebuilt workspaces before real task assignment. The critical piece: `lifecycle { ignore_changes = [name] }` on `docker_container.workspace` prevents Terraform from destroying and recreating the container when a prebuild is claimed (the name changes to include the new owner). Without this, prebuilds would be pointless — claiming would trigger a full rebuild.

**T02 — Cleanup scheduler + listWorkspaces + benchmarks:** Added `listWorkspaces(options?)` to CoderClient with owner/status query filters. Created `startCleanupScheduler(coderClient, db, options?)` that runs an immediate sweep on start plus periodic sweeps via `setInterval`. Each sweep queries Prisma for workspaces where the associated task is terminal (`done`/`failed`) and `updatedAt` is past the grace period, then calls `cleanupWorkspace` for each. Individual errors are caught and logged — never thrown — so one failed cleanup doesn't block others. Returns `{ stop }` for graceful shutdown. Wrote `docs/workspace-benchmarks.md` with measurement instructions for cold-start vs warm-start times and pool sizing guidance.

## Verification

All slice plan verification checks pass:

| Check | Result |
|-------|--------|
| `terraform validate` — hive-worker | ✅ pass |
| `terraform validate` — hive-verifier | ✅ pass |
| `coder_workspace_preset` in worker template | ✅ present |
| `coder_workspace_preset` in verifier template | ✅ present |
| `prebuilds` in both templates | ✅ present |
| `ignore_changes` in both templates | ✅ present |
| Client tests (11 total, 3 new listWorkspaces) | ✅ pass |
| Scheduler tests (6 tests) | ✅ pass |
| Full test suite (148 tests, 25 files) | ✅ pass, zero regressions |
| `docs/workspace-benchmarks.md` exists | ✅ present |

## New Requirements Surfaced

- none

## Deviations

None. Both tasks executed cleanly per plan.

## Known Limitations

- **Scheduler not wired to entrypoint**: `startCleanupScheduler` must be imported and called in the main server process with real CoderClient and PrismaClient instances. This is deferred to integration (noted in slice plan's Integration Closure section).
- **Coder Premium required**: Prebuilds require Coder Premium license for full pool management. Without it, the `prebuilds` blocks are ignored but templates still function normally.
- **Preset parameters coupling**: The `coder_workspace_preset` `parameters` map keys must match template parameter names exactly. If template variables are refactored, presets must be updated in sync.

## Follow-ups

- Wire `startCleanupScheduler` into the application entrypoint during integration
- Validate prebuilds behavior against a real Coder Premium deployment
- Measure actual cold-start vs warm-start times and update benchmark docs with real numbers

## Files Created/Modified

- `templates/hive-worker/main.tf` — Added empty defaults to task variables, coder_workspace_preset with prebuilds (2 instances), lifecycle ignore_changes on container name
- `templates/hive-verifier/main.tf` — Same pattern for verifier: defaults on task_id/repo_url/branch_name, preset with prebuilds (1 instance), stable container lifecycle
- `src/lib/coder/client.ts` — Added listWorkspaces method with owner/status query filters
- `src/lib/coder/types.ts` — Added ListWorkspacesResponse interface
- `src/lib/workspace/scheduler.ts` — New cleanup scheduler with startCleanupScheduler and internal sweep function
- `src/__tests__/lib/coder/client.test.ts` — Added 3 listWorkspaces tests (no filters, combined filters, single filter)
- `src/__tests__/lib/workspace/scheduler.test.ts` — New test file with 6 tests covering all scheduler behaviors
- `docs/workspace-benchmarks.md` — Benchmark documentation with measurement instructions and expected time ranges

## Forward Intelligence

### What the next slice should know
- All 7 slices of M001 are now complete. The scheduler needs to be wired into the app entrypoint during integration — call `startCleanupScheduler(coderClient, db, { intervalMs, graceMs })` in the server startup path.
- Prebuilds are configured but untested against real Coder Premium. Templates work fine without Premium — the prebuilds blocks are simply ignored.

### What's fragile
- **Preset parameter names** — The `coder_workspace_preset.parameters` map must match `variable` block names exactly. No compile-time check exists; mismatches silently break prebuild creation.
- **Container name stability** — The `ignore_changes = [name]` is essential for prebuilds. If someone removes this lifecycle rule, prebuilds will appear to work but destroy/recreate on claim, negating the performance benefit.

### Authoritative diagnostics
- `[cleanup-scheduler]` log prefix in container stdout — shows sweep cycle counts and per-workspace errors
- `terraform validate` on both templates — catches structural issues before deployment
- Coder dashboard with `owner:prebuilds` filter — shows prebuilt workspace pool status at runtime

### What assumptions changed
- No assumptions changed. This was a straightforward operational slice that delivered exactly what was planned.

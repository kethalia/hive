# S07: Workspace Lifecycle & Pre-warming — UAT

**Milestone:** M001
**Written:** 2026-03-20

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: S07 delivers Terraform configuration (no runtime server needed), a scheduler module (tested via unit tests), and documentation. All verification is structural — grep checks, terraform validate, and test execution.

## Preconditions

- Terraform CLI available (installed at `~/bin/terraform` or on PATH)
- Node.js + npm available for running vitest
- `npm install` / `npm ci` completed in project root

## Smoke Test

Run `cd templates/hive-worker && terraform init -backend=false && terraform validate` — should output "The configuration is valid." If this fails, nothing else will work.

## Test Cases

### 1. Worker template has prebuilds configuration

1. `grep -c "coder_workspace_preset" templates/hive-worker/main.tf`
2. **Expected:** Output is `1` (exactly one preset block)
3. `grep -c "prebuilds" templates/hive-worker/main.tf`
4. **Expected:** Output is at least `1`
5. `grep "instances" templates/hive-worker/main.tf | grep -o "[0-9]*"`
6. **Expected:** Output includes `2` (worker pool size)

### 2. Verifier template has prebuilds configuration

1. `grep -c "coder_workspace_preset" templates/hive-verifier/main.tf`
2. **Expected:** Output is `1`
3. `grep -c "prebuilds" templates/hive-verifier/main.tf`
4. **Expected:** Output is at least `1`
5. `grep "instances" templates/hive-verifier/main.tf | grep -o "[0-9]*"`
6. **Expected:** Output includes `1` (verifier pool size)

### 3. Container lifecycle stable across prebuild claim

1. `grep -A2 "lifecycle" templates/hive-worker/main.tf`
2. **Expected:** Shows `ignore_changes = [name]` inside a lifecycle block
3. `grep -A2 "lifecycle" templates/hive-verifier/main.tf`
4. **Expected:** Same pattern — `ignore_changes = [name]`

### 4. Task variables have defaults for prebuild phase

1. `grep -A1 'variable "task_id"' templates/hive-worker/main.tf`
2. **Expected:** Shows `default = ""` 
3. `grep -A1 'variable "task_prompt"' templates/hive-worker/main.tf`
4. **Expected:** Shows `default = ""`
5. `grep -A1 'variable "repo_url"' templates/hive-worker/main.tf`
6. **Expected:** Shows `default = ""`

### 5. Both templates pass terraform validate

1. `cd templates/hive-worker && terraform init -backend=false && terraform validate`
2. **Expected:** "The configuration is valid."
3. `cd templates/hive-verifier && terraform init -backend=false && terraform validate`
4. **Expected:** "The configuration is valid."

### 6. listWorkspaces method works correctly

1. `npx vitest run src/__tests__/lib/coder/client.test.ts`
2. **Expected:** All 11 tests pass, including "listWorkspaces" describe block with 3 tests (no filters, combined filters, single filter)

### 7. Cleanup scheduler handles all cases

1. `npx vitest run src/__tests__/lib/workspace/scheduler.test.ts`
2. **Expected:** All 6 tests pass:
   - cleans up stale workspaces with terminal tasks
   - skips workspaces where task is still running
   - skips already-deleted workspaces
   - continues on individual cleanup errors
   - stop() halts periodic sweeps
   - runs periodic sweeps on interval

### 8. Full test suite has no regressions

1. `npx vitest run`
2. **Expected:** 148 tests across 25 files, all pass

### 9. Benchmark documentation exists and has content

1. `test -f docs/workspace-benchmarks.md && echo "exists"`
2. **Expected:** "exists"
3. `grep -q "cold" docs/workspace-benchmarks.md && echo "has cold-start section"`
4. **Expected:** "has cold-start section"
5. `grep -q "warm" docs/workspace-benchmarks.md && echo "has warm-start section"`
6. **Expected:** "has warm-start section"

## Edge Cases

### Scheduler error resilience

1. Review `src/lib/workspace/scheduler.ts` — the sweep function must catch errors per-workspace
2. **Expected:** Individual `cleanupWorkspace` failures are logged but don't stop the sweep. Database query failures are caught and logged. The scheduler continues running regardless.

### Prebuild without Coder Premium

1. Both templates should function normally even without Coder Premium license
2. **Expected:** `terraform validate` passes regardless of Premium availability. The `prebuilds` blocks are simply ignored at runtime without Premium.

## Failure Signals

- `terraform validate` fails → template syntax is broken, prebuilds config is malformed
- Scheduler tests fail on "skips workspaces where task is still running" → filter logic is wrong, running workspaces would be deleted
- Full suite regression → S07 changes broke something in S01-S06
- Missing `ignore_changes` → prebuilds would destroy/recreate containers on claim, negating performance benefit

## Not Proven By This UAT

- Actual prebuild pool behavior against a real Coder Premium deployment
- Real cold-start vs warm-start time measurements (docs provide instructions, not results)
- Scheduler running in a live server process (wiring to entrypoint deferred to integration)
- Interaction between scheduler cleanup and active task execution under load

## Notes for Tester

- Terraform may need to be installed manually (`~/bin/terraform`) — it's not always on PATH in Coder workspaces
- The scheduler is a standalone module — it works correctly in isolation but hasn't been wired into the server entrypoint yet. That's intentional per the slice plan.
- Prebuilds require Coder Premium. Without it, the configuration is inert but harmless.

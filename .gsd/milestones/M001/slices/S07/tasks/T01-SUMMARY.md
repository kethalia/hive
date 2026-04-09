---
id: T01
parent: S07
milestone: M001
provides:
  - Prebuilt workspace pool configuration for worker and verifier templates
  - Stable container lifecycle across prebuild claim transitions
key_files:
  - templates/hive-worker/main.tf
  - templates/hive-verifier/main.tf
key_decisions:
  - Worker pool size of 2 instances, verifier pool size of 1 (verifiers needed less frequently)
  - Empty string defaults for task variables to allow prebuild creation before real task assignment
patterns_established:
  - coder_workspace_preset with prebuilds block pattern for all Hive templates
  - lifecycle ignore_changes on container name to survive ownership transfer
observability_surfaces:
  - none (Terraform config only — runtime observability comes from Coder's built-in prebuild metrics)
duration: 15m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T01: Add prebuilds configuration to worker and verifier Terraform templates

**Added coder_workspace_preset with prebuilds blocks and stable container lifecycle to both hive-worker (2 instances) and hive-verifier (1 instance) templates**

## What Happened

Added prebuild pool configuration to both Terraform templates in three changes per template:

1. **Variable defaults**: Added `default = ""` to `task_id`, `task_prompt`, `repo_url` in worker and `task_id`, `repo_url`, `branch_name` in verifier. These empty defaults allow Coder to create prebuilt workspaces before a real task is assigned.

2. **Workspace preset blocks**: Added `data "coder_workspace_preset"` with a `prebuilds` sub-block — 2 instances for worker (higher demand), 1 for verifier. The preset's `parameters` map provides the same empty defaults so prebuilds match the variable values. Comments note the Coder Premium requirement.

3. **Container lifecycle stability**: Added `lifecycle { ignore_changes = [name] }` to `docker_container.workspace` in both templates. Without this, when a prebuild is claimed and ownership transfers, the container name changes (it includes owner name), which would cause Terraform to destroy and recreate the container — defeating the purpose of prebuilds.

## Verification

- `terraform init -backend=false && terraform validate` passes for both templates
- `coder_workspace_preset` block present in both templates
- `prebuilds` block present in both templates
- `ignore_changes` lifecycle rule present in both templates
- All variable defaults properly set

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cd templates/hive-worker && terraform init -backend=false && terraform validate` | 0 | ✅ pass | 8.5s |
| 2 | `cd templates/hive-verifier && terraform init -backend=false && terraform validate` | 0 | ✅ pass | 5.8s |
| 3 | `grep -q "coder_workspace_preset" templates/hive-worker/main.tf` | 0 | ✅ pass | <1s |
| 4 | `grep -q "coder_workspace_preset" templates/hive-verifier/main.tf` | 0 | ✅ pass | <1s |
| 5 | `grep -q "ignore_changes" templates/hive-worker/main.tf` | 0 | ✅ pass | <1s |
| 6 | `grep -q "ignore_changes" templates/hive-verifier/main.tf` | 0 | ✅ pass | <1s |
| 7 | `grep -q "prebuilds" templates/hive-worker/main.tf` | 0 | ✅ pass | <1s |

## Diagnostics

This task is Terraform configuration only — no runtime diagnostics surfaces are introduced. At runtime, Coder exposes prebuild metrics (`coderd_prebuilt_workspaces_created_total`, `_claimed_total`, `_desired`, `_running`) via Prometheus when Premium is active. Prebuilt workspaces are visible in the Coder dashboard with `owner:prebuilds` filter.

## Deviations

None.

## Known Issues

- Terraform had to be installed manually in the CI environment (`~/bin/terraform`) — not available by default.
- The `coder_workspace_preset` `parameters` map keys must match Coder template parameter names. If the template is later refactored to use `coder_parameter` resources instead of `variable` blocks, the preset parameters must be updated to match.

## Files Created/Modified

- `templates/hive-worker/main.tf` — Added empty defaults to task variables, coder_workspace_preset block with prebuilds (2 instances), lifecycle ignore_changes on container name
- `templates/hive-verifier/main.tf` — Same pattern adapted for verifier: defaults on task_id/repo_url/branch_name, preset with prebuilds (1 instance), stable container lifecycle

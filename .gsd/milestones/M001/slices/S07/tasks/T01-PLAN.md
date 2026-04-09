---
estimated_steps: 5
estimated_files: 2
---

# T01: Add prebuilds configuration to worker and verifier Terraform templates

**Slice:** S07 — Workspace Lifecycle & Pre-warming
**Milestone:** M001

## Description

Add `coder_workspace_preset` data sources with `prebuilds` blocks to both the hive-worker and hive-verifier Terraform templates. This enables Coder to maintain a pool of pre-created workspaces that can be claimed instantly when a task is submitted, reducing cold-start time from minutes to seconds. Requires Coder Premium for the pool to be active, but the configuration is valid without it.

Key concerns from research:
- Variables without defaults (`task_id`, `task_prompt`, `repo_url`) need placeholder defaults since prebuilt workspaces are created before a real task exists
- Container name currently uses `coder-${owner}-${name}` which changes on claim — must use `lifecycle { ignore_changes = [name] }` to prevent container destruction
- Startup scripts reference `HIVE_TASK_ID` etc. — prebuild phase gets placeholder values, so guard task-specific init with a prebuild check

## Steps

1. **Add defaults to worker variables** — In `templates/hive-worker/main.tf`, add `default = ""` to `task_id`, `task_prompt`, `repo_url` variables (they currently have no defaults, which blocks prebuild creation). `branch_name` already has a default.

2. **Add defaults to verifier variables** — In `templates/hive-verifier/main.tf`, add `default = ""` to `task_id`, `repo_url`, `branch_name` variables. The verifier has no `task_prompt` variable.

3. **Add `coder_workspace_preset` to worker template** — Add a `data "coder_workspace_preset" "hive-worker"` block with a `prebuilds { instances = 2 }` sub-block. The preset provides default parameter values matching the variable defaults. Add a comment noting Coder Premium requirement. Place after the existing data sources section.

4. **Add `coder_workspace_preset` to verifier template** — Same pattern with `prebuilds { instances = 1 }` (verifiers are needed less frequently).

5. **Stabilize container name and guard startup** — Add `lifecycle { ignore_changes = [name] }` to `docker_container.workspace` in both templates so container isn't replaced on claim. Optionally, add a conditional in the `coder_agent.main` env block using `data.coder_workspace.me.prebuild_count > 0` to set placeholder env values during prebuild phase (the defaults already handle this via empty strings, but an explicit comment helps maintainability).

## Must-Haves

- [ ] `task_id`, `task_prompt`, `repo_url` variables in worker template have `default = ""`
- [ ] `task_id`, `repo_url`, `branch_name` variables in verifier template have `default = ""`
- [ ] Worker template has `data "coder_workspace_preset"` with `prebuilds { instances = 2 }`
- [ ] Verifier template has `data "coder_workspace_preset"` with `prebuilds { instances = 1 }`
- [ ] Both `docker_container.workspace` resources have `lifecycle { ignore_changes = [name] }`
- [ ] Comment in both templates noting Coder Premium requirement for prebuilds
- [ ] `terraform validate` passes for both templates

## Verification

- `cd templates/hive-worker && terraform init -backend=false && terraform validate` — exits 0
- `cd templates/hive-verifier && terraform init -backend=false && terraform validate` — exits 0
- `grep -q "coder_workspace_preset" templates/hive-worker/main.tf` — exits 0
- `grep -q "coder_workspace_preset" templates/hive-verifier/main.tf` — exits 0
- `grep -q "ignore_changes" templates/hive-worker/main.tf` — exits 0
- `grep -q "ignore_changes" templates/hive-verifier/main.tf` — exits 0
- `grep -q 'prebuilds' templates/hive-worker/main.tf` — exits 0

## Inputs

- `templates/hive-worker/main.tf` — Current worker template with variables, agent, docker resources. Variables `task_id`, `task_prompt`, `repo_url` have no defaults. Container name is `coder-${owner}-${name}`.
- `templates/hive-verifier/main.tf` — Current verifier template, similar structure but no `task_prompt` or AI tools. Variables `task_id`, `repo_url` have no defaults; `branch_name` has no default.

## Expected Output

- `templates/hive-worker/main.tf` — Modified with variable defaults, `coder_workspace_preset` block, prebuilds config, and stable container lifecycle
- `templates/hive-verifier/main.tf` — Same modifications adapted for verifier (1 instance, different variable set)

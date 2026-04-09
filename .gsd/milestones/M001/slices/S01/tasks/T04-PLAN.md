---
estimated_steps: 4
estimated_files: 8
---

# T04: Create hive-worker Coder template derived from ai-dev

**Slice:** S01 — Infrastructure & Orchestrator Core
**Milestone:** M001

## Description

Create the `hive-worker/` Coder template by forking the existing `ai-dev/` template. The worker template needs: Pi/GSD for agent execution, GitHub auth for repo access, Node.js + build tools, task parameter variables (task_id, task_prompt, repo_url, branch_name) injected as environment variables into the agent. Remove: OpenCode, web3 tools, VS Code code-server, filebrowser — this is a headless execution template, not an interactive dev environment. Covers requirement R012.

## Steps

1. **Copy base files** — Copy `ai-dev/Dockerfile` to `hive-worker/Dockerfile` as-is (it has everything the worker needs: Ubuntu 24.04, Docker, Chrome, Node.js, build tools). Copy these scripts from `ai-dev/scripts/` to `hive-worker/scripts/`: `init.sh`, `tools-ai.sh`, `tools-ci.sh`, `tools-shell.sh`, `tools-node.sh`, `tools-nvm.sh`, `tools-browser.sh`, `browser-serve.sh`, `symlinks.sh`. Do NOT copy: `opencode-install.sh`, `opencode-serve.sh`, `tools-web3.sh`, `claude-install.sh`.

2. **Create hive-worker/main.tf** — Start from `ai-dev/main.tf` and make these changes:
   - **Add task parameter variables** at the top of the variables section:
     ```
     variable "task_id" { description = "Hive task ID", type = string }
     variable "task_prompt" { description = "Task prompt/description", type = string }
     variable "repo_url" { description = "Target repository URL", type = string }
     variable "branch_name" { description = "Git branch name for this task", type = string, default = "" }
     ```
   - **Inject task env vars** into `coder_agent.main.env` block — add: `HIVE_TASK_ID = var.task_id`, `HIVE_TASK_PROMPT = var.task_prompt`, `HIVE_REPO_URL = var.repo_url`, `HIVE_BRANCH_NAME = var.branch_name`
   - **Remove these resources entirely**: `coder_script.opencode_install`, `coder_app.opencode_terminal`, `coder_app.opencode_ui`, `coder_script.opencode_serve`, `coder_script.tools_web3`, `coder_script.claude_code_install`, `coder_app.claude_code`, `module.code-server`, `module.filebrowser`
   - **Remove these variables**: `opencode_model`, `opencode_config_json`, `claude_code_model`, `claude_code_api_key`, `claude_code_system_prompt`, `claude_code_allowed_tools`
   - **Keep everything else**: Pi/GSD apps (coder_app.pi, coder_app.gsd), GitHub external auth, all git modules, AI tools script, CI tools script, shell/node/nvm tools, browser vision (coder_script.tools_browser, coder_script.browser_serve, coder_app.browser_vision), Docker resources (volume, image, container), symlinks script, all metadata blocks, resource limits
   - Update any `templatefile()` calls to use `${path.module}/scripts/` (should already be correct from copy)

3. **Update init.sh for worker context** — Modify `hive-worker/scripts/init.sh` to also clone the target repo on workspace start:
   - After existing dotfiles/git setup, add: if `HIVE_REPO_URL` is set, `git clone $HIVE_REPO_URL /home/coder/project`; if `HIVE_BRANCH_NAME` is set and non-empty, `cd /home/coder/project && git checkout -b $HIVE_BRANCH_NAME`
   - This ensures the workspace starts with the target repo ready to work on

4. **Validate the template** — Review main.tf for: no dangling references to removed resources, all `file()` and `templatefile()` calls reference scripts that exist in `hive-worker/scripts/`, all variables used in the template are declared. Run `terraform fmt hive-worker/main.tf` if terraform CLI is available, otherwise manually ensure consistent formatting.

## Must-Haves

- [ ] `hive-worker/main.tf` has variable blocks for task_id, task_prompt, repo_url, branch_name
- [ ] Agent env vars include HIVE_TASK_ID, HIVE_TASK_PROMPT, HIVE_REPO_URL, HIVE_BRANCH_NAME
- [ ] OpenCode, Claude Code, web3, code-server, filebrowser resources are removed
- [ ] Pi/GSD apps, GitHub auth, git modules, AI/CI/shell/node tools, browser vision are preserved
- [ ] `hive-worker/Dockerfile` is present (copy of ai-dev)
- [ ] All referenced scripts exist in `hive-worker/scripts/`
- [ ] No dangling resource references in main.tf
- [ ] init.sh clones HIVE_REPO_URL and checks out HIVE_BRANCH_NAME on start

## Verification

- `grep -c 'variable "task_id"' hive-worker/main.tf` returns 1
- `grep -c 'variable "task_prompt"' hive-worker/main.tf` returns 1
- `grep -c 'variable "repo_url"' hive-worker/main.tf` returns 1
- `grep -c 'variable "branch_name"' hive-worker/main.tf` returns 1
- `grep 'HIVE_TASK_ID' hive-worker/main.tf` shows env var injection
- `grep -c 'opencode' hive-worker/main.tf` returns 0
- `grep -c 'tools_web3' hive-worker/main.tf` returns 0
- `grep -c 'claude_code' hive-worker/main.tf` returns 0 (variable and resource references removed)
- `grep -c 'coder_app.*pi' hive-worker/main.tf` returns at least 1 (Pi app preserved)
- All files referenced by `file()` or `templatefile()` in main.tf exist in `hive-worker/scripts/`
- If terraform available: `terraform -chdir=hive-worker validate` passes

## Inputs

- `ai-dev/main.tf` — Source template to derive from (read only, do not modify)
- `ai-dev/Dockerfile` — Source Dockerfile to copy
- `ai-dev/scripts/*` — Source scripts to selectively copy

## Expected Output

- `hive-worker/main.tf` — Worker Coder template with task parameters, Pi/GSD, GitHub auth, no bloat
- `hive-worker/Dockerfile` — Copy of ai-dev/Dockerfile
- `hive-worker/scripts/init.sh` — Modified to clone task repo + checkout branch
- `hive-worker/scripts/tools-ai.sh` — Copy from ai-dev
- `hive-worker/scripts/tools-ci.sh` — Copy from ai-dev
- `hive-worker/scripts/tools-shell.sh` — Copy from ai-dev
- `hive-worker/scripts/tools-node.sh` — Copy from ai-dev
- `hive-worker/scripts/tools-nvm.sh` — Copy from ai-dev

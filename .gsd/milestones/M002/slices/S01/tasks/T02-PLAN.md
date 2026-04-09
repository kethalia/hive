---
estimated_steps: 31
estimated_files: 10
skills_used: []
---

# T02: Create hive-council Terraform template with Claude CLI support

Create the `templates/hive-council/` Terraform template based on hive-verifier, adapted for council reviewers: Claude CLI instead of Pi, anthropic_api_key variable, no browser tools. Must pass `terraform validate`.

## Steps

1. Create `templates/hive-council/` directory structure. Copy these files from `templates/hive-verifier/`:
   - `Dockerfile` (reuse as-is — image size optimization is out of scope per research)
   - `scripts/tools-shell.sh`
   - `scripts/tools-node.sh`
   - `scripts/tools-nvm.sh`
   - `scripts/tools-ci.sh`
   - `scripts/symlinks.sh`
   Do NOT copy: `scripts/tools-browser.sh`, `scripts/browser-serve.sh`

2. Create `templates/hive-council/scripts/claude-install.sh` — copy from `templates/ai-dev/scripts/claude-install.sh`. The script installs Claude Code CLI via `curl -fsSL https://claude.ai/install.sh | bash`. The template variable reference should use `claude_api_key` (matching the templatefile call).

3. Create `templates/hive-council/scripts/init.sh` — copy from `templates/hive-verifier/scripts/init.sh` but update the README content to say "council reviewer workspace" instead of "verifier workspace". Remove any browser-related references from the README.

4. Create `templates/hive-council/main.tf` based on `templates/hive-verifier/main.tf` with these changes:
   - Same terraform block (coder ~> 2.15, docker ~> 3.6)
   - Variables: keep `task_id`, `repo_url`, `branch_name`, `docker_socket`, `dotfiles_uri`. Add `anthropic_api_key` (string, default "", sensitive=true). Remove any verifier-specific variables not listed.
   - Workspace preset: name = "hive-council" (not "hive-verifier")
   - Agent env block: keep GIT_*, HIVE_TASK_ID, HIVE_REPO_URL, HIVE_BRANCH_NAME. Add ANTHROPIC_API_KEY using merge pattern: `merge({...base_env...}, var.anthropic_api_key != "" ? { ANTHROPIC_API_KEY = var.anthropic_api_key } : {})`
   - coder_script resources: keep tools_shell, tools_node, tools_ci, tools_nvm, symlinks. REMOVE tools_browser, browser_serve. ADD claude_install script using `templatefile("${path.module}/scripts/claude-install.sh", { claude_api_key = var.anthropic_api_key })`
   - REMOVE coder_app "browser_vision" resource entirely
   - Keep: GitHub external auth, git modules (github-upload-public-key, git-commit-signing, git-config)
   - Keep: docker_volume, docker_image, docker_container (identical to verifier)
   - Keep: all agent metadata blocks

5. Copy `.terraform.lock.hcl` from `templates/hive-verifier/.terraform.lock.hcl` (same providers).

6. Run `cd templates/hive-council && terraform init && terraform validate` to verify.

## Must-Haves
- `templates/hive-council/main.tf` exists and passes terraform validate
- anthropic_api_key variable declared as sensitive
- ANTHROPIC_API_KEY injected into agent env when non-empty
- Claude CLI install script present
- No browser tools/scripts/apps in the template
- Workspace preset named hive-council with instances = 1

## Inputs

- ``templates/hive-verifier/main.tf` — base template to adapt`
- ``templates/hive-verifier/Dockerfile` — reuse as-is`
- ``templates/hive-verifier/scripts/init.sh` — base init script`
- ``templates/hive-verifier/scripts/tools-shell.sh` — copy as-is`
- ``templates/hive-verifier/scripts/tools-node.sh` — copy as-is`
- ``templates/hive-verifier/scripts/tools-nvm.sh` — copy as-is`
- ``templates/hive-verifier/scripts/tools-ci.sh` — copy as-is`
- ``templates/hive-verifier/scripts/symlinks.sh` — copy as-is`
- ``templates/hive-verifier/.terraform.lock.hcl` — copy for same providers`
- ``templates/ai-dev/scripts/claude-install.sh` — Claude CLI install pattern`

## Expected Output

- ``templates/hive-council/main.tf` — council Terraform template`
- ``templates/hive-council/Dockerfile` — copied from verifier`
- ``templates/hive-council/scripts/init.sh` — adapted init script`
- ``templates/hive-council/scripts/claude-install.sh` — Claude CLI installer`
- ``templates/hive-council/scripts/tools-shell.sh` — copied`
- ``templates/hive-council/scripts/tools-node.sh` — copied`
- ``templates/hive-council/scripts/tools-nvm.sh` — copied`
- ``templates/hive-council/scripts/tools-ci.sh` — copied`
- ``templates/hive-council/scripts/symlinks.sh` — copied`
- ``templates/hive-council/.terraform.lock.hcl` — copied from verifier`

## Verification

cd templates/hive-council && terraform init && terraform validate

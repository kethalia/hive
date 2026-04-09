---
estimated_steps: 41
estimated_files: 2
skills_used: []
---

# T02: Wire KasmVNC into hive-council and verify all templates pass terraform validate + vitest

hive-council has KasmVNC in the base image but no Terraform wiring to start or expose it. Add browser-serve.sh (copied from hive-worker pattern, already using openbox) and the matching coder_script + coder_app resources to main.tf. Then run terraform validate for all 4 templates and vitest to confirm no regressions.

## Steps

1. Create `templates/hive-council/scripts/browser-serve.sh` — copy from `templates/hive-worker/scripts/browser-serve.sh` (which T01 already fixed to use openbox). Make it executable (`chmod +x`).

2. In `templates/hive-council/main.tf`, add two new resources after the last `coder_script` block (after `coder_script.symlinks` around line 258) and before `coder_script.tools_nvm`:

   ```hcl
   resource "coder_script" "browser_serve" {
     agent_id           = coder_agent.main.id
     display_name       = "Browser Vision Server"
     icon               = "/icon/terminal.svg"
     run_on_start       = true
     start_blocks_login = false
     script             = file("${path.module}/scripts/browser-serve.sh")
   }

   resource "coder_app" "browser_vision" {
     agent_id     = coder_agent.main.id
     slug         = "browser-vision"
     display_name = "Browser"
     url          = "http://localhost:6080"
     icon         = "/icon/terminal.svg"
     subdomain    = true
     share        = "owner"
   }
   ```

   Place them following the exact pattern from `templates/hive-worker/main.tf` lines 276-294.

3. Run `terraform validate` in each template directory:
   - `cd templates/hive-worker && terraform validate` (already has .terraform/)
   - `cd templates/hive-verifier && terraform validate` (already has .terraform/)
   - `cd templates/hive-council && terraform validate` (already has .terraform/)
   - For ai-dev: `cd templates/ai-dev && terraform init && terraform validate` (no .terraform/ cached — init needed first; requires network access to registry.coder.com)
   - If ai-dev terraform init fails due to network, document the failure but do not block slice completion — the other 3 templates validating is sufficient proof. ai-dev init is an environment constraint, not a code bug.

4. Run `npx vitest run` from the project root — expect 37 test files, 263 tests passed. These are orchestrator tests unrelated to Dockerfiles, so they must still pass.

## Must-Haves

- [ ] `templates/hive-council/scripts/browser-serve.sh` exists, is executable, references openbox
- [ ] `templates/hive-council/main.tf` contains `coder_script.browser_serve` and `coder_app.browser_vision`
- [ ] `terraform validate` passes for hive-worker, hive-verifier, hive-council
- [ ] `npx vitest run` passes (263 tests)

## Verification

- `test -x templates/hive-council/scripts/browser-serve.sh && grep -q openbox templates/hive-council/scripts/browser-serve.sh`
- `grep -q browser_serve templates/hive-council/main.tf && grep -q browser_vision templates/hive-council/main.tf`
- `cd templates/hive-worker && terraform validate && cd ../hive-verifier && terraform validate && cd ../hive-council && terraform validate`
- `npx vitest run 2>&1 | tail -5` — shows 263 tests passed

## Inputs

- `templates/hive-worker/scripts/browser-serve.sh`
- `templates/hive-worker/main.tf`
- `templates/hive-council/main.tf`

## Expected Output

- `templates/hive-council/scripts/browser-serve.sh`
- `templates/hive-council/main.tf`

## Verification

test -x templates/hive-council/scripts/browser-serve.sh && grep -q openbox templates/hive-council/scripts/browser-serve.sh && grep -q browser_serve templates/hive-council/main.tf && grep -q browser_vision templates/hive-council/main.tf && cd templates/hive-worker && terraform validate && cd ../hive-verifier && terraform validate && cd ../hive-council && terraform validate && cd ../.. && npx vitest run

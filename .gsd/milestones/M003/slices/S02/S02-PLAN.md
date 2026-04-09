# S02: Template Migration

**Goal:** All 4 template Dockerfiles are <20 lines each extending hive-base; docker build succeeds for all; terraform validate passes for all; 263 vitest tests still pass.
**Demo:** After this: all 4 template Dockerfiles are <20 lines each; `docker build` succeeds for all; `terraform validate` passes for all; 263 vitest tests still pass.

## Must-Haves

- All 4 Dockerfiles (hive-worker, hive-verifier, hive-council, ai-dev) contain only `FROM ghcr.io/kethalia/hive-base:latest` (no duplicated ubuntu:24.04 layers)
- All 3 existing browser-serve.sh scripts reference `openbox` instead of `fluxbox`
- hive-council has a new browser-serve.sh script and matching coder_script + coder_app in main.tf
- `terraform validate` passes for all 4 templates
- `npx vitest run` passes with 263 tests

## Proof Level

- This slice proves: Contract — terraform validate proves HCL correctness; docker build proves image layer resolution; vitest proves no regression.

## Integration Closure

- Upstream: `ghcr.io/kethalia/hive-base:latest` (from S01) — all Dockerfiles now depend on this published image
- New wiring: hive-council gains KasmVNC browser app (browser-serve.sh + coder_script + coder_app)
- Remaining for milestone: S03 adds Obsidian vault integration (autostart, cron sync, menu.xml) on top of these slim templates

## Verification

- None — this slice is infrastructure file replacement with no runtime behavior changes beyond fixing the window manager binary name.

## Tasks

- [x] **T01: Replace all 4 Dockerfiles with slim FROM-only files and fix fluxbox→openbox in browser-serve.sh** `est:15m`
  Replace all four 131-line ubuntu:24.04 Dockerfiles with minimal ~3-line files that just extend the shared base image. Also fix the window manager reference in all 3 existing browser-serve.sh scripts (fluxbox→openbox) since the base image ships openbox, not fluxbox.

## Steps

1. Replace `templates/hive-worker/Dockerfile` with:
   ```dockerfile
   FROM ghcr.io/kethalia/hive-base:latest
   ```
   (single line — no extra layers needed for S02)

2. Replace `templates/hive-verifier/Dockerfile` with the same single-line content.

3. Replace `templates/hive-council/Dockerfile` with the same single-line content.

4. Replace `templates/ai-dev/Dockerfile` with the same single-line content.

5. In `templates/hive-worker/scripts/browser-serve.sh`, change lines 63-64:
   - `if command -v fluxbox` → `if command -v openbox`
   - `nohup fluxbox -display ":${DISPLAY_NUM}" > "$LOG_DIR/fluxbox.log"` → `nohup openbox --sm-disable --display ":${DISPLAY_NUM}" > "$LOG_DIR/openbox.log"`
   Note: openbox uses `--sm-disable` flag to skip session management in containers, and `--display` not `-display`.

6. Apply the same fluxbox→openbox fix in `templates/hive-verifier/scripts/browser-serve.sh` (identical change).

7. Apply the same fluxbox→openbox fix in `templates/ai-dev/scripts/browser-serve.sh` (identical change).

## Must-Haves

- [ ] All 4 Dockerfiles are exactly 1 line: `FROM ghcr.io/kethalia/hive-base:latest`
- [ ] No Dockerfile references `ubuntu:24.04`
- [ ] All 3 browser-serve.sh files reference `openbox`, not `fluxbox`

## Verification

- `wc -l templates/*/Dockerfile` — each shows 1 line
- `grep -r 'ubuntu:24.04' templates/*/Dockerfile` — returns nothing
- `grep -r 'fluxbox' templates/*/scripts/browser-serve.sh` — returns nothing
- `grep -c 'openbox' templates/*/scripts/browser-serve.sh` — returns count > 0 for each
  - Files: `templates/hive-worker/Dockerfile`, `templates/hive-verifier/Dockerfile`, `templates/hive-council/Dockerfile`, `templates/ai-dev/Dockerfile`, `templates/hive-worker/scripts/browser-serve.sh`, `templates/hive-verifier/scripts/browser-serve.sh`, `templates/ai-dev/scripts/browser-serve.sh`
  - Verify: wc -l templates/*/Dockerfile && grep -r 'ubuntu:24.04' templates/*/Dockerfile; test $? -ne 0 && grep -r 'fluxbox' templates/*/scripts/browser-serve.sh; test $? -ne 0 && echo 'T01 PASS'

- [x] **T02: Wire KasmVNC into hive-council and verify all templates pass terraform validate + vitest** `est:20m`
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
  - Files: `templates/hive-council/scripts/browser-serve.sh`, `templates/hive-council/main.tf`
  - Verify: test -x templates/hive-council/scripts/browser-serve.sh && grep -q openbox templates/hive-council/scripts/browser-serve.sh && grep -q browser_serve templates/hive-council/main.tf && grep -q browser_vision templates/hive-council/main.tf && cd templates/hive-worker && terraform validate && cd ../hive-verifier && terraform validate && cd ../hive-council && terraform validate && cd ../.. && npx vitest run

## Files Likely Touched

- templates/hive-worker/Dockerfile
- templates/hive-verifier/Dockerfile
- templates/hive-council/Dockerfile
- templates/ai-dev/Dockerfile
- templates/hive-worker/scripts/browser-serve.sh
- templates/hive-verifier/scripts/browser-serve.sh
- templates/ai-dev/scripts/browser-serve.sh
- templates/hive-council/scripts/browser-serve.sh
- templates/hive-council/main.tf

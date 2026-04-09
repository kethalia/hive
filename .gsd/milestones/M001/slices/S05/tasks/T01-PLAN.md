---
estimated_steps: 5
estimated_files: 7
---

# T01: Create verifier Coder template and verification report types

**Slice:** S05 — Verifier Template & Proof-by-Consumption
**Milestone:** M001

## Description

Create the hive-verifier Coder workspace template by deriving from hive-worker, and define TypeScript types for verification reports. The verifier template needs the same Chrome/browser/Node.js tools as the worker but does NOT need AI tools (Pi/GSD) since it runs deterministic test steps, not an LLM agent. Also extend `BlueprintContext` with optional verifier-specific fields.

## Steps

1. **Copy hive-worker template to hive-verifier.** Copy the entire `templates/hive-worker/` directory to `templates/hive-verifier/`. This includes `main.tf`, `Dockerfile`, and `scripts/`.

2. **Modify `templates/hive-verifier/main.tf` variables.** Change the variable block:
   - Keep: `task_id`, `repo_url`, `branch_name`, `docker_socket`, `dotfiles_uri`
   - Remove: `task_prompt` (verifier doesn't need the prompt), `pi_api_key`, `pi_model`, `pi_provider` (no AI agent)
   - Update env block in `coder_agent.main`: keep `GIT_*` env vars and `HIVE_TASK_ID`, `HIVE_REPO_URL`, `HIVE_BRANCH_NAME`. Remove `HIVE_TASK_PROMPT`.
   - Remove `coder_script.tools_ai` resource (the `tools-ai.sh` script)
   - Remove `coder_app.pi` and `coder_app.gsd` resources (no AI agent apps)
   - Remove the `templatefile` call for `tools-ai.sh` in the script reference
   - Keep all browser/Chrome tools scripts, Node.js, CI tools, shell tools, symlinks, nvm
   - Keep `coder_external_auth.github`, `module.github-upload-public-key`, `module.git-commit-signing`, `module.git-config`

3. **Clean up verifier scripts directory.** Remove `templates/hive-verifier/scripts/tools-ai.sh` since it's no longer referenced. Keep all other scripts (they provide Chrome, Node.js, gh CLI, etc.).

4. **Create `src/lib/verification/report.ts`.** Define:
   ```typescript
   export type VerificationStrategy = "test-suite" | "web-app" | "static-site" | "none";
   export type VerificationOutcome = "pass" | "fail" | "inconclusive";
   export interface VerificationReport {
     strategy: VerificationStrategy;
     outcome: VerificationOutcome;
     logs: string;        // stdout/stderr from the verification execution
     durationMs: number;
     timestamp: string;   // ISO 8601
   }
   ```

5. **Extend `BlueprintContext` in `src/lib/blueprint/types.ts`.** Add these optional fields (must be optional to avoid breaking the worker pipeline):
   ```typescript
   /** Verification strategy detected by the verifier (set during verify-detect step). */
   verificationStrategy?: string;
   /** Structured verification report JSON (set during verify-report step). */
   verificationReport?: string;
   ```

## Must-Haves

- [ ] `templates/hive-verifier/main.tf` exists with `branch_name` variable and without `task_prompt`
- [ ] `templates/hive-verifier/scripts/tools-ai.sh` does NOT exist
- [ ] No `coder_app.pi` or `coder_app.gsd` in verifier main.tf
- [ ] `src/lib/verification/report.ts` exports `VerificationStrategy`, `VerificationOutcome`, `VerificationReport`
- [ ] `BlueprintContext` has optional `verificationStrategy` and `verificationReport` fields
- [ ] Existing worker tests still pass (BlueprintContext changes are backwards-compatible)

## Verification

- `test -f templates/hive-verifier/main.tf` — template file exists
- `grep -q 'variable "branch_name"' templates/hive-verifier/main.tf` — has branch_name variable
- `! grep -q 'task_prompt' templates/hive-verifier/main.tf` — no task_prompt
- `! grep -q 'coder_app.*pi' templates/hive-verifier/main.tf` — no Pi app
- `! grep -q 'coder_app.*gsd' templates/hive-verifier/main.tf` — no GSD app
- `! test -f templates/hive-verifier/scripts/tools-ai.sh` — AI tools script removed
- `test -f src/lib/verification/report.ts` — report types file exists
- `grep -q 'verificationStrategy' src/lib/blueprint/types.ts` — context extended
- `npx vitest run` — full suite passes (no regressions)

## Inputs

- `templates/hive-worker/` — source template to derive from
- `src/lib/blueprint/types.ts` — existing BlueprintContext interface to extend

## Expected Output

- `templates/hive-verifier/main.tf` — Coder template for verifier workspaces (no AI tools, has branch_name)
- `templates/hive-verifier/Dockerfile` — identical to worker Dockerfile (copied)
- `templates/hive-verifier/scripts/` — all worker scripts except tools-ai.sh
- `src/lib/verification/report.ts` — TypeScript types for verification reports
- `src/lib/blueprint/types.ts` — BlueprintContext with optional verifier fields added

---
id: T01
parent: S05
milestone: M001
provides:
  - hive-verifier Coder workspace template (no AI tools, has branch_name)
  - VerificationStrategy, VerificationOutcome, VerificationReport types
  - BlueprintContext extended with optional verifier fields
key_files:
  - templates/hive-verifier/main.tf
  - src/lib/verification/report.ts
  - src/lib/blueprint/types.ts
key_decisions:
  - Verifier template keeps browser/Chrome/Node.js tools but removes all AI tools (Pi, GSD, tools-ai.sh)
  - branch_name is required (no default) in verifier since it always verifies a specific branch
patterns_established:
  - Template derivation pattern: copy hive-worker, remove AI-specific resources, keep infrastructure
observability_surfaces:
  - VerificationReport type defines outcome field (pass/fail/inconclusive) for future DB persistence
duration: 15m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T01: Create verifier Coder template and verification report types

**Created hive-verifier Coder template derived from hive-worker (no AI tools) and defined VerificationReport TypeScript types with BlueprintContext extensions.**

## What Happened

Copied `templates/hive-worker/` to `templates/hive-verifier/` and stripped all AI-related resources: removed `task_prompt`, `pi_api_key`, `pi_model`, `pi_provider` variables; removed `HIVE_TASK_PROMPT` env var; removed `coder_script.tools_ai`, `coder_app.pi`, `coder_app.gsd` resources; deleted `scripts/tools-ai.sh`. Kept all browser/Chrome, Node.js, CI, shell, GitHub integration, and nvm resources. Made `branch_name` required (no default) since the verifier always targets a specific branch.

Created `src/lib/verification/report.ts` exporting `VerificationStrategy` (test-suite | web-app | static-site | none), `VerificationOutcome` (pass | fail | inconclusive), and `VerificationReport` interface with strategy, outcome, logs, durationMs, and timestamp fields.

Extended `BlueprintContext` in `src/lib/blueprint/types.ts` with optional `verificationStrategy` and `verificationReport` fields — backwards-compatible with all existing worker usage.

## Verification

All 9 structural checks pass (template exists, has branch_name, no task_prompt, no coder_app pi/gsd, no tools-ai.sh, report.ts exists, types extended). Full test suite passes: 16 test files, 79 tests, zero regressions.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `test -f templates/hive-verifier/main.tf` | 0 | ✅ pass | <1s |
| 2 | `grep -q 'variable "branch_name"' templates/hive-verifier/main.tf` | 0 | ✅ pass | <1s |
| 3 | `! grep -q 'task_prompt' templates/hive-verifier/main.tf` | 0 | ✅ pass | <1s |
| 4 | `! grep -q 'coder_app.*pi' templates/hive-verifier/main.tf` | 0 | ✅ pass | <1s |
| 5 | `! grep -q 'coder_app.*gsd' templates/hive-verifier/main.tf` | 0 | ✅ pass | <1s |
| 6 | `! test -f templates/hive-verifier/scripts/tools-ai.sh` | 0 | ✅ pass | <1s |
| 7 | `test -f src/lib/verification/report.ts` | 0 | ✅ pass | <1s |
| 8 | `grep -q 'verificationStrategy' src/lib/blueprint/types.ts` | 0 | ✅ pass | <1s |
| 9 | `npx vitest run` | 0 | ✅ pass | 2.6s |
| 10 | `test -d templates/hive-verifier && test -f templates/hive-verifier/main.tf` | 0 | ✅ pass | <1s |

## Diagnostics

- `templates/hive-verifier/main.tf` — inspect to verify variable set and resource list
- `src/lib/verification/report.ts` — import types to validate they compile
- `src/lib/blueprint/types.ts` — grep for `verificationStrategy` to confirm extension

## Deviations

- Made `branch_name` required (removed default "") in verifier template since the verifier always operates on a specific PR branch. Worker template retains the default.

## Known Issues

None.

## Files Created/Modified

- `templates/hive-verifier/main.tf` — Coder template for verifier workspaces, derived from hive-worker without AI tools
- `templates/hive-verifier/Dockerfile` — Identical copy of worker Dockerfile
- `templates/hive-verifier/scripts/` — All worker scripts except tools-ai.sh (removed)
- `src/lib/verification/report.ts` — VerificationStrategy, VerificationOutcome, VerificationReport types
- `src/lib/blueprint/types.ts` — Added optional verificationStrategy and verificationReport fields to BlueprintContext

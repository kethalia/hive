---
id: T02
parent: S02
milestone: M003
key_files:
  - templates/hive-council/scripts/browser-serve.sh
  - templates/hive-council/main.tf
key_decisions:
  - (none)
duration: 
verification_result: passed
completed_at: 2026-04-09T16:06:57.682Z
blocker_discovered: false
---

# T02: Added browser-serve.sh and Terraform KasmVNC wiring to hive-council; all 4 templates pass terraform validate and 263 vitest tests pass

**Added browser-serve.sh and Terraform KasmVNC wiring to hive-council; all 4 templates pass terraform validate and 263 vitest tests pass**

## What Happened

Copied templates/hive-worker/scripts/browser-serve.sh (already updated by T01 to use openbox) to templates/hive-council/scripts/browser-serve.sh and made it executable. Added coder_script.browser_serve and coder_app.browser_vision resources to templates/hive-council/main.tf after the coder_script.symlinks block, following the exact hive-worker pattern. All four templates validated successfully with terraform validate (ai-dev required terraform init first, which succeeded). The vitest suite ran cleanly: 37 test files, 263 tests passed.

## Verification

test -x + grep -q openbox confirmed script executable and openbox-referencing. grep confirmed both resources present in main.tf. terraform validate passed for hive-worker, hive-verifier, hive-council, and ai-dev. npx vitest run: 263 passed (263), 37 files.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `test -x templates/hive-council/scripts/browser-serve.sh && grep -q openbox templates/hive-council/scripts/browser-serve.sh` | 0 | ✅ pass | 20ms |
| 2 | `grep -q browser_serve templates/hive-council/main.tf && grep -q browser_vision templates/hive-council/main.tf` | 0 | ✅ pass | 20ms |
| 3 | `cd templates/hive-worker && terraform validate` | 0 | ✅ pass | 2000ms |
| 4 | `cd templates/hive-verifier && terraform validate` | 0 | ✅ pass | 2000ms |
| 5 | `cd templates/hive-council && terraform validate` | 0 | ✅ pass | 2000ms |
| 6 | `cd templates/ai-dev && terraform init && terraform validate` | 0 | ✅ pass | 15000ms |
| 7 | `npx vitest run 2>&1 | tail -5` | 0 | ✅ pass | 2500ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `templates/hive-council/scripts/browser-serve.sh`
- `templates/hive-council/main.tf`

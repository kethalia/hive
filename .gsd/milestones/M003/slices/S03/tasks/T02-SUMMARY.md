---
id: T02
parent: S03
milestone: M003
key_files:
  - templates/hive-worker/main.tf
  - templates/hive-worker/scripts/init.sh
  - templates/hive-verifier/main.tf
  - templates/hive-verifier/scripts/init.sh
  - templates/hive-council/main.tf
  - templates/hive-council/scripts/init.sh
  - templates/ai-dev/main.tf
  - templates/ai-dev/scripts/init.sh
key_decisions:
  - hive-worker and hive-verifier use plain env maps so VAULT_REPO added directly; hive-council and ai-dev use merge() so VAULT_REPO added inside first map argument
  - Added mkdir -p $HOME/.local/share before sync loop to ensure log directory exists on fresh workspaces
  - vault_repo uses default="" so terraform validate passes without providing a value
duration: 
verification_result: passed
completed_at: 2026-04-09T16:21:32.030Z
blocker_discovered: false
---

# T02: Added vault_repo Terraform variable, VAULT_REPO env injection, and vault clone/pull/sync block with 30-minute background push loop to all 4 workspace templates

**Added vault_repo Terraform variable, VAULT_REPO env injection, and vault clone/pull/sync block with 30-minute background push loop to all 4 workspace templates**

## What Happened

Read all 8 source files to confirm env patterns (plain map vs merge()) and init.sh structure before editing. Added vault_repo variable with default=\"\" to all 4 main.tf files, added vault_repo to each templatefile() call, added VAULT_REPO to each coder_agent env block (plain map for hive-worker/hive-verifier; inside first merge() map arg for hive-council/ai-dev). Inserted vault clone/pull/sync block in all 4 init.sh files outside the workspace_initialized guard: clones on first start, pulls on reconnect, background sync loop every 30min using & disown $!, push errors to ~/.local/share/vault-sync.log. Added mkdir -p ~/.local/share as a minor deviation to ensure the log directory exists on fresh workspaces.

## Verification

All grep checks pass (vault_repo in main.tf ×4, VAULT_REPO in main.tf ×4, vault sync in init.sh ×4, disown in hive-worker init.sh). terraform validate passes for all 4 templates. npx vitest run: 263 tests, 37 files, all passed.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `grep -q 'vault_repo' in all 4 main.tf files` | 0 | ✅ pass | 50ms |
| 2 | `grep -q 'VAULT_REPO' in all 4 main.tf files` | 0 | ✅ pass | 50ms |
| 3 | `grep -q 'vault sync' in all 4 init.sh files` | 0 | ✅ pass | 50ms |
| 4 | `grep -q 'disown' templates/hive-worker/scripts/init.sh` | 0 | ✅ pass | 20ms |
| 5 | `cd templates/hive-worker && terraform validate` | 0 | ✅ pass | 2800ms |
| 6 | `cd templates/hive-verifier && terraform validate` | 0 | ✅ pass | 2800ms |
| 7 | `cd templates/hive-council && terraform validate` | 0 | ✅ pass | 2800ms |
| 8 | `cd templates/ai-dev && terraform validate` | 0 | ✅ pass | 2800ms |
| 9 | `npx vitest run (263 tests, 37 files)` | 0 | ✅ pass | 3400ms |

## Deviations

Added `mkdir -p "$HOME/.local/share"` before the background sync loop in each init.sh. The plan did not include this, but vault-sync.log writes would fail on fresh workspaces without it. No other deviations.

## Known Issues

None.

## Files Created/Modified

- `templates/hive-worker/main.tf`
- `templates/hive-worker/scripts/init.sh`
- `templates/hive-verifier/main.tf`
- `templates/hive-verifier/scripts/init.sh`
- `templates/hive-council/main.tf`
- `templates/hive-council/scripts/init.sh`
- `templates/ai-dev/main.tf`
- `templates/ai-dev/scripts/init.sh`

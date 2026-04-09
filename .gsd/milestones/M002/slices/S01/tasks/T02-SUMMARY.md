---
id: T02
parent: S01
milestone: M002
key_files:
  - templates/hive-council/main.tf
  - templates/hive-council/Dockerfile
  - templates/hive-council/scripts/init.sh
  - templates/hive-council/scripts/claude-install.sh
  - templates/hive-council/scripts/tools-shell.sh
  - templates/hive-council/scripts/tools-node.sh
  - templates/hive-council/scripts/tools-nvm.sh
  - templates/hive-council/scripts/tools-ci.sh
  - templates/hive-council/scripts/symlinks.sh
  - templates/hive-council/.terraform.lock.hcl
key_decisions:
  - claude-install.sh copied verbatim from templates/ai-dev — already uses claude_api_key template variable as required
  - merge({base_env}, condition ? {KEY=val} : {}) pattern used for conditional ANTHROPIC_API_KEY injection in coder_agent.env
duration: 
verification_result: passed
completed_at: 2026-04-09T08:23:29.105Z
blocker_discovered: false
---

# T02: Created templates/hive-council/ Terraform template from hive-verifier with Claude CLI support, anthropic_api_key variable, conditional ANTHROPIC_API_KEY env injection, no browser tools — terraform validate passes

**Created templates/hive-council/ Terraform template from hive-verifier with Claude CLI support, anthropic_api_key variable, conditional ANTHROPIC_API_KEY env injection, no browser tools — terraform validate passes**

## What Happened

Built hive-council template by adapting hive-verifier. Six scripts copied as-is (Dockerfile, tools-shell, tools-node, tools-nvm, tools-ci, symlinks, .terraform.lock.hcl). claude-install.sh copied from templates/ai-dev (already uses claude_api_key template variable). init.sh updated: README says "council reviewer workspace", browser docs removed, .opencode/bin removed from PATH. main.tf changes: added anthropic_api_key variable (sensitive=true), changed env to merge() with conditional ANTHROPIC_API_KEY injection, added claude_install coder_script, removed tools_browser/browser_serve scripts and browser_vision coder_app, renamed preset to hive-council. terraform init and validate both pass.

## Verification

terraform init succeeded (coder/coder v2.15.0, kreuzwerker/docker v3.6.2, three git modules). terraform validate returned 'Success! The configuration is valid.' Grep confirmed no browser references in main.tf. anthropic_api_key has sensitive=true. Workspace preset named hive-council with instances=1. ANTHROPIC_API_KEY merge pattern present.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cd templates/hive-council && terraform init` | 0 | ✅ pass | 6100ms |
| 2 | `cd templates/hive-council && terraform validate` | 0 | ✅ pass | 1000ms |
| 3 | `grep -i browser templates/hive-council/main.tf` | 1 | ✅ pass | 50ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `templates/hive-council/main.tf`
- `templates/hive-council/Dockerfile`
- `templates/hive-council/scripts/init.sh`
- `templates/hive-council/scripts/claude-install.sh`
- `templates/hive-council/scripts/tools-shell.sh`
- `templates/hive-council/scripts/tools-node.sh`
- `templates/hive-council/scripts/tools-nvm.sh`
- `templates/hive-council/scripts/tools-ci.sh`
- `templates/hive-council/scripts/symlinks.sh`
- `templates/hive-council/.terraform.lock.hcl`

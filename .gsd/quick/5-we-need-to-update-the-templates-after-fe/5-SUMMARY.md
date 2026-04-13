# Quick Task: Sync CLAUDE.md, AGENTS.md, and Skills after every vault fetch

**Date:** 2026-04-13
**Branch:** feat/hive-template-params

## What Changed
- Added vault config sync (CLAUDE.md, AGENTS.md, Skills) to the `post_clone_script` in both hive and ai-dev `main.tf` — previously only rsync ran, leaving config files stale until next restart
- Aligned init.sh vault sync logic across both templates to use directory-based skill sync (vault/Skills/ directories instead of flat .md files)
- Updated init.sh comments to document the dual-path sync design (startup path + post-fetch path)
- Updated sync-vault.sh comments to reflect the post_clone_script integration
- Synced CLAUDE.md content across both templates

## Files Modified
- `templates/hive/main.tf` — post_clone_script now syncs CLAUDE.md, AGENTS.md, Skills after rsync
- `templates/ai-dev/main.tf` — same post_clone_script sync logic
- `templates/hive/scripts/init.sh` — aligned vault sync logic, updated comments
- `templates/ai-dev/scripts/init.sh` — aligned vault sync logic, updated comments
- `templates/hive/scripts/sync-vault.sh` — updated header comments
- `templates/ai-dev/scripts/sync-vault.sh` — updated header comments
- `templates/hive/CLAUDE.md` — synced content
- `templates/ai-dev/CLAUDE.md` — synced content

## Verification
- Both templates have identical post_clone_script, sync-vault.sh, and init.sh vault sync logic (verified via diff)
- Terraform formatting validated with `terraform fmt`
- No `${...}` bash patterns in post_clone_script (uses `$VAR` to avoid Terraform interpolation)

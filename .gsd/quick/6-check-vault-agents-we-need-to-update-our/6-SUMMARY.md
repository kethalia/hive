# Quick Task: Update CLAUDE.md and AGENTS.md cloning strategy to use vault/Agents/

**Date:** 2026-04-14
**Branch:** main

## What Changed
- Changed sync-vault.sh to source CLAUDE.md and AGENTS.md from `~/vault/Agents/` instead of `~/vault/` root
- Both files now sync to `~/.claude/` AND `~/.gsd/agent/` (previously only `~/.claude/`)
- Extracted common `sync_file` helper to DRY up the multi-target sync logic
- Updated init.sh fallback check path in both templates to `~/vault/Agents/CLAUDE.md`
- Updated test suite to use `vault/Agents/` source path and verify GSD target

## Files Modified
- `templates/hive/scripts/sync-vault.sh` — new source path + dual-target sync
- `templates/ai-dev/scripts/sync-vault.sh` — identical copy
- `templates/hive/scripts/init.sh` — fallback check path
- `templates/ai-dev/scripts/init.sh` — fallback check path
- `src/__tests__/lib/templates/sync-vault.test.ts` — updated for Agents/ source and GSD target assertions

## Verification
- All 15 sync-vault tests pass
- Both template sync scripts are identical (verified with diff)

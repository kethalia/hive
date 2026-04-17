# Quick Task: Fix template skills copy path

**Date:** 2026-04-16
**Branch:** fix/skills-copy-path

## What Changed
- Changed `sync_skills()` target from `~/.claude/skills/vault/` to `~/.claude/skills/` in both hive and ai-dev templates
- Changed `link_gsd_skills()` symlink from `~/.gsd/agent/skills/vault` to `~/.gsd/agent/skills` in both templates
- Fixed `mkdir -p` in `link_gsd_skills()` to create parent `$GSD_DIR` instead of `$GSD_DIR/skills` (which would conflict with the symlink)
- Updated all test expectations to match the new paths

## Files Modified
- `templates/hive/scripts/sync-vault.sh`
- `templates/ai-dev/scripts/sync-vault.sh`
- `src/__tests__/lib/templates/sync-vault.test.ts`

## Verification
- All 15 sync-vault tests pass

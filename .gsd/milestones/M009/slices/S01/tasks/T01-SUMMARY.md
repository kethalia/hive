---
id: T01
parent: S01
milestone: M009
key_files:
  - templates/hive/scripts/sync-vault.sh
  - templates/ai-dev/scripts/sync-vault.sh
key_decisions:
  - Used AGENTS_CONV_DIR (not AGENTS_DIR) to avoid collision with existing AGENTS_SRC variable
  - Per-directory manifest cleanup rather than shared manifest — each target independently tracks and prunes its own vault-managed skills
duration: 
verification_result: passed
completed_at: 2026-04-18T14:15:21.898Z
blocker_discovered: false
---

# T01: Refactor sync-vault.sh to copy skills, CLAUDE.md, and AGENTS.md to three independent directories with no symlinks

**Refactor sync-vault.sh to copy skills, CLAUDE.md, and AGENTS.md to three independent directories with no symlinks**

## What Happened

Updated sync-vault.sh to sync vault files to three independent target directories (~/.claude/, ~/.agents/, ~/.pi/agent/) instead of the previous two (~/.claude/, ~/.gsd/agent/).

Changes made:
1. Replaced `GSD_DIR="$HOME/.gsd/agent"` with `AGENTS_CONV_DIR="$HOME/.agents"` and `PI_DIR="$HOME/.pi/agent"`.
2. Updated `sync_claude_md()` and `sync_agents_md()` to target all three directories via the existing `sync_file()` helper.
3. Refactored `sync_skills()` from a single-target function to a loop over `SKILL_TARGETS=("$CLAUDE_DIR/skills" "$AGENTS_CONV_DIR/skills" "$PI_DIR/skills")`. Each target gets its own manifest-based stale cleanup, hash-compared sync, and manifest write — fully independent per directory.
4. Deleted `link_gsd_skills()` entirely (29 lines of symlink logic removed).
5. Removed the `link_gsd_skills` call from the main execution block.
6. Copied the updated script to `templates/ai-dev/scripts/sync-vault.sh` to maintain byte-identical copies.

## Verification

Ran three verification checks: (1) `diff` confirmed both template copies are byte-identical, (2) grep confirmed zero references to symlink/ln -s/readlink/link_gsd in the script, (3) `bash -n` confirmed valid bash syntax.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `diff templates/hive/scripts/sync-vault.sh templates/ai-dev/scripts/sync-vault.sh` | 0 | ✅ pass | 50ms |
| 2 | `test $(grep -c 'symlink|ln -s|readlink|link_gsd' templates/hive/scripts/sync-vault.sh) -eq 0` | 0 | ✅ pass | 30ms |
| 3 | `bash -n templates/hive/scripts/sync-vault.sh` | 0 | ✅ pass | 20ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `templates/hive/scripts/sync-vault.sh`
- `templates/ai-dev/scripts/sync-vault.sh`

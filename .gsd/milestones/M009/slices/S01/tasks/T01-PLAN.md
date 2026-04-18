---
estimated_steps: 19
estimated_files: 2
skills_used: []
---

# T01: Update sync-vault.sh for multi-target sync and remove symlink logic

The script currently targets ~/.claude/ and ~/.gsd/agent/ for context files and only ~/.claude/skills/ for skills, with a symlink for GSD. Must change to 3 independent copy targets with no symlinks.

Key changes to `templates/hive/scripts/sync-vault.sh` (190 lines):

1. **Replace constants** (line 21-22): Remove `GSD_DIR="$HOME/.gsd/agent"`. Add `AGENTS_CONV_DIR="$HOME/.agents"` and `PI_DIR="$HOME/.pi/agent"`.

2. **Update sync_claude_md()** (line 57-59): Change targets from `"$CLAUDE_DIR" "$GSD_DIR"` to `"$CLAUDE_DIR" "$AGENTS_CONV_DIR" "$PI_DIR"`. The `sync_file()` helper already accepts multiple targets, so this is a one-line edit.

3. **Update sync_agents_md()** (line 64-66): Same one-line change as above.

4. **Refactor sync_skills()** (line 72-139): Currently hardcoded to `$CLAUDE_DIR/skills`. Refactor to loop over `SKILL_TARGETS=("$CLAUDE_DIR/skills" "$AGENTS_CONV_DIR/skills" "$PI_DIR/skills")`. Each target needs its own:
   - `mkdir -p`
   - `.vault-managed` manifest read for stale cleanup
   - Stale skill removal pass
   - Copy of each skill directory (with hash comparison)
   - `.vault-managed` manifest write
   The hash comparison and copy logic stays the same per-target. Extract the per-target logic into the loop body.

5. **Delete link_gsd_skills()** (lines 146-174): Remove the entire function.

6. **Update main block** (lines 178-189): Remove the `link_gsd_skills` call (line 183).

7. **Copy to ai-dev**: `cp templates/hive/scripts/sync-vault.sh templates/ai-dev/scripts/sync-vault.sh`

Constraints:
- Script must remain POSIX-compatible bash with `set -euo pipefail`
- Variable name `AGENTS_CONV_DIR` (not `AGENTS_DIR`) to avoid confusion with `AGENTS_SRC` (vault source path) already at line 19
- Both template copies must be byte-identical after changes

## Inputs

- ``templates/hive/scripts/sync-vault.sh` — current script to modify (190 lines)`
- ``templates/ai-dev/scripts/sync-vault.sh` — must be byte-identical copy after changes`

## Expected Output

- ``templates/hive/scripts/sync-vault.sh` — updated with 3-target sync, no symlinks`
- ``templates/ai-dev/scripts/sync-vault.sh` — byte-identical copy of hive version`

## Verification

diff templates/hive/scripts/sync-vault.sh templates/ai-dev/scripts/sync-vault.sh && test $(grep -c 'symlink\|ln -s\|readlink\|link_gsd' templates/hive/scripts/sync-vault.sh) -eq 0

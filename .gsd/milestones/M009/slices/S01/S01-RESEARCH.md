# S01 — Multi-target vault sync — Research

**Date:** 2026-04-18
**Depth:** Light research — straightforward script changes to well-understood code.

## Summary

The current `sync-vault.sh` syncs CLAUDE.md and AGENTS.md to two targets (`~/.claude/`, `~/.gsd/agent/`) and skills to one target (`~/.claude/skills/`), then creates a symlink at `~/.gsd/agent/skills → ~/.claude/skills`. The change is mechanical: replace `~/.gsd/agent/` with `~/.agents/` and `~/.pi/agent/` as additional targets, extend `sync_skills()` to copy to all three skill directories with per-directory manifests, and delete `link_gsd_skills()` entirely.

Both template copies (hive, ai-dev) are currently byte-identical — confirmed via `diff`. The test file has 14 tests in 4 describe blocks; the "GSD skills symlink" block (4 tests) will be replaced with tests for multi-target skills and the absence of symlinks.

## Recommendation

Single-pass implementation: update the script's target constants, modify `sync_claude_md()` and `sync_agents_md()` to target all 3 directories, refactor `sync_skills()` to loop over 3 skill targets, delete `link_gsd_skills()`, then update tests. No architectural decisions needed — the `sync_file()` helper already accepts multiple targets, so CLAUDE.md/AGENTS.md changes are one-line edits. Skills require a loop over targets since each needs its own manifest and cleanup.

## Implementation Landscape

### Key Files

- `templates/hive/scripts/sync-vault.sh` (190 lines) — the script to modify. Key functions:
  - `sync_file()` (L30-52) — already multi-target, used by CLAUDE.md and AGENTS.md sync. No changes needed.
  - `sync_claude_md()` (L57-59) — add `"$AGENTS_CONV_DIR"` and `"$PI_DIR"` as targets. One-line change.
  - `sync_agents_md()` (L64-66) — same one-line change.
  - `sync_skills()` (L72-139) — currently hardcoded to `$CLAUDE_DIR/skills`. Needs refactoring to loop over 3 skill target directories, each with its own `.vault-managed` manifest and independent cleanup.
  - `link_gsd_skills()` (L146-174) — delete entirely.
  - Main block (L178-189) — remove `link_gsd_skills` call.
- `templates/ai-dev/scripts/sync-vault.sh` — must be an exact copy of hive version after changes.
- `src/__tests__/lib/templates/sync-vault.test.ts` (310 lines) — test file. Key changes:
  - `beforeEach`: add `agentsConvDir` and `piDir` temp directories (alongside existing `claudeDir`, `gsdDir`).
  - CLAUDE.md tests (L48-96): assert content in all 3 targets instead of 2. Remove `gsdDir` references, add `agentsConvDir` and `piDir`.
  - AGENTS.md tests (L101-135): same pattern.
  - Skills tests (L139-238): add tests verifying skills land in all 3 skill directories, each with independent `.vault-managed` manifest and independent stale cleanup.
  - GSD symlink tests (L243-309): delete entire describe block. Replace with a test asserting no symlinks exist in any target.

### Build Order

1. **Update script constants and context file sync** — Add `AGENTS_CONV_DIR="$HOME/.agents"` and `PI_DIR="$HOME/.pi/agent"` constants. Update `sync_claude_md()` and `sync_agents_md()` to pass all 3 targets to `sync_file()`. Remove `GSD_DIR` constant. This is trivial and unblocks test updates.

2. **Refactor `sync_skills()` for multi-target** — Extract the skill sync logic into a loop over `SKILL_TARGETS=("$CLAUDE_DIR/skills" "$AGENTS_CONV_DIR/skills" "$PI_DIR/skills")`. Each target gets its own `.vault-managed` manifest, its own stale cleanup pass, and its own copy of each skill directory. The hash comparison and copy logic stays the same per-target.

3. **Delete `link_gsd_skills()`** — Remove the function (L146-174) and its call (L183). Straightforward deletion.

4. **Copy script to ai-dev** — `cp templates/hive/scripts/sync-vault.sh templates/ai-dev/scripts/sync-vault.sh`

5. **Update tests** — Rewrite test assertions for 3 targets, delete symlink test block, add per-directory manifest tests.

### Verification Approach

```bash
# Run existing + new tests
pnpm vitest run src/__tests__/lib/templates/sync-vault.test.ts

# Verify both template scripts are identical
diff templates/hive/scripts/sync-vault.sh templates/ai-dev/scripts/sync-vault.sh

# Verify no symlink references remain in the script
grep -c "symlink\|ln -s\|readlink\|link_gsd" templates/hive/scripts/sync-vault.sh
# Expected: 0
```

## Constraints

- Script must remain POSIX-compatible bash with `set -euo pipefail`
- Both template copies must be byte-identical after changes
- Variable name `AGENTS_CONV_DIR` (not `AGENTS_DIR`) to avoid confusion with `AGENTS_SRC` (vault source path) already defined at L19

## Requirements Coverage

| Requirement | How Addressed |
|-------------|---------------|
| R082 — Skills to 3 directories | `sync_skills()` loops over 3 skill targets |
| R083 — CLAUDE.md/AGENTS.md to 3 directories | `sync_file()` called with 3 targets |
| R084 — No symlinks | `link_gsd_skills()` deleted |
| R085 — GSD symlink logic removed | Function and invocation deleted |
| R086 — Both templates identical | cp after edit, verified by diff |
| R087 — Per-directory manifest cleanup | Each skill target has independent `.vault-managed` |

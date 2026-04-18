---
id: S01
parent: M009
milestone: M009
provides:
  - (none)
requires:
  []
affects:
  []
key_files:
  - (none)
key_decisions:
  - ["AGENTS_CONV_DIR naming (not AGENTS_DIR) to avoid collision with existing AGENTS_SRC variable", "Per-directory manifest cleanup — each target independently tracks and prunes its own vault-managed skills", "Replaced 4 symlink tests with single recursive no-symlink assertion walking all target directories"]
patterns_established:
  - ["SKILL_TARGETS array loop for multi-directory sync — extensible if new tool directories are added"]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-18T14:18:25.509Z
blocker_discovered: false
---

# S01: Multi-target vault sync

**sync-vault.sh now copies skills, CLAUDE.md, and AGENTS.md to three independent directories (~/.claude/, ~/.agents/, ~/.pi/agent/) with no symlinks and per-directory manifest cleanup.**

## What Happened

This slice refactored sync-vault.sh to support three independent copy targets instead of two, and eliminated all symlink logic.

**T01 — Script refactor:** Replaced `GSD_DIR="$HOME/.gsd/agent"` with `AGENTS_CONV_DIR="$HOME/.agents"` and `PI_DIR="$HOME/.pi/agent"`. Updated `sync_claude_md()` and `sync_agents_md()` to pass all three targets to the existing `sync_file()` helper. Refactored `sync_skills()` from a single-target function to a loop over `SKILL_TARGETS=("$CLAUDE_DIR/skills" "$AGENTS_CONV_DIR/skills" "$PI_DIR/skills")` — each target gets its own `mkdir -p`, `.vault-managed` manifest read/write, stale skill removal pass, and hash-compared copy pass. Deleted `link_gsd_skills()` entirely (29 lines of symlink logic removed) and its call from the main block. Copied the updated script to `templates/ai-dev/scripts/sync-vault.sh` to maintain byte-identical copies.

**T02 — Test rewrite:** Rewrote `sync-vault.test.ts` to match the new 3-target behavior. Replaced all `gsdDir` references with `agentsConvDir` and `piDir`. CLAUDE.md, AGENTS.md, and Skills tests now assert content lands in all 3 targets. Added two new tests: independent per-directory `.vault-managed` manifests and independent per-directory stale cleanup. Deleted the 4-test GSD symlink describe block and replaced it with a recursive `lstat`-based no-symlink assertion across all targets. Tests do not pre-create `agentsConvDir` or `piDir` — the script's `mkdir -p` handles that, which the tests implicitly verify. Final count: 16 tests passing.

## Verification

All three slice-level verification checks passed:

1. **Tests pass:** `pnpm vitest run src/__tests__/lib/templates/sync-vault.test.ts` — 16/16 tests passed (150ms)
2. **Templates identical:** `diff templates/hive/scripts/sync-vault.sh templates/ai-dev/scripts/sync-vault.sh` — no diff
3. **No symlink references:** `grep -c 'symlink|ln -s|readlink|link_gsd' templates/hive/scripts/sync-vault.sh` — returns 0

## Requirements Advanced

None.

## Requirements Validated

- R082 — Skills land in ~/.claude/skills/, ~/.agents/skills/, ~/.pi/agent/skills/ — verified by 16 passing tests
- R083 — CLAUDE.md and AGENTS.md copied to all 3 directories — verified by tests asserting content in claudeDir, agentsConvDir, piDir
- R084 — No symlinks — recursive lstat test walks all targets asserting zero symlinks
- R085 — link_gsd_skills() deleted entirely — grep returns 0 matches for symlink/ln -s/readlink/link_gsd
- R086 — diff between hive and ai-dev templates returns empty — byte-identical
- R087 — Independent per-directory .vault-managed manifests — dedicated test verifies stale cleanup in one target doesn't affect others

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

None.

## Known Limitations

None.

## Follow-ups

None.

## Files Created/Modified

- `templates/hive/scripts/sync-vault.sh` — Refactored for 3-target sync, deleted link_gsd_skills()
- `templates/ai-dev/scripts/sync-vault.sh` — Byte-identical copy of hive template
- `src/__tests__/lib/templates/sync-vault.test.ts` — Rewrote for 3-target assertions, no-symlink verification, 16 tests

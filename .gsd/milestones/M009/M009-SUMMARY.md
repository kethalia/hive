---
id: M009
title: "Multi-Target Vault Sync"
status: complete
completed_at: 2026-04-18T14:23:22.438Z
key_decisions:
  - D036: Three independent copy targets (~/.claude/, ~/.agents/, ~/.pi/agent/) — no symlinks. Direct copies are more robust across container mounts and tool path resolution.
  - D037: Delete link_gsd_skills() entirely — GSD discovers skills from ~/.claude/ or ~/.agents/, making the dedicated ~/.gsd/agent/skills symlink unnecessary.
key_files:
  - templates/hive/scripts/sync-vault.sh
  - templates/ai-dev/scripts/sync-vault.sh
  - src/__tests__/lib/templates/sync-vault.test.ts
lessons_learned:
  - SKILL_TARGETS array loop pattern is extensible — adding a new tool directory requires only appending to the array, not modifying sync logic.
  - Per-directory manifests prevent cross-contamination during cleanup — each target independently tracks its own vault-managed files, so user-created content is never touched.
  - Naming variable AGENTS_CONV_DIR (not AGENTS_DIR) avoids collision with existing AGENTS_SRC variable — check for naming conflicts before introducing new globals in shell scripts.
---

# M009: Multi-Target Vault Sync

**sync-vault.sh now copies skills, CLAUDE.md, and AGENTS.md to three independent directories (~/.claude/, ~/.agents/, ~/.pi/agent/) with no symlinks and per-directory manifest cleanup.**

## What Happened

M009 refactored the vault sync script to support three independent copy targets instead of two, and eliminated all symlink logic.

The previous sync-vault.sh copied skills to ~/.claude/skills/ and created symlinks at ~/.gsd/agent/skills/. CLAUDE.md went to ~/.claude/ and AGENTS.md to ~/.agents/. This left gaps: Pi couldn't discover skills (no ~/.pi/agent/skills/), and the symlink at ~/.gsd/agent/ was fragile across container mounts.

S01 replaced the 2-target architecture with a 3-target loop: ~/.claude/, ~/.agents/, and ~/.pi/agent/ all receive independent copies of skills, CLAUDE.md, and AGENTS.md. The SKILL_TARGETS array pattern makes adding future directories trivial. Each target directory maintains its own .vault-managed manifest for independent stale skill cleanup — removing a skill from one target never affects another.

The link_gsd_skills() function (29 lines of symlink logic) was deleted entirely. GSD discovers skills through ~/.claude/ or ~/.agents/ — the dedicated symlink was a workaround no longer needed.

Both template copies (hive and ai-dev) were updated and verified byte-identical. The test suite was rewritten from scratch for the new 3-target behavior: 16 tests covering skill copying, context file distribution, no-symlink assertion via recursive lstat, and independent per-directory manifest cleanup.

## Success Criteria Results

- [x] **Skills in 3 directories**: 16 passing tests assert skills land in ~/.claude/skills/, ~/.agents/skills/, ~/.pi/agent/skills/
- [x] **Context files in 3 directories**: Tests assert CLAUDE.md and AGENTS.md content in all 3 targets
- [x] **No symlinks**: Recursive lstat test walks all targets — zero symlinks found
- [x] **Symlink logic removed**: grep returns 0 matches for symlink/ln -s/readlink/link_gsd in sync-vault.sh
- [x] **Templates identical**: diff between hive and ai-dev returns empty
- [x] **Per-directory cleanup**: Dedicated test verifies stale cleanup in one target doesn't affect others

## Definition of Done Results

- [x] All slices complete: S01 ✅ (only slice)
- [x] Slice summary exists: S01-SUMMARY.md present
- [x] All requirements validated: R082-R087 all validated with test evidence
- [x] Code changes verified: 3 files modified (249 insertions, 285 deletions)
- [x] Tests passing: 16/16 tests pass in 142ms

## Requirement Outcomes

- **R082** (new → validated): Skills land in ~/.claude/skills/, ~/.agents/skills/, ~/.pi/agent/skills/ — verified by 16 passing tests
- **R083** (new → validated): CLAUDE.md and AGENTS.md copied to all 3 directories — verified by test assertions in claudeDir, agentsConvDir, piDir
- **R084** (new → validated): No symlinks — recursive lstat test walks all targets asserting zero symlinks
- **R085** (new → validated): link_gsd_skills() deleted — grep returns 0 matches for symlink/ln -s/readlink/link_gsd
- **R086** (new → validated): Templates byte-identical — diff returns empty
- **R087** (new → validated): Per-directory .vault-managed manifests — dedicated test verifies independent cleanup

## Deviations

None.

## Follow-ups

None.

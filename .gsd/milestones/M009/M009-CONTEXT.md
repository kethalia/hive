# M009: Multi-Target Vault Sync

**Gathered:** 2026-04-18
**Status:** Ready for planning

## Project Description

Fix `sync-vault.sh` to sync vault skills and context files (AGENTS.md, CLAUDE.md) to three independent directories instead of two, removing the GSD symlink pattern entirely.

## Why This Milestone

The current `sync-vault.sh` only copies skills to `~/.claude/skills/` and symlinks to `~/.gsd/agent/skills`. GSD's `init` command installs skills to `~/.agents/skills/` (cross-tool convention) and `~/.pi/agent/skills/` (Pi coding agent), but the vault sync doesn't cover these directories. Skills from the vault are not discovered by Pi or tools using the `.agents/` convention.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Run `sync-vault.sh` and see vault skills appear in `~/.claude/skills/`, `~/.agents/skills/`, and `~/.pi/agent/skills/`
- See AGENTS.md and CLAUDE.md in `~/.claude/`, `~/.agents/`, and `~/.pi/agent/`
- Verify no symlinks exist — all targets contain independent copies

### Entry point / environment

- Entry point: `bash ~/sync-vault.sh` (called automatically by init.sh and post_clone_script)
- Environment: Coder workspace (both hive and ai-dev templates)
- Live dependencies involved: `~/vault` (Obsidian vault clone)

## Completion Class

- Contract complete means: tests verify all 3 targets receive skills and context files, no symlinks, manifest cleanup works per-directory
- Integration complete means: script runs successfully in a Coder workspace with a real vault
- Operational complete means: none — script is idempotent and called at workspace init

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- `sync-vault.sh` copies skills to all 3 target directories with correct content
- AGENTS.md and CLAUDE.md land in all 3 target directories
- Stale skill cleanup via `.vault-managed` works independently per target
- No symlinks exist in the output (link_gsd_skills removed)
- Both template variants (hive + ai-dev) have identical scripts
- All existing and new tests pass

## Architectural Decisions

### Direct copies over symlinks for all targets

**Decision:** Copy skills and context files independently to each target directory, no symlinks anywhere.

**Rationale:** Symlinks break when the source doesn't exist, when tools resolve paths differently, or when container mounts don't follow symlinks. Independent copies are more robust.

**Alternatives Considered:**
- Symlinks from `.agents/` and `.pi/agent/` to `.claude/` — fragile across tools and mounts
- Single canonical location with all tools configured to read from it — requires configuring each tool, not always possible

### Three target directories

**Decision:** `~/.claude/`, `~/.agents/`, `~/.pi/agent/` are the three sync targets.

**Rationale:** Claude Code reads `~/.claude/`, Pi reads `~/.pi/agent/`, and `~/.agents/` is the cross-tool convention (GSD init canonical). These are the directories where AI tools discover skills and context files.

**Alternatives Considered:**
- Also sync to `~/.gsd/agent/` — GSD reads from `.claude/` or `.agents/`, no dedicated copy needed

### Remove GSD symlink logic entirely

**Decision:** Delete the `link_gsd_skills()` function and its invocation.

**Rationale:** GSD discovers skills through `~/.claude/skills/` or `~/.agents/skills/`. The dedicated symlink at `~/.gsd/agent/skills` was a workaround that's no longer needed with multi-target direct copies.

## Error Handling Strategy

The script already handles errors gracefully: missing vault skips sync, missing source files skip individual copies, hash comparison prevents unnecessary overwrites. The same pattern extends to all 3 targets — if a target directory can't be created (permissions), the script fails fast via `set -euo pipefail`.

## Risks and Unknowns

- None significant — this is a well-understood script change with clear inputs and outputs

## Existing Codebase / Prior Art

- `templates/hive/scripts/sync-vault.sh` — current script (190 lines), syncs to 2 targets + GSD symlink
- `templates/ai-dev/scripts/sync-vault.sh` — identical copy of the hive script
- `src/__tests__/lib/templates/sync-vault.test.ts` — 14 existing tests covering CLAUDE.md, AGENTS.md, skills, and GSD symlink
- `templates/hive/scripts/init.sh` — calls sync-vault.sh at workspace init
- `templates/ai-dev/scripts/init.sh` — same for ai-dev template

## Relevant Requirements

- R082 — Vault skills copied to all 3 skill directories
- R083 — CLAUDE.md and AGENTS.md copied to all 3 root directories
- R084 — No symlinks in vault sync
- R085 — GSD agent skills symlink logic removed
- R086 — Both template variants identical
- R087 — Per-directory manifest-based cleanup

## Scope

### In Scope

- Update sync-vault.sh to add `~/.agents/` and `~/.pi/agent/` as targets for CLAUDE.md and AGENTS.md
- Update sync_skills() to sync to all 3 skill directories with per-directory manifests
- Remove link_gsd_skills() function entirely
- Update sync_claude_md() and sync_agents_md() to target all 3 directories
- Keep both template copies identical
- Update tests to cover all 3 targets and remove GSD symlink tests

### Out of Scope / Non-Goals

- Changes to init.sh or main.tf
- Changes to how tools discover or read skills
- Adding new skills to the vault

## Technical Constraints

- Script must remain POSIX-compatible bash (set -euo pipefail)
- Both template copies must be byte-identical after changes
- Existing hash-based change detection must work for all 3 targets independently

## Integration Points

- `~/vault/Skills/` — source of skill directories
- `~/vault/Agents/CLAUDE.md` and `~/vault/Agents/AGENTS.md` — source of context files
- `init.sh` — calls sync-vault.sh (no changes needed)
- `main.tf` post_clone_script — calls sync-vault.sh (no changes needed)

## Testing Requirements

- Update existing tests to verify 3 targets instead of 2 for CLAUDE.md and AGENTS.md
- Add tests for `~/.agents/skills/` and `~/.pi/agent/skills/` skill sync
- Add tests for per-directory manifest cleanup across all 3 skill targets
- Remove GSD symlink test section entirely
- Verify user-created skills preserved in all 3 directories independently

## Acceptance Criteria

### S01: Multi-target vault sync
- `sync-vault.sh` copies CLAUDE.md to `~/.claude/`, `~/.agents/`, `~/.pi/agent/`
- `sync-vault.sh` copies AGENTS.md to `~/.claude/`, `~/.agents/`, `~/.pi/agent/`
- Skills synced to `~/.claude/skills/`, `~/.agents/skills/`, `~/.pi/agent/skills/`
- Each skill directory has its own `.vault-managed` manifest
- Stale skill removal works per-directory
- User-created skills preserved per-directory
- No symlinks in output
- `link_gsd_skills()` function removed
- Both template scripts identical
- All tests pass

## Open Questions

- None

# S01: Multi-target vault sync

**Goal:** sync-vault.sh copies skills, CLAUDE.md, and AGENTS.md to three independent directories (~/.claude/, ~/.agents/, ~/.pi/agent/) with no symlinks, per-directory manifest cleanup, and both template copies byte-identical.
**Demo:** Run sync-vault.sh and see skills + AGENTS.md + CLAUDE.md in all 3 directories (~/.claude/, ~/.agents/, ~/.pi/agent/), no symlinks, stale cleanup works per-directory

## Must-Haves

- # S01: Multi-target vault sync
- **Goal:** sync-vault.sh copies skills, CLAUDE.md, and AGENTS.md to three independent directories (~/.claude/, ~/.agents/, ~/.pi/agent/) with no symlinks, per-directory manifest cleanup, and both template copies byte-identical.
- **Demo:** Run sync-vault.sh and see skills + AGENTS.md + CLAUDE.md in all 3 directories (~/.claude/, ~/.agents/, ~/.pi/agent/), no symlinks, stale cleanup works per-directory.
- ## Must-Haves
- CLAUDE.md and AGENTS.md copied to ~/.claude/, ~/.agents/, ~/.pi/agent/ (R082, R083)
- Skills copied to ~/.claude/skills/, ~/.agents/skills/, ~/.pi/agent/skills/ with independent .vault-managed manifests (R082, R087)
- No symlinks anywhere — link_gsd_skills() deleted entirely (R084, R085)
- Both template scripts (hive, ai-dev) byte-identical after changes (R086)
- Stale vault-managed skills removed independently per target directory (R087)
- ## Verification
- `pnpm vitest run src/__tests__/lib/templates/sync-vault.test.ts` — all tests pass
- `diff templates/hive/scripts/sync-vault.sh templates/ai-dev/scripts/sync-vault.sh` — no diff
- `grep -c "symlink\|ln -s\|readlink\|link_gsd" templates/hive/scripts/sync-vault.sh` — returns 0
- ## Tasks
- [x] **T01: Update sync-vault.sh for multi-target sync and remove symlink logic** `est:30m`
- Why: The script currently targets ~/.claude/ and ~/.gsd/agent/ for context files and only ~/.claude/skills/ for skills, with a symlink for GSD. Must change to 3 independent copy targets with no symlinks.
- Files: `templates/hive/scripts/sync-vault.sh`, `templates/ai-dev/scripts/sync-vault.sh`
- Do: (1) Replace GSD_DIR constant with AGENTS_CONV_DIR="$HOME/.agents" and PI_DIR="$HOME/.pi/agent". (2) Update sync_claude_md() to pass all 3 targets: "$CLAUDE_DIR" "$AGENTS_CONV_DIR" "$PI_DIR". (3) Update sync_agents_md() same way. (4) Refactor sync_skills() to loop over SKILL_TARGETS=("$CLAUDE_DIR/skills" "$AGENTS_CONV_DIR/skills" "$PI_DIR/skills") — each target gets its own mkdir, .vault-managed manifest, stale cleanup, and copy pass. (5) Delete link_gsd_skills() function entirely (lines 146-174). (6) Remove link_gsd_skills call from main block. (7) cp templates/hive/scripts/sync-vault.sh templates/ai-dev/scripts/sync-vault.sh.
- Verify: `diff templates/hive/scripts/sync-vault.sh templates/ai-dev/scripts/sync-vault.sh` returns empty; `grep -c "symlink\|ln -s\|readlink\|link_gsd" templates/hive/scripts/sync-vault.sh` returns 0
- Done when: Both template scripts are identical, no symlink references remain, script targets 3 directories for both context files and skills
- [ ] **T02: Rewrite tests for multi-target sync and no-symlink behavior** `est:30m`
- Why: Tests currently assert 2-target context file sync, single-target skills, and symlink creation. Must update for 3-target assertions and replace symlink tests with no-symlink verification.
- Files: `src/__tests__/lib/templates/sync-vault.test.ts`
- Do: (1) Add agentsConvDir and piDir temp directories in beforeEach alongside existing claudeDir. (2) Update CLAUDE.md tests to assert content exists in all 3 targets (claudeDir, agentsConvDir, piDir) instead of claudeDir+gsdDir. (3) Update AGENTS.md tests same way. (4) Update Skills tests to verify skills land in all 3 skill directories with independent .vault-managed manifests. Add test for stale cleanup working independently per directory. (5) Delete entire "GSD skills symlink" describe block. (6) Add a test asserting no symlinks exist in any target directory after sync.
- Verify: `pnpm vitest run src/__tests__/lib/templates/sync-vault.test.ts` — all tests pass
- Done when: All tests pass, no references to gsdDir or symlink behavior remain in tests, tests cover 3-target sync for context files and skills
- ## Files Likely Touched
- `templates/hive/scripts/sync-vault.sh`
- `templates/ai-dev/scripts/sync-vault.sh`
- `src/__tests__/lib/templates/sync-vault.test.ts`

## Proof Level

- This slice proves: Not provided.

## Integration Closure

Not provided.

## Verification

- Not provided.

## Tasks

- [ ] **T01: Update sync-vault.sh for multi-target sync and remove symlink logic** `est:30m`
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
  - Files: `templates/hive/scripts/sync-vault.sh`, `templates/ai-dev/scripts/sync-vault.sh`
  - Verify: diff templates/hive/scripts/sync-vault.sh templates/ai-dev/scripts/sync-vault.sh && test $(grep -c 'symlink\|ln -s\|readlink\|link_gsd' templates/hive/scripts/sync-vault.sh) -eq 0

- [ ] **T02: Rewrite tests for multi-target sync and no-symlink behavior** `est:30m`
  Tests currently assert 2-target context file sync (claudeDir + gsdDir), single-target skills (claudeDir/skills), and symlink creation (GSD skills symlink block). Must update for 3-target assertions and replace symlink tests with no-symlink verification.

Key changes to `src/__tests__/lib/templates/sync-vault.test.ts` (310 lines):

1. **beforeEach** (lines 31-39): Add `agentsConvDir` and `piDir` temp directories. Create them with `mkdir`. Remove `gsdDir` variable.
   ```typescript
   agentsConvDir = join(tempDir, ".agents");
   piDir = join(tempDir, ".pi", "agent");
   await mkdir(agentsConvDir, { recursive: true });
   await mkdir(piDir, { recursive: true });
   ```
   Note: Do NOT pre-create these — the script should create them via `mkdir -p`. Only create `claudeDir` as before (existing behavior).

2. **CLAUDE.md tests** (lines 47-96): Replace all `gsdDir` references with assertions for `agentsConvDir` and `piDir`. Each test that checks content in gsdDir should now check content in all 3 targets: claudeDir, agentsConvDir, piDir.

3. **AGENTS.md tests** (lines 101-135): Same pattern — replace gsdDir with agentsConvDir and piDir.

4. **Skills tests** (lines 139-238): Add assertions that skills land in all 3 skill directories:
   - `join(claudeDir, "skills")` 
   - `join(agentsConvDir, "skills")`
   - `join(piDir, "skills")`
   Add a test verifying each target has its own independent `.vault-managed` manifest.
   Add a test verifying stale cleanup works independently per directory (e.g., one target has a stale skill, others don't — only the stale one gets cleaned).

5. **GSD skills symlink block** (lines 243-309): Delete the entire `describe("GSD skills symlink", ...)` block. Replace with a test asserting no symlinks exist in any target directory after sync (use `lstat` to check).

The test file imports `lstat` already (line 2). The `runSync` helper passes `HOME` as env override, which the script uses for `$HOME`.

Constraints:
- Remove all references to `gsdDir` — the script no longer targets ~/.gsd/agent/
- Tests must not pre-create agentsConvDir or piDir — the script's mkdir -p should handle that
- Keep the same test structure (describe blocks for CLAUDE.md, AGENTS.md, Skills) but update assertions
  - Files: `src/__tests__/lib/templates/sync-vault.test.ts`
  - Verify: pnpm vitest run src/__tests__/lib/templates/sync-vault.test.ts

## Files Likely Touched

- templates/hive/scripts/sync-vault.sh
- templates/ai-dev/scripts/sync-vault.sh
- src/__tests__/lib/templates/sync-vault.test.ts

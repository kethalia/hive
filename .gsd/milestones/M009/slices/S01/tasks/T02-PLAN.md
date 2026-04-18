---
estimated_steps: 24
estimated_files: 1
skills_used: []
---

# T02: Rewrite tests for multi-target sync and no-symlink behavior

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

## Inputs

- ``src/__tests__/lib/templates/sync-vault.test.ts` — current test file to rewrite (310 lines)`
- ``templates/hive/scripts/sync-vault.sh` — updated script from T01 (needed to understand new behavior)`

## Expected Output

- ``src/__tests__/lib/templates/sync-vault.test.ts` — rewritten with 3-target assertions, no symlink tests, per-directory manifest tests`

## Verification

pnpm vitest run src/__tests__/lib/templates/sync-vault.test.ts

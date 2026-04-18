# S01: Multi-target vault sync — UAT

**Milestone:** M009
**Written:** 2026-04-18T14:18:25.509Z

# S01 UAT: Multi-Target Vault Sync

## Preconditions
- A vault directory exists at `~/vault` with `Skills/`, `CLAUDE.md`, and `AGENTS.md`
- At least two skills exist in `~/vault/Skills/` (e.g., `skill-a/SKILL.md`, `skill-b/SKILL.md`)
- The directories `~/.claude/`, `~/.agents/`, `~/.pi/agent/` may or may not exist prior to running

## Test Cases

### TC1: Context files land in all 3 targets
1. Run `bash templates/hive/scripts/sync-vault.sh`
2. Verify `~/.claude/CLAUDE.md` exists and matches `~/vault/CLAUDE.md` content
3. Verify `~/.agents/CLAUDE.md` exists and matches `~/vault/CLAUDE.md` content
4. Verify `~/.pi/agent/CLAUDE.md` exists and matches `~/vault/CLAUDE.md` content
5. Repeat steps 2-4 for `AGENTS.md`
- **Expected:** All 6 files exist with correct content

### TC2: Skills land in all 3 skill directories
1. Run `bash templates/hive/scripts/sync-vault.sh`
2. Verify `~/.claude/skills/skill-a/SKILL.md` exists
3. Verify `~/.agents/skills/skill-a/SKILL.md` exists
4. Verify `~/.pi/agent/skills/skill-a/SKILL.md` exists
5. Repeat for `skill-b`
- **Expected:** All skills present in all 3 directories

### TC3: Independent per-directory manifests
1. Run `bash templates/hive/scripts/sync-vault.sh`
2. Check `~/.claude/skills/.vault-managed` — should list skill-a and skill-b
3. Check `~/.agents/skills/.vault-managed` — should list skill-a and skill-b
4. Check `~/.pi/agent/skills/.vault-managed` — should list skill-a and skill-b
- **Expected:** Each directory has its own independent `.vault-managed` manifest

### TC4: Stale cleanup works independently per directory
1. Run sync once to populate all targets
2. Manually create `~/.agents/skills/stale-skill/SKILL.md` and add `stale-skill` to `~/.agents/skills/.vault-managed`
3. Run sync again
4. Verify `~/.agents/skills/stale-skill/` is removed (was in manifest but not in vault)
5. Verify `~/.claude/skills/` and `~/.pi/agent/skills/` are unaffected (no stale-skill existed there)
- **Expected:** Stale cleanup only affects the directory where the stale entry exists

### TC5: No symlinks anywhere
1. Run `bash templates/hive/scripts/sync-vault.sh`
2. Run `find ~/.claude ~/.agents ~/.pi/agent -type l 2>/dev/null`
- **Expected:** No output (zero symlinks)

### TC6: Directory creation on first run
1. Remove `~/.agents/` and `~/.pi/agent/` if they exist
2. Run `bash templates/hive/scripts/sync-vault.sh`
3. Verify both directories were created and populated
- **Expected:** Script creates missing directories via mkdir -p

### TC7: Template parity
1. Run `diff templates/hive/scripts/sync-vault.sh templates/ai-dev/scripts/sync-vault.sh`
- **Expected:** No diff — both templates are byte-identical

### TC8: Idempotent re-run
1. Run sync twice in succession
2. Verify no errors on second run
3. Verify all files still present and correct
- **Expected:** Second run is a no-op (hash comparison skips unchanged files)

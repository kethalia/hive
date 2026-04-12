# Triage: Obsidian + Vault Clone Bugs

## Bug 1: Obsidian not launching automatically

### Root cause

The openbox autostart at `/etc/xdg/openbox/autostart` (baked into hive-base Docker image) launches Obsidian correctly. However, `init.sh` line 9 in all 4 templates runs `mkdir -p ~/vault` during first-time setup — this creates the `~/vault` directory BEFORE the git-clone module runs. Additionally, the Dockerfile itself creates `~/vault` at line 168.

The git-clone module skips cloning when the directory is non-empty. But even more critically — the Obsidian vault at `~/vault` may be empty (just a directory with no `.obsidian/` folder), causing Obsidian to show the vault picker instead of opening the vault directly, or to fail silently.

The real issue: **without vault content cloned, Obsidian has nothing to open**. The `obsidian.json` config points to `/home/coder/vault` with `"open": true`, but if the vault is an empty directory, Obsidian may not create `.obsidian/` and could appear to "not launch" when it's actually launching but showing a blank/picker state inside KasmVNC where nobody sees it.

### Affected files
- `templates/ai-dev/main.tf:474-481` (git-clone-vault module)
- `templates/hive-worker/main.tf:326-332`
- `templates/hive-council/main.tf:326-332`
- `templates/hive-verifier/main.tf:319-325`
- `docker/hive-base/openbox-autostart` (Obsidian launch — works correctly)

## Bug 2: Vault repo not cloned on restart

### Root cause

The `coder/git-clone` module (v1.2.3) skips cloning when the target directory is non-empty. Two things create `~/vault` before git-clone runs:
1. `init.sh` line 9: `mkdir -p ~/projects ~/bin ~/.config ~/.local/bin ~/vault`
2. Dockerfile line 168: `mkdir -p ~/vault` (baked into image, copied to volume on first start)

On first workspace creation: Docker volume is populated from image → `~/vault/` exists (empty) → git-clone sees empty dir → clones successfully (the module checks emptiness with `ls -A`). On subsequent starts: volume persists → `~/vault/` has `.obsidian/` and `.git/` from previous clone → git-clone skips → stale vault content.

The user wants: clone to temp dir, replace ~/vault with fresh content every start.

### Reproduction
1. Create a workspace with `vault_repo` set
2. First start: vault clones correctly
3. Stop and restart workspace
4. Vault is NOT re-cloned (git-clone skips because ~/vault is non-empty)

### Fix approach

**Bug 2 fix:** Use `post_clone_script` on the git-clone module. Clone to a temp folder name (e.g. `vault_clone_tmp`), then the post-clone script (which runs ALWAYS, even when clone is skipped) does:
- `rsync` or replace `~/vault` with the fresh clone
- Clean up the temp dir

**Bug 1 fix:** Bug 1 is a consequence of Bug 2 — if vault content exists, Obsidian opens correctly via the autostart. The autostart itself is correct. Fixing the clone ensures vault content is present → Obsidian works.

Also: remove `~/vault` from the `mkdir -p` in init.sh since the git-clone module handles directory creation, and the Dockerfile already creates it.

### Templates affected
All 4 templates with vault support: ai-dev, hive-worker, hive-council, hive-verifier

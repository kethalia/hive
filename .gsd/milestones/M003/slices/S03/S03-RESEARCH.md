# S03 — Obsidian & Vault Integration: Research

**Date:** 2026-04-09
**Slice:** S03 — Obsidian & Vault Integration
**Requirements Owned:** R037, R038 (active); R036, R039 (already validated in S01/S02)

## Summary

S03 is targeted integration work — the base image (S01) already contains Obsidian, notesmd-cli, Openbox, and KasmVNC. The templates (S02) already start Openbox in every browser-serve.sh. This slice wires up the remaining three behaviors that depend on runtime user data: vault cloning/syncing via `vault_repo`, Obsidian autostart via Openbox's autostart mechanism, and the Openbox right-click menu.

The work divides cleanly into two surfaces: (1) **Terraform + init.sh** — adding `vault_repo` variable to all 4 templates and vault clone/pull/sync logic; and (2) **Openbox config** — baking `autostart` and `menu.xml` into the base image so all templates inherit them. One complication: no terminal emulator is installed in the base image, which `menu.xml` needs for the "terminal" entry. `xterm` must be added to the base Dockerfile.

## Recommendation

**Approach:** Two tasks in sequence. T01 modifies the base Dockerfile to add `xterm` and bake in `/etc/xdg/openbox/autostart` + `/etc/xdg/openbox/menu.xml`. T02 adds `vault_repo` variable to all 4 `main.tf` files, adds `VAULT_REPO` env var injection (env approach, not templatefile — simpler for per-start reconnect), and adds vault clone/pull/sync logic to all 4 `init.sh` scripts.

**Why env var approach over templatefile for vault_repo:** The vault reconnect logic (`git pull`) runs on every workspace start, not just first-time init. Using an env var (`VAULT_REPO`) injected into `coder_agent.env` means the running script can reference it on every invocation without re-baking the templatefile. This matches how `HIVE_REPO_URL` works in hive-worker/hive-verifier for the same reason.

**Why system-wide Openbox config (`/etc/xdg/openbox/`) vs user config:** The `coder` user's home directory is a Docker volume that persists across workspace stops/starts. User-level Openbox config (`~/.config/openbox/`) would be created once and then frozen in the volume — updates to the config via image rebuilds wouldn't propagate. System-wide config at `/etc/xdg/openbox/` lives in the image layer and is always current. Openbox reads system config when no user config exists; and since `autostart` and `menu.xml` baked into the image never need per-user override, system-wide is correct here.

**Vault sync approach — background while loop in init.sh, not cron:** Docker containers don't run a cron daemon. Installing and starting `cron` adds complexity; using `/etc/cron.d/` requires the daemon. A background `while true; do sleep 1800; git ...; done` loop launched from `init.sh` is simpler, reliable, and directly visible in logs. The context spec says "cron entry every 30min" — the while-loop delivers the same 30-min cadence without daemon management.

## Implementation Landscape

### Key Files

- `docker/hive-base/Dockerfile` — needs 3 additions: `xterm` in apt packages; `/etc/xdg/openbox/autostart` baked in (Obsidian autostart with --no-sandbox); `/etc/xdg/openbox/menu.xml` baked in (Obsidian + xterm entries)
- `templates/hive-council/main.tf` — add `vault_repo` variable (required, no default); inject `VAULT_REPO` into `coder_agent.env` (already uses `merge()` — fit the variable into the existing merge call); add `vault_repo` to `startup_script = templatefile(...)` params
- `templates/hive-worker/main.tf` — same vault_repo pattern; env block is a plain map (no merge yet) — needs conversion to `merge()` if conditional VAULT_REPO injection is desired, OR just always inject it
- `templates/hive-verifier/main.tf` — same vault_repo pattern
- `templates/ai-dev/main.tf` — same vault_repo pattern; already uses `merge()` in env block
- `templates/hive-council/scripts/init.sh` — add vault clone (first start) + git pull (reconnect) block + background sync loop
- `templates/hive-worker/scripts/init.sh` — same vault block
- `templates/hive-verifier/scripts/init.sh` — same vault block
- `templates/ai-dev/scripts/init.sh` — same vault block

### Openbox Config Content

**`/etc/xdg/openbox/autostart`** (baked into Dockerfile as ROOT step before `USER coder`):
```bash
# Autostart Obsidian with vault
/usr/bin/obsidian --no-sandbox --disable-gpu-sandbox /home/coder/vault &
```
Note: `~` doesn't expand reliably in Openbox autostart — use absolute path `/home/coder/vault`. Obsidian opens `vault` as its working directory/vault path.

**`/etc/xdg/openbox/menu.xml`** (baked into Dockerfile):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="Desktop">
    <item label="Obsidian">
      <action name="Execute">
        <command>/usr/bin/obsidian --no-sandbox --disable-gpu-sandbox /home/coder/vault</command>
      </action>
    </item>
    <item label="Terminal">
      <action name="Execute">
        <command>xterm</command>
      </action>
    </item>
  </menu>
</openbox_menu>
```

### Vault Logic in init.sh

Insert after the existing `~/.workspace_initialized` block, before "Per-start initialization":

```bash
# =============================================================================
# Vault: Clone or pull second brain
# =============================================================================
if [ -n "${vault_repo}" ]; then
  if [ ! -d "$HOME/vault/.git" ]; then
    echo "Cloning vault from ${vault_repo}..."
    git clone "${vault_repo}" "$HOME/vault" || echo "Warning: vault clone failed, continuing without vault"
  else
    echo "Pulling vault updates..."
    git -C "$HOME/vault" pull --rebase || echo "Warning: vault pull failed"
  fi

  # Background sync: commit and push every 30 minutes
  (
    while true; do
      sleep 1800
      if [ -d "$HOME/vault/.git" ]; then
        git -C "$HOME/vault" add -A
        git -C "$HOME/vault" diff --cached --quiet || \
          git -C "$HOME/vault" commit -m "vault sync $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        git -C "$HOME/vault" push 2>>"$HOME/.local/share/vault-sync.log" || true
      fi
    done
  ) &
  disown $!
fi
```

**Template var approach:** Since `init.sh` already uses `templatefile()`, `vault_repo` is passed as a Terraform template variable (interpolated as `${vault_repo}`). The env var `VAULT_REPO` is also injected into `coder_agent.env` as a belt-and-suspenders approach — but for init.sh logic, the templatefile interpolation is the primary mechanism (consistent with existing `dotfiles_uri`, `workspace_name` pattern).

### Dockerfile Changes

Add to the apt package list (in the Google Chrome + KasmVNC install layer, or a new layer):
```
xterm
```

Add as a ROOT step (before `USER coder`) to bake system-wide Openbox config:
```dockerfile
# Bake Openbox autostart + right-click menu (system-wide, picked up by all coder users)
RUN mkdir -p /etc/xdg/openbox
COPY --chown=root:root openbox/autostart /etc/xdg/openbox/autostart
COPY --chown=root:root openbox/menu.xml  /etc/xdg/openbox/menu.xml
RUN chmod 644 /etc/xdg/openbox/autostart /etc/xdg/openbox/menu.xml
```
OR use `RUN cat > /etc/xdg/openbox/autostart << 'EOF'` inline heredoc — avoids needing new source files in the build context.

The Dockerfile build context is `docker/hive-base/` — if using COPY, create `docker/hive-base/openbox/` with the two files. If using inline heredoc, no extra files needed. **Inline heredoc is preferred** — keeps the config colocated in the Dockerfile, no additional files in the context.

### Build Order

1. **T01 — Dockerfile changes:** Add `xterm`, bake Openbox `autostart` and `menu.xml` into `/etc/xdg/openbox/`. This is the foundational step — all templates inherit it. Verify with `terraform validate` (no Docker build needed for terraform; image build is a CI concern).
2. **T02 — Terraform variables + init.sh vault logic:** Add `vault_repo` variable to all 4 `main.tf` files, update `coder_agent.env`, update `startup_script = templatefile(...)` call to pass `vault_repo`, add vault clone/pull/sync block to all 4 `init.sh` files. Verify with `terraform validate` for all 4 templates + vitest suite for regressions.

### Verification Approach

```bash
# T01 verification (no docker build available in CI, use grep/structural checks)
grep "xterm" docker/hive-base/Dockerfile
grep "obsidian --no-sandbox" docker/hive-base/Dockerfile
grep "menu.xml\|autostart" docker/hive-base/Dockerfile
grep "root-menu\|Obsidian\|Terminal" docker/hive-base/Dockerfile

# T02 verification
grep -r "vault_repo" templates/hive-worker/main.tf templates/hive-verifier/main.tf templates/hive-council/main.tf templates/ai-dev/main.tf
grep -r "VAULT_REPO\|vault_repo" templates/hive-worker/scripts/init.sh templates/hive-verifier/scripts/init.sh templates/hive-council/scripts/init.sh templates/ai-dev/scripts/init.sh
grep "vault sync\|git clone.*vault\|git pull.*vault\|git -C.*vault" templates/hive-worker/scripts/init.sh

# terraform validate all 4 templates
cd templates/hive-worker && terraform validate
cd templates/hive-verifier && terraform validate
cd templates/hive-council && terraform validate
cd templates/ai-dev && terraform validate

# Vitest regression
npx vitest run
```

Manual (post-deploy) UAT: workspace start → KasmVNC → `pgrep obsidian` → right-click shows menu → `notesmd-cli search ~/vault test` returns results.

## Constraints

- `vault_repo` must be passed as a templatefile var to `init.sh` because init.sh already uses `templatefile()`. Adding it as a new key to the existing templatefile call is the correct pattern (consistent with `dotfiles_uri`, `workspace_name`).
- Openbox autostart must use absolute path `/home/coder/vault` (not `~`). Tilde expansion is not guaranteed in Openbox autostart.
- Obsidian requires `--no-sandbox --disable-gpu-sandbox` in Docker (Electron app, no user namespace support).
- The background sync loop must use `disown $!` to prevent init.sh from waiting for it (init.sh runs as the agent startup_script).
- `ai-dev` template already uses `merge()` in its env block; `hive-worker` and `hive-verifier` use plain maps. All need `VAULT_REPO` added — worker and verifier plain maps just need a new key/value entry; ai-dev and council use merge pattern.

## Common Pitfalls

- **Obsidian vault path in autostart** — use `/home/coder/vault` not `~/vault`; Openbox autostart doesn't expand `~`.
- **Background sync loop blocking init.sh** — must use `& disown $!` not just `&`; plain `&` can still block in some shell environments.
- **Git commit on empty diff** — check `git diff --cached --quiet` before `git commit` to avoid "nothing to commit" errors that could stop the loop.
- **vault_repo empty string in terraform validate** — since `vault_repo` has no default, `terraform validate` with a required variable will fail. Use `default = ""` with validation note in the description, OR use a plain `default = ""`. The spec says required but also says "empty string → graceful skip." Use `default = ""` for `terraform validate` to pass; mark description as "Required for vault sync." This matches how the other templates handle optional-but-meaningful vars.
- **xterm in Openbox menu** — if xterm is not installed, right-click terminal item silently does nothing. Ensure `xterm` is in the apt install layer.
- **System openbox config vs user config** — if coder user already has `~/.config/openbox/autostart` from a previous workspace volume, it overrides the system config. Solution: system config only applies on fresh volumes. This is acceptable — existing workspaces just won't have it until the volume is reset.

## Open Risks

- **Obsidian vault clone on every start vs first start only:** The `~/.workspace_initialized` guard controls first-time setup, but vault pull should run on every start (reconnect). The current init.sh structure puts things inside the `if [ ! -f ~/.workspace_initialized ]` block for one-time setup. Vault clone belongs inside that block; vault pull belongs OUTSIDE it (runs every start). The sync loop also starts every time. This needs careful placement in init.sh.
- **vault_repo Terraform required vs optional:** Spec says required but error handling says "graceful skip if empty." Resolution: `default = ""` + description says required. This lets `terraform validate` pass and lets presets pre-fill it without breaking workspaces that don't use a vault.

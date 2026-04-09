# S03: Obsidian & Vault Integration

**Goal:** Wire Obsidian autostart, desktop right-click menu, and vault clone/sync into all templates via base image Openbox config and per-template Terraform vault_repo variable.
**Demo:** After this: create a workspace with vault_repo=<test-repo> → KasmVNC browser → Obsidian open with vault loaded → right-click shows app menu → `notesmd-cli search ~/vault test` returns results → 30min later vault changes pushed to GitHub.

## Must-Haves

- `xterm` installed in base Dockerfile
- `/etc/xdg/openbox/autostart` baked into base image (launches Obsidian with --no-sandbox)
- `/etc/xdg/openbox/menu.xml` baked into base image (Obsidian + Terminal entries)
- All 4 templates declare `vault_repo` variable with `default = ""`
- All 4 templates pass `vault_repo` to templatefile() for init.sh
- All 4 templates inject `VAULT_REPO` into coder_agent.env
- All 4 init.sh scripts have vault clone (first start) + pull (reconnect) + background sync loop
- `terraform validate` passes for all 4 templates
- `npx vitest run` passes (no regressions)

## Proof Level

- This slice proves: This slice proves: integration (base image config inherited by all templates + Terraform variable wiring). Real runtime required: no (structural + terraform validate). Human/UAT required: yes (post-deploy: KasmVNC → Obsidian visible, right-click menu works, vault cloned).

## Integration Closure

- Upstream surfaces consumed: `docker/hive-base/Dockerfile` (S01 output), all 4 template `main.tf` + `init.sh` (S02 output)
- New wiring introduced: Openbox autostart/menu.xml in base image; vault_repo Terraform variable → templatefile → init.sh vault logic; VAULT_REPO env var in coder_agent.env
- What remains before milestone is truly usable end-to-end: nothing — this is the final integration slice for M003

## Verification

- Runtime signals: init.sh logs "Cloning vault...", "Pulling vault updates...", warnings on clone/pull failure; sync loop logs to `~/.local/share/vault-sync.log`
- Inspection surfaces: `pgrep -f "sleep 1800"` confirms sync loop running; `cat ~/.local/share/vault-sync.log` for push errors; `ls ~/vault/.git` confirms vault cloned
- Failure visibility: clone/pull failures logged to stdout with "Warning:" prefix; sync push failures logged to vault-sync.log; graceful skip if vault_repo is empty

## Tasks

- [x] **T01: Add xterm and bake Openbox autostart + menu.xml into base Dockerfile** `est:20m`
  ## Description

The base image already has Openbox installed but no config files — right-click does nothing and nothing autostarts. This task adds `xterm` to the apt layer and bakes two Openbox config files into `/etc/xdg/openbox/` using inline heredocs in the Dockerfile. System-wide config is correct here because user home is a Docker volume — image-layer config at `/etc/xdg/openbox/` always reflects the latest build.

This advances R037 (Obsidian autostart in every KasmVNC session) and R036 (right-click XML app launcher menu).

## Steps

1. Open `docker/hive-base/Dockerfile`. Find the apt layer that installs `openbox` (the Google Chrome + KasmVNC layer). Add `xterm` to the package list in that same `apt-get install` call.

2. After the `USER coder` line, find a suitable location BEFORE `USER coder` (must be root to write to `/etc/xdg/`). Insert a new block that creates `/etc/xdg/openbox/` and writes `autostart` and `menu.xml` using inline heredocs:

```dockerfile
# Bake Openbox desktop config (system-wide — survives volume mounts on /home/coder)
RUN mkdir -p /etc/xdg/openbox \
    && cat > /etc/xdg/openbox/autostart << 'XDGEOF'
# Autostart Obsidian with vault
/usr/bin/obsidian --no-sandbox --disable-gpu-sandbox /home/coder/vault &
XDGEOF
    && cat > /etc/xdg/openbox/menu.xml << 'XDGEOF'
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
XDGEOF
    && chmod 644 /etc/xdg/openbox/autostart /etc/xdg/openbox/menu.xml
```

3. **Critical placement:** This block MUST be placed before the `USER coder` line (needs root to write to /etc/xdg/) but after openbox is installed.

4. **Key constraints:**
   - Use absolute path `/home/coder/vault` not `~/vault` — tilde doesn't expand in Openbox autostart
   - Obsidian needs `--no-sandbox --disable-gpu-sandbox` (Electron in Docker)
   - Use `'XDGEOF'` (quoted) heredoc delimiter so no shell variable expansion occurs
   - The `&` at end of obsidian line in autostart is critical — Openbox autostart blocks on foreground processes

## Must-Haves

- [ ] `xterm` added to the apt-get install layer alongside openbox
- [ ] `/etc/xdg/openbox/autostart` created with Obsidian launch command using absolute path and --no-sandbox flags
- [ ] `/etc/xdg/openbox/menu.xml` created with Obsidian and Terminal entries
- [ ] Both config files placed BEFORE `USER coder` line
- [ ] Both config files chmod 644

## Verification

- `grep -q 'xterm' docker/hive-base/Dockerfile`
- `grep -q 'obsidian --no-sandbox' docker/hive-base/Dockerfile`
- `grep -q '/etc/xdg/openbox/autostart' docker/hive-base/Dockerfile`
- `grep -q '/etc/xdg/openbox/menu.xml' docker/hive-base/Dockerfile`
- `grep -q 'root-menu' docker/hive-base/Dockerfile`
- `grep -q '/home/coder/vault' docker/hive-base/Dockerfile`
- Verify the openbox config block appears before `USER coder`: the line number of 'xdg/openbox' should be less than the line number of 'USER coder'
  - Files: `docker/hive-base/Dockerfile`
  - Verify: grep -q 'xterm' docker/hive-base/Dockerfile && grep -q 'obsidian --no-sandbox' docker/hive-base/Dockerfile && grep -q 'root-menu' docker/hive-base/Dockerfile && grep -q '/home/coder/vault' docker/hive-base/Dockerfile && test $(grep -n 'xdg/openbox' docker/hive-base/Dockerfile | head -1 | cut -d: -f1) -lt $(grep -n 'USER coder' docker/hive-base/Dockerfile | head -1 | cut -d: -f1)

- [x] **T02: Wire vault_repo variable and vault clone/sync logic into all 4 templates** `est:40m`
  ## Description

This task adds the `vault_repo` Terraform variable to all 4 templates (hive-worker, hive-verifier, hive-council, ai-dev), injects `VAULT_REPO` into each template's `coder_agent.env` block, passes `vault_repo` to the `templatefile()` call for init.sh, and adds the vault clone/pull/sync block to all 4 init.sh scripts. This advances R038 (vault_repo variable + clone + sync).

## Steps

### Step 1: Add `vault_repo` variable to all 4 main.tf files

In each template's `main.tf`, add near the other variables:

```hcl
variable "vault_repo" {
  description = "Git repository URL for Obsidian vault (required for vault sync)"
  type        = string
  default     = ""
}
```

Use `default = ""` so `terraform validate` passes without providing it. The description makes clear it's needed for vault sync.

### Step 2: Add `vault_repo` to each templatefile() call

In each `main.tf`, find the `startup_script = templatefile(...)` block and add `vault_repo = var.vault_repo` to the template vars map. All 4 currently pass `dotfiles_uri`, `workspace_name`, `owner_name`, `owner_email`.

### Step 3: Add `VAULT_REPO` to each coder_agent.env block

The env block patterns differ:
- **hive-worker**: plain `env = { ... }` map — add `VAULT_REPO = var.vault_repo` as a new entry
- **hive-verifier**: plain `env = { ... }` map — same as worker
- **hive-council**: uses `merge()` — add `VAULT_REPO = var.vault_repo` inside the first map argument
- **ai-dev**: uses `merge()` — add `VAULT_REPO = var.vault_repo` inside the first map argument

### Step 4: Add vault clone/pull/sync block to all 4 init.sh scripts

Insert AFTER the `~/.workspace_initialized` block and PATH setup, BEFORE the per-start Docker check. The vault logic runs on EVERY start (not inside the workspace_initialized guard). Use `${vault_repo}` (Terraform templatefile interpolation, not shell env var).

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

**Critical placement notes:**
- Vault clone (`git clone`) must be OUTSIDE the `~/.workspace_initialized` guard — we want clone on first start AND pull on reconnect
- The `if [ ! -d "$HOME/vault/.git" ]` check handles the clone-vs-pull distinction
- `${vault_repo}` uses Terraform templatefile interpolation (dollar-brace), consistent with how `${dotfiles_uri}` and `${workspace_name}` work in the same file
- `$HOME` uses shell variable (no braces needed for shell)
- The background sync loop uses `& disown $!` to prevent init.sh from blocking
- Push errors go to `~/.local/share/vault-sync.log` for later inspection
- `git diff --cached --quiet` prevents empty commits

**ai-dev difference:** ai-dev's init.sh does NOT have the HIVE_REPO_URL block (it's not a hive template). Insert the vault block in the same location — after PATH setup, before the per-start Docker check.

### Step 5: Run terraform validate on all 4 templates

```bash
cd templates/hive-worker && terraform init -backend=false && terraform validate && cd ../..
cd templates/hive-verifier && terraform init -backend=false && terraform validate && cd ../..
cd templates/hive-council && terraform init -backend=false && terraform validate && cd ../..
cd templates/ai-dev && terraform init -backend=false && terraform validate && cd ../..
```

### Step 6: Run vitest to confirm no regressions

```bash
npx vitest run
```

## Must-Haves

- [ ] `vault_repo` variable declared in all 4 main.tf with `default = ""`
- [ ] `vault_repo` passed in templatefile() call in all 4 main.tf
- [ ] `VAULT_REPO` in coder_agent.env block in all 4 main.tf
- [ ] Vault clone/pull/sync block in all 4 init.sh scripts, OUTSIDE the workspace_initialized guard
- [ ] Background sync uses `& disown $!`
- [ ] Push errors logged to `~/.local/share/vault-sync.log`
- [ ] `terraform validate` passes for all 4 templates
- [ ] `npx vitest run` passes

## Verification

- `grep -q 'vault_repo' templates/hive-worker/main.tf && grep -q 'vault_repo' templates/hive-verifier/main.tf && grep -q 'vault_repo' templates/hive-council/main.tf && grep -q 'vault_repo' templates/ai-dev/main.tf`
- `grep -q 'VAULT_REPO' templates/hive-worker/main.tf && grep -q 'VAULT_REPO' templates/hive-verifier/main.tf && grep -q 'VAULT_REPO' templates/hive-council/main.tf && grep -q 'VAULT_REPO' templates/ai-dev/main.tf`
- `grep -q 'vault sync' templates/hive-worker/scripts/init.sh && grep -q 'vault sync' templates/hive-verifier/scripts/init.sh && grep -q 'vault sync' templates/hive-council/scripts/init.sh && grep -q 'vault sync' templates/ai-dev/scripts/init.sh`
- `grep -q 'disown' templates/hive-worker/scripts/init.sh`
- `cd templates/hive-worker && terraform validate && cd ../..`
- `cd templates/hive-verifier && terraform validate && cd ../..`
- `cd templates/hive-council && terraform validate && cd ../..`
- `cd templates/ai-dev && terraform validate && cd ../..`
- `npx vitest run`

## Observability Impact

- Signals added: init.sh logs vault clone/pull status to stdout; sync loop logs push errors to `~/.local/share/vault-sync.log`
- How a future agent inspects: `pgrep -f 'sleep 1800'` confirms sync loop; `cat ~/.local/share/vault-sync.log` for push failures; `ls ~/vault/.git` confirms clone
- Failure state exposed: "Warning: vault clone failed" / "Warning: vault pull failed" in agent startup logs; push errors in vault-sync.log
  - Files: `templates/hive-worker/main.tf`, `templates/hive-worker/scripts/init.sh`, `templates/hive-verifier/main.tf`, `templates/hive-verifier/scripts/init.sh`, `templates/hive-council/main.tf`, `templates/hive-council/scripts/init.sh`, `templates/ai-dev/main.tf`, `templates/ai-dev/scripts/init.sh`
  - Verify: grep -q 'vault_repo' templates/hive-worker/main.tf && grep -q 'vault_repo' templates/hive-verifier/main.tf && grep -q 'vault_repo' templates/hive-council/main.tf && grep -q 'vault_repo' templates/ai-dev/main.tf && grep -q 'vault sync' templates/hive-worker/scripts/init.sh && grep -q 'vault sync' templates/ai-dev/scripts/init.sh && cd templates/hive-worker && terraform validate && cd ../hive-verifier && terraform validate && cd ../hive-council && terraform validate && cd ../ai-dev && terraform validate && cd ../.. && npx vitest run

## Files Likely Touched

- docker/hive-base/Dockerfile
- templates/hive-worker/main.tf
- templates/hive-worker/scripts/init.sh
- templates/hive-verifier/main.tf
- templates/hive-verifier/scripts/init.sh
- templates/hive-council/main.tf
- templates/hive-council/scripts/init.sh
- templates/ai-dev/main.tf
- templates/ai-dev/scripts/init.sh

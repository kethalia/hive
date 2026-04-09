---
estimated_steps: 93
estimated_files: 8
skills_used: []
---

# T02: Wire vault_repo variable and vault clone/sync logic into all 4 templates

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

## Inputs

- ``templates/hive-worker/main.tf` — current template with coder_agent env (plain map) and templatefile() call`
- ``templates/hive-worker/scripts/init.sh` — current init script with workspace_initialized guard and HIVE_REPO_URL block`
- ``templates/hive-verifier/main.tf` — current template with coder_agent env (plain map) and templatefile() call`
- ``templates/hive-verifier/scripts/init.sh` — current init script with workspace_initialized guard and HIVE_REPO_URL block`
- ``templates/hive-council/main.tf` — current template with coder_agent env (merge pattern) and templatefile() call`
- ``templates/hive-council/scripts/init.sh` — current init script with workspace_initialized guard and HIVE_REPO_URL block`
- ``templates/ai-dev/main.tf` — current template with coder_agent env (merge pattern) and templatefile() call`
- ``templates/ai-dev/scripts/init.sh` — current init script with workspace_initialized guard (NO HIVE_REPO_URL block)`

## Expected Output

- ``templates/hive-worker/main.tf` — vault_repo variable + VAULT_REPO env + templatefile param added`
- ``templates/hive-worker/scripts/init.sh` — vault clone/pull/sync block added`
- ``templates/hive-verifier/main.tf` — vault_repo variable + VAULT_REPO env + templatefile param added`
- ``templates/hive-verifier/scripts/init.sh` — vault clone/pull/sync block added`
- ``templates/hive-council/main.tf` — vault_repo variable + VAULT_REPO env (in merge) + templatefile param added`
- ``templates/hive-council/scripts/init.sh` — vault clone/pull/sync block added`
- ``templates/ai-dev/main.tf` — vault_repo variable + VAULT_REPO env (in merge) + templatefile param added`
- ``templates/ai-dev/scripts/init.sh` — vault clone/pull/sync block added`

## Verification

grep -q 'vault_repo' templates/hive-worker/main.tf && grep -q 'vault_repo' templates/hive-verifier/main.tf && grep -q 'vault_repo' templates/hive-council/main.tf && grep -q 'vault_repo' templates/ai-dev/main.tf && grep -q 'vault sync' templates/hive-worker/scripts/init.sh && grep -q 'vault sync' templates/ai-dev/scripts/init.sh && cd templates/hive-worker && terraform validate && cd ../hive-verifier && terraform validate && cd ../hive-council && terraform validate && cd ../ai-dev && terraform validate && cd ../.. && npx vitest run

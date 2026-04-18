#!/bin/bash
# sync-vault.sh — Sync vault config files and skills to local agent directories
#
# Vault is the single source of truth for:
#   - Agents/CLAUDE.md  (global Claude Code instructions)
#   - Agents/AGENTS.md  (agent orientation & context discovery)
#   - Skills/           (skill directories with SKILL.md files)
#
# Called automatically by:
#   - init.sh (startup path — deploys this script, then calls it)
#   - post_clone_script in main.tf (after every vault fetch)
#
# Can also be invoked manually:
#   bash ~/sync-vault.sh

set -euo pipefail

VAULT_DIR="$HOME/vault"
AGENTS_SRC="$VAULT_DIR/Agents"
CLAUDE_DIR="$HOME/.claude"
AGENTS_CONV_DIR="$HOME/.agents"
PI_DIR="$HOME/.pi/agent"

# Track what changed for logging
changes=()

# -----------------------------------------------------------------------------
# sync_file — copy a vault file to one or more target directories
# Usage: sync_file <source_path> <filename> <target_dir> [<target_dir>...]
# -----------------------------------------------------------------------------
sync_file() {
  local src="$1"
  local name="$2"
  shift 2
  local targets=("$@")

  if [ ! -f "$src" ]; then
    echo "$name: skipped (source file missing: $src)"
    return
  fi

  for target_dir in "${targets[@]}"; do
    mkdir -p "$target_dir"
    local dest="$target_dir/$name"
    if [ -f "$dest" ] && diff -q "$src" "$dest" >/dev/null 2>&1; then
      echo "$name → $target_dir: already in sync"
    else
      cp "$src" "$dest"
      changes+=("$name synced to $target_dir")
      echo "$name → $target_dir: synced from vault"
    fi
  done
}

# -----------------------------------------------------------------------------
# CLAUDE.md — sync to all agent directories
# -----------------------------------------------------------------------------
sync_claude_md() {
  sync_file "$AGENTS_SRC/CLAUDE.md" "CLAUDE.md" "$CLAUDE_DIR" "$AGENTS_CONV_DIR" "$PI_DIR"
}

# -----------------------------------------------------------------------------
# AGENTS.md — sync to all agent directories
# -----------------------------------------------------------------------------
sync_agents_md() {
  sync_file "$AGENTS_SRC/AGENTS.md" "AGENTS.md" "$CLAUDE_DIR" "$AGENTS_CONV_DIR" "$PI_DIR"
}

# -----------------------------------------------------------------------------
# Skills — sync vault skill directories to all agent skill directories
# Each vault skill is a directory (e.g. Skills/caveman/) containing SKILL.md
# -----------------------------------------------------------------------------
sync_skills() {
  if [ ! -d "$VAULT_DIR/Skills" ]; then
    echo "Skills: skipped (vault not available)"
    return
  fi

  # Precompute vault hashes once — avoids re-hashing per target
  declare -A vault_hashes
  for skill_dir in "$VAULT_DIR/Skills"/*/; do
    [ -d "$skill_dir" ] || continue
    local skill_name
    skill_name=$(basename "$skill_dir")
    vault_hashes["$skill_name"]=$(cd "$skill_dir" && find . -type f -exec md5sum {} + 2>/dev/null | sort | md5sum | cut -d' ' -f1)
  done

  local skill_targets=("$CLAUDE_DIR/skills" "$AGENTS_CONV_DIR/skills" "$PI_DIR/skills")

  for skills_target in "${skill_targets[@]}"; do
    mkdir -p "$skills_target"

    local synced=0
    local removed=0
    local unchanged=0

    local manifest="$skills_target/.vault-managed"
    if [ -f "$manifest" ]; then
      while IFS= read -r managed_name; do
        [ -n "$managed_name" ] || continue
        # Reject path traversal: no slashes, no "..", no leading dash
        if [[ "$managed_name" == */* || "$managed_name" == ".." || "$managed_name" == -* ]]; then
          echo "WARNING: ignoring suspicious manifest entry: $managed_name"
          continue
        fi
        if [ -d "$skills_target/$managed_name" ] && [ ! -d "$VAULT_DIR/Skills/$managed_name" ]; then
          rm -rf "$skills_target/$managed_name"
          removed=$((removed + 1))
        fi
      done < "$manifest"
    fi

    for skill_dir in "$VAULT_DIR/Skills"/*/; do
      [ -d "$skill_dir" ] || continue
      local skill_name
      skill_name=$(basename "$skill_dir")

      local needs_sync=false
      if [ ! -d "$skills_target/$skill_name" ]; then
        needs_sync=true
      else
        local local_hash
        local_hash=$(cd "$skills_target/$skill_name" && find . -type f -exec md5sum {} + 2>/dev/null | sort | md5sum | cut -d' ' -f1)
        if [ "${vault_hashes["$skill_name"]-}" != "$local_hash" ]; then
          needs_sync=true
        fi
      fi

      if [ "$needs_sync" = true ]; then
        rm -rf "$skills_target/$skill_name"
        cp -a "$skill_dir" "$skills_target/$skill_name"
        synced=$((synced + 1))
      else
        unchanged=$((unchanged + 1))
      fi
    done

    local managed_list=""
    for skill_dir in "$VAULT_DIR/Skills"/*/; do
      [ -d "$skill_dir" ] || continue
      managed_list+="$(basename "$skill_dir")"$'\n'
    done
    printf '%s' "$managed_list" > "$skills_target/.vault-managed"

    local total=$((synced + unchanged))
    if [ "$synced" -gt 0 ] || [ "$removed" -gt 0 ]; then
      changes+=("Skills ($skills_target): $synced updated, $removed removed, $unchanged unchanged (total: $total)")
    fi
    echo "Skills ($skills_target): $synced updated, $removed removed, $unchanged unchanged (total: $total)"
  done
}

# -----------------------------------------------------------------------------
# Run all syncs
# -----------------------------------------------------------------------------
echo "--- Vault sync started ---"
sync_claude_md
sync_agents_md
sync_skills

if [ ${#changes[@]} -gt 0 ]; then
  echo "--- Vault sync complete (${#changes[@]} changes) ---"
else
  echo "--- Vault sync complete (everything up to date) ---"
fi

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
GSD_DIR="$HOME/.gsd/agent"

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
    echo "$name: skipped (vault not available)"
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
# CLAUDE.md — always overwrite from vault/Agents/ to ~/.claude/ and ~/.gsd/agent/
# -----------------------------------------------------------------------------
sync_claude_md() {
  sync_file "$AGENTS_SRC/CLAUDE.md" "CLAUDE.md" "$CLAUDE_DIR" "$GSD_DIR"
}

# -----------------------------------------------------------------------------
# AGENTS.md — always overwrite from vault/Agents/ to ~/.claude/ and ~/.gsd/agent/
# -----------------------------------------------------------------------------
sync_agents_md() {
  sync_file "$AGENTS_SRC/AGENTS.md" "AGENTS.md" "$CLAUDE_DIR" "$GSD_DIR"
}

# -----------------------------------------------------------------------------
# Skills — sync vault skill directories to ~/.claude/skills/vault/
# Each vault skill is a directory (e.g. Skills/caveman/) containing SKILL.md
# -----------------------------------------------------------------------------
sync_skills() {
  if [ ! -d "$VAULT_DIR/Skills" ]; then
    echo "Skills: skipped (vault not available)"
    return
  fi

  local skills_target="$CLAUDE_DIR/skills/vault"
  mkdir -p "$skills_target"

  local synced=0
  local removed=0
  local unchanged=0

  # Remove stale skills that no longer exist in vault
  if [ -d "$skills_target" ]; then
    for local_skill in "$skills_target"/*/; do
      [ -d "$local_skill" ] || continue
      local skill_name
      skill_name=$(basename "$local_skill")
      if [ ! -d "$VAULT_DIR/Skills/$skill_name" ]; then
        rm -rf "$local_skill"
        removed=$((removed + 1))
      fi
    done
  fi

  # Sync each skill directory from vault
  for skill_dir in "$VAULT_DIR/Skills"/*/; do
    [ -d "$skill_dir" ] || continue
    local skill_name
    skill_name=$(basename "$skill_dir")

    # Compare using checksums of all files in the skill directory
    local needs_sync=false
    if [ ! -d "$skills_target/$skill_name" ]; then
      needs_sync=true
    else
      # Quick check: compare file counts and content hashes
      local vault_hash local_hash
      vault_hash=$(cd "$skill_dir" && find . -type f -exec md5sum {} + 2>/dev/null | sort | md5sum | cut -d' ' -f1)
      local_hash=$(cd "$skills_target/$skill_name" && find . -type f -exec md5sum {} + 2>/dev/null | sort | md5sum | cut -d' ' -f1)
      if [ "$vault_hash" != "$local_hash" ]; then
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

  local total=$((synced + unchanged))
  if [ "$synced" -gt 0 ] || [ "$removed" -gt 0 ]; then
    changes+=("Skills: $synced updated, $removed removed, $unchanged unchanged (total: $total)")
  fi
  echo "Skills: $synced updated, $removed removed, $unchanged unchanged (total: $total)"
}

# -----------------------------------------------------------------------------
# GSD skills symlink — share vault skills with GSD/pi agent
# ~/.gsd/agent/skills/vault → ~/.claude/skills/vault
# -----------------------------------------------------------------------------
link_gsd_skills() {
  local claude_skills="$CLAUDE_DIR/skills/vault"
  local gsd_skills="$GSD_DIR/skills/vault"

  # Only link if the Claude skills dir exists (sync_skills created it)
  if [ ! -d "$claude_skills" ]; then
    echo "GSD skills: skipped (no Claude skills to link)"
    return
  fi

  mkdir -p "$GSD_DIR/skills"

  # If it's already the correct symlink, nothing to do
  if [ -L "$gsd_skills" ] && [ "$(readlink "$gsd_skills")" = "$claude_skills" ]; then
    echo "GSD skills: symlink already correct"
    return
  fi

  # Remove stale symlink or directory
  rm -rf "$gsd_skills"
  ln -s "$claude_skills" "$gsd_skills"
  changes+=("GSD skills: symlinked to $claude_skills")
  echo "GSD skills: symlinked $gsd_skills → $claude_skills"
}

# -----------------------------------------------------------------------------
# Run all syncs
# -----------------------------------------------------------------------------
echo "--- Vault sync started ---"
sync_claude_md
sync_agents_md
sync_skills
link_gsd_skills

if [ ${#changes[@]} -gt 0 ]; then
  echo "--- Vault sync complete (${#changes[@]} changes) ---"
else
  echo "--- Vault sync complete (everything up to date) ---"
fi

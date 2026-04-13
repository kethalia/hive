#!/bin/bash
# sync-vault.sh — Sync vault config files and skills to local agent directories
#
# Vault is the single source of truth for:
#   - CLAUDE.md  (global Claude Code instructions)
#   - AGENTS.md  (skill registry & context discovery)
#   - Skills/    (skill directories with SKILL.md files)
#
# The post_clone_script in main.tf syncs these files automatically after every
# vault fetch. This script can also be invoked manually:
#   bash ~/sync-vault.sh
#
# Arguments:
#   $1 — fallback CLAUDE.md content (used by init.sh when vault isn't cloned yet)

set -euo pipefail

VAULT_DIR="$HOME/vault"
CLAUDE_DIR="$HOME/.claude"
FALLBACK_CLAUDE_MD="${1:-}"

# Track what changed for logging
changes=()

# -----------------------------------------------------------------------------
# CLAUDE.md — always overwrite from vault
# -----------------------------------------------------------------------------
sync_claude_md() {
  mkdir -p "$CLAUDE_DIR"

  if [ -f "$VAULT_DIR/CLAUDE.md" ]; then
    if [ -f "$CLAUDE_DIR/CLAUDE.md" ] && diff -q "$VAULT_DIR/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md" >/dev/null 2>&1; then
      echo "CLAUDE.md: already in sync"
    else
      cp "$VAULT_DIR/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
      changes+=("CLAUDE.md synced from vault")
      echo "CLAUDE.md: synced from vault"
    fi
  elif [ -n "$FALLBACK_CLAUDE_MD" ] && [ ! -f "$CLAUDE_DIR/CLAUDE.md" ]; then
    echo "$FALLBACK_CLAUDE_MD" > "$CLAUDE_DIR/CLAUDE.md"
    changes+=("CLAUDE.md written from template fallback")
    echo "CLAUDE.md: written from template fallback (vault not available)"
  else
    echo "CLAUDE.md: skipped (vault not available, local copy exists)"
  fi
}

# -----------------------------------------------------------------------------
# AGENTS.md — always overwrite from vault
# -----------------------------------------------------------------------------
sync_agents_md() {
  mkdir -p "$CLAUDE_DIR"

  if [ -f "$VAULT_DIR/AGENTS.md" ]; then
    if [ -f "$CLAUDE_DIR/AGENTS.md" ] && diff -q "$VAULT_DIR/AGENTS.md" "$CLAUDE_DIR/AGENTS.md" >/dev/null 2>&1; then
      echo "AGENTS.md: already in sync"
    else
      cp "$VAULT_DIR/AGENTS.md" "$CLAUDE_DIR/AGENTS.md"
      changes+=("AGENTS.md synced from vault")
      echo "AGENTS.md: synced from vault"
    fi
  else
    echo "AGENTS.md: skipped (vault not available)"
  fi
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
      vault_hash=$(find "$skill_dir" -type f -exec md5sum {} + 2>/dev/null | sort | md5sum | cut -d' ' -f1)
      local_hash=$(find "$skills_target/$skill_name" -type f -exec md5sum {} + 2>/dev/null | sort | md5sum | cut -d' ' -f1)
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

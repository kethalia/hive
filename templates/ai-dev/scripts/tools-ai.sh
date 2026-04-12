#!/bin/bash
set -e

BOLD='\033[0;1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

command_exists() {
  command -v "$1" &> /dev/null
}

install_if_missing() {
  local name=$1
  local check_cmd=$2
  local check_path=$3
  local install_cmd=$4

  if [ -n "$check_cmd" ] && command_exists "$check_cmd"; then
    printf "${GREEN}[ok] $name already installed${RESET}\n"
    return 0
  elif [ -n "$check_path" ] && [ -e "$check_path" ]; then
    printf "${GREEN}[ok] $name already installed${RESET}\n"
    return 0
  fi

  printf "${BOLD}[install] $name...${RESET}\n"
  if eval "$install_cmd"; then
    printf "${GREEN}[ok] $name installed successfully${RESET}\n\n"
  else
    printf "${YELLOW}[warn] $name installation failed, continuing...${RESET}\n\n"
  fi
}

# Ensure PATH includes tool directories
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
mkdir -p "$HOME/.local/bin"

# Force npm global installs into ~/.local (user-writable, already on PATH)
export npm_config_prefix="$HOME/.local"

# Install GSD for Claude Code
install_if_missing "GSD (get-shit-done)" "" "$HOME/.claude/commands/gsd" '
  npx get-shit-done-cc@latest --claude --global --yes 2>/dev/null || \
  npx get-shit-done-cc@latest --claude --global 2>/dev/null || true
'

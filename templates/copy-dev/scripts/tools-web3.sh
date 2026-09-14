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
    printf "${GREEN}[ok] %s already installed${RESET}\n" "$name"
    return 0
  elif [ -n "$check_path" ] && [ -e "$check_path" ]; then
    printf "${GREEN}[ok] %s already installed${RESET}\n" "$name"
    return 0
  fi

  printf "${BOLD}[install] %s...${RESET}\n" "$name"
  if eval "$install_cmd"; then
    printf "${GREEN}[ok] %s installed successfully${RESET}\n\n" "$name"
  else
    printf "${YELLOW}[warn] %s installation failed, continuing...${RESET}\n\n" "$name"
  fi
}

# Install Foundry (check binary path directly — command -v fails before .zshrc is sourced)
# shellcheck disable=SC2016 # The command is intentionally evaluated by install_if_missing.
install_if_missing "Foundry" "" "$HOME/.foundry/bin/forge" '
  curl -L https://foundry.paradigm.xyz | bash &&
  export PATH="$HOME/.foundry/bin:$PATH" &&
  foundryup
'

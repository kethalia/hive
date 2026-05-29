#!/bin/bash
set -e

BOLD='\033[0;1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

command_exists() {
  command -v "$1" &> /dev/null
}

run_step() {
  local name=$1
  local install_cmd=$2

  printf "${BOLD}[install] $name...${RESET}\n"
  if eval "$install_cmd"; then
    printf "${GREEN}[ok] $name completed successfully${RESET}\n\n"
  else
    printf "${YELLOW}[warn] $name failed, continuing...${RESET}\n\n"
  fi
}

# Ensure PATH includes tool directories
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
mkdir -p "$HOME/.local/bin"

# Force npm global installs into ~/.local (user-writable, already on PATH)
export npm_config_prefix="$HOME/.local"

# Remove abandoned pre-OpenGSD packages first. Otherwise stale gsd/gsd-sdk shims can
# remain first on PATH and mask the maintained @opengsd packages.
run_step "Remove legacy GSD packages" '
  npm uninstall -g \
    get-shit-done-cc \
    get-shit-done-redux \
    gsd-pi \
    @gsd-build/sdk \
    @gsd-redux/sdk \
    @gsd-redux/get-shit-done-redux \
    >/dev/null 2>&1 || true
'

# Install OpenGSD core globally so hooks and slash commands resolve the maintained
# gsd-sdk shim, then refresh the Claude Code command surface non-interactively.
run_step "OpenGSD core (Claude Code slash commands)" '
  npm install -g @opengsd/get-shit-done-redux@latest &&
  get-shit-done-redux --claude --global
'

# Install the maintained standalone CLI harness. This provides gsd and gsd-cli.
run_step "OpenGSD Pi CLI" '
  npm install -g @opengsd/gsd-pi@latest
'

gsd_path="$(command -v gsd 2>/dev/null || true)"
gsd_sdk_path="$(command -v gsd-sdk 2>/dev/null || true)"

if [ "$gsd_path" = "$HOME/.local/bin/gsd" ]; then
  printf "${GREEN}[ok] OpenGSD CLI available: %s${RESET}\n" "$gsd_path"
elif [ -n "$gsd_path" ]; then
  printf "${YELLOW}[warn] gsd resolves outside ~/.local/bin after installation: %s${RESET}\n" "$gsd_path"
else
  printf "${YELLOW}[warn] gsd was not found on PATH after installation${RESET}\n"
fi

if [ "$gsd_sdk_path" = "$HOME/.local/bin/gsd-sdk" ]; then
  printf "${GREEN}[ok] OpenGSD SDK available: %s${RESET}\n" "$gsd_sdk_path"
elif [ -n "$gsd_sdk_path" ]; then
  printf "${YELLOW}[warn] gsd-sdk resolves outside ~/.local/bin after installation: %s${RESET}\n" "$gsd_sdk_path"
else
  printf "${YELLOW}[warn] gsd-sdk was not found on PATH after installation${RESET}\n"
fi

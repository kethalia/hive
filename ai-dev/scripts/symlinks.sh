#!/bin/bash
set -e

BOLD='\033[0;1m'
GREEN='\033[0;32m'
RESET='\033[0m'

printf "$${BOLD}Creating tool symlinks in ~/.local/bin...$${RESET}\n"
mkdir -p $HOME/.local/bin

# Node.js / npm / npx — from nvm default version
NVM_DIR="$HOME/.nvm"
if [ -d "$NVM_DIR" ]; then
  # Resolve the default node version directory
  NODE_DIR=$(find "$NVM_DIR/versions/node" -maxdepth 1 -type d | sort -V | tail -1)
  if [ -n "$NODE_DIR" ] && [ -d "$NODE_DIR/bin" ]; then
    for bin in node npm npx corepack; do
      [ -f "$NODE_DIR/bin/$bin" ] && ln -sf "$NODE_DIR/bin/$bin" "$HOME/.local/bin/$bin"
    done
    # Also symlink globally installed npm packages (pi, gsd, etc.)
    for bin in "$NODE_DIR/bin/"*; do
      [ -x "$bin" ] && [ ! -e "$HOME/.local/bin/$(basename "$bin")" ] && ln -sf "$bin" "$HOME/.local/bin/$(basename "$bin")"
    done
    printf "$${GREEN}[ok] Node.js symlinked from $NODE_DIR$${RESET}\n"
  fi
fi

# PNPM
[ -f "$HOME/.local/share/pnpm/pnpm" ] && ln -sf "$HOME/.local/share/pnpm/pnpm" "$HOME/.local/bin/pnpm"
[ -f "$HOME/.local/share/pnpm/pnpx" ] && ln -sf "$HOME/.local/share/pnpm/pnpx" "$HOME/.local/bin/pnpx"

# Bun
[ -f "$HOME/.bun/bin/bun" ] && ln -sf "$HOME/.bun/bin/bun" "$HOME/.local/bin/bun"
[ -f "$HOME/.bun/bin/bunx" ] && ln -sf "$HOME/.bun/bin/bunx" "$HOME/.local/bin/bunx"

# Foundry
for bin in forge cast anvil chisel; do
  [ -f "$HOME/.foundry/bin/$bin" ] && ln -sf "$HOME/.foundry/bin/$bin" "$HOME/.local/bin/$bin"
done

# OpenCode
[ -f "$HOME/.opencode/bin/opencode" ] && ln -sf "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"

printf "$${GREEN}[ok] All tool symlinks created$${RESET}\n"

# Source updated shell configuration
source $HOME/.zshrc 2>/dev/null || true

echo ""
printf "$${GREEN}All development tools are ready!$${RESET}\n"
echo ""

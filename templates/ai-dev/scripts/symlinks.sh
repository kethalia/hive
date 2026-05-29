#!/bin/bash
set -e

BOLD='\033[0;1m'
GREEN='\033[0;32m'
RESET='\033[0m'

printf "${BOLD}Creating tool symlinks in ~/.local/bin...${RESET}\n"
mkdir -p $HOME/.local/bin

# Node.js / npm / npx — prefer known system/module locations. Do not use
# command -v against PATH here: persistent homes can contain stale
# ~/.local/bin/node self-symlinks, and resolving those recreates the loop.
for bin in node npm npx corepack; do
  for candidate in /usr/bin/$bin /usr/local/bin/$bin /opt/node*/bin/$bin; do
    if [ -x "$candidate" ]; then
      ln -sf "$candidate" "$HOME/.local/bin/$bin"
      break
    fi
  done
done
hash -r 2>/dev/null || true

# Symlink globally installed npm packages (claude, etc.)
# The Coder nodejs module installs to /opt/node*/bin/, so check there too
NPM_GLOBAL_BIN=$(npm -g bin 2>/dev/null || echo "")
for bindir in $NPM_GLOBAL_BIN /usr/lib/node_modules/.bin /opt/node*/bin; do
  if [ -d "$bindir" ]; then
    for bin in "$bindir/"*; do
      [ -x "$bin" ] && [ ! -e "$HOME/.local/bin/$(basename "$bin")" ] && ln -sf "$bin" "$HOME/.local/bin/$(basename "$bin")"
    done
  fi
done
printf "${GREEN}[ok] Node.js symlinked${RESET}\n"

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

# Chrome — Playwright looks for /usr/bin/chromium-browser by default
[ -x /usr/bin/google-chrome-stable ] && sudo ln -sf /usr/bin/google-chrome-stable /usr/bin/chromium-browser

printf "${GREEN}[ok] All tool symlinks created${RESET}\n"

echo ""
printf "${GREEN}All development tools are ready!${RESET}\n"
echo ""

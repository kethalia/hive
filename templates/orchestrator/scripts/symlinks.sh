#!/bin/bash
set -e

BOLD='\033[0;1m'
GREEN='\033[0;32m'
RESET='\033[0m'

printf "%sCreating tool symlinks in ~/.local/bin...%s\n" "$BOLD" "$RESET"
mkdir -p "$HOME/.local/bin"

# Node.js / npm / npx — prefer known system/module locations. Do not use
# command -v against PATH here: persistent homes can contain stale
# ~/.local/bin/node self-symlinks, and resolving those recreates the loop.
for bin in node npm npx corepack; do
  for candidate in "/usr/bin/$bin" "/usr/local/bin/$bin" /opt/node*/bin/"$bin"; do
    if [ -x "$candidate" ]; then
      ln -sf "$candidate" "$HOME/.local/bin/$bin"
      break
    fi
  done
done
hash -r 2>/dev/null || true

# Symlink globally installed npm packages (claude, etc.)
# Check system and optional tool-managed Node.js locations.
NPM_GLOBAL_BIN=$(npm -g bin 2>/dev/null || echo "")
for bindir in $NPM_GLOBAL_BIN /usr/lib/node_modules/.bin /opt/node*/bin; do
  if [ -d "$bindir" ]; then
    for bin in "$bindir/"*; do
      [ -x "$bin" ] && [ ! -e "$HOME/.local/bin/$(basename "$bin")" ] && ln -sf "$bin" "$HOME/.local/bin/$(basename "$bin")"
    done
  fi
done
printf "%s[ok] Node.js symlinked%s\n" "$GREEN" "$RESET"

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

# User-writable compatibility name for tools that invoke chromium-browser via PATH.
[ -x /usr/bin/google-chrome-stable ] && ln -sf /usr/bin/google-chrome-stable "$HOME/.local/bin/chromium-browser"

printf "%s[ok] All tool symlinks created%s\n" "$GREEN" "$RESET"

echo ""
printf "%sAll development tools are ready!%s\n" "$GREEN" "$RESET"
echo ""

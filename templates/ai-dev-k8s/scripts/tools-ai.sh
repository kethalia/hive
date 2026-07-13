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

  printf '%b[install] %s...%b\n' "$BOLD" "$name" "$RESET"
  if eval "$install_cmd"; then
    printf '%b[ok] %s completed successfully%b\n\n' "$GREEN" "$name" "$RESET"
  else
    printf '%b[warn] %s failed, continuing...%b\n\n' "$YELLOW" "$name" "$RESET"
  fi
}

repair_node_shims() {
  mkdir -p "$HOME/.local/bin"

  # Existing persistent homes can contain self-referential node/npm shims from an
  # older symlink pass. If those stay first on PATH, every npm install fails with
  # "env: ‘node’: Too many levels of symbolic links".
  for bin in node npm npx corepack; do
    local shim="$HOME/.local/bin/$bin"
    if [ -L "$shim" ]; then
      local target
      target="$(readlink "$shim" 2>/dev/null || true)"
      if [ "$target" = "$shim" ] || [ "$target" = "$HOME/.local/bin/$bin" ]; then
        rm -f "$shim"
      fi
    fi
  done

  local node_dir=""
  for candidate in /usr/bin/node /usr/local/bin/node /opt/node*/bin/node; do
    if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
      node_dir="$(dirname "$candidate")"
      break
    fi
  done

  if [ -z "$node_dir" ]; then
    printf '%b[warn] Node.js runtime not found; npm-based AI installs may fail%b\n' "$YELLOW" "$RESET"
    return 1
  fi

  for bin in node npm npx corepack; do
    if [ -x "$node_dir/$bin" ]; then
      ln -sf "$node_dir/$bin" "$HOME/.local/bin/$bin"
    fi
  done

  hash -r 2>/dev/null || true

  if ! node --version >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
    printf '%b[warn] Node.js shims are still not usable; npm-based AI installs may fail%b\n' "$YELLOW" "$RESET"
    return 1
  fi
}

npm_global_has() {
  npm list -g --depth=0 "$1" >/dev/null 2>&1
}

# Ensure PATH includes tool directories
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
mkdir -p "$HOME/.local/bin"

# Force npm global installs into ~/.local (user-writable, already on PATH)
export npm_config_prefix="$HOME/.local"

repair_node_shims || true

# Remove stale command shims before installing. Otherwise a failed npm run can
# leave abandoned pre-OpenGSD binaries in place and produce a false green check.
rm -f \
  "$HOME/.local/bin/gsd" \
  "$HOME/.local/bin/gsd-cli" \
  "$HOME/.local/bin/gsd-sdk" \
  "$HOME/.local/bin/gsd-tools" \
  "$HOME/.local/bin/get-shit-done-redux" \
  "$HOME/.local/bin/codex"
hash -r 2>/dev/null || true

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

# Install Codex before refreshing OpenGSD's Codex surface.
run_step "Codex CLI" '
  npm install -g @openai/codex@latest
'

# Install OpenGSD core globally so hooks and slash commands resolve the maintained
# gsd-sdk shim, then refresh Claude Code and Codex command/skill surfaces.
# shellcheck disable=SC2016 # The command is intentionally evaluated by run_step.
run_step "OpenGSD core (Claude Code + Codex)" '
  mkdir -p "$HOME/.codex" &&
  npm install -g @opengsd/get-shit-done-redux@latest &&
  get-shit-done-redux --claude --global &&
  get-shit-done-redux --codex --global
'

# Install the maintained standalone CLI harness. This provides gsd and gsd-cli.
run_step "OpenGSD Pi CLI" '
  npm install -g @opengsd/gsd-pi@latest
'

gsd_path="$(command -v gsd 2>/dev/null || true)"
gsd_sdk_path="$(command -v gsd-sdk 2>/dev/null || true)"
codex_path="$(command -v codex 2>/dev/null || true)"

if [ "$gsd_path" = "$HOME/.local/bin/gsd" ] && npm_global_has "@opengsd/gsd-pi"; then
  printf "${GREEN}[ok] OpenGSD CLI available: %s${RESET}\n" "$gsd_path"
elif [ -n "$gsd_path" ]; then
  printf "${YELLOW}[warn] gsd is present but @opengsd/gsd-pi is not verified: %s${RESET}\n" "$gsd_path"
else
  printf '%b[warn] gsd was not found on PATH after installation%b\n' "$YELLOW" "$RESET"
fi

if [ "$gsd_sdk_path" = "$HOME/.local/bin/gsd-sdk" ] && npm_global_has "@opengsd/get-shit-done-redux"; then
  printf "${GREEN}[ok] OpenGSD SDK available: %s${RESET}\n" "$gsd_sdk_path"
elif [ -n "$gsd_sdk_path" ]; then
  printf "${YELLOW}[warn] gsd-sdk is present but @opengsd/get-shit-done-redux is not verified: %s${RESET}\n" "$gsd_sdk_path"
else
  printf '%b[warn] gsd-sdk was not found on PATH after installation%b\n' "$YELLOW" "$RESET"
fi

if [ "$codex_path" = "$HOME/.local/bin/codex" ] && npm_global_has "@openai/codex"; then
  printf "${GREEN}[ok] Codex CLI available: %s${RESET}\n" "$codex_path"
elif [ -n "$codex_path" ]; then
  printf "${YELLOW}[warn] codex is present but @openai/codex is not verified: %s${RESET}\n" "$codex_path"
else
  printf '%b[warn] codex was not found on PATH after installation%b\n' "$YELLOW" "$RESET"
fi

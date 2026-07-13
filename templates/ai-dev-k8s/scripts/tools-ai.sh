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

# Keep verified persistent installs in place. New packages are installed with
# npm's own replacement handling, so a transient registry failure never starts
# by deleting working command shims.
if npm_global_has "@openai/codex" && command_exists codex; then
  printf '%b[ok] Codex CLI already installed%b\n' "$GREEN" "$RESET"
else
  run_step "Codex CLI" '
    npm install -g --force @openai/codex@latest
  '
fi

hash -r 2>/dev/null || true

codex_path="$(command -v codex 2>/dev/null || true)"

if [ "$codex_path" = "$HOME/.local/bin/codex" ] && npm_global_has "@openai/codex"; then
  printf "${GREEN}[ok] Codex CLI available: %s${RESET}\n" "$codex_path"
elif [ -n "$codex_path" ]; then
  printf "${YELLOW}[warn] codex is present but @openai/codex is not verified: %s${RESET}\n" "$codex_path"
else
  printf '%b[warn] codex was not found on PATH after installation%b\n' "$YELLOW" "$RESET"
fi

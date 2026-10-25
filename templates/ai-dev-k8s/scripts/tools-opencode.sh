#!/usr/bin/env bash
set -euo pipefail

# Keep model servers and weights outside these thin interactive workspaces.
# Never write user provider configuration or credentials during provisioning.
version=1.19.4
export PATH="$HOME/.local/bin:$PATH"
if command -v opencode >/dev/null 2>&1; then
  printf '%s\n' '[ok] Keeping the existing OpenCode installation'
  opencode --version
  exit 0
fi
timeout 150s npm install --global --prefix "$HOME/.local" "opencode-ai@$version" --no-audit --no-fund
opencode --version

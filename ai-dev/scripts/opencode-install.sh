#!/bin/bash
set -e

# Install OpenCode if not present
if ! command -v opencode &> /dev/null && [ ! -f "$HOME/.opencode/bin/opencode" ]; then
  echo "Installing OpenCode..."
  curl -fsSL https://opencode.ai/install | bash
else
  echo "OpenCode already installed"
fi

# Write OpenCode config
mkdir -p "$HOME/.config/opencode"
echo '${opencode_config_json}' > "$HOME/.config/opencode/config.json"
echo "OpenCode configured"

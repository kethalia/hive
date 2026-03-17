#!/bin/bash
set -e

mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

# Install Claude Code if not present
if ! command -v claude &> /dev/null; then
  echo "Installing Claude Code..."
  # MUST use bash, not sh — Ubuntu's sh is dash which can't parse the installer
  curl -fsSL https://claude.ai/install.sh | bash
  echo "Claude Code install script completed"
else
  echo "Claude Code already installed at $(command -v claude)"
fi

# Verify the binary exists
if command -v claude &> /dev/null; then
  echo "Claude Code ready: $(command -v claude)"
else
  echo "ERROR: Claude Code binary not found after install"
  exit 1
fi

%{if claude_api_key != ""}
export ANTHROPIC_API_KEY="${claude_api_key}"
grep -q 'ANTHROPIC_API_KEY' "$HOME/.bashrc" 2>/dev/null || echo 'export ANTHROPIC_API_KEY="${claude_api_key}"' >> "$HOME/.bashrc"
grep -q 'ANTHROPIC_API_KEY' "$HOME/.zshrc" 2>/dev/null || echo 'export ANTHROPIC_API_KEY="${claude_api_key}"' >> "$HOME/.zshrc"
grep -q 'ANTHROPIC_API_KEY' "$HOME/.zshenv" 2>/dev/null || echo 'export ANTHROPIC_API_KEY="${claude_api_key}"' >> "$HOME/.zshenv"
%{endif}

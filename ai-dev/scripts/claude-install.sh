#!/bin/bash
set -e

export PATH="$HOME/.local/bin:$PATH"

# Install Claude Code if not present
if ! command -v claude &> /dev/null; then
  echo "Installing Claude Code..."
  curl -fsSL https://claude.ai/install.sh | sh
else
  echo "Claude Code already installed"
fi

%{if claude_api_key != ""}
export ANTHROPIC_API_KEY="${claude_api_key}"
echo 'export ANTHROPIC_API_KEY="${claude_api_key}"' >> "$HOME/.bashrc"
grep -q 'ANTHROPIC_API_KEY' "$HOME/.zshrc" 2>/dev/null || echo 'export ANTHROPIC_API_KEY="${claude_api_key}"' >> "$HOME/.zshrc"
%{endif}

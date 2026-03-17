#!/bin/bash
set -e

export PATH="$HOME/.local/bin:$PATH"

# Install Claude Code if not present
if ! command -v claude &> /dev/null; then
  echo "Installing Claude Code..."
  curl -fsSL https://claude.ai/install.sh | sh

  # Ensure claude is accessible from ~/.local/bin
  # The installer may place it in ~/.claude/local/bin or other locations
  if ! command -v claude &> /dev/null; then
    for candidate in "$HOME/.claude/local/bin/claude" "$HOME/.claude/bin/claude"; do
      if [ -x "$candidate" ]; then
        ln -sf "$candidate" "$HOME/.local/bin/claude"
        echo "Symlinked claude from $candidate to ~/.local/bin/claude"
        break
      fi
    done
  fi

  # Verify installation
  if command -v claude &> /dev/null; then
    echo "Claude Code installed successfully"
  else
    echo "WARNING: Claude Code install completed but binary not found on PATH"
    # Search for it anywhere under home
    CLAUDE_BIN=$(find "$HOME" -name "claude" -type f -executable 2>/dev/null | head -1)
    if [ -n "$CLAUDE_BIN" ]; then
      ln -sf "$CLAUDE_BIN" "$HOME/.local/bin/claude"
      echo "Found and symlinked claude from $CLAUDE_BIN"
    fi
  fi
else
  echo "Claude Code already installed"
fi

%{if claude_api_key != ""}
export ANTHROPIC_API_KEY="${claude_api_key}"
echo 'export ANTHROPIC_API_KEY="${claude_api_key}"' >> "$HOME/.bashrc"
grep -q 'ANTHROPIC_API_KEY' "$HOME/.zshrc" 2>/dev/null || echo 'export ANTHROPIC_API_KEY="${claude_api_key}"' >> "$HOME/.zshrc"
grep -q 'ANTHROPIC_API_KEY' "$HOME/.zshenv" 2>/dev/null || echo 'export ANTHROPIC_API_KEY="${claude_api_key}"' >> "$HOME/.zshenv"
%{endif}

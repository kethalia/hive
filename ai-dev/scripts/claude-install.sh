#!/bin/bash
set -e

mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

# Install Claude Code if not present
if ! command -v claude &> /dev/null; then
  echo "Installing Claude Code..."
  curl -fsSL https://claude.ai/install.sh | sh

  # The installer uses whatever npm is on PATH (often the nodejs Coder module's
  # node at /opt/node*/bin/). The binary ends up there, NOT on our PATH.
  # Find it and symlink to ~/.local/bin so all shells can use it.
  if [ ! -x "$HOME/.local/bin/claude" ]; then
    CLAUDE_BIN=$(command -v claude 2>/dev/null || find / -name "claude" -type f -executable -not -path "*//.git/*" 2>/dev/null | head -1)
    if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
      ln -sf "$CLAUDE_BIN" "$HOME/.local/bin/claude"
      echo "Symlinked claude from $CLAUDE_BIN to ~/.local/bin/claude"
    else
      echo "WARNING: Claude Code binary not found after install"
    fi
  fi
else
  # Already installed — ensure symlink exists in ~/.local/bin
  CLAUDE_BIN=$(command -v claude 2>/dev/null)
  if [ -n "$CLAUDE_BIN" ] && [ ! -e "$HOME/.local/bin/claude" ]; then
    ln -sf "$CLAUDE_BIN" "$HOME/.local/bin/claude"
  fi
  echo "Claude Code already installed"
fi

%{if claude_api_key != ""}
export ANTHROPIC_API_KEY="${claude_api_key}"
echo 'export ANTHROPIC_API_KEY="${claude_api_key}"' >> "$HOME/.bashrc"
grep -q 'ANTHROPIC_API_KEY' "$HOME/.zshrc" 2>/dev/null || echo 'export ANTHROPIC_API_KEY="${claude_api_key}"' >> "$HOME/.zshrc"
grep -q 'ANTHROPIC_API_KEY' "$HOME/.zshenv" 2>/dev/null || echo 'export ANTHROPIC_API_KEY="${claude_api_key}"' >> "$HOME/.zshenv"
%{endif}

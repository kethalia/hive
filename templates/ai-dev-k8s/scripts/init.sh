#!/bin/bash
set -e

# One-time initialization
if [ ! -f ~/.workspace_initialized ]; then
  echo "First-time workspace setup..."

  # Create directory structure
  mkdir -p ~/projects ~/bin ~/.config ~/.local/bin

  # Setup git aliases
  git config --global alias.st status
  git config --global alias.co checkout
  git config --global alias.br branch
  git config --global alias.cm commit
  git config --global alias.lg "log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit"

  # Dotfiles are handled by the coder/dotfiles module in main.tf

  # Create workspace README
  if [ ! -f ~/README.md ]; then
    cat > ~/README.md << 'EOFREADME'
# ${workspace_name}

## Quick Start Guide

### AI-Assisted Development
- **Claude Code**: `claude` in terminal or use the web app
- **Codex CLI**: `codex` in terminal with Playwright MCP and vault skills wired

### Available Tools & Versions
- **Node.js**: v24 (default), also available: 18, 20, 22
- **Package Managers**: PNPM, Yarn, Bun
- **Foundry**: Ethereum development toolkit
- **act**: Run GitHub Actions locally
- **Container builds**: Use a rootless or remote builder; no host Docker socket is mounted

### Shell
- **ZSH** with Starship prompt
- **tmux** for session persistence
- **direnv** for per-project env management

### Browser Vision
Claude Code and Codex can see what you're developing in a browser:
- **Claude Code/Codex**: Just ask! (e.g. "screenshot localhost:3000")
- **CLI helpers**: `browser-screenshot <url>` or `browser-html <url>`

### Useful Commands

```bash
# AI Agents
claude                       # Start Claude Code
codex                        # Start Codex CLI

# Node.js
node --version               # Check Node version
pnpm install                 # Install with PNPM
yarn install                 # Install with Yarn
bun install                  # Install with Bun

# Git
gs                           # git status
gco -b feature/new           # Create branch
gc -m "message"              # Commit
git lg                       # Pretty log
```

### Workspace Info
- **Owner**: ${owner_name}
- **Email**: ${owner_email}
- **Created**: $(date)
EOFREADME
  fi

  # Mark as initialized
  touch ~/.workspace_initialized
  echo "Workspace initialized"
fi

# Ensure tools are on PATH (prepend without overriding agent PATH)
export PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"

# Codex MCP config — user-level config is shared by the Codex CLI and IDE.
# Managed as a marked block so user settings outside the block are preserved.
configure_codex_mcp() {
  mkdir -p "$HOME/.codex"
  python3 - <<'PYCODEX'
import os
from pathlib import Path

config = Path(os.environ["HOME"]) / ".codex" / "config.toml"
config.parent.mkdir(parents=True, exist_ok=True)
existing = config.read_text() if config.exists() else ""
start = "# >>> hive-managed-codex-mcp"
end = "# <<< hive-managed-codex-mcp"
block = f"""{start}
[mcp_servers.hive_obsidian]
command = "npx"
args = ["-y", "@bitbonsai/mcpvault@0.11.0", "/home/coder/vault"]

[mcp_servers.hive_playwright]
command = "npx"
args = ["-y", "@playwright/mcp", "--no-sandbox"]

[mcp_servers.hive_playwright.env]
DISPLAY = ":1"
{end}
"""

if start in existing and end in existing:
    before = existing.split(start, 1)[0].rstrip()
    after = existing.split(end, 1)[1].lstrip()
    pieces = [part for part in (before, block.rstrip(), after.rstrip()) if part]
    updated = "\n\n".join(pieces) + "\n"
else:
    updated = (existing.rstrip() + "\n\n" if existing.strip() else "") + block

if updated != existing:
    config.write_text(updated)
    print(f"Codex MCP config synced at {config}")
else:
    print(f"Codex MCP config already in sync at {config}")
PYCODEX
  chmod 600 "$HOME/.codex/config.toml"
}

configure_codex_mcp

# Per-start initialization
echo "Starting workspace services..."

# XFCE autostart — Obsidian launches automatically when the desktop starts.
# /home/coder is a volume mount, so we copy from the image-baked staging dir.
mkdir -p "$HOME/.config/autostart"
if [ -d /usr/share/hive/autostart ] && ls /usr/share/hive/autostart/*.desktop >/dev/null 2>&1; then
  cp /usr/share/hive/autostart/*.desktop "$HOME/.config/autostart/"
fi

# =============================================================================
# Vault sync — deploy sync-vault.sh and run it
# sync-vault.sh is the single source of truth for syncing CLAUDE.md, AGENTS.md,
# Skills from the vault.
# It's also called by the post_clone_script in main.tf after every vault fetch.
# Obsidian creates .obsidian/ automatically on first launch.
# mcp.json is baked into the Docker image (docker/hive-base/claude-mcp.json).
# =============================================================================

# Deploy sync-vault.sh to ~/sync-vault.sh (used by post_clone_script too)
# shellcheck disable=SC2154 # Populated by Terraform templatefile().
printf '%s' "${sync_vault_script_b64}" | base64 -d > "$HOME/sync-vault.sh"
chmod +x "$HOME/sync-vault.sh"

# CLAUDE.md fallback: if vault isn't available yet, write template content
# so the workspace has a working CLAUDE.md from first boot.
# sync-vault.sh will overwrite this with the vault version once it's cloned.
if [ ! -f "$HOME/vault/Agents/CLAUDE.md" ] && [ ! -f "$HOME/.claude/CLAUDE.md" ]; then
  mkdir -p "$HOME/.claude"
  cat > "$HOME/.claude/CLAUDE.md" << 'CLAUDEEOF'
${claude_md_content}
CLAUDEEOF
  echo "CLAUDE.md: written from template fallback (vault not available yet)"
fi

# Run vault sync (syncs CLAUDE.md, AGENTS.md, and Skills)
"$HOME/sync-vault.sh"

echo ""
echo "Workspace is ready!"
echo "Check ~/README.md for quick start guide"
echo ""

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
- **GSD**: `/gsd:help` inside Claude Code

### Available Tools & Versions
- **Node.js**: v24 (default), also available: 18, 20, 22
- **Package Managers**: PNPM, Yarn, Bun
- **Docker & Docker Compose**: Latest
- **Foundry**: Ethereum development toolkit
- **act**: Run GitHub Actions locally

### Shell
- **ZSH** with Starship prompt
- **tmux** for session persistence
- **direnv** for per-project env management

### Browser Vision
Claude Code can see what you're developing in a browser:
- **Claude Code**: Just ask! (e.g. "screenshot localhost:3000")
- **CLI helpers**: `browser-screenshot <url>` or `browser-html <url>`

### Useful Commands

```bash
# AI Agents
claude                       # Start Claude Code

# Docker
docker ps                    # List running containers
docker-compose up -d         # Start services

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

# =============================================================================
# Hive Task: Clone target repository and checkout branch
# =============================================================================

if [ -n "$HIVE_REPO_URL" ]; then
  echo "Cloning task repository: $HIVE_REPO_URL"
  if [ ! -d /home/coder/project ]; then
    git clone "$HIVE_REPO_URL" /home/coder/project
    echo "Repository cloned to /home/coder/project"
  else
    echo "Project directory already exists, skipping clone"
  fi

  if [ -n "$HIVE_BRANCH_NAME" ] && [ -d /home/coder/project ]; then
    cd /home/coder/project
    git checkout -b "$HIVE_BRANCH_NAME" 2>/dev/null || git checkout "$HIVE_BRANCH_NAME" 2>/dev/null || echo "Warning: could not checkout branch $HIVE_BRANCH_NAME"
    echo "Checked out branch: $HIVE_BRANCH_NAME"
  fi
fi

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
# Skills, and GSD skills symlinks from the vault.
# It's also called by the post_clone_script in main.tf after every vault fetch.
# Obsidian creates .obsidian/ automatically on first launch.
# mcp.json is baked into the Docker image (docker/hive-base/claude-mcp.json).
# =============================================================================

# Deploy sync-vault.sh to ~/sync-vault.sh (used by post_clone_script too)
echo "${sync_vault_script_b64}" | base64 -d > "$HOME/sync-vault.sh"
chmod +x "$HOME/sync-vault.sh"

# CLAUDE.md fallback: if vault isn't available yet, write template content
# so the workspace has a working CLAUDE.md from first boot.
# sync-vault.sh will overwrite this with the vault version once it's cloned.
if [ ! -f "$HOME/vault/CLAUDE.md" ] && [ ! -f "$HOME/.claude/CLAUDE.md" ]; then
  mkdir -p "$HOME/.claude"
  cat > "$HOME/.claude/CLAUDE.md" << 'CLAUDEEOF'
${claude_md_content}
CLAUDEEOF
  echo "CLAUDE.md: written from template fallback (vault not available yet)"
fi

# Run vault sync (syncs CLAUDE.md, AGENTS.md, Skills, GSD skills symlink)
"$HOME/sync-vault.sh"

# Verify Docker access
if docker info &> /dev/null; then
  echo "Docker is accessible"
else
  echo "Warning: Docker is not accessible. Check socket mount."
fi

echo ""
echo "Workspace is ready!"
echo "Check ~/README.md for quick start guide"
echo ""

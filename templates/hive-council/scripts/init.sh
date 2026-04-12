#!/bin/bash
set -e

# One-time initialization
if [ ! -f ~/.workspace_initialized ]; then
  echo "First-time workspace setup..."

  # Create directory structure
  mkdir -p ~/projects ~/bin ~/.config ~/.local/bin ~/vault

  # Setup git aliases
  git config --global alias.st status
  git config --global alias.co checkout
  git config --global alias.br branch
  git config --global alias.cm commit
  git config --global alias.lg "log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit"

  # Clone dotfiles if specified
  %{if dotfiles_uri != ""}
  if [ ! -d ~/.dotfiles ]; then
    echo "Cloning dotfiles..."
    git clone ${dotfiles_uri} ~/.dotfiles && cd ~/.dotfiles && ./install.sh || true
  fi
  %{endif}

  # Create workspace README
  if [ ! -f ~/README.md ]; then
    cat > ~/README.md << 'EOFREADME'
# ${workspace_name}

## Quick Start Guide

### Council Reviewer Environment
This is a **council reviewer workspace** — it runs AI-powered code review using Claude Code
against PR branches.

### Available Tools & Versions
- **Node.js**: v24 (default), also available: 18, 20, 22
- **Package Managers**: PNPM, Yarn, Bun
- **Docker & Docker Compose**: Latest
- **Claude Code**: AI code review CLI

### Shell
- **ZSH** with Starship prompt
- **tmux** for session persistence
- **direnv** for per-project env management

### Useful Commands

```bash
# Code Review
claude review                # Run Claude Code review
claude analyze               # Analyze codebase

# Testing
npm test                     # Run tests
npm run build                # Build project
npm run lint                 # Run linter

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
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"

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

# =============================================================================
# Vault setup — Claude Code context wiring
# Clone is handled by the coder/git-clone module in main.tf (if vault_repo is set)
# Obsidian creates .obsidian/ automatically on first launch
# =============================================================================

# Claude Code context wiring
# mcp.json is baked into the Docker image (docker/hive-base/claude-mcp.json)
# Write CLAUDE.md only on first run — user edits are preserved on subsequent starts
if [ ! -f ~/.claude/CLAUDE.md ]; then
  cat > ~/.claude/CLAUDE.md << 'CLAUDEEOF'
${claude_md_content}
CLAUDEEOF
  echo "Claude Code vault context written to ~/.claude/CLAUDE.md"
fi

# Sync vault Skills → ~/.claude/skills/vault/ (isolated subdir to avoid polluting bundled skills)
if [ -d ~/vault/Skills ]; then
  mkdir -p ~/.claude/skills/vault
  # Remove stale skills from previous syncs
  rm -f ~/.claude/skills/vault/*.md
  for skill_file in ~/vault/Skills/*.md; do
    [ -f "$skill_file" ] || continue
    skill_name=$(basename "$skill_file" .md | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
    cp "$skill_file" "$HOME/.claude/skills/vault/$skill_name.md"
  done
  echo "Vault skills synced to ~/.claude/skills/vault/"
fi

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

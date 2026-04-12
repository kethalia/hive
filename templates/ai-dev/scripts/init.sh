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

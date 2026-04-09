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

### AI-Assisted Development
- **Claude Code**: `claude` in terminal or use the web app
- **OpenCode**: `opencode` in terminal or use the web UI
- **Pi**: `pi` in terminal
- **GSD (Claude/OpenCode)**: `/gsd:help` inside Claude Code or OpenCode
- **GSD (Pi)**: `/gsd help` inside Pi

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
All AI agents can see what you're developing in a browser:
- **Claude Code & OpenCode**: Just ask! (e.g. "screenshot localhost:3000")
- **Pi**: Use \`browser-screenshot <url>\` or \`browser-html <url>\`

### Useful Commands

```bash
# AI Agents
claude                       # Start Claude Code
opencode                     # Start OpenCode
pi                           # Start Pi coding agent

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
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"

# Per-start initialization
echo "Starting workspace services..."

# Clone or pull vault on every start
%{if vault_repo != ""}
VAULT_REPO="${vault_repo}"
if [ ! -d ~/vault/.git ]; then
  echo "Cloning Obsidian vault..."
  # Build HTTPS URL with token from gh CLI auth store
  if echo "$VAULT_REPO" | grep -q "github.com"; then
    REPO_PATH=$(echo "$VAULT_REPO" | sed 's|.*github.com[:/]||' | sed 's|\.git$||')
    GH_TOKEN=$(gh auth token 2>/dev/null || echo "")
    if [ -n "$GH_TOKEN" ]; then
      git clone "https://x-access-token:$GH_TOKEN@github.com/$REPO_PATH.git" ~/vault \
        && echo "Vault cloned successfully" \
        || echo "WARNING: vault clone failed"
    else
      git clone "$VAULT_REPO" ~/vault || echo "WARNING: vault clone failed"
    fi
  else
    git clone "$VAULT_REPO" ~/vault || echo "WARNING: vault clone failed"
  fi
else
  echo "Pulling vault updates..."
  git -C ~/vault pull --ff-only 2>/dev/null || true
fi

# Bootstrap .obsidian config if vault has none (fresh repo)
if [ -d ~/vault ] && [ ! -d ~/vault/.obsidian ]; then
  mkdir -p ~/vault/.obsidian
  echo '{"legacyEditor":false,"livePreview":true}' > ~/vault/.obsidian/app.json
  echo '{}' > ~/vault/.obsidian/appearance.json
  echo "Created .obsidian config in vault"
fi

# Configure Obsidian MCP + CLAUDE.md + sync vault skills
%{if vault_repo != ""}
if [ -d ~/vault ]; then
  # 1. Register mcp-obsidian in Claude Code's MCP config
  mkdir -p ~/.claude
  CLAUDE_MCP="$HOME/.claude/mcp.json"
  python3 -c "
import json, os
path = os.path.expanduser('~/.claude/mcp.json')
try:
    cfg = json.load(open(path))
except:
    cfg = {}
servers = cfg.get('mcpServers', {})
servers['obsidian'] = {
    'command': 'npx',
    'args': ['-y', '@bitbonsai/mcpvault@latest', '/home/coder/vault'],
    'env': {}
}
cfg['mcpServers'] = servers
json.dump(cfg, open(path, 'w'), indent=2)
print('Obsidian MCP registered in ~/.claude/mcp.json')
" 2>/dev/null || true

  # 2. Write a lean CLAUDE.md — instructs Claude to use the MCP, not raw file reads
  cat > ~/.claude/CLAUDE.md << 'CLAUDEEOF'
# Second Brain

Your user maintains a personal knowledge vault at `~/vault`, accessible via the `obsidian` MCP server.

## How to use the vault

Before starting any task, use the obsidian MCP to load relevant context:
- `mcp__obsidian__search_notes` — search by keyword across the whole vault
- `mcp__obsidian__read_note` — read a specific note
- `mcp__obsidian__list_notes` — list notes in a folder

Key folders: `Projects/`, `Decision Log/`, `Patterns/`, `Principles/`, `Tech Stack/`, `Profile/`, `Knowledge Base/`

## Writing back

When you make a significant decision, discover a pattern, or complete a milestone — offer to update the relevant vault file.

## Skills

Custom slash commands for this vault are in `~/vault/Skills/`. Run `/help` in Claude Code to see them.
CLAUDEEOF
  echo "Claude Code vault context configured at ~/.claude/CLAUDE.md"

  # 3. Sync vault skills to Claude Code skills directory
  if [ -d ~/vault/Skills ]; then
    mkdir -p ~/.claude/skills
    for skill_file in ~/vault/Skills/*.md; do
      [ -f "$skill_file" ] || continue
      skill_name=$(basename "$skill_file" .md | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
      dest="$HOME/.claude/skills/$skill_name.md"
      cp "$skill_file" "$dest"
      echo "Synced skill: $skill_name"
    done
  fi
fi
%{endif}
%{endif}

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

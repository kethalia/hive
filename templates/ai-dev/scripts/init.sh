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
- **Pi**: Use `browser-screenshot <url>` or `browser-html <url>`

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

# =============================================================================
# Vault sync — clone/pull Obsidian second brain + wire Claude Code context
# Prefer templatefile var, fall back to VAULT_REPO env (old workspaces)
# =============================================================================

# Always ensure vault directory and .obsidian config exist.
# obsidian-launch (openbox autostart) waits for ~/vault/.obsidian before opening Obsidian.
mkdir -p ~/vault
if [ ! -d ~/vault/.obsidian ]; then
  mkdir -p ~/vault/.obsidian
  echo '{"legacyEditor":false,"livePreview":true}' > ~/vault/.obsidian/app.json
  echo '{}' > ~/vault/.obsidian/appearance.json
  echo "Created .obsidian config in vault"
fi

EFFECTIVE_VAULT_REPO="${vault_repo}"
if [ -z "$EFFECTIVE_VAULT_REPO" ] && [ -n "$VAULT_REPO" ]; then
  EFFECTIVE_VAULT_REPO="$VAULT_REPO"
fi

if [ -n "$EFFECTIVE_VAULT_REPO" ]; then
  # Find Coder agent binary for gitssh (SSH key injection without needing a key on disk)
  CODER_BIN=$(command -v coder 2>/dev/null || find /tmp -maxdepth 2 -name 'coder' -path '/tmp/coder.*' -print -quit 2>/dev/null || true)
  if [ -n "$CODER_BIN" ]; then
    export GIT_SSH_COMMAND="$CODER_BIN gitssh --"
  fi

  # Ensure github.com host key is trusted (deduplicate on repeat runs)
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  if ! ssh-keygen -F github.com >/dev/null 2>&1; then
    echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" >> ~/.ssh/known_hosts
    echo "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=" >> ~/.ssh/known_hosts
  fi

  # If ~/vault exists but isn't a git repo, move it aside rather than destroying it
  if [ -d ~/vault ] && [ ! -d ~/vault/.git ]; then
    echo "Moving non-git ~/vault aside..."
    if ! mv ~/vault ~/vault-bak-$(date +%s); then
      echo "WARNING: could not move ~/vault aside — skipping vault clone"
      EFFECTIVE_VAULT_REPO=""
    fi
  fi

  if [ -n "$EFFECTIVE_VAULT_REPO" ]; then
    if [ ! -d ~/vault/.git ]; then
      echo "Cloning Obsidian vault..."
      git clone "$EFFECTIVE_VAULT_REPO" ~/vault \
        && echo "Vault cloned successfully" \
        || echo "WARNING: vault clone failed — check SSH key and repo URL"
    else
      echo "Pulling vault updates..."
      git -C ~/vault pull --ff-only \
        || echo "WARNING: vault pull failed — vault may be stale (diverged branch or network error)"
    fi
  fi
fi  # if [ -n "$EFFECTIVE_VAULT_REPO" ]

# Wire Claude Code vault context (always runs — vault always exists after mkdir above)
mkdir -p ~/.claude
python3 - << 'PYEOF'
import json, os
path = os.path.expanduser('~/.claude/mcp.json')
try:
    cfg = json.load(open(path))
except (OSError, json.JSONDecodeError):
    cfg = {}
servers = cfg.get('mcpServers', {})
servers['obsidian'] = {
    'command': 'npx',
    'args': ['-y', '@bitbonsai/mcpvault@1.0.4', '/home/coder/vault'],
    'env': {}
}
cfg['mcpServers'] = servers
json.dump(cfg, open(path, 'w'), indent=2)
print('Obsidian MCP registered in ~/.claude/mcp.json')
PYEOF

# Write CLAUDE.md only on first run — user edits are preserved on subsequent starts
if [ ! -f ~/.claude/CLAUDE.md ]; then
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

terraform {
  required_providers {
    coder = {
      source = "coder/coder"
    }
    docker = {
      source = "kreuzwerker/docker"
    }
  }
}

locals {
  username = data.coder_workspace_owner.me.name
}

# =============================================================================
# Variables
# =============================================================================

variable "docker_socket" {
  description = "(Optional) Docker socket URI"
  type        = string
  default     = ""
}

variable "dotfiles_uri" {
  description = "Git URI for dotfiles repository (optional)"
  type        = string
  default     = ""
}

# --- OpenCode Configuration ---

variable "opencode_model" {
  description = "Default model for OpenCode"
  type        = string
  default     = "anthropic/claude-sonnet-4-20250514"
}

variable "opencode_config_json" {
  description = "Full OpenCode config JSON override (takes precedence over opencode_model when non-empty)"
  type        = string
  default     = ""
}

# --- Claude Code Configuration ---

variable "claude_code_model" {
  description = "Default model for Claude Code (e.g. sonnet, opus, or full model name)"
  type        = string
  default     = ""
}

variable "claude_code_api_key" {
  description = "Anthropic API key for Claude Code (leave empty to use AI Bridge or external auth)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "claude_code_system_prompt" {
  description = "Custom system prompt for Claude Code"
  type        = string
  default     = ""
}

variable "claude_code_allowed_tools" {
  description = "Comma-separated list of allowed tools for Claude Code"
  type        = string
  default     = ""
}

# --- Pi Coding Agent Configuration ---

variable "pi_api_key" {
  description = "API key for Pi coding agent LLM provider (e.g. Anthropic key)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "pi_model" {
  description = "Model for Pi coding agent (e.g. claude-sonnet-4-20250514)"
  type        = string
  default     = "claude-sonnet-4-20250514"
}

variable "pi_provider" {
  description = "LLM provider for Pi coding agent (e.g. anthropic, openai, google)"
  type        = string
  default     = "anthropic"
}

# =============================================================================
# Providers & Data Sources
# =============================================================================

provider "docker" {
  host = var.docker_socket != "" ? var.docker_socket : null
}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

# =============================================================================
# Coder Agent
# =============================================================================

resource "coder_agent" "main" {
  arch           = data.coder_provisioner.me.arch
  os             = "linux"
  startup_script = <<-EOT
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
      %{if var.dotfiles_uri != ""}
      if [ ! -d ~/.dotfiles ]; then
        echo "Cloning dotfiles..."
        git clone ${var.dotfiles_uri} ~/.dotfiles && cd ~/.dotfiles && ./install.sh || true
      fi
      %{endif}

      # Create workspace README
      if [ ! -f ~/README.md ]; then
        cat > ~/README.md << 'EOFREADME'
# ${data.coder_workspace.me.name}

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
- **Owner**: ${data.coder_workspace_owner.me.name}
- **Email**: ${data.coder_workspace_owner.me.email}
- **Created**: $(date)
EOFREADME
      fi

      # Mark as initialized
      touch ~/.workspace_initialized
      echo "Workspace initialized"
    fi

    # Per-start initialization
    echo "Starting workspace services..."

    # Verify Docker access
    if docker info &> /dev/null; then
      echo "Docker is accessible"
    else
      echo "Warning: Docker is not accessible. Check socket mount."
    fi

    # Source shell configuration
    source ~/.zshrc 2>/dev/null || true

    echo ""
    echo "Workspace is ready!"
    echo "Check ~/README.md for quick start guide"
    echo ""
  EOT

  env = {
    GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_AUTHOR_EMAIL    = "${data.coder_workspace_owner.me.email}"
    GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_COMMITTER_EMAIL = "${data.coder_workspace_owner.me.email}"

    EXTENSIONS_GALLERY = "{\"serviceUrl\":\"https://marketplace.visualstudio.com/_apis/public/gallery\"}"

    # Ensure all tools are on PATH for non-interactive shells (AI agents, subprocesses)
    PATH = "/home/coder/.local/bin:/home/coder/.opencode/bin:/home/coder/.local/share/pnpm:/home/coder/.bun/bin:/home/coder/.foundry/bin:/usr/local/bin:/usr/bin:/bin"
  }

  metadata {
    display_name = "CPU Usage"
    key          = "0_cpu_usage"
    script       = "coder stat cpu"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "RAM Usage"
    key          = "1_ram_usage"
    script       = "coder stat mem"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "Home Disk"
    key          = "3_home_disk"
    script       = "coder stat disk --path $${HOME}"
    interval     = 60
    timeout      = 1
  }

  metadata {
    display_name = "CPU Usage (Host)"
    key          = "4_cpu_usage_host"
    script       = "coder stat cpu --host"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "Memory Usage (Host)"
    key          = "5_mem_usage_host"
    script       = "coder stat mem --host"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "Load Average (Host)"
    key          = "6_load_host"
    script   = <<EOT
      echo "`cat /proc/loadavg | awk '{ print $1 }'` `nproc`" | awk '{ printf "%0.2f", $1/$2 }'
    EOT
    interval = 60
    timeout  = 1
  }

  metadata {
    display_name = "Swap Usage (Host)"
    key          = "7_swap_host"
    script       = <<EOT
      free -b | awk '/^Swap/ { printf("%.1f/%.1f", $3/1024.0/1024.0/1024.0, $2/1024.0/1024.0/1024.0) }'
    EOT
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "Workspace Size"
    key          = "10_workspace_size"
    script       = "du -sh /home/coder 2>/dev/null | cut -f1 || echo 'N/A'"
    interval     = 300
    timeout      = 10
  }
}

# =============================================================================
# External Auth
# =============================================================================

data "coder_external_auth" "github" {
  id = "primary-github"
}

# =============================================================================
# VS Code Server
# =============================================================================

module "code-server" {
  count   = data.coder_workspace.me.start_count
  source  = "registry.coder.com/modules/code-server/coder"
  version = ">= 1.0.0"

  agent_id              = coder_agent.main.id
  order                 = 1
  subdomain             = true
  use_cached_extensions = true

  extensions = [
    "binary-ink.dark-modern-oled-theme-set",
    "pkief.material-icon-theme",
    "prisma.prisma",
    "graphql.vscode-graphql",
    "graphql.vscode-graphql-syntax",
    "bradlc.vscode-tailwindcss",
    "tintinweb.vscode-solidity-language",
    "nomicfoundation.hardhat-solidity",
    "esbenp.prettier-vscode",
    "eamodio.gitlens",
    "oderwat.indent-rainbow",
    "gruntfuggly.todo-tree",
    "pflannery.vscode-versionlens",
    "ms-vsliveshare.vsliveshare",
    "hashicorp.terraform",
    "ms-azuretools.vscode-docker",
    "cweijan.vscode-postgresql-client2",
    "usernamehw.errorlens",
    "streetsidesoftware.code-spell-checker",
    "wayou.vscode-todo-highlight",
  ]

  settings = {
    # Solidity
    "[solidity]" : {
      "editor.defaultFormatter" : "esbenp.prettier-vscode",
      "editor.formatOnSave" : true
    },
    "solidity.telemetry" : false,

    # Editor
    "editor.defaultFormatter" : "esbenp.prettier-vscode",
    "editor.fontFamily" : "Fira Code",
    "editor.fontLigatures" : true,
    "editor.formatOnSave" : true,
    "editor.wordWrap" : "on",
    "editor.inlineSuggest.enabled" : true,
    "editor.bracketPairColorization.enabled" : true,
    "editor.guides.bracketPairs" : true,
    "editor.minimap.enabled" : false,
    "editor.stickyScroll.enabled" : true,
    "editor.tabSize" : 2,

    # Files
    "files.autoSave" : "off",
    "files.watcherExclude" : {
      "**/.git/objects/**" : true,
      "**/.git/subtree-cache/**" : true,
      "**/node_modules/**" : true,
      "**/.hg/store/**" : true,
      "**/dist/**" : true,
      "**/build/**" : true,
      "**/.next/**" : true,
      "**/out/**" : true,
    },

    # Git
    "git.confirmSync" : false,
    "git.autofetch" : true,
    "git.enableSmartCommit" : true,

    # Terminal
    "terminal.integrated.scrollback" : 10000,
    "terminal.integrated.defaultProfile.linux" : "zsh",
    "terminal.integrated.fontSize" : 14,

    # Workbench
    "workbench.colorTheme" : "Dark Modern (OLED Black) [Orange]",
    "workbench.iconTheme" : "material-icon-theme",

    # Explorer
    "explorer.confirmDelete" : false,
    "explorer.confirmDragAndDrop" : false,

    # Docker
    "docker.showStartPage" : false,
  }
}

# =============================================================================
# OpenCode
# =============================================================================

resource "coder_script" "opencode_install" {
  agent_id           = coder_agent.main.id
  display_name       = "OpenCode Install"
  icon               = "/icon/opencode.svg"
  run_on_start       = true
  start_blocks_login = true

  script = <<EOT
    #!/bin/bash
    set -e

    # Install OpenCode if not present
    if ! command -v opencode &> /dev/null && [ ! -f "$HOME/.opencode/bin/opencode" ]; then
      echo "Installing OpenCode..."
      curl -fsSL https://opencode.ai/install | bash
    else
      echo "OpenCode already installed"
    fi

    # Write OpenCode config
    mkdir -p "$HOME/.config/opencode"
    CONFIG_JSON='${var.opencode_config_json != "" ? var.opencode_config_json : jsonencode({
      "$schema" = "https://opencode.ai/config.json"
      permission = {
        skill = {
          "*"              = "allow"
          "pr-review"      = "allow"
          "internal-*"     = "deny"
          "experimental-*" = "ask"
        }
      }
      model = var.opencode_model
    })}'
    echo "$CONFIG_JSON" > "$HOME/.config/opencode/config.json"
    echo "OpenCode configured"
  EOT
}

resource "coder_app" "opencode_terminal" {
  agent_id     = coder_agent.main.id
  slug         = "opencode-terminal"
  display_name = "OpenCode"
  icon         = "/icon/opencode.svg"
  command      = "bash -l -c 'export PATH=\"$HOME/.opencode/bin:$PATH\" && opencode'"
  share        = "owner"
}

resource "coder_app" "opencode_ui" {
  agent_id     = coder_agent.main.id
  slug         = "opencode-ui"
  display_name = "OpenCode UI"
  url          = "http://localhost:62748"
  icon         = "/icon/opencode.svg"
  subdomain    = true
  share        = "owner"
}

resource "coder_script" "opencode_serve" {
  agent_id           = coder_agent.main.id
  display_name       = "OpenCode Serve"
  icon               = "/icon/opencode.svg"
  run_on_start       = true
  start_blocks_login = false

  script = <<EOT
    #!/bin/bash
    set -e

    export PATH="/home/coder/.opencode/bin:$HOME/.local/bin:$PATH"

    # Wait for opencode to be installed
    max_attempts=30
    attempt=0
    while ! command -v opencode &> /dev/null; do
      attempt=$((attempt + 1))
      if [ "$attempt" -ge "$max_attempts" ]; then
        echo "ERROR: opencode CLI not found after $max_attempts attempts"
        exit 1
      fi
      echo "Waiting for opencode CLI to be installed... (attempt $attempt/$max_attempts)"
      sleep 10
    done

    echo "Starting opencode serve on port 62748..."
    opencode serve --port 62748 &
  EOT
}

# =============================================================================
# Claude Code
# =============================================================================

resource "coder_script" "claude_code_install" {
  agent_id           = coder_agent.main.id
  display_name       = "Claude Code Install"
  icon               = "/icon/claude.svg"
  run_on_start       = true
  start_blocks_login = true

  script = <<EOT
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

    %{if var.claude_code_api_key != ""}
    export ANTHROPIC_API_KEY="${var.claude_code_api_key}"
    echo 'export ANTHROPIC_API_KEY="${var.claude_code_api_key}"' >> "$HOME/.bashrc"
    grep -q 'ANTHROPIC_API_KEY' "$HOME/.zshrc" 2>/dev/null || echo 'export ANTHROPIC_API_KEY="${var.claude_code_api_key}"' >> "$HOME/.zshrc"
    %{endif}
  EOT
}

resource "coder_app" "claude_code" {
  agent_id     = coder_agent.main.id
  slug         = "claude-code"
  display_name = "Claude Code"
  icon         = "/icon/claude.svg"
  command      = "bash -l -c 'export PATH=\"$HOME/.local/bin:$PATH\" && claude'"
  share        = "owner"
}

# =============================================================================
# Pi Coding Agent (terminal app)
# =============================================================================

resource "coder_app" "pi" {
  agent_id     = coder_agent.main.id
  slug         = "pi"
  display_name = "Pi Agent"
  icon         = "/icon/terminal.svg"
  command      = "bash -l -c pi"
  share        = "owner"
}

# =============================================================================
# File Browser
# =============================================================================

module "filebrowser" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/coder/filebrowser/coder"
  version  = "1.1.2"
  agent_id = coder_agent.main.id
}

# =============================================================================
# GitHub Integration
# =============================================================================

module "github-upload-public-key" {
  count            = data.coder_workspace.me.start_count
  source           = "registry.coder.com/coder/github-upload-public-key/coder"
  version          = "1.0.15"
  agent_id         = coder_agent.main.id
  external_auth_id = data.coder_external_auth.github.id
}

module "git-commit-signing" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/coder/git-commit-signing/coder"
  version  = "1.0.11"
  agent_id = coder_agent.main.id
}

module "git-config" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/coder/git-config/coder"
  version  = "1.0.15"
  agent_id = coder_agent.main.id
}

# =============================================================================
# Node.js
# =============================================================================

module "nodejs" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/thezoker/nodejs/coder"
  version  = "1.0.11"
  agent_id = coder_agent.main.id
  node_versions = [
    "18",
    "20",
    "22",
    "24",
    "node"
  ]
  default_node_version = "24"
}

# =============================================================================
# Development Tools Script
# =============================================================================

resource "coder_script" "development_tools" {
  agent_id           = coder_agent.main.id
  display_name       = "Development Tools"
  icon               = "/icon/terminal.svg"
  run_on_start       = true
  start_blocks_login = true

  script = <<EOT
    #!/bin/bash
    set -e

    BOLD='\033[0;1m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    RESET='\033[0m'

    # Function to check if command exists
    command_exists() {
      command -v "$1" &> /dev/null
    }

    # Function to install if not present
    install_if_missing() {
      local name=$1
      local check_cmd=$2
      local check_path=$3
      local install_cmd=$4

      if [ -n "$check_cmd" ] && command_exists "$check_cmd"; then
        printf "$${GREEN}[ok] $name already installed$${RESET}\n"
        return 0
      elif [ -n "$check_path" ] && [ -e "$check_path" ]; then
        printf "$${GREEN}[ok] $name already installed$${RESET}\n"
        return 0
      fi

      printf "$${BOLD}[install] $name...$${RESET}\n"
      if eval "$install_cmd"; then
        printf "$${GREEN}[ok] $name installed successfully$${RESET}\n\n"
      else
        printf "$${YELLOW}[warn] $name installation failed, continuing...$${RESET}\n\n"
      fi
    }

    echo ""
    printf "$${BOLD}Setting up development tools...$${RESET}\n\n"

    # ---- Shell & Prompt ----

    # Install Oh My Zsh (without powerlevel10k — we use Starship)
    install_if_missing "Oh My Zsh" "" "$HOME/.oh-my-zsh" '
      RUNZSH=no CHSH=no sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended &&
      git clone --quiet https://github.com/zsh-users/zsh-autosuggestions.git $HOME/.oh-my-zsh/custom/plugins/zsh-autosuggestions &&
      git clone --quiet https://github.com/zsh-users/zsh-syntax-highlighting.git $HOME/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting &&
      git clone --quiet https://github.com/zsh-users/zsh-completions.git $HOME/.oh-my-zsh/custom/plugins/zsh-completions &&
      sed -i "s|^ZSH_THEME.*|ZSH_THEME=\"\"|g" $HOME/.zshrc &&
      sed -i "s|^plugins=.*|plugins=(git docker docker-compose zsh-autosuggestions zsh-syntax-highlighting zsh-completions direnv tmux)|g" $HOME/.zshrc
    '

    # Install Starship prompt
    install_if_missing "Starship" "starship" "" '
      curl -sS https://starship.rs/install.sh | sh -s -- --yes
    '

    # Ensure Starship init is in .zshrc
    if ! grep -q "starship init zsh" $HOME/.zshrc 2>/dev/null; then
      echo "eval \"\$(starship init zsh)\"" >> $HOME/.zshrc
    fi

    # ---- Package Managers ----

    # Install PNPM
    install_if_missing "PNPM" "pnpm" "" '
      curl -fsSL https://get.pnpm.io/install.sh | sh -
    '

    # Install Yarn (needs corepack from nvm's node)
    install_if_missing "Yarn" "yarn" "" '
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
      corepack enable &&
      corepack prepare yarn@stable --activate
    '

    # Install Bun
    install_if_missing "Bun" "bun" "" '
      curl -fsSL https://bun.sh/install | bash
    '

    # Ensure Bun is on PATH
    if ! grep -q "BUN_INSTALL" $HOME/.zshrc 2>/dev/null; then
      echo 'export BUN_INSTALL="$HOME/.bun"' >> $HOME/.zshrc
      echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> $HOME/.zshrc
    fi

    # ---- Blockchain / Web3 ----

    # Install Foundry
    install_if_missing "Foundry" "forge" "" '
      curl -L https://foundry.paradigm.xyz | bash &&
      source $HOME/.bashrc 2>/dev/null &&
      source $HOME/.zshrc 2>/dev/null &&
      export PATH="$HOME/.foundry/bin:$PATH" &&
      foundryup
    '

    # ---- CI/CD Tools ----

    # Install act (GitHub Actions locally)
    install_if_missing "act" "act" "" '
      wget -qO /tmp/act.tar.gz https://github.com/nektos/act/releases/latest/download/act_Linux_x86_64.tar.gz &&
      sudo tar xf /tmp/act.tar.gz -C /usr/local/bin act &&
      rm /tmp/act.tar.gz
    '

    # ---- GitHub CLI ----

    install_if_missing "GitHub CLI" "gh" "" '
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg &&
      sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg &&
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null &&
      sudo apt-get update &&
      sudo apt-get install gh -y
    '

    # Configure GitHub CLI authentication using Coder external auth token
    if command_exists gh && [ -n "${data.coder_external_auth.github.access_token}" ]; then
      if ! gh auth status &>/dev/null; then
        printf "$${BOLD}Configuring GitHub CLI authentication...$${RESET}\n"
        echo "${data.coder_external_auth.github.access_token}" | gh auth login --with-token
        printf "$${GREEN}[ok] GitHub CLI authenticated$${RESET}\n\n"
      else
        printf "$${GREEN}[ok] GitHub CLI already authenticated$${RESET}\n\n"
      fi
    fi

    # ---- AI Tools ----

    # Ensure PATH includes npm global bin for installations below
    export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"

    # Install Pi coding agent
    install_if_missing "Pi coding agent" "pi" "" '
      npm install -g @mariozechner/pi-coding-agent
    '

    # Configure Pi provider settings
    mkdir -p $HOME/.config/pi
    %{if var.pi_api_key != ""}
    cat > $HOME/.config/pi/config.json << PIEOF
{
  "provider": "${var.pi_provider}",
  "model": "${var.pi_model}"
}
PIEOF
    %{endif}

    # Install GSD for Claude Code and OpenCode
    install_if_missing "GSD (get-shit-done)" "" "$HOME/.claude/commands/gsd" '
      npx get-shit-done-cc@latest --claude --opencode --global --yes 2>/dev/null || \
      npx get-shit-done-cc@latest --claude --opencode --global 2>/dev/null || true
    '

    # Install GSD-2 for Pi
    install_if_missing "GSD-2 (gsd-pi)" "gsd" "" '
      npm install -g gsd-pi
    '

    # ---- Symlink all tools into ~/.local/bin for non-interactive shells ----

    printf "$${BOLD}Creating tool symlinks in ~/.local/bin...$${RESET}\n"
    mkdir -p $HOME/.local/bin

    # Node.js / npm / npx — from nvm default version
    NVM_DIR="$HOME/.nvm"
    if [ -d "$NVM_DIR" ]; then
      # Resolve the default node version directory
      NODE_DIR=$(find "$NVM_DIR/versions/node" -maxdepth 1 -type d | sort -V | tail -1)
      if [ -n "$NODE_DIR" ] && [ -d "$NODE_DIR/bin" ]; then
        for bin in node npm npx corepack; do
          [ -f "$NODE_DIR/bin/$bin" ] && ln -sf "$NODE_DIR/bin/$bin" "$HOME/.local/bin/$bin"
        done
        # Also symlink globally installed npm packages (pi, gsd, etc.)
        for bin in "$NODE_DIR/bin/"*; do
          [ -x "$bin" ] && [ ! -e "$HOME/.local/bin/$(basename "$bin")" ] && ln -sf "$bin" "$HOME/.local/bin/$(basename "$bin")"
        done
        printf "$${GREEN}[ok] Node.js symlinked from $NODE_DIR$${RESET}\n"
      fi
    fi

    # PNPM
    [ -f "$HOME/.local/share/pnpm/pnpm" ] && ln -sf "$HOME/.local/share/pnpm/pnpm" "$HOME/.local/bin/pnpm"
    [ -f "$HOME/.local/share/pnpm/pnpx" ] && ln -sf "$HOME/.local/share/pnpm/pnpx" "$HOME/.local/bin/pnpx"

    # Bun
    [ -f "$HOME/.bun/bin/bun" ] && ln -sf "$HOME/.bun/bin/bun" "$HOME/.local/bin/bun"
    [ -f "$HOME/.bun/bin/bunx" ] && ln -sf "$HOME/.bun/bin/bunx" "$HOME/.local/bin/bunx"

    # Foundry
    for bin in forge cast anvil chisel; do
      [ -f "$HOME/.foundry/bin/$bin" ] && ln -sf "$HOME/.foundry/bin/$bin" "$HOME/.local/bin/$bin"
    done

    # OpenCode
    [ -f "$HOME/.opencode/bin/opencode" ] && ln -sf "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"

    printf "$${GREEN}[ok] All tool symlinks created$${RESET}\n"

    # ---- Finalize ----

    # Source updated shell configuration
    source $HOME/.zshrc 2>/dev/null || true

    echo ""
    printf "$${GREEN}All development tools are ready!$${RESET}\n"
    echo ""
  EOT
}

# =============================================================================
# Docker Resources
# =============================================================================

resource "docker_volume" "home_volume" {
  name = "coder-${data.coder_workspace.me.id}-home"

  lifecycle {
    ignore_changes = all
  }

  labels {
    label = "coder.owner"
    value = data.coder_workspace_owner.me.name
  }
  labels {
    label = "coder.owner_id"
    value = data.coder_workspace_owner.me.id
  }
  labels {
    label = "coder.workspace_id"
    value = data.coder_workspace.me.id
  }
  labels {
    label = "coder.workspace_name_at_creation"
    value = data.coder_workspace.me.name
  }
}

resource "docker_image" "main" {
  name = "coder-${data.coder_workspace.me.id}"
  build {
    context = "."
  }
  triggers = {
    dir_sha1 = sha1(join("", [for f in fileset(path.module, "Dockerfile") : filesha1(f)]))
  }
}

resource "docker_container" "workspace" {
  count    = data.coder_workspace.me.start_count
  image    = docker_image.main.name
  name     = "coder-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  hostname = data.coder_workspace.me.name

  entrypoint = ["sh", "-c", replace(coder_agent.main.init_script, "/localhost|127\\.0\\.0\\.1/", "host.docker.internal")]
  env        = ["CODER_AGENT_TOKEN=${coder_agent.main.token}"]

  host {
    host = "host.docker.internal"
    ip   = "host-gateway"
  }

  # Resource limits: 12GB RAM, 20GB swap (32GB total), 6 CPU cores
  memory      = 12288
  memory_swap = 32768
  cpu_shares  = 6144

  # Home directory volume
  volumes {
    container_path = "/home/coder"
    volume_name    = docker_volume.home_volume.name
    read_only      = false
  }

  # Docker socket for full Docker functionality
  volumes {
    container_path = "/var/run/docker.sock"
    host_path      = "/var/run/docker.sock"
    read_only      = false
  }

  # Health check
  healthcheck {
    test         = ["CMD", "test", "-f", "/tmp/coder-agent"]
    interval     = "30s"
    timeout      = "5s"
    retries      = 3
    start_period = "10s"
  }

  labels {
    label = "coder.owner"
    value = data.coder_workspace_owner.me.name
  }
  labels {
    label = "coder.owner_id"
    value = data.coder_workspace_owner.me.id
  }
  labels {
    label = "coder.workspace_id"
    value = data.coder_workspace.me.id
  }
  labels {
    label = "coder.workspace_name"
    value = data.coder_workspace.me.name
  }
  labels {
    label = "coder.template_version"
    value = "1.0.0"
  }
}

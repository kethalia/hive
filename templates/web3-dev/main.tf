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

provider "docker" {
  host = var.docker_socket != "" ? var.docker_socket : null
}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

resource "coder_agent" "main" {
  arch           = data.coder_provisioner.me.arch
  os             = "linux"
  startup_script = <<-EOT
    set -e

    # One-time initialization
    if [ ! -f ~/.workspace_initialized ]; then
      echo "🚀 First-time workspace setup..."
      
      # Create directory structure
      mkdir -p ~/projects ~/bin ~/.config
      
      # Setup git aliases
      git config --global alias.st status
      git config --global alias.co checkout
      git config --global alias.br branch
      git config --global alias.cm commit
      git config --global alias.lg "log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit"
      
      # Clone dotfiles if specified
      %{if var.dotfiles_uri != ""}
      if [ ! -d ~/.dotfiles ]; then
        echo "📦 Cloning dotfiles..."
        git clone ${var.dotfiles_uri} ~/.dotfiles && cd ~/.dotfiles && ./install.sh || true
      fi
      %{endif}
      
      # Create workspace README
      if [ ! -f ~/README.md ]; then
        cat > ~/README.md << 'EOFREADME'
# ${data.coder_workspace.me.name}

## 🚀 Quick Start Guide

### Available Tools & Versions
- **Node.js**: v24 (default), also available: 18, 20, 22
- **PNPM**: Latest version
- **Docker & Docker Compose**: Latest
- **Foundry**: Ethereum development toolkit
- **act**: Run GitHub Actions locally
- **Python Tools**: poetry, black, ruff, pre-commit

### 📦 Installed VS Code Extensions
- Solidity (Hardhat & Language support)
- Tailwind CSS IntelliSense
- GraphQL
- Prisma
- Prettier
- GitLens
- Material Icon Theme
- Dark Modern OLED Theme

### 🛠️ Useful Commands

#### Docker
\`\`\`bash
docker ps                    # List running containers
docker-compose up -d         # Start services
act                          # Run GitHub Actions locally
\`\`\`

#### Node.js
\`\`\`bash
node --version               # Check Node version
pnpm install                 # Install dependencies
pnpm dev                     # Start development server
\`\`\`

#### Solidity/Foundry
\`\`\`bash
forge init my-project        # Create new Foundry project
forge build                  # Build contracts
forge test                   # Run tests
\`\`\`

#### Git
\`\`\`bash
gs                           # git status
gco -b feature/new-feature   # Create and checkout new branch
gc -m "commit message"       # Commit changes
gp                           # git pull
git lg                       # Pretty log
\`\`\`

### 🗄️ Database Information
Connection is pre-configured via environment variables (\`PGHOST\`, \`PGUSER\`, \`PGDATABASE\`).
Use \`psql\` to connect with no arguments.

### 📁 Directory Structure
- \`~/projects/\` - Your project files
- \`~/bin/\` - Custom scripts and binaries
- \`~/.config/\` - Configuration files

### 🎯 Workspace Info
- **Owner**: ${data.coder_workspace_owner.me.name}
- **Email**: ${data.coder_workspace_owner.me.email}
- **Created**: $(date)

### 🔗 Useful Links
- [Coder Docs](https://coder.com/docs)
- [Foundry Book](https://book.getfoundry.sh/)
- [Node.js Docs](https://nodejs.org/docs/)

### 💡 Tips
- Use \`Ctrl/Cmd + Shift + P\` in VS Code to access the command palette
- Docker socket is mounted - you have full Docker access
- All environment variables are pre-configured for development

Happy coding! 🎉
EOFREADME
      fi
      
      # Mark as initialized
      touch ~/.workspace_initialized
      echo "✅ Workspace initialized"
    fi
    
    # Per-start initialization
    echo "🔄 Starting workspace services..."
    
    # Verify Docker access
    if docker info &> /dev/null; then
      echo "✅ Docker is accessible"
    else
      echo "⚠️  Warning: Docker is not accessible. Check socket mount."
    fi
    
    # Start opencode serve in background (waits for CLI to be installed by module)
    (
      export PATH="/home/coder/.opencode/bin:$PATH"
      max_attempts=30
      attempt=0
      while ! command -v opencode &> /dev/null; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge "$max_attempts" ]; then
          echo "ERROR: opencode CLI not found after $max_attempts attempts" >> /tmp/opencode-serve.log
          exit 1
        fi
        sleep 10
      done
      nohup opencode serve --port 62748 > /tmp/opencode-serve.log 2>&1 &
    ) &

    echo ""
    echo "✨ Workspace is ready! ✨"
    echo "📖 Check ~/README.md for quick start guide"
    echo ""
  EOT

  env = {
    GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_AUTHOR_EMAIL    = "${data.coder_workspace_owner.me.email}"
    GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_COMMITTER_EMAIL = "${data.coder_workspace_owner.me.email}"
    
    EXTENSIONS_GALLERY = "{\"serviceUrl\":\"https://marketplace.visualstudio.com/_apis/public/gallery\"}"
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
    # get load avg scaled by number of cores
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

data "coder_external_auth" "github" {
  id = "primary-github"
}

module "code-server" {
  count   = data.coder_workspace.me.start_count
  source  = "registry.coder.com/modules/code-server/coder"
  version = "1.4.3"

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

module "opencode" {
  source       = "registry.coder.com/coder-labs/opencode/coder"
  version      = "0.1.1"
  agent_id     = coder_agent.main.id
  workdir      = "/home/coder"
  report_tasks = false
  cli_app      = true
  config_json = jsonencode({
    "$schema" = "https://opencode.ai/config.json"
    permission = {
      skill = {
        "*" = "allow"
        "pr-review" = "allow"
        "internal-*" = "deny"
        "experimental-*" = "ask"
      }
    }
    model = "anthropic/claude-sonnet-4-20250514"
  })
}

resource "coder_app" "opencode_ui" {
  agent_id     = coder_agent.main.id
  slug         = "opencode-ui"
  display_name = "Opencode UI"
  url          = "http://localhost:62748"
  icon         = "/icon/opencode.svg"
  subdomain    = true
  share        = "owner"
}

module "filebrowser" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/coder/filebrowser/coder"
  version  = "1.1.4"
  agent_id = coder_agent.main.id
}

module "github-upload-public-key" {
  count            = data.coder_workspace.me.start_count
  source           = "registry.coder.com/coder/github-upload-public-key/coder"
  version          = "1.0.32"
  agent_id         = coder_agent.main.id
  external_auth_id = data.coder_external_auth.github.id
}

module "git-commit-signing" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/coder/git-commit-signing/coder"
  version  = "1.0.32"
  agent_id = coder_agent.main.id
}

module "git-config" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/coder/git-config/coder"
  version  = "1.0.33"
  agent_id = coder_agent.main.id
}

module "nodejs" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/thezoker/nodejs/coder"
  version  = "1.0.13"
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

resource "coder_script" "development_tools" {
  agent_id           = coder_agent.main.id
  display_name       = "Development Tools"
  icon               = "/icon/terminal.svg"
  run_on_start       = true
  start_blocks_login = false

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
        printf "$${GREEN}✅ $name already installed$${RESET}\n"
        return 0
      elif [ -n "$check_path" ] && [ -e "$check_path" ]; then
        printf "$${GREEN}✅ $name already installed$${RESET}\n"
        return 0
      fi

      printf "$${BOLD}📦 Installing $name...$${RESET}\n"
      if eval "$install_cmd"; then
        printf "$${GREEN}✅ $name installed successfully$${RESET}\n\n"
      else
        printf "$${YELLOW}⚠️  $name installation failed, continuing...$${RESET}\n\n"
      fi
    }

    echo ""
    printf "$${BOLD}🚀 Setting up development tools...$${RESET}\n\n"

    # Install Oh My Zsh
    install_if_missing "Oh My Zsh" "" "$HOME/.oh-my-zsh" '
      RUNZSH=no CHSH=no sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended &&
      git clone --depth=1 https://github.com/romkatv/powerlevel10k.git $HOME/.oh-my-zsh/custom/themes/powerlevel10k &&
      git clone --quiet https://github.com/zsh-users/zsh-autosuggestions.git $HOME/.oh-my-zsh/custom/plugins/zsh-autosuggestions &&
      git clone --quiet https://github.com/zsh-users/zsh-syntax-highlighting.git $HOME/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting &&
      git clone --quiet https://github.com/zsh-users/zsh-completions.git $HOME/.oh-my-zsh/custom/plugins/zsh-completions &&
      sed -i "s|^ZSH_THEME.*|ZSH_THEME=\"powerlevel10k/powerlevel10k\"|g" $HOME/.zshrc &&
      sed -i "s|^plugins=.*|plugins=(git docker docker-compose zsh-autosuggestions zsh-syntax-highlighting zsh-completions)|g" $HOME/.zshrc
    '

    # Install PNPM
    install_if_missing "PNPM" "pnpm" "" '
      curl -fsSL https://get.pnpm.io/install.sh | sh -
    '

    # Install Foundry
    install_if_missing "Foundry" "forge" "" '
      curl -L https://foundry.paradigm.xyz | bash &&
      export PATH="$HOME/.foundry/bin:$PATH" &&
      foundryup
    '

    # Configure GitHub CLI authentication using Coder external auth token
    # (gh and act are pre-installed in the Dockerfile)
    if command_exists gh && [ -n "${data.coder_external_auth.github.access_token}" ]; then
      if ! gh auth status &>/dev/null; then
        printf "$${BOLD}🔐 Configuring GitHub CLI authentication...$${RESET}\n"
        echo "${data.coder_external_auth.github.access_token}" | gh auth login --with-token
        printf "$${GREEN}✅ GitHub CLI authenticated$${RESET}\n\n"
      else
        printf "$${GREEN}✅ GitHub CLI already authenticated$${RESET}\n\n"
      fi
    fi

    echo ""
    printf "$${GREEN}🎉 All development tools are ready!$${RESET}\n"
    echo ""
  EOT
}

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

  # Home directory volume
  volumes {
    container_path = "/home/coder"
    volume_name    = docker_volume.home_volume.name
    read_only      = false
  }

  # Docker socket for Docker-in-Docker
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
    value = "2.0.0"
  }
}

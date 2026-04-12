terraform {
  required_providers {
    coder = {
      source  = "coder/coder"
      version = "~> 2.15"
    }
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.6"
    }
  }
}

# =============================================================================
# Parameters — surfaced in the Coder workspace creation UI
# =============================================================================

data "coder_parameter" "dotfiles_uri" {
  name         = "dotfiles_uri"
  display_name = "Dotfiles URI"
  description  = "Git repository URL for your dotfiles (optional). Will be cloned to ~/.dotfiles and ./install.sh run."
  type         = "string"
  default      = ""
  mutable      = true
  order        = 1
}

data "coder_parameter" "vault_repo" {
  name         = "vault_repo"
  display_name = "Obsidian Vault Repo"
  description  = "Git SSH URL for your Obsidian second-brain vault (e.g. git@github.com:you/vault.git). Cloned to ~/vault on start. Leave empty to skip."
  type         = "string"
  default      = ""
  mutable      = true
  order        = 2
}

variable "claude_code_api_key" {
  description = "Anthropic API key for Claude Code. Set at template push time."
  type        = string
  sensitive   = true
  default     = ""
}

data "coder_parameter" "claude_code_model" {
  name         = "claude_code_model"
  display_name = "Claude Code Model"
  description  = "Model for Claude Code."
  type         = "string"
  default      = "claude-sonnet-4-6"
  mutable      = true
  order        = 7

  # Claude 4.6 generation
  option {
    name  = "Claude Sonnet 4.6 (Recommended)"
    value = "claude-sonnet-4-6"
  }
  option {
    name  = "Claude Opus 4.6"
    value = "claude-opus-4-6"
  }
  # Claude 4.5 generation
  option {
    name  = "Claude Opus 4.5"
    value = "claude-opus-4-5"
  }
  option {
    name  = "Claude Sonnet 4.5"
    value = "claude-sonnet-4-5"
  }
  option {
    name  = "Claude Haiku 4.5"
    value = "claude-haiku-4-5"
  }
  # Claude 3.5 (legacy)
  option {
    name  = "Claude Haiku 3.5 (legacy)"
    value = "claude-haiku-3-5"
  }
}

data "coder_parameter" "claude_code_system_prompt" {
  name         = "claude_code_system_prompt"
  display_name = "Claude Code System Prompt"
  description  = "Custom system prompt for Claude Code (optional)."
  type         = "string"
  default      = ""
  mutable      = true
  order        = 8
}

data "coder_parameter" "docker_socket" {
  name         = "docker_socket"
  display_name = "Docker Socket URI"
  description  = "Override the Docker socket URI (optional — leave empty to use the default)."
  type         = "string"
  default      = ""
  mutable      = false
  order        = 10
}

# =============================================================================
# Providers & Data Sources
# =============================================================================

provider "docker" {
  host = data.coder_parameter.docker_socket.value != "" ? data.coder_parameter.docker_socket.value : null
}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

# =============================================================================
# External Auth
# =============================================================================

data "coder_external_auth" "github" {
  id = "primary-github"
}



# =============================================================================
# Base image from GHCR
# =============================================================================

resource "docker_image" "main" {
  name          = "ghcr.io/kethalia/hive-base:latest"
  pull_triggers = [data.coder_workspace.me.start_count]
  keep_locally  = true
}

# =============================================================================
# Coder Agent
# =============================================================================

resource "coder_agent" "main" {
  arch = data.coder_provisioner.me.arch
  os   = "linux"

  startup_script = templatefile("${path.module}/scripts/init.sh", {
    dotfiles_uri      = data.coder_parameter.dotfiles_uri.value
    workspace_name    = data.coder_workspace.me.name
    owner_name        = data.coder_workspace_owner.me.name
    owner_email       = data.coder_workspace_owner.me.email
    claude_md_content = file("${path.module}/CLAUDE.md")
  })

  env = merge(
    {
      GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
      GIT_AUTHOR_EMAIL    = data.coder_workspace_owner.me.email
      GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
      GIT_COMMITTER_EMAIL = data.coder_workspace_owner.me.email
      EXTENSIONS_GALLERY  = "{\"serviceUrl\":\"https://marketplace.visualstudio.com/_apis/public/gallery\"}"
    },
    var.claude_code_api_key != "" ? { ANTHROPIC_API_KEY = var.claude_code_api_key } : {},
    data.coder_parameter.claude_code_model.value != "" ? { CLAUDE_CODE_DEFAULT_MODEL = data.coder_parameter.claude_code_model.value } : {},
    data.coder_parameter.claude_code_system_prompt.value != "" ? { CLAUDE_CODE_SYSTEM_PROMPT = data.coder_parameter.claude_code_system_prompt.value } : {}
  )

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
    script       = <<EOT
      echo "`cat /proc/loadavg | awk '{ print $1 }'` `nproc`" | awk '{ printf "%0.2f", $1/$2 }'
    EOT
    interval     = 60
    timeout      = 1
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
# Development Tools
# =============================================================================

resource "coder_script" "tools_shell" {
  agent_id           = coder_agent.main.id
  display_name       = "Shell & Prompt"
  icon               = "/icon/terminal.svg"
  run_on_start       = true
  start_blocks_login = true
  script             = file("${path.module}/scripts/tools-shell.sh")
}

resource "coder_script" "tools_node" {
  agent_id           = coder_agent.main.id
  display_name       = "Node.js Package Managers"
  icon               = "/icon/nodejs.svg"
  run_on_start       = true
  start_blocks_login = true
  script             = file("${path.module}/scripts/tools-node.sh")
}

resource "coder_script" "tools_web3" {
  agent_id           = coder_agent.main.id
  display_name       = "Web3 Tools"
  icon               = "/icon/terminal.svg"
  run_on_start       = true
  start_blocks_login = true
  script             = file("${path.module}/scripts/tools-web3.sh")
}

resource "coder_script" "tools_ci" {
  agent_id           = coder_agent.main.id
  display_name       = "CI/CD Tools"
  icon               = "/icon/terminal.svg"
  run_on_start       = true
  start_blocks_login = true
  script = templatefile("${path.module}/scripts/tools-ci.sh", {
    github_token = data.coder_external_auth.github.access_token
  })
}

resource "coder_script" "tools_ai" {
  agent_id           = coder_agent.main.id
  display_name       = "AI Tools"
  icon               = "/icon/terminal.svg"
  run_on_start       = true
  start_blocks_login = true
  script = file("${path.module}/scripts/tools-ai.sh")
}

resource "coder_script" "tools_browser" {
  agent_id           = coder_agent.main.id
  display_name       = "Browser Vision"
  icon               = "/icon/terminal.svg"
  run_on_start       = true
  start_blocks_login = true
  script             = file("${path.module}/scripts/tools-browser.sh")
}

resource "coder_script" "browser_serve" {
  agent_id           = coder_agent.main.id
  display_name       = "Browser Vision Server"
  icon               = "/icon/terminal.svg"
  run_on_start       = true
  start_blocks_login = false
  script             = file("${path.module}/scripts/browser-serve.sh")
}

resource "coder_app" "browser_vision" {
  agent_id     = coder_agent.main.id
  slug         = "browser-vision"
  display_name = "KasmVNC"
  url          = "http://localhost:6080"
  icon         = "/icon/kasmvnc.svg"
  subdomain    = true
  share        = "owner"
}

resource "coder_script" "symlinks" {
  agent_id           = coder_agent.main.id
  display_name       = "Tool Symlinks"
  icon               = "/icon/terminal.svg"
  run_on_start       = true
  start_blocks_login = true
  script             = file("${path.module}/scripts/symlinks.sh")
}

# =============================================================================
# VS Code Server
# =============================================================================

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
    "[solidity]" : {
      "editor.defaultFormatter" : "esbenp.prettier-vscode",
      "editor.formatOnSave" : true
    },
    "solidity.telemetry" : false,
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
    "git.confirmSync" : false,
    "git.autofetch" : true,
    "git.enableSmartCommit" : true,
    "terminal.integrated.scrollback" : 10000,
    "terminal.integrated.defaultProfile.linux" : "zsh",
    "terminal.integrated.fontSize" : 14,
    "workbench.colorTheme" : "Dark Modern (OLED Black) [Orange]",
    "workbench.iconTheme" : "material-icon-theme",
    "explorer.confirmDelete" : false,
    "explorer.confirmDragAndDrop" : false,
    "docker.showStartPage" : false,
  }
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
  script = templatefile("${path.module}/scripts/claude-install.sh", {
    claude_api_key = var.claude_code_api_key
  })
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
# File Browser
# =============================================================================

module "filebrowser" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/coder/filebrowser/coder"
  version  = "1.1.4"
  agent_id = coder_agent.main.id
}

# =============================================================================
# GitHub Integration
# =============================================================================

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

# =============================================================================
# Obsidian Vault (optional)
# =============================================================================

module "git-clone-vault" {
  count       = data.coder_parameter.vault_repo.value != "" ? data.coder_workspace.me.start_count : 0
  source      = "registry.coder.com/coder/git-clone/coder"
  version     = "1.2.3"
  agent_id    = coder_agent.main.id
  url         = data.coder_parameter.vault_repo.value
  folder_name = "vault"
}

# =============================================================================
# Node.js
# =============================================================================

resource "coder_script" "tools_nvm" {
  agent_id           = coder_agent.main.id
  display_name       = "Node.js (nvm)"
  icon               = "/icon/nodejs.svg"
  run_on_start       = true
  start_blocks_login = true
  script = templatefile("${path.module}/scripts/tools-nvm.sh", {
    node_versions        = join(" ", ["18", "20", "22", "24", "node"])
    default_node_version = "24"
  })
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

resource "docker_container" "workspace" {
  count    = data.coder_workspace.me.start_count
  image    = docker_image.main.image_id
  name     = "coder-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  hostname = data.coder_workspace.me.name

  entrypoint = ["sh", "-c", replace(coder_agent.main.init_script, "/localhost|127\\.0\\.0\\.1/", "host.docker.internal")]
  env        = ["CODER_AGENT_TOKEN=${coder_agent.main.token}"]

  host {
    host = "host.docker.internal"
    ip   = "host-gateway"
  }

  memory      = 12288
  memory_swap = 32768
  cpu_shares  = 6144

  volumes {
    container_path = "/home/coder"
    volume_name    = docker_volume.home_volume.name
    read_only      = false
  }

  volumes {
    container_path = "/var/run/docker.sock"
    host_path      = "/var/run/docker.sock"
    read_only      = false
  }

  lifecycle {
    ignore_changes = [name]
  }

  healthcheck {
    test         = ["CMD-SHELL", "pgrep -x coder > /dev/null || pgrep -f 'coder agent' > /dev/null"]
    interval     = "30s"
    timeout      = "5s"
    retries      = 5
    start_period = "60s"
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

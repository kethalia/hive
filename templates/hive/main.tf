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

locals {
  username = data.coder_workspace_owner.me.name
}

# =============================================================================
# Parameters — surfaced in the Coder workspace creation UI
# =============================================================================

# --- Hive Task Parameters ---

data "coder_parameter" "task_id" {
  name         = "task_id"
  display_name = "Hive Task ID"
  description  = "Hive task identifier (e.g. HIVE-42). Leave empty for a general-purpose workspace."
  type         = "string"
  default      = ""
  mutable      = true
  order        = 1
}

data "coder_parameter" "task_prompt" {
  name         = "task_prompt"
  display_name = "Task Prompt"
  description  = "Task description or prompt for the hive worker. Leave empty for a general-purpose workspace."
  type         = "string"
  default      = ""
  mutable      = true
  order        = 2
}

data "coder_parameter" "repo_url" {
  name         = "repo_url"
  display_name = "Repository URL"
  description  = "Git URL of the target repository to clone into /home/coder/project (e.g. git@github.com:org/repo.git). Leave empty to skip."
  type         = "string"
  default      = ""
  mutable      = true
  order        = 3
}

data "coder_parameter" "branch_name" {
  name         = "branch_name"
  display_name = "Branch Name"
  description  = "Git branch to checkout after cloning (e.g. feat/my-feature). Leave empty for the default branch."
  type         = "string"
  default      = ""
  mutable      = true
  order        = 4
}

# --- User Preferences ---

data "coder_parameter" "vault_repo" {
  name         = "vault_repo"
  display_name = "Obsidian Vault Repo"
  description  = "Git SSH URL for your Obsidian second-brain vault (e.g. git@github.com:you/vault.git). Cloned to ~/vault on start. Leave empty to skip."
  type         = "string"
  default      = ""
  mutable      = true
  order        = 5
}

# --- Claude Code ---

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

# --- Infrastructure ---

data "coder_parameter" "docker_socket" {
  name         = "docker_socket"
  display_name = "Docker Socket URI"
  description  = "Override the Docker socket URI (optional — leave empty to use the default)."
  type         = "string"
  default      = ""
  mutable      = false
  order        = 9
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
# Coder Agent
# =============================================================================

resource "coder_agent" "main" {
  arch = data.coder_provisioner.me.arch
  os   = "linux"

  startup_script = templatefile("${path.module}/scripts/init.sh", {
    workspace_name         = data.coder_workspace.me.name
    owner_name             = data.coder_workspace_owner.me.name
    owner_email            = data.coder_workspace_owner.me.email
    claude_md_content      = file("${path.module}/CLAUDE.md")
    sync_vault_script_b64  = base64encode(file("${path.module}/scripts/sync-vault.sh"))
  })

  env = merge(
    {
      GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
      GIT_AUTHOR_EMAIL    = "${data.coder_workspace_owner.me.email}"
      GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
      GIT_COMMITTER_EMAIL = "${data.coder_workspace_owner.me.email}"

      HIVE_TASK_ID     = data.coder_parameter.task_id.value
      HIVE_TASK_PROMPT = data.coder_parameter.task_prompt.value
      HIVE_REPO_URL    = data.coder_parameter.repo_url.value
      HIVE_BRANCH_NAME = data.coder_parameter.branch_name.value
    },
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
# Development Tools (separate scripts for clarity)
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
  script             = file("${path.module}/scripts/tools-ai.sh")
}

resource "coder_script" "tools_browser" {
  agent_id           = coder_agent.main.id
  display_name       = "Browser Vision"
  icon               = "/icon/terminal.svg"
  run_on_start       = true
  start_blocks_login = true
  script             = file("${path.module}/scripts/tools-browser.sh")
}

resource "coder_app" "gsd" {
  agent_id     = coder_agent.main.id
  slug         = "gsd"
  display_name = "GSD"
  icon         = "/icon/terminal.svg"
  command      = "bash -l -c 'export PATH=\"$HOME/.local/bin:$PATH\" && gsd'"
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
  folder_name = "vault_clone_tmp"

  # The git-clone module skips cloning when the target dir is non-empty, but
  # post_clone_script runs ALWAYS (even on skip).  We clone into a temp dir,
  # then rsync into ~/vault so the vault is refreshed on every workspace start.
  # The git-clone module clones into a temp dir; we rsync into ~/vault then
  # call ~/sync-vault.sh (deployed by init.sh) to sync config files.
  post_clone_script = <<-EOT
    #!/bin/bash
    set -e
    VAULT_DIR="$HOME/vault"
    CLONE_DIR="$HOME/vault_clone_tmp"
    if [ -d "$CLONE_DIR/.git" ]; then
      mkdir -p "$VAULT_DIR"
      rsync -a --delete --exclude '.obsidian' "$CLONE_DIR/" "$VAULT_DIR/"
      rm -rf "$CLONE_DIR"
      echo "Vault synced to $VAULT_DIR"

      # Sync config files (CLAUDE.md, AGENTS.md, Skills, GSD symlinks)
      if [ -x "$HOME/sync-vault.sh" ]; then
        "$HOME/sync-vault.sh"
      else
        echo "WARNING: ~/sync-vault.sh not found — config sync skipped" >&2
      fi
    else
      echo "ERROR: Vault clone failed — $CLONE_DIR has no .git directory" >&2
      rm -rf "$CLONE_DIR"
      exit 1
    fi
  EOT
}

# =============================================================================
# Claude Code (module replaces claude-install.sh + coder_app)
# =============================================================================

module "claude-code" {
  count               = data.coder_workspace.me.start_count
  source              = "registry.coder.com/coder/claude-code/coder"
  version             = "1.1.0"
  agent_id            = coder_agent.main.id
  folder              = "/home/coder/project"
  install_claude_code = false
}

# =============================================================================
# KasmVNC (module replaces browser-serve.sh + coder_app)
# =============================================================================

module "kasmvnc" {
  count               = data.coder_workspace.me.start_count
  source              = "registry.coder.com/coder/kasmvnc/coder"
  version             = "1.3.0"
  agent_id            = coder_agent.main.id
  desktop_environment = "xfce"
  port                = 6080
}

# =============================================================================
# Node.js via nvm (module replaces tools-nvm.sh)
# =============================================================================

module "nodejs" {
  count                = data.coder_workspace.me.start_count
  source               = "registry.coder.com/thezoker/nodejs/coder"
  version              = "1.0.13"
  agent_id             = coder_agent.main.id
  node_versions        = ["18", "20", "22", "24"]
  default_node_version = "24"
}

# =============================================================================
# Dotfiles (module replaces dotfiles clone in init.sh)
# =============================================================================

module "dotfiles" {
  count                 = data.coder_workspace.me.start_count
  source                = "registry.coder.com/coder/dotfiles/coder"
  version               = "1.4.1"
  agent_id              = coder_agent.main.id
  coder_parameter_order = 6
}

# =============================================================================
# Coder Login (auto-authenticates coder CLI inside workspace)
# =============================================================================

module "coder-login" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/coder/coder-login/coder"
  version  = "1.0.15"
  agent_id = coder_agent.main.id
}

# =============================================================================
# tmux with session persistence
# =============================================================================

module "tmux" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/anomaly/tmux/coder"
  version  = "1.0.4"
  agent_id = coder_agent.main.id
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

data "docker_registry_image" "main" {
  name = "ghcr.io/kethalia/hive-base:latest"
}

resource "docker_image" "main" {
  name          = data.docker_registry_image.main.name
  pull_triggers = [data.docker_registry_image.main.sha256_digest]
  keep_locally  = true
}

resource "docker_container" "workspace" {
  count    = data.coder_workspace.me.start_count
  image    = docker_image.main.image_id
  name     = "coder-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  hostname = data.coder_workspace.me.name

  # Prevent container replacement when workspace name changes during prebuild claim
  lifecycle {
    ignore_changes = [name]
  }

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

  # Health check — verify the coder agent process is running
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

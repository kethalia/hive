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

# --- Hive Task Parameters ---

variable "task_id" {
  description = "Hive task ID"
  type        = string
}

variable "task_prompt" {
  description = "Task prompt/description"
  type        = string
}

variable "repo_url" {
  description = "Target repository URL"
  type        = string
}

variable "branch_name" {
  description = "Git branch name for this task"
  type        = string
  default     = ""
}

# --- Infrastructure ---

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

# --- Pi Coding Agent Configuration ---

variable "pi_api_key" {
  description = "API key for Pi coding agent LLM provider (e.g. Anthropic key)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "pi_model" {
  description = "Model for Pi coding agent (e.g. claude-opus-4-6)"
  type        = string
  default     = "claude-opus-4-6"
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
    dotfiles_uri   = var.dotfiles_uri
    workspace_name = data.coder_workspace.me.name
    owner_name     = data.coder_workspace_owner.me.name
    owner_email    = data.coder_workspace_owner.me.email
  })

  env = {
    GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_AUTHOR_EMAIL    = "${data.coder_workspace_owner.me.email}"
    GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_COMMITTER_EMAIL = "${data.coder_workspace_owner.me.email}"

    HIVE_TASK_ID     = var.task_id
    HIVE_TASK_PROMPT = var.task_prompt
    HIVE_REPO_URL    = var.repo_url
    HIVE_BRANCH_NAME = var.branch_name
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
  script = templatefile("${path.module}/scripts/tools-ai.sh", {
    pi_api_key  = var.pi_api_key
    pi_provider = var.pi_provider
    pi_model    = var.pi_model
  })
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
  display_name = "Browser"
  url          = "http://localhost:6080"
  icon         = "/icon/terminal.svg"
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
# Pi Coding Agent
# =============================================================================

resource "coder_app" "pi" {
  agent_id     = coder_agent.main.id
  slug         = "pi"
  display_name = "Pi Agent"
  icon         = "/icon/terminal.svg"
  command      = "bash -l -c 'export PATH=\"$HOME/.local/bin:$PATH\" && pi'"
  share        = "owner"
}

resource "coder_app" "gsd" {
  agent_id     = coder_agent.main.id
  slug         = "gsd"
  display_name = "GSD"
  icon         = "/icon/terminal.svg"
  command      = "bash -l -c 'export PATH=\"$HOME/.local/bin:$PATH\" && gsd'"
  share        = "owner"
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

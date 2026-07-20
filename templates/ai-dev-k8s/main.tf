terraform {
  required_providers {
    coder = {
      source  = "coder/coder"
      version = "~> 2.15"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.38"
    }
  }
}

# =============================================================================
# Parameters — surfaced in the Coder workspace creation UI
# =============================================================================

data "coder_parameter" "vault_repo" {
  name         = "vault_repo"
  display_name = "Obsidian Vault Repo"
  description  = "GitHub owner/repository for your Obsidian vault. Initialized in ~/vault and safely fast-forwarded on startup. Leave empty to skip."
  type         = "string"
  default      = "kethalia/second-brain"
  mutable      = false
  order        = 1

  validation {
    regex = "^$|^(chillwhales|kethalia|phlox-labs)/[A-Za-z0-9._-]+$"
    error = "Vault repository must be empty or use owner/repository from chillwhales, kethalia, or phlox-labs."
  }
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

data "coder_parameter" "home_disk_size" {
  name         = "home_disk_size"
  display_name = "Home disk size"
  description  = "Persistent Longhorn volume size in GiB. Choose at workspace creation; bound Kubernetes PVCs cannot be shrunk."
  type         = "number"
  default      = 100
  mutable      = false
  order        = 10

  validation {
    min = 20
    max = 500
  }
}

data "coder_parameter" "projects_root" {
  name         = "projects_root"
  display_name = "Workspace projects root"
  description  = "Absolute workspace path shared by Hive Git discovery, terminals, VS Code, and File Browser. Must match Hive's HIVE_PROJECTS_ROOT."
  type         = "string"
  default      = "/home/coder"
  mutable      = false
  order        = 11

  validation {
    regex = "^/([^/\\x00]+(/[^/\\x00]+)*)?/?$"
    error = "Workspace projects root must be an absolute POSIX path."
  }
}

# =============================================================================
# Providers & Data Sources
# =============================================================================

provider "kubernetes" {}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

locals {
  workspace_hostname_candidate = trim(substr(replace(lower(data.coder_workspace.me.name), "/[^a-z0-9-]/", "-"), 0, 63), "-")
  workspace_hostname           = local.workspace_hostname_candidate != "" ? local.workspace_hostname_candidate : "workspace"
}

# =============================================================================
# External Auth
# =============================================================================

data "coder_external_auth" "github" {
  id = "github"
}



# =============================================================================
# Coder Agent
# =============================================================================

resource "coder_agent" "main" {
  arch                    = "amd64"
  os                      = "linux"
  startup_script_behavior = "blocking"

  startup_script = templatefile("${path.module}/scripts/init.sh", {
    workspace_name        = data.coder_workspace.me.name
    owner_name            = data.coder_workspace_owner.me.name
    owner_email           = data.coder_workspace_owner.me.email
    claude_md_content     = file("${path.module}/CLAUDE.md")
    sync_vault_script_b64 = base64encode(file("${path.module}/scripts/sync-vault.sh"))
  })

  env = merge(
    {
      GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
      GIT_AUTHOR_EMAIL    = data.coder_workspace_owner.me.email
      GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
      GIT_COMMITTER_EMAIL = data.coder_workspace_owner.me.email
      EXTENSIONS_GALLERY  = "{\"serviceUrl\":\"https://marketplace.visualstudio.com/_apis/public/gallery\"}"
      HIVE_PROJECTS_ROOT  = data.coder_parameter.projects_root.value
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
    github_token                  = data.coder_external_auth.github.access_token
    github_cli_script_b64         = base64encode(file("${path.module}/scripts/github-cli.sh"))
    github_credential_script_b64  = base64encode(file("${path.module}/scripts/github-credential.sh"))
    clone_repositories_script_b64 = base64encode(file("${path.module}/scripts/clone-repositories.sh"))
    repositories_manifest_b64     = base64encode(file("${path.module}/repositories.txt"))
    vault_repository_b64          = base64encode(data.coder_parameter.vault_repo.value)
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
      "**/out/**" : true
    },
    "git.confirmSync" : false,
    "git.autofetch" : true,
    "git.enableSmartCommit" : true,
    "terminal.integrated.scrollback" : 10000,
    "terminal.integrated.defaultProfile.linux" : "zsh",
    "terminal.integrated.fontSize" : 14,
    "workbench.iconTheme" : "material-icon-theme",
    "explorer.confirmDelete" : false,
    "explorer.confirmDragAndDrop" : false,
    "docker.showStartPage" : false,
    "workbench.preferredDarkColorTheme" : "Dark Modern (OLED Black) [Orange]",
    "workbench.preferredLightColorTheme" : "Light Modern (OLED) Saturated",
    "workbench.preferredHighContrastColorTheme" : "Dark Modern (OLED Black) Stylized [Orange]",
    "workbench.preferredHighContrastLightColorTheme" : "Light Modern (OLED) Saturated Stylized",
    "window.autoDetectColorScheme" : true
  }
}

# =============================================================================
# File Browser — user-writable install for the non-root workspace pod
# =============================================================================

resource "coder_script" "filebrowser" {
  agent_id           = coder_agent.main.id
  display_name       = "File Browser"
  icon               = "/icon/filebrowser.svg"
  run_on_start       = true
  start_blocks_login = false
  script             = file("${path.module}/scripts/tools-filebrowser.sh")
}

resource "coder_app" "filebrowser" {
  agent_id     = coder_agent.main.id
  slug         = "filebrowser"
  display_name = "File Browser"
  url          = "http://localhost:13339"
  icon         = "/icon/filebrowser.svg"
  subdomain    = true
  share        = "owner"

  healthcheck {
    url       = "http://localhost:13339/health"
    interval  = 5
    threshold = 6
  }
}

# =============================================================================
# GitHub Integration
# =============================================================================

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
# Claude Code (module replaces claude-install.sh + coder_app)
# =============================================================================

module "claude-code" {
  count               = data.coder_workspace.me.start_count
  source              = "registry.coder.com/coder/claude-code/coder"
  version             = "1.1.0"
  agent_id            = coder_agent.main.id
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
# Dotfiles (module replaces dotfiles clone in init.sh)
# =============================================================================

module "dotfiles" {
  count                 = data.coder_workspace.me.start_count
  source                = "registry.coder.com/coder/dotfiles/coder"
  version               = "1.4.1"
  agent_id              = coder_agent.main.id
  coder_parameter_order = 11
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
# Kubernetes Resources
# =============================================================================

resource "kubernetes_persistent_volume_claim_v1" "home" {
  metadata {
    name      = "coder-${data.coder_workspace.me.id}-home"
    namespace = "coder"
    labels = {
      "app.kubernetes.io/name"     = "coder-workspace-home"
      "app.kubernetes.io/instance" = "coder-${data.coder_workspace.me.id}"
      "app.kubernetes.io/part-of"  = "coder"
      "com.coder.resource"         = "true"
      "com.coder.workspace.id"     = data.coder_workspace.me.id
      "com.coder.workspace.name"   = data.coder_workspace.me.name
      "com.coder.user.id"          = data.coder_workspace_owner.me.id
      "com.coder.user.username"    = data.coder_workspace_owner.me.name
    }
  }

  wait_until_bound = false

  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = "longhorn"

    resources {
      requests = {
        storage = "${data.coder_parameter.home_disk_size.value}Gi"
      }
    }
  }

}

resource "kubernetes_deployment_v1" "workspace" {
  count            = data.coder_workspace.me.start_count
  wait_for_rollout = false

  metadata {
    name      = "coder-${data.coder_workspace.me.id}"
    namespace = "coder"
    labels = {
      "app.kubernetes.io/name"     = "coder-workspace"
      "app.kubernetes.io/instance" = "coder-${data.coder_workspace.me.id}"
      "app.kubernetes.io/part-of"  = "coder"
      "com.coder.resource"         = "true"
      "com.coder.workspace.id"     = data.coder_workspace.me.id
      "com.coder.workspace.name"   = data.coder_workspace.me.name
      "com.coder.user.id"          = data.coder_workspace_owner.me.id
      "com.coder.user.username"    = data.coder_workspace_owner.me.name
    }
  }

  spec {
    replicas = 1

    selector {
      match_labels = {
        "app.kubernetes.io/instance" = "coder-${data.coder_workspace.me.id}"
      }
    }

    strategy {
      type = "Recreate"
    }

    template {
      metadata {
        labels = {
          "app.kubernetes.io/name"     = "coder-workspace"
          "app.kubernetes.io/instance" = "coder-${data.coder_workspace.me.id}"
          "app.kubernetes.io/part-of"  = "coder"
          "com.coder.resource"         = "true"
          "com.coder.workspace.id"     = data.coder_workspace.me.id
          "com.coder.workspace.name"   = data.coder_workspace.me.name
          "com.coder.user.id"          = data.coder_workspace_owner.me.id
          "com.coder.user.username"    = data.coder_workspace_owner.me.name
        }
      }

      spec {
        automount_service_account_token = false
        hostname                        = local.workspace_hostname

        security_context {
          run_as_non_root        = true
          run_as_user            = 1000
          run_as_group           = 1000
          fs_group               = 1000
          fs_group_change_policy = "OnRootMismatch"
        }

        affinity {
          node_affinity {
            preferred_during_scheduling_ignored_during_execution {
              weight = 100

              preference {
                match_expressions {
                  key      = "kubernetes.io/hostname"
                  operator = "In"
                  values   = ["k3s-03"]
                }
              }
            }
          }
        }

        image_pull_secrets {
          name = "ghcr-pull-kethalia"
        }

        init_container {
          name              = "seed-home"
          image             = "ghcr.io/kethalia/hive-base@sha256:3d1942a23c132385c55e1ffe41c45dfb9b1a7896238be14034e10c9109d47c03"
          image_pull_policy = "IfNotPresent"
          command = [
            "sh",
            "-c",
            "if [ ! -e /target/.hive-image-seeded ]; then cp -R --no-preserve=ownership,timestamps /home/coder/. /target/ && touch /target/.hive-image-seeded; fi",
          ]

          security_context {
            allow_privilege_escalation = false
            run_as_non_root            = true
            run_as_user                = 1000

            capabilities {
              drop = ["ALL"]
            }
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "128Mi"
            }
            limits = {
              cpu    = "500m"
              memory = "512Mi"
            }
          }

          volume_mount {
            name       = "home"
            mount_path = "/target"
          }
        }

        container {
          name              = "dev"
          image             = "ghcr.io/kethalia/hive-base@sha256:3d1942a23c132385c55e1ffe41c45dfb9b1a7896238be14034e10c9109d47c03"
          image_pull_policy = "IfNotPresent"
          command           = ["sh", "-c", coder_agent.main.init_script]

          security_context {
            allow_privilege_escalation = false
            run_as_non_root            = true
            run_as_user                = 1000

            capabilities {
              drop = ["ALL"]
            }
          }

          env {
            name  = "CODER_AGENT_TOKEN"
            value = coder_agent.main.token
          }

          env {
            name  = "USER"
            value = "coder"
          }

          env {
            name  = "HOME"
            value = "/home/coder"
          }

          resources {
            requests = {
              cpu    = "2"
              memory = "4Gi"
            }
            limits = {
              cpu    = "6"
              memory = "12Gi"
            }
          }

          volume_mount {
            name       = "home"
            mount_path = "/home/coder"
          }
        }

        volume {
          name = "home"

          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim_v1.home.metadata[0].name
          }
        }
      }
    }
  }

  depends_on = [kubernetes_persistent_volume_claim_v1.home]
}

resource "coder_metadata" "workspace" {
  count       = data.coder_workspace.me.start_count
  resource_id = kubernetes_deployment_v1.workspace[count.index].id

  item {
    key   = "template_version"
    value = "1.0.0"
  }

  item {
    key   = "home_disk"
    value = "${data.coder_parameter.home_disk_size.value} GiB"
  }
}

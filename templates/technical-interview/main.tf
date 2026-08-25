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
# Providers & Data Sources
# =============================================================================

provider "kubernetes" {}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

locals {
  profile                      = jsondecode(file("${path.module}/profile.json"))
  github_auth_enabled          = try(local.profile.security.github_auth, true)
  coder_login_enabled          = try(local.profile.security.coder_login, true)
  include_workspace_routing    = try(local.profile.agent_context.include_workspace_routing, true)
  profile_applications         = try(local.profile.applications, [])
  workspace_hostname_candidate = trim(substr(replace(lower(data.coder_workspace.me.name), "/[^a-z0-9-]/", "-"), 0, 63), "-")
  workspace_hostname           = local.workspace_hostname_candidate != "" ? local.workspace_hostname_candidate : "workspace"
}

# =============================================================================
# External Auth
# =============================================================================

data "coder_external_auth" "github" {
  count = local.github_auth_enabled ? 1 : 0
  id    = "github"
}



# =============================================================================
# Coder Agent
# =============================================================================

resource "coder_agent" "main" {
  arch                    = "amd64"
  os                      = "linux"
  startup_script_behavior = "blocking"

  startup_script = templatefile("${path.module}/scripts/init.sh", {
    workspace_name = data.coder_workspace.me.name
    owner_name     = data.coder_workspace_owner.me.name
    owner_email    = data.coder_workspace_owner.me.email
    enable_browser = local.profile.capabilities.browser
    claude_md_content = join("\n\n", compact([
      trimspace(file("${path.module}/CLAUDE.md")),
      local.include_workspace_routing ? trimspace(file("${path.module}/WORKSPACE_ROUTING.md")) : "",
    ]))
    workspace_readme_content = file("${path.module}/WORKSPACE.md")
  })

  env = {
    GIT_AUTHOR_NAME             = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_AUTHOR_EMAIL            = data.coder_workspace_owner.me.email
    GIT_COMMITTER_NAME          = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_COMMITTER_EMAIL         = data.coder_workspace_owner.me.email
    EXTENSIONS_GALLERY          = "{\"serviceUrl\":\"https://marketplace.visualstudio.com/_apis/public/gallery\"}"
    HIVE_PROJECTS_ROOT          = "/home/coder"
    HIVE_WORKSPACE_PROFILE      = local.profile.id
    HIVE_EXPECTED_IMAGE_VARIANT = local.profile.image_variant
    HIVE_DESKTOP_ENABLED        = tostring(local.profile.capabilities.desktop)
    HIVE_BROWSER_ENABLED        = tostring(local.profile.capabilities.browser)
    HIVE_GITHUB_AUTH_ENABLED    = tostring(local.github_auth_enabled)
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
  count              = local.profile.capabilities.web3 ? 1 : 0
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
    github_auth_enabled           = local.github_auth_enabled
    github_token                  = local.github_auth_enabled ? data.coder_external_auth.github[0].access_token : ""
    github_cli_script_b64         = base64encode(file("${path.module}/scripts/github-cli.sh"))
    github_credential_script_b64  = base64encode(file("${path.module}/scripts/github-credential.sh"))
    clone_repositories_script_b64 = base64encode(file("${path.module}/scripts/clone-repositories.sh"))
    repositories_manifest_b64     = base64encode(file("${path.module}/repositories.txt"))
    profile_bootstrap_script_b64  = fileexists("${path.module}/bootstrap.sh") ? base64encode(file("${path.module}/bootstrap.sh")) : ""
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
  count              = local.profile.capabilities.browser ? 1 : 0
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
  count   = local.profile.capabilities.editor ? data.coder_workspace.me.start_count : 0
  source  = "registry.coder.com/modules/code-server/coder"
  version = "1.4.3"

  agent_id              = coder_agent.main.id
  order                 = 1
  subdomain             = true
  use_cached_extensions = true

  extensions = concat([
    "binary-ink.dark-modern-oled-theme-set",
    "pkief.material-icon-theme",
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
  ], local.profile.vscode_extensions)

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
  count              = local.profile.capabilities.file_browser ? 1 : 0
  agent_id           = coder_agent.main.id
  display_name       = "File Browser"
  icon               = "/icon/filebrowser.svg"
  run_on_start       = true
  start_blocks_login = false
  script             = file("${path.module}/scripts/tools-filebrowser.sh")
}

resource "coder_app" "filebrowser" {
  count        = local.profile.capabilities.file_browser ? 1 : 0
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
# Optional profile-owned applications
# =============================================================================

resource "coder_app" "profile" {
  for_each = { for application in local.profile_applications : application.slug => application }

  agent_id     = coder_agent.main.id
  slug         = each.value.slug
  display_name = each.value.display_name
  url          = each.value.url
  icon         = each.value.icon
  subdomain    = try(each.value.subdomain, true)
  share        = "owner"

  dynamic "healthcheck" {
    for_each = try(each.value.healthcheck_url, null) != null ? [each.value.healthcheck_url] : []

    content {
      url       = healthcheck.value
      interval  = try(each.value.healthcheck_interval, 5)
      threshold = try(each.value.healthcheck_threshold, 12)
    }
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
  count               = local.profile.capabilities.desktop ? data.coder_workspace.me.start_count : 0
  source              = "registry.coder.com/coder/kasmvnc/coder"
  version             = "1.3.0"
  agent_id            = coder_agent.main.id
  desktop_environment = "xfce"
  port                = 6080
}

# =============================================================================
# Coder Login (auto-authenticates coder CLI inside workspace)
# =============================================================================

module "coder-login" {
  count    = local.coder_login_enabled ? data.coder_workspace.me.start_count : 0
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
        storage = local.profile.resources.storage
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
          image             = local.profile.image
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
          image             = local.profile.image
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
              cpu    = local.profile.resources.cpu_request
              memory = local.profile.resources.memory_request
            }
            limits = {
              cpu    = local.profile.resources.cpu_limit
              memory = local.profile.resources.memory_limit
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
    value = "3.0.0"
  }

  item {
    key   = "workspace_profile"
    value = local.profile.id
  }

  item {
    key   = "image_variant"
    value = local.profile.image_variant
  }

  item {
    key   = "workspace_capabilities"
    value = join(",", [for name, enabled in local.profile.capabilities : name if enabled])
  }

  item {
    key   = "home_disk"
    value = local.profile.resources.storage
  }
}

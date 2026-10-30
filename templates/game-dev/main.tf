terraform {
  required_providers {
    external = {
      source  = "hashicorp/external"
      version = "= 2.4.2"
    }
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

data "coder_parameter" "enable_opencode" {
  name         = "enable_opencode"
  display_name = "OpenCode CLI"
  description  = "Install OpenCode for hosted or OpenAI-compatible model endpoints. Configure provider credentials in the CLI."
  type         = "bool"
  default      = "false"
  mutable      = true
}

locals {
  profile                      = jsondecode(file("${path.module}/profile.json"))
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
    git_config_retry_script        = file("${path.module}/scripts/git-config-retry.sh")
    tmux_snapshot_migration_script = file("${path.module}/scripts/retire-tmux-snapshots.py")
    workspace_name                 = data.coder_workspace.me.name
    owner_name                     = data.coder_workspace_owner.me.name
    owner_email                    = data.coder_workspace_owner.me.email
    enable_browser                 = local.profile.capabilities.browser
    claude_md_content = join("\n\n", [
      trimspace(file("${path.module}/CLAUDE.md")),
      trimspace(file("${path.module}/WORKSPACE_ROUTING.md")),
    ])
    workspace_readme_content = file("${path.module}/WORKSPACE.md")
  })

  env = {
    GIT_AUTHOR_NAME             = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_AUTHOR_EMAIL            = data.coder_workspace_owner.me.email
    GIT_COMMITTER_NAME          = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_COMMITTER_EMAIL         = data.coder_workspace_owner.me.email
    EXTENSIONS_GALLERY          = "{\"serviceUrl\":\"https://marketplace.visualstudio.com/_apis/public/gallery\"}"
    HIVE_RUNTIME_BUILD_ID       = local.hive_host_enabled ? data.external.hive_build_identity[0].result.build_id : (local.hive_read_enabled ? data.external.hive_read_build_identity[0].result.build_id : (local.hive_voice_enabled ? data.external.hive_voice_build_identity[0].result.build_id : ""))
    HIVE_PROJECTS_ROOT          = "/home/coder"
    HIVE_WORKSPACE_PROFILE      = local.profile.id
    HIVE_MANAGED_PROJECTS       = tostring(local.hive_host_enabled)
    HIVE_EXPECTED_IMAGE_VARIANT = local.profile.image_variant
    HIVE_DESKTOP_ENABLED        = tostring(local.profile.capabilities.desktop)
    HIVE_BROWSER_ENABLED        = tostring(local.profile.capabilities.browser)
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

# A terminal app keeps the diagnostic on demand. coder_script requires a startup,
# shutdown, or cron trigger, even when it is intended for manual execution only.
resource "coder_app" "codex_sandbox_readiness" {
  agent_id     = coder_agent.main.id
  slug         = "codex-sandbox-readiness"
  display_name = "Codex restricted sandbox readiness"
  icon         = "/icon/terminal.svg"
  share        = "owner"
  command      = "timeout 240s python3 - <<'HIVE_SANDBOX_PY'\n${file("${path.module}/scripts/codex-sandbox-readiness.py")}\nHIVE_SANDBOX_PY\n"
}

# Coder agents schedule this directly; workspace containers need no cron daemon
# or user systemd session. Stopped workspaces run at the next scheduled time
# after starting; cache maintenance never blocks workspace startup.
resource "coder_script" "workspace_cache_maintenance" {
  agent_id           = coder_agent.main.id
  display_name       = "Daily development cache maintenance"
  icon               = "/icon/nodejs.svg"
  cron               = "CRON_TZ=UTC 0 45 6 * * *"
  run_on_start       = false
  start_blocks_login = false
  timeout            = 900
  script             = "set -e\npython3 - <<'HIVE_CACHE_PY'\n${file("${path.module}/scripts/prune-turbo-cache.py")}\nHIVE_CACHE_PY\n${file("${path.module}/scripts/workspace-cache-maintenance.sh")}"
}

# Vendor-only maintenance; does not restart agents, change authentication, or touch plugin choices.
resource "coder_script" "official_agent_maintenance" {
  agent_id           = coder_agent.main.id
  display_name       = "Daily official agent updates"
  icon               = "/icon/terminal.svg"
  cron               = "CRON_TZ=UTC 0 15 6 * * *"
  run_on_start       = false
  start_blocks_login = false
  timeout            = 900
  script             = "timeout 850s python3 - <<'HIVE_AGENT_UPDATE_PY'\n${file("${path.module}/scripts/update-official-agents.py")}\nHIVE_AGENT_UPDATE_PY\n"
}

# Task completion is explicit. Existing/unmanaged or active worktrees are never age-pruned.
resource "coder_script" "completed_worktree_maintenance" {
  count              = local.profile.id == "software" ? 1 : 0
  agent_id           = coder_agent.main.id
  display_name       = "Completed task worktree cleanup"
  icon               = "/icon/git.svg"
  cron               = "CRON_TZ=UTC 0 55 6 * * *"
  run_on_start       = false
  start_blocks_login = false
  timeout            = 120
  script             = "timeout 110s python3 - prune <<'HIVE_WORKTREE_PY'\n${file("${path.module}/scripts/worktree-lifecycle.py")}\nHIVE_WORKTREE_PY\n"
}

# Only signed receipts explicitly completed in the primary can enter cleanup.
resource "coder_script" "completed_workspace_maintenance" {
  count              = local.profile.id == "software" ? 1 : 0
  agent_id           = coder_agent.main.id
  display_name       = "Completed disposable workspace cleanup"
  icon               = "/icon/terminal.svg"
  cron               = "CRON_TZ=UTC 0 */5 * * * *"
  run_on_start       = false
  start_blocks_login = false
  timeout            = 120
  script             = "timeout 110s python3 - reap <<'HIVE_WORKSPACE_PY'\n${file("${path.module}/scripts/workspace-lifecycle.py")}\nHIVE_WORKSPACE_PY\n"
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
    git_config_retry_script        = file("${path.module}/scripts/git-config-retry.sh")
    github_cli_script_b64          = base64encode(file("${path.module}/scripts/github-cli.sh"))
    github_credential_script_b64   = base64encode(file("${path.module}/scripts/github-credential.sh"))
    clone_repositories_script_b64  = base64encode(file("${path.module}/scripts/clone-repositories.sh"))
    repositories_manifest_b64      = base64encode(file("${path.module}/repositories.txt"))
    worktree_lifecycle_script_b64  = base64encode(file("${path.module}/scripts/worktree-lifecycle.py"))
    workspace_lifecycle_script_b64 = base64encode(file("${path.module}/scripts/workspace-lifecycle.py"))
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

resource "coder_script" "agent_integrations" {
  count              = local.profile.id == "software" ? 1 : 0
  agent_id           = coder_agent.main.id
  display_name       = "Agent integrations"
  icon               = "/icon/terminal.svg"
  run_on_start       = true
  start_blocks_login = false
  script = join("\n", [
    "export HIVE_AGENT_TOOLS_SOURCE_B64='${base64encode(file("${path.module}/scripts/agent-tools.py"))}'",
    "export HIVE_NEON_SKILL_SOURCE_B64='${base64encode(file("${path.module}/scripts/install-neon-skill.py"))}'",
    file("${path.module}/scripts/agent-integrations.sh"),
  ])
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
  source  = "registry.coder.com/coder/code-server/coder"
  version = "1.6.0"

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
# Native CLI modules and launchers (no agentapi/Tasks server)
# =============================================================================

module "claude-code" {
  count               = data.coder_workspace.me.start_count
  source              = "registry.coder.com/coder/claude-code/coder"
  version             = "5.5.2"
  agent_id            = coder_agent.main.id
  install_claude_code = false
}

resource "coder_app" "claude_cli" {
  agent_id     = coder_agent.main.id
  slug         = "claude-cli"
  display_name = "Claude Code"
  icon         = "/icon/claude.svg"
  command      = "cd /home/coder && exec claude"
}

resource "coder_app" "codex_cli" {
  agent_id     = coder_agent.main.id
  slug         = "codex-cli"
  display_name = "Codex"
  icon         = "/icon/openai.svg"
  command      = "cd /home/coder && exec codex"
}

resource "coder_script" "opencode" {
  count              = data.coder_parameter.enable_opencode.value == "true" ? 1 : 0
  agent_id           = coder_agent.main.id
  display_name       = "OpenCode CLI"
  run_on_start       = true
  start_blocks_login = true
  timeout            = 180
  script             = file("${path.module}/scripts/tools-opencode.sh")
}

resource "coder_app" "opencode_cli" {
  count        = data.coder_parameter.enable_opencode.value == "true" ? 1 : 0
  agent_id     = coder_agent.main.id
  slug         = "opencode-cli"
  display_name = "OpenCode"
  icon         = "/icon/terminal.svg"
  command      = "cd /home/coder && exec opencode"
}

# =============================================================================
# Loopback desktop (Coder owns authentication; the backend has no network ingress)
# =============================================================================

resource "coder_script" "tools_desktop" {
  count        = local.profile.capabilities.desktop ? data.coder_workspace.me.start_count : 0
  agent_id     = coder_agent.main.id
  display_name = "Desktop"
  icon         = "/icon/kasmvnc.svg"
  run_on_start = true
  script = join("\n", [
    "#!/bin/bash",
    "HIVE_DESKTOP_GUARD_SOURCE_B64='${base64encode(file("${path.module}/scripts/kasmvnc-loopback.c"))}'",
    file("${path.module}/scripts/tools-desktop.sh"),
  ])
}

resource "coder_app" "desktop" {
  count        = local.profile.capabilities.desktop ? data.coder_workspace.me.start_count : 0
  agent_id     = coder_agent.main.id
  slug         = "kasm-vnc"
  display_name = "KasmVNC"
  url          = "http://127.0.0.1:6080"
  icon         = "/icon/kasmvnc.svg"
  subdomain    = true
  share        = "owner"
  healthcheck {
    url       = "http://127.0.0.1:6080/app"
    interval  = 5
    threshold = 5
  }
}

# =============================================================================
# Owner Coder login belongs only to the persistent orchestration workspace.
# =============================================================================

module "coder-login" {
  count    = local.profile.id == "software" ? data.coder_workspace.me.start_count : 0
  source   = "registry.coder.com/coder/coder-login/coder"
  version  = "1.1.1"
  agent_id = coder_agent.main.id
}

# =============================================================================
# tmux sessions survive disconnects while the workspace is running
# =============================================================================

resource "coder_app" "tmux" {
  count        = data.coder_workspace.me.start_count
  agent_id     = coder_agent.main.id
  slug         = "tmux-default"
  display_name = "tmux - default"
  icon         = "/icon/tmux.svg"
  command      = "tmux new-session -A -s default"
}

# Retain the existing app identity while dropping the module's plugin installer.
moved {
  from = module.tmux[0].coder_app.tmux_sessions["default"]
  to   = coder_app.tmux[0]
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
  lifecycle {
    precondition {
      condition     = data.coder_parameter.enable_hive_voice.value != "true" || local.profile.id == "software"
      error_message = "Hive voice signaling requires the software workspace profile."
    }
    precondition {
      condition     = try(local.profile.codex_sandbox_apparmor_profile, null) == null ? true : can(regex("^hive-codex-v[0-9]+$", local.profile.codex_sandbox_apparmor_profile))
      error_message = "Codex sandbox AppArmor policy must be a versioned hive-codex-vN localhost profile installed by the cluster operator."
    }
  }

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
        # Kubernetes provider 2.38 does not expose securityContext.appArmorProfile.
        # Verify this compatibility annotation against deployed k3s before rollout.
        # Opt in only after the named policy is loaded on eligible nodes.
        # The seed-home container continues using the runtime's default policy.
        annotations = merge(local.hive_host_bootstrap_data, local.hive_read_bootstrap_data, local.hive_voice_bootstrap_data, try(local.profile.codex_sandbox_apparmor_profile, null) == null ? {} : {
          "container.apparmor.security.beta.kubernetes.io/dev" = "localhost/${local.profile.codex_sandbox_apparmor_profile}"
        })

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
        node_selector = try(local.profile.codex_sandbox_apparmor_profile, null) == null ? {} : {
          "hive.kethalia.com/codex-sandbox" = local.profile.codex_sandbox_apparmor_profile
        }

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
          command = ["sh", "-c", local.profile.id == "software" ? coder_agent.main.init_script : templatefile("${path.module}/scripts/specialist-agent-entrypoint.sh", {
            agent_init_script               = coder_agent.main.init_script
            coder_access_url_b64            = base64encode(data.coder_workspace.me.access_url)
            workspace_profile_b64           = base64encode(local.profile.id)
            coder_credential_cleanup_script = file("${path.module}/scripts/coder-credential-cleanup.py")
          })]

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

          dynamic "volume_mount" {
            for_each = local.hive_host_enabled ? [true] : []
            content {
              name       = "hive-host-bootstrap"
              mount_path = "/opt/hive-codex-host-template"
              read_only  = true
            }
          }
          dynamic "volume_mount" {
            for_each = local.hive_read_enabled ? [true] : []
            content {
              name       = "hive-read-bootstrap"
              mount_path = "/opt/hive-workspace-read-template"
              read_only  = true
            }
          }
          dynamic "volume_mount" {
            for_each = local.hive_voice_enabled ? [true] : []
            content {
              name       = "hive-voice-bootstrap"
              mount_path = "/opt/hive-voice-template"
              read_only  = true
            }
          }

        }

        dynamic "volume" {
          for_each = local.hive_host_enabled ? [true] : []
          content {
            name = "hive-host-bootstrap"
            downward_api {
              default_mode = "0444"
              items {
                path = "request.json"
                field_ref {
                  field_path = "metadata.annotations['hive.kethalia.com/host-request']"
                }
              }
            }
          }
        }

        dynamic "volume" {
          for_each = local.hive_read_enabled ? [true] : []
          content {
            name = "hive-read-bootstrap"
            downward_api {
              default_mode = "0444"
              items {
                path = "request.json"
                field_ref {
                  field_path = "metadata.annotations['hive.kethalia.com/read-request']"
                }
              }
            }
          }
        }

        dynamic "volume" {
          for_each = local.hive_voice_enabled ? [true] : []
          content {
            name = "hive-voice-bootstrap"
            downward_api {
              default_mode = "0444"
              items {
                path = "request.json"
                field_ref {
                  field_path = "metadata.annotations['hive.kethalia.com/voice-request']"
                }
              }
            }
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

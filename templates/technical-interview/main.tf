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

data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

locals {
  profile                      = jsondecode(file("${path.module}/profile.json"))
  workspace_hostname_candidate = trim(substr(replace(lower(data.coder_workspace.me.name), "/[^a-z0-9-]/", "-"), 0, 63), "-")
  workspace_hostname           = local.workspace_hostname_candidate != "" ? local.workspace_hostname_candidate : "workspace"
  credentialless_environment   = <<-EOT
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
    unset OPENAI_API_KEY OPENAI_API_TOKEN CODEX_API_KEY
    unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
    unset CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR
    unset NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG
    unset npm_config_userconfig npm_config_globalconfig
    unset PIP_CONFIG_FILE PIP_INDEX_URL PIP_EXTRA_INDEX_URL PIP_TRUSTED_HOST
    unset PIP_CERT PIP_CLIENT_CERT PIP_KEYRING_PROVIDER PIP_PROXY
    unset GH_TOKEN GITHUB_TOKEN CODER_SESSION_TOKEN
    unset GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_PROXY_COMMAND GIT_SSH
    unset SSH_AUTH_SOCK SSH_AGENT_PID SSH_ASKPASS_REQUIRE
    unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN
    unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
    unset AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE
    unset GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_AUTH_ACCESS_TOKEN
    unset AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID
    unset ARM_CLIENT_ID ARM_CLIENT_SECRET ARM_TENANT_ID ARM_SUBSCRIPTION_ID
    unset KUBECONFIG
  EOT
}

# =============================================================================
# Coder Agent
# =============================================================================

resource "coder_agent" "main" {
  arch                    = "amd64"
  os                      = "linux"
  api_key_scope           = "no_user_data"
  startup_script_behavior = "blocking"

  startup_script = templatefile("${path.module}/scripts/init.sh", {
    workspace_name           = data.coder_workspace.me.name
    enable_browser           = local.profile.capabilities.browser
    claude_md_content        = trimspace(file("${path.module}/CLAUDE.md"))
    workspace_readme_content = file("${path.module}/WORKSPACE.md")
  })

  env = {
    GIT_AUTHOR_NAME             = "Interview Candidate"
    GIT_AUTHOR_EMAIL            = "interview@local.invalid"
    GIT_COMMITTER_NAME          = "Interview Candidate"
    GIT_COMMITTER_EMAIL         = "interview@local.invalid"
    EXTENSIONS_GALLERY          = "{\"serviceUrl\":\"https://marketplace.visualstudio.com/_apis/public/gallery\"}"
    HIVE_PROJECTS_ROOT          = "/home/coder/projects"
    HIVE_WORKSPACE_PROFILE      = local.profile.id
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

resource "coder_script" "tools_ci" {
  agent_id     = coder_agent.main.id
  display_name = "Interview setup"
  icon         = "/icon/terminal.svg"
  run_on_start = true
  # Dependency hooks, tests, and builds come from the persistent candidate
  # checkout and must never make the recovery terminal inaccessible.
  start_blocks_login = false
  script = templatefile("${path.module}/scripts/tools-ci.sh", {
    clone_repositories_script_b64 = base64encode(file("${path.module}/scripts/clone-repositories.sh"))
    repositories_manifest_b64     = base64encode(file("${path.module}/repositories.txt"))
    bootstrap_script_b64gzip      = base64gzip(file("${path.module}/bootstrap.sh"))
  })
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

  extensions = local.profile.vscode_extensions

  settings = {
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
    "git.autofetch" : false,
    "git.enableSmartCommit" : true,
    "terminal.integrated.scrollback" : 10000,
    "terminal.integrated.defaultProfile.linux" : "zsh",
    "terminal.integrated.fontSize" : 14,
    "explorer.confirmDelete" : false,
    "explorer.confirmDragAndDrop" : false,
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
# Interview applications
# =============================================================================

resource "coder_app" "interview_app" {
  agent_id     = coder_agent.main.id
  slug         = "interview-app"
  display_name = "Interview App"
  url          = "http://localhost:3000"
  icon         = "/icon/nodejs.svg"
  subdomain    = true
  share        = "owner"

  healthcheck {
    url       = "http://localhost:3000"
    interval  = 5
    threshold = 12
  }
}

resource "coder_app" "api_docs" {
  agent_id     = coder_agent.main.id
  slug         = "api-docs"
  display_name = "API Docs"
  url          = "http://localhost:8000/docs"
  icon         = "/icon/terminal.svg"
  subdomain    = true
  share        = "owner"

  healthcheck {
    url       = "http://localhost:8000/openapi.json"
    interval  = 5
    threshold = 12
  }
}

resource "coder_app" "interview_claude" {
  agent_id     = coder_agent.main.id
  slug         = "interview-claude"
  display_name = "Interview Claude"
  command      = "/opt/hive-interview-tools/interview-claude --client /run/hive-interview-launch/claude.sock"
  icon         = "/icon/terminal.svg"
  share        = "owner"
}

resource "coder_app" "interview_claude_key" {
  agent_id     = coder_agent.main.id
  slug         = "interview-claude-key"
  display_name = "Interview Claude Key"
  url          = "http://localhost:43118"
  icon         = "/icon/terminal.svg"
  subdomain    = true
  share        = "owner"

  healthcheck {
    url       = "http://localhost:43118/health"
    interval  = 5
    threshold = 12
  }
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
        share_process_namespace         = false

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

        # Keep network-dependent trusted staging independent from the main
        # recovery runtime. This credential-free sidecar retries transient
        # failures while the development agent remains usable; the protected
        # Claude runtime waits for its atomically promoted payload.
        container {
          name              = "stage-trusted-tools"
          image             = local.profile.image
          image_pull_policy = "IfNotPresent"
          command = [
            "sh",
            "-c",
            <<-EOT
              ${local.credentialless_environment}
              while ! /bin/sh -c "$1" stage-trusted-tools --stay-alive; do
                printf '[warn] trusted interview payload staging failed; retrying in 5 seconds\n' >&2
                /usr/bin/sleep 5
              done
            EOT
            ,
            "stage-trusted-tools-wrapper",
            file("${path.module}/scripts/stage-trusted-tools.sh"),
          ]

          env {
            name  = "HIVE_INTERVIEW_CLAUDE_HELPER_B64"
            value = base64encode(file("${path.module}/scripts/interview-claude"))
          }

          env {
            name  = "HIVE_INTERVIEW_CLAUDE_GUARD_B64"
            value = base64encode(file("${path.module}/scripts/claude-guard.c"))
          }

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
              memory = "256Mi"
            }
            limits = {
              cpu    = "500m"
              memory = "1Gi"
            }
          }

          volume_mount {
            name       = "trusted-tools"
            mount_path = "/trusted-tools"
          }

          volume_mount {
            name       = "claude-mcp"
            mount_path = "/trusted-mcp"
          }
        }

        init_container {
          name              = "seed-home"
          image             = local.profile.image
          image_pull_policy = "IfNotPresent"
          command = ["sh", "-c", "${local.credentialless_environment}\n/bin/sh -c \"$1\"", "seed-home-wrapper", file("${path.module}/scripts/seed-home.sh")]

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
          command = [
            "sh",
            "-c",
            "${local.credentialless_environment}\nexec /bin/sh -c \"$1\"",
            "coder-agent-wrapper",
            coder_agent.main.init_script,
          ]

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

          volume_mount {
            name       = "trusted-tools"
            mount_path = "/opt/hive-interview-tools"
            read_only  = true
          }

          volume_mount {
            name       = "claude-status"
            mount_path = "/run/hive-interview-claude"
            read_only  = true
          }

          volume_mount {
            name       = "claude-launch"
            mount_path = "/run/hive-interview-launch"
            read_only  = true
          }

          volume_mount {
            name       = "browser-profile"
            mount_path = "/home/coder/.cache/hive-interview-browser"
          }

          volume_mount {
            name       = "browser-google-profile"
            mount_path = "/home/coder/.config/google-chrome"
          }

          volume_mount {
            name       = "browser-chromium-profile"
            mount_path = "/home/coder/.config/chromium"
          }

          volume_mount {
            name       = "browser-chromium-browser-profile"
            mount_path = "/home/coder/.config/chromium-browser"
          }
        }

        # This sibling container is the credential boundary. It has no Coder
        # agent, no Coder token, and therefore no owner-reachable SSH or web
        # terminal. Its owner-only key app encrypts the temporary key in the
        # browser before handing it to this runtime. The runtime relays a PTY
        # through the read-only socket exposed to the credentialless client.
        container {
          name              = "claude-runtime"
          image             = local.profile.image
          image_pull_policy = "IfNotPresent"
          command = [
            "sh",
            "-c",
            <<-EOT
              ${local.credentialless_environment}
              unset CODER_AGENT_TOKEN
              /bin/bash -c "$1"
              (
                while :; do
                  /bin/bash -c "$2" || true
                  /usr/bin/sleep 5
                done
              ) &
              exec /opt/hive-interview-tools/interview-claude --serve /run/hive-interview-launch/claude.sock
            EOT
            ,
            "claude-runtime-wrapper",
            templatefile("${path.module}/scripts/init-claude.sh", {
              claude_md_content = trimspace(file("${path.module}/CLAUDE.md"))
            }),
            file("${path.module}/scripts/claude-heartbeat.sh"),
          ]

          security_context {
            allow_privilege_escalation = false
            run_as_non_root            = true
            run_as_user                = 1000

            capabilities {
              drop = ["ALL"]
            }
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
              cpu    = "100m"
              memory = "256Mi"
            }
            limits = {
              cpu    = "2"
              memory = "2Gi"
            }
          }

          volume_mount {
            name       = "home"
            mount_path = "/workspace/projects"
            sub_path   = "projects"
          }

          volume_mount {
            name       = "claude-home"
            mount_path = "/home/coder"
          }

          volume_mount {
            name       = "trusted-tools"
            mount_path = "/opt/hive-interview-tools"
            read_only  = true
          }

          volume_mount {
            name       = "claude-status"
            mount_path = "/run/hive-interview-claude"
          }

          volume_mount {
            name       = "claude-mcp"
            mount_path = "/opt/hive-interview-mcp"
            read_only  = true
          }

          volume_mount {
            name       = "claude-launch"
            mount_path = "/run/hive-interview-launch"
          }
        }

        volume {
          name = "home"

          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim_v1.home.metadata[0].name
          }
        }

        volume {
          name = "trusted-tools"

          empty_dir {
            size_limit = "512Mi"
          }
        }

        volume {
          name = "claude-home"

          empty_dir {
            size_limit = "1Gi"
          }
        }

        volume {
          name = "claude-status"

          empty_dir {
            size_limit = "1Mi"
          }
        }

        volume {
          name = "claude-mcp"

          empty_dir {
            size_limit = "512Mi"
          }
        }

        volume {
          name = "claude-launch"

          empty_dir {
            size_limit = "1Mi"
          }
        }

        volume {
          name = "browser-profile"

          empty_dir {
            size_limit = "1Gi"
          }
        }

        volume {
          name = "browser-google-profile"

          empty_dir {
            size_limit = "1Gi"
          }
        }

        volume {
          name = "browser-chromium-profile"

          empty_dir {
            size_limit = "1Gi"
          }
        }

        volume {
          name = "browser-chromium-browser-profile"

          empty_dir {
            size_limit = "1Gi"
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

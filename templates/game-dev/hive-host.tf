# The managed host uses the existing root-pinned workspace image bootstrap.
variable "hive_project_origin" {
  type        = string
  default     = ""
  description = "Deployment-controlled HTTPS origin for the managed Projects application."
}

variable "hive_project_model" {
  type        = string
  default     = "gpt-6.1-sol"
  description = "Deployment-controlled model used for managed project conversations."
}

variable "hive_project_effort" {
  type        = string
  default     = "high"
  description = "Deployment-controlled reasoning effort."
  validation {
    condition     = contains(["low", "medium", "high", "xhigh", "max", "ultra"], var.hive_project_effort)
    error_message = "Unsupported reasoning effort."
  }
}

data "coder_parameter" "enable_hive_projects" {
  name         = "enable_hive_projects"
  display_name = "Managed Hive projects"
  description  = "Enable the managed project host after Hive configures this workspace. Existing conversations and checkouts are retained."
  type         = "bool"
  default      = "false"
  mutable      = true
}

data "coder_parameter" "hive_user_id" {
  name         = "hive_user_id"
  display_name = "Hive account ID"
  description  = "Configured by Hive for the signed-in account. Both Hive and Coder independently verify ownership."
  type         = "string"
  default      = ""
  mutable      = true
}

locals {
  hive_host_enabled = local.profile.id == "software" && data.coder_parameter.enable_hive_projects.value == "true"
  hive_host_port    = 13341
  hive_host_label   = "codex-session--main--${data.coder_workspace.me.name}--${data.coder_workspace_owner.me.name}"
  hive_host_origin  = "https://${local.hive_host_label}.${var.hive_coder_app_domain}"
}

data "external" "hive_build_identity" {
  count   = local.hive_host_enabled ? 1 : 0
  program = ["sh", "${path.module}/scripts/hive-build-identity.sh"]
  lifecycle {
    postcondition {
      condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", self.result.build_id))
      error_message = "Managed Hive projects require an independently verified Coder build identity."
    }
  }
}

resource "coder_app" "hive_projects" {
  count        = local.hive_host_enabled ? 1 : 0
  agent_id     = coder_agent.main.id
  slug         = "codex-session"
  display_name = "Hive project session"
  url          = "http://127.0.0.1:${local.hive_host_port}"
  subdomain    = true
  share        = "owner"
  hidden       = true
}

# Public configuration is mounted from a bounded Downward API annotation.
# Coder scripts use a fixed file path rather than embedding the package in argv.
locals {
  hive_host_bootstrap_data = local.hive_host_enabled ? {
    "hive.kethalia.com/host-request" = jsonencode({
      schemaVersion   = 1
      imageArchiveSha256   = filesha256("${path.module}/assets/codex-host.tar.xz")
      imageInstallerSha256 = filesha256("${path.module}/scripts/install-codex-host.py")
      archiveEncoding = "xz"
      archiveSha256   = trimspace(file("${path.module}/assets/codex-host.tar.sha256"))
      config = {
        schemaVersion          = 1
        enabled                = true
        profile                = "software"
        managerEnabled         = true
        guardianEnabled        = true
        nativeIsolationEnabled = true
        hiveOrigin             = var.hive_project_origin
        issuerPublicKeyPem     = var.hive_issuer_public_key_pem
        issuerKeyId            = var.hive_issuer_key_id
        port                   = local.hive_host_port
        model                  = var.hive_project_model
        effort                 = var.hive_project_effort
        binding = {
          coderOrigin = trimsuffix(data.coder_workspace.me.access_url, "/")
          hiveUserId  = data.coder_parameter.hive_user_id.value
          ownerId     = data.coder_workspace_owner.me.id
          workspaceId = data.coder_workspace.me.id
          buildId     = data.external.hive_build_identity[0].result.build_id
          agentId     = coder_agent.main.id
          templateId  = data.coder_workspace.me.template_id
          appOrigin   = local.hive_host_origin
          appId       = coder_app.hive_projects[0].id
        }
      }
    })
  } : {}
}

resource "coder_script" "hive_projects" {
  count              = local.hive_host_enabled ? 1 : 0
  agent_id           = coder_agent.main.id
  display_name       = "Managed Hive project host"
  run_on_start       = true
  start_blocks_login = false
  script             = file("${path.module}/scripts/install-codex-host.sh.tftpl")
  lifecycle {
    precondition {
      condition     = sum([for key, content in local.hive_host_bootstrap_data : length(base64encode(key)) * 3 / 4 + length(base64encode(content)) * 3 / 4]) <= 16384
      error_message = "The managed host bootstrap request exceeds its annotation capacity."
    }
    precondition {
      condition     = can(regex("^https://[a-z0-9.-]+$", var.hive_project_origin)) && var.hive_issuer_public_key_pem != "" && can(regex("^[A-Za-z0-9._:-]{1,200}$", var.hive_issuer_key_id))
      error_message = "Managed projects require the deployment's HTTPS origin and public issuer key configuration."
    }
    precondition {
      condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", data.coder_parameter.hive_user_id.value)) && length(local.hive_host_label) <= 63 && can(regex("^[a-z0-9-]+$", local.hive_host_label))
      error_message = "Managed projects require a valid Hive account and a workspace app DNS label of at most 63 characters."
    }
  }
}

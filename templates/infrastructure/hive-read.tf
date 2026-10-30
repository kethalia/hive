# Independent read-only workspace transport, available in every capability profile.
# Deployment-owned public issuer and Coder provisioner identity bind this service.
data "coder_parameter" "enable_hive_workspace_read" {
  name         = "enable_hive_workspace_read"
  display_name = "Hive workspace discovery"
  description  = "Enable signed terminal discovery and file-link checks after Hive configures this workspace."
  type         = "bool"
  default      = "false"
  mutable      = true
}

locals {
  hive_read_enabled         = data.coder_parameter.enable_hive_workspace_read.value == "true"
  hive_read_label           = "hive-read--main--${data.coder_workspace.me.name}--${data.coder_workspace_owner.me.name}"
  hive_read_origin          = "https://${local.hive_read_label}.${var.hive_coder_app_domain}"
  hive_read_manifest_sha256 = trimspace(file("${path.module}/assets/workspace-read.manifest.sha256"))
  hive_read_archive_sha256  = trimspace(file("${path.module}/assets/workspace-read.tar.sha256"))
}

data "external" "hive_read_build_identity" {
  count   = local.hive_read_enabled ? 1 : 0
  program = ["sh", "${path.module}/scripts/hive-build-identity.sh"]
  lifecycle {
    postcondition {
      condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", self.result.build_id))
      error_message = "Workspace discovery requires the Coder provisioner's build identity."
    }
  }
}

resource "coder_app" "hive_read" {
  count        = local.hive_read_enabled ? 1 : 0
  agent_id     = coder_agent.main.id
  slug         = "hive-read"
  display_name = "Hive workspace discovery"
  url          = "http://127.0.0.1:13342"
  subdomain    = true
  share        = "owner"
  hidden       = true
}

locals {
  hive_read_bootstrap_data = local.hive_read_enabled ? {
    "hive.kethalia.com/read-start" = file("${path.module}/scripts/start-workspace-read.py")
    "hive.kethalia.com/read-installer" = filebase64("${path.module}/assets/workspace-read-installer.py.gz")
    "hive.kethalia.com/read-installer-sha256" = trimspace(file("${path.module}/assets/workspace-read-installer.sha256"))
    "hive.kethalia.com/read-request" = jsonencode({
      schemaVersion  = 1
      archive        = filebase64("${path.module}/assets/workspace-read.tar.gz")
      archiveSha256  = local.hive_read_archive_sha256
      manifestSha256 = local.hive_read_manifest_sha256
      config = {
        schemaVersion      = 1
        profile            = local.profile.id
        projectsRoot       = "/home/coder"
        home               = "/home/coder"
        hiveOrigin         = var.hive_control_origin
        issuerPublicKeyPem = var.hive_issuer_public_key_pem
        issuerKeyId        = var.hive_issuer_key_id
        packageDirectory   = "/home/coder/.local/share/hive/workspace-read/${local.hive_read_archive_sha256}"
        manifestSha256     = local.hive_read_manifest_sha256
        stateDirectory     = "/home/coder/.local/state/hive/workspace-read/${data.external.hive_read_build_identity[0].result.build_id}"
        port               = 13342
        binding = {
          coderOrigin = trimsuffix(data.coder_workspace.me.access_url, "/")
          ownerId     = data.coder_workspace_owner.me.id
          workspaceId = data.coder_workspace.me.id
          buildId     = data.external.hive_read_build_identity[0].result.build_id
          agentId     = coder_agent.main.id
          templateId  = data.coder_workspace.me.template_id
          appOrigin   = local.hive_read_origin
          appId       = coder_app.hive_read[0].id
        }
      }
    })
  } : {}
}

resource "coder_script" "hive_read" {
  count              = local.hive_read_enabled ? 1 : 0
  agent_id           = coder_agent.main.id
  display_name       = "Hive workspace discovery service"
  run_on_start       = true
  start_blocks_login = false
  script             = file("${path.module}/scripts/install-workspace-read.sh.tftpl")
  lifecycle {
    precondition {
      condition     = sum([for key, content in merge(local.hive_host_bootstrap_data, local.hive_read_bootstrap_data) : length(base64encode(key)) * 3 / 4 + length(base64encode(content)) * 3 / 4]) <= 240000
      error_message = "Combined Hive services exceed their bounded pod metadata capacity."
    }
    precondition {
      condition     = can(regex("^https://[a-z0-9.-]+$", var.hive_control_origin)) && var.hive_issuer_public_key_pem != "" && can(regex("^[A-Za-z0-9._-]{1,64}$", var.hive_issuer_key_id))
      error_message = "Workspace discovery requires the deployment's HTTPS origin and public issuer key."
    }
    precondition {
      condition     = length(local.hive_read_label) <= 63 && can(regex("^[a-z0-9-]+$", local.hive_read_label))
      error_message = "Workspace discovery requires a valid app DNS label of at most 63 characters."
    }
  }
}

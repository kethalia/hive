# Independent scoped workspace agent service, available in every capability profile.
# Deployment-owned public issuer and Coder provisioner identity bind this service.
data "coder_parameter" "enable_hive_agent_tools" {
  name         = "enable_hive_agent_tools"
  display_name = "Hive agent tools"
  description  = "Enable signed agent inventory and conversation recovery after Hive configures this workspace."
  type         = "bool"
  default      = "false"
  mutable      = true
}

locals {
  hive_agent_enabled         = data.coder_parameter.enable_hive_agent_tools.value == "true"
  hive_agent_label           = "hive-agent--main--${data.coder_workspace.me.name}--${data.coder_workspace_owner.me.name}"
  hive_agent_origin          = "https://${local.hive_agent_label}.${var.hive_coder_app_domain}"
  hive_agent_manifest_sha256 = trimspace(file("${path.module}/assets/agent-bridge.manifest.sha256"))
  hive_agent_archive_sha256  = trimspace(file("${path.module}/assets/agent-bridge.tar.sha256"))
  hive_agent_helper_sha256   = trimspace(file("${path.module}/assets/agent-bridge.helper.sha256"))
}

data "external" "hive_agent_build_identity" {
  count   = local.hive_agent_enabled ? 1 : 0
  program = ["sh", "${path.module}/scripts/hive-build-identity.sh"]
  lifecycle {
    postcondition {
      condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", self.result.build_id))
      error_message = "Agent tools require the Coder provisioner's build identity."
    }
  }
}

resource "coder_app" "hive_agent" {
  count        = local.hive_agent_enabled ? 1 : 0
  agent_id     = coder_agent.main.id
  slug         = "hive-agent"
  display_name = "Hive agent tools"
  url          = "http://127.0.0.1:13344"
  subdomain    = true
  share        = "owner"
  hidden       = true
}

locals {
  hive_agent_bootstrap_data = local.hive_agent_enabled ? {
    "hive.kethalia.com/agent-request" = jsonencode({
      schemaVersion  = 1
      imageArchiveSha256   = filesha256("${path.module}/assets/agent-bridge.tar.gz")
      imageInstallerSha256 = filesha256("${path.module}/scripts/install-agent-bridge.py")
      archiveSha256  = local.hive_agent_archive_sha256
      manifestSha256 = local.hive_agent_manifest_sha256
      config = {
        schemaVersion      = 1
        profile            = local.profile.id
        home               = "/home/coder"
        hiveOrigin         = var.hive_control_origin
        issuerPublicKeyPem = var.hive_issuer_public_key_pem
        issuerKeyId        = var.hive_issuer_key_id
        packageDirectory   = "/home/coder/.local/share/hive/agent-bridge/${local.hive_agent_archive_sha256}"
        manifestSha256     = local.hive_agent_manifest_sha256
        helperSha256       = local.hive_agent_helper_sha256
        port               = 13344
        binding = {
          coderOrigin = trimsuffix(data.coder_workspace.me.access_url, "/")
          ownerId     = data.coder_workspace_owner.me.id
          workspaceId = data.coder_workspace.me.id
          buildId     = data.external.hive_agent_build_identity[0].result.build_id
          agentId     = coder_agent.main.id
          templateId  = data.coder_workspace.me.template_id
          appOrigin   = local.hive_agent_origin
          appId       = coder_app.hive_agent[0].id
        }
      }
    })
  } : {}
}

resource "coder_script" "hive_agent" {
  count              = local.hive_agent_enabled ? 1 : 0
  agent_id           = coder_agent.main.id
  display_name       = "Hive agent tools service"
  run_on_start       = true
  start_blocks_login = false
  script             = file("${path.module}/scripts/install-agent-bridge.sh.tftpl")
  lifecycle {
    precondition {
      condition     = sum([for key, content in local.hive_agent_bootstrap_data : length(base64encode(key)) * 3 / 4 + length(base64encode(content)) * 3 / 4]) <= 16384
      error_message = "Agent request exceeds its annotation capacity."
    }
    precondition {
      condition     = can(regex("^https://[a-z0-9.-]+$", var.hive_control_origin)) && var.hive_issuer_public_key_pem != "" && can(regex("^[A-Za-z0-9._-]{1,64}$", var.hive_issuer_key_id))
      error_message = "Agent tools require the deployment's HTTPS origin and public issuer key."
    }
    precondition {
      condition     = length(local.hive_agent_label) <= 63 && can(regex("^[a-z0-9-]+$", local.hive_agent_label))
      error_message = "Agent tools require a valid app DNS label of at most 63 characters."
    }
  }
}
